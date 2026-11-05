using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using EAgentX.Engines;
using EAgentX.Util;

namespace EAgentX.Core
{
	/// <summary>
	/// 单纯的 Server-Sent Events 逐行解析器（零 NuGet 依赖）。
	/// 只关心 data: 行，按 SSE 规范把连续多行 data 用 \n 拼成一条事件；
	/// 注释行（:）与其它字段（event/id/retry）忽略。调用方负责用 data == "[DONE]" 收尾。
	/// </summary>
	public class SseReader
	{
		private readonly TextReader Reader;

		private readonly StringBuilder Data = new StringBuilder();

		private bool HasData;

		public SseReader(TextReader reader)
		{
			Reader = reader;
		}

		/// <summary>读下一个事件的数据体；流结束返回 null。</summary>
		public async Task<string> ReadEventAsync()
		{
			if (Reader == null)
			{
				return null;
			}
			while (true)
			{
				string line = await Reader.ReadLineAsync().ConfigureAwait(false);
				if (line == null)
				{
					if (HasData)
					{
						string tail = Data.ToString();
						Data.Length = 0;
						HasData = false;
						return tail;
					}
					return null;
				}
				if (line.Length == 0)
				{
					// 空行 = 事件分隔符
					if (HasData)
					{
						string body = Data.ToString();
						Data.Length = 0;
						HasData = false;
						return body;
					}
					continue;
				}
				if (line[0] == ':')
				{
					// 心跳 / 注释
					continue;
				}
				if (!line.StartsWith("data:", StringComparison.Ordinal))
				{
					continue;
				}
				string payload = line.Substring(5);
				if (payload.Length > 0 && payload[0] == ' ')
				{
					payload = payload.Substring(1);
				}
				if (HasData)
				{
					Data.Append('\n');
				}
				Data.Append(payload);
				HasData = true;
			}
		}

		/// <summary>
		/// 把一段可能包着 SSE 的文本拆成 data 事件列表（HTTP 传输里 MCP 也可能返回单次 text/event-stream）。
		/// </summary>
		public static List<string> Split(string text)
		{
			List<string> events = new List<string>();
			if (text == null)
			{
				return events;
			}
			string[] lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
			StringBuilder current = new StringBuilder();
			bool has = false;
			for (int i = 0; i < lines.Length; i++)
			{
				string line = lines[i];
				if (line.Length == 0)
				{
					if (has)
					{
						events.Add(current.ToString());
						current.Length = 0;
						has = false;
					}
					continue;
				}
				if (line[0] == ':' || !line.StartsWith("data:", StringComparison.Ordinal))
				{
					continue;
				}
				string payload = line.Substring(5);
				if (payload.Length > 0 && payload[0] == ' ')
				{
					payload = payload.Substring(1);
				}
				if (has)
				{
					current.Append('\n');
				}
				current.Append(payload);
				has = true;
			}
			if (has)
			{
				events.Add(current.ToString());
			}
			return events;
		}
	}

	/// <summary>
	/// Chat Completions 响应解析（普通 JSON 与 SSE 流式两种形态）。
	/// 流式 tool_calls 的 arguments 会拆成多个 chunk 下发，必须按 index 用 StringBuilder 拼齐，
	/// 否则拼出来的 JSON 是残缺的，下一轮回传会直接 400。
	/// </summary>
	public static class ChatStreamParser
	{
		/// <summary>流式聚合中的单个 tool_call 分片累加器。</summary>
		public sealed class ToolCallAccumulator
		{
			public int Index;

			public string Id = "";

			public string Name = "";

			public readonly StringBuilder Arguments = new StringBuilder();

			public int Order;
		}

		/// <summary>解析非流式 JSON 响应体。</summary>
		public static ChatTurnResponse ParseResponse(string body)
		{
			Dictionary<string, object> root = Json.Obj(Json.Decode(body));
			if (root == null)
			{
				throw new Exception("API 响应不是合法 JSON: " + Truncate(body, 300));
			}
			List<object> choices = Json.List(Json.Get(root, "choices"));
			if (choices == null || choices.Count == 0)
			{
				throw new Exception("API 响应里没有 choices: " + Truncate(body, 300));
			}
			Dictionary<string, object> choice = Json.Obj(choices[0]);
			Dictionary<string, object> message = Json.Obj(Json.Get(choice, "message"));
			ChatTurnResponse turn = new ChatTurnResponse();
			turn.Content = HttpUtil.TextOrEmpty(Json.GetStr(message, "content"));
			turn.ReasoningContent = HttpUtil.TextOrEmpty(Json.GetStr(message, "reasoning_content"));
			turn.FinishReason = HttpUtil.TextOrEmpty(Json.GetStr(choice, "finish_reason"));
			List<object> toolCalls = Json.List(Json.Get(message, "tool_calls"));
			if (toolCalls != null)
			{
				for (int i = 0; i < toolCalls.Count; i++)
				{
					Dictionary<string, object> item = Json.Obj(toolCalls[i]);
					Dictionary<string, object> function = Json.Obj(Json.Get(item, "function"));
					ToolCallRequest request = new ToolCallRequest();
					request.Id = HttpUtil.TextOrEmpty(Json.GetStr(item, "id"));
					request.Name = HttpUtil.TextOrEmpty(Json.GetStr(function, "name"));
					request.ArgumentsJson = HttpUtil.TextOrEmpty(Json.GetStr(function, "arguments"));
					if (request.Name.Length > 0)
					{
						turn.ToolCalls.Add(request);
					}
				}
			}
			return turn;
		}

		/// <summary>聚合过程中的增量流。</summary>
		public sealed class StreamState
		{
			public readonly StringBuilder Content = new StringBuilder();

			public readonly StringBuilder Reasoning = new StringBuilder();

			public readonly Dictionary<int, ToolCallAccumulator> Calls = new Dictionary<int, ToolCallAccumulator>();

			public int NextOrder;

			public string FinishReason = "";
		}

		/// <summary>解析单条 SSE data 事件并累加到 state；返回 false 表示收到 [DONE]。</summary>
		public static bool ApplyChunk(string data, StreamState state, Action<string> onContentDelta, Action<string> onReasoningDelta)
		{
			if (state == null || string.IsNullOrEmpty(data))
			{
				return true;
			}
			if (data.Trim() == "[DONE]")
			{
				return false;
			}
			Dictionary<string, object> root = Json.Obj(Json.Decode(data));
			if (root == null)
			{
				// 有些网关会夹带空对象 / 心跳 JSON，跳过即可
				return true;
			}
			List<object> choices = Json.List(Json.Get(root, "choices"));
			if (choices == null || choices.Count == 0)
			{
				return true;
			}
			Dictionary<string, object> choice = Json.Obj(choices[0]);
			string finish = Json.GetStr(choice, "finish_reason");
			if (!string.IsNullOrEmpty(finish))
			{
				state.FinishReason = finish;
			}
			Dictionary<string, object> delta = Json.Obj(Json.Get(choice, "delta"));
			if (delta == null)
			{
				delta = Json.Obj(Json.Get(choice, "message"));
			}
			if (delta == null)
			{
				return true;
			}
			string content = Json.GetStr(delta, "content");
			if (!string.IsNullOrEmpty(content))
			{
				state.Content.Append(content);
				if (onContentDelta != null)
				{
					onContentDelta(content);
				}
			}
			string reasoning = Json.GetStr(delta, "reasoning_content");
			if (string.IsNullOrEmpty(reasoning))
			{
				reasoning = Json.GetStr(delta, "reasoning");
			}
			if (!string.IsNullOrEmpty(reasoning))
			{
				state.Reasoning.Append(reasoning);
				if (onReasoningDelta != null)
				{
					onReasoningDelta(reasoning);
				}
			}
			List<object> toolCalls = Json.List(Json.Get(delta, "tool_calls"));
			if (toolCalls != null)
			{
				for (int i = 0; i < toolCalls.Count; i++)
				{
					ApplyToolCallDelta(Json.Obj(toolCalls[i]), state);
				}
			}
			return true;
		}

		private static void ApplyToolCallDelta(Dictionary<string, object> item, StreamState state)
		{
			if (item == null)
			{
				return;
			}
			int index = Json.GetInt(item, "index", state.NextOrder);
			ToolCallAccumulator accumulator;
			if (!state.Calls.TryGetValue(index, out accumulator))
			{
				accumulator = new ToolCallAccumulator();
				accumulator.Index = index;
				accumulator.Order = state.NextOrder++;
				state.Calls[index] = accumulator;
			}
			string id = Json.GetStr(item, "id");
			if (!string.IsNullOrEmpty(id) && accumulator.Id.Length == 0)
			{
				accumulator.Id = id;
			}
			Dictionary<string, object> function = Json.Obj(Json.Get(item, "function"));
			if (function == null)
			{
				return;
			}
			string name = Json.GetStr(function, "name");
			if (!string.IsNullOrEmpty(name) && accumulator.Name.Length == 0)
			{
				accumulator.Name = name;
			}
			object arguments = Json.Get(function, "arguments");
			if (arguments == null)
			{
				return;
			}
			if (arguments is Dictionary<string, object>)
			{
				// 少数网关会直接下发对象而非字符串
				accumulator.Arguments.Append(Json.Encode(arguments));
				return;
			}
			accumulator.Arguments.Append(arguments.ToString());
		}

		/// <summary>把聚合结果转成正式的一轮响应。</summary>
		public static ChatTurnResponse Complete(StreamState state)
		{
			ChatTurnResponse turn = new ChatTurnResponse();
			if (state == null)
			{
				return turn;
			}
			turn.Content = state.Content.ToString();
			turn.ReasoningContent = state.Reasoning.ToString();
			turn.FinishReason = state.FinishReason;
			List<ToolCallAccumulator> ordered = new List<ToolCallAccumulator>(state.Calls.Values);
			ordered.Sort(delegate(ToolCallAccumulator a, ToolCallAccumulator b)
			{
				return a.Order.CompareTo(b.Order);
			});
			for (int i = 0; i < ordered.Count; i++)
			{
				ToolCallAccumulator accumulator = ordered[i];
				if (accumulator.Name.Length == 0)
				{
					// 没有函数名的分片是坏数据，丢掉比回传 400 好
					continue;
				}
				ToolCallRequest request = new ToolCallRequest();
				request.Id = (accumulator.Id.Length == 0) ? ("call_" + i + "_" + DateTime.Now.Ticks.ToString()) : accumulator.Id;
				request.Name = accumulator.Name;
				request.ArgumentsJson = accumulator.Arguments.ToString();
				turn.ToolCalls.Add(request);
			}
			return turn;
		}

		/// <summary>按字节流逐事件读取（供 HTTP SSE 与 TcpListener 自检共用）。</summary>
		public static async Task<ChatTurnResponse> ReadStreamAsync(TextReader reader, StreamState state, Action<string> onContentDelta, Action<string> onReasoningDelta, CancellationToken ct)
		{
			SseReader sse = new SseReader(reader);
			while (true)
			{
				ct.ThrowIfCancellationRequested();
				string data = await sse.ReadEventAsync().ConfigureAwait(false);
				if (data == null)
				{
					break;
				}
				if (!ApplyChunk(data, state, onContentDelta, onReasoningDelta))
				{
					break;
				}
			}
			return Complete(state);
		}

		private static string Truncate(string text, int max)
		{
			if (text == null)
			{
				return "";
			}
			if (text.Length <= max)
			{
				return text;
			}
			return text.Substring(0, max);
		}
	}

	/// <summary>几处重复的小工具：空值归一、HTTP 头解析、字节解码。</summary>
	public static class HttpUtil
	{
		public static string TextOrEmpty(string value)
		{
			return (value == null) ? "" : value;
		}

		/// <summary>
		/// 严格 UTF-8 解码；失败（比如 GBK 输出）时退回 GB18030，再不行按 Latin1 兜底，保证不抛异常。
		/// </summary>
		public static string DecodeUtf8(byte[] bytes)
		{
			if (bytes == null || bytes.Length == 0)
			{
				return "";
			}
			int offset = 0;
			int count = bytes.Length;
			if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
			{
				offset = 3;
				count -= 3;
			}
			try
			{
				return new UTF8Encoding(false, true).GetString(bytes, offset, count);
			}
			catch
			{
			}
			try
			{
				return Encoding.GetEncoding(936).GetString(bytes, offset, count);
			}
			catch
			{
			}
			try
			{
				return Encoding.GetEncoding("ISO-8859-1").GetString(bytes, offset, count);
			}
			catch
			{
			}
			return "";
		}

		/// <summary>判断 Content-Type 是否是 SSE（大小写与参数都不敏感）。</summary>
		public static bool IsEventStream(string contentType)
		{
			if (string.IsNullOrEmpty(contentType))
			{
				return false;
			}
			return contentType.IndexOf("text/event-stream", StringComparison.OrdinalIgnoreCase) >= 0;
		}

	}
}
