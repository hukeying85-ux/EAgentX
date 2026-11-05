using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using EAgentX.Util;

namespace EAgentX.Mcp
{
	/// <summary>
	/// 一个 MCP Server 的配置。字段刻意对齐 Claude Desktop / Cursor 的 mcpServers 写法，
	/// 用户可以直接把别处的整段 JSON 粘过来。
	/// </summary>
	public class McpServerEntry
	{
		public string Name;

		public bool Enabled;

		/// <summary>stdio = 启动本地子进程；http = 直接向 Url 发 JSON-RPC POST。</summary>
		public string Transport;

		public string Command;

		public List<string> Args;

		public Dictionary<string, string> Env;

		public string Url;

		public Dictionary<string, string> Headers;

		/// <summary>是否每次调用都弹出审批窗口（默认 true；只读服务可以关掉）。</summary>
		public bool RequireApproval;

		public McpServerEntry()
		{
			Name = "";
			Enabled = true;
			Transport = "stdio";
			Command = "";
			Args = new List<string>();
			Env = new Dictionary<string, string>();
			Url = "";
			Headers = new Dictionary<string, string>();
			RequireApproval = true;
		}

		public bool IsHttp
		{
			get
			{
				return string.Equals(Transport, "http", StringComparison.OrdinalIgnoreCase) ||
					string.Equals(Transport, "sse", StringComparison.OrdinalIgnoreCase);
			}
		}

		public McpServerEntry Clone()
		{
			McpServerEntry copy = new McpServerEntry();
			copy.Name = Name;
			copy.Enabled = Enabled;
			copy.Transport = Transport;
			copy.Command = Command;
			copy.Args = new List<string>(Args ?? new List<string>());
			copy.Env = new Dictionary<string, string>(Env ?? new Dictionary<string, string>());
			copy.Url = Url;
			copy.Headers = new Dictionary<string, string>(Headers ?? new Dictionary<string, string>());
			copy.RequireApproval = RequireApproval;
			return copy;
		}
	}

	/// <summary>
	/// %APPDATA%\EAgentX-UI\mcp.json 的读写（与 config.json 同目录）。
	/// 兼容标准 mcpServers 结构；同时接受 "enabled" / "disabled" / "transport" / "url" / "headers"
	/// 这些扩展字段，缺字段时全部回落到安全默认值。
	/// </summary>
	public static class McpConfig
	{
		public const string SampleJson =
			"{\r\n" +
			"  \"mcpServers\": {\r\n" +
			"    \"filesystem\": {\r\n" +
			"      \"command\": \"npx\",\r\n" +
			"      \"args\": [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"C:\\\\Users\"],\r\n" +
			"      \"requireApproval\": true\r\n" +
			"    },\r\n" +
			"    \"demo-http\": {\r\n" +
			"      \"transport\": \"http\",\r\n" +
			"      \"url\": \"http://127.0.0.1:8123/mcp\",\r\n" +
			"      \"enabled\": false\r\n" +
			"    }\r\n" +
			"  }\r\n" +
			"}";

		public static string FilePath
		{
			get
			{
				return Path.Combine(Settings.Dir, "mcp.json");
			}
		}

		/// <summary>读配置；文件不存在时返回空列表（绝不抛异常）。</summary>
		public static List<McpServerEntry> Load()
		{
			try
			{
				if (!File.Exists(FilePath))
				{
					return new List<McpServerEntry>();
				}
				return Parse(File.ReadAllText(FilePath));
			}
			catch (Exception ex)
			{
				Log.Error("读取 mcp.json 失败: " + ex.Message);
				return new List<McpServerEntry>();
			}
		}

		public static bool Save(List<McpServerEntry> servers)
		{
			return SaveText(ToJson(servers));
		}

		/// <summary>保存原始 JSON 文本（设置窗口里用户是直接编辑文本的）。</summary>
		public static bool SaveText(string json)
		{
			try
			{
				string dir = Path.GetDirectoryName(FilePath);
				if (!Directory.Exists(dir))
				{
					Directory.CreateDirectory(dir);
				}
				string temp = FilePath + ".tmp";
				// MCP 子进程对 BOM 很敏感的是 stdin；但配置文件本身也统一用无 BOM UTF-8，避免别家解析器报错
				File.WriteAllText(temp, json ?? "", new UTF8Encoding(false));
				if (File.Exists(FilePath))
				{
					File.Delete(FilePath);
				}
				File.Move(temp, FilePath);
				return true;
			}
			catch (Exception ex)
			{
				Log.Error("保存 mcp.json 失败: " + ex.Message);
				return false;
			}
		}

		/// <summary>解析标准 mcpServers JSON。</summary>
		public static List<McpServerEntry> Parse(string json)
		{
			List<McpServerEntry> servers = new List<McpServerEntry>();
			if (string.IsNullOrEmpty(json))
			{
				return servers;
			}
			Dictionary<string, object> root = Json.Obj(Json.Decode(json));
			if (root == null)
			{
				throw new Exception("mcp.json 不是合法的 JSON 对象。");
			}
			Dictionary<string, object> map = Json.Obj(Json.Get(root, "mcpServers"));
			if (map == null)
			{
				// 也接受直接写 { "serverName": {...} } 的简化格式
				map = root;
			}
			foreach (KeyValuePair<string, object> pair in map)
			{
				Dictionary<string, object> body = Json.Obj(pair.Value);
				if (body == null)
				{
					continue;
				}
				McpServerEntry entry = new McpServerEntry();
				entry.Name = pair.Key;
				entry.Enabled = Json.GetBool(body, "enabled", true);
				if (Json.GetBool(body, "disabled", false))
				{
					entry.Enabled = false;
				}
				entry.Transport = (Json.GetStr(body, "transport") ?? "stdio").Trim().ToLowerInvariant();
				if (entry.Transport == "streamable-http" || entry.Transport == "streamablehttp")
				{
					entry.Transport = "http";
				}
				entry.Command = Json.GetStr(body, "command") ?? "";
				entry.Args = StringList(Json.Get(body, "args"));
				entry.Env = StringMap(Json.Get(body, "env"));
				entry.Url = Json.GetStr(body, "url") ?? "";
				entry.Headers = StringMap(Json.Get(body, "headers"));
				entry.RequireApproval = Json.GetBool(body, "requireApproval", true);
				if (entry.Transport == "http" || entry.Url.Length > 0)
				{
					entry.Transport = "http";
				}
				if (entry.Name.Trim().Length > 0)
				{
					servers.Add(entry);
				}
			}
			return servers;
		}

		/// <summary>把配置序列化回标准 mcpServers 格式（不输出空的扩展字段）。</summary>
		public static string ToJson(List<McpServerEntry> servers)
		{
			Dictionary<string, object> map = new Dictionary<string, object>();
			if (servers != null)
			{
				for (int i = 0; i < servers.Count; i++)
				{
					McpServerEntry entry = servers[i];
					if (entry == null || string.IsNullOrEmpty(entry.Name))
					{
						continue;
					}
					Dictionary<string, object> body = new Dictionary<string, object>();
					if (entry.IsHttp)
					{
						body["transport"] = "http";
						body["url"] = entry.Url;
						if (entry.Headers != null && entry.Headers.Count > 0)
						{
							Dictionary<string, object> headers = new Dictionary<string, object>();
							foreach (KeyValuePair<string, string> pair in entry.Headers)
							{
								headers[pair.Key] = pair.Value;
							}
							body["headers"] = headers;
						}
					}
					else
					{
						body["command"] = entry.Command;
						body["args"] = entry.Args;
						if (entry.Env != null && entry.Env.Count > 0)
						{
							Dictionary<string, object> env = new Dictionary<string, object>();
							foreach (KeyValuePair<string, string> pair in entry.Env)
							{
								env[pair.Key] = pair.Value;
							}
							body["env"] = env;
						}
					}
					body["enabled"] = entry.Enabled;
					body["requireApproval"] = entry.RequireApproval;
					map[entry.Name] = body;
				}
			}
			Dictionary<string, object> root = new Dictionary<string, object>();
			root["mcpServers"] = map;
			return Indent(Json.Encode(root));
		}

		private static List<string> StringList(object value)
		{
			List<string> items = new List<string>();
			List<object> raw = Json.List(value);
			if (raw == null)
			{
				return items;
			}
			for (int i = 0; i < raw.Count; i++)
			{
				if (raw[i] != null)
				{
					items.Add(raw[i].ToString());
				}
			}
			return items;
		}

		private static Dictionary<string, string> StringMap(object value)
		{
			Dictionary<string, string> map = new Dictionary<string, string>();
			Dictionary<string, object> raw = Json.Obj(value);
			if (raw == null)
			{
				return map;
			}
			foreach (KeyValuePair<string, object> pair in raw)
			{
				map[pair.Key] = (pair.Value == null) ? "" : pair.Value.ToString();
			}
			return map;
		}

		/// <summary>
		/// 极简 JSON 美化（JavaScriptSerializer 只输出单行）。
		/// 只在字符串外部换行/缩进，转义字符原样保留，不会破坏内容。
		/// </summary>
		public static string Indent(string json)
		{
			if (string.IsNullOrEmpty(json))
			{
				return "";
			}
			StringBuilder sb = new StringBuilder();
			int depth = 0;
			bool inString = false;
			bool escaped = false;
			for (int i = 0; i < json.Length; i++)
			{
				char c = json[i];
				if (inString)
				{
					sb.Append(c);
					if (escaped)
					{
						escaped = false;
					}
					else if (c == '\\')
					{
						escaped = true;
					}
					else if (c == '"')
					{
						inString = false;
					}
					continue;
				}
				switch (c)
				{
				case '"':
					inString = true;
					sb.Append(c);
					break;
				case '{':
				case '[':
					depth++;
					sb.Append(c).Append("\r\n").Append(Pad(depth));
					break;
				case '}':
				case ']':
					depth--;
					sb.Append("\r\n").Append(Pad(depth)).Append(c);
					break;
				case ',':
					sb.Append(c).Append("\r\n").Append(Pad(depth));
					break;
				case ':':
					sb.Append(": ");
					break;
				default:
					if (c != '\r' && c != '\n')
					{
						sb.Append(c);
					}
					break;
				}
			}
			return sb.ToString();
		}

		private static string Pad(int depth)
		{
			return new string(' ', depth * 2);
		}
	}
}
