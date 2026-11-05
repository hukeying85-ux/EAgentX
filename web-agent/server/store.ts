/**
 * 配置 / 会话 / 排行榜的集中存储（全部本地文件，无数据库依赖）。
 *
 * - 配置：`web-agent/data/config.json`（含 API Key，只留在服务端，GET 接口会脱敏）；
 * - 会话：内存 Map + 磁盘工作区 `web-agent/workspaces/<sessionId>/`；
 * - 排行榜：聚合 `data/metrics.jsonl` 里的会话与点赞信号。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalMode,
  LeaderboardRow,
  ModelEndpoint,
  ModelReveal,
  ProviderKind,
  PublicConfig,
  SessionSettings,
} from './types';
import { AgentSession } from './core/agentSession';
import { DemoProvider } from './providers/demoProvider';
import { createOnlineProvider } from './providers/llmRouter';
import { skillsCount } from './core/skillRegistry';
import { readMetrics } from './core/traceStore';
import { dataDir, workspacesRoot } from './paths';
import { WorkspaceSandbox } from './tools/workspaceSandbox';

export interface StoredConfig {
  endpoints: ModelEndpoint[];
  defaultEndpointId: string | null;
  blindMode: boolean;
  approvalMode: ApprovalMode;
  maxSteps: number;
  forceDemo: boolean;
}

export interface ProviderOption {
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  toolModel: string;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  { kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', toolModel: 'gpt-4o-mini' },
  { kind: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', toolModel: 'deepseek-chat' },
  { kind: 'anthropic', label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', toolModel: 'claude-3-5-sonnet-latest' },
  { kind: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', toolModel: 'qwen2.5:7b' },
  { kind: 'custom', label: '自定义 OpenAI 兼容', baseUrl: '', toolModel: '' },
];

const CONFIG_FILE = () => path.join(dataDir(), 'config.json');

function defaultConfig(): StoredConfig {
  const endpoints: ModelEndpoint[] = [];
  if (process.env.OPENAI_API_KEY) {
    endpoints.push({
      id: 'openai-default',
      label: 'OpenAI',
      kind: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      nativeTools: true,
    });
  }
  if (process.env.DEEPSEEK_API_KEY) {
    endpoints.push({
      id: 'deepseek-default',
      label: 'DeepSeek',
      kind: 'deepseek',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      apiKey: process.env.DEEPSEEK_API_KEY,
      nativeTools: true,
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    endpoints.push({
      id: 'anthropic-default',
      label: 'Anthropic Claude',
      kind: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
      apiKey: process.env.ANTHROPIC_API_KEY,
      nativeTools: true,
    });
  }
  return {
    endpoints,
    defaultEndpointId: endpoints[0]?.id ?? null,
    blindMode: false,
    approvalMode: 'manual',
    maxSteps: 12,
    forceDemo: false,
  };
}

export function loadConfig(): StoredConfig {
  const file = CONFIG_FILE();
  if (!fs.existsSync(file)) return defaultConfig();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredConfig>;
    const base = defaultConfig();
    return {
      endpoints: Array.isArray(parsed.endpoints) ? (parsed.endpoints as ModelEndpoint[]) : base.endpoints,
      defaultEndpointId: parsed.defaultEndpointId ?? base.endpoints[0]?.id ?? null,
      blindMode: Boolean(parsed.blindMode),
      approvalMode: parsed.approvalMode === 'auto' || parsed.approvalMode === 'readonly' ? parsed.approvalMode : 'manual',
      maxSteps: clampSteps(parsed.maxSteps ?? base.maxSteps),
      forceDemo: Boolean(parsed.forceDemo),
    };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: StoredConfig): StoredConfig {
  const normalized: StoredConfig = {
    ...config,
    maxSteps: clampSteps(config.maxSteps),
    endpoints: config.endpoints.map((endpoint) => ({
      ...endpoint,
      nativeTools: endpoint.nativeTools !== false,
    })),
  };
  try {
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(normalized, null, 2), 'utf8');
  } catch {
    /* 磁盘不可写时保持内存配置 */
  }
  return normalized;
}

function clampSteps(steps: number): number {
  const value = Number.isFinite(steps) ? Math.floor(steps) : 12;
  return Math.min(30, Math.max(3, value));
}

export function leaderboard(): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow>();
  for (const metric of readMetrics()) {
    const key = metric.model ?? 'unknown';
    if (!key || key === 'hidden') continue;
    if (metric.kind === 'session') {
      const row = rows.get(key) ?? {
        modelId: key,
        label: metric.modelLabel ?? key,
        model: key,
        likes: 0,
        dislikes: 0,
        sessions: 0,
        toolCalls: 0,
        toolFailures: 0,
        lastAt: 0,
      };
      row.sessions += 1;
      row.toolCalls += metric.toolCalls ?? 0;
      row.toolFailures += metric.toolFailures ?? 0;
      row.lastAt = Math.max(row.lastAt, metric.at);
      rows.set(key, row);
    } else if (metric.kind === 'feedback' && metric.rating) {
      const row = rows.get(key) ?? {
        modelId: key,
        label: metric.modelLabel ?? key,
        model: key,
        likes: 0,
        dislikes: 0,
        sessions: 0,
        toolCalls: 0,
        toolFailures: 0,
        lastAt: 0,
      };
      if (metric.rating === 'up') row.likes += 1;
      else row.dislikes += 1;
      row.lastAt = Math.max(row.lastAt, metric.at);
      rows.set(key, row);
    }
  }
  return Array.from(rows.values()).sort((a, b) => b.likes - a.likes || b.sessions - a.sessions);
}

export function publicConfig(): PublicConfig {
  const config = loadConfig();
  const endpoints = config.endpoints.map(({ apiKey, ...rest }) => ({ ...rest, hasKey: Boolean(apiKey) }));
  return {
    endpoints,
    providerOptions: PROVIDER_OPTIONS,
    defaults: {
      approvalMode: config.approvalMode,
      maxSteps: config.maxSteps,
      blindMode: config.blindMode,
      demoMode: config.forceDemo || config.endpoints.length === 0,
      forceDemo: config.forceDemo,
      endpointId: config.defaultEndpointId,
    },
    hasAnyKey: config.endpoints.some((endpoint) => Boolean(endpoint.apiKey)),
    demoAvailable: true,
    skillsCount: skillsCount(),
    leaderboard: leaderboard(),
  };
}

export interface ResolvedProvider {
  provider: ReturnType<typeof createOnlineProvider> | DemoProvider;
  reveal: ModelReveal;
  blind: boolean;
  demo: boolean;
}

/** 选择本次会话使用的模型：盲测随机 / 指定端点 / Demo 兜底。 */
export function resolveProvider(config: StoredConfig, endpointId?: string | null): ResolvedProvider {
  const usable = config.endpoints.filter((endpoint) => endpoint.apiKey || endpoint.kind === 'ollama');

  if (config.forceDemo || usable.length === 0) {
    const provider = new DemoProvider();
    return {
      provider,
      reveal: { id: 'demo', label: provider.label, model: provider.model, demo: true },
      blind: false,
      demo: true,
    };
  }

  let endpoint: ModelEndpoint;
  if (config.blindMode && usable.length > 0) {
    endpoint = usable[Math.floor(Math.random() * usable.length)];
  } else {
    endpoint = usable.find((item) => item.id === (endpointId ?? config.defaultEndpointId)) ?? usable[0];
  }

  const provider = createOnlineProvider(endpoint);
  return {
    provider,
    reveal: { id: endpoint.id, label: endpoint.label, model: endpoint.model, demo: false, revealed: false },
    blind: config.blindMode,
    demo: false,
  };
}

/* ------------------------------ 会话注册表 ------------------------------ */

class SessionRegistry {
  private sessions = new Map<string, AgentSession>();

  create(options: { endpointId?: string | null } = {}): AgentSession {
    const config = loadConfig();
    const resolved = resolveProvider(config, options.endpointId);
    const id = `sess-${randomUUID().slice(0, 8)}`;
    const sandbox = new WorkspaceSandbox(path.join(workspacesRoot(), id));
    const settings: SessionSettings = { approvalMode: config.approvalMode, maxSteps: config.maxSteps };
    const session = new AgentSession({
      id,
      sandbox,
      provider: resolved.provider,
      modelReveal: resolved.reveal,
      settings,
      blind: resolved.blind,
      demo: resolved.demo,
    });
    this.sessions.set(id, session);
    this.gc();
    return session;
  }

  get(id: string): AgentSession | null {
    return this.sessions.get(id) ?? null;
  }

  /** 服务退出时回收所有后台子进程，避免留下孤儿 dev server。 */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  delete(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.dispose();
    this.sessions.delete(id);
  }

  /** 回收 6 小时没有活动的会话（工作区文件保留）。 */
  private gc(): void {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [id, session] of this.sessions) {
      if (session.startedAt < cutoff && session.status !== 'running') {
        this.delete(id);
      }
    }
  }
}

export const sessions = new SessionRegistry();

export function sessionIdIsValid(id: string): boolean {
  return /^sess-[a-z0-9]{4,32}$/i.test(id);
}
