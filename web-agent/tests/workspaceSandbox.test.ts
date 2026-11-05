import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxViolation, WorkspaceSandbox } from '../server/tools/workspaceSandbox';
import { readFile, writeFile, editFile } from '../server/tools/fileTools';

let dir: string;
let sandbox: WorkspaceSandbox;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sandbox-'));
  sandbox = new WorkspaceSandbox(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspaceSandbox（路径逃逸拦截）', () => {
  it('允许工作区内的相对路径', () => {
    expect(sandbox.resolve('index.html')).toBe(path.join(dir, 'index.html'));
    expect(sandbox.resolve('src/app.js')).toBe(path.join(dir, 'src', 'app.js'));
  });

  it('拦截 ../ 逃逸', () => {
    expect(() => sandbox.resolve('../../etc/passwd')).toThrow(SandboxViolation);
    expect(() => sandbox.resolve('..')).toThrow(SandboxViolation);
  });

  it('拦截绝对路径', () => {
    expect(() => sandbox.resolve('/etc/passwd')).toThrow(SandboxViolation);
  });

  it('拦截同前缀的兄弟目录（workspaces/sess-1 与 sess-10）', () => {
    const sibling = new WorkspaceSandbox(`${dir}-evil`);
    try {
      expect(() => sibling.resolve(`../${path.basename(dir)}/x`)).toThrow(SandboxViolation);
    } finally {
      fs.rmSync(`${dir}-evil`, { recursive: true, force: true });
    }
  });

  it('工具层把逃逸转成可读错误而不是抛异常', () => {
    const result = readFile(sandbox, { path: '../../etc/passwd' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('禁止');
    const write = writeFile(sandbox, { path: '/tmp/x', content: 'x' });
    expect(write.ok).toBe(false);
  });

  it('读写与替换都落在工作区里', () => {
    const written = writeFile(sandbox, { path: 'notes/a.md', content: 'hello world' });
    expect(written.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes', 'a.md'))).toBe(true);

    const edited = editFile(sandbox, { path: 'notes/a.md', old_string: 'world', new_string: 'agent' });
    expect(edited.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'notes', 'a.md'), 'utf8')).toBe('hello agent');

    const read = readFile(sandbox, { path: 'notes/a.md' });
    expect(read.ok).toBe(true);
    expect(read.output).toContain('hello agent');
  });

  it('文件树能列出产物', () => {
    sandbox.write('index.html', '<h1>x</h1>');
    sandbox.write('assets/app.js', 'console.log(1)');
    const tree = sandbox.tree();
    expect(tree).toContain('index.html');
    expect(tree).toContain('assets/');
    expect(sandbox.findEntryHtml()).toBe('index.html');
  });
});
