# 三大演进方案总览、架构审查报告与多分支分配指南

本文档汇总了基于 `EAgentX` 演进及对标 `https://arena.ai/agent` 的**三套独立实施方案**、**架构师交叉审查报告（含已修正的源码隐患）**，以及**可直接复制给另外三个分支的执行指令（Prompt）**。

---

## 一、三套方案定位与文件索引

| 方案编号 | 方案文档路径 | 核心目标 | 技术栈与形态 | 与原仓库冲突度 |
| :--- | :--- | :--- | :--- | :--- |
| **方案一** | [`plan-1-multi-site-cdp-web-engine.md`](plan-1-multi-site-cdp-web-engine.md) | 改造 `WebEngine` 支持多站点网页版（含 `arena.ai` Direct、DeepSeek、ChatGPT、Kimi 及自定义站点） | C# 5 / .NET Framework 4.8 WinForms 单 `.exe` | 低（仅改 Web/CDP 层与站点设置） |
| **方案二** | [`plan-2-arena-style-web-agent.md`](plan-2-arena-style-web-agent.md) | 借鉴 `EAgentX` 闭环机制与 26 个技能包，打造类 `arena.ai/agent` 的全栈双栏 Web 自主智能体工作台 | Node.js 22 + TypeScript + React/Vite（独立于 `web-agent/` 目录） | **零冲突**（完全不触碰根目录 C# 代码） |
| **方案三** | [`plan-3-native-tool-calling-and-mcp.md`](plan-3-native-tool-calling-and-mcp.md) | 强化桌面端 `ApiEngine`，补齐原生 Function Calling、SSE 逐字流式输出与零依赖 MCP 工具接入 | C# 5 / .NET Framework 4.8 WinForms 单 `.exe` | 低（聚焦 API 引擎、工具 Schema 与新增 `src/Mcp/`） |

---

## 二、架构与代码级审查报告（Review Report）

在生成并交叉审查三份方案与当前仓库源码（commit `e5da060`）的过程中，我们识别并提前修正了 **8 项关键风险与既有代码 Bug**（均已写入对应方案的正文约束中）：

### 1. 抓出当前仓库 `EAgentX` 既有隐蔽 Bug（影响方案一 & 方案三）
- **问题定位**：`src/Ui/MainForm.cs` 的 `NewSessionAsync()`（第 1087–1121 行）在用户点击「新建会话」时：
  - **网页模式**：调用了 `web.ResetAsync()` 让浏览器跳回新对话页，但**未重置 `AgentSession.HasRun = false`**。导致新对话发出的第一条任务只发送了 `"【新任务】..."` 追问模板，**整段系统提示词丢失**！
  - **API 模式**：点「新建会话」只清空了界面日志框，**根本没清空 `ApiEngine.Messages` 历史列表**，旧上下文一直残留。
  - 此外，`src/Engines/WebEngine.cs` 第 18 行存在约 250 行未使用的死代码常量 `Helper`（与 `BuildHelper()` 完全重复）。
- **审查结论与修正**：在方案一和方案三中统一为 `IChatEngine` 与 `AgentSession` 增加 `ResetAsync()` 契约，并清理 `WebEngine.cs` 死代码。

### 2. `arena.ai/agent` 与 `arena.ai` 普通对话模式的“双 Agent 抢工具冲突”（方案一核心风险）
- **问题定位**：`arena.ai/agent` 是自带云端 Linux Bash 沙箱的云端 Agent。如果 CDP 直接连 `/agent` 页面并发去 Windows PowerShell 提示词，云端模型会试图在它自己的 Linux 容器里跑 PowerShell 命令而不是输出代码块给本机。此外，`arena.ai` 默认首页是 Battle 双模型并排输出，简单取最后一个 Markdown 节点会导致左右栏串台。
- **审查结论与修正**：方案一将 `Arena` 预设默认 URL 定为 **`https://arena.ai/?mode=direct`（Direct 纯对话模式）**；同时在注入脚本中实现 **并排双栏左栏锁定算法**、**`/agent` 路径冲突检测告警** 以及 **Cloudflare Turnstile / 条款弹窗最多 120 秒等待机制**。

### 3. C# 5 编译器红线与跨环境验证盲区（方案一 & 方案三致命构建风险）
- **问题定位**：`EAgentX.csproj` 和 `build.ps1` 强制要求 `/langversion:5`（兼容 Windows 自带无 SDK 的 `v4.0.30319\csc.exe`）且**零 NuGet 依赖**。若分支上的 AI 编码代理习惯性写出 `?.`、`$"..."`、`nameof()`、`out int x` 或引入 `Newtonsoft.Json`，在 Windows 上跑 `build.ps1` 会立刻编译失败；而云端 Linux 沙箱默认装有 Node 22 / Python 3.11 但未预装 `csc.exe`。
- **审查结论与修正**：在方案一和方案三中明确列出禁用语法清单，要求配备 `tools/verify-cs5.py` 静态语法守卫脚本；方案一额外配备 `tools/test-web-helper.mjs` 用 Node 验证注入脚本 DOM 逻辑。

### 4. 原生 Tool Calling 多工具并发 `400 Bad Request` 陷阱（方案三核心风险）
- **问题定位**：切换为原生 OpenAI Function Calling 后，大模型常在单轮 `assistant` 消息中返回 **多个 `tool_calls`**，且 SSE 流式模式下 `function.arguments` 会拆成多个 chunk 下发。如果宿主只回传第一个 `tool_call_id`，或用户点拒绝后漏回 `tool` 消息，下一轮 API 调用必报 `400`。
- **审查结论与修正**：方案三强制要求按 `index` 聚合 SSE `tool_calls` 分片，并对每个 `tool_call_id` 严格一一回传 `role: "tool"` 消息（即使审批拒绝也回传拒绝说明）。

### 5. Stdio MCP 子进程 UTF-8 BOM 崩溃陷阱（方案三隐蔽风险）
- **问题定位**：.NET Framework 的 `Encoding.UTF8` 默认输出 3 字节 BOM（`EF BB BF`），会导致 Node/Python 编写的标准 MCP Server 首行 `JSON.parse` 抛异常直接退出。
- **审查结论与修正**：方案三强制规定 `McpClient` 的标准输入/输出流必须使用 `new UTF8Encoding(false)`，并写入单元测试断言。

### 6. 非视觉模型（如 `deepseek-chat`）传入截图 `image_url` 报错问题（方案三）
- **问题定位**：`ApiEngine` 若无脑将截图转成 `image_url` 发给纯文本模型，接口会直接拒绝。
- **审查结论与修正**：方案三将 `role: "tool"` 结果固定为纯文本 JSON 元数据，并新增 `ApiVisionEnabled` 开关控制是否附带 `image_url` 视觉块。

### 7. 云端沙箱预览网络规范与免 Key 可测试性（方案二）
- **问题定位**：Web 应用若在前端写死 `http://localhost:3001` 或后端只绑 `127.0.0.1`，在云端远程浏览器预览环境下会彻底无法访问；若没有预置 API Key，页面打开后无法验收闭环效果。
- **审查结论与修正**：方案二强制绑定 `0.0.0.0`、配置 Vite `allowedHosts: true` 与相对路径 `/api`、`/preview` 代理，并内置 **Demo Mock 真实工具编排引擎**（无 Key 也能真实写文件、跑命令、看右侧 Live Preview，填 Key 即切换真模型）。

### 8. 三分支并行开发与未来合并（Merge）冲突控制
- `EAgentX.csproj` 使用 `<Compile Include="src\**\*.cs" />` 通配符，`build.ps1` 递归扫描 `src\*.cs`，因此新增 `.cs` 文件**完全不产生工程文件冲突**。
- **方案二** 100% 位于 `web-agent/` 目录，与方案一、方案三 **0 文件交集**。
- **方案一**与**方案三**的单元测试分别拆入 `src/SelfTest.WebSites.cs` 与 `src/SelfTest.NativeTools.cs`（利用 `partial class SelfTest`），将来若想把方案一和方案三合并到同一个超级桌面版，只需轻量合并 `Settings.cs`、`SettingsForm.cs`、`MainForm.cs` 三处配置绑定即可。

---

## 三、综合评估与推进优先级建议

| 评估维度 | 方案一：多站点 CDP 网页版 | 方案二：类 Arena 全栈 Web Agent | 方案三：桌面原生 Tool + MCP |
| :--- | :--- | :--- | :--- |
| **开发工作量** | 小–中（约 4–6 个核心文件） | 中–大（独立全栈前后端工程） | 中（流式解析 + JSON-RPC MCP） |
| **运行时稳定性** | 中（受第三方网页改版与风控影响） | **高**（标准 API + 隔离工作区） | **高**（标准 API + 标准 MCP 协议） |
| **使用成本** | **免费**（复用网页版额度） | 按 API Token 计费（含免费 Demo 模式） | 按 API Token 计费（支持免费本地 Ollama） |
| **能力上限** | 本机 PowerShell + 键鼠 GUI | 云端代码/建站实时预览 + 多模型盲测评测 | **本机 GUI/PowerShell + 外部 MCP 生态通吃** |

---

## 四、直接分配给另外三个分支的执行指令（可直接复制粘贴）

> **使用方式**：如果你把当前分支的 `docs/plans/` 目录同步过去，直接发对应简短指令即可；如果另外三个分支是从原始 `main`（`e5da060`）直接拉出的干净分支，也可以直接把对应 `docs/plans/plan-*.md` 的全文连同下面指令一起发给对应分支的 Agent。

### 分支 1 指令（执行方案一：多站点 CDP 网页引擎）
```text
请严格按照方案一改造当前仓库 EAgentX，使其 WebEngine 支持多站点网页适配器（含 Arena.ai Direct 模式、DeepSeek、ChatGPT、Kimi 与自定义站点）：
1. 新增 src/Util/WebSiteProfile.cs，内置 deepseek / arena (默认 https://arena.ai/?mode=direct) / chatgpt / kimi / custom 五套预设；扩展 Selectors 支持消息容器、动作栏、Cloudflare Turnstile 人机验证检测、中英文限流词与 Arena 并排双栏左栏锁定消歧。
2. 重构 src/Engines/WebEngine.cs 与 src/Net/EdgeLauncher.cs：移除 WebEngine 中重复未使用的 Helper 死代码常量，去掉写死的 deepseek.com 域名与 .ds-* / SVG 路径耦合（仅在 deepseek 预设启用专属 SVG 判定），动态提取 StartUrl 域名，遇登录或 Cloudflare 验证时等待最多 120 秒，检测到 arena.ai/agent 路径时给出双 Agent 工具冲突提示。
3. 修复新建会话丢失系统提示词与不清空 API 历史的既有 Bug：在 IChatEngine 和 AgentSession 中增加 ResetAsync，并在 MainForm.NewSessionAsync 中调用。
4. 在 Settings / SettingsForm 增加网页站点下拉框联动，动态更新 MainForm 标题与状态栏文案。
5. 硬性约束：所有 C# 代码必须严格保持 C# 5 语法（禁用 ?.、$"..."、nameof、out var 等）与零 NuGet 依赖；使用 partial class SelfTest 将新增单测放入 src/SelfTest.WebSites.cs，并编写 tools/test-web-helper.mjs（Node 测试多站点 DOM 提取）和 tools/verify-cs5.py 确保全部验证通过。
```

### 分支 2 指令（执行方案二：类 `arena.ai/agent` 全栈 Web 智能体工作台）
```text
请在当前仓库新建独立的 web-agent/ 子目录（零修改根目录任何 C# 源码、EAgentX.csproj 或 build.ps1），借鉴 EAgentX 的核心闭环机制并对齐 arena.ai/agent 体验，开发一套全栈 TypeScript 双栏 Web 自主智能体工作台并启动在线预览：
1. 后端（Node.js + Express/Fastify + SSE）：移植 EAgentX 的 AgentSession 多步状态机、CommandShape 命令残片拦截、PowerShellRunner 的超时杀进程组与头8000+尾3000字符输出截断、.eagentx Markdown 轨迹与评测信号记录；直接读取 ../assets/skill_zip.zip 解压索引全部 26 个 SKILL.md 暴露为 list_skills / read_skill 工具。
2. 工具与安全沙箱：每个会话隔离在 workspaces/<sessionId>/（严格拦截 ../ 路径穿越），实现 bash、read_file、write_file、edit_file、fetch_page、ask_user 澄清提问工具，以及可切换的人工审批挂起机制。
3. 多模型路由：支持配置 OpenAI/DeepSeek/Anthropic 兼容 API（原生 Tool Calling + 代码块回退解析）及“随机盲测路由 + 点赞后揭晓模型”模式；同时必须内置零 API Key 可用的 Demo 编排引擎，支持开箱即用跑通“生成多文件网页并在右侧实时预览”的真实工具闭环。
4. 前端（React + Vite + Tailwind）：继承 EAgentX 日间/夜间双主题视觉风格，左栏展示流式对话、工具执行折叠卡、内联审批卡与单选提问卡；右栏提供 Live Preview（iframe 同源代理 /preview/:sessionId/*）、文件查看器、终端输出与 Trace 轨迹页签。
5. 网络与工程约束：纯 JS/TS 依赖（不用 node-gyp 原生包），服务绑定 0.0.0.0，Vite 开启 allowedHosts: true 并代理 /api 与 /preview（前端严禁硬编码 localhost），补齐 Vitest 单元测试并启动后台服务提供实时预览。
```

### 分支 3 指令（执行方案三：强化桌面端原生 Tool Calling + 流式 + MCP）
```text
请严格按照方案三升级当前仓库 EAgentX 桌面端（聚焦 ApiEngine、AgentSession 与新增 src/Mcp/，不改动 WebEngine 网页自动化逻辑）：
1. 在保持 IChatEngine 向后兼容的前提下（仅补充 ResetAsync 修复新会话清历史 Bug），新增 src/Engines/IToolChatEngine.cs 与 src/Core/BuiltInToolSchemas.cs，将 run_powershell、capture_screenshot、attach_local_file、mouse_click、keyboard_press 及 list_skills/read_skill 封装为标准 JSON Schema 工具，保留原有 ApproveForm 人工审批逻辑。
2. 升级 src/Engines/ApiEngine.cs：支持 OpenAI 兼容的原生 tools 调用与 SSE 流式输出（HttpCompletionOption.ResponseHeadersRead），按 index 完整拼接跨 chunk 分片的 delta.tool_calls 参数；确保单轮返回多个 tool_calls 时每个 tool_call_id 都严格回传对应的 role:"tool" 消息（含用户拒绝场景）；新增 ApiVisionEnabled 开关控制截图是否追加 image_url 附件以兼容纯文本模型。
3. 新增零依赖 MCP 客户端（src/Mcp/McpConfig.cs、McpClient.cs、McpManager.cs）：支持读取 mcp.json（兼容标准 mcpServers 格式），实现 Stdio（必须使用 new UTF8Encoding(false) 无 BOM 防止子进程 JSON 解析崩溃）与 HTTP 两种 JSON-RPC 2.0 传输，完成 initialize -> tools/list -> tools/call 闭环并映射为 mcp__<server>__<tool>。
4. 升级 AgentSession 与 MainForm（70ms 缓冲节流渲染 AssistantDelta 流式增量），在 SettingsForm 增加原生工具/流式/视觉开关及「MCP 工具」配置测试页签。
5. 硬性约束：严格遵守 C# 5 语法与零 NuGet 依赖；使用 partial class SelfTest 在 src/SelfTest.NativeTools.cs 中利用本地 Loopback TcpListener 编写 SSE 多分片 Tool Call 闭环单测与 MCP JSON-RPC 握手单测，并编写 tools/verify-cs5.py 验证语法合规。
```
