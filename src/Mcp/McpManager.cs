using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using EAgentX.Engines;
using EAgentX.Util;

namespace EAgentX.Mcp
{
	/// <summary>已注册的一个外部工具：命名空间化后的函数名 + 来源 Server + 原始工具名。</summary>
	public class McpToolRoute
	{
		public string QualifiedName;

		public string ServerName;

		public string ToolName;

		public string Description;

		public Dictionary<string, object> InputSchema;

		public bool RequireApproval;

		public McpClient Client;
	}

	/// <summary>
	/// 多 MCP Server 的生命周期管理与工具命名空间映射：
	/// 外部工具统一暴露为 mcp__&lt;serverName&gt;__&lt;toolName&gt;，
	/// 并过滤到 OpenAI 函数名正则 ^[a-zA-Z0-9_-]{1,64}$。
	/// </summary>
	public class McpManager : IDisposable
	{
		private readonly List<McpServerEntry> Entries = new List<McpServerEntry>();

		private readonly List<McpClient> Clients = new List<McpClient>();

		private readonly Dictionary<string, McpToolRoute> Routes = new Dictionary<string, McpToolRoute>(StringComparer.Ordinal);

		private readonly object Gate = new object();

		private bool Attempted;

		/// <summary>上一次连接的整体诊断（显示在设置窗口 / 日志里）。</summary>
		public string Diagnostics { get; private set; }

		/// <summary>启用并成功握手的 Server 数量。</summary>
		public int ConnectedCount { get; private set; }

		public McpManager()
		{
			Diagnostics = "未加载 MCP 配置。";
		}

		public bool HasTools
		{
			get
			{
				return Routes.Count > 0;
			}
		}

		public List<McpServerEntry> EntriesSnapshot
		{
			get
			{
				List<McpServerEntry> copy = new List<McpServerEntry>();
				for (int i = 0; i < Entries.Count; i++)
				{
					copy.Add(Entries[i].Clone());
				}
				return copy;
			}
		}

		/// <summary>已注册的全部工具（可直接并入 ToolDefinition 列表发给模型）。</summary>
		public List<ToolDefinition> ToolDefinitions()
		{
			List<ToolDefinition> tools = new List<ToolDefinition>();
			foreach (KeyValuePair<string, McpToolRoute> pair in Routes)
			{
				McpToolRoute route = pair.Value;
				ToolDefinition definition = new ToolDefinition();
				definition.Name = route.QualifiedName;
				definition.Description = ((route.Description == null) ? "" : route.Description) +
					"（来自 MCP Server「" + route.ServerName + "」的外部工具 " + route.ToolName + "）";
				definition.ParametersSchema = (route.InputSchema == null) ? ToolDefinition.EmptySchema() : route.InputSchema;
				tools.Add(definition);
			}
			return tools;
		}

		/// <summary>从 mcp.json 读取并连接全部启用的 Server。失败只记录，不影响主流程。</summary>
		public async Task<string> LoadAndConnectAsync(CancellationToken ct)
		{
			List<McpServerEntry> entries = McpConfig.Load();
			return await LoadAndConnectAsync(entries, ct).ConfigureAwait(false);
		}

		/// <summary>同一个会话里只握手一次；配置改了由 Reset() 重置后重新加载。</summary>
		public async Task<string> EnsureConnectedAsync(CancellationToken ct)
		{
			if (Attempted)
			{
				return Diagnostics;
			}
			return await LoadAndConnectAsync(ct).ConfigureAwait(false);
		}

		/// <summary>断开全部连接并允许下次重新加载（新建会话 / 修改配置后调用）。</summary>
		public void Reset()
		{
			CloseAll();
			lock (Gate)
			{
				Routes.Clear();
				Entries.Clear();
				Attempted = false;
			}
			ConnectedCount = 0;
			Diagnostics = "MCP 连接已重置。";
		}

		public async Task<string> LoadAndConnectAsync(List<McpServerEntry> entries, CancellationToken ct)
		{
			Attempted = true;
			CloseAll();
			lock (Gate)
			{
				Entries.Clear();
				if (entries != null)
				{
					for (int i = 0; i < entries.Count; i++)
					{
						Entries.Add(entries[i].Clone());
					}
				}
				Routes.Clear();
			}
			StringBuilder report = new StringBuilder();
			int connected = 0;
			for (int i = 0; i < Entries.Count; i++)
			{
				McpServerEntry entry = Entries[i];
				if (!entry.Enabled)
				{
					report.AppendLine("- " + entry.Name + ": 已禁用，跳过");
					continue;
				}
				ct.ThrowIfCancellationRequested();
				McpClient client = new McpClient(entry);
				try
				{
					List<McpToolInfo> tools = await client.ConnectAsync(ct).ConfigureAwait(false);
					int registered = Register(entry, client, tools, report);
					if (registered >= 0)
					{
						Clients.Add(client);
						connected++;
					}
					else
					{
						client.Dispose();
					}
				}
				catch (Exception ex)
				{
					client.Dispose();
					report.AppendLine("- " + entry.Name + ": 连接失败 — " + ex.Message);
					Log.Error("MCP " + entry.Name + " 连接失败: " + ex.Message);
				}
			}
			ConnectedCount = connected;
			Diagnostics = ((connected == 0) ? "没有可用的 MCP Server。" : ("已连接 " + connected + " 个 MCP Server，共 " + Routes.Count + " 个外部工具。")) + "\r\n" + report.ToString().TrimEnd();
			return Diagnostics;
		}

		/// <summary>把某个 Server 的工具注册进路由表；返回注册数量（-1 表示一个都没有）。</summary>
		private int Register(McpServerEntry entry, McpClient client, List<McpToolInfo> tools, StringBuilder report)
		{
			if (tools == null || tools.Count == 0)
			{
				report.AppendLine("- " + entry.Name + ": 已连接（" + client.ServerName + "），但没有暴露工具");
				return -1;
			}
			int count = 0;
			lock (Gate)
			{
				for (int i = 0; i < tools.Count; i++)
				{
					McpToolInfo tool = tools[i];
					string qualified = Qualify(entry.Name, tool.Name);
					if (Routes.ContainsKey(qualified))
					{
						report.AppendLine("- " + entry.Name + ": 工具名冲突，已跳过 " + tool.Name);
						continue;
					}
					McpToolRoute route = new McpToolRoute();
					route.QualifiedName = qualified;
					route.ServerName = entry.Name;
					route.ToolName = tool.Name;
					route.Description = tool.Description;
					route.InputSchema = tool.InputSchema;
					route.RequireApproval = entry.RequireApproval;
					route.Client = client;
					Routes[qualified] = route;
					count++;
				}
			}
			report.AppendLine("- " + entry.Name + ": 已连接（" + client.ServerName + " " + client.ServerVersion + "），注册 " + count + " 个工具");
			return count;
		}

		public bool IsMcpTool(string name)
		{
			if (string.IsNullOrEmpty(name))
			{
				return false;
			}
			lock (Gate)
			{
				return Routes.ContainsKey(name);
			}
		}

		public McpToolRoute Find(string qualifiedName)
		{
			lock (Gate)
			{
				McpToolRoute route;
				if (Routes.TryGetValue(qualifiedName, out route))
				{
					return route;
				}
			}
			return null;
		}

		/// <summary>执行一次外部工具调用。参数 JSON 原样透传，不做任何改写。</summary>
		public async Task<McpCallResult> CallAsync(string qualifiedName, string argumentsJson, CancellationToken ct)
		{
			McpToolRoute route = Find(qualifiedName);
			if (route == null)
			{
				throw new Exception("没有找到 MCP 工具: " + qualifiedName);
			}
			return await route.Client.CallToolAsync(route.ToolName, argumentsJson, ct).ConfigureAwait(false);
		}

		private void CloseAll()
		{
			for (int i = 0; i < Clients.Count; i++)
			{
				try
				{
					Clients[i].Dispose();
				}
				catch
				{
				}
			}
			Clients.Clear();
		}

		public void Dispose()
		{
			CloseAll();
			lock (Gate)
			{
				Routes.Clear();
			}
		}

		// ---------------- 命名空间映射 ----------------

		private static readonly Regex InvalidChars = new Regex("[^a-zA-Z0-9_-]", RegexOptions.Compiled);

		/// <summary>
		/// mcp__&lt;server&gt;__&lt;tool&gt;：非法字符换成下划线，超出 64 字符截断。
		/// 例：server "filesystem" + tool "read_file" → "mcp__filesystem__read_file"。
		/// </summary>
		public static string Qualify(string serverName, string toolName)
		{
			string server = Sanitize(serverName);
			string tool = Sanitize(toolName);
			string qualified = "mcp__" + server + "__" + tool;
			if (qualified.Length > 64)
			{
				qualified = qualified.Substring(0, 64);
			}
			return qualified;
		}

		/// <summary>拆回 (server, tool)；不符合命名空间格式时返回 null。</summary>
		public static string[] Split(string qualifiedName)
		{
			if (string.IsNullOrEmpty(qualifiedName) || !qualifiedName.StartsWith("mcp__", StringComparison.Ordinal))
			{
				return null;
			}
			string rest = qualifiedName.Substring(5);
			int split = rest.IndexOf("__", StringComparison.Ordinal);
			if (split <= 0 || split + 2 >= rest.Length)
			{
				return null;
			}
			return new string[] { rest.Substring(0, split), rest.Substring(split + 2) };
		}

		public static string Sanitize(string name)
		{
			if (string.IsNullOrEmpty(name))
			{
				return "server";
			}
			string cleaned = InvalidChars.Replace(name, "_");
			if (cleaned.Length == 0)
			{
				return "server";
			}
			if (cleaned.Length > 24)
			{
				cleaned = cleaned.Substring(0, 24);
			}
			return cleaned;
		}
	}
}
