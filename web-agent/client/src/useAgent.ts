/**
 * 会话状态管理：SSE 事件 → UI 视图模型。
 *
 * 关键点：
 *   - 事件都是增量的（delta / start / result），这里用纯函数 reducer 折叠成消息流；
 *   - 断线重连或刷新页面时用 GET /state 拉快照回填，保证不丢历史；
 *   - 审批 / 提问 / 中断都是显式的用户动作，失败会冒泡成错误提示。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type {
  AgentEvent,
  ApprovalMode,
  ChatItem,
  ModelReveal,
  PublicConfig,
  SessionSettings,
  SessionSnapshot,
  SessionStatus,
} from './types';

export interface StatusLine {
  message: string;
  status: SessionStatus;
}

export interface TerminalLine {
  id: string;
  kind: 'bash' | 'process';
  label: string;
  text: string;
  ok?: boolean;
}

const STORAGE_KEY = 'eagentx.sessionId';

export function reduceItems(items: ChatItem[], event: AgentEvent): ChatItem[] {
  switch (event.type) {
    case 'user_message':
      return [...items, { kind: 'user', id: `u_${event.at}_${items.length}`, text: event.text, at: event.at }];

    case 'assistant_start':
      return [
        ...items,
        {
          kind: 'assistant',
          id: event.messageId,
          text: '',
          model: event.model,
          done: false,
          at: Date.now(),
        },
      ];

    case 'assistant_delta': {
      const next = items.slice();
      const index = next.findIndex((item) => item.kind === 'assistant' && item.id === event.messageId);
      if (index < 0) {
        next.push({
          kind: 'assistant',
          id: event.messageId,
          text: event.text,
          done: false,
          at: Date.now(),
        });
      } else {
        const item = next[index];
        if (item.kind === 'assistant') next[index] = { ...item, text: item.text + event.text };
      }
      return next;
    }

    case 'assistant_end': {
      const next = items.slice();
      const index = next.findIndex((item) => item.kind === 'assistant' && item.id === event.messageId);
      if (index < 0) {
        next.push({
          kind: 'assistant',
          id: event.messageId,
          text: event.text,
          model: event.model,
          demo: event.demo,
          done: true,
          at: Date.now(),
        });
      } else {
        const item = next[index];
        if (item.kind === 'assistant') {
          next[index] = { ...item, text: event.text, model: event.model ?? item.model, demo: event.demo, done: true };
        }
      }
      return next;
    }

    case 'tool_call_start':
      return [...items, { kind: 'tool', id: event.call.id, call: event.call, at: Date.now() }];

    case 'tool_call_result': {
      const index = items.findIndex((item) => item.kind === 'tool' && item.id === event.result.id);
      if (index < 0) {
        return [
          ...items,
          {
            kind: 'tool',
            id: event.result.id,
            call: { id: event.result.id, name: event.result.name, args: {}, preview: '' },
            result: event.result,
            at: Date.now(),
          },
        ];
      }
      const next = items.slice();
      const item = next[index];
      if (item.kind === 'tool') next[index] = { ...item, result: event.result };
      return next;
    }

    case 'approval_required':
      return [...items, { kind: 'approval', id: event.approval.id, approval: event.approval, at: Date.now() }];

    case 'approval_resolved': {
      const index = items.findIndex((item) => item.kind === 'approval' && item.id === event.id);
      if (index < 0) return items;
      const next = items.slice();
      const item = next[index];
      if (item.kind === 'approval') next[index] = { ...item, decision: event.decision };
      return next;
    }

    case 'question_required':
      return [...items, { kind: 'question', id: event.question.id, question: event.question, at: Date.now() }];

    case 'question_resolved': {
      const index = items.findIndex((item) => item.kind === 'question' && item.id === event.id);
      if (index < 0) return items;
      const next = items.slice();
      const item = next[index];
      if (item.kind === 'question') next[index] = { ...item, answer: event.answer };
      return next;
    }

    case 'error':
      return [...items, { kind: 'notice', id: `err_${Date.now()}`, text: event.message, at: Date.now() }];

    default:
      return items;
  }
}

export function useAgent() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [stateMessage, setStateMessage] = useState('正在连接会话…');
  const [model, setModel] = useState<ModelReveal | null>(null);
  const [settings, setSettings] = useState<SessionSettings>({ approvalMode: 'manual', maxSteps: 12 });
  const [files, setFiles] = useState<string[]>([]);
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [traceText, setTraceText] = useState('');
  const [terminal, setTerminal] = useState<TerminalLine[]>([]);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<string | null>(null);

  const pushTerminal = useCallback((line: TerminalLine) => {
    setTerminal((prev) => [...prev.slice(-299), line]);
  }, []);

  const hydrate = useCallback((snapshot: SessionSnapshot) => {
    setItems(snapshot.items ?? []);
    setStatus(snapshot.status);
    setStateMessage(snapshot.stateMessage);
    setModel(snapshot.model);
    setSettings(snapshot.settings);
    setFiles(snapshot.files ?? []);
    setPreviewPort(snapshot.previewPort);
    setSessionId(snapshot.id);
    sessionRef.current = snapshot.id;
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api.config());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      const result = await api.files(id);
      setFiles(result.files);
    } catch {
      /* 忽略：文件列表拉不到不影响对话 */
    }
  }, []);

  const refreshTrace = useCallback(async () => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      const result = await api.trace(id);
      setTraceText(result.trace);
    } catch {
      /* 忽略 */
    }
  }, []);

  const applyEvent = useCallback(
    (event: AgentEvent) => {
      setItems((prev) => reduceItems(prev, event));

      switch (event.type) {
        case 'state':
          setStateMessage(event.message);
          if (event.status) setStatus(event.status);
          break;
        case 'assistant_end':
          setStatus((prev) => (prev === 'awaiting_approval' || prev === 'awaiting_input' ? prev : 'running'));
          break;
        case 'approval_required':
          setStatus('awaiting_approval');
          break;
        case 'question_required':
          setStatus('awaiting_input');
          break;
        case 'workspace_updated':
          setFiles(event.files);
          break;
        case 'process_started':
          if (event.port) setPreviewPort(event.port);
          if (event.command) {
            pushTerminal({
              id: `proc_${event.processId}_${Date.now()}`,
              kind: 'process',
              label: event.command,
              text: event.port ? `已监听端口 ${event.port}` : '已启动',
            });
          }
          break;
        case 'process_output':
          setTerminal((prev) => {
            const index = prev.findIndex((line) => line.kind === 'process' && line.id.startsWith(`proc_${event.processId}`));
            if (index >= 0) {
              const next = prev.slice();
              const line = next[index];
              next[index] = { ...line, text: (line.text + event.chunk).slice(-8000) };
              return next;
            }
            return [...prev.slice(-299), { id: `proc_${event.processId}`, kind: 'process', label: event.processId, text: event.chunk }];
          });
          break;
        case 'tool_call_result':
          if (event.result.name === 'bash') {
            pushTerminal({
              id: `bash_${event.result.id}`,
              kind: 'bash',
              label: String(event.result.meta?.command ?? 'bash'),
              text: event.result.output,
              ok: event.result.ok,
            });
          }
          break;
        case 'session_done':
          setStatus(event.status);
          if (event.model) setModel(event.model);
          setStateMessage(event.summary ?? (event.status === 'done' ? '任务完成' : '会话结束'));
          void refreshFiles();
          void refreshTrace();
          break;
        case 'error':
          setStatus('error');
          setError(event.message);
          break;
        default:
          break;
      }
    },
    [pushTerminal, refreshFiles, refreshTrace],
  );

  const connect = useCallback(
    (id: string) => {
      sourceRef.current?.close();
      const source = new EventSource(`/api/sessions/${id}/events`);
      sourceRef.current = source;
      source.onopen = () => setConnected(true);
      source.onmessage = (message) => {
        try {
          applyEvent(JSON.parse(message.data) as AgentEvent);
        } catch {
          /* 心跳或非法载荷 */
        }
      };
      source.onerror = () => setConnected(false);
    },
    [applyEvent],
  );

  const newSession = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { id, snapshot } = await api.createSession();
      sourceRef.current?.close();
      setItems([]);
      setTerminal([]);
      setTraceText('');
      hydrate(snapshot);
      connect(id);
      localStorage.setItem(STORAGE_KEY, id);
      setStateMessage('会话已就绪，把任务交给它吧');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [connect, hydrate]);

  useEffect(() => {
    void (async () => {
      await refreshConfig();
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          const snapshot = await api.getSession(saved);
          hydrate(snapshot);
          connect(saved);
          setStateMessage(snapshot.stateMessage || '已恢复上次会话');
          void refreshTrace();
          return;
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
      await newSession();
    })();
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(async (text: string) => {
    const id = sessionRef.current;
    if (!id || !text.trim()) return;
    setError(null);
    try {
      await api.send(id, text);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const approve = useCallback(async (approvalId: string, decision: 'approved' | 'rejected') => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      await api.approve(id, approvalId, decision);
      setStatus('running');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const answer = useCallback(async (questionId: string, value: string) => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      await api.answer(id, questionId, value);
      setStatus('running');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const stop = useCallback(async () => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      await api.stop(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const feedback = useCallback(async (rating: 'up' | 'down') => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      const result = await api.feedback(id, rating);
      setModel(result.model);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const updateApprovalMode = useCallback(async (mode: ApprovalMode) => {
    const id = sessionRef.current;
    setSettings((prev) => ({ ...prev, approvalMode: mode }));
    if (!id) return;
    try {
      await api.updateSettings(id, { approvalMode: mode });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const revealedModel = useMemo(() => model ?? null, [model]);

  return {
    sessionId,
    items,
    status,
    stateMessage,
    model: revealedModel,
    settings,
    files,
    previewPort,
    traceText,
    terminal,
    config,
    connected,
    busy,
    error,
    setError,
    newSession,
    send,
    approve,
    answer,
    stop,
    feedback,
    updateApprovalMode,
    refreshFiles,
    refreshTrace,
    refreshConfig,
    setConfig,
  };
}
