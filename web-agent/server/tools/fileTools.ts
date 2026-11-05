/** 文件工具：read_file / write_file / edit_file / list_files（全部受 WorkspaceSandbox 约束）。 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolResult } from '../types';
import type { WorkspaceSandbox } from './workspaceSandbox';
import { SandboxViolation } from './workspaceSandbox';
import { truncateOutput } from './truncate';

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteFileArgs {
  path: string;
  content: string;
  append?: boolean;
}

export interface EditFileArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface ListFilesArgs {
  path?: string;
  depth?: number;
}

export function readFile(sandbox: WorkspaceSandbox, args: ReadFileArgs): ToolResult {
  try {
    const target = sandbox.resolve(args.path);
    if (!fs.existsSync(target)) {
      return { ok: false, output: `文件不存在：${args.path}` };
    }
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      return { ok: false, output: `${args.path} 是目录，请用 list_files。` };
    }
    const raw = fs.readFileSync(target, 'utf8');
    const allLines = raw.split('\n');
    const offset = Math.max(1, Math.floor(args.offset ?? 1));
    const limit = Math.min(4000, Math.max(1, Math.floor(args.limit ?? 2000)));
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((line, index) => `${String(offset + index).padStart(5, ' ')}\t${line}`).join('\n');
    const truncated = truncateOutput(numbered, { head: 20000, tail: 4000, threshold: 24000 });
    const header = `# ${sandbox.relative(target)}（共 ${allLines.length} 行，${raw.length} 字节，显示第 ${offset}-${Math.min(
      offset + limit - 1,
      allLines.length,
    )} 行）\n`;
    return {
      ok: true,
      output: header + truncated.text,
      meta: { path: sandbox.relative(target), lines: allLines.length, bytes: raw.length },
    };
  } catch (error) {
    if (error instanceof SandboxViolation) return { ok: false, output: error.message, meta: { sandboxBlocked: true } };
    return { ok: false, output: `读取失败：${(error as Error).message}` };
  }
}

export function writeFile(sandbox: WorkspaceSandbox, args: WriteFileArgs): ToolResult {
  try {
    if (typeof args.content !== 'string') {
      return { ok: false, output: 'content 必须是字符串。' };
    }
    const rel = args.append ? sandbox.append(args.path, args.content) : sandbox.write(args.path, args.content);
    const bytes = Buffer.byteLength(args.content, 'utf8');
    return {
      ok: true,
      output: `已${args.append ? '追加' : '写入'} ${rel}（${bytes} 字节，${args.content.split('\n').length} 行）。`,
      meta: { path: rel, bytes, written: true },
    };
  } catch (error) {
    if (error instanceof SandboxViolation) return { ok: false, output: error.message, meta: { sandboxBlocked: true } };
    return { ok: false, output: `写入失败：${(error as Error).message}` };
  }
}

export function editFile(sandbox: WorkspaceSandbox, args: EditFileArgs): ToolResult {
  try {
    const target = sandbox.resolve(args.path);
    if (!fs.existsSync(target)) return { ok: false, output: `文件不存在：${args.path}` };
    const original = fs.readFileSync(target, 'utf8');
    if (!args.old_string) return { ok: false, output: 'old_string 不能为空。' };

    const occurrences = original.split(args.old_string).length - 1;
    if (occurrences === 0) {
      return { ok: false, output: `在 ${args.path} 中没有找到要替换的内容，请先 read_file 确认原文。` };
    }
    if (occurrences > 1 && !args.replace_all) {
      return {
        ok: false,
        output: `要替换的内容在 ${args.path} 中出现 ${occurrences} 次。请提供更长的唯一上下文，或设置 replace_all=true。`,
      };
    }
    const updated = args.replace_all
      ? original.split(args.old_string).join(args.new_string)
      : original.replace(args.old_string, args.new_string);
    fs.writeFileSync(target, updated, 'utf8');
    return {
      ok: true,
      output: `已修改 ${sandbox.relative(target)}（替换 ${args.replace_all ? occurrences : 1} 处）。`,
      meta: { path: sandbox.relative(target), replacements: args.replace_all ? occurrences : 1, written: true },
    };
  } catch (error) {
    if (error instanceof SandboxViolation) return { ok: false, output: error.message, meta: { sandboxBlocked: true } };
    return { ok: false, output: `编辑失败：${(error as Error).message}` };
  }
}

export function listFiles(sandbox: WorkspaceSandbox, args: ListFilesArgs): ToolResult {
  try {
    const target = sandbox.resolve(args.path ?? '.');
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      return { ok: true, output: `# ${sandbox.relative(target)}\n（这是一个文件，用 read_file 查看内容）` };
    }
    const depth = Math.min(8, Math.max(1, Math.floor(args.depth ?? 4)));
    const tree = sandbox.tree(depth);
    return { ok: true, output: `# 工作区文件树（${sandbox.relative(target)}）\n${tree}`, meta: { path: sandbox.relative(target) } };
  } catch (error) {
    if (error instanceof SandboxViolation) return { ok: false, output: error.message, meta: { sandboxBlocked: true } };
    return { ok: false, output: `列目录失败：${(error as Error).message}` };
  }
}

/** 写入内容时做一次路径归一化，避免模型给出 `./a//b` 这类奇怪路径。 */
export function normalizeRel(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}
