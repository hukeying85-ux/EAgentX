/** 双栏工作台外壳：顶栏（品牌 / 模型 / 主题 / 设置）+ 左对话 + 右工作台。 */

import { useCallback, useEffect, useState } from 'react';
import { Bot, Moon, Plus, Settings2, Sun, X } from 'lucide-react';
import { ChatPane } from './components/ChatPane';
import { ModelSettingsModal } from './components/ModelSettingsModal';
import { WorkbenchPane } from './components/WorkbenchPane';
import { useAgent } from './useAgent';

type Theme = 'light' | 'dark';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export default function App() {
  const agent = useAgent();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<'chat' | 'workbench'>('chat');

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.dataset.theme = theme;
    try {
      localStorage.setItem('eagentx.theme', theme);
    } catch {
      /* 隐私模式忽略 */
    }
  }, [theme]);

  const alwaysAllow = useCallback(() => {
    void agent.updateApprovalMode('auto');
  }, [agent]);

  const demoMode = agent.config?.defaults.demoMode ?? true;

  return (
    <div className="flex h-full flex-col bg-day-bg text-day-text transition-colors dark:bg-night-bg dark:text-night-text">
      <header className="flex shrink-0 items-center gap-3 border-b border-day-line/70 bg-day-panel/80 px-4 py-2.5 backdrop-blur dark:border-night-line/70 dark:bg-night-panel/80">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-day-accent text-white shadow-sm dark:bg-night-accent dark:text-night-bg">
            <Bot size={17} />
          </span>
          <div className="leading-tight">
            <h1 className="text-[14px] font-semibold tracking-tight">EAgentX Web Agent</h1>
            <p className="hidden text-[11px] text-day-muted sm:block dark:text-night-muted">
              双栏自主智能体工作台 · 真实沙箱工具链
            </p>
          </div>
        </div>

        <span
          className={`ml-1 rounded-full px-2.5 py-1 text-[10.5px] font-semibold ${
            demoMode
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-300'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          }`}
          title={demoMode ? '没有配置 API Key，使用内置 Demo 编排引擎' : '使用已配置的真实大模型'}
        >
          {demoMode ? 'Demo 引擎（免 Key）' : agent.model?.label ?? '真实模型'}
        </span>

        {agent.sessionId && (
          <span className="hidden rounded-full bg-day-bg px-2.5 py-1 font-mono text-[10.5px] text-day-muted md:inline dark:bg-night-bg dark:text-night-muted">
            {agent.sessionId}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void agent.newSession()}
            disabled={agent.busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-day-line bg-day-card px-2.5 py-1.5 text-[12px] font-medium transition hover:border-day-accent hover:text-day-accent disabled:opacity-50 dark:border-night-line dark:bg-night-card dark:hover:border-night-accent"
            title="新建会话（清空上下文与工作区）"
          >
            <Plus size={13} /> 新建会话
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg border border-day-line bg-day-card p-1.5 text-day-muted transition hover:border-day-accent hover:text-day-accent dark:border-night-line dark:bg-night-card dark:text-night-muted dark:hover:border-night-accent"
            title="模型与运行设置"
          >
            <Settings2 size={15} />
          </button>
          <button
            type="button"
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            className="rounded-lg border border-day-line bg-day-card p-1.5 text-day-muted transition hover:border-day-accent hover:text-day-accent dark:border-night-line dark:bg-night-card dark:text-night-muted dark:hover:border-night-accent"
            title={theme === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </header>

      {/* 小屏切换条 */}
      <div className="flex shrink-0 gap-1 border-b border-day-line/70 px-3 py-1.5 lg:hidden dark:border-night-line/70">
        {(['chat', 'workbench'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setMobileTab(tab)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
              mobileTab === tab
                ? 'bg-day-card text-day-text shadow-sm dark:bg-night-card dark:text-night-text'
                : 'text-day-muted dark:text-night-muted'
            }`}
          >
            {tab === 'chat' ? '对话' : '工作台'}
          </button>
        ))}
      </div>

      <main className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className={`min-h-0 ${mobileTab === 'chat' ? 'block' : 'hidden'} lg:block`}>
          <ChatPane
            items={agent.items}
            status={agent.status}
            stateMessage={agent.stateMessage}
            model={agent.model}
            settings={agent.settings}
            connected={agent.connected}
            onSend={(text) => void agent.send(text)}
            onApprove={(id, decision) => void agent.approve(id, decision)}
            onAnswer={(id, value) => void agent.answer(id, value)}
            onAlwaysAllow={alwaysAllow}
            onStop={() => void agent.stop()}
            onFeedback={(rating) => void agent.feedback(rating)}
            onApprovalModeChange={(mode) => void agent.updateApprovalMode(mode)}
          />
        </div>
        <div className={`min-h-0 ${mobileTab === 'workbench' ? 'block' : 'hidden'} lg:block`}>
          <WorkbenchPane
            sessionId={agent.sessionId}
            files={agent.files}
            previewPort={agent.previewPort}
            terminal={agent.terminal}
            traceText={agent.traceText}
            status={agent.status}
            model={agent.model}
            settings={agent.settings}
            onRefreshFiles={() => void agent.refreshFiles()}
            onRefreshTrace={() => void agent.refreshTrace()}
          />
        </div>
      </main>

      {agent.error && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3.5 py-2.5 text-[12.5px] text-rose-700 shadow-soft dark:border-rose-500/30 dark:bg-rose-950/80 dark:text-rose-200">
          <span className="min-w-0 flex-1 break-words">{agent.error}</span>
          <button type="button" onClick={() => agent.setError(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <X size={14} />
          </button>
        </div>
      )}

      <ModelSettingsModal
        open={settingsOpen}
        config={agent.config}
        onClose={() => setSettingsOpen(false)}
        onSaved={(config) => {
          agent.setConfig(config);
          setSettingsOpen(false);
          void agent.newSession();
        }}
      />
    </div>
  );
}
