using System;
using System.Threading;
using System.Threading.Tasks;

namespace EAgentX.Engines
{
	/// <summary>
	/// 对话引擎抽象：网页版（CDP 页面自动化）和 API 模式实现同一套接口，
	/// 所以 AgentSession 的主循环对两者完全一致。
	/// </summary>
	public interface IChatEngine : IDisposable
	{
		/// <summary>引擎名，显示在状态栏和日志里。</summary>
		string Name { get; }

		/// <summary>最近一次连接/页面诊断信息。</summary>
		string Diagnostics { get; }

		/// <summary>开始一段新对话，返回一行人类可读的状态。</summary>
		Task<string> StartAsync(CancellationToken ct);

		/// <summary>发送一条消息，返回模型完整的回复文本。attachments 非空时作为附件一起发送。</summary>
		Task<string> SendAsync(string text, string[] attachments, CancellationToken ct);

		/// <summary>
		/// 开启一段新对话：网页版回到起始页，API 版清空消息历史并重新压入系统提示词。
		/// 修复「新建会话后旧上下文残留 / 首轮丢失系统提示词」的既有 Bug。
		/// </summary>
		Task ResetAsync(CancellationToken ct);
	}
}
