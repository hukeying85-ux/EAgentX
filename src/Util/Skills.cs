using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;

namespace EAgentX.Util
{
	/// <summary>
	/// 测试版：把内嵌的 26 个技能解压到 &lt;工作目录&gt;\.eagentx\skills\。
	/// 用 .version 文件做幂等标记，重复调用不会反复解压。
	/// </summary>
	public static class Skills
	{
		private const string ResourceName = "skills.zip";

		private const string Version = "eagent-2026-10-19";

		public static string Ensure(Settings s)
		{
			if (s == null || string.IsNullOrEmpty(s.WorkDir))
			{
				return null;
			}
			string target = Path.Combine(s.WorkDir, ".eagentx", "skills");
			string marker = Path.Combine(target, ".version");
			try
			{
				if (File.Exists(marker) && File.ReadAllText(marker).Trim() == Version && CountSkills(target) > 0)
				{
					return target;
				}
				Directory.CreateDirectory(target);
				Assembly assembly = typeof(Skills).Assembly;
				using (Stream stream = assembly.GetManifestResourceStream(ResourceName))
				{
					if (stream == null)
					{
						Log.Error("没有找到内嵌技能包资源: " + ResourceName);
						return null;
					}
					using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
					{
						string root = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
						foreach (ZipArchiveEntry entry in archive.Entries)
						{
							if (string.IsNullOrEmpty(entry.Name))
							{
								continue;
							}
							string full = Path.GetFullPath(Path.Combine(target, entry.FullName.Replace('/', '\\')));
							if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
							{
								continue;
							}
							string folder = Path.GetDirectoryName(full);
							if (!string.IsNullOrEmpty(folder))
							{
								Directory.CreateDirectory(folder);
							}
							using (Stream input = entry.Open())
							using (FileStream output = new FileStream(full, FileMode.Create, FileAccess.Write, FileShare.None))
							{
								input.CopyTo(output);
							}
						}
					}
				}
				File.WriteAllText(marker, Version);
				Log.Info("技能包已解压: " + target + "（" + CountSkills(target) + " 个技能）");
				return target;
			}
			catch (Exception ex)
			{
				Log.Error("解压技能包失败: " + ex.Message);
				return null;
			}
		}

		/// <summary>
		/// 方案三：给 list_skills 工具用。返回 "技能名 — 一句话简介" 列表。
		/// 技能包是「分类/技能名/SKILL.md」两层结构，技能名取目录名。
		/// </summary>
		public static List<string> List(string root)
		{
			List<string> lines = new List<string>();
			try
			{
				if (string.IsNullOrEmpty(root) || !Directory.Exists(root))
				{
					return lines;
				}
				string[] files = Directory.GetFiles(root, "SKILL.md", SearchOption.AllDirectories);
				Array.Sort(files, StringComparer.OrdinalIgnoreCase);
				for (int i = 0; i < files.Length; i++)
				{
					string name = Path.GetFileName(Path.GetDirectoryName(files[i]));
					string summary = FirstSummary(files[i]);
					lines.Add((summary.Length == 0) ? name : (name + " — " + summary));
				}
			}
			catch
			{
			}
			return lines;
		}

		/// <summary>按技能名（目录名，或「分类/技能名」）定位 SKILL.md；找不到返回 null。</summary>
		public static string FindSkillFile(string root, string name)
		{
			try
			{
				if (string.IsNullOrEmpty(root) || string.IsNullOrEmpty(name) || !Directory.Exists(root))
				{
					return null;
				}
				string target = name.Replace('\\', '/').Trim().Trim('/');
				string[] files = Directory.GetFiles(root, "SKILL.md", SearchOption.AllDirectories);
				string loose = null;
				for (int i = 0; i < files.Length; i++)
				{
					string folder = Path.GetDirectoryName(files[i]);
					string leaf = Path.GetFileName(folder);
					string relative = folder.Substring(root.Length).Replace('\\', '/').Trim('/');
					if (string.Equals(relative, target, StringComparison.OrdinalIgnoreCase))
					{
						return files[i];
					}
					if (string.Equals(leaf, target, StringComparison.OrdinalIgnoreCase) && loose == null)
					{
						loose = files[i];
					}
				}
				return loose;
			}
			catch
			{
				return null;
			}
		}

		/// <summary>取 SKILL.md 里的第一段有效说明（跳过标题、空行与 front matter）。</summary>
		private static string FirstSummary(string file)
		{
			try
			{
				string[] lines = File.ReadAllLines(file);
				bool inFrontMatter = false;
				for (int i = 0; i < lines.Length && i < 60; i++)
				{
					string line = (lines[i] == null) ? "" : lines[i].Trim();
					if (i == 0 && line == "---")
					{
						inFrontMatter = true;
						continue;
					}
					if (inFrontMatter)
					{
						if (line == "---")
						{
							inFrontMatter = false;
						}
						continue;
					}
					if (line.Length == 0 || line[0] == '#' || line.StartsWith("```", StringComparison.Ordinal))
					{
						continue;
					}
					string text = line.TrimStart('-', '*', '>', ' ');
					if (text.Length > 90)
					{
						text = text.Substring(0, 90) + "…";
					}
					return text;
				}
			}
			catch
			{
			}
			return "";
		}

		/// <summary>统计含 SKILL.md 的技能目录数（技能包是「分类/技能名/SKILL.md」两层结构）。</summary>
		public static int CountSkills(string root)
		{
			try
			{
				if (!Directory.Exists(root))
				{
					return 0;
				}
				int count = 0;
				string[] files = Directory.GetFiles(root, "SKILL.md", SearchOption.AllDirectories);
				count = files.Length;
				return count;
			}
			catch
			{
				return 0;
			}
		}
	}
}
