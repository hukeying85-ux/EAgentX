using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using EAgentX.Core;
using EAgentX.Engines;
using EAgentX.Mcp;
using EAgentX.Util;

namespace EAgentX
{
	/// <summary>
	/// 方案三的离线自检：SSE 分片 tool_calls 聚合、多 tool_call_id 一一回传、MCP JSON-RPC 握手与无 BOM stdio。
	/// 全部走 127.0.0.1 的 TcpListener 假服务端，不联网、不需要管理员权限、不弹窗。
	/// </summary>
	public static partial class SelfTest
	{
		/// <summary>被 AgentSession.RunNativeTaskAsync 调用的入口（由 SelfTest.Run 挂载）。</summary>
		private static void RunNativeToolTests(Runner r)
		{
			RunNativeToolChecks(r.Check, r.Info);
		}

		public delegate void CheckDelegate(string name, Action test);

		public delegate void InfoDelegate(string name, string detail);

		public static void RunNativeToolChecks(CheckDelegate check, InfoDelegate info)
		{
			check("SSE 分片 tool_calls 聚合", delegate
			{
				string stream = BuildSseStream();
				ChatStreamParser.StreamState state = new ChatStreamParser.StreamState();
				StringBuilder deltas = new StringBuilder();
				List<string> events = SseReader.Split(stream);
				for (int i = 0; i < events.Count; i++)
				{
					if (!ChatStreamParser.ApplyChunk(events[i], state, delegate(string d) { deltas.Append(d); }, null))
					{
						break;
					}
				}
				ChatTurnResponse turn = ChatStreamParser.Complete(state);
				Assert(turn.ToolCalls.Count == 2, "应聚合出 2 个 tool_calls，实际 " + turn.ToolCalls.Count);
				Assert(turn.ToolCalls[0].Name == BuiltInToolSchemas.RunPowerShell, "第 1 个工具名错: " + turn.ToolCalls[0].Name);
				Assert(turn.ToolCalls[1].Name == BuiltInToolSchemas.ListSkills, "第 2 个工具名错: " + turn.ToolCalls[1].Name);
				Assert(turn.ToolCalls[0].ArgumentsJson == "{\"command\": \"Write-Output hello\", \"description\": \"demo\"}", "第 1 个参数没有跨分片拼齐: " + turn.ToolCalls[0].ArgumentsJson);
				Assert(turn.ToolCalls[1].ArgumentsJson == "{\"keyword\": \"pdf\"}", "第 2 个参数没有跨分片拼齐: " + turn.ToolCalls[1].ArgumentsJson);
				Assert(turn.Content == "我先看一下。", "正文增量聚合失败: " + turn.Content);
				Assert(deltas.ToString() == "我先看一下。", "流式增量回调内容不一致: " + deltas);
			});

			check("chat/SSE 请求解析", delegate
			{
				string body = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"好的\",\"tool_calls\":[{\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"list_skills\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}";
				ChatTurnResponse turn = ChatStreamParser.ParseResponse(body);
				Assert(turn.ToolCalls.Count == 1 && turn.ToolCalls[0].Id == "call_a", "普通 JSON 的 tool_calls 解析失败");
				Assert(turn.Content == "好的", "普通 JSON 正文解析失败");
			});

			check("无 BOM UTF-8 编码", delegate
			{
				byte[] written;
				using (MemoryStream buffer = new MemoryStream())
				{
					using (StreamWriter writer = McpClient.CreateStdioWriter(buffer))
					{
						writer.WriteLine("{\"jsonrpc\":\"2.0\"}");
						writer.Flush();
						written = buffer.ToArray();
					}
				}
				Assert(written.Length > 3, "没有写出内容");
				Assert(!(written[0] == 0xEF && written[1] == 0xBB && written[2] == 0xBF), "stdio 写入流带了 UTF-8 BOM（会让 Node/Python MCP Server 首行 JSON 解析崩溃）");
				Assert(written[0] == (byte)'{', "首字节不是 {，说明前面有额外内容: 0x" + written[0].ToString("X2"));
				// 兜底说明：.NET Framework 的 Encoding.UTF8 确实会写 BOM，所以这里顺便记录差异
				using (MemoryStream legacy = new MemoryStream())
				{
					using (StreamWriter writer = new StreamWriter(legacy, Encoding.UTF8))
					{
						writer.Write("x");
						writer.Flush();
						byte[] raw = legacy.ToArray();
						Assert(raw.Length >= 3 && raw[0] == 0xEF, "Encoding.UTF8 未写 BOM（测试前提站不住，但 McpClient 仍按无 BOM 实现）");
					}
				}
			});

			check("MCP 命名空间映射", delegate
			{
				Assert(McpManager.Qualify("filesystem", "read_file") == "mcp__filesystem__read_file", "命名空间映射错误");
				Assert(McpManager.Qualify("my server!", "do.something#1") == "mcp__my_server___do_something_1", "非法字符没有被替换: " + McpManager.Qualify("my server!", "do.something#1"));
				string[] parts = McpManager.Split("mcp__filesystem__read_file");
				Assert(parts != null && parts[0] == "filesystem" && parts[1] == "read_file", "命名空间拆分失败");
				string longName = McpManager.Qualify("a-very-long-server-name-that-keeps-going", "a-very-long-tool-name-that-also-keeps-going-and-going");
				Assert(longName.Length <= 64, "函数名超过 64 字符: " + longName.Length);
			});

			check("内置工具 Schema", delegate
			{
				Settings settings = new Settings();
				string sandbox = Path.Combine(Path.GetTempPath(), "eagentx-native-" + DateTime.Now.ToString("HHmmssfff"));
				Directory.CreateDirectory(sandbox);
				try
				{
					List<ToolDefinition> tools = BuiltInToolSchemas.Build(settings, sandbox);
					for (int i = 0; i < tools.Count; i++)
					{
						string name = tools[i].Name;
						Assert(name.Length <= 64, "工具名过长: " + name);
						for (int j = 0; j < name.Length; j++)
						{
							char c = name[j];
							bool legal = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
							Assert(legal, "工具名含非法字符: " + name);
						}
						Dictionary<string, object> api = tools[i].ToApiFormat();
						Assert(api.ContainsKey("type") && api.ContainsKey("function"), "tools 序列化缺少字段: " + name);
						Dictionary<string, object> schema = Json.Obj(tools[i].ParametersSchema);
						Assert(schema != null && "object".Equals(Json.GetStr(schema, "type")), "参数 Schema 不是 object: " + name);
						Dictionary<string, object> props = Json.Obj(Json.Get(schema, "properties"));
						Assert(props != null, "参数 Schema 缺少 properties: " + name);
						foreach (KeyValuePair<string, object> property in props)
						{
							Dictionary<string, object> body = Json.Obj(property.Value);
							Assert(Json.Get(body, "__name") == null, "Schema 泄漏了内部键 __name: " + name);
							Assert(Json.GetStr(body, "type") != null, "参数缺少 type: " + name + "." + property.Key);
						}
					}
					Assert(tools.Count >= 5, "内置工具数量过少: " + tools.Count);
					Settings noTools = new Settings();
					noTools.EnableTools = false;
					List<ToolDefinition> reduced = BuiltInToolSchemas.Build(noTools, sandbox);
					Assert(reduced.Count < tools.Count, "关闭扩展工具后工具列表没有变短");
					for (int i = 0; i < reduced.Count; i++)
					{
						Assert(reduced[i].Name != BuiltInToolSchemas.MouseClick, "关闭扩展工具后仍暴露 mouse_click");
					}
					info("内置工具", tools.Count + " 个（关闭扩展工具后 " + reduced.Count + " 个）");
				}
				finally
				{
					try
					{
						Directory.Delete(sandbox, true);
					}
					catch
					{
					}
				}
			});

			check("MCP HTTP 握手闭环", delegate
			{
				MockMcpServer server = new MockMcpServer();
				server.Start();
				try
				{
					McpServerEntry entry = new McpServerEntry();
					entry.Name = "demo";
					entry.Transport = "http";
					entry.Url = "http://127.0.0.1:" + server.Port + "/mcp";
					using (McpClient client = new McpClient(entry))
					{
						List<McpToolInfo> tools = client.ConnectAsync(CancellationToken.None).Result;
						Assert(tools.Count == 1 && tools[0].Name == "echo", "tools/list 结果不对: " + tools.Count);
						McpCallResult call = client.CallToolAsync("echo", "{\"text\":\"你好\"}", CancellationToken.None).Result;
						Assert(!call.IsError, "tools/call 报了错误: " + call.Text);
						Assert(call.Text == "echo:你好", "tools/call 文本结果不对: " + call.Text);
					}
					Assert(server.Requests.Count >= 3, "握手应至少发出 3 次请求（initialize / notifications/initialized / tools/list），实际 " + server.Requests.Count);
					// 顺序必须严格是 initialize → notifications/initialized → tools/list
					// （少数运行时会因为 keep-alive 复用多发一次 initialize，这里只校验前三条的业务顺序）
					List<string> methods = new List<string>();
					for (int i = 0; i < server.Requests.Count; i++)
					{
						Dictionary<string, object> body = Json.Obj(Json.Decode(server.Requests[i]));
						methods.Add(Json.GetStr(body, "method") ?? "");
					}
					Assert(methods[0] == "initialize", "第 1 个请求不是 initialize: " + string.Join(",", methods.ToArray()));
					Assert(methods[1] == "notifications/initialized", "第 2 个请求不是 notifications/initialized: " + string.Join(",", methods.ToArray()));
					Assert(methods[2] == "tools/list", "第 3 个请求不是 tools/list: " + string.Join(",", methods.ToArray()));
				}
				finally
				{
					server.Stop();
				}
			});

			check("MCP 管理器工具注入", delegate
			{
				MockMcpServer server = new MockMcpServer();
				server.Start();
				McpManager manager = new McpManager();
				try
				{
					McpServerEntry entry = new McpServerEntry();
					entry.Name = "demo";
					entry.Transport = "http";
					entry.Url = "http://127.0.0.1:" + server.Port + "/mcp";
					entry.RequireApproval = false;
					List<McpServerEntry> entries = new List<McpServerEntry>();
					entries.Add(entry);
					string report = manager.LoadAndConnectAsync(entries, CancellationToken.None).Result;
					Assert(manager.ConnectedCount == 1, "没有连上 Mock Server: " + report);
					Assert(manager.IsMcpTool("mcp__demo__echo"), "工具没有按 mcp__demo__echo 注入: " + report);
					List<ToolDefinition> tools = manager.ToolDefinitions();
					Assert(tools.Count == 1 && tools[0].Name == "mcp__demo__echo", "ToolDefinition 注入结果不对");
					Assert(tools[0].ParametersSchema != null && "object".Equals(Json.GetStr(tools[0].ParametersSchema, "type")), "MCP 工具的 inputSchema 没有透传");
					McpCallResult call = manager.CallAsync("mcp__demo__echo", "{\"text\":\"abc\"}", CancellationToken.None).Result;
					Assert(call.Text == "echo:abc", "MCP 工具调用结果不对: " + call.Text);
					info("MCP", report.Replace("\r\n", " | "));
				}
				finally
				{
					manager.Dispose();
					server.Stop();
				}
			});

			check("MCP 配置读写", delegate
			{
				List<McpServerEntry> servers = McpConfig.Parse(McpConfig.SampleJson);
				Assert(servers.Count == 2, "示例配置应解析出 2 个 Server，实际 " + servers.Count);
				McpServerEntry fs = null;
				McpServerEntry http = null;
				for (int i = 0; i < servers.Count; i++)
				{
					if (servers[i].Name == "filesystem")
					{
						fs = servers[i];
					}
					if (servers[i].Name == "demo-http")
					{
						http = servers[i];
					}
				}
				Assert(fs != null && !fs.IsHttp && fs.Command == "npx" && fs.Args.Count == 3, "stdio Server 解析失败");
				Assert(fs.RequireApproval, "requireApproval 默认值应为 true");
				Assert(http != null && http.IsHttp && !http.Enabled, "http Server 解析失败");
				string roundTrip = McpConfig.ToJson(servers);
				List<McpServerEntry> again = McpConfig.Parse(roundTrip);
				Assert(again.Count == 2, "序列化再解析后 Server 数量变了");
				Dictionary<string, object> root = Json.Obj(Json.Decode(roundTrip));
				Assert(Json.Obj(Json.Get(root, "mcpServers")) != null, "序列化结果缺少 mcpServers 根节点");
				Assert(roundTrip.IndexOf("\r\n", StringComparison.Ordinal) > 0, "序列化结果没有换行（不便编辑）");
			});

			check("MCP 参数转义", delegate
			{
				Assert(McpClient.BuildArguments(null) == "", "空参数应为空串");
				Assert(McpClient.BuildArguments(new List<string> { "-y", "@scope/pkg", "C:\\Users" }) == "-y @scope/pkg C:\\Users", "普通参数被错误加引号");
				Assert(McpClient.QuoteArgument("C:\\Program Files\\x") == "\"C:\\Program Files\\x\"", "带空格路径未加引号: " + McpClient.QuoteArgument("C:\\Program Files\\x"));
				Assert(McpClient.QuoteArgument("say \"hi\"") == "\"say \\\"hi\\\"\"", "内嵌引号转义错误: " + McpClient.QuoteArgument("say \"hi\""));
				Assert(McpClient.QuoteArgument("C:\\a b\\") == "\"C:\\a b\\\\\"", "结尾反斜杠转义错误: " + McpClient.QuoteArgument("C:\\a b\\"));
			});

			check("原生工具多 tool_call_id 回传", delegate
			{
				string sandbox = Path.Combine(Path.GetTempPath(), "eagentx-native-loop-" + DateTime.Now.ToString("HHmmssfff"));
				Directory.CreateDirectory(sandbox);
				// 自己造一个技能，别依赖内嵌技能包（这条用例要在没有资源包的构建里也能跑）
				string demoSkillDir = Path.Combine(sandbox, ".eagentx", "skills", "demo");
				Directory.CreateDirectory(demoSkillDir);
				File.WriteAllText(Path.Combine(demoSkillDir, "SKILL.md"), "# demo-skill\r\n把演示步骤写清楚。\r\n");
				MockChatServer server = new MockChatServer();
				server.Start();
				try
				{
					Settings settings = new Settings();
					settings.WorkDir = sandbox;
					settings.ApiBase = "http://127.0.0.1:" + server.Port + "/v1";
					settings.ApiKey = "test-key";
					settings.ApiModel = "mock-model";
					settings.ApiNativeTools = true;
					settings.ApiStream = true;
					settings.SendIntervalSec = 0;
					settings.MaxSteps = 6;
					settings.ReplyTimeoutSec = 30;
					settings.CommandTimeoutSec = 30;
					List<string> deltas = new List<string>();
					int finished = 0;
					using (ApiEngine engine = new ApiEngine(settings))
					{
						using (AgentSession session = new AgentSession(settings, engine))
						{
							session.ApproveHandler = delegate(string text) { return true; };
							session.AssistantDelta += delegate(string delta) { deltas.Add(delta); };
							session.CommandFinished += delegate(RunResult result) { finished++; };
							session.RunTaskAsync("跑两个工具", CancellationToken.None).Wait();
						}
					}
					Assert(finished == 2, "应执行 2 个工具（run_powershell + list_skills），实际 " + finished);
					Assert(server.Requests.Count == 2, "应发出 2 次请求（工具轮 + 总结轮），实际 " + server.Requests.Count);
					Dictionary<string, object> second = Json.Obj(Json.Decode(server.Requests[1]));
					List<object> messages = Json.List(Json.Get(second, "messages"));
					Assert(messages != null, "第 2 次请求里没有 messages");
					// 找到 assistant(tool_calls) 之后的两条 tool 消息
					int assistantAt = -1;
					List<string> ids = new List<string>();
					for (int i = 0; i < messages.Count; i++)
					{
						Dictionary<string, object> message = Json.Obj(messages[i]);
						string role = Json.GetStr(message, "role");
						if (role == "assistant" && Json.List(Json.Get(message, "tool_calls")) != null)
						{
							assistantAt = i;
							List<object> calls = Json.List(Json.Get(message, "tool_calls"));
							for (int j = 0; j < calls.Count; j++)
							{
								ids.Add(Json.GetStr(Json.Obj(calls[j]), "id"));
							}
						}
					}
					Assert(assistantAt >= 0, "第 2 次请求里没有带 tool_calls 的 assistant 消息");
					Assert(ids.Count == 2, "assistant 消息里应保留 2 个 tool_calls，实际 " + ids.Count);
					List<string> toolIds = new List<string>();
					for (int i = assistantAt + 1; i < messages.Count; i++)
					{
						Dictionary<string, object> message = Json.Obj(messages[i]);
						if (Json.GetStr(message, "role") != "tool")
						{
							break;
						}
						toolIds.Add(Json.GetStr(message, "tool_call_id"));
						string content = Json.GetStr(message, "content");
						Assert(content != null && content.Length > 0, "role:tool 消息内容为空（模型会以为工具什么都没做）");
					}
					Assert(toolIds.Count == 2, "应回传 2 条 role:tool 消息（漏一条就会 400），实际 " + toolIds.Count);
					Assert(toolIds[0] == ids[0] && toolIds[1] == ids[1], "tool_call_id 与 assistant.tool_calls 不匹配: " + string.Join(",", toolIds.ToArray()) + " vs " + string.Join(",", ids.ToArray()));
					// 第 2 个工具 list_skills 应真的读到技能目录里的 SKILL.md
					string skillsContent = "";
					for (int i = assistantAt + 1; i < messages.Count; i++)
					{
						Dictionary<string, object> message = Json.Obj(messages[i]);
						if (Json.GetStr(message, "role") != "tool")
						{
							break;
						}
						if (i == assistantAt + 2)
						{
							skillsContent = Json.GetStr(message, "content");
						}
					}
					Assert(skillsContent != null && skillsContent.IndexOf("- demo", StringComparison.Ordinal) >= 0, "list_skills 没有列出测试技能: " + skillsContent);
					Assert(deltas.Count > 0 && string.Join("", deltas.ToArray()).IndexOf("都做完了", StringComparison.Ordinal) >= 0, "AssistantDelta 没有收到完整流式片段");
					Assert(server.SawStreamTrue, "请求体里没有 stream:true");
					Assert(server.SawToolsArray, "请求体里没有 tools 数组");
					Assert(server.SawAuthorization, "请求缺少 Authorization 头");
					info("原生工具闭环", "2 次工具调用 → 2 条 tool 回包 → 流式总结");
				}
				finally
				{
					server.Stop();
					try
					{
						Directory.Delete(sandbox, true);
					}
					catch
					{
					}
				}
			});

			check("拒绝工具也回传 tool_call_id", delegate
			{
				string sandbox = Path.Combine(Path.GetTempPath(), "eagentx-native-deny-" + DateTime.Now.ToString("HHmmssfff"));
				Directory.CreateDirectory(sandbox);
				MockChatServer server = new MockChatServer();
				server.Start();
				try
				{
					Settings settings = new Settings();
					settings.WorkDir = sandbox;
					settings.ApiBase = "http://127.0.0.1:" + server.Port + "/v1";
					settings.ApiKey = "test-key";
					settings.ApiModel = "mock-model";
					settings.ApiNativeTools = true;
					settings.ApiStream = true;
					settings.SendIntervalSec = 0;
					settings.MaxSteps = 6;
					settings.ReplyTimeoutSec = 30;
					int denied = 0;
					using (ApiEngine engine = new ApiEngine(settings))
					{
						using (AgentSession session = new AgentSession(settings, engine))
						{
							session.ApproveHandler = delegate(string text)
							{
								denied++;
								return false;
							};
							session.RunTaskAsync("跑两个工具（会被拒绝）", CancellationToken.None).Wait();
						}
					}
					Assert(denied == 1, "只应弹 1 次审批（run_powershell 需审批，list_skills 不需要），实际 " + denied);
					Dictionary<string, object> second = Json.Obj(Json.Decode(server.Requests[1]));
					List<object> messages = Json.List(Json.Get(second, "messages"));
					int toolCount = 0;
					string deniedContent = null;
					for (int i = 0; i < messages.Count; i++)
					{
						Dictionary<string, object> message = Json.Obj(messages[i]);
						if (Json.GetStr(message, "role") == "tool")
						{
							toolCount++;
							string content = Json.GetStr(message, "content");
							if (content != null && content.IndexOf("用户拒绝执行", StringComparison.Ordinal) >= 0)
							{
								deniedContent = content;
							}
						}
					}
					Assert(toolCount == 2, "拒绝场景也必须回传 2 条 role:tool，实际 " + toolCount);
					Assert(deniedContent != null, "被拒绝的工具没有回传「用户拒绝执行」说明");
				}
				finally
				{
					server.Stop();
					try
					{
						Directory.Delete(sandbox, true);
					}
					catch
					{
					}
				}
			});
		}

		/// <summary>构造一段真实形态的 SSE 流：5 个正文 chunk + 2 个跨分片的 tool_calls。</summary>
		private static string BuildSseStream()
		{
			StringBuilder sb = new StringBuilder();
			sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"我先\"}}]}\n\n");
			sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"看一下。\"}}]}\n\n");
			sb.Append(": heartbeat\n\n");
			sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"run_powershell\",\"arguments\":\"{\\\"command\\\": \\\"Write-Out\"}}]}}]}\n\n");
			sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"put hello\\\", \\\"description\\\": \\\"demo\\\"}\"}}]}}]}\n\n");
			sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"list_skills\",\"arguments\":\"{\\\"key\"}}]}}]}\n\n");
			sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"word\\\": \\\"pdf\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n");
			sb.Append("data: [DONE]\n\n");
			return sb.ToString();
		}

		// ---------------- 假服务端 ----------------

		/// <summary>极简 HTTP 服务端（TcpListener，随机端口），供各测试写入响应体。</summary>
		private abstract class LoopbackServer
		{
			private TcpListener Listener;

			private Thread AcceptThread;

			private volatile bool Stopping;

			public int Port { get; private set; }

			public readonly List<string> Requests = new List<string>();

			/// <summary>正在处理中的连接（Stop 时统一关掉，避免 keep-alive 把线程挂住）。</summary>
			private readonly List<TcpClient> Active = new List<TcpClient>();

			protected readonly object Sync = new object();

			protected LoopbackServer()
			{
				Listener = new TcpListener(IPAddress.Loopback, 0);
			}

			public void Start()
			{
				Listener.Start();
				Port = ((IPEndPoint)Listener.LocalEndpoint).Port;
				AcceptThread = new Thread(AcceptLoop);
				AcceptThread.IsBackground = true;
				AcceptThread.Start();
			}

			public void Stop()
			{
				Stopping = true;
				// 先自连一次把阻塞在 AcceptTcpClient 的接收线程唤醒：
				// 有些运行时上「Stop() 与 Accept 同时进行」会直接卡住（.NET Core 3.1 实测），
				// 用一次空连接把 Accept 走完再关监听，任何运行时都不会挂。
				try
				{
					using (TcpClient wake = new TcpClient())
					{
						wake.Connect(IPAddress.Loopback, Port);
					}
				}
				catch
				{
				}
				try
				{
					if (AcceptThread != null)
					{
						AcceptThread.Join(1500);
					}
				}
				catch
				{
				}
				try
				{
					Listener.Stop();
				}
				catch
				{
				}
				// 关掉还在处理中的连接，避免客户端 keep-alive 把收尾线程挂住
				lock (Sync)
				{
					for (int i = 0; i < Active.Count; i++)
					{
						try
						{
							Active[i].Close();
						}
						catch
						{
						}
					}
					Active.Clear();
				}
			}

			private void AcceptLoop()
			{
				while (!Stopping)
				{
					TcpClient client = null;
					try
					{
						client = Listener.AcceptTcpClient();
					}
					catch
					{
						break;
					}
					if (Stopping)
					{
						try
						{
							client.Close();
						}
						catch
						{
						}
						break;
					}
					lock (Sync)
					{
						Active.Add(client);
					}
					try
					{
						HandleClient(client);
					}
					catch
					{
					}
					finally
					{
						lock (Sync)
						{
							Active.Remove(client);
						}
						try
						{
							client.Close();
						}
						catch
						{
						}
					}
				}
			}

			private void HandleClient(TcpClient client)
			{
				NetworkStream stream = client.GetStream();
				byte[] buffer = new byte[8192];
				MemoryStream received = new MemoryStream();
				int headerEnd = -1;
				int contentLength = 0;
				while (true)
				{
					int read = stream.Read(buffer, 0, buffer.Length);
					if (read <= 0)
					{
						return;
					}
					received.Write(buffer, 0, read);
					if (headerEnd < 0)
					{
						string soFar = Encoding.ASCII.GetString(received.ToArray());
						int found = soFar.IndexOf("\r\n\r\n", StringComparison.Ordinal);
						if (found >= 0)
						{
							headerEnd = found;
							contentLength = ParseContentLength(soFar.Substring(0, found));
						}
					}
					if (headerEnd >= 0 && received.Length >= headerEnd + 4 + contentLength)
					{
						break;
					}
				}
				byte[] raw = received.ToArray();
				string headerText = Encoding.ASCII.GetString(raw, 0, headerEnd);
				string requestBody = Encoding.UTF8.GetString(raw, headerEnd + 4, Math.Max(0, raw.Length - headerEnd - 4));
				lock (Sync)
				{
					Requests.Add(requestBody);
				}
				Respond(stream, headerText, requestBody);
			}

			private static int ParseContentLength(string headerText)
			{
				string[] lines = headerText.Replace("\r\n", "\n").Split('\n');
				for (int i = 0; i < lines.Length; i++)
				{
					string line = lines[i];
					if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
					{
						int length;
						if (int.TryParse(line.Substring(15).Trim(), out length))
						{
							return length;
						}
					}
				}
				return 0;
			}

			protected abstract void Respond(NetworkStream stream, string headerText, string body);

			protected static void WriteResponse(NetworkStream stream, int status, string contentType, string body)
			{
				byte[] bytes = new UTF8Encoding(false).GetBytes(body ?? "");
				StringBuilder header = new StringBuilder();
				header.Append("HTTP/1.1 ").Append(status).Append(" ").Append((status == 200) ? "OK" : "Error").Append("\r\n");
				header.Append("Content-Type: ").Append(contentType).Append("\r\n");
				header.Append("Content-Length: ").Append(bytes.Length).Append("\r\n");
				header.Append("Connection: close\r\n\r\n");
				byte[] headBytes = Encoding.ASCII.GetBytes(header.ToString());
				stream.Write(headBytes, 0, headBytes.Length);
				stream.Write(bytes, 0, bytes.Length);
				stream.Flush();
			}
		}

		/// <summary>假 MCP Server：initialize / notifications/initialized / tools/list / tools/call。</summary>
		private sealed class MockMcpServer : LoopbackServer
		{
			protected override void Respond(NetworkStream stream, string headerText, string body)
			{
				Dictionary<string, object> message = Json.Obj(Json.Decode(body));
				string method = Json.GetStr(message, "method") ?? "";
				object id = Json.Get(message, "id");
				if (method == "initialize")
				{
					StringBuilder sb = new StringBuilder();
					sb.Append("{\"jsonrpc\":\"2.0\",\"id\":").Append(Json.Encode(id));
					sb.Append(",\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"mock-mcp\",\"version\":\"0.1\"}}}");
					WriteResponse(stream, 200, "application/json", sb.ToString());
					return;
				}
				if (method == "notifications/initialized")
				{
					WriteResponse(stream, 202, "application/json", "");
					return;
				}
				if (method == "tools/list")
				{
					StringBuilder sb = new StringBuilder();
					sb.Append("{\"jsonrpc\":\"2.0\",\"id\":").Append(Json.Encode(id));
					sb.Append(",\"result\":{\"tools\":[{\"name\":\"echo\",\"description\":\"回显文本\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}}]}}");
					WriteResponse(stream, 200, "application/json", sb.ToString());
					return;
				}
				if (method == "tools/call")
				{
					Dictionary<string, object> parameters = Json.Obj(Json.Get(message, "params"));
					Dictionary<string, object> arguments = Json.Obj(Json.Get(parameters, "arguments"));
					string text = Json.GetStr(arguments, "text") ?? "";
					StringBuilder sb = new StringBuilder();
					sb.Append("{\"jsonrpc\":\"2.0\",\"id\":").Append(Json.Encode(id));
					sb.Append(",\"result\":{\"content\":[{\"type\":\"text\",\"text\":").Append(Json.Encode("echo:" + text)).Append("}],\"isError\":false}}");
					WriteResponse(stream, 200, "application/json", sb.ToString());
					return;
				}
				StringBuilder error = new StringBuilder();
				error.Append("{\"jsonrpc\":\"2.0\",\"id\":").Append(Json.Encode(id));
				error.Append(",\"error\":{\"code\":-32601,\"message\":\"method not found\"}}");
				WriteResponse(stream, 200, "application/json", error.ToString());
			}
		}

		/// <summary>
		/// 假 Chat Completions 端点：
		///   第 1 次请求 → SSE 流式返回 2 个 tool_calls（run_powershell + list_skills）；
		///   第 2 次请求 → SSE 流式返回最终总结文本。
		/// </summary>
		private sealed class MockChatServer : LoopbackServer
		{
			public volatile bool SawStreamTrue;

			public volatile bool SawToolsArray;

			public volatile bool SawAuthorization;

			private int Count;

			protected override void Respond(NetworkStream stream, string headerText, string body)
			{
				int index;
				lock (Sync)
				{
					index = Count;
					Count++;
				}
				if (body.IndexOf("\"stream\":true", StringComparison.Ordinal) >= 0)
				{
					SawStreamTrue = true;
				}
				if (body.IndexOf("\"tools\":[", StringComparison.Ordinal) >= 0)
				{
					SawToolsArray = true;
				}
				if (headerText.IndexOf("Authorization: Bearer", StringComparison.OrdinalIgnoreCase) >= 0)
				{
					SawAuthorization = true;
				}
				if (index == 0)
				{
					StringBuilder sb = new StringBuilder();
					sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"好的，\"}}]}\n\n");
					sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"我先跑两个工具。\"}}]}\n\n");
					sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_ps\",\"type\":\"function\",\"function\":{\"name\":\"run_powershell\",\"arguments\":\"{\\\"command\\\":\\\"Write-Output hi\\\",\\\"descr\"}}]}}]}\n\n");
					sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"iption\\\":\\\"echo hi\\\"}\"}}]}}]}\n\n");
					sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_skills\",\"type\":\"function\",\"function\":{\"name\":\"list_skills\",\"arguments\":\"{}\"}}]}}]}\n\n");
					sb.Append("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n");
					sb.Append("data: [DONE]\n\n");
					WriteResponse(stream, 200, "text/event-stream", sb.ToString());
					return;
				}
				StringBuilder final = new StringBuilder();
				final.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"两个工具\"}}]}\n\n");
				final.Append("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"都做完了。\"}}]}\n\n");
				final.Append("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n");
				final.Append("data: [DONE]\n\n");
				WriteResponse(stream, 200, "text/event-stream", final.ToString());
			}
		}
	}
}
