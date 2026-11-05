# 方案一实施计划：改造 `EAgentX` 支持多站点 CDP 网页引擎（含 `arena.ai`）

> **适用分支**：分支 1（建议命名示例：`feat/multi-site-web-engine`）
> **目标形态**：保留 `EAgentX` 零依赖 Windows 单文件 `.exe` 形态，解耦当前写死在源码里的 DeepSeek 域名与 DOM 特征，引入**可插拔站点预设适配器（Site Profile）**，原生支持 `Arena.ai`（普通对话页）、`DeepSeek`、`ChatGPT`、`Kimi` 与 `Custom` 自定义站点。
> **与其它分支隔离约定**：仅修改 Web/CDP 相关模块及 `Settings` / `SettingsForm` 站点预设项；不动 `ApiEngine`、不新增外部依赖。

---

## 1. 背景与现状问题定位（基于当前仓库源码）

虽然 `src/Util/Selectors.cs` 暴露了 5 个 CSS 选择器配置，但当前源码中有 **8 处写死了 DeepSeek 逻辑**，导致只改设置里的 `StartUrl` 无法连接 `https://arena.ai` 或其它网页大模型：

1. **`src/Engines/WebEngine.cs`（第 18 行与第 585 行）**：存在近 250 行重复的 JS 字符串（`private const string Helper` 为未使用的死代码，`BuildHelper()` 内又复制了一份完整 JS），维护极易出错。
2. **`src/Engines/WebEngine.cs`（`EnsureStartUrlAsync`，第 253–285 行）**：硬编码判断 `href.IndexOf("deepseek.com") >= 0`；若 `StartUrl` 设为 `https://arena.ai/?mode=direct`，每次连接都会误判“不在目标站”，强行跳转并空等 60 秒循环。
3. **`src/Engines/WebEngine.cs`（注入脚本 `window.__eagentx`）**：
   - `E.msgCount`、`E.userSent`、`E.latestReply`、`E.replyState`、`E.rateLimit` 全部写死 `.ds-message` 与 `.ds-markdown`；
   - `E.generating` 写死 `.ds-button--primary` 及 DeepSeek 专属 SVG path（停止方块 `M2 4.88`、发送箭头 `M8.3125`）；
   - `E.rateLimit` 仅检测中文文案（`消息发送过于频繁`），无法识别 `arena.ai` 等英文站点的配额耗尽（`daily limit` / `rate limit` / `too many requests`）。
4. **`src/Engines/WebEngine.cs`（`StartAsync` / `WaitForLoginAsync`，第 120–190 行）**：仅检测密码框 `input[type='password']` 或 `/login` URL，遇到 `arena.ai` 的 **Cloudflare Turnstile 人机校验** 或 **服务条款弹窗（Accept Terms Modal）** 时会直接抛异常“找不到输入框”，不给用户点击通过的时间。
5. **`src/Net/EdgeLauncher.cs`（`PickChat`，第 200 行）**：写死优先匹配 `deepseek.com` 标签页。
6. **`src/Engines/WebEngine.cs`（第 111 行）、`src/Ui/MainForm.cs`（第 638、1520 行）、`src/SelfTest.cs`（第 1113、1258 行）**：窗口查找 `Win32.FindBrowserWindow(..., "DeepSeek")` 与状态栏文案全部写死 `"DeepSeek"`。
7. **`src/Ui/MainForm.cs`（`NewSessionAsync`，第 1087–1121 行）既有 Bug**：点「新建会话」调用 `web.ResetAsync()` 让浏览器开了新对话，但**没有重置 `AgentSession.HasRun = false`**，导致第二段新对话首条消息只发 `"【新任务】..."` 而丢失整段系统提示词！
8. **`arena.ai` 站点专属陷阱（审查重点）**：
   - **双 Agent 抢工具冲突**：若用户打开的是 `https://arena.ai/agent`（云端 Agent Mode），云端模型自带 Linux Bash 沙箱工具，收到 `EAgentX` 的 Windows PowerShell 提示词后会试图在云端容器里跑 Windows 命令导致报错。默认必须引导至 **`https://arena.ai/?mode=direct`（Direct 纯对话模式）**，并在检测到 `/agent` 路径时给出显式告警或桥接提示词。
   - **Battle / Side-by-Side 双栏回复干扰**：`arena.ai` 默认首页是双模型盲测（左右两栏同时生成回复）。若 DOM 提取器只取最后一个 Markdown 节点，会在左右栏之间跳变或提前截断。

---

## 2. 硬性技术约束（必读）

1. **严格遵守 C# 5 语法**：`EAgentX.csproj` 指定 `<LangVersion>5</LangVersion>`，`build.ps1` 使用 `/langversion:5` 兼容 Windows 自带 `v4.0.30319\csc.exe`。
   - **严禁使用**：`?.` 空条件、`$"..."` 字符串插值、`nameof()`、`out int x` 内联声明、`using var`、表达式体方法 `=>`、`Array.Empty<T>()`。
2. **零外部 NuGet 依赖**：仅使用项目已引用的 `.NET Framework` 系统程序集与 `EAgentX.Util.Json`。
3. **配置向后兼容**：旧版 `config.json` 没有新增字段时，`Settings.Load()` + `Normalize()` 必须平滑回落到 `deepseek` 预设，不破坏老用户配置。

---

## 3. 架构与模块改造清单

### 步骤 1：新增站点预设模型 `src/Util/WebSiteProfile.cs`
定义站点适配器数据结构 `WebSiteProfile` 与内置注册表 `WebSiteRegistry`：

- **字段设计**：
  - `Id`：`deepseek`（默认） | `arena` | `chatgpt` | `kimi` | `custom`
  - `DisplayName`：如 `"Arena.ai 网页版（Direct 模式）"`、`"DeepSeek 网页版"`
  - `DefaultStartUrl`：
    - `deepseek` -> `https://chat.deepseek.com/`
    - `arena` -> `https://arena.ai/?mode=direct`
    - `chatgpt` -> `https://chatgpt.com/`
    - `kimi` -> `https://kimi.moonshot.cn/`
  - `HostKeywords`：域名匹配数组（优先从当前 `Settings.StartUrl` 解析 `Uri.Host` 动态匹配，此项作兜底，如 `new string[] { "arena.ai", "lmarena.ai" }`）
  - `WindowTitleKeyword`：用于 `Win32.FindBrowserWindow` 兜底（如 `"Arena"`、`"DeepSeek"`、`"ChatGPT"`、`"Kimi"`）
  - **扩展选择器 `Selectors`（向后兼容扩展 `src/Util/Selectors.cs`）**：
    在原有 `Input`、`Send`、`Reply`、`Generating`、`Login` 5 项基础上，补充可选高级字段（为空时走通用启发式）：
    - `MessageItem`：单条消息外层容器（DeepSeek 为 `.ds-message`；Arena/通用可配 `[data-message-id], [data-testid*='message'], article` 或留空直接按 `Reply` 容器列表计数）
    - `ActionBar`：回复完成后的底部动作栏选择器（复制/重生成/点赞按钮，如 `button[aria-label*='Copy'], button[aria-label*='复制']`）
    - `Challenge`：人机验证/弹窗遮罩选择器（`iframe[src*='challenges.cloudflare.com'], #challenge-running, [id*='turnstile']`）
    - `RateLimitPatterns`：逗号分隔的限流关键词（中英文兼顾：`消息发送过于频繁,请求过于频繁,发送太频繁,rate limit,too many requests,daily limit,usage limit`）
    - `SingleColumnInMultiView`：`bool`（在 `arena` 预设下开启：当同一轮检测到左右并排的 2 个可见回复栏时，固定锁定左侧第一栏提取文本，同时等待所有生成指示器结束）。

### 步骤 2：重构 `src/Engines/WebEngine.cs` 与注入脚本
1. **删除重复死代码**：移除第 18 行未使用的 `private const string Helper` 常量，统一由独立的 JS 模板构建器生成 `window.__eagentx`（版本号升至 `v: 11`）。
2. **重写 `window.__eagentx` 为站点无关 + 预设增强的双层策略**：
   - **消息与回复提取（去 `.ds-message` 硬编码）**：
     - 若配置了 `cfg.messageItem` 且页面命中，则按消息流倒序查找助手回复；
     - 否则直接基于 `E.replies()`（去重嵌套后的可见 `cfg.reply` 容器列表）工作：记录发送前 `beforeReplyCount` 与最后一条回复摘要 `beforeLastText`；当 `replies.length > beforeReplyCount`（或最后一条回复文本变化且不等于用户刚发的文本）时提取最新回复。
     - **Arena 并排双栏消歧**：当 `cfg.singleColumn` 为真时，计算最后两个可见回复节点的 `getBoundingClientRect()`；若两者垂直位置重叠（`|topA - topB| < 80` 且水平不重叠 `leftB > rightA - 20`），判定为 Battle/Side-by-Side 并排双栏，始终取 `left` 较小的左栏序列化输出，避免左右跳变。
   - **生成状态判定 `E.generating()`**：
     - 仅在 `siteId === 'deepseek'` 时保留 `.ds-button--primary` 的专属 SVG path 判定；
     - 通用路径检查 `E.first(cfg.generating)`、可见按钮的 `aria-label` / `title` / `data-testid` 匹配 `/stop|停止|中止|cancel|streaming/i`、以及 `[data-streaming='true'], .result-streaming`。
   - **人机校验与同意弹窗诊断 `E.diag()`**：
     - 新增返回 `challenge: bool`（命中 Cloudflare Turnstile）与 `routeWarning: string`（例如在 `arena.ai` 下检测到 `location.pathname.indexOf('/agent') === 0` 时返回告警：`"当前处于 Arena Agent Mode（自带云端沙箱），建议切换到 https://arena.ai/?mode=direct 普通对话模式以避免工具冲突"`）。
3. **动态域名跳转与等待登录/验证改造**：
   - `EnsureStartUrlAsync`：使用 `Uri.TryCreate(S.StartUrl, UriKind.Absolute, out targetUri)` 提取目标主域名（如 `arena.ai`），只要当前页面同属该主域名即视为在目标站，不再写死 `deepseek.com`。
   - `StartAsync` & `WaitForLoginAsync`：当 `diag` 检测到登录页 **或** `challenge == true`（Cloudflare 验证）时，进入最多 120 秒轮询等待，并在日志提示用户在打开的浏览器里完成登录或点击人机验证/同意条款。
   - 若检测到 `arena.ai/agent` 路径，在日志与诊断信息中输出清晰提示（但若页面有输入框仍允许运行，同时可在 `PromptBuilder` 注入一行本机优先声明，防止云端误调 bash）。

### 步骤 3：改造 `src/Net/EdgeLauncher.cs` 与窗口匹配
- `EdgeLauncher.PickChat`：从 `S.StartUrl` 提取目标域名（去掉 `www.` 比较），优先匹配目标域名的标签页；提示文案改为 `"等待目标网页超时，请确认浏览器已打开 " + S.StartUrl`。
- `WebEngine.IsOurBrowserWindow` / `MainForm.ToggleEmbed` / `SelfTest`：将写死的 `"DeepSeek"` 替换为 `WebSiteRegistry.Current(S).WindowTitleKeyword`。

### 步骤 4：修复「新建会话」丢失系统提示词的既有 Bug
- 在 `src/Engines/IChatEngine.cs` 增加 `Task ResetAsync(CancellationToken ct);`（`WebEngine` 已有该方法直接实现接口；`ApiEngine` 实现为清空 `Messages` 并重新写入 `PromptBuilder.System(S)`）。
- 在 `src/Core/AgentSession.cs` 增加 `public async Task ResetAsync(CancellationToken ct)`：重置 `HasRun = false`、`ContinueNudges = 0`、`PendingAttachments = null`，新建会话轨迹文件头，并调用 `await Engine.ResetAsync(ct)`。
- 在 `src/Ui/MainForm.cs` 的 `NewSessionAsync` 中统一调用 `await Task.Run(() => Session.ResetAsync(Cts.Token))`，彻底修复网页版和 API 版新建会话的状态残留问题。

### 步骤 5：更新配置与 UI（`Settings.cs`、`SettingsForm.cs`、`MainForm.cs`）
- `src/Util/Settings.cs`：新增 `public string WebSite { get; set; }`（默认 `"deepseek"`；当旧配置 `WebSite` 为空时，按 `StartUrl` 自动推断或回落 `"deepseek"`）。切换站点预设时自动填充对应的 `StartUrl` 与 `Selectors`（`custom` 模式保留用户手填值）。
- `src/Ui/SettingsForm.cs`：在「常规 → 运行方式」新增 `网页站点` 下拉框（`DeepSeek 网页版` / `Arena.ai (Direct 对话)` / `ChatGPT 网页版` / `Kimi 网页版` / `自定义网页`），选择预设时联动刷新 `StartUrlBox` 和「高级」页签里的选择器框。
- `src/Ui/MainForm.cs`：顶部副标题与底部状态栏 `LblEngine` 根据当前站点预设动态展示名称（不再写死 `"DeepSeek 桌面智能体"`）。

---

## 4. 测试与验收方案（兼顾 Windows 本机与 Linux 云端环境）

1. **新增 C# 离线单元测试（独立文件 `src/SelfTest.WebSites.cs`，将 `SelfTest` 标为 `partial class` 降低合并冲突）**：
   - 测试 1：验证 `deepseek` / `arena` / `chatgpt` / `kimi` / `custom` 五种 `WebSiteProfile` 的默认 URL、域名提取与 `Settings` JSON 序列化/旧版配置兼容反序列化。
   - 测试 2：验证 `AgentSession.ResetAsync()` 调用后 `HasRun` 正确归零，下一轮任务重新携带完整 `PromptBuilder.FirstTask` 系统提示词。
   - 测试 3：验证 `BuildHelper()` 注入配置后的 JS 脚本无未替换占位符、语法合法。
2. **新增可离线运行的 DOM 模拟测试 `tools/test-web-helper.mjs`（Node.js 脚本）**：
   - 在无界面的 Linux 容器或 CI 环境中，构造模拟 DOM 树分别测试：
     - DeepSeek 消息树（`.ds-message` + `.ds-markdown` + 停止方块 SVG）；
     - Arena.ai Direct 单栏对话 DOM + Battle 并排双栏 DOM（验证左栏锁定不跳变）+ `/agent` 路由告警 + Cloudflare Turnstile 检测 + `<pre><code class="language-powershell_tool">` 代码块反向序列化为 Markdown 围栏。
3. **C# 5 语法合规扫描脚本 `tools/verify-cs5.py`**：
   - 在没有 `csc.exe` 的 Linux 环境中自动扫描 `src/**/*.cs`，确保未误引入 `?.`、`$"..."`、`nameof(`、`out var` 等 C# 6+ 语法；在 Windows 环境下运行 `powershell -File .\build.ps1` 实现 **0 警告 0 错误**，且 `.\dist\EAgentX.exe --selftest` 全绿通过。

---

## 5. 改动文件边界汇总

| 操作 | 文件路径 | 说明 |
| :--- | :--- | :--- |
| 新增 | `src/Util/WebSiteProfile.cs` | 多站点预设定义与 URL/域名解析辅助 |
| 新增 | `src/SelfTest.WebSites.cs` | 多站点配置与会话重置离线自检（`partial class SelfTest`） |
| 新增 | `tools/test-web-helper.mjs` | `window.__eagentx` 多站点 DOM 提取与双栏消歧离线测试 |
| 新增 | `tools/verify-cs5.py` | C# 5 语法静态守卫脚本 |
| 修改 | `src/Util/Selectors.cs` | 扩展可选选择器字段并保持旧字段兼容 |
| 修改 | `src/Util/Settings.cs` | 新增 `WebSite` 字段与预设联动归一化 |
| 修改 | `src/Engines/IChatEngine.cs` | 补充 `ResetAsync` 接口契约 |
| 修改 | `src/Engines/ApiEngine.cs` | 实现 `ResetAsync`（仅 ~6 行，修复新建会话不清空历史） |
| 修改 | `src/Engines/WebEngine.cs` | 移除重复死代码，接入 `WebSiteProfile`、动态域名、人机验证等待 |
| 修改 | `src/Net/EdgeLauncher.cs` | 按 `StartUrl` 动态域名挑选标签页 |
| 修改 | `src/Core/AgentSession.cs` | 新增 `ResetAsync` 修复新会话丢失系统提示词问题 |
| 修改 | `src/Ui/SettingsForm.cs` | 新增「网页站点」下拉框与选择器联动 |
| 修改 | `src/Ui/MainForm.cs` | 动态品牌/状态栏站点名、`NewSessionAsync` 调用 `Session.ResetAsync` |
| 修改 | `src/SelfTest.cs` | 类声明加 `partial` 并在 `Run()` 末尾调用 `RunWebSiteTests(r)` |
