using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using EAgentX.Core;
using EAgentX.Util;

namespace EAgentX.Mcp
{
	/// <summary>MCP Server 暴露的一个工具（tools/list 的结果，已简化成宿主需要的字段）。</summary>
	public class McpToolInfo
	{
		public string Name;

		public string Description;

		/// <summary>inputSchema 原文（JSON 字符串），直接透传给模型。</summary>
		public string InputSchemaJson;

		public Dictionary<string, object> InputSchema;
	}

	/// <summary>tools/call 的结果：拼接后的文本 + 图片 data URI / mime 列表。</summary>
	public class McpCallResult
	{
		public bool IsError;

		public string Text;

		public List<string> Images;

		public McpCallResult()
		{
			Text = "";
			Images = new List<string>();
		}
	}

	/// <summary>
	/// 零依赖 MCP（Model Context Protocol）客户端，协议版本 2024-11-05。
	/// 两种传输：
	///   stdio —— 启动子进程，stdin/stdout 上按行收发 JSON-RPC（必须无 BOM UTF-8，否则 Node/Python
	///            Server 读第一行 JSON 直接抛 SyntaxError 退出）；
	///   http  —— 向 endpoint POST JSON-RPC，兼容 application/json 与单次 text/event-stream 响应。
	/// </summary>
	public class McpClient : IDisposable
	{
		public const string ProtocolVersion = "2024-11-05";

		private readonly McpServerEntry Entry;

		private readonly HttpClient Http;

		private readonly object Gate = new object();

		private Process Child;

		private StreamWriter ChildIn;

		private StreamReader ChildOut;

		private int NextId = 1;

		private readonly Dictionary<int, TaskCompletionSource<Dictionary<string, object>>> Pending =
			new Dictionary<int, TaskCompletionSource<Dictionary<string, object>>>();

		private Task ReaderTask;

		private bool Initialized;

		private bool Disposed;

		/// <summary>最近一次握手/调用的诊断信息。</summary>
		public string Diagnostics { get; private set; }

		/// <summary>Server 自己上报的名字与版本（initialize 结果）。</summary>
		public string ServerName { get; private set; }

		public string ServerVersion { get; private set; }

		public McpServerEntry Config
		{
			get
			{
				return Entry;
			}
		}

		/// <summary>握手完成后缓存的工具列表。</summary>
		public List<McpToolInfo> Tools { get; private set; }

		public McpClient(McpServerEntry entry)
		{
			Entry = (entry == null) ? new McpServerEntry() : entry.Clone();
			Tools = new List<McpToolInfo>();
			ServerName = "";
			ServerVersion = "";
			Diagnostics = "";
			Http = new HttpClient();
			Http.Timeout = TimeSpan.FromSeconds(90);
		}

		// ---------------- 握手 ----------------

		/// <summary>initialize → notifications/initialized → tools/list。可重复调用（已握手直接返回）。</summary>
		public async Task<List<McpToolInfo>> ConnectAsync(CancellationToken ct)
		{
			if (Initialized)
			{
				return Tools;
			}
			Dictionary<string, object> clientInfo = new Dictionary<string, object>();
			clientInfo["name"] = "EAgentX";
			clientInfo["version"] = "1.0";
			Dictionary<string, object> capabilities = new Dictionary<string, object>();
			Dictionary<string, object> parameters = new Dictionary<string, object>();
			parameters["protocolVersion"] = ProtocolVersion;
			parameters["capabilities"] = capabilities;
			parameters["clientInfo"] = clientInfo;

			Dictionary<string, object> initResult = await RequestAsync("initialize", parameters, ct).ConfigureAwait(false);
			Dictionary<string, object> info = Json.Obj(Json.Get(initResult, "serverInfo"));
			ServerName = (Json.GetStr(info, "name") == null) ? Entry.Name : Json.GetStr(info, "name");
			ServerVersion = Json.GetStr(info, "version") ?? "";

			// 通知没有 id、也不期待响应
			await NotifyAsync("notifications/initialized", null, ct).ConfigureAwait(false);

			List<McpToolInfo> tools = new List<McpToolInfo>();
			try
			{
				Dictionary<string, object> listResult = await RequestAsync("tools/list", new Dictionary<string, object>(), ct).ConfigureAwait(false);
				List<object> items = Json.List(Json.Get(listResult, "tools"));
				if (items != null)
				{
					for (int i = 0; i < items.Count; i++)
					{
						Dictionary<string, object> raw = Json.Obj(items[i]);
						if (raw == null)
						{
							continue;
						}
						McpToolInfo tool = new McpToolInfo();
						tool.Name = Json.GetStr(raw, "name") ?? "";
						tool.Description = Json.GetStr(raw, "description") ?? "";
						Dictionary<string, object> schema = Json.Obj(Json.Get(raw, "inputSchema"));
						tool.InputSchema = schema;
						tool.InputSchemaJson = (schema == null) ? "" : Json.Encode(schema);
						if (tool.Name.Length > 0)
						{
							tools.Add(tool);
						}
					}
				}
			}
			catch (Exception ex)
			{
				// 有些极简 Server 不支持 tools/list，握手仍算成功，只是没有工具
				Log.Dim("MCP " + Entry.Name + " tools/list 失败: " + ex.Message);
			}
			Tools = tools;
			Initialized = true;
			Diagnostics = Entry.Name + " · " + (ServerName ?? "") + " " + ServerVersion + " · " + tools.Count + " 个工具 · " + (Entry.IsHttp ? "http" : "stdio");
			return Tools;
		}

		// ---------------- tools/call ----------------

		public async Task<McpCallResult> CallToolAsync(string toolName, string argumentsJson, CancellationToken ct)
		{
			Dictionary<string, object> arguments = Json.Obj(Json.Decode(argumentsJson));
			if (arguments == null)
			{
				arguments = new Dictionary<string, object>();
			}
			Dictionary<string, object> parameters = new Dictionary<string, object>();
			parameters["name"] = toolName;
			parameters["arguments"] = arguments;
			Dictionary<string, object> result = await RequestAsync("tools/call", parameters, ct).ConfigureAwait(false);
			return ParseCallResult(result);
		}

		/// <summary>把 tools/call 的 content 数组展开成纯文本（图片单独收集，由视觉开关决定是否回传）。</summary>
		public static McpCallResult ParseCallResult(Dictionary<string, object> result)
		{
			McpCallResult call = new McpCallResult();
			call.IsError = Json.GetBool(result, "isError", false);
			StringBuilder sb = new StringBuilder();
			List<object> content = Json.List(Json.Get(result, "content"));
			if (content != null)
			{
				for (int i = 0; i < content.Count; i++)
				{
					Dictionary<string, object> block = Json.Obj(content[i]);
					if (block == null)
					{
						continue;
					}
					string type = Json.GetStr(block, "type") ?? "";
					if (type == "text")
					{
						sb.AppendLine(Json.GetStr(block, "text") ?? "");
					}
					else if (type == "image")
					{
						string mime = Json.GetStr(block, "mimeType") ?? "image/png";
						string data = Json.GetStr(block, "data") ?? "";
						if (data.Length > 0)
						{
							call.Images.Add(mime + "|" + data);
							sb.AppendLine("（MCP Server 返回了一张 " + mime + " 图片，已记录。）");
						}
					}
					else if (type == "resource")
					{
						Dictionary<string, object> resource = Json.Obj(Json.Get(block, "resource"));
						string uri = Json.GetStr(resource, "uri");
						string text = Json.GetStr(resource, "text");
						sb.AppendLine("【资源 " + (uri ?? "") + "】" + (text ?? ""));
					}
					else
					{
						sb.AppendLine("【" + type + "】" + Json.Encode(block));
					}
				}
			}
			if (sb.Length == 0)
			{
				object structured = Json.Get(result, "structuredContent");
				if (structured != null)
				{
					sb.Append(Json.Encode(structured));
				}
			}
			call.Text = sb.ToString().TrimEnd();
			return call;
		}

		// ---------------- JSON-RPC 管道 ----------------

		private async Task<Dictionary<string, object>> RequestAsync(string method, Dictionary<string, object> parameters, CancellationToken ct)
		{
			int id;
			lock (Gate)
			{
				id = NextId++;
			}
			Dictionary<string, object> message = new Dictionary<string, object>();
			message["jsonrpc"] = "2.0";
			message["id"] = id;
			message["method"] = method;
			if (parameters != null)
			{
				message["params"] = parameters;
			}
			string payload = Json.Encode(message);
			if (Entry.IsHttp)
			{
				return await HttpRequestAsync(id, payload, method, ct).ConfigureAwait(false);
			}
			return await StdioRequestAsync(id, payload, method, ct).ConfigureAwait(false);
		}

		private async Task NotifyAsync(string method, Dictionary<string, object> parameters, CancellationToken ct)
		{
			Dictionary<string, object> message = new Dictionary<string, object>();
			message["jsonrpc"] = "2.0";
			message["method"] = method;
			if (parameters != null)
			{
				message["params"] = parameters;
			}
			string payload = Json.Encode(message);
			ct.ThrowIfCancellationRequested();
			if (Entry.IsHttp)
			{
				using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, Entry.Url))
				{
					request.Content = new StringContent(payload, new UTF8Encoding(false), "application/json");
					ApplyHeaders(request, false);
					using (HttpResponseMessage response = await Http.SendAsync(request, ct).ConfigureAwait(false))
					{
						// 通知的响应体无所谓，读掉释放连接
						await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
					}
				}
				return;
			}
			EnsureProcess();
			await WriteLineAsync(payload).ConfigureAwait(false);
		}

		private async Task<Dictionary<string, object>> HttpRequestAsync(int id, string payload, string method, CancellationToken ct)
		{
			using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, Entry.Url))
			{
				request.Content = new StringContent(payload, new UTF8Encoding(false), "application/json");
				ApplyHeaders(request, true);
				using (HttpResponseMessage response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false))
				{
					byte[] bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
					string body = HttpUtil.DecodeUtf8(bytes);
					string contentType = "";
					try
					{
						contentType = response.Content.Headers.ContentType == null ? "" : response.Content.Headers.ContentType.ToString();
					}
					catch
					{
					}
					if (!response.IsSuccessStatusCode)
					{
						throw new Exception("MCP " + Entry.Name + " " + method + " 返回 " + (int)response.StatusCode + ": " + Shorten(body));
					}
					// 兼容「单次 text/event-stream 包装」的服务端
					if (HttpUtil.IsEventStream(contentType) || body.TrimStart().StartsWith("event:", StringComparison.Ordinal) ||
						(body.TrimStart().StartsWith("data:", StringComparison.Ordinal)))
					{
						List<string> events = SseReader.Split(body);
						Dictionary<string, object> picked = PickResponse(events, id, method);
						if (picked != null)
						{
							return picked;
						}
					}
					Dictionary<string, object> single = Json.Obj(Json.Decode(body));
					if (single != null)
					{
						return ReadResult(single, method);
					}
					throw new Exception("MCP " + Entry.Name + " " + method + " 响应无法解析: " + Shorten(body));
				}
			}
		}

		private Dictionary<string, object> PickResponse(List<string> events, int id, string method)
		{
			for (int i = 0; i < events.Count; i++)
			{
				Dictionary<string, object> item = Json.Obj(Json.Decode(events[i]));
				if (item == null)
				{
					continue;
				}
				if (Json.GetInt(item, "id", -1) == id)
				{
					return ReadResult(item, method);
				}
			}
			// 只有一个事件时宽容一点
			if (events.Count == 1)
			{
				Dictionary<string, object> only = Json.Obj(Json.Decode(events[0]));
				if (only != null && (Json.Get(only, "result") != null || Json.Get(only, "error") != null))
				{
					return ReadResult(only, method);
				}
			}
			return null;
		}

		private Dictionary<string, object> ReadResult(Dictionary<string, object> message, string method)
		{
			Dictionary<string, object> error = Json.Obj(Json.Get(message, "error"));
			if (error != null)
			{
				throw new Exception("MCP " + Entry.Name + " " + method + " 出错: " + (Json.GetStr(error, "message") ?? Json.Encode(error)));
			}
			Dictionary<string, object> result = Json.Obj(Json.Get(message, "result"));
			if (result == null)
			{
				result = new Dictionary<string, object>();
			}
			return result;
		}

		// ---------------- stdio 传输 ----------------

		/// <summary>启动子进程。关键：stdin/stdout 都显式 new UTF8Encoding(false)（无 BOM）。</summary>
		private void EnsureProcess()
		{
			if (Child != null && !Child.HasExited)
			{
				return;
			}
			if (string.IsNullOrEmpty(Entry.Command))
			{
				throw new Exception("MCP Server「" + Entry.Name + "」没有配置 command。");
			}
			ProcessStartInfo info = new ProcessStartInfo();
			info.FileName = Entry.Command;
			info.Arguments = BuildArguments(Entry.Args);
			info.UseShellExecute = false;
			info.CreateNoWindow = true;
			info.RedirectStandardInput = true;
			info.RedirectStandardOutput = true;
			info.RedirectStandardError = true;
			// 与 config.json 同目录作为工作目录，便于 Server 读相对路径资源
			info.WorkingDirectory = Settings.Dir;
			if (Entry.Env != null)
			{
				foreach (KeyValuePair<string, string> pair in Entry.Env)
				{
					try
					{
						info.EnvironmentVariables[pair.Key] = pair.Value;
					}
					catch
					{
					}
				}
			}
			Process process = new Process();
			process.StartInfo = info;
			try
			{
				if (!process.Start())
				{
					throw new Exception("进程没有启动");
				}
			}
			catch (Exception ex)
			{
				throw new Exception("启动 MCP Server「" + Entry.Name + "」失败（" + Entry.Command + "）: " + ex.Message);
			}
			Child = process;
			ChildIn = CreateStdioWriter(process.StandardInput.BaseStream);
			ChildOut = CreateStdioReader(process.StandardOutput.BaseStream);
			ReaderTask = Task.Run(delegate
			{
				ReadLoop();
			});
			Task stderrTask = Task.Run(delegate
			{
				try
				{
					while (true)
					{
						string line = process.StandardError.ReadLine();
						if (line == null)
						{
							break;
						}
						if (line.Trim().Length > 0)
						{
							Log.Dim("[" + Entry.Name + " stderr] " + Shorten(line));
						}
					}
				}
				catch
				{
				}
			});
			Diagnostics = Entry.Name + " · 子进程已启动 pid=" + SafePid(process);
		}

		private static int SafePid(Process process)
		{
			try
			{
				return process.Id;
			}
			catch
			{
				return 0;
			}
		}

		private void ReadLoop()
		{
			while (true)
			{
				string line;
				try
				{
					line = ChildOut.ReadLine();
				}
				catch
				{
					break;
				}
				if (line == null)
				{
					break;
				}
				if (line.Trim().Length == 0)
				{
					continue;
				}
				Dictionary<string, object> message = Json.Obj(Json.Decode(line));
				if (message == null)
				{
					Log.Dim("[" + Entry.Name + "] 非 JSON-RPC 输出: " + Shorten(line));
					continue;
				}
				int id = Json.GetInt(message, "id", -1);
				if (id < 0)
				{
					// Server 主动发来的通知（日志、进度），忽略
					continue;
				}
				TaskCompletionSource<Dictionary<string, object>> waiter = null;
				lock (Gate)
				{
					if (Pending.TryGetValue(id, out waiter))
					{
						Pending.Remove(id);
					}
				}
				if (waiter != null)
				{
					waiter.TrySetResult(message);
				}
			}
			FailAllPending("MCP Server「" + Entry.Name + "」的输出流已关闭。");
		}

		private void FailAllPending(string reason)
		{
			List<TaskCompletionSource<Dictionary<string, object>>> waiters = new List<TaskCompletionSource<Dictionary<string, object>>>();
			lock (Gate)
			{
				foreach (KeyValuePair<int, TaskCompletionSource<Dictionary<string, object>>> pair in Pending)
				{
					waiters.Add(pair.Value);
				}
				Pending.Clear();
			}
			for (int i = 0; i < waiters.Count; i++)
			{
				waiters[i].TrySetException(new Exception(reason));
			}
		}

		private async Task<Dictionary<string, object>> StdioRequestAsync(int id, string payload, string method, CancellationToken ct)
		{
			EnsureProcess();
			TaskCompletionSource<Dictionary<string, object>> waiter = new TaskCompletionSource<Dictionary<string, object>>();
			lock (Gate)
			{
				Pending[id] = waiter;
			}
			try
			{
				await WriteLineAsync(payload).ConfigureAwait(false);
				Task completed = await Task.WhenAny(waiter.Task, Task.Delay(TimeSpan.FromSeconds(120), ct)).ConfigureAwait(false);
				if (completed != waiter.Task)
				{
					lock (Gate)
					{
						Pending.Remove(id);
					}
					ct.ThrowIfCancellationRequested();
					throw new TimeoutException("MCP " + Entry.Name + " " + method + " 超时（120 秒）。");
				}
				Dictionary<string, object> message = await waiter.Task.ConfigureAwait(false);
				return ReadResult(message, method);
			}
			catch
			{
				lock (Gate)
				{
					Pending.Remove(id);
				}
				throw;
			}
		}

		private async Task WriteLineAsync(string payload)
		{
			StreamWriter writer = ChildIn;
			if (writer == null)
			{
				throw new Exception("MCP Server「" + Entry.Name + "」的标准输入不可用。");
			}
			// 去掉内嵌换行（JSON 里合法换行已被转义成 \n，这里只是防御）
			string line = payload.Replace("\r", " ").Replace("\n", " ");
			await writer.WriteLineAsync(line).ConfigureAwait(false);
			await writer.FlushAsync().ConfigureAwait(false);
		}

		private void ApplyHeaders(HttpRequestMessage request, bool isCall)
		{
			if (Entry.Headers != null)
			{
				foreach (KeyValuePair<string, string> pair in Entry.Headers)
				{
					try
					{
						if (string.Equals(pair.Key, "Content-Type", StringComparison.OrdinalIgnoreCase))
						{
							continue;
						}
						request.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
					}
					catch
					{
					}
				}
			}
			if (request.Headers.Accept.Count == 0)
			{
				request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
				request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
			}
		}

		/// <summary>Stdio 写入流：必须是 new UTF8Encoding(false) 无 BOM UTF-8。</summary>
		public static StreamWriter CreateStdioWriter(Stream stream)
		{
			StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false));
			writer.AutoFlush = true;
			return writer;
		}

		/// <summary>Stdio 读取流：同样无 BOM（带 BOM 的解码器会把首行 JSON 的第一个 token 读成 \uFEFF）。</summary>
		public static StreamReader CreateStdioReader(Stream stream)
		{
			return new StreamReader(stream, new UTF8Encoding(false));
		}

		/// <summary>Windows 命令行参数转义（引号/反斜杠按 CreateProcess 规则）。</summary>
		public static string BuildArguments(List<string> args)
		{
			if (args == null || args.Count == 0)
			{
				return "";
			}
			StringBuilder sb = new StringBuilder();
			for (int i = 0; i < args.Count; i++)
			{
				if (i > 0)
				{
					sb.Append(' ');
				}
				sb.Append(QuoteArgument(args[i] ?? ""));
			}
			return sb.ToString();
		}

		public static string QuoteArgument(string value)
		{
			if (value.Length == 0)
			{
				return "\"\"";
			}
			bool needQuote = value.IndexOfAny(new char[] { ' ', '\t', '\n', '\r', '"' }) >= 0;
			if (!needQuote)
			{
				return value;
			}
			StringBuilder sb = new StringBuilder();
			sb.Append('"');
			int backslashes = 0;
			for (int i = 0; i < value.Length; i++)
			{
				char c = value[i];
				if (c == '\\')
				{
					backslashes++;
					sb.Append(c);
					continue;
				}
				if (c == '"')
				{
					sb.Append('\\', backslashes + 1);
					sb.Append('"');
					backslashes = 0;
					continue;
				}
				sb.Append(c);
				backslashes = 0;
			}
			sb.Append('\\', backslashes);
			sb.Append('"');
			return sb.ToString();
		}

		private static string Shorten(string text)
		{
			if (text == null)
			{
				return "";
			}
			string flat = text.Replace("\r", " ").Replace("\n", " ").Trim();
			if (flat.Length <= 300)
			{
				return flat;
			}
			return flat.Substring(0, 300) + "…";
		}

		public void Dispose()
		{
			if (Disposed)
			{
				return;
			}
			Disposed = true;
			try
			{
				if (Http != null)
				{
					Http.Dispose();
				}
			}
			catch
			{
			}
			FailAllPending("MCP 客户端已关闭。");
			try
			{
				if (ChildIn != null)
				{
					ChildIn.Dispose();
				}
			}
			catch
			{
			}
			try
			{
				if (Child != null && !Child.HasExited)
				{
					// 先关 stdin（标准做法，Server 会自己退出），再兜底 Kill
					try
					{
						Child.Kill();
					}
					catch
					{
					}
				}
			}
			catch
			{
			}
			try
			{
				if (Child != null)
				{
					Child.Dispose();
				}
			}
			catch
			{
			}
			try
			{
				if (ReaderTask != null)
				{
					ReaderTask.Wait(2000);
				}
			}
			catch
			{
			}
			Child = null;
			ChildIn = null;
			ChildOut = null;
		}
	}
}
