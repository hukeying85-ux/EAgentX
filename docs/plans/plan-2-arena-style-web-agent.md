# 方案二实施计划：构建类 `arena.ai/agent` 的全栈 Web 自主智能体工作台

> **适用分支**：分支 2（建议命名示例：`feat/arena-web-agent`）
> **目标形态**：借鉴 `EAgentX` 的核心闭环机制（状态机、残片拦截、`SKILL.md` 技能体系、输出头尾截断、Markdown 轨迹审计），在独立子目录 `web-agent/` 下构建一套现代化的 **类 `arena.ai/agent` 双栏 Web 自主智能体平台**，支持多模型路由（原生 Function Calling + 文本代码块双兼容 + 零 Key 演示引擎）、工作区沙箱工具链、人工审批与右侧实时预览（Live Preview）。
> **与其它分支隔离约定**：所有代码 **100% 收敛在 `web-agent/` 子目录内**（仅只读复用 `../assets/skill_zip.zip` 与 `../assets/eagent_prompt.txt` 思路），**零修改** 根目录下的任何 `src/*.cs`、`EAgentX.csproj` 或 `build.ps1`，与分支 1、分支 3 合并 **0 冲突**。

---

## 1. 产品定位：如何把 `EAgentX` 基因升级为 `arena.ai/agent` 体验？

| 核心模块 | 从 `EAgentX` 继承的工程精华 | 对齐 `arena.ai/agent` 新增的云端/Web 能力 |
| :--- | :--- | :--- |
| **编排主循环** | `AgentSession.cs` 的步数熔断（`MaxSteps`）、空回复催促（`ContinueNudges`）、`[TASK_DONE]` / `[NEED_INPUT]` 状态切分 | 支持**多工具并发调用**、SSE 实时流式推送（思考过程 + 工具卡片动态刷新）、随时中断与追问续跑 |
| **工具协议层** | `CommandParser.cs` + `CommandShape.cs`（未闭合引号/括号/here-string 静态拦截） | **双模引擎**：优先走 OpenAI/Anthropic 兼容的原生 JSON Schema Tool Calling；对不支持 Tool Calling 的模型自动回退到代码块协议；并内置 **Demo Mock 引擎**（无 API Key 也能完整体验建站/执行/预览全流程） |
| **技能包系统** | 直接读取并解压仓库现有的 `../assets/skill_zip.zip`（26 个 `SKILL.md` 技能） | 提供 `list_skills` / `read_skill` 工具与前端技能面板，按需渐进式加载技能文档，节省上下文 Token |
| **工具与沙箱** | `PowerShellRunner.cs` 的超时杀进程树 + 头 8000 / 尾 3000 字符截断 | 跨平台工作区隔离目录（`workspaces/<sessionId>/`）：`bash`/`pwsh` 命令执行、`read_file`/`write_file`/`edit_file`、后台服务进程管理（`start_process` 端口探测）、网页抓取（`fetch_page`）与交互式提问（`ask_user`） |
| **安全与留痕** | 默认命令审批（`ApproveForm`）+ `.eagentx/session-*.md` 会话轨迹 | Web 端内联命令审批卡片（支持“只读自动放行 / 写与命令需确认 / 全自动”三档）+ 轨迹回放与用户点赞/点踩评测信号导出（对标 Agent Arena Trace） |
| **前端工作台** | 日间浅色 / 夜间深色护眼卡片视觉语言 | **双栏分屏 IDE 工作台**：左栏对话流 + 工具折叠卡片 + 单选澄清组件；右栏 **文件树 / 代码查看器 / 终端日志 / Web 实时预览（Live Preview iframe）** |

---

## 2. 技术栈与运行环境约束（必读）

1. **技术选型（前后端全栈 TypeScript，零系统级编译依赖）**：
   - **Runtime**：Node.js 22+（纯 JS/TS 依赖，不使用 `node-pty` / `better-sqlite3` 等需要 C++ `node-gyp` 编译的原生包，确保在受限容器与 Windows 下 `npm install` 100% 秒过）。
   - **后端（`web-agent/server`）**：`Express`（或 `Fastify`）+ 原生 `fetch` 流式大模型客户端 + `adm-zip`（或 Node 内置 `zlib`/纯 JS 解压读取 `../assets/skill_zip.zip`）+ SSE（Server-Sent Events）。
   - **前端（`web-agent/client`）**：`React 18` + `Vite` + `Tailwind CSS` + `Lucide Icons`。
   - **测试**：`Vitest` 单元测试 + Supertest/原生 `fetch` 接口集成测试。
2. **云端沙箱与实时预览网络规范（严禁踩坑）**：
   - **监听地址**：后端与 Vite 前端开发服务器必须绑定 **`0.0.0.0`**（绝不能只绑 `127.0.0.1`）。
   - **Host / Origin 放行**：Vite 配置必须设置 `server: { host: '0.0.0.0', allowedHosts: true, proxy: { '/api': 'http://127.0.0.1:3001', '/preview': 'http://127.0.0.1:3001' } }`；禁止前端设置阻止 iframe 嵌入的响应头。
   - **禁止浏览器直连 `localhost`**：前端所有 API 请求与工作区静态/服务预览一律走**相对路径**（`/api/...`、`/preview/<sessionId>/...`），由 Vite / 后端统一反向代理，保证在云端远程浏览器预览（如 `https://{port}-{sandbox}.e2b.app`）与本机均正常可用！
3. **Git 提交卫生**：在 `web-agent/.gitignore` 忽略 `node_modules/`、`dist/`、`workspaces/`、`.env`，切勿将依赖产物提交进 Git。

---

## 3. 目录结构设计

```text
web-agent/
├─ package.json                  # npm workspaces 或统一脚本 (dev / build / test)
├─ tsconfig.json
├─ vite.config.ts                # host: '0.0.0.0', allowedHosts: true, /api 与 /preview 代理
├─ README.md                     # 启动说明、环境变量与架构图
├─ server/
│  ├─ index.ts                   # HTTP + SSE 服务入口 (0.0.0.0:3001)
│  ├─ core/
│  │  ├─ agentSession.ts         # 移植并升级自 AgentSession.cs：多步闭环、审批挂起、轨迹记录
│  │  ├─ commandShape.ts         # 移植自 CommandShape.cs：Shell/PS 命令截断与未闭合语法拦截
│  │  ├─ fallbackParser.ts       # 移植自 CommandParser.cs：Markdown 代码块工具回退解析
│  │  ├─ skillRegistry.ts        # 解压并索引 ../assets/skill_zip.zip 中的 26 个 SKILL.md
│  │  └─ traceStore.ts           # 生成 Markdown 轨迹 + JSONL 评测信号 (耗时/步数/工具成败/点赞)
│  ├─ providers/
│  │  ├─ llmRouter.ts            # 多模型路由：OpenAI / DeepSeek / Claude / Ollama / Arena盲测随机模式
│  │  └─ demoProvider.ts         # 零 API Key 演示编排器：支持真实的“创建网页/分析仓库/调用技能”端到端闭环演示
│  └─ tools/
│     ├─ workspaceSandbox.ts     # 路径逃逸守卫 (限制在 workspaces/<sessionId> 内)
│     ├─ bashTool.ts             # 带超时、进程组清理 (process.kill(-pid))、头8000+尾3000截断的终端工具
│     ├─ fileTools.ts            # read_file / write_file / edit_file / list_files
│     ├─ webTools.ts             # fetch_page (HTML 转可读 Markdown；遇网络受限时优雅提示)
│     ├─ askUserTool.ts          # 结构化澄清单选提问工具 (挂起等待前端用户点选)
│     └─ previewProxy.ts         # 静态 HTML 直接预览 + 子进程 Web 服务反向代理 (/preview/:sessionId/*)
├─ client/
│  ├─ index.html
│  └─ src/
│     ├─ App.tsx                 # 双栏响应式工作台 + 日间/夜间双主题切换（致敬 EAgentX 配色）
│     ├─ components/
│     │  ├─ ChatPane.tsx         # 流式消息、思考折叠块、工具调用状态卡、点赞/点踩反馈条
│     │  ├─ ApprovalCard.tsx     # 危险命令内联审批卡片（允许 / 拒绝 / 本会话自动放行）
│     │  ├─ AskUserCard.tsx      # 澄清问题选项卡片（对标 arena.ai/agent 交互提问）
│     │  ├─ WorkbenchPane.tsx    # 右栏多页签：Live Preview / 文件浏览器 & 代码高亮 / 终端输出 / Trace 轨迹
│     │  └─ ModelSettingsModal.tsx # 模型配置（支持自定义 BaseURL + Key、盲测随机路由、或一键 Demo 模式）
└─ tests/
   ├─ commandShape.test.ts       # 截断命令检查单测
   ├─ skillRegistry.test.ts      # 验证真实加载 ../assets/skill_zip.zip 的 26 个技能
   ├─ workspaceSandbox.test.ts   # 路径穿越拦截单测 (../ 逃逸阻断)
   └─ agentLoop.test.ts          # 端到端闭环单测 (含工具执行、审批拒绝恢复、轨迹落盘)
```

---

## 4. 分阶段实施步骤

### 阶段 1：核心内核移植与安全沙箱（`server/core` & `server/tools`）
1. **实现 `workspaceSandbox.ts`**：为每个会话创建独立目录 `web-agent/workspaces/<sessionId>`；所有文件读写路径经 `path.resolve` 校验前缀必须在工作区内，阻止 `../` 越界访问宿主机敏感目录。
2. **移植 `commandShape.ts` 与 `bashTool.ts`**：
   - 将 `EAgentX` 的引号、括号、管道/连字符结尾残片检测移植到 TS（兼顾 Bash heredoc `<< 'EOF'` 与 PowerShell here-string）；
   - `bashTool` 使用 `spawn(..., { detached: true, cwd: sessionWorkspace })`，超时终止整个进程组，输出超 12,000 字符时保留头 8,000 + 尾 3,000 字符并标注省略字数。
3. **实现 `skillRegistry.ts`**：直接读取上级目录 `../assets/skill_zip.zip`，解析全部 26 个技能目录的 `SKILL.md` 元信息（名称与摘要），暴露 `list_skills` 与 `read_skill(name)` 两个工具给模型。

### 阶段 2：多模型路由与编排会话（`server/providers` & `server/core/agentSession.ts`）
1. **实现 `llmRouter.ts`**：
   - 支持配置多个模型端点（OpenAI / DeepSeek / Anthropic 兼容格式），并提供 **“Arena Blind Mode（随机盲测模式）”**：从已配置的模型池中随机抽取一个作为当前会话的 Orchestrator，在用户提交点赞/点踩反馈后再揭晓模型身份并写入本地 Leaderboard 统计！
   - 同时内置 **`demoProvider.ts`（免 Key 真实沙箱演示引擎）**：当未配置任何 API Key 时默认可用，能根据用户指令（如“帮我做一个带番茄钟的个人主页并预览”或“查看有哪些技能并汇总项目结构”）真正调用 `write_file` / `bash` / `list_skills` 工具生成真实文件并在右栏实时预览。
2. **实现 `agentSession.ts` + SSE 事件流**：
   - 定义标准 SSE 事件：`assistant_delta`、`tool_call_start`、`approval_required`、`question_required`、`tool_call_result`、`workspace_updated`、`session_done`、`error`。
   - 实现挂起恢复 Promise：当触发命令审批（`ApprovalMode === 'manual'`）或 `ask_user` 提问时，会话协程挂起等待 `POST /api/sessions/:id/approve` 或 `/answer` 回调后继续下一步。

### 阶段 3：双栏 Web 工作台与实时预览（`client/` & `previewProxy.ts`）
1. **左栏（对话与交互流）**：沿用 `EAgentX` 温和的冷灰/米白日间主题与深灰蓝夜间主题，展示流式输出、可展开查看入参/出参的工具执行胶囊、内联审批卡与单选提问卡。
2. **右栏（实时工作台 Workbench）**：
   - **Live Preview 页签**：当 Agent 在工作区生成了 `index.html` 或启动了 Web 服务，自动通过同源代理路径 `/preview/<sessionId>/index.html` 在右侧 `<iframe>` 实时渲染，带刷新与响应式视口切换按钮；
   - **Files 页签**：实时浏览工作区文件树并查看文件内容；
   - **Terminal 页签**：聚合展示历史 `bash` 执行流与退出码；
   - **Trace & Eval 页签**：展示自动生成的 `.eagentx/session-*.md` 审计轨迹与会话评测指标（总步数、工具成功率、耗时、模型揭晓）。

---

## 5. 测试与验收标准

1. **自动化测试全绿**：运行 `cd web-agent && npm test`，覆盖：
   - `commandShape` 截断命令识别率 100%；
   - `skillRegistry` 成功从 `../assets/skill_zip.zip` 读取出 ≥ 20 个 `SKILL.md` 技能；
   - `workspaceSandbox` 拦截 `../../etc/passwd` 路径逃逸；
   - `agentSession` 在 Demo 引擎下跑通“计划 → 审批 → 写文件/跑 bash → 生成轨迹 → 完成”全链路。
2. **生产构建与在线预览验收**：
   - `cd web-agent && npm run build` 零 TypeScript 编译错误；
   - 使用后台进程启动服务（监听 `0.0.0.0`），确认无 Host/Origin 拦截或 iframe 阻断告警，打开预览页面可直接通过内置 Demo 模式一键生成网页并在右栏 Live Preview 实时看到渲染结果；填入真实 DeepSeek / OpenAI API Key 后可无缝切换真实大模型驱动。
3. **分支纯净度检查**：`git status` 确认根目录 C# 工程文件无任何修改，且 `node_modules/`、`workspaces/` 未被追踪。
