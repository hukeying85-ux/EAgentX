/** 前端用的类型（与 server/types.ts 对齐，但只保留渲染需要的部分，避免把 Node 类型带进浏览器构建）。 */

export type ApprovalMode = 'readonly' | 'manual' | 'auto';

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'done'
  | 'error'
  | 'stopped';

export interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
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
  | {
      type: 'session_done';
      status: SessionStatus;
      summary?: string;
      model?: ModelReveal;
    }
  | { type: 'error'; message: string };

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

export interface EndpointConfig {
  id: string;
  label: string;
  kind: 'openai' | 'deepseek' | 'anthropic' | 'ollama' | 'custom';
  baseUrl: string;
  model: string;
  hasKey?: boolean;
  apiKey?: string;
  nativeTools: boolean;
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

export interface PublicConfig {
  endpoints: EndpointConfig[];
  providerOptions: Array<{ kind: EndpointConfig['kind']; label: string; baseUrl: string; toolModel: string }>;
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

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  group: string;
  version: string;
  files: string[];
}
