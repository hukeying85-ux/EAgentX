/** 模型与运行设置弹窗：多端点配置、盲测路由、Demo 模式、技能与排行榜概览。 */

import { useEffect, useState } from 'react';
import { Eye, KeyRound, Plus, Save, Sparkles, Trash2, Trophy, X } from 'lucide-react';
import { api } from '../api';
import type { ApprovalMode, EndpointConfig, LeaderboardRow, PublicConfig, SkillSummary } from '../types';

interface Props {
  open: boolean;
  config: PublicConfig | null;
  onClose: () => void;
  onSaved: (config: PublicConfig) => void;
}

interface DraftConfig {
  endpoints: EndpointConfig[];
  defaultEndpointId: string | null;
  blindMode: boolean;
  approvalMode: ApprovalMode;
  maxSteps: number;
  forceDemo: boolean;
}

function toDraft(config: PublicConfig | null): DraftConfig {
  return {
    endpoints: (config?.endpoints ?? []).map((endpoint) => ({ ...endpoint, apiKey: '' })),
    defaultEndpointId: config?.defaults.endpointId ?? null,
    blindMode: config?.defaults.blindMode ?? false,
    approvalMode: config?.defaults.approvalMode ?? 'manual',
    maxSteps: config?.defaults.maxSteps ?? 12,
    forceDemo: config?.defaults.forceDemo ?? false,
  };
}

export function ModelSettingsModal({ open, config, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<DraftConfig>(toDraft(config));
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(toDraft(config));
    setError(null);
    void api
      .skills()
      .then((result) => setSkills(result.skills))
      .catch(() => setSkills([]));
    void api
      .leaderboard()
      .then((result) => setRows(result.rows))
      .catch(() => setRows([]));
  }, [open, config]);

  if (!open) return null;

  const updateEndpoint = (index: number, patch: Partial<EndpointConfig>) => {
    setDraft((prev) => {
      const endpoints = prev.endpoints.slice();
      endpoints[index] = { ...endpoints[index], ...patch };
      return { ...prev, endpoints };
    });
  };

  const addEndpoint = (preset?: { kind: EndpointConfig['kind']; label: string; baseUrl: string; model: string }) => {
    const kind = preset?.kind ?? 'openai';
    const endpoint: EndpointConfig = {
      id: `ep-${Date.now()}`,
      label: preset?.label ?? '自定义模型',
      kind,
      baseUrl: preset?.baseUrl ?? '',
      model: preset?.model ?? '',
      apiKey: '',
      hasKey: false,
      nativeTools: true,
    };
    setDraft((prev) => ({ ...prev, endpoints: [...prev.endpoints, endpoint] }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveConfig({
        endpoints: draft.endpoints,
        defaultEndpointId: draft.defaultEndpointId,
        blindMode: draft.blindMode,
        approvalMode: draft.approvalMode,
        maxSteps: draft.maxSteps,
        forceDemo: draft.forceDemo,
      });
      onSaved(result.config);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const liveEndpoints = draft.endpoints.filter((endpoint) => endpoint.baseUrl && endpoint.model);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="animate-rise flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-day-line bg-day-panel shadow-2xl dark:border-night-line dark:bg-night-panel">
        <div className="flex items-center gap-3 border-b border-day-line/80 px-5 py-3 dark:border-night-line/80">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-day-accent/10 text-day-accent dark:bg-night-accent/15 dark:text-night-accent">
            <Sparkles size={16} />
          </span>
          <div>
            <h2 className="text-[15px] font-semibold">模型与运行设置</h2>
            <p className="text-[11.5px] text-day-muted dark:text-night-muted">
              API Key 只保存在服务端 data/config.json，不会回传到浏览器
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1.5 text-day-muted transition hover:bg-day-bg hover:text-day-text dark:text-night-muted dark:hover:bg-night-bg"
          >
            <X size={16} />
          </button>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold">模型端点</h3>
              <button
                type="button"
                onClick={() => addEndpoint()}
                className="inline-flex items-center gap-1 rounded-lg border border-day-line px-2 py-1 text-[11.5px] font-medium transition hover:border-day-accent hover:text-day-accent dark:border-night-line dark:hover:border-night-accent"
              >
                <Plus size={12} /> 添加端点
              </button>
            </div>

            {config?.providerOptions && (
              <div className="flex flex-wrap gap-1.5">
                {config.providerOptions.map((preset) => (
                  <button
                    key={preset.kind}
                    type="button"
                    onClick={() =>
                      addEndpoint({ kind: preset.kind, label: preset.label, baseUrl: preset.baseUrl, model: preset.toolModel })
                    }
                    className="rounded-full border border-day-line px-2.5 py-1 text-[11px] text-day-muted transition hover:border-day-accent hover:text-day-accent dark:border-night-line dark:text-night-muted dark:hover:border-night-accent"
                  >
                    + {preset.label}
                  </button>
                ))}
              </div>
            )}

            {draft.endpoints.length === 0 && (
              <p className="rounded-xl border border-dashed border-day-line p-3 text-[12px] leading-relaxed text-day-muted dark:border-night-line dark:text-night-muted">
                还没有配置模型端点 —— 现在使用内置 <strong>Demo 编排引擎</strong>（免 Key，真实写文件 / 跑命令）。
                填入任意 OpenAI 兼容端点后会立即切换为真实大模型。
              </p>
            )}

            <div className="space-y-2">
              {draft.endpoints.map((endpoint, index) => (
                <div key={endpoint.id} className="rounded-xl border border-day-line p-3 dark:border-night-line">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-[11px] text-day-muted dark:text-night-muted">
                      显示名称
                      <input
                        value={endpoint.label}
                        onChange={(event) => updateEndpoint(index, { label: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-day-line bg-day-card px-2 py-1.5 text-[12.5px] text-day-text outline-none focus:border-day-accent dark:border-night-line dark:bg-night-card dark:text-night-text"
                      />
                    </label>
                    <label className="text-[11px] text-day-muted dark:text-night-muted">
                      接口格式
                      <select
                        value={endpoint.kind}
                        onChange={(event) => updateEndpoint(index, { kind: event.target.value as EndpointConfig['kind'] })}
                        className="mt-1 w-full rounded-lg border border-day-line bg-day-card px-2 py-1.5 text-[12.5px] text-day-text outline-none focus:border-day-accent dark:border-night-line dark:bg-night-card dark:text-night-text"
                      >
                        <option value="openai">OpenAI 兼容</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="ollama">Ollama</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                    <label className="text-[11px] text-day-muted dark:text-night-muted">
                      Base URL
                      <input
                        value={endpoint.baseUrl}
                        placeholder="https://api.openai.com/v1"
                        onChange={(event) => updateEndpoint(index, { baseUrl: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-day-line bg-day-card px-2 py-1.5 font-mono text-[12px] text-day-text outline-none focus:border-day-accent dark:border-night-line dark:bg-night-card dark:text-night-text"
                      />
                    </label>
                    <label className="text-[11px] text-day-muted dark:text-night-muted">
                      模型名
                      <input
                        value={endpoint.model}
                        placeholder="gpt-4o-mini"
                        onChange={(event) => updateEndpoint(index, { model: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-day-line bg-day-card px-2 py-1.5 font-mono text-[12px] text-day-text outline-none focus:border-day-accent dark:border-night-line dark:bg-night-card dark:text-night-text"
                      />
                    </label>
                    <label className="text-[11px] text-day-muted dark:text-night-muted sm:col-span-1">
                      API Key
                      <input
                        type="password"
                        value={endpoint.apiKey ?? ''}
                        placeholder={endpoint.hasKey ? '已保存（留空则不修改）' : 'sk-…'}
                        onChange={(event) => updateEndpoint(index, { apiKey: event.target.value })}
                        className="mt-1 w-full rounded-lg border border-day-line bg-day-card px-2 py-1.5 font-mono text-[12px] text-day-text outline-none focus:border-day-accent dark:border-night-line dark:bg-night-card dark:text-night-text"
                      />
                    </label>
                    <div className="flex items-end gap-3 pb-1">
                      <label className="inline-flex items-center gap-1.5 text-[11.5px] text-day-muted dark:text-night-muted">
                        <input
                          type="checkbox"
                          checked={endpoint.nativeTools}
                          onChange={(event) => updateEndpoint(index, { nativeTools: event.target.checked })}
                        />
                        原生 Tool Calling
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          setDraft((prev) => ({ ...prev, endpoints: prev.endpoints.filter((_, i) => i !== index) }))
                        }
                        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-rose-500 transition hover:bg-rose-500/10"
                      >
                        <Trash2 size={12} /> 删除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <label className="rounded-xl border border-day-line p-3 text-[11.5px] dark:border-night-line">
              <span className="flex items-center gap-1.5 font-semibold text-day-text dark:text-night-text">
                <Eye size={13} /> 盲测路由（Arena Blind Mode）
              </span>
              <span className="mt-1 block text-day-muted dark:text-night-muted">
                每次新会话从已配置端点里随机抽一个，点赞/点踩后才揭晓模型并计入排行榜。
              </span>
              <span className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.blindMode}
                  onChange={(event) => setDraft((prev) => ({ ...prev, blindMode: event.target.checked }))}
                />
                启用随机盲测
              </span>
            </label>

            <label className="rounded-xl border border-day-line p-3 text-[11.5px] dark:border-night-line">
              <span className="flex items-center gap-1.5 font-semibold text-day-text dark:text-night-text">
                <KeyRound size={13} /> 强制 Demo 引擎
              </span>
              <span className="mt-1 block text-day-muted dark:text-night-muted">
                即使配置了 Key 也走内置编排引擎，用于演示与回归测试。
              </span>
              <span className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.forceDemo}
                  onChange={(event) => setDraft((prev) => ({ ...prev, forceDemo: event.target.checked }))}
                />
                只用 Demo 引擎
              </span>
            </label>

            <label className="rounded-xl border border-day-line p-3 text-[11.5px] dark:border-night-line">
              <span className="font-semibold text-day-text dark:text-night-text">默认审批模式</span>
              <select
                value={draft.approvalMode}
                onChange={(event) => setDraft((prev) => ({ ...prev, approvalMode: event.target.value as ApprovalMode }))}
                className="mt-1.5 w-full rounded-lg border border-day-line bg-day-card px-2 py-1.5 text-[12px] outline-none focus:border-day-accent dark:border-night-line dark:bg-night-card"
              >
                <option value="readonly">只读自动放行</option>
                <option value="manual">仅危险命令需确认</option>
                <option value="auto">全自动</option>
              </select>
            </label>

            <label className="rounded-xl border border-day-line p-3 text-[11.5px] dark:border-night-line">
              <span className="font-semibold text-day-text dark:text-night-text">最大步数</span>
              <input
                type="number"
                min={3}
                max={30}
                value={draft.maxSteps}
                onChange={(event) => setDraft((prev) => ({ ...prev, maxSteps: Number(event.target.value) }))}
                className="mt-1.5 w-full rounded-lg border border-day-line bg-day-card px-2 py-1.5 text-[12px] outline-none focus:border-day-accent dark:border-night-line dark:bg-night-card"
              />
            </label>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-day-line p-3 dark:border-night-line">
              <h3 className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                <Sparkles size={13} /> 技能库（{skills.length || config?.skillsCount || 0}）
              </h3>
              <div className="scrollbar-thin mt-2 max-h-36 space-y-1 overflow-y-auto">
                {skills.slice(0, 40).map((skill) => (
                  <p key={skill.id} className="truncate text-[11.5px] text-day-muted dark:text-night-muted" title={skill.description}>
                    <span className="font-mono text-day-text dark:text-night-text">{skill.id}</span> · {skill.group}
                  </p>
                ))}
                {skills.length === 0 && (
                  <p className="text-[11.5px] text-day-muted dark:text-night-muted">（未加载到 assets/skill_zip.zip）</p>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-day-line p-3 dark:border-night-line">
              <h3 className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                <Trophy size={13} /> 模型排行榜
              </h3>
              <div className="scrollbar-thin mt-2 max-h-36 space-y-1 overflow-y-auto">
                {rows.length === 0 && (
                  <p className="text-[11.5px] text-day-muted dark:text-night-muted">还没有评测数据，先在会话里点个赞试试。</p>
                )}
                {rows.map((row) => (
                  <p key={row.modelId} className="flex items-center justify-between text-[11.5px]">
                    <span className="truncate">
                      <span className="font-mono">{row.model}</span>
                    </span>
                    <span className="shrink-0 text-day-muted dark:text-night-muted">
                      👍 {row.likes} · 👎 {row.dislikes} · {row.sessions} 次
                    </span>
                  </p>
                ))}
              </div>
            </div>
          </section>

          {draft.endpoints.length > 0 && (
            <p className="text-[11.5px] text-day-muted dark:text-night-muted">
              当前可用端点：{liveEndpoints.length} / {draft.endpoints.length}
              {liveEndpoints.length === 0 && '（都缺少 Base URL 或模型名）'}
            </p>
          )}

          {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-day-line/80 px-5 py-3 dark:border-night-line/80">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-day-line px-3 py-1.5 text-[12.5px] font-medium transition hover:bg-day-bg dark:border-night-line dark:hover:bg-night-bg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-day-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50 dark:bg-night-accent dark:text-night-bg"
          >
            <Save size={13} /> {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  );
}
