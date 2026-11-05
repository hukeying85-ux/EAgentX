/** 右栏工作台：Live Preview / 文件 / 终端 / 轨迹评估。 */

import { useEffect, useMemo, useState } from 'react';
import {
  Code2,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Maximize2,
  Monitor,
  RefreshCw,
  ScrollText,
  Smartphone,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { api } from '../api';
import type { TerminalLine } from '../useAgent';
import type { ModelReveal, SessionSettings, SessionStatus } from '../types';

type Tab = 'preview' | 'files' | 'terminal' | 'trace';

interface Props {
  sessionId: string | null;
  files: string[];
  previewPort: number | null;
  terminal: TerminalLine[];
  traceText: string;
  status: SessionStatus;
  model: ModelReveal | null;
  settings: SessionSettings;
  onRefreshFiles: () => void;
  onRefreshTrace: () => void;
}

const TABS: Array<{ id: Tab; label: string; icon: typeof Monitor }> = [
  { id: 'preview', label: 'Live Preview', icon: Monitor },
  { id: 'files', label: '文件', icon: FolderOpen },
  { id: 'terminal', label: '终端', icon: TerminalIcon },
  { id: 'trace', label: '轨迹评估', icon: ScrollText },
];

export function WorkbenchPane(props: Props) {
  const { sessionId, files, previewPort, terminal, traceText } = props;
  const [tab, setTab] = useState<Tab>('preview');
  const [tick, setTick] = useState(0);
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [selected, setSelected] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);

  const previewUrl = sessionId ? `/preview/${sessionId}/?t=${tick}` : 'about:blank';

  useEffect(() => {
    if (tab !== 'trace') return;
    setTraceLoading(true);
    props.onRefreshTrace();
    const timer = setTimeout(() => setTraceLoading(false), 400);
    return () => clearTimeout(timer);
    // 只在切到轨迹页签时拉一次，之后由 session_done 事件驱动刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (!selected && files.length > 0) setSelected(files[0]);
  }, [files, selected]);

  useEffect(() => {
    if (!sessionId || !selected) return;
    let cancelled = false;
    setFileError(null);
    api
      .file(sessionId, selected)
      .then((result) => {
        if (!cancelled) setFileContent(result.content);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setFileContent('');
          setFileError(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selected]);

  const terminalText = useMemo(
    () =>
      terminal
        .map((line) => `$ ${line.label}\n${line.text}`.trim())
        .join('\n\n────────────────────────────\n\n'),
    [terminal],
  );

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl2 border border-day-line bg-day-panel shadow-soft dark:border-night-line dark:bg-night-panel">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-day-line/80 px-2 py-1.5 dark:border-night-line/80">
        {TABS.map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition ${
                active
                  ? 'bg-day-card text-day-text shadow-sm dark:bg-night-card dark:text-night-text'
                  : 'text-day-muted hover:bg-day-bg/70 hover:text-day-text dark:text-night-muted dark:hover:bg-night-bg/60 dark:hover:text-night-text'
              }`}
            >
              <Icon size={13} />
              {entry.label}
              {entry.id === 'files' && files.length > 0 && (
                <span className="rounded-full bg-day-accent/10 px-1.5 text-[10px] text-day-accent dark:bg-night-accent/15 dark:text-night-accent">
                  {files.length}
                </span>
              )}
            </button>
          );
        })}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {previewPort && (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
              端口 {previewPort}
            </span>
          )}
          {tab === 'preview' && (
            <>
              <button
                type="button"
                onClick={() => setViewport((prev) => (prev === 'desktop' ? 'mobile' : 'desktop'))}
                className="rounded-md p-1.5 text-day-muted transition hover:bg-day-bg hover:text-day-text dark:text-night-muted dark:hover:bg-night-bg dark:hover:text-night-text"
                title={viewport === 'desktop' ? '切换到手机视口' : '切换到桌面视口'}
              >
                {viewport === 'desktop' ? <Smartphone size={13} /> : <Maximize2 size={13} />}
              </button>
              <button
                type="button"
                onClick={() => setTick((prev) => prev + 1)}
                className="rounded-md p-1.5 text-day-muted transition hover:bg-day-bg hover:text-day-text dark:text-night-muted dark:hover:bg-night-bg dark:hover:text-night-text"
                title="刷新预览"
              >
                <RefreshCw size={13} />
              </button>
              {sessionId && (
                <a
                  href={`/preview/${sessionId}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md p-1.5 text-day-muted transition hover:bg-day-bg hover:text-day-text dark:text-night-muted dark:hover:bg-night-bg dark:hover:text-night-text"
                  title="在新窗口打开"
                >
                  <ExternalLink size={13} />
                </a>
              )}
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'preview' && (
          <div className="flex h-full flex-col items-center justify-center bg-day-bg/60 p-3 dark:bg-night-bg/40">
            <div
              className={`h-full overflow-hidden rounded-xl border border-day-line bg-white shadow-soft transition-all dark:border-night-line ${
                viewport === 'mobile' ? 'w-[390px] max-w-full' : 'w-full'
              }`}
            >
              <iframe
                key={previewUrl}
                src={previewUrl}
                title="Live Preview"
                className="h-full w-full bg-white"
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
              />
            </div>
          </div>
        )}

        {tab === 'files' && (
          <div className="flex h-full min-h-0">
            <div className="scrollbar-thin w-44 shrink-0 overflow-y-auto border-r border-day-line/80 p-1.5 dark:border-night-line/80">
              {files.length === 0 && (
                <p className="p-2 text-[11.5px] leading-relaxed text-day-muted dark:text-night-muted">
                  还没有产物。让它写个 <code>index.html</code> 试试。
                </p>
              )}
              {files.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => setSelected(file)}
                  className={`mb-0.5 flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] transition ${
                    selected === file
                      ? 'bg-day-accent/10 text-day-accent dark:bg-night-accent/15 dark:text-night-accent'
                      : 'text-day-text hover:bg-day-bg dark:text-night-text dark:hover:bg-night-bg'
                  }`}
                  title={file}
                >
                  <FileCode2 size={12} className="shrink-0" />
                  <span className="truncate">{file.split('/').pop()}</span>
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2 border-b border-day-line/70 px-3 py-1.5 dark:border-night-line/70">
                <Code2 size={12} className="text-day-muted dark:text-night-muted" />
                <span className="truncate font-mono text-[11.5px] text-day-muted dark:text-night-muted">
                  {selected ?? '未选择文件'}
                </span>
                <button
                  type="button"
                  onClick={props.onRefreshFiles}
                  className="ml-auto rounded-md p-1 text-day-muted transition hover:bg-day-bg hover:text-day-text dark:text-night-muted dark:hover:bg-night-bg"
                  title="刷新文件列表"
                >
                  <RefreshCw size={12} />
                </button>
              </div>
              <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre p-3 text-[11.5px] leading-relaxed">
                {fileError ? `读取失败：${fileError}` : fileContent || '（空文件）'}
              </pre>
            </div>
          </div>
        )}

        {tab === 'terminal' && (
          <div className="h-full overflow-hidden bg-[#0f141d]">
            <div className="scrollbar-thin h-full overflow-auto p-3">
              {terminalText ? (
                <pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-[#c8d3e4]">
                  {terminalText}
                </pre>
              ) : (
                <p className="font-mono text-[11.5px] text-[#7c8aa0]">
                  {'// 还没有命令输出。bash 工具的真实 stdout/stderr 会实时汇总到这里。'}
                </p>
              )}
            </div>
          </div>
        )}

        {tab === 'trace' && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid grid-cols-3 gap-2 border-b border-day-line/70 p-2.5 dark:border-night-line/70">
              <div className="rounded-lg bg-day-bg/70 px-2.5 py-1.5 dark:bg-night-bg/60">
                <p className="text-[10px] uppercase tracking-wide text-day-muted dark:text-night-muted">状态</p>
                <p className="truncate text-[12px] font-semibold">{props.status}</p>
              </div>
              <div className="rounded-lg bg-day-bg/70 px-2.5 py-1.5 dark:bg-night-bg/60">
                <p className="text-[10px] uppercase tracking-wide text-day-muted dark:text-night-muted">模型</p>
                <p className="truncate text-[12px] font-semibold">{props.model?.label ?? '—'}</p>
              </div>
              <div className="rounded-lg bg-day-bg/70 px-2.5 py-1.5 dark:bg-night-bg/60">
                <p className="text-[10px] uppercase tracking-wide text-day-muted dark:text-night-muted">审批</p>
                <p className="truncate text-[12px] font-semibold">{props.settings.approvalMode}</p>
              </div>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
              <pre className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-day-text dark:text-night-text">
                {traceLoading && !traceText ? '正在读取轨迹…' : traceText || '会话开始后，这里会出现 .eagentx/session-*.md 的完整轨迹。'}
              </pre>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
