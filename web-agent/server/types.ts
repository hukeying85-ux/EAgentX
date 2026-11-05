/**
 * 全局类型定义：LLM 消息、工具、SSE 事件、会话视图模型。
 * 命名尽量贴近 EAgentX 的 C# 版本（AgentSession / RunResult / Settings），便于对照阅读。
 */

export type ApprovalMode = 'readonly' | 'manual' | 'auto';

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'done'
  | 'error'
  | 'stopped';

/* ------------------------------ LLM ------------------------------ */

export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串（与 OpenAI function.arguments 一致） */
  arguments: string;
}

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** 仅用于 UI 展示：模型名 */
  model?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: LlmMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface ChatReply {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  provider: string;
  demo?: boolean;
}

export interface ChatProvider {
  id: string;
  label: string;
  model: string;
  /** true = 走标准 JSON Schema tool calling；false = 代码块文本协议 */
  nativeTools: boolean;
  demo?: boolean;
  chat(req: ChatRequest): Promise<ChatReply>;
}

/* ------------------------------ 工具 ------------------------------ */

export type ToolName =
  | 'bash'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_files'
  | 'list_skills'
  | 'read_skill'
  | 'fetch_page'
  | 'ask_user'
  | 'start_process'
  | 'stop_process';

export interface ToolResult {
  ok: boolean;
  /** 回喂给模型的文本（已做头尾截断） */
  output: string;
  /** 给 UI 用的结构化元数据 */
  meta?: Record<string, unknown>;
}

export interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 请求审批时展示的人类可读命令/摘要 */
  preview: string;
}

export interface ToolResultView {
  id: string;
  name: string;
  ok: boolean;
  output: string;
  elapsedMs: number;
  exitCode?: number;
  meta?: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  callId: string;
  tool: string;
  preview: string;
  reason: string;
}

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  id: string;
  callId: string;
  question: string;
  options: AskUserOption[];
  allowCustom: boolean;
}

/* ------------------------------ SSE 事件 ------------------------------ */

export type AgentEvent =
  | { type: 'state'; message: string; status?: SessionStatus }
  | { type: 'user_message'; text: string; at: number }
  | { type: 'assistant_start'; messageId: string; model?: string }
  | { type: 'assistant_delta'; messageId: string; text: string }
  | { type: 'assistant_end'; messageId: string; text: string; model?: string; demo?: boolean }
  | { type: 'tool_call_start'; call: ToolCallView }
  | { type: 'approval_required'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; decision: 'approved' | 'rejected' | 'auto' }
  | { type: 'question_required'; question: AskUserQuestion }
  | { type: 'question_resolved'; id: string; answer: string }
  | { type: 'tool_call_result'; result: ToolResultView }
  | { type: 'workspace_updated'; files: string[] }
  | { type: 'process_started'; processId: string; command: string; port?: number }
  | { type: 'process_output'; processId: string; chunk: string }
  | { type: 'process_stopped'; processId: string; exitCode: number | null }
  | { type: 'session_done'; status: SessionStatus; summary?: string; model?: ModelReveal }
  | { type: 'error'; message: string };

/* ------------------------------ 模型与会话配置 ------------------------------ */

export type ProviderKind = 'openai' | 'deepseek' | 'anthropic' | 'ollama' | 'custom';

export interface ModelEndpoint {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 是否使用原生 JSON Schema tool calling */
  nativeTools: boolean;
}

export interface ModelReveal {
  id: string;
  label: string;
  model: string;
  demo?: boolean;
  preliminary?: boolean;
  revealed?: boolean;
}

export interface SessionSettings {
  approvalMode: ApprovalMode;
  maxSteps: number;
}

export interface PublicConfig {
  endpoints: Array<Omit<ModelEndpoint, 'apiKey'> & { hasKey: boolean }>;
  providerOptions: Array<{ kind: ProviderKind; label: string; baseUrl: string; toolModel: string }>;
  defaults: {
    approvalMode: ApprovalMode;
    maxSteps: number;
    blindMode: boolean;
    demoMode: boolean;
    forceDemo: boolean;
    endpointId: string | null;
  };
  hasAnyKey: boolean;
  demoAvailable: boolean;
  skillsCount: number;
  leaderboard: LeaderboardRow[];
}

export interface LeaderboardRow {
  modelId: string;
  label: string;
  model: string;
  likes: number;
  dislikes: number;
  sessions: number;
  toolCalls: number;
  toolFailures: number;
  lastAt: number;
}

/* ------------------------------ 会话 UI 状态 ------------------------------ */

export type ChatItem =
  | { kind: 'user'; id: string; text: string; at: number }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      model?: string;
      demo?: boolean;
      done: boolean;
      at: number;
      feedback?: 'up' | 'down';
    }
  | { kind: 'tool'; id: string; call: ToolCallView; result?: ToolResultView; at: number }
  | {
      kind: 'approval';
      id: string;
      approval: ApprovalRequest;
      decision?: 'approved' | 'rejected' | 'auto';
      at: number;
    }
  | { kind: 'question'; id: string; question: AskUserQuestion; answer?: string; at: number }
  | { kind: 'notice'; id: string; text: string; at: number };

export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  stateMessage: string;
  settings: SessionSettings;
  model: ModelReveal | null;
  items: ChatItem[];
  files: string[];
  previewPort: number | null;
  tracePath: string | null;
  step: number;
  startedAt: number;
  feedback?: 'up' | 'down';
}
