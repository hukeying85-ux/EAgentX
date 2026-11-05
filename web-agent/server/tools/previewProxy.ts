/**
 * Live Preview 同源代理：`/preview/<sessionId>/...`
 *
 * 两种模式自动切换：
 *   1. 会话通过 start_process 起了真实服务 → 反向代理到 127.0.0.1:<port>；
 *   2. 否则当静态站点，从会话工作区取文件（默认 index.html）。
 *
 * 前端 iframe 只用相对路径访问，所以云端沙箱 / 本机都能直接看到结果，
 * 也不会出现「浏览器去连 localhost」的经典事故。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { sessions, sessionIdIsValid } from '../store';
import { workspacesRoot } from '../paths';
import { WorkspaceSandbox } from './workspaceSandbox';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function emptyPage(sessionId: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>Live Preview</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; font:15px/1.6 -apple-system,"Segoe UI","PingFang SC",sans-serif;
    background:#eef1f5; color:#252b34; }
  @media (prefers-color-scheme: dark) { body { background:#121721; color:#e6eaf2; } .card { background:#1d2432 !important; border-color:#2a3342 !important; } }
  .card { background:#fff; border:1px solid #dfe3ea; border-radius:16px; padding:28px 32px; max-width:460px; box-shadow:0 18px 40px -24px rgba(16,24,40,.35); }
  h1 { font-size:18px; margin:0 0 8px; }
  p { margin:0; color:#6b7482; font-size:13px; }
  code { background:rgba(127,127,127,.15); border-radius:5px; padding:1px 5px; }
</style></head>
<body><div class="card">
  <h1>预览区还是空的</h1>
  <p>让智能体在工作区里生成 <code>index.html</code>，或用 <code>start_process</code> 启动一个服务，这里会自动渲染。
  会话 ID：<code>${sessionId}</code></p>
</div></body></html>`;
}

function proxyToPort(port: number, req: Request, res: Response, sessionId: string): void {
  const prefix = `/preview/${sessionId}`;
  const rest = req.originalUrl.startsWith(prefix) ? req.originalUrl.slice(prefix.length) || '/' : req.url;
  const proxied = http.request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: rest,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on('error', (error) => {
    if (!res.headersSent) {
      res.status(502).type('html').send(emptyPage(sessionId).replace('预览区还是空的', `服务暂时不可用：${error.message}`));
    } else {
      res.end();
    }
  });
  req.pipe(proxied);
}

export function previewRouter(): Router {
  const router = Router();

  // 只对「没有尾斜杠」的地址补斜杠，否则会变成无限重定向
  router.get('/:sessionId', (req, res, next) => {
    if (req.originalUrl.endsWith('/')) {
      next();
      return;
    }
    res.redirect(301, `/preview/${req.params.sessionId}/`);
  });

  router.use('/:sessionId', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId;
    if (!sessionIdIsValid(sessionId)) {
      res.status(400).type('text').send('无效的会话 ID');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    // 明确允许被前端 iframe 嵌入，避免任何默认拦截头
    res.removeHeader('X-Frame-Options');

    const session = sessions.get(sessionId);
    if (session?.previewPort) {
      proxyToPort(session.previewPort, req, res, sessionId);
      return;
    }

    const workspace = path.join(workspacesRoot(), sessionId);
    if (!fs.existsSync(workspace)) {
      res.status(404).type('html').send(emptyPage(sessionId));
      return;
    }

    let sandbox: WorkspaceSandbox;
    try {
      sandbox = new WorkspaceSandbox(workspace);
    } catch {
      res.status(500).type('text').send('工作区不可用');
      return;
    }

    let rel: string;
    try {
      rel = decodeURIComponent(req.path === '/' ? '' : req.path.replace(/^\/+/, ''));
    } catch {
      res.status(400).type('text').send('路径编码错误');
      return;
    }

    let target: string;
    try {
      target = sandbox.resolve(rel || '.');
    } catch (error) {
      res.status(403).type('text').send((error as Error).message);
      return;
    }

    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      const index = path.join(target, 'index.html');
      if (fs.existsSync(index)) {
        target = index;
      } else {
        const entry = sandbox.findEntryHtml();
        if (!entry) {
          res.type('html').send(emptyPage(sessionId));
          return;
        }
        target = sandbox.resolve(entry);
      }
    } else if (!fs.existsSync(target)) {
      // 普通资源缺失就老实 404；页面级路径（无扩展名）则回落到入口页
      if (path.extname(target) === '') {
        const entry = sandbox.findEntryHtml();
        if (entry) {
          target = sandbox.resolve(entry);
        } else {
          res.status(404).type('html').send(emptyPage(sessionId));
          return;
        }
      } else {
        res.status(404).type('text').send(`文件不存在：${rel}`);
        return;
      }
    }

    const ext = path.extname(target).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';

    if (ext === '.html' || ext === '.htm') {
      try {
        let html = fs.readFileSync(target, 'utf8');
        // 注入 base，让相对路径在 /preview/<id>/ 前缀下也能正确解析
        if (!html.includes('<base ')) {
          const baseTag = `<base href="/preview/${sessionId}/">`;
          html = /<head[^>]*>/i.test(html)
            ? html.replace(/<head([^>]*)>/i, `<head$1>\n  ${baseTag}`)
            : `${baseTag}\n${html}`;
        }
        res.type('text/html; charset=utf-8').send(html);
        return;
      } catch (error) {
        res.status(500).type('text').send(`读取失败：${(error as Error).message}`);
        return;
      }
    }

    res.type(mime);
    fs.createReadStream(target)
      .on('error', () => {
        if (!res.headersSent) res.status(404).end();
        else res.end();
      })
      .pipe(res);
  });

  return router;
}
