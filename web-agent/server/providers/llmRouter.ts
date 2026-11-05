/**
 * 多模型路由。
 *
 * 支持三类线上格式：
 *   1. OpenAI 兼容（OpenAI / DeepSeek / Ollama / 任意 /v1 网关）—— SSE 流式 + 原生 tool calling；
 *   2. Anthropic Messages API —— 非流式（一次性返回后统一推送），原生 tool_use；
 *   3. Demo 编排引擎（无 Key）—— 见 demoProvider.ts。
 *
 * 不支持 tool calling 的端点会自动降级到「代码块文本协议」，由 fallbackParser 解析。
 */

import type { ChatProvider, ChatReply, ChatRequest, LlmMessage, ModelEndpoint, ToolCall, ToolSchema } from '../types';
import { extractTextToolCalls } from '../core/fallbackParser';

const REQUEST_TIMEOUT_MS = 180_000;

function combineSignals(signal: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('模型请求超时')), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

function joinUrl(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}${suffix}`;
}

/* ------------------------------ OpenAI 兼容 ------------------------------ */

interface OpenAiToolCallState {
  id: string;
  name: string;
  arguments: string;
}

function toOpenAiMessages(messages: LlmMessage[], nativeTools: boolean): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (nativeTools && message.toolCallId) {
        out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
      } else {
        out.push({ role: 'user', content: `【工具结果】\n${message.content}` });
      }
      continue;
    }
    if (message.role === 'assistant') {
      const assistant: Record<string, unknown> = {
        role: 'assistant',
        content: message.content && message.content.length > 0 ? message.content : nativeTools ? null : '',
      };
      if (nativeTools && message.toolCalls && message.toolCalls.length > 0) {
        assistant.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      out.push(assistant);
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function toOpenAiTools(tools: ToolSchema[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** 解析 OpenAI 风格 SSE 流，边解析边回调 delta。 */
async function consumeOpenAiStream(
  response: Response,
  onDelta?: (text: string) => void,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('模型响应没有可读流。');

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const calls = new Map<number, OpenAiToolCallState>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');

      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const errorField = chunk.error as { message?: string } | undefined;
      if (errorField) throw new Error(`模型返回错误：${errorField.message ?? JSON.stringify(errorField)}`);

      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Record<string, unknown>;

      const content = delta.content;
      if (typeof content === 'string' && content.length > 0) {
        text += content;
        onDelta?.(content);
      }

      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(toolCalls)) {
        for (const entry of toolCalls) {
          const index = Number(entry.index ?? 0);
          const state = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof entry.id === 'string' && entry.id) state.id = entry.id;
          const fn = entry.function as { name?: string; arguments?: string } | undefined;
          if (fn?.name) state.name = fn.name;
          if (fn?.arguments) state.arguments += fn.arguments;
          calls.set(index, state);
        }
      }
    }
  }

  const toolCalls: ToolCall[] = Array.from(calls.entries())
    .sort((a, b) => a[0] - b[0])
    .filter(([, state]) => state.name)
    .map(([index, state]) => ({
      id: state.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
      name: state.name,
      arguments: state.arguments || '{}',
    }));

  return { text, toolCalls };
}

function parseOpenAiNonStream(json: Record<string, unknown>): { text: string; toolCalls: ToolCall[] } {
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
  const text = typeof message.content === 'string' ? message.content : '';
  const rawCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  const toolCalls: ToolCall[] = (rawCalls ?? []).map((entry, index) => {
    const fn = (entry.function ?? {}) as { name?: string; arguments?: string };
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id : `call_${index}`,
      name: fn.name ?? '',
      arguments: fn.arguments ?? '{}',
    };
  });
  return { text, toolCalls: toolCalls.filter((call) => call.name) };
}

async function postOpenAi(
  endpoint: ModelEndpoint,
  req: ChatRequest,
  body: Record<string, unknown>,
): Promise<Response> {
  const { signal, cancel } = combineSignals(req.signal);
  try {
    const url = joinUrl(endpoint.baseUrl, '/chat/completions');
    let attempt = 0;
    for (;;) {
      const response = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      const detail = (await response.text()).slice(0, 800);
      if (retryable && attempt < 1) {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 900));
        continue;
      }
      throw new Error(`模型接口 ${response.status} ${response.statusText}：${detail}`);
    }
  } finally {
    // 响应体还在读的时候不能 cancel，交给调用方处理；这里只清理超时计时器
    if (!req.signal.aborted) cancel();
  }
}

class OpenAiProvider implements ChatProvider {
  id: string;
  label: string;
  model: string;
  nativeTools: boolean;
  private endpoint: ModelEndpoint;

  constructor(endpoint: ModelEndpoint) {
    this.endpoint = endpoint;
    this.id = endpoint.id;
    this.label = endpoint.label;
    this.model = endpoint.model;
    this.nativeTools = endpoint.nativeTools;
  }

  async chat(req: ChatRequest): Promise<ChatReply> {
    const body: Record<string, unknown> = {
      model: this.endpoint.model,
      messages: toOpenAiMessages(req.messages, this.nativeTools),
      temperature: 0.3,
      stream: true,
    };
    if (this.nativeTools && req.tools.length > 0) {
      body.tools = toOpenAiTools(req.tools);
      body.tool_choice = 'auto';
    }

    const response = await postOpenAi(this.endpoint, req, body);
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      // 少数网关忽略 stream=true
      const json = (await response.json()) as Record<string, unknown>;
      const parsed = parseOpenAiNonStream(json);
      if (parsed.text) req.onDelta?.(parsed.text);
      return {
        text: parsed.text,
        toolCalls: this.nativeTools ? parsed.toolCalls : extractTextToolCalls(parsed.text, req.tools.map((t) => t.name)),
        model: this.model,
        provider: this.label,
      };
    }

    const { text, toolCalls } = await consumeOpenAiStream(response, req.onDelta);
    return {
      text,
      toolCalls: this.nativeTools ? toolCalls : extractTextToolCalls(text, req.tools.map((t) => t.name)),
      model: this.model,
      provider: this.label,
    };
  }
}

/* ------------------------------ Anthropic ------------------------------ */

function toAnthropicMessages(messages: LlmMessage[]): { system: string; messages: unknown[] } {
  let system = '';
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];

  const pushBlock = (role: 'user' | 'assistant', block: unknown) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };

  for (const message of messages) {
    if (message.role === 'system') {
      system += (system ? '\n\n' : '') + message.content;
      continue;
    }
    if (message.role === 'tool') {
      pushBlock('user', {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? 'unknown',
        content: message.content,
      });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) pushBlock('assistant', { type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        pushBlock('assistant', {
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: safeParse(call.arguments),
        });
      }
      if (!message.content && !(message.toolCalls && message.toolCalls.length)) {
        pushBlock('assistant', { type: 'text', text: '（无输出）' });
      }
      continue;
    }
    pushBlock('user', { type: 'text', text: message.content });
  }

  return { system, messages: out };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

class AnthropicProvider implements ChatProvider {
  id: string;
  label: string;
  model: string;
  nativeTools = true;
  private endpoint: ModelEndpoint;

  constructor(endpoint: ModelEndpoint) {
    this.endpoint = endpoint;
    this.id = endpoint.id;
    this.label = endpoint.label;
    this.model = endpoint.model;
  }

  async chat(req: ChatRequest): Promise<ChatReply> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: this.endpoint.model,
      max_tokens: 4096,
      messages,
      temperature: 0.3,
      ...(system ? { system } : {}),
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
    };

    const { signal, cancel } = combineSignals(req.signal);
    let json: Record<string, unknown>;
    try {
      const response = await fetch(joinUrl(this.endpoint.baseUrl, '/messages'), {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(this.endpoint.apiKey
            ? { 'x-api-key': this.endpoint.apiKey, Authorization: `Bearer ${this.endpoint.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Anthropic 接口 ${response.status}：${(await response.text()).slice(0, 600)}`);
      }
      json = (await response.json()) as Record<string, unknown>;
    } finally {
      cancel();
    }

    const blocks = (json.content as Array<Record<string, unknown>>) ?? [];
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id ?? `call_${toolCalls.length}`),
          name: String(block.name ?? ''),
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    // Anthropic 是非流式调用，一次性把文本推送出去，前端仍然有打字机效果（单帧）
    if (text) req.onDelta?.(text);
    return { text, toolCalls: toolCalls.filter((call) => call.name), model: this.model, provider: this.label };
  }
}

/* ------------------------------ 工厂 ------------------------------ */

export class DemoProviderMarker {
  static readonly KIND = 'demo';
}

export function createOnlineProvider(endpoint: ModelEndpoint): ChatProvider {
  if (endpoint.kind === 'anthropic') return new AnthropicProvider(endpoint);
  return new OpenAiProvider(endpoint);
}
