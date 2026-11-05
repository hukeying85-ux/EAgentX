/**
 * 终端执行器（移植自 EAgentX `PowerShellRunner.cs` 的关键设计）：
 *   1. 超时后整棵进程组一起杀（POSIX 用 detached + kill(-pid)，Windows 用 taskkill /T）；
 *   2. 输出超过 12000 字符时保留头 8000 + 尾 3000，并标注省略字数；
 *   3. 子进程环境里剔除 API Key / Token 等敏感变量，防止模型把密钥写进文件或日志。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { truncateOutput } from './truncate';

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  output: string;
  timedOut: boolean;
  elapsedMs: number;
  truncated: boolean;
  totalChars: number;
}

const SENSITIVE_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

export function sanitizedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SENSITIVE_ENV.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

export function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: '/bin/bash', args: ['-lc', command] };
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 进程可能已经退出 */
    }
  }
}

export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 60000, 1000), 180000);
  const { file, args } = shellCommand(command);

  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env ?? sanitizedEnv(),
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        command,
        exitCode: -1,
        output: `启动命令失败：${(error as Error).message}`,
        timedOut: false,
        elapsedMs: Date.now() - startedAt,
        truncated: false,
        totalChars: 0,
      });
      return;
    }

    let buffer = '';
    let overflow = 0;
    const MAX_BUFFER = 400_000;
    let timedOut = false;
    let settled = false;

    const push = (chunk: string) => {
      if (options.onOutput) options.onOutput(chunk);
      if (buffer.length < MAX_BUFFER) {
        buffer += chunk;
      } else {
        overflow += chunk.length;
      }
    };

    child.stdout?.on('data', (data: Buffer) => push(data.toString('utf8')));
    child.stderr?.on('data', (data: Buffer) => push(data.toString('utf8')));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = () => {
      timedOut = false;
      killTree(child);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const raw = overflow > 0 ? `${buffer}\n…（另有 ${overflow} 个字符未采集）` : buffer;
      const truncated = truncateOutput(raw);
      resolve({
        command,
        exitCode,
        output: truncated.text,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        truncated: truncated.truncated,
        totalChars: raw.length,
      });
    };

    child.on('error', (error) => {
      push(`\n进程错误：${error.message}`);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}
