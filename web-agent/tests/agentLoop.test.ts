import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSession } from '../server/core/agentSession';
import { DemoProvider } from '../server/providers/demoProvider';
import { WorkspaceSandbox } from '../server/tools/workspaceSandbox';
import type { AgentEvent, ApprovalMode, ChatProvider, ChatReply, ChatRequest, ModelReveal } from '../server/types';
import { extractTextToolCalls } from '../server/core/fallbackParser';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-'));
const dataDir = path.join(tmpRoot, 'data');
const sessions: AgentSession[] = [];

beforeAll(() => {
  process.env.WEB_AGENT_DATA_DIR = dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
});

afterAll(() => {
  for (const session of sessions) session.dispose();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function createSession(options: { approvalMode?: ApprovalMode; provider?: ChatProvider; id?: string } = {}) {
  const id = options.id ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
  const sandbox = new WorkspaceSandbox(path.join(tmpRoot, id));
  const provider = options.provider ?? new DemoProvider({ delayMs: 0 });
  const modelReveal: ModelReveal = { id: 'demo', label: 'Demo 编排引擎', model: 'demo-model', demo: true };
  const session = new AgentSession({
    id,
    sandbox,
    provider,
    modelReveal,
    settings: { approvalMode: options.approvalMode ?? 'auto', maxSteps: 12 },
    demo: true,
  });
  sessions.push(session);
  return { session, sandbox };
}

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

describe('agentSession（Demo 引擎端到端闭环）', () => {
  it('自动模式下真实写文件、跑命令、落盘轨迹', async () => {
    const { session, sandbox } = createSession();
    const events = collect(session);

    await session.send('帮我做一个番茄钟页面并预览');

    expect(session.status).toBe('done');
    expect(fs.existsSync(path.join(sandbox.root, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox.root, 'styles.css'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox.root, 'app.js'))).toBe(true);
    expect(fs.readFileSync(path.join(sandbox.root, 'index.html'), 'utf8')).toContain('番茄');

    const types = events.map((event) => event.type);
    expect(types).toContain('assistant_delta');
    expect(types).toContain('tool_call_start');
    expect(types).toContain('tool_call_result');
    expect(types).toContain('session_done');

    const results = events.filter((event): event is Extract<AgentEvent, { type: 'tool_call_result' }> => event.type === 'tool_call_result');
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results.every((result) => result.result.ok)).toBe(true);

    const tracePath = session.trace.filePath;
    expect(tracePath).toBeTruthy();
    const trace = fs.readFileSync(tracePath as string, 'utf8');
    expect(trace).toContain('# EAgentX Web Agent 会话记录');
    expect(trace).toContain('工具（第');
    expect(trace).toContain('番茄');

    const snapshot = session.snapshot();
    expect(snapshot.files).toContain('index.html');
    expect(snapshot.items.some((item) => item.kind === 'assistant')).toBe(true);
  });

  it('审批拒绝后不写文件，但会话继续跑完（拒绝也要回喂结果）', async () => {
    const { session, sandbox } = createSession({ approvalMode: 'readonly' });
    const events = collect(session);

    let approvals = 0;
    session.subscribe((event) => {
      if (event.type === 'approval_required') {
        approvals++;
        const decision = approvals === 1 ? 'rejected' : 'approved';
        setTimeout(() => session.approve(event.approval.id, decision), 0);
      }
    });

    await session.send('生成一个待办清单页面');

    expect(approvals).toBeGreaterThanOrEqual(4);
    expect(session.status).toBe('done');
    // 第一条 write_file(index.html) 被拒绝 → 文件不存在；后续 CSS / JS 通过
    expect(fs.existsSync(path.join(sandbox.root, 'index.html'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.root, 'styles.css'))).toBe(true);

    const approvalItem = session.snapshot().items.find((item) => item.kind === 'approval');
    expect(approvalItem && approvalItem.kind === 'approval' ? approvalItem.decision : null).toBe('rejected');
    expect(events.some((event) => event.type === 'approval_resolved')).toBe(true);
  });

  it('ask_user 会挂起会话，收到回答后继续并回喂结果', async () => {
    class ScriptedProvider implements ChatProvider {
      id = 'scripted';
      label = '脚本模型';
      model = 'scripted-1';
      nativeTools = true;
      private turn = 0;

      async chat(req: ChatRequest): Promise<ChatReply> {
        this.turn++;
        if (this.turn === 1) {
          return {
            text: '需要确认一下风格。',
            toolCalls: [
              {
                id: 'call_ask_1',
                name: 'ask_user',
                arguments: JSON.stringify({
                  question: '你更喜欢哪种主色？',
                  options: [{ label: '蓝色' }, { label: '绿色' }],
                }),
              },
            ],
            model: this.model,
            provider: this.label,
          };
        }
        const last = req.messages[req.messages.length - 1];
        return {
          text: `收到你的选择：${last?.content ?? ''}\n\n[TASK_DONE]`,
          toolCalls: [],
          model: this.model,
          provider: this.label,
        };
      }
    }

    const { session } = createSession({ provider: new ScriptedProvider(), approvalMode: 'auto' });
    const events = collect(session);
    session.subscribe((event) => {
      if (event.type === 'question_required') {
        setTimeout(() => session.answer(event.question.id, '蓝色'), 0);
      }
    });

    await session.send('帮我选个配色');

    expect(events.some((event) => event.type === 'question_required')).toBe(true);
    expect(events.some((event) => event.type === 'question_resolved')).toBe(true);
    expect(session.status).toBe('done');
    const toolResult = events.find(
      (event): event is Extract<AgentEvent, { type: 'tool_call_result' }> => event.type === 'tool_call_result',
    );
    expect(toolResult?.result.output).toContain('蓝色');
  });

  it('多工具单轮调用：每个 tool_call 都有对应结果', async () => {
    class MultiProvider implements ChatProvider {
      id = 'multi';
      label = '多工具模型';
      model = 'multi-1';
      nativeTools = true;
      private turn = 0;

      async chat(req: ChatRequest): Promise<ChatReply> {
        this.turn++;
        if (this.turn === 1) {
          return {
            text: '一次性写两个文件。',
            toolCalls: [
              { id: 'call_a', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'A' }) },
              { id: 'call_b', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'B' }) },
            ],
            model: this.model,
            provider: this.label,
          };
        }
        const toolMessages = req.messages.filter((message) => message.role === 'tool');
        return {
          text: `收到 ${toolMessages.length} 条工具结果。\n\n[TASK_DONE]`,
          toolCalls: [],
          model: this.model,
          provider: this.label,
        };
      }
    }

    const { session, sandbox } = createSession({ provider: new MultiProvider() });
    await session.send('写两个文件');

    expect(fs.readFileSync(path.join(sandbox.root, 'a.txt'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(sandbox.root, 'b.txt'), 'utf8')).toBe('B');
    const toolMessages = session.messages.filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.toolCallId)).toEqual(['call_a', 'call_b']);
  });

  it('盲测模式下反馈前不暴露真实模型', async () => {
    const { session } = createSession();
    session.modelReveal = { id: 'ep-1', label: '偏好的模型', model: 'gpt-x', revealed: false };
    // 直接构造盲测会话
    const blindSession = new AgentSession({
      id: `sess-${Math.random().toString(36).slice(2, 10)}`,
      sandbox: new WorkspaceSandbox(path.join(tmpRoot, `blind-${Date.now()}`)),
      provider: new DemoProvider({ delayMs: 0 }),
      modelReveal: { id: 'ep-1', label: '偏好的模型', model: 'gpt-x', revealed: false },
      settings: { approvalMode: 'auto', maxSteps: 6 },
      blind: true,
      demo: true,
    });
    sessions.push(blindSession);

    expect(blindSession.snapshot().model?.preliminary).toBe(true);
    expect(blindSession.snapshot().model?.model).toBe('hidden');

    const revealed = blindSession.setFeedback('up');
    expect(revealed.model).toBe('gpt-x');
    expect(revealed.revealed).toBe(true);
    expect(session.modelReveal).toBeTruthy();
  });

  it('文本协议端点（无原生 tool calling）也能完成闭环', async () => {
    class TextProtocolProvider implements ChatProvider {
      id = 'text';
      label = '文本协议模型';
      model = 'text-1';
      nativeTools = false;
      private turn = 0;

      async chat(req: ChatRequest): Promise<ChatReply> {
        this.turn++;
        if (this.turn === 1) {
          const text = '先写一个文件。\n\n```tool:write_file\n{"path":"t.txt","content":"hello"}\n```';
          return {
            text,
            toolCalls: extractTextToolCalls(text, req.tools.map((tool) => tool.name)),
            model: this.model,
            provider: this.label,
          };
        }
        return { text: '文件已写好。\n\n[TASK_DONE]', toolCalls: [], model: this.model, provider: this.label };
      }
    }

    const { session, sandbox } = createSession({ provider: new TextProtocolProvider() });
    await session.send('帮我写个文件');

    expect(fs.readFileSync(path.join(sandbox.root, 't.txt'), 'utf8')).toBe('hello');
    expect(session.status).toBe('done');
    const toolMessage = session.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('write_file');
  });

  it('截断命令会被 CommandShape 拦下，不会真的执行', async () => {
    class BrokenCommandProvider implements ChatProvider {
      id = 'broken';
      label = '残片模型';
      model = 'broken-1';
      nativeTools = true;
      private turn = 0;

      async chat(): Promise<ChatReply> {
        this.turn++;
        if (this.turn === 1) {
          return {
            text: '跑一下。',
            toolCalls: [{ id: 'call_bad', name: 'bash', arguments: JSON.stringify({ command: 'echo "unclosed' }) }],
            model: this.model,
            provider: this.label,
          };
        }
        return { text: '好的，我换一种写法。\n\n[TASK_DONE]', toolCalls: [], model: this.model, provider: this.label };
      }
    }

    const { session } = createSession({ provider: new BrokenCommandProvider() });
    const events = collect(session);
    await session.send('执行命令');

    const result = events.find(
      (event): event is Extract<AgentEvent, { type: 'tool_call_result' }> => event.type === 'tool_call_result',
    );
    expect(result?.result.ok).toBe(false);
    expect(result?.result.output).toContain('截断');
    expect(result?.result.meta?.rejected).toBe(true);
  });
});
