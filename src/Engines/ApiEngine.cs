using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using EAgentX.Core;
using EAgentX.Util;

namespace EAgentX.Engines
{
	/// <summary>
	/// OpenAI 兼容接口引擎（DeepSeek / 通义 / 本地 Ollama…），自己维护完整消息历史。
	/// 方案三升级：
	///   1. 原生 tools / function calling（S.ApiNativeTools），流式与非流式都支持；
	///   2. SSE 逐字流式（S.ApiStream），按 index 拼接跨 chunk 的 delta.tool_calls 参数；
	///   3. role:"tool" 回包永远是纯文本，截图仅在 S.ApiVisionEnabled 时追加一条 image_url 用户消息；
	///   4. ResetAsync 清空历史并重新压入系统提示词（修复新建会话不清上下文的 Bug）。
	/// 关闭原生工具时，旧的 SendAsync（文本代码块协议）行为完全不变。
	/// </summary>
	public class ApiEngine : IToolChatEngine, IDisposable
	{
		private readonly Settings S;

		private readonly HttpClient Http;

		private readonly List<Dictionary<string, object>> Messages = new List<Dictionary<string, object>>();

		private string SkillsDir;

		/// <summary>本轮附加的视觉图片（截图），下一轮请求前以 user 消息追加进历史。</summary>
		private readonly List<string> PendingVisionImages = new List<string>();

		public string Name
		{
			get
			{
				return UseNativeTools ? "API 模式（OpenAI 兼容 · 原生工具）" : "API 模式（OpenAI 兼容）";
			}
		}

		public string Diagnostics { get; private set; }

		/// <summary>只有设置里开了原生工具才走结构化路径；否则 AgentSession 仍用文本协议。</summary>
		public bool UseNativeTools
		{
			get
			{
				return S.ApiNativeTools;
			}
		}

		/// <summary>最近一轮使用的工具数量（诊断用）。</summary>
		public int LastToolCount { get; private set; }

		/// <summary>最近一轮是否走了 SSE。</summary>
		public bool LastUsedStream { get; private set; }

		public ApiEngine(Settings settings)
		{
			S = settings;
			Http = new HttpClient();
			Http.Timeout = TimeSpan.FromSeconds(Math.Max(30, S.ReplyTimeoutSec));
			Diagnostics = "";
		}

		// ---------------- IChatEngine ----------------

		public Task<string> StartAsync(CancellationToken ct)
		{
			// 本地端点（Ollama 之类）不需要 Key
			if (string.IsNullOrEmpty(S.ApiKey) && !IsLocalEndpoint())
			{
				throw new Exception("API 模式需要在设置里填写 API Key（本地 Ollama 等可留空）。");
			}
			Messages.Clear();
			ResetSystemMessage();
			Diagnostics = "API: " + Endpoint() + "  模型: " + S.ApiModel + (UseNativeTools ? "  原生工具: 开" : "  原生工具: 关") + (S.ApiStream ? "  流式: 开" : "  流式: 关");
			return Task.FromResult(Diagnostics);
		}

		/// <summary>新建会话：清空历史 + 重新压入系统提示词。</summary>
		public Task ResetAsync(CancellationToken ct)
		{
			Messages.Clear();
			PendingVisionImages.Clear();
			ResetSystemMessage();
			Diagnostics = "已开启新对话（历史已清空） · " + Endpoint() + "  模型: " + S.ApiModel;
			return Task.FromResult(0);
		}

		private void ResetSystemMessage()
		{
			Messages.Add(Message("system", PromptBuilder.NativeTools(S, SkillsDir)));
		}

		/// <summary>AgentSession 注入技能目录，用于系统提示词与 list_skills。</summary>
		public void SetSkillsDir(string skillsDir)
		{
			SkillsDir = skillsDir;
		}

		private bool IsLocalEndpoint()
		{
			string baseUrl = (S.ApiBase ?? "").ToLowerInvariant();
			if (!baseUrl.Contains("127.0.0.1"))
			{
				return baseUrl.Contains("localhost");
			}
			return true;
		}

		/// <summary>Base URL 归一化：支持以 /v1 或 /chat/completions 结尾的写法。</summary>
		private string Endpoint()
		{
			string baseUrl = (S.ApiBase ?? "").Trim().TrimEnd('/');
			if (baseUrl.Length == 0)
			{
				baseUrl = "https://api.deepseek.com/v1";
			}
			if (baseUrl.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase))
			{
				return baseUrl;
			}
			if (baseUrl.EndsWith("/v1", StringComparison.OrdinalIgnoreCase))
			{
				return baseUrl + "/chat/completions";
			}
			return baseUrl + "/v1/chat/completions";
		}

		private static Dictionary<string, object> Message(string role, object content)
		{
			Dictionary<string, object> message = new Dictionary<string, object>();
			message["role"] = role;
			message["content"] = content;
			return message;
		}

		// ---------------- 文本协议（原生工具关闭时） ----------------

		public async Task<string> SendAsync(string text, string[] attachments, CancellationToken ct)
		{
			Messages.Add(Message("user", BuildContent(text, attachments)));
			Dictionary<string, object> body = new Dictionary<string, object>();
			body["model"] = S.ApiModel;
			body["messages"] = Messages;
			body["stream"] = false;
			body["temperature"] = 0.3;
			ChatTurnResponse turn = await PostAsync(body, false, null, null, ct).ConfigureAwait(false);
			string content = ((turn.Content == null) ? "" : turn.Content);
			if (content.Length == 0)
			{
				content = ((turn.ReasoningContent == null) ? "" : turn.ReasoningContent);
			}
			Messages.Add(Message("assistant", content));
			return content;
		}

		// ---------------- 原生工具协议 ----------------

		public async Task<ChatTurnResponse> SendTurnAsync(string userText, string[] attachments, List<ToolCallResponse> toolOutputs, IList<ToolDefinition> tools, Action<string> onContentDelta, Action<string> onReasoningDelta, CancellationToken ct)
		{
			FlushVisionImages();
			if (toolOutputs != null && toolOutputs.Count > 0)
			{
				// 硬性协议：assistant 里每个 tool_calls[].id 都必须紧跟一条 role:"tool" + tool_call_id
				AppendToolMessages(toolOutputs);
			}
			if (userText != null)
			{
				Messages.Add(Message("user", BuildContent(userText, attachments)));
			}
			else if (Messages.Count <= 1)
			{
				throw new Exception("还没有可发送的内容：请先输入任务。");
			}

			bool stream = S.ApiStream;
			ChatTurnResponse turn = null;
			string lastError = null;
			for (int round = 0; round < 2; round++)
			{
				Dictionary<string, object> body = BuildRequestBody(tools, stream);
				bool firstAttempt = (round == 0);
				try
				{
					// 重试那一次不再回调增量，避免界面把已经显示的半截内容再刷一遍
					turn = await PostAsync(body, stream, firstAttempt ? onContentDelta : null, firstAttempt ? onReasoningDelta : null, ct).ConfigureAwait(false);
					LastUsedStream = stream;
					break;
				}
				catch (Exception ex)
				{
					if (!stream || round > 0 || IsCancelled(ex, ct))
					{
						throw;
					}
					// 网关不支持 stream（或把 tools 与 stream 一起拒了）：降级为非流式重试一次
					lastError = ex.Message;
					Log.Dim("流式请求失败，降级为非流式重试: " + lastError);
					stream = false;
				}
			}
			if (turn == null)
			{
				throw new Exception("请求失败: " + lastError);
			}
			LastToolCount = (turn.ToolCalls == null) ? 0 : turn.ToolCalls.Count;
			Messages.Add(AssistantMessage(turn));
			return turn;
		}

		private static bool IsCancelled(Exception ex, CancellationToken ct)
		{
			if (ct.IsCancellationRequested)
			{
				return true;
			}
			return ex is OperationCanceledException;
		}

		private Dictionary<string, object> BuildRequestBody(IList<ToolDefinition> tools, bool stream)
		{
			Dictionary<string, object> body = new Dictionary<string, object>();
			body["model"] = S.ApiModel;
			body["messages"] = Messages;
			body["stream"] = stream;
			body["temperature"] = 0.3;
			if (tools != null && tools.Count > 0)
			{
				List<object> serialized = new List<object>();
				for (int i = 0; i < tools.Count; i++)
				{
					if (tools[i] != null && !string.IsNullOrEmpty(tools[i].Name))
					{
						serialized.Add(tools[i].ToApiFormat());
					}
				}
				if (serialized.Count > 0)
				{
					body["tools"] = serialized;
					body["tool_choice"] = "auto";
				}
			}
			return body;
		}

		/// <summary>把模型返回的 assistant 消息（含 tool_calls）原样存进历史。</summary>
		private static Dictionary<string, object> AssistantMessage(ChatTurnResponse turn)
		{
			Dictionary<string, object> message = new Dictionary<string, object>();
			message["role"] = "assistant";
			if (turn.HasToolCalls)
			{
				// 有 tool_calls 时 content 允许为空串（部分网关要求显式 null，这里用空串更稳）
				message["content"] = (turn.Content == null) ? "" : turn.Content;
				List<object> calls = new List<object>();
				for (int i = 0; i < turn.ToolCalls.Count; i++)
				{
					ToolCallRequest call = turn.ToolCalls[i];
					Dictionary<string, object> function = new Dictionary<string, object>();
					function["name"] = call.Name;
					function["arguments"] = (call.ArgumentsJson == null) ? "{}" : call.ArgumentsJson;
					Dictionary<string, object> item = new Dictionary<string, object>();
					item["id"] = call.Id;
					item["type"] = "function";
					item["function"] = function;
					calls.Add(item);
				}
				message["tool_calls"] = calls;
			}
			else
			{
				message["content"] = (turn.Content == null) ? "" : turn.Content;
			}
			return message;
		}

		/// <summary>把每个工具结果都变成一条 role:"tool" 消息（不可漏，也不可乱序）。</summary>
		private void AppendToolMessages(List<ToolCallResponse> outputs)
		{
			for (int i = 0; i < outputs.Count; i++)
			{
				ToolCallResponse output = outputs[i];
				Dictionary<string, object> message = new Dictionary<string, object>();
				message["role"] = "tool";
				message["tool_call_id"] = (output.ToolCallId == null) ? "" : output.ToolCallId;
				message["content"] = (output.Content == null) ? "" : output.Content;
				if (!string.IsNullOrEmpty(output.Name))
				{
					message["name"] = output.Name;
				}
				Messages.Add(message);
				// 视觉模型才追加图片；纯文本模型收到 image_url 会 400
				if (S.ApiVisionEnabled && output.Attachments != null)
				{
					for (int j = 0; j < output.Attachments.Length; j++)
					{
						string path = output.Attachments[j];
						if (!string.IsNullOrEmpty(path) && File.Exists(path))
						{
							PendingVisionImages.Add(path);
						}
					}
				}
			}
		}

		/// <summary>截图作为一条独立的 user 消息追加（不塞进 role:"tool" 的 content）。</summary>
		private void FlushVisionImages()
		{
			if (PendingVisionImages.Count == 0)
			{
				return;
			}
			List<string> images = new List<string>(PendingVisionImages);
			PendingVisionImages.Clear();
			if (!S.ApiVisionEnabled)
			{
				return;
			}
			List<object> parts = new List<object>();
			Dictionary<string, object> caption = new Dictionary<string, object>();
			caption["type"] = "text";
			caption["text"] = "上面工具生成的图片附件（共 " + images.Count + " 张），请查看：";
			parts.Add(caption);
			for (int i = 0; i < images.Count; i++)
			{
				Dictionary<string, object> part = ImagePart(images[i]);
				if (part != null)
				{
					parts.Add(part);
				}
			}
			if (parts.Count > 1)
			{
				Messages.Add(Message("user", parts));
			}
		}

		/// <summary>单次 HTTP 请求 + 解析（自动在普通 JSON 与 SSE 之间切换）。</summary>
		private async Task<ChatTurnResponse> PostAsync(Dictionary<string, object> body, bool stream, Action<string> onContentDelta, Action<string> onReasoningDelta, CancellationToken ct)
		{
			string json = Json.Encode(body);
			using (HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Post, Endpoint()))
			{
				request.Content = new StringContent(json, new UTF8Encoding(false), "application/json");
				if (!string.IsNullOrEmpty(S.ApiKey))
				{
					request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", S.ApiKey);
				}
				if (stream)
				{
					request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
				}
				using (CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(ct))
				{
					// 全局超时之外再加一层，避免用户点了「停止」还要等 HttpClient 自己的超时
					linked.CancelAfter(TimeSpan.FromSeconds(S.ReplyTimeoutSec));
					HttpResponseMessage response;
					try
					{
						HttpCompletionOption completion = stream ? HttpCompletionOption.ResponseHeadersRead : HttpCompletionOption.ResponseContentRead;
						response = await Http.SendAsync(request, completion, linked.Token).ConfigureAwait(false);
					}
					catch (OperationCanceledException)
					{
						// 用户点了「停止」和真的超时要分开报，否则会被误认为网络问题
						if (ct.IsCancellationRequested)
						{
							throw;
						}
						throw new TimeoutException("API 请求超时（" + S.ReplyTimeoutSec + " 秒）。");
					}
					using (response)
					{
						string contentType = "";
						try
						{
							contentType = (response.Content.Headers.ContentType == null) ? "" : response.Content.Headers.ContentType.ToString();
						}
						catch
						{
						}
						if (!response.IsSuccessStatusCode)
						{
							string errorBody = "";
							try
							{
								errorBody = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
							}
							catch
							{
							}
							throw new Exception("API 返回 " + (int)response.StatusCode + " " + response.StatusCode + ": " + Truncate(errorBody));
						}
						// 只有服务端真的回了 SSE 才按流解析；老网关往往忽略 stream:true 直接回 JSON
						bool useStream = stream && HttpUtil.IsEventStream(contentType);
						if (!useStream)
						{
							byte[] bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
							string text = HttpUtil.DecodeUtf8(bytes);
							ChatTurnResponse plain = ChatStreamParser.ParseResponse(text);
							if (onContentDelta != null && !string.IsNullOrEmpty(plain.Content))
							{
								onContentDelta(plain.Content);
							}
							if (onReasoningDelta != null && !string.IsNullOrEmpty(plain.ReasoningContent))
							{
								onReasoningDelta(plain.ReasoningContent);
							}
							return plain;
						}
						using (System.IO.Stream raw = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
						using (StreamReader reader = new StreamReader(raw, new UTF8Encoding(false)))
						{
							Task<ChatTurnResponse> readTask = ChatStreamParser.ReadStreamAsync(reader, new ChatStreamParser.StreamState(), onContentDelta, onReasoningDelta, linked.Token);
							try
							{
								return await readTask.ConfigureAwait(false);
							}
							catch (OperationCanceledException)
							{
								if (ct.IsCancellationRequested)
								{
									throw;
								}
								throw new TimeoutException("流式响应超时（" + S.ReplyTimeoutSec + " 秒内没有完成）。");
							}
						}
					}
				}
			}
		}

		// ---------------- 附件 / 图片 ----------------

		/// <summary>
		/// 把附件拼进 API 消息。图片走 image_url(data URL)；
		/// 文本类小文件直接内联；其他文件只能给路径（API 模式读不了 PDF/Office）。
		/// </summary>
		private static object BuildContent(string text, string[] attachments)
		{
			if (attachments == null || attachments.Length == 0)
			{
				return text;
			}
			List<object> parts = new List<object>();
			List<string> notes = new List<string>();
			long totalBytes = 0L;
			for (int i = 0; i < attachments.Length; i++)
			{
				string path = attachments[i];
				if (string.IsNullOrEmpty(path) || !File.Exists(path))
				{
					continue;
				}
				string ext = Path.GetExtension(path).ToLowerInvariant();
				FileInfo info = new FileInfo(path);
				totalBytes += info.Length;
				if (totalBytes > 24L * 1024L * 1024L)
				{
					notes.Add(Path.GetFileName(path) + "（附件总量超过 24MB，已跳过）");
					continue;
				}
				if (IsImageExt(ext))
				{
					Dictionary<string, object> part = ImagePart(path);
					if (part != null)
					{
						parts.Add(part);
						notes.Add(Path.GetFileName(path) + "（图片，已内联）");
					}
					continue;
				}
				bool isText = (ext == ".txt" || ext == ".md" || ext == ".csv" || ext == ".json" || ext == ".log" || ext == ".xml" || ext == ".html" || ext == ".cs" || ext == ".ps1" || ext == ".py" || ext == ".js" || ext == ".ini" || ext == ".yml" || ext == ".yaml");
				if (isText && info.Length <= 100L * 1024L)
				{
					string body = File.ReadAllText(path);
					Dictionary<string, object> part = new Dictionary<string, object>();
					part["type"] = "text";
					part["text"] = "【附件 " + Path.GetFileName(path) + "】\r\n```\r\n" + body + "\r\n```";
					parts.Add(part);
					notes.Add(Path.GetFileName(path) + "（文本，已内联）");
					continue;
				}
				notes.Add(Path.GetFileName(path) + "（API 模式只能给路径：" + path + "）");
			}
			if (parts.Count == 0)
			{
				string onlyText = text;
				if (notes.Count > 0)
				{
					onlyText += "\r\n\r\n【附件说明】\r\n- " + string.Join("\r\n- ", notes.ToArray());
				}
				return onlyText;
			}
			Dictionary<string, object> caption = new Dictionary<string, object>();
			caption["type"] = "text";
			caption["text"] = text + ((notes.Count > 0) ? ("\r\n\r\n【附件说明】\r\n- " + string.Join("\r\n- ", notes.ToArray())) : "");
			parts.Insert(0, caption);
			return parts;
		}

		private static bool IsImageExt(string ext)
		{
			return ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".webp" || ext == ".bmp";
		}

		private static Dictionary<string, object> ImagePart(string path)
		{
			try
			{
				if (string.IsNullOrEmpty(path) || !File.Exists(path))
				{
					return null;
				}
				FileInfo info = new FileInfo(path);
				if (info.Length > 8L * 1024L * 1024L)
				{
					return null;
				}
				string ext = Path.GetExtension(path).ToLowerInvariant();
				string mime = (ext == ".png") ? "image/png" : (ext == ".gif") ? "image/gif" : (ext == ".webp") ? "image/webp" : (ext == ".bmp") ? "image/bmp" : "image/jpeg";
				Dictionary<string, object> imageUrl = new Dictionary<string, object>();
				imageUrl["url"] = "data:" + mime + ";base64," + Convert.ToBase64String(File.ReadAllBytes(path));
				Dictionary<string, object> part = new Dictionary<string, object>();
				part["type"] = "image_url";
				part["image_url"] = imageUrl;
				return part;
			}
			catch
			{
				return null;
			}
		}

		private static string Truncate(string text)
		{
			if (text == null)
			{
				return "";
			}
			string body = text.Trim();
			if (body.Length <= 500)
			{
				return body;
			}
			return body.Substring(0, 500);
		}

		public void Dispose()
		{
			try
			{
				Http.Dispose();
			}
			catch
			{
			}
		}
	}
}
