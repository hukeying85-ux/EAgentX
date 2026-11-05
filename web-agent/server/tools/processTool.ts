/**
 * 后台服务进程管理（对标 arena.ai/agent 的 start_process / stop_process）。
 *
 * 用途：模型在自己工作区里 `npm run dev` 或 `python -m http.server` 起一个服务，
 * 这里捕获它的 stdout，探测监听端口，并把 `/preview/<sessionId>/*` 的请求反代过去，
 * 于是右栏的 Live Preview 就能直接看到真实运行中的页面。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { shellCommand, sanitizedEnv } from './bashTool';

export type ProcessStatus = 'running' | 'exited';

export interface BackgroundProcessInfo {
  id: string;
  command: string;
  pid: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  port: number | null;
  startedAt: number;
  log: string;
}

export interface ProcessRegistryOptions {
  /** 输出片段 / 状态变化都通过它推给 SSE */
  onOutput?: (processId: string, chunk: string) => void;
  onExit?: (processId: string, exitCode: number | null) => void;
  onPort?: (processId: string, port: number) => void;
}

const MAX_LOG = 20000;

function parsePort(chunk: string): number | null {
  const patterns = [
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:：](\d{2,5})/i,
    /listening[^\d]{0,20}(\d{2,5})/i,
    /port[^\d]{0,10}(\d{2,5})/i,
    /https?:\/\/[^\s:]+:(\d{2,5})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(chunk);
    if (!match) continue;
    const port = Number(match[1]);
    if (port >= 80 && port <= 65535) return port;
  }
  return null;
}

class BackgroundProcess {
  info: BackgroundProcessInfo;
  child: ChildProcess;
  private registry: ProcessRegistry;

  constructor(registry: ProcessRegistry, command: string, cwd: string) {
    this.registry = registry;
    this.info = {
      id: `proc-${randomUUID().slice(0, 8)}`,
      command,
      pid: null,
      status: 'running',
      exitCode: null,
      port: null,
      startedAt: Date.now(),
      log: '',
    };
    const { file, args } = shellCommand(command);
    this.child = spawn(file, args, {
      cwd,
      env: sanitizedEnv({ PORT: '' }),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.info.pid = this.child.pid ?? null;
    this.child.stdout?.on('data', (d: Buffer) => this.append(d.toString('utf8')));
    this.child.stderr?.on('data', (d: Buffer) => this.append(d.toString('utf8')));
    this.child.on('error', (error) => this.append(`\n[进程错误] ${error.message}`));
    this.child.on('close', (code) => {
      this.info.status = 'exited';
      this.info.exitCode = code ?? null;
      this.registry.notifyExit(this.info.id, this.info.exitCode);
    });
  }

  private append(chunk: string): void {
    this.info.log = (this.info.log + chunk).slice(-MAX_LOG);
    this.registry.notifyOutput(this.info.id, chunk);
    if (!this.info.port) {
      const port = parsePort(chunk);
      if (port) {
        this.info.port = port;
        this.registry.notifyPort(this.info.id, port);
      }
    }
  }

  kill(): void {
    if (this.info.status !== 'running') return;
    try {
      if (process.platform === 'win32' && this.info.pid) {
        spawn('taskkill', ['/pid', String(this.info.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else if (this.info.pid) {
        process.kill(-this.info.pid, 'SIGTERM');
        setTimeout(() => {
          try {
            if (this.info.pid) process.kill(-this.info.pid, 'SIGKILL');
          } catch {
            /* 已退出 */
          }
        }, 1500).unref?.();
      }
    } catch {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    this.info.status = 'exited';
  }
}

export class ProcessRegistry {
  private processes = new Map<string, BackgroundProcess>();
  private options: ProcessRegistryOptions;

  constructor(options: ProcessRegistryOptions = {}) {
    this.options = options;
  }

  start(command: string, cwd: string): BackgroundProcessInfo {
    const proc = new BackgroundProcess(this, command, cwd);
    this.processes.set(proc.info.id, proc);
    return proc.info;
  }

  stop(id: string): BackgroundProcessInfo | null {
    const proc = this.processes.get(id);
    if (!proc) return null;
    proc.kill();
    return proc.info;
  }

  get(id: string): BackgroundProcessInfo | null {
    return this.processes.get(id)?.info ?? null;
  }

  list(): BackgroundProcessInfo[] {
    return Array.from(this.processes.values()).map((p) => p.info);
  }

  /** 当前最新可用端口（Live Preview 用） */
  activePort(): number | null {
    const running = this.list().filter((p) => p.status === 'running' && p.port);
    return running.length > 0 ? (running[running.length - 1].port as number) : null;
  }

  killAll(): void {
    for (const proc of this.processes.values()) proc.kill();
    this.processes.clear();
  }

  notifyOutput(id: string, chunk: string): void {
    this.options.onOutput?.(id, chunk);
  }

  notifyExit(id: string, exitCode: number | null): void {
    this.options.onExit?.(id, exitCode);
  }

  notifyPort(id: string, port: number): void {
    this.options.onPort?.(id, port);
  }
}
