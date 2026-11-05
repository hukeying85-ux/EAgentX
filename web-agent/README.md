# EAgentX Web Agent · 类 arena.ai/agent 的双栏自主智能体工作台

这是 [`EAgentX`](../README.md) 桌面版的 **Web 姐妹项目**：把桌面端「思考 → 执行 → 观察 → 再思考」的闭环内核搬到浏览器里，
做成一套 **左栏对话 + 右栏实时工作台** 的全栈自主智能体。

- **零 API Key 也能跑完整闭环**：内置 Demo 编排引擎，真的写文件、真的跑命令、右栏真的渲染页面；
- **配好 Key 即切换真实大模型**：OpenAI / DeepSeek / Anthropic / Ollama / 任意 OpenAI 兼容网关，原生 Tool Calling + 文本协议兜底；
- **隔离工作区**：每个会话一个 `workspaces/<sessionId>/`，路径逃逸被拦截，命令超时杀进程组；
- **可审计**：每一步写进 `.eagentx/session-*.md`，会话指标与点赞信号落到 `data/metrics.jsonl`，盲测有排行榜。

> 本目录内的代码 **不修改根目录任何 C# 源码、`EAgentX.csproj` 或 `build.ps1`**，与桌面端的其它演进分支零冲突。
> 唯一的外部依赖是只读复用仓库根目录的 `assets/skill_zip.zip`（26 个 `SKILL.md` 技能）。

---

## 快速开始

```bash
cd web-agent
npm install

# 开发模式（前端 Vite 5173 + 后端 tsx 3001，/api 与 /preview 已配好代理）
npm run dev

# 生产模式（单端口同时提供界面 + API + SSE + Live Preview）
npm run build
npm start            # 默认 0.0.0.0:3001
```

打开 <http://localhost:3001>（生产）或 <http://localhost:5173>（开发）。

**云端沙箱 / 远程预览**：服务默认绑定 `0.0.0.0`，Vite 设置 `allowedHosts: true`，
前端所有请求都走同源相对路径（`/api/...`、`/preview/<sessionId>/...`），
所以在 `https://{port}-{sandbox}.e2b.app` 这类反代地址下同样可用，不会出现「浏览器去连 localhost」。

```bash
npm test        # 30 个单元 / 集成测试
npm run typecheck
```

---

## 和 EAgentX 桌面版的血缘关系

| 能力 | 来源（C# 桌面版） | Web 版实现 |
| --- | --- | --- |
| 主循环 / 步数熔断 / 空回复催促 | `src/Core/AgentSession.cs` | `server/core/agentSession.ts` |
| 命令残片拦截（引号/括号/here-string） | `src/Core/CommandShape.cs` | `server/core/commandShape.ts`（额外支持 Bash heredoc） |
| 代码块工具协议回退 | `src/Core/CommandParser.cs` | `server/core/fallbackParser.ts`（`tool:name` / 裸语言名 / json 包装） |
| 超时杀进程组 + 头 8000 / 尾 3000 截断 | `src/Core/PowerShellRunner.cs` | `server/tools/bashTool.ts` + `truncate.ts` |
| 技能库渐进式加载 | `src/Util/Skills.cs` | `server/core/skillRegistry.ts`（内存索引 `assets/skill_zip.zip`） |
| 人工审批 | `src/Ui/ApproveForm.cs` | 内联审批卡 + 三档审批策略（见下） |
| 会话轨迹 | `.eagentx/session-*.md` | `server/core/traceStore.ts`（+ JSONL 评测信号） |
| 双主题视觉语言 | `src/Ui/Theme.cs` | `client/src/index.css` + Tailwind 配色 |

---

## 目录结构

```text
web-agent/
├─ server/
│  ├─ index.ts                # Express：REST + SSE + Live Preview + 静态前端（0.0.0.0:3001）
│  ├─ store.ts                # 配置持久化 / 会话注册表 / 盲测路由 / 排行榜
│  ├─ paths.ts                # 数据目录、工作区、前端产物定位
│  ├─ types.ts                # 消息、工具、SSE 事件、视图模型
│  ├─ core/
│  │  ├─ agentSession.ts      # 主循环：流式、审批挂起、多工具、轨迹
│  │  ├─ commandShape.ts      # 命令完整性守卫
│  │  ├─ fallbackParser.ts    # 文本协议解析
│  │  ├─ prompt.ts            # 系统提示词 / 催促 / 拒绝话术
│  │  ├─ skillRegistry.ts     # 26 个 SKILL.md 索引
│  │  └─ traceStore.ts        # Markdown 轨迹 + JSONL 评测
│  ├─ providers/
│  │  ├─ llmRouter.ts         # OpenAI 兼容（SSE + tool_calls 分片聚合）/ Anthropic
│  │  └─ demoProvider.ts      # 免 Key 的真实编排引擎
│  └─ tools/
│     ├─ workspaceSandbox.ts  # 路径逃逸拦截（含 realpath 复核）
│     ├─ bashTool.ts          # 超时杀进程组、敏感环境变量剔除
│     ├─ fileTools.ts         # read/write/edit/list
│     ├─ webTools.ts          # fetch_page（HTML→文本）
│     ├─ processTool.ts       # start_process 端口探测 / stop_process
│     └─ previewProxy.ts      # /preview/:id/* 静态预览 + 子服务反代
├─ client/
│  ├─ index.html
│  └─ src/
│     ├─ App.tsx              # 顶栏 + 双栏布局 + 主题
│     ├─ useAgent.ts          # SSE → 视图模型（纯 reducer）+ 会话恢复
│     ├─ api.ts               # 全部同源相对路径
│     └─ components/          # ChatPane / ApprovalCard / AskUserCard / WorkbenchPane / ModelSettingsModal
├─ tests/                     # vitest：命令守卫、协议解析、沙箱、技能库、端到端闭环
└─ data/                      # config.json / metrics.jsonl（git 忽略）
```

---

## 核心机制

### 1. 主循环（`agentSession.ts`）

```
用户任务
  → 系统提示词（环境 + 工具协议 + 纪律）
  → 模型流式回复（SSE assistant_delta）
  → 有 tool_calls？
       有 → 逐条：审批？ → 执行 → 工具结果回喂（每个 tool_call_id 都回传，含被拒绝的）
       无 → 有 [TASK_DONE] 收尾；否则催促（最多 2 次）
  → 步数用尽则强制收尾总结
```

- **流式**：`assistant_delta` 逐字推送，前端打字机效果；
- **多工具单轮**：一条 assistant 消息里的多个 `tool_calls` 全部执行并逐一回传结果（拒绝也回传说明），避免下一轮 400；
- **挂起 / 恢复**：审批与 `ask_user` 都用 Promise 挂起协程，由 `POST /approve`、`/answer` 恢复；中断时统一 resolve 掉；
- **轨迹**：每一步的助手文本、工具入参/出参、审批结论都写盘。

### 2. 工具与沙箱

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `bash` | 工作区内执行命令，默认 60s 超时（最大 180s），超时杀整棵进程组 | ✗ |
| `read_file` / `list_files` | 带行号读取、文件树 | ✓ |
| `write_file` / `edit_file` | 写入/追加、精确替换（多处匹配会要求更精确上下文） | ✗ |
| `list_skills` / `read_skill` | 26 个技能渐进式加载 | ✓ |
| `fetch_page` | 抓网页转可读文本，网络受限时优雅降级 | ✓ |
| `ask_user` | 结构化提问（2-4 个选项 + 自由输入），挂起等待 | ✓ |
| `start_process` / `stop_process` | 后台服务，自动探测端口并接入 Live Preview | ✗ |

所有路径都过 `WorkspaceSandbox`：拦截 `../`、绝对路径、以及指向区外的符号链接；
命令先过 `CommandShape`，未闭合引号/括号/heredoc、结尾停在 `- | = (` 上的一律拒绝并让模型重写；
子进程环境里剔除 `*KEY* / *TOKEN* / *SECRET*` 等敏感变量。

### 3. 审批三档（默认「仅危险命令需确认」）

| 模式 | 读类工具 | 写文件 | 普通命令 | 危险命令（`rm -rf`、`sudo`、`curl|sh`、`git push`…） |
| --- | --- | --- | --- | --- |
| `readonly` 只读自动放行 | 自动 | 需确认 | 需确认 | 需确认 |
| `manual` 仅危险命令需确认（默认） | 自动 | 自动 | 自动 | 需确认 |
| `auto` 全自动 | 自动 | 自动 | 自动 | 自动 |

审批卡支持「允许 / 拒绝 / 本会话自动放行」；拒绝会把「用户拒绝执行」回喂给模型，让它换更安全的方式。

### 4. 模型路由与盲测

- 端点可在设置弹窗里增删（OpenAI / DeepSeek / Anthropic / Ollama / 自定义），Key 只存服务端 `data/config.json`，接口返回时脱敏；
- 支持用环境变量预置：`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`（可选 `*_BASE_URL` / `*_MODEL`）；
- 不支持 Tool Calling 的端点勾掉「原生 Tool Calling」即自动走代码块文本协议；
- **Arena Blind Mode**：新会话从可用端点里随机抽一个，界面只显示「盲测模型（反馈后揭晓）」，点赞/点踩后揭晓并累计排行榜（`/api/leaderboard`）。

### 5. Demo 编排引擎（零 Key）

不是假数据：它按剧本调用**真实工具**——

- 「番茄钟 / 待办 / 个人主页 / 其它」四套页面模板 → `write_file` 三次 → `bash ls -la && wc -c` 校验 → `[TASK_DONE]` 总结；
- 「有哪些技能」→ `list_skills` → `read_skill(frontend-design)` → 汇总技能库；
- 由于进度由「已得到的工具结果数」推导，审批被拒绝、工具失败、用户中断后都能自然继续，不会卡死。

### 6. Live Preview

`/preview/<sessionId>/...` 一个路由两种模式：

1. 会话用 `start_process` 起了真实服务 → 反向代理到 `127.0.0.1:<port>`；
2. 否则当静态站点，从工作区取文件（默认 `index.html`），并注入 `<base href="/preview/<id>/">` 让相对路径正确解析。

前端 `<iframe>` 只用相对地址，可切换桌面/手机视口、刷新、新窗口打开；不设任何阻止嵌入的响应头。

### 7. 轨迹与评测

- `.eagentx/session-<id>.md`：会话元信息 → 每步助手文本 → 每次工具调用（入参/结果/成功失败）→ 审批结论 → 结束统计；
- `data/metrics.jsonl`：会话（步数/耗时/工具调用数/失败数）与反馈（点赞点踩/是否盲测）两类事件，排行榜由它聚合。

---

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、当前引擎模式、技能数 |
| GET / PUT | `/api/config` | 读取（Key 脱敏）/ 保存模型与运行配置 |
| GET | `/api/skills` | 26 个技能摘要 |
| GET | `/api/leaderboard` | 盲测排行榜 |
| POST | `/api/sessions` | 新建会话（`{ endpointId? }`） |
| GET | `/api/sessions/:id` | 会话快照（刷新/重连回填） |
| GET | `/api/sessions/:id/events` | **SSE**：state / assistant_* / tool_call_* / approval_* / question_* / workspace_updated / process_* / session_done / error |
| POST | `/api/sessions/:id/messages` | 提交任务或追问 `{ text }` |
| POST | `/api/sessions/:id/approve` | 审批 `{ id, decision: approved\|rejected }` |
| POST | `/api/sessions/:id/answer` | 回答提问 `{ id, answer }` |
| POST | `/api/sessions/:id/stop` | 中断当前任务 |
| POST | `/api/sessions/:id/feedback` | 点赞/点踩并揭晓盲测模型 |
| PATCH | `/api/sessions/:id` | 调整审批模式 / 最大步数 |
| GET | `/api/sessions/:id/files` \| `/file?path=` \| `/trace` \| `/processes` | 文件树、文件内容、轨迹、后台进程 |
| GET | `/preview/:id/*` | Live Preview（静态或反代） |

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `API_PORT` | `3001` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址（云端预览务必保持 0.0.0.0） |
| `WEB_AGENT_WORKSPACES` | `web-agent/workspaces` | 会话工作区根目录 |
| `WEB_AGENT_DATA_DIR` | `web-agent/data` | 配置与指标目录 |
| `SKILL_ZIP_PATH` | 自动向上查找 `assets/skill_zip.zip` | 技能压缩包路径 |
| `DEMO_STREAM_MS` | `7` | Demo 引擎流式输出间隔（毫秒） |
| `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` | — | 首次启动时预置端点 |

---

## 测试与验收

```bash
npm test        # 5 个测试文件 / 30 个用例
npm run build   # 服务端 tsc + 前端 vite，零错误
```

覆盖点：

- `commandShape`：完整/截断命令、heredoc、尾随操作符、注释；
- `fallbackParser`：`tool:name`、裸语言名、json 包装、提示符剥离、未闭合围栏；
- `workspaceSandbox`：`../../etc/passwd`、绝对路径、同前缀兄弟目录越界、读写回环；
- `skillRegistry`：真实读取 `../assets/skill_zip.zip` 且 ≥20 个技能；
- `agentLoop`：Demo 引擎端到端（写文件 + 跑命令 + 轨迹落盘）、审批拒绝恢复、`ask_user` 挂起恢复、多工具单轮、盲测揭晓、文本协议闭环、截断命令拦截。

---

## 安全边界与已知限制

- 沙箱只保证「不会读写工作区之外的文件」，**不是容器级隔离**：`bash` 仍以服务进程身份执行，请勿在存放敏感数据的机器上把审批切到全自动；
- `fetch_page` 受宿主网络限制，出网失败会返回提示而不是抛异常；
- Anthropic 走非流式（一次性推送），OpenAI 兼容端点才是逐字流式；
- 会话与工作区保留在内存/磁盘，重启后旧的会话快照不可用（工作区文件仍在，可新建会话重新生成）；
- 盲测模式只在配置了 ≥2 个可用端点时才有意义。
