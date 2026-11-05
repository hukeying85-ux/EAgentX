using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace EAgentX.Engines
{
	/// <summary>
	/// 一个可被模型调用的工具定义（OpenAI tools[].function 的宿主侧镜像）。
	/// ParametersSchema 直接就是 JSON Schema 对象，序列化后原样放进请求体。
	/// </summary>
	public class ToolDefinition
	{
		public string Name;

		public string Description;

		/// <summary>JSON Schema：{ "type": "object", "properties": {...}, "required": [...] }</summary>
		public Dictionary<string, object> ParametersSchema;

		public ToolDefinition()
		{
			ParametersSchema = EmptySchema();
		}

		public ToolDefinition(string name, string description, Dictionary<string, object> schema)
		{
			Name = name;
			Description = description;
			ParametersSchema = ((schema == null) ? EmptySchema() : schema);
		}

		/// <summary>生成 OpenAI 兼容的 { type: "function", function: { name, description, parameters } }。</summary>
		public Dictionary<string, object> ToApiFormat()
		{
			Dictionary<string, object> function = new Dictionary<string, object>();
			function["name"] = Name;
			function["description"] = (Description == null) ? "" : Description;
			function["parameters"] = ((ParametersSchema == null) ? EmptySchema() : ParametersSchema);
			Dictionary<string, object> root = new Dictionary<string, object>();
			root["type"] = "function";
			root["function"] = function;
			return root;
		}

		public static Dictionary<string, object> EmptySchema()
		{
			Dictionary<string, object> schema = new Dictionary<string, object>();
			schema["type"] = "object";
			schema["properties"] = new Dictionary<string, object>();
			schema["required"] = new List<object>();
			return schema;
		}
	}

	/// <summary>模型这一轮发起的一次工具调用。Id 必须原样回传，否则下一轮 API 报 400。</summary>
	public class ToolCallRequest
	{
		public string Id;

		public string Name;

		/// <summary>函数参数原文（JSON 字符串；流式分片已在引擎里拼齐）。</summary>
		public string ArgumentsJson;
	}

	/// <summary>宿主执行完一次工具调用后的回包，最终会变成一条 role:"tool" 消息。</summary>
	public class ToolCallResponse
	{
		public string ToolCallId;

		public string Name;

		/// <summary>给模型看的纯文本结果（截图也只放文本摘要，见 ApiVisionEnabled）。</summary>
		public string Content;

		/// <summary>需要作为视觉附件追加的本地图片路径（仅视觉模型生效）。</summary>
		public string[] Attachments;

		public bool Ok;

		public ToolCallResponse()
		{
			Ok = true;
		}

		public ToolCallResponse(string toolCallId, string name, string content, bool ok)
		{
			ToolCallId = toolCallId;
			Name = name;
			Content = content;
			Ok = ok;
		}
	}

	/// <summary>一次完整对话轮次（含可能的多个工具调用）的结果。</summary>
	public class ChatTurnResponse
	{
		public string Content;

		/// <summary>深度思考内容（DeepSeek Reasoner / R1 的 reasoning_content）。</summary>
		public string ReasoningContent;

		public List<ToolCallRequest> ToolCalls;

		public string FinishReason;

		public ChatTurnResponse()
		{
			Content = "";
			ReasoningContent = "";
			ToolCalls = new List<ToolCallRequest>();
			FinishReason = "";
		}

		public bool HasToolCalls
		{
			get
			{
				return ToolCalls != null && ToolCalls.Count > 0;
			}
		}
	}

	/// <summary>
	/// 原生工具调用引擎扩展契约：向下 100% 兼容 IChatEngine（SelfTest 里的假引擎不用改），
	/// AgentSession 只有在 S.ApiNativeTools 打开且引擎实现了本接口时才走结构化循环。
	/// </summary>
	public interface IToolChatEngine : IChatEngine
	{
		/// <summary>本引擎当前是否启用原生 tools（关闭时 AgentSession 回到文本代码块协议）。</summary>
		bool UseNativeTools { get; }

		/// <summary>
		/// 发送一轮对话：userText 是新的用户文本（为 null 表示只回传上一轮的工具结果），
		/// toolOutputs 是上一轮所有 tool_calls 的执行结果（必须与 ToolCalls 一一对应）。
		/// onContentDelta 非空时逐块回调流式增量文本。
		/// </summary>
		Task<ChatTurnResponse> SendTurnAsync(string userText, string[] attachments, List<ToolCallResponse> toolOutputs, IList<ToolDefinition> tools, Action<string> onContentDelta, Action<string> onReasoningDelta, CancellationToken ct);
	}
}
