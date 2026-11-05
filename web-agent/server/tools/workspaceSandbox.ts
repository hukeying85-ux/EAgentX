/**
 * 会话工作区沙箱：所有文件读写必须落在 `workspaces/<sessionId>/` 里。
 * 三种逃逸都会被拦截：`../../etc/passwd`、绝对路径 `/etc/passwd`、
 * 以及指向区外的符号链接（存在时做一次 realpath 复核）。
 */

import fs from 'node:fs';
import path from 'node:path';

export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxViolation';
  }
}

export class WorkspaceSandbox {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** 把相对路径解析成绝对路径；越界立刻抛 SandboxViolation。 */
  resolve(relative?: string): string {
    const rel = (relative ?? '.').trim() || '.';
    if (path.isAbsolute(rel)) {
      throw new SandboxViolation(`禁止使用绝对路径：${rel}（只能在工作区内操作）`);
    }
    const target = path.resolve(this.root, rel);
    const prefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (target !== this.root && !target.startsWith(prefix)) {
      throw new SandboxViolation(`禁止访问工作区之外的路径：${rel}`);
    }
    // 已存在的路径再复核一次真实路径，防止符号链接把访问带出沙箱
    if (fs.existsSync(target)) {
      try {
        const real = fs.realpathSync(target);
        const realPrefix = fs.realpathSync(this.root) + path.sep;
        if (real !== fs.realpathSync(this.root) && !real.startsWith(realPrefix)) {
          throw new SandboxViolation(`禁止访问符号链接指向的区外路径：${rel}`);
        }
      } catch (error) {
        if (error instanceof SandboxViolation) throw error;
      }
    }
    return target;
  }

  relative(absolute: string): string {
    const rel = path.relative(this.root, absolute);
    return rel === '' ? '.' : rel.split(path.sep).join('/');
  }

  exists(rel?: string): boolean {
    return fs.existsSync(this.resolve(rel));
  }

  read(rel: string): string {
    return fs.readFileSync(this.resolve(rel), 'utf8');
  }

  write(rel: string, content: string): string {
    const target = this.resolve(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return this.relative(target);
  }

  append(rel: string, content: string): string {
    const target = this.resolve(rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, content, 'utf8');
    return this.relative(target);
  }

  /** 递归列出文件（相对路径，最多 limit 条）。 */
  list(limit = 400): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (out.length >= limit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= limit) return;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else out.push(this.relative(abs));
      }
    };
    walk(this.root);
    return out;
  }

  /** 渲染缩进树，给模型 / 前端文件面板用。 */
  tree(maxDepth = 4, limit = 400): string {
    const lines: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || lines.length >= limit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= limit) return;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        lines.push(`${'  '.repeat(depth)}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
      }
    };
    walk(this.root, 0);
    return lines.length ? lines.join('\n') : '（空工作区）';
  }

  /** 找一个可用的默认页面：index.html / 唯一的 .html 文件。 */
  findEntryHtml(): string | null {
    if (this.exists('index.html')) return 'index.html';
    const html = this.list().filter((f) => /\.html?$/i.test(f));
    return html.length > 0 ? html[0] : null;
  }
}
