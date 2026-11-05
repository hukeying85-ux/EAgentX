/**
 * 代码块工具协议回退解析（移植并扩写自 EAgentX `src/Core/CommandParser.cs`）。
 *
 * 对不支持原生 tool calling 的模型（部分 Ollama / 兼容网关），系统提示词里会写明文本协议：
 *
 *   ```tool:write_file
 *   {"path": "index.html", "content": "<h1>hi</h1>"}
 *   ```
 *
 * 也可以用语言名直接当工具名（```bash）或单个 JSON 块（```json {"tool":"bash",...}）。
 * 这里负责把回复解析成统一的 ToolCall[]，并顺带做「围栏未闭合」与「$ 提示符」清理。
 */

import type { ToolCall } from '../types';

export interface Fence {
  lang: string;
  code: string;
}

const FENCE_RE = /```[ \t]*([A-Za-z0-9_+:.#-]*)[ \t]*\r?\n([\s\S]*?)```/g;

export function hasUnclosedFence(reply: string): boolean {
  if (!reply) return false;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = reply.indexOf('```', index);
    if (found < 0) break;
    count++;
    index = found + 3;
  }
  return count % 2 !== 0;
}

export function parseFences(reply: string): Fence[] {
  const out: Fence[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(reply)) !== null) {
    out.push({ lang: normalizeLang(match[1]), code: match[2] });
  }
  return out;
}

export function normalizeLang(raw: string | undefined): string {
  if (!raw) return '';
  const token = /[A-Za-z0-9_+:#.-]+/.exec(raw);
  return token ? token[0].toLowerCase() : '';
}

/** 反复剥掉 `$ `、`PS> `、`PS C:\> ` 之类提示符与 `powershell ` 前缀。 */
export function cleanCommand(code: string): string {
  let text = (code ?? '').trim();
  if (!text) return '';
  const prompts = ['$ ', 'PS> ', 'PS C:\\> ', '> '];
  const shells = ['powershell ', 'pwsh ', 'bash '];
  let stripped = true;
  while (stripped && text.length > 0) {
    stripped = false;
    for (const prompt of prompts) {
      if (text.toLowerCase().startsWith(prompt.toLowerCase())) {
        text = text.slice(prompt.length).trimStart();
        stripped = true;
      }
    }
    for (const shell of shells) {
      if (!text.toLowerCase().startsWith(shell)) continue;
      const rest = text.slice(shell.length).trimStart();
      if (rest.startsWith('-')) continue; // `powershell -Command ...` 是真命令
      text = rest;
      stripped = true;
    }
  }
  return text.trim();
}

function safeJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 不是合法 JSON */
  }
  return null;
}

/** 把非 JSON 的代码块塞进该工具的首个必填参数里。 */
function coerceArgs(tool: string, payload: string): Record<string, unknown> | null {
  const text = cleanCommand(payload);
  if (!text) return {};
  switch (tool) {
    case 'bash':
      return { command: text };
    case 'read_file':
    case 'list_files':
      return { path: text.split('\n')[0].trim() };
    case 'read_skill':
      return { name: text.split('\n')[0].trim() };
    case 'fetch_page':
      return { url: text.split('\n')[0].trim() };
    case 'list_skills':
    case 'stop_process':
      return {};
    case 'ask_user':
      return { question: text };
    default:
      return null;
  }
}

/**
 * 从模型回复里抽取工具调用。
 * `allowed` 是当前注册的工具名集合，只有命中集合的代码块才会被当成调用。
 */
export function extractTextToolCalls(reply: string, allowed: string[]): ToolCall[] {
  const fences = parseFences(reply);
  const allowedSet = new Set(allowed);
  const calls: ToolCall[] = [];

  for (const fence of fences) {
    if (!fence.code.trim()) continue;

    // 形式一：```tool:name
    if (fence.lang.startsWith('tool:')) {
      const name = fence.lang.slice(5);
      if (!allowedSet.has(name)) continue;
      const args = safeJsonObject(fence.code) ?? coerceArgs(name, fence.code);
      if (!args) continue;
      calls.push({ id: `txt_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) });
      continue;
    }

    // 形式二：```json {"tool": "...", "args": {...}}
    if (fence.lang === 'json') {
      const obj = safeJsonObject(fence.code);
      if (!obj) continue;
      const name = typeof obj.tool === 'string' ? obj.tool : typeof obj.name === 'string' ? obj.name : '';
      if (!allowedSet.has(name)) continue;
      const rawArgs = (obj.args ?? obj.arguments ?? {}) as unknown;
      const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
      calls.push({ id: `txt_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) });
      continue;
    }

    // 形式三：语言名就是工具名（```bash / ```read_file）
    if (allowedSet.has(fence.lang)) {
      const args = safeJsonObject(fence.code) ?? coerceArgs(fence.lang, fence.code);
      if (!args) continue;
      calls.push({ id: `txt_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, name: fence.lang, arguments: JSON.stringify(args) });
    }
  }

  return calls;
}
