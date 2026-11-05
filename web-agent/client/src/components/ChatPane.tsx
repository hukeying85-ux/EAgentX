/** 左栏：流式对话 + 工具执行卡 + 内联审批/提问 + 输入区。 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  FileCode2,
  Globe2,
  ListChecks,
  Loader2,
  Send,
  ShieldQuestion,
  Sparkles,
  Square,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { ApprovalMode, ChatItem, ModelReveal, SessionSettings, SessionStatus, ToolCallView, ToolResultView } from '../types';
import { ApprovalCard } from './ApprovalCard';
import { AskUserCard } from './AskUserCard';
import { MarkdownLite } from './MarkdownLite';

interface Props {
  items: ChatItem[];
  status: SessionStatus;
  stateMessage: string;
  model: ModelReveal | null;
  settings: SessionSettings;
  connected: boolean;
  onSend: (text: string) => void;
  onApprove: (id: string, decision: 'approved' | 'rejected') => void;
  onAnswer: (id: string, value: string) => void;
  onAlwaysAllow: () => void;
  onStop: () => void;
  onFeedback: (rating: 'up' | 'down') => void;
  onApprovalModeChange: (mode: ApprovalMode) => void;
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  idle: '空闲',
  running: '执行中',
  awaiting_approval: '等待审批',
  awaiting_input: '等待回答',
  done: '已完成',
  error: '异常',
  stopped: '已中断',
};

const TOOL_ICONS: Record<string, typeof Terminal> = {
  bash: Terminal,
  start_process: Terminal,
  stop_process: Terminal,
  read_file: FileCode2,
  write_file: FileCode2,
  edit_file: FileCode2,
  list_files: FileCode2,
  list_skills: ListChecks,
  read_skill: ListChecks,
  fetch_page: Globe2,
  ask_user: ShieldQuestion,
};

const SAMPLE_TASKS = [
  '帮我做一个可交互的番茄钟页面，并放到预览里',
  '生成一个待办清单应用，支持勾选和本地保存',
  '列出技能库里有哪些技能，读一个前端相关技能',
];

function ToolCard({ call, result }: { call: ToolCallView; result?: ToolResultView }) {
  const pending = !result;
  const [open, setOpen] = useState(!result?.ok);
  const Icon = TOOL_ICONS[call.name] ?? Wrench;
  const args = useMemo(() => JSON.stringify(call.args, null, 2), [call.args]);

  useEffect(() => {
    if (result && !result.ok) setOpen(true);
  }, [result]);

  return (
    <div
      className={`animate-rise overflow-hidden rounded-xl border transition ${
        pending
          ? 'border-day-line bg-day-card dark:border-night-line dark:bg-night-card'
          : result?.ok
            ? 'border-emerald-300/60 bg-emerald-50/40 dark:border-emerald-500/25 dark:bg-emerald-500/5'
            : 'border-rose-300/60 bg-rose-50/40 dark:border-rose-500/25 dark:bg-rose-500/5'
      }`}
    >
      <button type="button" onClick={() => setOpen((prev) => !prev)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-day-bg text-day-muted dark:bg-night-bg dark:text-night-muted">
          <Icon size={13} />
        </span>
        <span className="font-mono text-[12.5px] font-semibold text-day-text dark:text-night-text">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-day-muted dark:text-night-muted">
          {call.preview || '（无参数）'}
        </span>
        {pending ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-day-accent dark:text-night-accent" />
        ) : result?.ok ? (
          <CheckCircle2 size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <XCircle size={14} className="shrink-0 text-rose-600 dark:text-rose-400" />
        )}
        {result && (
          <span className="shrink-0 text-[11px] tabular-nums text-day-muted dark:text-night-muted">{result.elapsedMs}ms</span>
        )}
        <ChevronDown
          size={13}
          className={`shrink-0 text-day-muted transition ${open ? 'rotate-180' : ''} dark:text-night-muted`}
        />
      </button>

      {open && (
        <div className="border-t border-day-line/70 px-3 py-2.5 dark:border-night-line/70">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-day-muted dark:text-night-muted">入参</p>
          <pre className="scrollbar-thin max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-day-bg/80 p-2 text-[11.5px] leading-relaxed dark:bg-night-bg/80">
            {args}
          </pre>
          {result && (
            <>
              <p className="mb-1 mt-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-day-muted dark:text-night-muted">
                输出
                {typeof result.exitCode === 'number' && (
                  <span className="rounded bg-day-bg px-1.5 py-0.5 font-mono text-[10.5px] normal-case dark:bg-night-bg">
                    exit {result.exitCode}
                  </span>
                )}
              </p>
              <pre className="scrollbar-thin max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-day-bg/80 p-2 text-[11.5px] leading-relaxed dark:bg-night-bg/80">
                {result.output || '（无输出）'}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatPane(props: Props) {
  const { items, status, stateMessage, model, settings, connected } = props;
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = status === 'running' || status === 'awaiting_approval' || status === 'awaiting_input';
  const lastAssistantId = [...items].reverse().find((item) => item.kind === 'assistant' && item.done)?.id;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [items]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    props.onSend(text);
  };

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl2 border border-day-line bg-day-panel shadow-soft dark:border-night-line dark:bg-night-panel">
      {/* 状态条 */}
      <div className="flex items-center gap-2 border-b border-day-line/80 px-4 py-2.5 dark:border-night-line/80">
        <span
          className={`flex h-2 w-2 shrink-0 rounded-full ${
            status === 'running'
              ? 'animate-pulse bg-emerald-500'
              : status === 'awaiting_approval' || status === 'awaiting_input'
                ? 'animate-pulse bg-amber-500'
                : status === 'error'
                  ? 'bg-rose-500'
                  : 'bg-day-line dark:bg-night-line'
          }`}
        />
        <span className="shrink-0 text-[12px] font-semibold">{STATUS_TEXT[status]}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-day-muted dark:text-night-muted">{stateMessage}</span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            connected
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-300'
          }`}
          title={connected ? 'SSE 已连接' : 'SSE 断开，正在重连'}
        >
          {connected ? '已连接' : '重连中'}
        </span>
        {model && (
          <span
            className="hidden shrink-0 items-center gap-1 rounded-full bg-day-bg px-2 py-0.5 text-[10.5px] font-medium text-day-muted sm:flex dark:bg-night-bg dark:text-night-muted"
            title={model.preliminary ? '盲测模式：反馈后揭晓模型' : model.model}
          >
            <Bot size={11} />
            {model.label}
          </span>
        )}
      </div>

      {/* 对话流 */}
      <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-day-accent/10 text-day-accent dark:bg-night-accent/15 dark:text-night-accent">
              <Sparkles size={22} />
            </div>
            <div>
              <p className="text-[15px] font-semibold">把任务交给一个真的会动手的智能体</p>
              <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-day-muted dark:text-night-muted">
                它在隔离工作区里写文件、跑命令、查技能库，产物会实时出现在右栏 Live Preview。
                没有配置 API Key 时用内置 Demo 编排引擎，全流程同样真实可跑。
              </p>
            </div>
            <div className="grid w-full max-w-md gap-2">
              {SAMPLE_TASKS.map((task) => (
                <button
                  key={task}
                  type="button"
                  onClick={() => props.onSend(task)}
                  className="rounded-xl border border-day-line bg-day-card px-3 py-2 text-left text-[12.5px] transition hover:-translate-y-px hover:border-day-accent hover:shadow-soft dark:border-night-line dark:bg-night-card dark:hover:border-night-accent"
                >
                  {task}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((item) => {
          if (item.kind === 'user') {
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[86%] rounded-xl2 rounded-br-md bg-day-accent px-3.5 py-2 text-[13.5px] leading-relaxed text-white shadow-sm dark:bg-night-accent dark:text-night-bg">
                  {item.text}
                </div>
              </div>
            );
          }

          if (item.kind === 'assistant') {
            return (
              <div key={item.id} className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] text-day-muted dark:text-night-muted">
                  <Bot size={12} />
                  <span>{item.model ?? '智能体'}</span>
                  {item.demo && (
                    <span className="rounded bg-day-bg px-1.5 py-0.5 text-[10px] dark:bg-night-bg">Demo 引擎</span>
                  )}
                </div>
                <div className="rounded-xl2 rounded-tl-md border border-day-line bg-day-card px-3.5 py-2.5 shadow-sm dark:border-night-line dark:bg-night-card">
                  {item.text ? (
                    <MarkdownLite text={item.text} />
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[13px] text-day-muted dark:text-night-muted">
                      <Loader2 size={13} className="animate-spin" /> 正在思考…
                    </span>
                  )}
                  {!item.done && item.text && <span className="caret ml-0.5 inline-block" />}
                </div>

                {item.id === lastAssistantId && item.done && (
                  <div className="flex items-center gap-1.5 pl-1">
                    <button
                      type="button"
                      onClick={() => props.onFeedback('up')}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition ${
                        item.feedback === 'up'
                          ? 'border-emerald-400 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'border-day-line text-day-muted hover:border-emerald-400 hover:text-emerald-600 dark:border-night-line dark:text-night-muted'
                      }`}
                    >
                      <ThumbsUp size={11} /> 有用
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onFeedback('down')}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition ${
                        item.feedback === 'down'
                          ? 'border-rose-400 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                          : 'border-day-line text-day-muted hover:border-rose-400 hover:text-rose-600 dark:border-night-line dark:text-night-muted'
                      }`}
                    >
                      <ThumbsDown size={11} /> 不行
                    </button>
                  </div>
                )}
              </div>
            );
          }

          if (item.kind === 'tool') {
            return <ToolCard key={item.id} call={item.call} result={item.result} />;
          }

          if (item.kind === 'approval') {
            return (
              <ApprovalCard
                key={item.id}
                approval={item.approval}
                decision={item.decision}
                onDecide={(decision) => props.onApprove(item.approval.id, decision)}
                onAlwaysAllow={props.onAlwaysAllow}
              />
            );
          }

          if (item.kind === 'question') {
            return (
              <AskUserCard
                key={item.id}
                question={item.question}
                answer={item.answer}
                onAnswer={(value) => props.onAnswer(item.question.id, value)}
              />
            );
          }

          return (
            <p key={item.id} className="rounded-lg bg-rose-500/10 px-3 py-2 text-[12.5px] text-rose-600 dark:text-rose-300">
              {item.text}
            </p>
          );
        })}
      </div>

      {/* 输入区 */}
      <div className="border-t border-day-line/80 px-3 pb-3 pt-2.5 dark:border-night-line/80">
        <div className="mb-2 flex items-center gap-2">
          <label className="text-[11px] font-medium text-day-muted dark:text-night-muted">审批</label>
          <select
            value={settings.approvalMode}
            onChange={(event) => props.onApprovalModeChange(event.target.value as ApprovalMode)}
            className="rounded-lg border border-day-line bg-day-card px-2 py-1 text-[11.5px] outline-none transition focus:border-day-accent dark:border-night-line dark:bg-night-card dark:focus:border-night-accent"
          >
            <option value="readonly">只读自动放行（写/命令需确认）</option>
            <option value="manual">仅危险命令需确认</option>
            <option value="auto">全自动</option>
          </select>
          <span className="ml-auto text-[11px] text-day-muted dark:text-night-muted">
            Enter 发送 · Shift+Enter 换行
          </span>
        </div>

        <div className="flex items-end gap-2 rounded-xl2 border border-day-line bg-day-card p-2 transition focus-within:border-day-accent focus-within:ring-2 focus-within:ring-day-accent/15 dark:border-night-line dark:bg-night-card dark:focus-within:border-night-accent dark:focus-within:ring-night-accent/20">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={busy ? '它正在干活，你可以先准备好下一条指令…' : '描述任务，例如：做一个带深色模式的产品落地页并预览'}
            onChange={(event) => {
              setDraft(event.target.value);
              const el = event.target as HTMLTextAreaElement;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            className="scrollbar-thin max-h-40 min-h-[38px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[13.5px] leading-relaxed outline-none placeholder:text-day-muted/70 dark:placeholder:text-night-muted/60"
          />
          {busy ? (
            <button
              type="button"
              onClick={props.onStop}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-[12.5px] font-semibold text-white transition hover:bg-rose-500 active:scale-[0.98]"
            >
              <Square size={13} /> 中断
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-day-accent px-3 text-[12.5px] font-semibold text-white transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-night-accent dark:text-night-bg"
            >
              <Send size={13} /> 发送
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
