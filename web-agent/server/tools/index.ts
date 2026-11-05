/**
 * 工具注册表：把 EAgentX 的本机能力搬到 Web 沙箱里。
 *
 * 读类工具自动放行，写类工具受审批策略约束（见 agentSession.needsApproval），
 * 所有文件路径都过 WorkspaceSandbox，所有命令都过 CommandShape + 超时杀进程组。
 */

import type { AgentEvent, AskUserOption, ToolName, ToolResult } from '../types';
import { checkCommandShape } from '../core/commandShape';
import { findSkill, loadSkills, listSkills } from '../core/skillRegistry';
import { runCommand } from './bashTool';
import { editFile, listFiles, readFile, writeFile } from './fileTools';
import { ProcessRegistry } from './processTool';
import { fetchPage } from './webTools';
import type { WorkspaceSandbox } from './workspaceSandbox';

export interface ToolContext {
  sandbox: WorkspaceSandbox;
  emit: (event: AgentEvent) => void;
  askUser: (callId: string, question: string, options: AskUserOption[], allowCustom: boolean) => Promise<string>;
  processes: ProcessRegistry;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  /** 只读工具在 readonly 模式下自动放行 */
  readOnly: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function num(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

function bool(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  return value === true || value === 'true';
}

const tools: ToolDefinition[] = [
  {
    name: 'bash',
    readOnly: false,
    description:
      '在会话工作区执行 shell 命令（Linux/WSL 下是 bash -lc，Windows 下是 cmd /c）。用于安装依赖、跑测试、检查文件、启动服务前验证等。默认 60 秒超时，超时会杀掉整个进程组。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令；多条语句可用 && 连接' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 60000，最大 180000' },
      },
      required: ['command'],
    },
    async handler(args, ctx) {
      const command = str(args, 'command').trim();
      if (!command) return { ok: false, output: 'command 不能为空。' };
      const shape = checkCommandShape(command);
      if (!shape.complete) {
        return {
          ok: false,
          output: `命令可能被截断，已拒绝执行（${shape.reason}）。请重新输出完整命令：引号/括号/here-doc 要闭合，不要以 - | = ( 等符号结尾。`,
          meta: { rejected: true, reason: shape.reason },
        };
      }
      const result = await runCommand(command, {
        cwd: ctx.sandbox.root,
        timeoutMs: num(args, 'timeout_ms'),
      });
      const status = result.timedOut ? `超时（${result.elapsedMs}ms）后已终止` : `退出码 ${result.exitCode}`;
      const body = result.output.trim() ? result.output : '（无输出）';
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        output: `$ ${command}\n${status}｜耗时 ${result.elapsedMs}ms\n\n${body}`,
        meta: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          elapsedMs: result.elapsedMs,
          truncated: result.truncated,
          command,
        },
      };
    },
  },
  {
    name: 'read_file',
    readOnly: true,
    description: '读取工作区内的文本文件，返回带行号的内容（自动截断超长文件）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的路径' },
        offset: { type: 'number', description: '起始行号（1 起），默认 1' },
        limit: { type: 'number', description: '最多读取多少行，默认 2000' },
      },
      required: ['path'],
    },
    async handler(args, ctx) {
      return readFile(ctx.sandbox, {
        path: str(args, 'path'),
        offset: num(args, 'offset'),
        limit: num(args, 'limit'),
      });
    },
  },
  {
    name: 'write_file',
    readOnly: false,
    description: '在工作区写入（或覆盖）文本文件，父目录会自动创建。适合生成 HTML/CSS/JS/脚本/文档。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的路径' },
        content: { type: 'string', description: '完整文件内容' },
        append: { type: 'boolean', description: '为 true 时追加而不是覆盖' },
      },
      required: ['path', 'content'],
    },
    async handler(args, ctx) {
      return writeFile(ctx.sandbox, {
        path: str(args, 'path'),
        content: str(args, 'content'),
        append: bool(args, 'append'),
      });
    },
  },
  {
    name: 'edit_file',
    readOnly: false,
    description: '精确替换文件中的一段文本（优先小范围替换，不要整文件重写）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径' },
        old_string: { type: 'string', description: '要被替换的原文（必须唯一）' },
        new_string: { type: 'string', description: '替换后的内容' },
        replace_all: { type: 'boolean', description: '是否替换全部匹配' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async handler(args, ctx) {
      return editFile(ctx.sandbox, {
        path: str(args, 'path'),
        old_string: str(args, 'old_string'),
        new_string: str(args, 'new_string'),
        replace_all: bool(args, 'replace_all'),
      });
    },
  },
  {
    name: 'list_files',
    readOnly: true,
    description: '查看工作区文件树，确认项目结构与生成结果。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '起始目录，默认工作区根' },
        depth: { type: 'number', description: '递归深度，默认 4' },
      },
    },
    async handler(args, ctx) {
      return listFiles(ctx.sandbox, { path: str(args, 'path') || undefined, depth: num(args, 'depth') });
    },
  },
  {
    name: 'list_skills',
    readOnly: true,
    description: '列出内置技能库里全部技能（名称 + 摘要）。不知道某个领域怎么做时先查这里。',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const skills = listSkills();
      if (skills.length === 0) return { ok: false, output: '技能库为空（未找到 assets/skill_zip.zip）。' };
      const lines = skills.map((s) => `- ${s.id}｜${s.group}｜${s.description}`);
      return {
        ok: true,
        output: `共 ${skills.length} 个技能：\n${lines.join('\n')}`,
        meta: { count: skills.length, skills: skills.map((s) => s.id) },
      };
    },
  },
  {
    name: 'read_skill',
    readOnly: true,
    description: '读取某个技能的 SKILL.md 全文（渐进式加载：先 list_skills 再按需 read_skill）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能 id 或名称，例如 weather' } },
      required: ['name'],
    },
    async handler(args) {
      const name = str(args, 'name');
      const skill = findSkill(name);
      if (!skill) {
        const ids = loadSkills()
          .map((s) => s.id)
          .slice(0, 30)
          .join(', ');
        return { ok: false, output: `没找到技能「${name}」。可用技能：${ids}` };
      }
      const extra = skill.files.length ? `\n\n附带文件：${skill.files.join(', ')}` : '';
      return {
        ok: true,
        output: `${skill.content.trim()}${extra}`,
        meta: { skill: skill.id, group: skill.group, files: skill.files },
      };
    },
  },
  {
    name: 'fetch_page',
    readOnly: true,
    description: '抓取网页并转成可读文本（Markdown 风格），用于查资料或验证线上页面。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 链接' },
        max_chars: { type: 'number', description: '最多保留多少字符，默认 12000' },
      },
      required: ['url'],
    },
    async handler(args) {
      return fetchPage({ url: str(args, 'url'), max_chars: num(args, 'max_chars') });
    },
  },
  {
    name: 'ask_user',
    readOnly: true,
    description:
      '当信息不足以继续时，向用户提一个结构化问题，会话会挂起等待用户点选/填写后继续。不要用它问“是否继续”。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题' },
        options: {
          type: 'array',
          description: '2-4 个单选项',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['label'],
          },
        },
        allow_custom: { type: 'boolean', description: '是否允许自由输入，默认 true' },
      },
      required: ['question'],
    },
    async handler(args, ctx) {
      const question = str(args, 'question');
      if (!question) return { ok: false, output: 'question 不能为空。' };
      const rawOptions = Array.isArray(args.options) ? (args.options as Array<Record<string, unknown>>) : [];
      const options: AskUserOption[] = rawOptions.slice(0, 4).map((option, index) => ({
        id: str(option, 'id') || `opt${index + 1}`,
        label: str(option, 'label'),
        description: str(option, 'description') || undefined,
      }));
      const allowCustom = args.allow_custom === undefined ? true : bool(args, 'allow_custom');
      const answer = await ctx.askUser('', question, options, allowCustom);
      return { ok: true, output: `用户回答：${answer}`, meta: { answer } };
    },
  },
  {
    name: 'start_process',
    readOnly: false,
    description:
      '在后台启动一个长驻进程（如 npm run dev、python -m http.server 8080），自动探测端口并接入右栏 Live Preview。不要用它跑会马上结束的命令。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '启动命令' },
        wait_ms: { type: 'number', description: '等待端口探测的毫秒数，默认 4000' },
      },
      required: ['command'],
    },
    async handler(args, ctx) {
      const command = str(args, 'command').trim();
      if (!command) return { ok: false, output: 'command 不能为空。' };
      const shape = checkCommandShape(command);
      if (!shape.complete) return { ok: false, output: `命令可能被截断（${shape.reason}），请重新输出。` };
      const info = ctx.processes.start(command, ctx.sandbox.root);
      const waitMs = Math.min(15000, Math.max(1000, num(args, 'wait_ms') ?? 4000));
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        const current = ctx.processes.get(info.id);
        if (!current) break;
        if (current.port || current.status === 'exited') break;
      }
      const final = ctx.processes.get(info.id) ?? info;
      const tail = final.log.trim().split('\n').slice(-20).join('\n');
      return {
        ok: final.status === 'running',
        output: `已启动 ${final.command}（pid ${final.pid}）\n状态：${final.status}${
          final.port ? `，端口 ${final.port}，右栏 Live Preview 已接入` : '，暂未探测到端口'
        }\n\n最近输出：\n${tail || '（暂无输出）'}`,
        meta: { processId: final.id, port: final.port, status: final.status, exited: final.status === 'exited' },
      };
    },
  },
  {
    name: 'stop_process',
    readOnly: false,
    description: '停止通过 start_process 启动的后台进程。',
    parameters: {
      type: 'object',
      properties: { process_id: { type: 'string', description: '进程 id，例如 proc-1a2b3c4d' } },
      required: ['process_id'],
    },
    async handler(args, ctx) {
      const id = str(args, 'process_id');
      const info = ctx.processes.stop(id);
      if (!info) return { ok: false, output: `没有找到进程 ${id}。` };
      return { ok: true, output: `已停止 ${info.id}（${info.command}）。`, meta: { processId: info.id } };
    },
  },
];

export function createTools(): Map<ToolName, ToolDefinition> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export function toolSchemas(registry = createTools()) {
  return Array.from(registry.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
