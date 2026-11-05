# 方案三实施计划：强化 `EAgentX` 本机智能体（原生 Function Calling + SSE 流式 + MCP 接入）

> **适用分支**：分支 3（建议命名示例：`feat/native-tools-and-mcp`）
> **目标形态**：保留 `EAgentX` 轻量级 Windows 原生桌面端优势，彻底解决 `docs/设计说明.md` 第 9、10 节列出的三大核心短板——将 `ApiEngine` 升级为支持 **原生结构化 Tool / Function Calling**、**SSE 逐字流式输出**，并实现零外部依赖的 **MCP（Model Context Protocol）客户端**（支持接入本地 `stdio` 与远程 `http` MCP Server，如 GitHub、Filesystem、Fetch、Notion 等连接器），让桌面端兼具 `arena.ai/agent` 的连接器生态与本机 GUI/PowerShell 操控力。
> **与其它分支隔离约定**：聚焦 `ApiEngine`、`AgentSession` 工具分发与新增 `src/Mcp/` 目录；**不修改 `WebEngine.cs` 与 `EdgeLauncher.cs` 的网页自动化逻辑**。

---

## 1. 背景与关键架构问题定位（审查重点）

在当前仓库中，`ApiEngine.cs`（第 15–17 行）明确注明：*“仍然走「文本命令协议」，没实现 function calling，不支持流式逐字显示”*。在升级过程中，必须规避以下 **4 个极易踩中的工程陷阱**：

1. **陷阱 1：破坏 `IChatEngine` 会导致 `WebEngine` 与全部旧版 `SelfTest` 崩溃**
   - 现状：`IChatEngine.SendAsync` 返回纯 `Task<string>`，`SelfTest.cs` 里有 4 个假引擎实现了该接口。
   - **解法**：**保留 `IChatEngine` 原签名完全兼容**（补充 `ResetAsync` 修复新会话清历史 Bug），新增扩展接口 **`IToolChatEngine : IChatEngine`**。`AgentSession` 运行时判断 `Engine is IToolChatEngine` 且 `S.ApiNativeTools == true` 时走结构化工具调用与流式回调路径；否则（如 `WebEngine` 或用户关闭原生工具开关时）100% 保持原有 Markdown 代码块协议！
2. **陷阱 2：单轮并发多 Tool Calls 漏回 `tool_call_id` 导致 API 报 `400 Bad Request`**
   - 现状：旧代码块协议每轮只执行 1 条命令；但原生 Function Calling 下，GPT / Claude / DeepSeek 经常在一条 `assistant` 消息里同时返回 **多个 `tool_calls`**（例如同时调 `read_file` 读两个文件，或调 `mcp__filesystem__list`）。
   - **硬性协议要求**：OpenAI 兼容规范强制要求 `assistant.tool_calls` 数组中的**每一个 `id` 都必须紧跟一条对应的 `{ "role": "tool", "tool_call_id": id, "content": "..." }` 消息**（哪怕某条工具被用户在 `ApproveForm` 拒绝执行，也必须回传一条 `"用户拒绝执行该工具调用"` 的 `tool` 消息，绝不能漏传 `tool_call_id`！）。
3. **陷阱 3：截图工具的二进制图片回传与非多模态模型报错（`deepseek-chat` 兼容）**
   - 现状：许多 OpenAI 兼容网关不允许在 `role: "tool"` 的 `content` 中放 `image_url` 数组；且纯文本模型（如 `deepseek-chat`）收到 `image_url` 会直接报 `400`。
   - **解法**：`screenshot` 工具在 `role: "tool"` 消息中始终返回纯文本 JSON 摘要（尺寸、保存路径、鼠标物理坐标）；仅当设置开启 **`S.ApiVisionEnabled`（模型支持视觉输入）** 时，额外追加一条包含 `image_url` data URI 的 `user` 附件消息。
4. **陷阱 4：.NET Framework `Encoding.UTF8` 带 BOM 导致 Stdio MCP Server 解析崩溃**
   - 现状：`Encoding.UTF8` 默认会在流开头写入 3 字节 BOM（`EF BB BF`），Node.js / Python 编写的标准 MCP Server（如 `@modelcontextprotocol/server-filesystem`）从 `stdin` 读第一行 JSON-RPC 时会直接抛 `SyntaxError: Unexpected token \uFEFF` 退出！
   - **解法**：`McpStdioTransport` 的 `StreamWriter` / `StreamReader` **必须显式使用 `new UTF8Encoding(false)`（无 BOM UTF-8）**！

---

## 2. 硬性技术约束（必读）

1. **严格遵守 C# 5 语法**：编译目标为 `/langversion:5`（兼容 Windows 自带 `csc.exe`）。禁止使用 `?.`、`$"..."`、`nameof()`、`out var`、`using var`、表达式体成员 `=>`。
2. **零外部 NuGet 依赖**：SSE 流解析基于 `HttpClient.SendAsync(..., HttpCompletionOption.ResponseHeadersRead)` + `StreamReader.ReadLineAsync()` 手写；MCP JSON-RPC 2.0 基于现有 `EAgentX.Util.Json`（`JavaScriptSerializer`）实现。
3. **UI 线程防闪烁节流**：WinForms `RichTextBox` 逐 token 刷新若每毫秒 `AppendText` 会严重卡死和闪烁；流式增量必须做 **60–80ms 缓冲合并节流** 后再 `BeginInvoke` 追加到当前助手段落。

---

## 3. 模块设计与实施步骤

### 步骤 1：定义结构化对话与流式契约 `src/Engines/IToolChatEngine.cs`
新增数据结构与扩展接口（C# 5 类定义）：
- `ToolDefinition`：`Name`、`Description`、`ParametersSchema`（`Dictionary<string, object>` JSON Schema）。
- `ToolCallRequest`：`Id`、`Name`、`ArgumentsJson`。
- `ToolCallResponse`：`ToolCallId`、`Name`、`Content`、`Attachments`（可选本地图片路径）。
- `ChatTurnResponse`：`Content`（文本回复）、`ReasoningContent`（深度思考内容，兼容 DeepSeek Reasoner / R1）、`ToolCalls`（`List<ToolCallRequest>`）、`FinishReason`。
- `IToolChatEngine : IChatEngine`：
  - `bool UseNativeTools { get; }`
  - `Task<ChatTurnResponse> SendTurnAsync(string userText, string[] attachments, List<ToolCallResponse> toolOutputs, IList<ToolDefinition> tools, Action<string> onContentDelta, CancellationToken ct);`

### 步骤 2：构建内置工具 Schema 与分发器 `src/Core/BuiltInToolSchemas.cs`
将 `EAgentX` 现有的 5 大能力 + 技能查询封装为标准 JSON Schema 工具（受 `S.EnableTools` 开关控制）：
1. `run_powershell`(`command`, `description`) -> 复用 `PowerShellRunner.Run`（保留 `ApproveHandler` 审批弹窗！）
2. `capture_screenshot`(`target`: `"screen"` 或窗口句柄字符串) -> 复用 `ToolRunner.Screenshot`
3. `attach_local_file`(`path`) -> 复用 `ToolRunner.Upload`（或读取小文本文件直接返回内容）
4. `mouse_click`(`x`, `y`, `action`: `"left"|"double"|"right"|"rightdouble"`) -> 复用 `ToolRunner.Mouse`（保留审批！）
5. `keyboard_press`(`keys`: 虚拟键码数组, `hwnd`: 可选窗口句柄) -> 复用 `ToolRunner.Keyboard`（保留审批！）
6. `list_skills` / `read_skill`(`skill_name`) -> 直接索引 `.eagentx\skills\` 下的 26 个 `SKILL.md`，让模型按需读取技能说明，大幅减少首轮 System Prompt 体积！

### 步骤 3：升级 `src/Engines/ApiEngine.cs`（原生 Tool Calling + SSE 流式）
1. **支持 `stream: true`（可由 `S.ApiStream` 开关切换）**：
   - 使用 `HttpCompletionOption.ResponseHeadersRead` 读取 `text/event-stream`；
   - 逐行解析 `data: {...}` 直至 `data: [DONE]`（若服务端未返回 `text/event-stream` Content-Type，自动兼容按普通 JSON 一次性解析，兼容老网关）；
   - 流式拼接 `delta.content`、`delta.reasoning_content`，以及按 `index` 聚合分片到达的 **`delta.tool_calls[i].id` / `function.name` / `function.arguments`**（这是流式 Tool Calling 的核心细节：函数参数 JSON 是跨多个 SSE chunk 分片传输的，必须按 `index` 用 `StringBuilder` 拼齐后再返回！）。
2. **原生 `tools` 消息历史维护**：
   - 当 `UseNativeTools` 开启时，首条 `system` 提示词采用精简版原生工具系统提示词（不再注入冗长的 `agent_mouse_simulate_1_start` 文本标记说明，避免模型混用文本标记和原生函数调用）；
   - 将模型返回的 `assistant` 消息（含 `tool_calls` 数组）原样存入 `Messages`，随后在下一轮开头把宿主执行得到的全部 `{ role: "tool", tool_call_id, content }` 追加进 `Messages` 再请求模型。
3. **实现 `ResetAsync`**：清空 `Messages` 并重新压入最新 `system` 消息。

### 步骤 4：实现零依赖 MCP 客户端 `src/Mcp/`（对标 `arena.ai/agent` 连接器能力）
新增三个高内聚文件：
1. **`src/Mcp/McpConfig.cs`**：定义 `McpServerEntry`（`Name`、`Enabled`、`Transport`: `"stdio"` | `"http"`、`Command`、`Args`、`Env`、`Url`、`Headers`、`RequireApproval` 默认 `true`）。配置文件存放在 `%APPDATA%\EAgentX-UI\mcp.json`（与 `config.json` 同目录，支持标准 `mcpServers` JSON 结构，可直接粘贴 Claude Desktop / Cursor 的 `mcpServers` 配置！）。
2. **`src/Mcp/McpClient.cs`**：
   - **Stdio 传输**：启动子进程（`CreateNoWindow = true`，`UseShellExecute = false`，`StandardInput/Output` 均采用 `new UTF8Encoding(false)`），后台线程异步读取 `stdout` 按行解析 JSON-RPC 响应并按 `id` 匹配 `TaskCompletionSource<Dictionary<string, object>>`，`stderr` 写入调试日志；`Dispose()` 时安全终止子进程。
   - **HTTP 传输**：通过 `HttpClient` 向 MCP Endpoint 发送 JSON-RPC POST 请求（兼容返回 `application/json` 或单次 `text/event-stream` 包装的响应）。
   - **标准握手流程**：`initialize`（`protocolVersion: "2024-11-05"`） -> 发送 `notifications/initialized` 通知 -> 调用 `tools/list` 获取工具列表 -> 调用 `tools/call` 执行工具并提取 `content` 数组中的 `text` / `image` 结果。
3. **`src/Mcp/McpManager.cs`**：
   - 管理多个已启用的 MCP Server，把外部工具统一命名空间映射为 `mcp__<serverName>__<toolName>`（过滤非法字符以符合 OpenAI 函数名正则 `^[a-zA-Z0-9_-]{1,64}$`），注入到 `ToolDefinition` 列表；
   - 当模型调用 `mcp__*` 工具时，路由回对应的 `McpClient.CallToolAsync`，并根据 `RequireApproval` 触发 `ApproveForm` 人工确认。

### 步骤 5：升级 `AgentSession.cs`、`SettingsForm.cs` 与 `MainForm.cs`
- **`src/Core/AgentSession.cs`**：
  - 新增 `public event Action<string> AssistantDelta;` 事件；
  - 在 `RunTaskAsync` 中，若当前引擎为启用原生工具的 `IToolChatEngine`，走结构化循环：当 `turn.ToolCalls.Count == 0` 时直接完成本轮对话（原生工具模式下，模型不再返回 `tool_calls` 即代表本轮回答完毕，无需强求 `[TASK_DONE]` 标记，避免无意义催促！）；当 `turn.ToolCalls.Count > 0` 时逐个审批、执行本机工具或 MCP 工具，组装完整 `List<ToolCallResponse>` 进入下一轮，并同步记录到 `.eagentx\session-*.md` 审计轨迹。
- **`src/Ui/MainForm.cs`**：订阅 `AssistantDelta`，使用 70ms `Timer` 缓冲合并增量文本并实时追加到 `LogBox` 当前助手回复块。
- **`src/Ui/SettingsForm.cs`**：
  - 在「API 模式」区域增加 3 个复选框：`启用原生 Tool Calling（推荐）`、`启用流式逐字输出（SSE）`、`模型支持视觉图片输入（Vision）`；
  - 新增第 3 个页签 **「MCP 工具」**：支持可视化粘贴/编辑 `mcpServers` JSON 配置、一键「测试连接并列出工具」按钮。

---

## 4. 测试与验收方案

1. **新增 C# 离线单元测试（独立文件 `src/SelfTest.NativeTools.cs`，使用 `partial class SelfTest`）**：
   - **本地 Loopback HTTP Mock 测试**：用 `.NET Framework` 内置 `TcpListener`（监听随机本地端口 `127.0.0.1:0`，无需管理员权限）模拟一个真实的 OpenAI SSE 流式端点：
     - 第 1 轮分 5 个 SSE chunk 流式下发 `delta.content` + **2 个分片 `delta.tool_calls`**（例如同时调 `run_powershell` 和 `list_skills`）；
     - 断言 `ApiEngine` 正确拼合分片 JSON 参数、`AgentSession` 顺序执行两个工具并在第 2 轮请求体中完整带上 2 条匹配的 `role: "tool"` + `tool_call_id`；
     - 第 2 轮流式返回最终总结文本，会话正常结束，且 `AssistantDelta` 收到完整流式片段。
   - **MCP JSON-RPC 离线闭环测试**：用本地 Loopback HTTP 服务（或微型子进程脚本）模拟 MCP Server，验证 `initialize` -> `tools/list` -> 命名空间映射 `mcp__demo__echo` -> `tools/call` 全链路返回正确。
   - **UTF-8 无 BOM 编码断言**：验证 `McpClient` 写出首字节不含 `0xEF 0xBB 0xBF`。
2. **语法与构建验收**：
   - 运行 C# 5 语法扫描脚本确保零 C# 6+ 语法；
   - 在 Windows 环境运行 `.\build.ps1` 实现 **0 警告 0 错误**，`.\dist\EAgentX.exe --selftest` 包含原有 22 项 + 新增原生工具/SSE/MCP 测试全部 PASS。

---

## 5. 改动文件边界汇总

| 操作 | 文件路径 | 说明 |
| :--- | :--- | :--- |
| 新增 | `src/Engines/IToolChatEngine.cs` | 原生工具调用与流式增量契约（向下兼容 `IChatEngine`） |
| 新增 | `src/Core/BuiltInToolSchemas.cs` | 内置 5 大本机工具 + 技能查询工具的 JSON Schema 与分发器 |
| 新增 | `src/Mcp/McpConfig.cs` | `mcp.json` 配置读写（兼容标准 `mcpServers` 格式） |
| 新增 | `src/Mcp/McpClient.cs` | 零依赖 Stdio（无 BOM UTF-8）与 HTTP JSON-RPC 2.0 MCP 客户端 |
| 新增 | `src/Mcp/McpManager.cs` | 多 MCP Server 生命周期、工具名合法化映射与统一调用 |
| 新增 | `src/SelfTest.NativeTools.cs` | SSE 分片 Tool Call 聚合、多 `tool_call_id` 回传、MCP 握手离线自检 |
| 修改 | `src/Engines/IChatEngine.cs` | 补充 `ResetAsync` 接口方法 |
| 修改 | `src/Engines/WebEngine.cs` | 仅声明实现已有的 `ResetAsync`（改动 0 业务逻辑） |
| 修改 | `src/Engines/ApiEngine.cs` | 支持原生 `tools`、SSE 流式 chunk 聚合、`VisionEnabled` 控制 |
| 修改 | `src/Core/AgentSession.cs` | 支持 `IToolChatEngine` 多工具循环与 `AssistantDelta` 事件 |
| 修改 | `src/Util/Settings.cs` | 新增 `ApiNativeTools`、`ApiStream`、`ApiVisionEnabled` 配置项 |
| 修改 | `src/Ui/SettingsForm.cs` | 增加 API 原生工具/流式/视觉开关及「MCP 工具」配置页签 |
| 修改 | `src/Ui/MainForm.cs` | 接入 `AssistantDelta` 70ms 节流流式渲染与 `Session.ResetAsync` |
| 修改 | `src/SelfTest.cs` | 标为 `partial class` 并挂载 `RunNativeToolTests(r)` |
