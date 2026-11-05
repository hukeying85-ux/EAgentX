import { describe, expect, it } from 'vitest';
import { cleanCommand, extractTextToolCalls, hasUnclosedFence, parseFences } from '../server/core/fallbackParser';

const ALLOWED = ['bash', 'read_file', 'write_file', 'list_skills', 'read_skill', 'ask_user'];

describe('fallbackParser（代码块工具协议）', () => {
  it('识别未闭合的代码围栏', () => {
    expect(hasUnclosedFence('```bash\nls')).toBe(true);
    expect(hasUnclosedFence('```bash\nls\n```')).toBe(false);
  });

  it('解析 ```tool:name 形式', () => {
    const reply = '先写文件。\n\n```tool:write_file\n{"path":"a.txt","content":"hi"}\n```';
    const calls = extractTextToolCalls(reply, ALLOWED);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: 'a.txt', content: 'hi' });
  });

  it('语言名即工具名时，把裸文本塞进首个参数', () => {
    const reply = '```bash\nls -la\n```';
    const calls = extractTextToolCalls(reply, ALLOWED);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].arguments).command).toBe('ls -la');
  });

  it('支持 json 包装形式，并忽略未知工具', () => {
    const reply = '```json\n{"tool":"read_file","args":{"path":"README.md"}}\n```\n```json\n{"tool":"rm_rf"}\n```';
    const calls = extractTextToolCalls(reply, ALLOWED);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });

  it('剥掉 shell 提示符', () => {
    expect(cleanCommand('$ ls -la')).toBe('ls -la');
    expect(cleanCommand('PS C:\\> dir')).toBe('dir');
    expect(cleanCommand('powershell -Command "echo hi"')).toBe('powershell -Command "echo hi"');
  });

  it('解析多个代码块', () => {
    const fences = parseFences('```bash\na\n```\n文字\n```tool:read_file\n{"path":"b"}\n```');
    expect(fences.map((fence) => fence.lang)).toEqual(['bash', 'tool:read_file']);
  });
});
