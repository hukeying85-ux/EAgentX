using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using EAgentX.Engines;
using EAgentX.Util;

namespace EAgentX.Core
{
	/// <summary>一次内置工具调用的执行结果（文本 + 需要追加给视觉模型的图片路径）。</summary>
	public class ToolExecResult
	{
		public bool Ok;

		public string Text;

		public string[] Attachments;

		/// <summary>用户拒绝执行（需要原样回传给模型，不允许漏 tool_call_id）。</summary>
		public bool Denied;

		public static ToolExecResult From(bool ok, string text)
		{
			ToolExecResult result = new ToolExecResult();
			result.Ok = ok;
			result.Text = text;
			return result;
		}

		public static ToolExecResult Refused(string reason)
		{
			ToolExecResult result = new ToolExecResult();
			result.Ok = false;
			result.Denied = true;
			result.Text = reason;
			return result;
		}
	}

	/// <summary>
	/// 内置工具：把 EAgentX 原有的 5 大本机能力 + 技能查询封装成标准 JSON Schema。
	/// 名称符合 OpenAI 函数名正则 ^[a-zA-Z0-9_-]{1,64}$。
	/// </summary>
	public static class BuiltInToolSchemas
	{
		public const string RunPowerShell = "run_powershell";

		public const string CaptureScreenshot = "capture_screenshot";

		public const string AttachLocalFile = "attach_local_file";

		public const string MouseClick = "mouse_click";

		public const string KeyboardPress = "keyboard_press";

		public const string ListSkills = "list_skills";

		public const string ReadSkill = "read_skill";

		/// <summary>需要人工审批（默认弹 ApproveForm）的本机副作用工具。</summary>
		public static bool RequiresApproval(string name)
		{
			return name == RunPowerShell || name == MouseClick || name == KeyboardPress;
		}

		/// <summary>是否是本类内置工具（其余交给 MCP 管理器路由）。</summary>
		public static bool IsBuiltIn(string name)
		{
			if (string.IsNullOrEmpty(name))
			{
				return false;
			}
			return name == RunPowerShell || name == CaptureScreenshot || name == AttachLocalFile ||
				name == MouseClick || name == KeyboardPress || name == ListSkills || name == ReadSkill;
		}

		/// <summary>按设置和技能目录生成工具列表；S.EnableTools 关闭时只剩 PowerShell + 技能查询。</summary>
		public static List<ToolDefinition> Build(Settings s, string skillsDir)
		{
			List<ToolDefinition> tools = new List<ToolDefinition>();
			tools.Add(new ToolDefinition(RunPowerShell,
				"在用户电脑上执行一段 PowerShell 脚本（工作目录为设置里的工作目录），返回退出码与标准输出/错误。脚本必须是完整合法的 PowerShell。",
				Schema(new string[] { "command" },
					Prop("command", "string", "要执行的 PowerShell 脚本（可以多行、多条语句）。"),
					Prop("description", "string", "一句话说明这条命令要做什么（显示在审批窗口里，方便用户判断风险）。"))));
			if (s == null || s.EnableTools)
			{
				tools.Add(new ToolDefinition(CaptureScreenshot,
					"截屏：target 写 \"screen\" 截整个屏幕，或写窗口句柄数字截指定窗口。返回图片尺寸、保存路径与鼠标坐标（纯文本）。",
					Schema(new string[] { "target" },
						Prop("target", "string", "填 screen / 屏幕 / 全屏 表示整屏；或填窗口句柄数字。"))));
				tools.Add(new ToolDefinition(AttachLocalFile,
					"把一个本地文件作为附件交给模型。图片会内联成图片块（仅视觉模型），小文本文件直接返回内容，其它文件只返回路径与大小。",
					Schema(new string[] { "path" },
						Prop("path", "string", "本地文件的绝对路径。"))));
				tools.Add(new ToolDefinition(MouseClick,
					"把鼠标移到屏幕物理坐标 (x, y) 并点击，用于操作本机 GUI 程序。使用前先用 capture_screenshot 确认坐标。",
					Schema(new string[] { "x", "y" },
						Prop("x", "integer", "屏幕物理坐标 X（像素）。"),
						Prop("y", "integer", "屏幕物理坐标 Y（像素）。"),
						Prop("action", "string", "点击方式：left 左键单击（默认）/ double 左键双击 / right 右键单击 / rightdouble 右键双击。",
							new string[] { "left", "double", "right", "rightdouble" }))));
				tools.Add(new ToolDefinition(KeyboardPress,
					"发送一组同时按下的虚拟键码（先按顺序按下，再逆序松开），可选先激活指定窗口。例如 Win+R 是 [91,82]，Ctrl+S 是 [17,83]。",
					Schema(new string[] { "keys" },
						Prop("keys", "array", "最多 3 个虚拟键码（0-255），按顺序同时按下。"),
						Prop("hwnd", "integer", "可选：先激活的窗口句柄。"))));
			}
			if (!string.IsNullOrEmpty(skillsDir))
			{
				tools.Add(new ToolDefinition(ListSkills,
					"列出本机技能库（.eagentx\\skills）里的全部技能名称与一句话简介。需要用到某个技能时，再用 read_skill 读取它的完整说明。",
					Schema(new string[] { }, Prop("keyword", "string", "可选：按关键字过滤技能名或简介。"))));
				tools.Add(new ToolDefinition(ReadSkill,
					"读取某个技能的 SKILL.md 完整内容（含步骤、脚本和注意事项）。skill_name 用 list_skills 返回的名字。",
					Schema(new string[] { "skill_name" },
						Prop("skill_name", "string", "技能名，例如 list_skills 返回的名字。"))));
			}
			return tools;
		}

		/// <summary>
		/// 分发执行。cancelCheck 由 AgentSession 传入，用于在执行前响应「停止」。
		/// 审批由 AgentSession 统一做（这样 MCP 工具也能复用同一套 ApproveHandler），
		/// 所以这里只负责真正执行。
		/// </summary>
		public static ToolExecResult Execute(Settings s, string skillsDir, PowerShellRunner runner, string name, Dictionary<string, object> args, CancellationToken ct)
		{
			ct.ThrowIfCancellationRequested();
			if (name == ListSkills)
			{
				return ExecListSkills(skillsDir, ArgStr(args, "keyword", ""));
			}
			if (name == ReadSkill)
			{
				return ExecReadSkill(skillsDir, ArgStr(args, "skill_name", ""));
			}
			if (name == RunPowerShell)
			{
				string command = ArgStr(args, "command", "");
				if (command.Trim().Length == 0)
				{
					return ToolExecResult.From(false, "参数 command 为空。");
				}
				if (runner == null)
				{
					return ToolExecResult.From(false, "PowerShell 执行器未初始化。");
				}
				RunResult result = runner.Run(command);
				StringBuilder sb = new StringBuilder();
				if (result.TimedOut)
				{
					sb.AppendLine("【超时】命令超过 " + (result.ElapsedMs / 1000) + " 秒被终止。");
				}
				sb.AppendLine("退出码: " + result.ExitCode + "（" + result.ElapsedMs + " ms）");
				sb.AppendLine("输出:");
				sb.AppendLine((result.Output == null) ? "" : result.Output);
				return ToolExecResult.From(result.ExitCode == 0 && !result.TimedOut, sb.ToString());
			}
			if (name == CaptureScreenshot)
			{
				ToolResult shot = ToolRunner.Screenshot(s, ArgStr(args, "target", "screen"));
				ToolExecResult exec = new ToolExecResult();
				exec.Ok = shot.Ok;
				exec.Text = DescribeScreenshot(shot);
				exec.Attachments = shot.Ok ? shot.Attachments : null;
				return exec;
			}
			if (name == AttachLocalFile)
			{
				return ExecAttach(s, ArgStr(args, "path", ""));
			}
			if (name == MouseClick)
			{
				int x = ArgInt(args, "x", 0);
				int y = ArgInt(args, "y", 0);
				string action = ArgStr(args, "action", "left");
				ToolResult click = ToolRunner.Mouse(x + "," + y + "," + action);
				return ToolExecResult.From(click.Ok, click.Text);
			}
			if (name == KeyboardPress)
			{
				List<int> keys = ArgIntList(args, "keys");
				if (keys.Count == 0)
				{
					return ToolExecResult.From(false, "参数 keys 为空：虚拟键码示例 Win+R = [91,82]，Ctrl+S = [17,83]。");
				}
				int hwnd = ArgInt(args, "hwnd", 0);
				StringBuilder payload = new StringBuilder();
				for (int i = 0; i < keys.Count; i++)
				{
					if (i > 0)
					{
						payload.Append(',');
					}
					payload.Append(keys[i]);
				}
				if (hwnd > 0)
				{
					payload.Append(',').Append(hwnd);
				}
				ToolResult pressed = ToolRunner.Keyboard(payload.ToString());
				return ToolExecResult.From(pressed.Ok, pressed.Text);
			}
			return ToolExecResult.From(false, "未知的内置工具: " + name);
		}

		/// <summary>截图结果转纯文本（尺寸、路径、鼠标物理坐标），不依赖多模态。</summary>
		private static string DescribeScreenshot(ToolResult shot)
		{
			if (shot == null)
			{
				return "截图失败：没有返回结果。";
			}
			string head = (shot.Text == null) ? "" : shot.Text.Trim();
			StringBuilder sb = new StringBuilder();
			if (!shot.Ok)
			{
				sb.Append("截图失败：").Append(head);
				return sb.ToString();
			}
			sb.AppendLine(head);
			if (shot.Attachments != null)
			{
				for (int i = 0; i < shot.Attachments.Length; i++)
				{
					string path = shot.Attachments[i];
					try
					{
						if (!File.Exists(path))
						{
							continue;
						}
						FileInfo info = new FileInfo(path);
						sb.AppendLine("图片文件: " + path + "（" + info.Length / 1024 + " KB）");
						using (System.Drawing.Image image = System.Drawing.Image.FromFile(path))
						{
							sb.AppendLine("像素尺寸: " + image.Width + " × " + image.Height);
							sb.AppendLine("注意：mouse_click 使用的是屏幕物理坐标；如果截图是整屏，坐标原点就是 (0,0)。");
						}
					}
					catch (Exception ex)
					{
						sb.AppendLine("读取图片信息失败: " + ex.Message);
					}
				}
			}
			return sb.ToString();
		}

		private static ToolExecResult ExecAttach(Settings s, string path)
		{
			if (string.IsNullOrEmpty(path))
			{
				return ToolExecResult.From(false, "参数 path 为空。");
			}
			if (!File.Exists(path))
			{
				return ToolExecResult.From(false, "文件不存在: " + path);
			}
			try
			{
				FileInfo info = new FileInfo(path);
				string ext = Path.GetExtension(path).ToLowerInvariant();
				bool isImage = ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".webp" || ext == ".bmp";
				if (isImage)
				{
					StringBuilder sb = new StringBuilder();
					sb.AppendLine("已附加图片: " + path + "（" + info.Length / 1024 + " KB）");
					using (System.Drawing.Image image = System.Drawing.Image.FromFile(path))
					{
						sb.AppendLine("像素尺寸: " + image.Width + " × " + image.Height);
					}
					ToolExecResult exec = ToolExecResult.From(true, sb.ToString());
					exec.Attachments = new string[] { path };
					return exec;
				}
				bool isText = ext == ".txt" || ext == ".md" || ext == ".csv" || ext == ".json" || ext == ".log" || ext == ".xml" ||
					ext == ".html" || ext == ".cs" || ext == ".ps1" || ext == ".py" || ext == ".js" || ext == ".ini" ||
					ext == ".yml" || ext == ".yaml" || ext == ".bat" || ext == ".cmd" || ext == ".config";
				if (isText && info.Length <= 100L * 1024L)
				{
					string body = File.ReadAllText(path);
					return ToolExecResult.From(true, "文件内容（" + path + "，共 " + body.Length + " 字符）：\r\n```\r\n" + body + "\r\n```");
				}
				return ToolExecResult.From(true, "文件: " + path + "（" + info.Length + " 字节，" + ext + "）。内容较大或二进制，请用 run_powershell 读取。");
			}
			catch (Exception ex)
			{
				return ToolExecResult.From(false, "读取文件失败: " + ex.Message);
			}
		}

		private static ToolExecResult ExecListSkills(string skillsDir, string keyword)
		{
			List<string> lines = Skills.List(skillsDir);
			if (lines == null || lines.Count == 0)
			{
				return ToolExecResult.From(false, "技能库里没有找到技能（目录: " + skillsDir + "）。");
			}
			string filter = (keyword == null) ? "" : keyword.Trim().ToLowerInvariant();
			StringBuilder sb = new StringBuilder();
			int count = 0;
			for (int i = 0; i < lines.Count; i++)
			{
				string line = lines[i];
				if (filter.Length > 0 && line.ToLowerInvariant().IndexOf(filter, StringComparison.Ordinal) < 0)
				{
					continue;
				}
				sb.AppendLine("- " + line);
				count++;
			}
			if (count == 0)
			{
				return ToolExecResult.From(true, "没有匹配「" + keyword + "」的技能。");
			}
			sb.Insert(0, "共 " + count + " 个技能（name — 简介）：\r\n");
			sb.Append("需要细节时调用 read_skill(skill_name=...)。");
			return ToolExecResult.From(true, sb.ToString());
		}

		private static ToolExecResult ExecReadSkill(string skillsDir, string skillName)
		{
			string name = (skillName == null) ? "" : skillName.Trim();
			if (name.Length == 0)
			{
				return ToolExecResult.From(false, "参数 skill_name 为空，请先调用 list_skills。");
			}
			string file = Skills.FindSkillFile(skillsDir, name);
			if (file == null)
			{
				return ToolExecResult.From(false, "没有找到技能「" + name + "」。请先调用 list_skills 确认名字。");
			}
			try
			{
				string body = File.ReadAllText(file);
				if (body.Length > 60000)
				{
					body = body.Substring(0, 60000) + "\r\n\r\n（内容超过 60000 字符，已截断）";
				}
				return ToolExecResult.From(true, "技能 " + name + "（" + file + "）：\r\n" + body);
			}
			catch (Exception ex)
			{
				return ToolExecResult.From(false, "读取技能失败: " + ex.Message);
			}
		}

		// ---------------- 参数取值（宽松解析，模型偶尔会把数字写成字符串） ----------------

		public static string ArgStr(Dictionary<string, object> args, string key, string fallback)
		{
			object value = Json.Get(args, key);
			if (value == null)
			{
				return fallback;
			}
			string text = value.ToString();
			return string.IsNullOrEmpty(text) ? fallback : text;
		}

		public static int ArgInt(Dictionary<string, object> args, string key, int fallback)
		{
			object value = Json.Get(args, key);
			if (value == null)
			{
				return fallback;
			}
			try
			{
				return Convert.ToInt32(value);
			}
			catch
			{
				int parsed;
				if (int.TryParse(value.ToString().Trim(), out parsed))
				{
					return parsed;
				}
				return fallback;
			}
		}

		public static List<int> ArgIntList(Dictionary<string, object> args, string key)
		{
			List<int> values = new List<int>();
			object raw = Json.Get(args, key);
			List<object> items = Json.List(raw);
			if (items != null)
			{
				for (int i = 0; i < items.Count; i++)
				{
					try
					{
						values.Add(Convert.ToInt32(items[i]));
					}
					catch
					{
					}
				}
				return values;
			}
			if (raw == null)
			{
				return values;
			}
			// 兼容 "91,82" / "91 82" 这种写法
			string[] parts = raw.ToString().Split(new char[] { ',', ' ', ';', '|' }, StringSplitOptions.RemoveEmptyEntries);
			for (int i = 0; i < parts.Length; i++)
			{
				int parsed;
				if (int.TryParse(parts[i].Trim(), out parsed))
				{
					values.Add(parsed);
				}
			}
			return values;
		}

		// ---------------- JSON Schema 小工具 ----------------

		private static Dictionary<string, object> Schema(string[] required, params Dictionary<string, object>[] properties)
		{
			Dictionary<string, object> props = new Dictionary<string, object>();
			for (int i = 0; i < properties.Length; i++)
			{
				Dictionary<string, object> property = properties[i];
				props[(string)property["__name"]] = property;
			}
			// 清掉内部使用的 __name 键，避免污染 schema
			foreach (KeyValuePair<string, object> pair in props)
			{
				((Dictionary<string, object>)pair.Value).Remove("__name");
			}
			List<object> req = new List<object>();
			for (int i = 0; required != null && i < required.Length; i++)
			{
				req.Add(required[i]);
			}
			Dictionary<string, object> schema = new Dictionary<string, object>();
			schema["type"] = "object";
			schema["properties"] = props;
			schema["required"] = req;
			return schema;
		}

		private static Dictionary<string, object> Prop(string name, string type, string description)
		{
			return Prop(name, type, description, null);
		}

		private static Dictionary<string, object> Prop(string name, string type, string description, string[] enumValues)
		{
			Dictionary<string, object> property = new Dictionary<string, object>();
			property["__name"] = name;
			property["type"] = type;
			property["description"] = description;
			if (type == "array")
			{
				Dictionary<string, object> items = new Dictionary<string, object>();
				items["type"] = "integer";
				property["items"] = items;
			}
			if (enumValues != null && enumValues.Length > 0)
			{
				List<object> allowed = new List<object>();
				for (int i = 0; i < enumValues.Length; i++)
				{
					allowed.Add(enumValues[i]);
				}
				property["enum"] = allowed;
			}
			return property;
		}
	}
}
