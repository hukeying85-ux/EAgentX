/**
 * 所有请求都走同源相对路径（/api/...），这样在云端沙箱的 https://{port}-{sandbox}.e2b.app
 * 预览里也能正常访问，绝不会出现浏览器去连 localhost 的问题。
 */

import type {
  ApprovalMode,
  EndpointConfig,
  LeaderboardRow,
  PublicConfig,
  SessionSnapshot,
  SkillSummary,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const message =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return json as T;
}

export interface SessionFileResponse {
  path: string;
  size: number;
  content: string;
}

export interface FeedbackResponse {
  ok: boolean;
  model: { id: string; label: string; model: string; demo?: boolean; revealed?: boolean };
  leaderboard: LeaderboardRow[];
}

export const api = {
  health: () => request<{ ok: boolean; mode: string; skills: number }>('/api/health'),

  config: () => request<PublicConfig>('/api/config'),

  saveConfig: (payload: {
    endpoints: EndpointConfig[];
    defaultEndpointId: string | null;
    blindMode: boolean;
    approvalMode: ApprovalMode;
    maxSteps: number;
    forceDemo: boolean;
  }) => request<{ ok: boolean; config: PublicConfig }>('/api/config', { method: 'PUT', body: JSON.stringify(payload) }),

  skills: () => request<{ skills: SkillSummary[] }>('/api/skills'),

  leaderboard: () => request<{ rows: LeaderboardRow[] }>('/api/leaderboard'),

  createSession: (endpointId?: string | null) =>
    request<{ id: string; snapshot: SessionSnapshot }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ endpointId: endpointId ?? undefined }),
    }),

  getSession: (id: string) => request<SessionSnapshot>(`/api/sessions/${id}`),

  updateSettings: (id: string, settings: { approvalMode?: ApprovalMode; maxSteps?: number }) =>
    request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(settings) }),

  send: (id: string, text: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),

  approve: (id: string, approvalId: string, decision: 'approved' | 'rejected') =>
    request<{ ok: boolean }>(`/api/sessions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ id: approvalId, decision }),
    }),

  answer: (id: string, questionId: string, answer: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ id: questionId, answer }),
    }),

  stop: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}/stop`, { method: 'POST' }),

  feedback: (id: string, rating: 'up' | 'down') =>
    request<FeedbackResponse>(`/api/sessions/${id}/feedback`, { method: 'POST', body: JSON.stringify({ rating }) }),

  file: (id: string, path: string) =>
    request<SessionFileResponse>(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`),

  files: (id: string) => request<{ files: string[] }>(`/api/sessions/${id}/files`),

  trace: (id: string) => request<{ trace: string; exists: boolean }>(`/api/sessions/${id}/trace`),
};
