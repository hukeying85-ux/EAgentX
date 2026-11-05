/**
 * HTTP + SSE 服务入口（绑定 0.0.0.0:3001）。
 *
 * 端口约定：生产模式下同一个端口同时提供前端静态资源、REST API、SSE 与 Live Preview，
 * 因此在云端远程浏览器预览（https://{port}-{sandbox}.e2b.app）里也能一次性跑通。
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { AgentEvent, ApprovalMode, ModelEndpoint } from './types';
import { loadConfig, publicConfig, saveConfig, sessions, sessionIdIsValid, leaderboard } from './store';
import { listSkills } from './core/skillRegistry';
import { previewRouter } from './tools/previewProxy';
import { clientDist, workspacesRoot } from './paths';
import { SandboxViolation } from './tools/workspaceSandbox';

const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

/* ------------------------------ 基础信息 ------------------------------ */

app.get('/api/health', (_req, res) => {
  const config = loadConfig();
  res.json({
    ok: true,
    port: PORT,
    mode: config.forceDemo || config.endpoints.length === 0 ? 'demo' : 'live',
    endpoints: config.endpoints.length,
    skills: listSkills().length,
    workspaces: workspacesRoot(),
    time: Date.now(),
  });
});

app.get('/api/config', (_req, res) => {
  res.json(publicConfig());
});

app.put('/api/config', (req, res) => {
  const current = loadConfig();
  const body = req.body ?? {};

  const incoming: Array<Record<string, unknown>> = Array.isArray(body.endpoints) ? body.endpoints : [];
  const endpoints: ModelEndpoint[] = incoming
    .filter((item) => typeof item.baseUrl === 'string' && typeof item.model === 'string')
    .map((item, index) => {
      const id = typeof item.id === 'string' && item.id ? item.id : `ep-${Date.now()}-${index}`;
      const previous = current.endpoints.find((endpoint) => endpoint.id === id);
      const apiKey = typeof item.apiKey === 'string' && item.apiKey.trim() ? item.apiKey.trim() : previous?.apiKey;
      return {
        id,
        label: typeof item.label === 'string' && item.label ? item.label : `模型 ${index + 1}`,
        kind: (item.kind as ModelEndpoint['kind']) ?? 'openai',
        baseUrl: String(item.baseUrl).replace(/\/+$/, ''),
        model: String(item.model),
        apiKey,
        nativeTools: item.nativeTools !== false,
      };
    });

  const next = saveConfig({
    endpoints,
    defaultEndpointId: typeof body.defaultEndpointId === 'string' ? body.defaultEndpointId : endpoints[0]?.id ?? null,
    blindMode: Boolean(body.blindMode),
    approvalMode: (body.approvalMode as ApprovalMode) ?? current.approvalMode,
    maxSteps: Number(body.maxSteps ?? current.maxSteps),
    forceDemo: Boolean(body.forceDemo),
  });

  res.json({ ok: true, config: publicConfig(), saved: { endpoints: next.endpoints.length } });
});

app.get('/api/skills', (_req, res) => {
  res.json({ skills: listSkills() });
});

app.get('/api/leaderboard', (_req, res) => {
  res.json({ rows: leaderboard() });
});

/* ------------------------------ 会话 ------------------------------ */

function getSession(req: Request, res: Response) {
  const id = req.params.id;
  if (!sessionIdIsValid(id)) {
    res.status(400).json({ error: '无效的会话 ID' });
    return null;
  }
  const session = sessions.get(id);
  if (!session) {
    res.status(404).json({ error: '会话不存在或已过期，请新建会话。' });
    return null;
  }
  return session;
}

app.post('/api/sessions', (req, res) => {
  const endpointId = typeof req.body?.endpointId === 'string' ? req.body.endpointId : undefined;
  const session = sessions.create({ endpointId });
  res.json({ id: session.id, snapshot: session.snapshot() });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json(session.snapshot());
});

app.patch('/api/sessions/:id', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const { approvalMode, maxSteps } = req.body ?? {};
  if (approvalMode === 'readonly' || approvalMode === 'manual' || approvalMode === 'auto') {
    session.setApprovalMode(approvalMode);
  }
  if (Number.isFinite(Number(maxSteps))) {
    session.settings = { ...session.settings, maxSteps: Math.min(30, Math.max(3, Math.floor(Number(maxSteps)))) };
  }
  res.json({ ok: true, settings: session.settings });
});

app.get('/api/sessions/:id/events', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ id: session.id, status: session.status })}\n\n`);

  const send = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = session.subscribe(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
    res.end();
  });
});

app.post('/api/sessions/:id/messages', async (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    res.status(400).json({ error: '消息内容不能为空' });
    return;
  }
  if (session.status === 'running' || session.status === 'awaiting_approval' || session.status === 'awaiting_input') {
    const hint =
      session.status === 'awaiting_approval'
        ? '会话正在等待你审批命令，请先允许或拒绝。'
        : session.status === 'awaiting_input'
          ? '会话正在等待你回答提问。'
          : '会话正在运行中，请等待完成或先中断。';
    res.status(409).json({ error: hint });
    return;
  }
  res.json({ ok: true, accepted: true });
  session.send(text).catch((error: Error) => {
    // send 内部已经把错误推成 SSE 事件，这里兜底打日志
    console.error('[session]', session.id, error.message);
  });
});

app.post('/api/sessions/:id/approve', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const id = String(req.body?.id ?? '');
  const decision = req.body?.decision === 'approved' ? 'approved' : 'rejected';
  const ok = session.approve(id, decision);
  res.status(ok ? 200 : 409).json({ ok });
});

app.post('/api/sessions/:id/answer', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const id = String(req.body?.id ?? '');
  const answer = String(req.body?.answer ?? '');
  const ok = session.answer(id, answer);
  res.status(ok ? 200 : 409).json({ ok });
});

app.post('/api/sessions/:id/stop', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  session.stop();
  res.json({ ok: true, snapshot: session.snapshot() });
});

app.post('/api/sessions/:id/feedback', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const rating = req.body?.rating === 'down' ? 'down' : 'up';
  const model = session.setFeedback(rating);
  res.json({ ok: true, model, leaderboard: leaderboard() });
});

app.get('/api/sessions/:id/files', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ files: session.sandbox.list(500) });
});

app.get('/api/sessions/:id/file', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const rel = String(req.query.path ?? '');
  if (!rel) {
    res.status(400).json({ error: '缺少 path 参数' });
    return;
  }
  try {
    const target = session.sandbox.resolve(rel);
    if (!fs.existsSync(target)) {
      res.status(404).json({ error: `文件不存在：${rel}` });
      return;
    }
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      res.status(400).json({ error: '这是目录，请用文件列表接口。' });
      return;
    }
    if (stat.size > 2_000_000) {
      res.status(413).json({ error: '文件过大（>2MB），请在终端里查看。' });
      return;
    }
    const content = fs.readFileSync(target, 'utf8');
    res.json({ path: rel, size: stat.size, content });
  } catch (error) {
    if (error instanceof SandboxViolation) {
      res.status(403).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/sessions/:id/trace', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  const file = session.trace.filePath;
  if (!file || !fs.existsSync(file)) {
    res.json({ trace: '', exists: false });
    return;
  }
  res.json({ trace: fs.readFileSync(file, 'utf8'), exists: true });
});

app.get('/api/sessions/:id/processes', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ processes: session.processes.list(), previewPort: session.previewPort });
});

/* ------------------------------ Live Preview ------------------------------ */

app.use('/preview', previewRouter());

/* ------------------------------ 前端静态资源 ------------------------------ */

const dist = clientDist();
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/preview')) {
      next();
      return;
    }
    res.sendFile(path.join(dist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>EAgentX Web Agent</title>
<style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;background:#eef1f5;color:#252b34;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #dfe3ea;border-radius:16px;padding:28px 32px;max-width:560px}
code{background:#eef1f5;border-radius:6px;padding:2px 6px}a{color:#3c6df0}</style></head>
<body><div class="card"><h2>后端已启动，但还没构建前端</h2>
<p>开发模式：另开一个终端跑 <code>npm run dev:client</code>，打开 5173 端口。</p>
<p>生产模式：<code>npm run build</code> 后重启，本端口会直接提供完整界面。</p>
<p>接口自检：<a href="/api/health">/api/health</a></p></div></body></html>`);
  });
}

/* ------------------------------ 错误处理 ------------------------------ */

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api]', error.message);
  if (res.headersSent) return;
  res.status(500).json({ error: error.message });
});

const server = app.listen(PORT, HOST, () => {
  const config = loadConfig();
  const mode = config.forceDemo || config.endpoints.length === 0 ? 'Demo（免 Key）' : `${config.endpoints.length} 个模型端点`;
  console.log(`[web-agent] 监听 http://${HOST}:${PORT}`);
  console.log(`[web-agent] 模型：${mode}｜审批：${config.approvalMode}｜技能：${listSkills().length} 个`);
  console.log(`[web-agent] 工作区：${workspacesRoot()}`);
});

function shutdown(signal: string): void {
  console.log(`\n[web-agent] 收到 ${signal}，正在关闭…`);
  sessions.disposeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
