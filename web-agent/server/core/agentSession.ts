/**
 * 智能体主循环（移植并升级自 EAgentX `src/Core/AgentSession.cs`）。
 *
 * 保留桌面版的工程纪律：
 *   - 最大步数熔断、空回复催促（最多 2 次）、[TASK_DONE] / [NEED_INPUT] 状态切分；
 *   - 每条命令先过 CommandShape 残片检查，再执行并把真实输出回喂；
 *   - 每一步都写进 `.eagentx/session-*.md` 轨迹。
 *
 * Web 版新增：
 *   - SSE 流式事件（assistant_delta / tool_call_* / approval_required / question_required …）；
 *   - 人工审批与 ask_user 提问的「挂起 - 恢复」Promise；
 *   - 原生 tool calling 的多工具单轮支持（每个 tool_call_id 都回传结果，含拒绝场景）。
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ApprovalMode,
  ApprovalRequest,
  AskUserOption,
  AskUserQuestion,
  ChatItem,
  ChatProvider,
  LlmMessage,
  ModelReveal,
  SessionSettings,
  SessionSnapshot,
  SessionStatus,
  ToolCall,
  ToolCallView,
  ToolName,
  ToolResult,
  ToolResultView,
} from '../types';
import { createTools, toolSchemas } from '../tools';
import type { ToolContext, ToolDefinition } from '../tools';
import { ProcessRegistry } from '../tools/processTool';
import { WorkspaceSandbox } from '../tools/workspaceSandbox';
import { buildSystemPrompt, prompts } from './prompt';
import { TraceStore } from './traceStore';
import { recordMetric } from './traceStore';

function uid(prefix = 'id'): string {
  return `${prefix}_${randomUUID().slice(0, 10)}`;
}

const DANGEROUS_COMMAND = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /curl[^|]*\|\s*(ba)?sh/i,
  /wget[^|]*\|\s*(ba)?sh/i,
  /:\(\)\s*\{/,
  />\s*\/dev\/(sd|nvme)/i,
  /\b(shutdown|reboot|poweroff)\b/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /Remove-Item[^\n]*-(Recurse|Force)/i,
  /\breg\s+delete\b/i,
  /\bchmod\s+777\b/i,
];

const MUTATING_TOOLS: ToolName[] = ['write_file', 'edit_file', 'bash', 'start_process', 'stop_process'];

export interface AgentSessionOptions {
  id: string;
  sandbox: WorkspaceSandbox;
  provider: ChatProvider;
  modelReveal: ModelReveal;
  settings: SessionSettings;
  blind?: boolean;
  demo?: boolean;
}

export class AgentSession {
  readonly id: string;
  readonly sandbox: WorkspaceSandbox;
  readonly provider: ChatProvider;
  readonly trace: TraceStore;
  readonly processes: ProcessRegistry;
  readonly startedAt = Date.now();
  readonly blind: boolean;

  status: SessionStatus = 'idle';
  stateMessage = '就绪';
  settings: SessionSettings;
  modelReveal: ModelReveal;
  items: ChatItem[] = [];
  messages: LlmMessage[] = [];
  previewPort: number | null = null;
  feedback?: 'up' | 'down';
  step = 0;

  private tools = createTools();
  private listeners = new Set<(event: AgentEvent) => void>();
  private abort: AbortController | null = null;
  private pendingApproval: { id: string; item: Extract<ChatItem, { kind: 'approval' }>; resolve: (ok: boolean) => void } | null =
    null;
  private pendingQuestion: {
    id: string;
    item: Extract<ChatItem, { kind: 'question' }>;
    resolve: (answer: string) => void;
  } | null = null;
  private running = false;
  private hasRun = false;
  private stats = { steps: 0, toolCalls: 0, toolFailures: 0 };
  private finished = false;

  constructor(options: AgentSessionOptions) {
    this.id = options.id;
    this.sandbox = options.sandbox;
    this.provider = options.provider;
    this.settings = options.settings;
    this.modelReveal = options.modelReveal;
    this.blind = Boolean(options.blind);

    this.processes = new ProcessRegistry({
      onOutput: (processId, chunk) => this.emit({ type: 'process_output', processId, chunk: chunk.slice(-4000) }),
      onExit: (processId, exitCode) => this.emit({ type: 'process_stopped', processId, exitCode }),
      onPort: (processId, port) => {
        this.previewPort = port;
        const info = this.processes.get(processId);
        this.emit({ type: 'process_started', processId, command: info?.command ?? '', port });
        this.setState(`后台服务已在端口 ${port} 就绪，右栏预览已接入`);
      },
    });

    this.trace = new TraceStore(this.sandbox.root, {
      sessionId: this.id,
      model: `${this.modelReveal.label}${this.blind ? '（盲测）' : ''}`,
      modelId: this.modelReveal.model,
      approvalMode: this.settings.approvalMode,
      workspace: this.sandbox.root,
      demo: Boolean(options.demo || this.provider.demo),
    });
  }

  /* ------------------------------ 订阅 ------------------------------ */

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* 单个订阅者异常不影响会话 */
      }
    }
  }

  private setState(message: string, status?: SessionStatus): void {
    this.stateMessage = message;
    if (status) this.status = status;
    this.emit({ type: 'state', message, status: this.status });
  }

  private pushItem(item: ChatItem): void {
    this.items.push(item);
    if (this.items.length > 400) this.items.splice(0, this.items.length - 400);
  }

  private files(): string[] {
    return this.sandbox.list(300);
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      status: this.status,
      stateMessage: this.stateMessage,
      settings: this.settings,
      model: this.publicModel(),
      items: this.items,
      files: this.files(),
      previewPort: this.previewPort,
      tracePath: this.trace.displayPath,
      step: this.step,
      startedAt: this.startedAt,
      feedback: this.feedback,
    };
  }

  /** 盲测模式下反馈前不暴露真实模型。 */
  publicModel(): ModelReveal {
    if (this.blind && !this.modelReveal.revealed) {
      return { id: 'blind', label: '盲测模型（反馈后揭晓）', model: 'hidden', demo: this.provider.demo, preliminary: true };
    }
    return this.modelReveal;
  }

  /* ------------------------------ 主循环 ------------------------------ */

  async send(text: string): Promise<void> {
    const task = (text ?? '').trim();
    if (!task) return;
    if (this.running) throw new Error('会话正在运行中，请先等待完成或中断。');

    this.running = true;
    this.finished = false;
    this.status = 'running';
    this.abort = new AbortController();
    const at = Date.now();

    this.pushItem({ kind: 'user', id: uid('u'), text: task, at });
    this.emit({ type: 'user_message', text: task, at });
    this.trace.user(task);

    const isFirstTask = !this.hasRun;
    if (isFirstTask) {
      this.messages = [
        {
          role: 'system',
          content: buildSystemPrompt({
            workspace: this.sandbox.root,
            sessionId: this.id,
            approvalMode: this.settings.approvalMode,
            nativeTools: this.provider.nativeTools,
            toolNames: Array.from(this.tools.keys()),
            demo: Boolean(this.provider.demo),
          }),
        },
      ];
      this.hasRun = true;
    }
    this.messages.push({ role: 'user', content: isFirstTask ? prompts.firstTask(task) : prompts.followUp(task) });

    let nudges = 0;

    try {
      for (let step = 1; step <= this.settings.maxSteps; step++) {
        this.step = step;
        this.stats.steps = step;
        this.setState(`第 ${step} 步：等待模型回复…`);

        const messageId = uid('a');
        this.pushItem({
          kind: 'assistant',
          id: messageId,
          text: '',
          model: this.publicModel().label,
          demo: this.provider.demo,
          done: false,
          at: Date.now(),
        });
        this.emit({ type: 'assistant_start', messageId, model: this.publicModel().label });

        let streamed = '';
        const reply = await this.provider.chat({
          messages: this.messages,
          tools: toolSchemas(this.tools),
          signal: this.abort.signal,
          onDelta: (delta) => {
            streamed += delta;
            this.updateAssistant(messageId, streamed);
            this.emit({ type: 'assistant_delta', messageId, text: delta });
          },
        });

        const text = (reply.text && reply.text.length >= streamed.length ? reply.text : streamed) || '';
        this.updateAssistant(messageId, text, true);
        this.emit({
          type: 'assistant_end',
          messageId,
          text,
          model: this.publicModel().label,
          demo: Boolean(reply.demo ?? this.provider.demo),
        });
        this.messages.push({ role: 'assistant', content: text, toolCalls: reply.toolCalls });
        this.trace.assistant(step, text || '（空回复）');

        const done = /\[TASK_DONE\]/i.test(text);
        const needInput = /\[NEED_INPUT\]/i.test(text);
        const calls = reply.toolCalls ?? [];

        if (calls.length === 0) {
          if (done) {
            this.finish('done', summarize(text));
            return;
          }
          if (needInput) {
            this.finish('done', summarize(text));
            return;
          }
          if (nudges < 2) {
            nudges++;
            this.setState(`模型只回了文字，正在催它继续（${nudges}/2）…`);
            this.messages.push({ role: 'user', content: prompts.continueNudge() });
            continue;
          }
          this.finish('done', summarize(text) || '本轮结束（没有需要执行的工具调用）');
          return;
        }

        nudges = 0;
        for (const call of calls) {
          await this.executeCall(call, step);
        }
        this.emit({ type: 'workspace_updated', files: this.files() });
      }

      // 步数用尽：给模型一次收尾机会
      this.messages.push({ role: 'user', content: prompts.maxSteps(this.settings.maxSteps) });
      const wrapUp = await this.provider.chat({
        messages: this.messages,
        tools: [],
        signal: this.abort.signal,
      });
      if (wrapUp.text) {
        const id = uid('a');
        this.pushItem({
          kind: 'assistant',
          id,
          text: wrapUp.text,
          model: this.publicModel().label,
          demo: this.provider.demo,
          done: true,
          at: Date.now(),
        });
        this.emit({ type: 'assistant_end', messageId: id, text: wrapUp.text, model: this.publicModel().label });
      }
      this.finish('error', `已达到步数上限 ${this.settings.maxSteps}，任务未完全结束。`);
    } catch (error) {
      const aborted = this.abort?.signal.aborted;
      if (aborted) {
        this.finish('stopped', '已被用户中断。');
      } else {
        const message = (error as Error).message ?? String(error);
        this.pushItem({ kind: 'notice', id: uid('n'), text: `出错了：${message}`, at: Date.now() });
        this.emit({ type: 'error', message });
        this.finish('error', message);
      }
    } finally {
      this.running = false;
      this.abort = null;
      this.rejectPending();
    }
  }

  private updateAssistant(id: string, text: string, done = false): void {
    const item = this.items.find((entry) => entry.kind === 'assistant' && entry.id === id);
    if (item && item.kind === 'assistant') {
      item.text = text;
      if (done) item.done = true;
    }
  }

  private finish(status: SessionStatus, summary?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.status = status;
    this.stateMessage =
      status === 'done' ? '任务完成' : status === 'stopped' ? '已中断' : status === 'error' ? '异常结束' : this.stateMessage;
    this.trace.finish(status, summary ?? '', this.stats);
    this.emit({
      type: 'session_done',
      status,
      summary,
      model: this.publicModel(),
    });
    this.emit({ type: 'workspace_updated', files: this.files() });
  }

  /* ------------------------------ 工具执行 ------------------------------ */

  private parseArgs(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return {};
    } catch {
      return {};
    }
  }

  private preview(tool: string, args: Record<string, unknown>): string {
    switch (tool) {
      case 'bash':
      case 'start_process':
        return String(args.command ?? '');
      case 'write_file':
      case 'edit_file':
      case 'read_file':
      case 'list_files':
        return String(args.path ?? '');
      case 'read_skill':
        return `技能：${String(args.name ?? '')}`;
      case 'fetch_page':
        return String(args.url ?? '');
      case 'ask_user':
        return String(args.question ?? '');
      case 'stop_process':
        return String(args.process_id ?? '');
      default:
        return JSON.stringify(args).slice(0, 200);
    }
  }

  private needsApproval(tool: ToolDefinition, args: Record<string, unknown>): { needed: boolean; reason: string } {
    const mode: ApprovalMode = this.settings.approvalMode;
    if (mode === 'auto') return { needed: false, reason: '' };

    const command = String(args.command ?? '');
    const dangerous = DANGEROUS_COMMAND.some((pattern) => pattern.test(command));

    if (mode === 'readonly') {
      if (tool.readOnly) return { needed: false, reason: '' };
      return { needed: true, reason: '当前为「只读自动放行」模式：所有写文件与命令都需要确认。' };
    }

    // manual：危险命令确认，普通写文件安全放行
    if (dangerous) return { needed: true, reason: '检测到可能破坏性的命令，需要人工确认。' };
    return { needed: false, reason: '' };
  }

  private requestApproval(view: ToolCallView, reason: string): Promise<boolean> {
    const id = uid('ap');
    const approval: ApprovalRequest = { id, callId: view.id, tool: view.name, preview: view.preview, reason };
    const item: Extract<ChatItem, { kind: 'approval' }> = { kind: 'approval', id, approval, at: Date.now() };
    this.pushItem(item);
    this.emit({ type: 'approval_required', approval });
    this.setState('等待你确认这条命令…', 'awaiting_approval');

    return new Promise<boolean>((resolve) => {
      this.pendingApproval = { id, item, resolve };
    });
  }

  private requestQuestion(
    callId: string,
    question: string,
    options: AskUserOption[],
    allowCustom: boolean,
  ): Promise<string> {
    const id = uid('q');
    const payload: AskUserQuestion = { id, callId, question, options, allowCustom };
    const item: Extract<ChatItem, { kind: 'question' }> = { kind: 'question', id, question: payload, at: Date.now() };
    this.pushItem(item);
    this.emit({ type: 'question_required', question: payload });
    this.setState('等待你回答问题…', 'awaiting_input');
    return new Promise<string>((resolve) => {
      this.pendingQuestion = { id, item, resolve };
    });
  }

  approve(id: string, decision: 'approved' | 'rejected'): boolean {
    const pending = this.pendingApproval;
    if (!pending || pending.id !== id) return false;
    this.pendingApproval = null;
    pending.item.decision = decision;
    this.emit({ type: 'approval_resolved', id, decision });
    this.status = 'running';
    this.setState('继续执行…', 'running');
    pending.resolve(decision === 'approved');
    return true;
  }

  /** 切换审批模式；切到全自动时顺手放行当前挂起的那条审批。 */
  setApprovalMode(mode: ApprovalMode): void {
    this.settings = { ...this.settings, approvalMode: mode };
    if (mode === 'auto' && this.pendingApproval) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.item.decision = 'auto';
      this.emit({ type: 'approval_resolved', id: pending.id, decision: 'auto' });
      this.status = 'running';
      this.setState('已切换为全自动，继续执行…', 'running');
      pending.resolve(true);
    }
  }

  answer(id: string, answerText: string): boolean {
    const pending = this.pendingQuestion;
    if (!pending || pending.id !== id) return false;
    this.pendingQuestion = null;
    const value = (answerText ?? '').trim() || '（用户留空）';
    pending.item.answer = value;
    this.emit({ type: 'question_resolved', id, answer: value });
    this.status = 'running';
    this.setState('收到你的回答，继续…', 'running');
    pending.resolve(value);
    return true;
  }

  private rejectPending(): void {
    if (this.pendingApproval) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.item.decision = 'rejected';
      pending.resolve(false);
    }
    if (this.pendingQuestion) {
      const pending = this.pendingQuestion;
      this.pendingQuestion = null;
      pending.item.answer = '（会话已中断）';
      pending.resolve('（会话已中断）');
    }
  }

  private async executeCall(call: ToolCall, step: number): Promise<void> {
    const tool = this.tools.get(call.name as ToolName);
    const args = this.parseArgs(call.arguments);
    const preview = this.preview(call.name, args);
    const view: ToolCallView = { id: call.id, name: call.name, args, preview };

    this.pushItem({ kind: 'tool', id: call.id, call: view, at: Date.now() });
    this.emit({ type: 'tool_call_start', call: view });

    const appendToolMessage = (result: ToolResult) => {
      this.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `${call.name} → ${result.ok ? '成功' : '失败'}\n${result.output}`,
      });
    };

    if (!tool) {
      const result: ToolResult = { ok: false, output: `未知工具「${call.name}」，可用工具：${Array.from(this.tools.keys()).join(', ')}` };
      appendToolMessage(result);
      this.completeTool(call.id, call.name, result, 0);
      return;
    }

    const gate = this.needsApproval(tool, args);
    if (gate.needed) {
      const approved = await this.requestApproval(view, gate.reason);
      this.trace.approval(call.name, preview, approved ? '通过' : '拒绝');
      if (!approved) {
        const result: ToolResult = {
          ok: false,
          output: '用户拒绝执行这次工具调用，未做任何修改。请换一种方式，或说明原因后输出 [TASK_DONE]。',
          meta: { denied: true },
        };
        appendToolMessage(result);
        this.completeTool(call.id, call.name, result, 0);
        return;
      }
    }

    this.setState(`执行工具：${call.name}…`, 'running');
    const startedAt = Date.now();
    const ctx: ToolContext = {
      sandbox: this.sandbox,
      emit: (event) => this.emit(event),
      processes: this.processes,
      askUser: (_callId, question, options, allowCustom) => this.requestQuestion(call.id, question, options, allowCustom),
    };

    let result: ToolResult;
    try {
      result = await tool.handler(args, ctx);
    } catch (error) {
      result = { ok: false, output: `工具执行异常：${(error as Error).message}` };
    }
    const elapsed = Date.now() - startedAt;

    appendToolMessage(result);
    this.completeTool(call.id, call.name, result, elapsed);
    this.trace.tool(step, call.name, JSON.stringify(args).slice(0, 4000), result.output.slice(0, 6000), result.ok);

    const processId = result.meta?.processId;
    if (typeof processId === 'string') {
      const info = this.processes.get(processId);
      this.emit({
        type: 'process_started',
        processId,
        command: info?.command ?? String(args.command ?? ''),
        port: info?.port ?? undefined,
      });
      if (info?.port) this.previewPort = info.port;
    }
    if (result.meta?.written || call.name === 'write_file' || call.name === 'edit_file') {
      this.emit({ type: 'workspace_updated', files: this.files() });
    }
  }

  private completeTool(callId: string, name: string, result: ToolResult, elapsedMs: number): void {
    const item = this.items.find((entry) => entry.kind === 'tool' && entry.id === callId);
    const view: ToolResultView = {
      id: callId,
      name,
      ok: result.ok,
      output: result.output,
      elapsedMs,
      exitCode: typeof result.meta?.exitCode === 'number' ? (result.meta.exitCode as number) : undefined,
      meta: result.meta,
    };
    if (item && item.kind === 'tool') item.result = view;
    this.stats.toolCalls++;
    if (!result.ok) this.stats.toolFailures++;
    this.emit({ type: 'tool_call_result', result: view });
  }

  /* ------------------------------ 中断 / 反馈 ------------------------------ */

  stop(): void {
    this.abort?.abort(new Error('用户中断'));
    this.rejectPending();
    if (this.status === 'running' || this.status === 'awaiting_approval' || this.status === 'awaiting_input') {
      this.status = 'stopped';
      this.stateMessage = '已中断';
      this.trace.finish('stopped', '用户中断', this.stats);
      this.emit({ type: 'session_done', status: 'stopped', summary: '已中断' });
    }
  }

  setFeedback(rating: 'up' | 'down'): ModelReveal {
    this.feedback = rating;
    const assistants = this.items.filter((item): item is Extract<ChatItem, { kind: 'assistant' }> => item.kind === 'assistant');
    const last = assistants[assistants.length - 1];
    if (last) last.feedback = rating;
    recordMetric({
      kind: 'feedback',
      at: Date.now(),
      sessionId: this.id,
      model: this.modelReveal.model,
      modelLabel: this.modelReveal.label,
      demo: this.provider.demo,
      rating,
      blind: this.blind,
    });
    this.modelReveal = { ...this.modelReveal, revealed: true };
    return this.publicModel();
  }

  dispose(): void {
    this.listeners.clear();
    this.rejectPending();
    this.processes.killAll();
  }
}

function summarize(text: string): string {
  const cleaned = text
    .replace(/\[TASK_DONE\]/gi, '')
    .replace(/\[NEED_INPUT\]/gi, '')
    .trim();
  const firstLine = cleaned.split('\n').find((line) => line.trim().length > 0) ?? '';
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}
