/**
 * 会话轨迹与评测信号。
 *
 * - 轨迹：写进会话工作区 `.eagentx/session-<id>.md`，格式对齐 EAgentX 的会话记录，可审计、可回放；
 * - 评测：每次会话结束追加一行 JSONL 到 `web-agent/data/metrics.jsonl`（步数/耗时/工具成败/点赞），
 *   盲测模式揭晓的模型也会一起落盘，供 Leaderboard 统计。
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths';

export interface TraceMeta {
  sessionId: string;
  /** 展示用名称（写进 Markdown 表头） */
  model: string;
  /** 真实模型标识（写进 JSONL 评测信号，排行榜按它聚合） */
  modelId: string;
  approvalMode: string;
  workspace: string;
  demo: boolean;
}

export class TraceStore {
  readonly filePath: string | null;
  private readonly meta: TraceMeta;
  private readonly startedAt = Date.now();

  constructor(workspaceRoot: string, meta: TraceMeta) {
    this.meta = meta;
    try {
      const dir = path.join(workspaceRoot, '.eagentx');
      fs.mkdirSync(dir, { recursive: true });
      this.filePath = path.join(dir, `session-${meta.sessionId}.md`);
      const header = [
        '# EAgentX Web Agent 会话记录',
        '',
        `- 时间: ${formatTime(new Date())}`,
        `- 会话: ${meta.sessionId}`,
        `- 模型: ${meta.model}${meta.demo && !meta.model.includes('Demo') ? '（Demo 编排引擎）' : ''}`,
        `- 审批模式: ${meta.approvalMode}`,
        `- 工作目录: ${meta.workspace}`,
        '',
        '',
      ].join('\n');
      fs.writeFileSync(this.filePath, header, 'utf8');
    } catch {
      this.filePath = null;
    }
  }

  get displayPath(): string | null {
    return this.filePath ? path.relative(process.cwd(), this.filePath) : null;
  }

  append(text: string): void {
    if (!this.filePath) return;
    try {
      fs.appendFileSync(this.filePath, text, 'utf8');
    } catch {
      /* 轨迹写不了不影响主流程 */
    }
  }

  section(title: string, body: string): void {
    this.append(`## ${title}\n\n${body.trim()}\n\n`);
  }

  user(text: string): void {
    this.section('用户', text);
  }

  assistant(step: number, text: string): void {
    this.section(`助手（第 ${step} 步）`, text);
  }

  tool(step: number, name: string, args: string, result: string, ok: boolean): void {
    this.section(
      `工具（第 ${step} 步 · ${name} · ${ok ? '成功' : '失败'}）`,
      `入参：\n\n\`\`\`json\n${args}\n\`\`\`\n\n结果：\n\n\`\`\`text\n${result}\n\`\`\``,
    );
  }

  approval(name: string, preview: string, decision: string): void {
    this.section('审批', `工具：${name}\n命令：${preview}\n结论：${decision}`);
  }

  finish(status: string, summary: string, stats: { steps: number; toolCalls: number; toolFailures: number }): void {
    this.section(
      '结束',
      [
        `- 状态: ${status}`,
        `- 总耗时: ${Date.now() - this.startedAt}ms`,
        `- 步数: ${stats.steps}`,
        `- 工具调用: ${stats.toolCalls}（失败 ${stats.toolFailures}）`,
        summary ? `- 总结: ${summary}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    recordMetric({
      kind: 'session',
      at: Date.now(),
      sessionId: this.meta.sessionId,
      model: this.meta.modelId,
      modelLabel: this.meta.model,
      demo: this.meta.demo,
      approvalMode: this.meta.approvalMode,
      status,
      elapsedMs: Date.now() - this.startedAt,
      steps: stats.steps,
      toolCalls: stats.toolCalls,
      toolFailures: stats.toolFailures,
    });
  }
}

export interface MetricRecord {
  kind: 'session' | 'feedback';
  at: number;
  sessionId: string;
  model?: string;
  modelLabel?: string;
  demo?: boolean;
  approvalMode?: string;
  status?: string;
  elapsedMs?: number;
  steps?: number;
  toolCalls?: number;
  toolFailures?: number;
  rating?: 'up' | 'down';
  blind?: boolean;
}

export function recordMetric(record: MetricRecord): void {
  try {
    const file = path.join(dataDir(), 'metrics.jsonl');
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    /* 评测落盘失败不影响主流程 */
  }
}

export function readMetrics(limit = 2000): MetricRecord[] {
  try {
    const file = path.join(dataDir(), 'metrics.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as MetricRecord;
        } catch {
          return null;
        }
      })
      .filter((row): row is MetricRecord => row !== null);
  } catch {
    return [];
  }
}

function formatTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}
