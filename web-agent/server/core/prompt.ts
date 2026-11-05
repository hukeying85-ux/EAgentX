/**
 * 系统提示词拼装。
 *
 * 结构参照 EAgentX 的 PromptBuilder：本机/会话信息 → 工具协议 → 工作纪律 → 收尾标记。
 * 唯一的分叉是工具协议：支持原生 tool calling 的模型走 JSON Schema，否则走代码块文本协议。
 */

import os from 'node:os';
import { listSkills } from './skillRegistry';

export interface PromptOptions {
  workspace: string;
  sessionId: string;
  approvalMode: string;
  nativeTools: boolean;
  toolNames: string[];
  demo: boolean;
}

function nowText(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function skillCatalogLine(): string {
  const skills = listSkills();
  if (skills.length === 0) return '（技能库未加载）';
  return skills.map((skill) => skill.id).join(', ');
}

const TEXT_PROTOCOL = `你当前使用的模型不支持原生 tool calling，请严格用「代码块工具协议」调用工具：

\`\`\`tool:工具名
{"参数名": "参数值"}
\`\`\`

示例：

\`\`\`tool:write_file
{"path": "index.html", "content": "<h1>hello</h1>"}
\`\`\`

\`\`\`tool:bash
{"command": "ls -la"}
\`\`\`

规则：
- 每条回复最多给 1 个工具代码块，语言标记必须是 tool:工具名；
- 参数必须是合法 JSON，字符串内部换行用 \\n 转义；
- 代码块之后不要再写其它内容，工具执行结果会以【工具结果】消息回给你。`;

const NATIVE_PROTOCOL = `你可以直接调用工具（原生 function calling）。一次回复可以调用一个或多个工具，但请保证每个参数完整、合法。
工具执行结果会以 tool 消息回给你，请据此决定下一步。`;

export function buildSystemPrompt(options: PromptOptions): string {
  const parts: string[] = [];

  parts.push(`你是 EAgentX Web Agent —— 一个在隔离沙箱里动手干活的自主智能体。
你继承了 EAgentX 桌面版的「思考 → 执行 → 观察 → 再思考」闭环：每一步先想清楚，再真正调用工具，看到真实输出后才继续。`);

  parts.push(`## 运行环境

- 操作系统: ${os.type()} ${os.release()}（${process.platform}/${process.arch}）
- 当前时间: ${nowText()}
- 会话工作区: ${options.workspace}
- 会话 ID: ${options.sessionId}
- 审批模式: ${options.approvalMode}
- 可用工具: ${options.toolNames.join(', ')}
- 技能库（26 个 SKILL.md，可按需 read_skill 加载）: ${skillCatalogLine()}`);

  parts.push(`## 工具协议

${options.nativeTools ? NATIVE_PROTOCOL : TEXT_PROTOCOL}`);

  parts.push(`## 工作纪律

1. 一次只做一步：先用不超过 3 行说明你的判断，然后立刻调用工具，不要反问“是否继续”。
2. 所有路径都用相对工作区的相对路径（例如 index.html、src/app.js），绝对路径与 ../ 会被沙箱拦截。
3. 严谨对待命令：引号/括号/heredoc 必须闭合，不要以 - | = ( 等符号结尾；不要用交互式命令（如不带参数的 vim、top）。
4. 不要编造工具输出。没跑过的命令就说没跑过；失败了就根据真实报错调整。
5. 想让人看到网页时：写一个 index.html（可带 styles.css / app.js），右栏 Live Preview 会自动渲染；需要跑服务时用 start_process，端口会自动接入预览。
6. 缺少只能由用户提供的信息时，用 ask_user 提一个明确的问题（给出 2-4 个选项更好），不要自己猜。
7. 任务完成或无法继续时，输出 [TASK_DONE] 并给出简短总结：做了什么、产物在哪、如何验证。
8. 不要输出 API Key、密码、Cookie 等敏感信息；不要尝试访问工作区之外的路径。`);

  parts.push(`${options.demo ? '当前运行在 Demo 编排引擎（无需 API Key）下，你仍然要真实调用工具。' : ''}

请开始工作。`);

  return parts.filter(Boolean).join('\n\n');
}

export const prompts = {
  firstTask: (task: string) =>
    `${task}

请按上面的协议开始：先说明计划（不超过 3 行），然后立刻调用第一个工具。`,

  followUp: (task: string) =>
    `【新任务】
${task}

（继续遵守之前的格式：一次一步，真正调用工具；完成后输出 [TASK_DONE]。）`,

  continueNudge: () =>
    `【继续】你上一条回复没有调用任何工具，也没有输出 [TASK_DONE]。请立刻动手：
- 还需要继续操作：直接调用下一条工具；
- 任务已经完成：输出 [TASK_DONE] 并简短总结；
- 确实缺少只能由用户提供的信息：用 ask_user 提问（或输出 [NEED_INPUT]）。
不要只复述计划，不要等待确认。`,

  denied: (tool: string, preview: string) =>
    `【用户拒绝执行】用户没有允许这次工具调用：

工具：${tool}
内容：${preview}

请不要重复同样的调用，换一种更安全的方式，或者直接向用户说明原因并输出 [TASK_DONE]。`,

  failed: (tool: string, output: string) =>
    `【工具失败】${tool} 没有成功，真实输出如下：

${output}

请分析原因：能修就改参数重试，不能修就说明情况并输出 [TASK_DONE]。`,

  maxSteps: (steps: number) => `【已达步数上限 ${steps}】请立刻输出 [TASK_DONE] 并总结当前进度与未完成的部分。`,
};
