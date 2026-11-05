/**
 * Demo 编排引擎（零 API Key 也能跑通真实闭环）。
 *
 * 它不是「假数据」：每一步都真的调用注册表里的工具 —— 真的在工作区写文件、
 * 真的跑 bash、真的读技能库，所以右栏 Live Preview 看到的是磁盘上真实生成的页面。
 *
 * 实现方式：把用户任务映射成一份固定剧本（写什么文件、跑什么命令），
 * 再根据「已经拿到的工具结果条数」决定当前演到第几步。这样审批拒绝、工具失败、
 * 用户打断都能自然恢复，不会因为状态丢失而卡死。
 */

import type { ChatProvider, ChatReply, ChatRequest, LlmMessage, ToolCall } from '../types';

interface DemoStep {
  /** 这一步的内心想法（可省略：最终总结步骤不需要） */
  thought?: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** 最后一步的总结（支持占位符 {{task}}） */
  final?: string;
}

const DEFAULT_DELAY = Number(process.env.DEMO_STREAM_MS ?? 7);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stream(req: ChatRequest, text: string, delayMs: number): Promise<void> {
  if (!req.onDelta) return;
  if (delayMs <= 0) {
    req.onDelta(text);
    return;
  }
  const chunks = text.match(/[\s\S]{1,5}/g) ?? [];
  for (const chunk of chunks) {
    req.onDelta(chunk);
    await sleep(delayMs);
  }
}

function lastTaskIndex(messages: LlmMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const text = message.content.trim();
    if (text.startsWith('【工具结果】')) continue;
    if (text.startsWith('【继续】') || text.startsWith('【系统】')) continue;
    return i;
  }
  return -1;
}

function extractTask(messages: LlmMessage[]): string {
  const index = lastTaskIndex(messages);
  if (index < 0) return '';
  let text = messages[index].content.trim();
  text = text.replace(/^【新任务】\s*/, '');
  // 去掉宿主提示词包装（首轮 / 追问），只留用户真正写的那句话
  for (const marker of ['\n\n请按上面的协议开始', '\n\n（继续遵守之前的格式', '\n\n请根据以上真实']) {
    const cut = text.indexOf(marker);
    if (cut >= 0) text = text.slice(0, cut);
  }
  return text.trim();
}

function countToolResultsSince(messages: LlmMessage[], startIndex: number): number {
  let count = 0;
  for (let i = startIndex + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'tool') count++;
    else if (message.role === 'user' && message.content.trim().startsWith('【工具结果】')) count++;
  }
  return count;
}

/* ------------------------------ 页面素材 ------------------------------ */

type Variant = 'pomodoro' | 'todo' | 'profile' | 'snapshot';

function pickVariant(task: string): Variant {
  const t = task.toLowerCase();
  if (/番茄|pomodoro|计时|专注/.test(t)) return 'pomodoro';
  if (/待办|todo|清单|任务管理/.test(t)) return 'todo';
  if (/简历|个人主页|个人网站|portfolio|profile|landing/.test(t)) return 'profile';
  return 'snapshot';
}

const SHARED_STYLE = `:root {
  color-scheme: light dark;
  --bg: #eef1f5;
  --panel: #fbfaf7;
  --card: #ffffff;
  --line: #dfe3ea;
  --text: #252b34;
  --muted: #6b7482;
  --accent: #3c6df0;
  --accent-soft: rgba(60, 109, 240, 0.12);
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 18px 40px -24px rgba(16, 24, 40, 0.35);
}
html[data-theme='dark'] {
  --bg: #121721;
  --panel: #171d29;
  --card: #1d2432;
  --line: #2a3342;
  --text: #e6eaf2;
  --muted: #93a0b4;
  --accent: #6f9bff;
  --accent-soft: rgba(111, 155, 255, 0.16);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 18px 40px -24px rgba(0, 0, 0, 0.7);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  padding: 32px 20px 56px;
  background: radial-gradient(1200px 500px at 20% -10%, var(--accent-soft), transparent 60%), var(--bg);
  color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.shell { width: min(860px, 100%); display: grid; gap: 18px; }
header.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: 0.2px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 24px;
  box-shadow: var(--shadow);
}
h1 { font-size: clamp(24px, 4vw, 34px); line-height: 1.25; margin: 6px 0 10px; }
h2 { font-size: 17px; margin: 0 0 8px; }
p.lead { color: var(--muted); margin: 0; }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.pill {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600;
}
.btn {
  appearance: none; border: 1px solid transparent; border-radius: 10px; padding: 10px 18px;
  font: inherit; font-weight: 600; cursor: pointer; color: #fff; background: var(--accent);
  transition: transform .12s ease, box-shadow .12s ease, background .12s ease;
}
.btn:hover { transform: translateY(-1px); box-shadow: 0 8px 18px -10px var(--accent); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--line); }
.btn.ghost:hover { background: var(--accent-soft); }
input[type='text'] {
  width: 100%; padding: 11px 14px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--panel); color: var(--text); font: inherit; outline: none;
}
input[type='text']:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.muted { color: var(--muted); font-size: 13px; }
footer { color: var(--muted); font-size: 12px; text-align: center; padding-top: 4px; }
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlDocument(title: string, body: string, scriptNote: string): string {
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="shell">
    <header class="bar">
      <div class="brand"><span class="dot"></span> ${escapeHtml(title)}</div>
      <button class="btn ghost" id="theme-toggle" type="button">切换主题</button>
    </header>
${body}
    <footer>由 EAgentX Web Agent 在隔离工作区内生成 · ${escapeHtml(scriptNote)}</footer>
  </div>
  <script src="app.js"></script>
</body>
</html>
`;
}

function buildFiles(task: string, variant: Variant): { index: string; style: string; script: string; title: string } {
  const taskHtml = escapeHtml(task || '（未提供任务描述）').replace(/\n/g, '<br />');

  if (variant === 'pomodoro') {
    const title = '番茄钟 · Focus Timer';
    return {
      title,
      style: SHARED_STYLE,
      index: htmlDocument(
        title,
        `    <section class="card">
      <span class="pill">专注模式</span>
      <h1>25 分钟，只做一件事。</h1>
      <p class="lead">按「开始」进入番茄钟循环；工作 25 分钟，休息 5 分钟，四轮后长休息 15 分钟。</p>
      <div style="display:grid;place-items:center;gap:16px;margin-top:22px">
        <div id="dial" style="position:relative;width:220px;height:220px;border-radius:50%;background:var(--panel);border:1px solid var(--line);display:grid;place-items:center">
          <div style="text-align:center">
            <div id="clock" style="font-size:44px;font-weight:700;font-variant-numeric:tabular-nums">25:00</div>
            <div class="muted" id="phase">工作 · 第 1 轮</div>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
          <button class="btn" id="start" type="button">开始</button>
          <button class="btn ghost" id="pause" type="button">暂停</button>
          <button class="btn ghost" id="reset" type="button">重置</button>
        </div>
        <p class="muted" id="hint">本轮已完成 0 个番茄</p>
      </div>
    </section>
    <section class="card">
      <h2>任务备忘</h2>
      <p class="lead">${taskHtml}</p>
    </section>`,
        '番茄钟计时逻辑为真实 JS 实现',
      ),
      script: `const WORK = 25 * 60, BREAK = 5 * 60, LONG = 15 * 60;
let phase = 'work', round = 1, remaining = WORK, timer = null, done = 0;
const clock = document.getElementById('clock');
const phaseEl = document.getElementById('phase');
const hint = document.getElementById('hint');
function render() {
  const m = String(Math.floor(remaining / 60)).padStart(2, '0');
  const s = String(remaining % 60).padStart(2, '0');
  clock.textContent = m + ':' + s;
  phaseEl.textContent = (phase === 'work' ? '工作' : phase === 'break' ? '休息' : '长休息') + ' · 第 ' + round + ' 轮';
  hint.textContent = '本轮已完成 ' + done + ' 个番茄';
}
function tick() {
  remaining -= 1;
  if (remaining <= 0) {
    if (phase === 'work') { done += 1; phase = done % 4 === 0 ? 'long' : 'break'; remaining = phase === 'long' ? LONG : BREAK; }
    else { phase = 'work'; round += 1; remaining = WORK; }
  }
  render();
}
document.getElementById('start').onclick = () => { if (!timer) timer = setInterval(tick, 1000); };
document.getElementById('pause').onclick = () => { clearInterval(timer); timer = null; };
document.getElementById('reset').onclick = () => { clearInterval(timer); timer = null; phase = 'work'; round = 1; remaining = WORK; done = 0; render(); };
document.getElementById('theme-toggle').onclick = () => {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
};
render();`,
    };
  }

  if (variant === 'todo') {
    const title = '待办清单 · Today';
    return {
      title,
      style: SHARED_STYLE,
      index: htmlDocument(
        title,
        `    <section class="card">
      <span class="pill">任务看板</span>
      <h1>今天只做重要的三件事。</h1>
      <p class="lead">新增后会写到浏览器 localStorage，刷新不丢；双击条目可以删除。</p>
      <div style="display:flex;gap:10px;margin:18px 0 6px">
        <input type="text" id="new-todo" placeholder="下一步要做什么？" />
        <button class="btn" id="add" type="button">添加</button>
      </div>
      <ul id="list" style="list-style:none;padding:0;margin:14px 0 0;display:grid;gap:8px"></ul>
      <p class="muted" id="empty">还没有任务，先加一条吧。</p>
    </section>
    <section class="card">
      <h2>需求原文</h2>
      <p class="lead">${taskHtml}</p>
    </section>`,
        '数据存在 localStorage',
      ),
      script: `const KEY = 'eagentx.todos';
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const input = document.getElementById('new-todo');
let todos = JSON.parse(localStorage.getItem(KEY) || '[]');
function save() { localStorage.setItem(KEY, JSON.stringify(todos)); }
function render() {
  list.innerHTML = '';
  empty.style.display = todos.length ? 'none' : 'block';
  todos.forEach((todo, index) => {
    const li = document.createElement('li');
    li.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel)';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = todo.done;
    box.onchange = () => { todos[index].done = box.checked; save(); render(); };
    const span = document.createElement('span');
    span.textContent = todo.text;
    span.style.cssText = 'flex:1;' + (todo.done ? 'text-decoration:line-through;color:var(--muted)' : '');
    li.append(box, span);
    li.ondblclick = () => { todos.splice(index, 1); save(); render(); };
    list.append(li);
  });
}
document.getElementById('add').onclick = () => {
  const text = input.value.trim();
  if (!text) return;
  todos.push({ text, done: false });
  input.value = '';
  save();
  render();
};
input.addEventListener('keydown', (event) => { if (event.key === 'Enter') document.getElementById('add').click(); });
document.getElementById('theme-toggle').onclick = () => {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
};
render();`,
    };
  }

  const title = variant === 'profile' ? '个人主页 · Studio' : 'Agent 快照 · Snapshot';
  const hero =
    variant === 'profile'
      ? `<h1>你好，我是这一页的作者。</h1>
      <p class="lead">独立开发者 / 设计工程。这一版主页由 EAgentX Web Agent 根据需求直接生成，右侧预览即真实产物。</p>`
      : `<h1>这一步的产物已经跑在真实沙箱里。</h1>
      <p class="lead">下面是你交给智能体的原始需求；页面、样式与脚本都由工具真实写入工作区。</p>`;
  return {
    title,
    style: SHARED_STYLE,
    index: htmlDocument(
      title,
      `    <section class="card">
      <span class="pill">Live Preview</span>
      ${hero}
      <div class="grid" style="margin-top:22px">
        <div class="card" style="padding:16px"><h2>真实文件</h2><p class="muted">index.html / styles.css / app.js 均由 write_file 写入</p></div>
        <div class="card" style="padding:16px"><h2>真实命令</h2><p class="muted">bash 工具在工作区执行并回喂真实输出</p></div>
        <div class="card" style="padding:16px"><h2>隔离沙箱</h2><p class="muted">路径逃逸会被拦截，命令超时会杀掉进程组</p></div>
      </div>
    </section>
    <section class="card">
      <h2>你的需求</h2>
      <p class="lead">${taskHtml}</p>
    </section>`,
      '静态页面，可直接在 iframe 里预览',
    ),
    script: `document.getElementById('theme-toggle').onclick = () => {
  const html = document.documentElement;
  html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
};
document.querySelectorAll('.card').forEach((card) => {
  card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
  card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--line)'; });
});`,
  };
}

/* ------------------------------ 剧本 ------------------------------ */

function buildPlan(task: string): DemoStep[] {
  const t = task.toLowerCase();

  if (/技能|skill|能力清单|工具清单/.test(t) && !/网站|网页|页面|主页/.test(t)) {
    return [
      {
        thought: '先去技能库确认有哪些可用技能，再读一个与任务最相关的，避免凭空发挥。',
        tool: 'list_skills',
        args: {},
      },
      {
        thought: '挑一个前端相关技能看细节，后续生成页面时按它的规范来。',
        tool: 'read_skill',
        args: { name: 'frontend-design' },
      },
      {
        final:
          '技能库已经扫描完毕，完整清单在左栏工具卡里。\n\n- 技能来源：仓库根目录 assets/skill_zip.zip，按「作者自用 / 来源于网络」分组；\n- 加载策略：先 list_skills 拿摘要，需要细节再 read_skill，节省上下文；\n- 本次额外读了 frontend-design 的 SKILL.md 作为实现参考。\n\n如果你想让我用某个技能做具体的事，直接说需求即可。\n\n[TASK_DONE]',
      },
    ];
  }

  const variant = pickVariant(task);
  const files = buildFiles(task, variant);

  return [
    {
      thought: '先把页面骨架写出来：语义化结构 + 可交互的组件，路径固定为 index.html，右栏预览会自动挂载。',
      tool: 'write_file',
      args: { path: 'index.html', content: files.index },
    },
    {
      thought: '再补样式：沿用 EAgentX 的冷灰/米白与深灰蓝双主题配色，圆角 16、间距 8 的节奏。',
      tool: 'write_file',
      args: { path: 'styles.css', content: files.style },
    },
    {
      thought: '最后补交互脚本，让预览里的按钮、计时器、清单都是真的能用。',
      tool: 'write_file',
      args: { path: 'app.js', content: files.script },
    },
    {
      thought: '跑一条真实命令核对产物，确认文件确实落盘、大小合理。',
      tool: 'bash',
      args: { command: "ls -la && wc -c index.html styles.css app.js 2>/dev/null || true" },
    },
    {
      final: [
        `已经完成「${task.slice(0, 60)}${task.length > 60 ? '…' : ''}」。`,
        '',
        '**产物（真实写入工作区）**',
        `- index.html — 页面结构（${files.title}）`,
        '- styles.css — 双主题配色与卡片样式',
        '- app.js — 交互逻辑（主题切换 / 计时或清单）',
        '',
        '**验证**',
        '- 通过 bash 执行 `ls -la` 与 `wc -c`，确认三个文件均存在且大小正常（结果见上一步工具卡）。',
        '',
        '**下一步**',
        '- 右栏 Live Preview 已经可以交互预览；想改风格、加页面或接后端接口，直接继续说需求。',
        '',
        '[TASK_DONE]',
      ].join('\n'),
    },
  ];
}

/* ------------------------------ Provider ------------------------------ */

export interface DemoProviderOptions {
  delayMs?: number;
}

export class DemoProvider implements ChatProvider {
  id = 'demo';
  label = 'Demo 编排引擎（免 Key）';
  model = 'eagentx-demo-orchestrator';
  nativeTools = true;
  demo = true;
  private delayMs: number;

  constructor(options: DemoProviderOptions = {}) {
    this.delayMs = options.delayMs ?? DEFAULT_DELAY;
  }

  async chat(req: ChatRequest): Promise<ChatReply> {
    const task = extractTask(req.messages);
    const startIndex = lastTaskIndex(req.messages);
    const completed = countToolResultsSince(req.messages, startIndex);
    const plan = buildPlan(task || '生成一个可交互的示例页面');
    const step = plan[completed];

    if (!step) {
      return {
        text: '（Demo 剧本已结束）如果还需要继续，请给出新的需求。\n\n[TASK_DONE]',
        toolCalls: [],
        model: this.model,
        provider: this.label,
        demo: true,
      };
    }

    if (step.final) {
      const text = step.final;
      await stream(req, text, this.delayMs);
      return { text, toolCalls: [], model: this.model, provider: this.label, demo: true };
    }

    const toolCalls: ToolCall[] = [];
    if (step.tool) {
      toolCalls.push({
        id: `demo_${completed}_${Math.random().toString(36).slice(2, 8)}`,
        name: step.tool,
        arguments: JSON.stringify(step.args ?? {}),
      });
    }
    const thought = `${step.thought ?? ''}\n\n` + describeCall(step.tool ?? '', step.args ?? {});
    await stream(req, thought, this.delayMs);

    return {
      text: thought,
      toolCalls,
      model: this.model,
      provider: this.label,
      demo: true,
    };
  }
}

function describeCall(tool: string, args: Record<string, unknown>): string {
  if (tool === 'write_file') return `→ 调用 \`write_file\`：${String(args.path ?? '')}`;
  if (tool === 'bash') return `→ 调用 \`bash\`：${String(args.command ?? '')}`;
  if (tool === 'list_skills') return '→ 调用 `list_skills`';
  if (tool === 'read_skill') return `→ 调用 \`read_skill\`：${String(args.name ?? '')}`;
  return `→ 调用 \`${tool}\``;
}
