/** 统一解析数据目录 / 工作区目录（开发态 tsx 与产物态 dist 都能找到 web-agent 根）。 */

import fs from 'node:fs';
import path from 'node:path';

function findProjectRoot(): string {
  let dir = path.resolve(__dirname);
  for (let depth = 0; depth < 8; depth++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string };
        if (json.name === 'web-agent') return dir;
      } catch {
        /* 继续向上 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const projectRoot = findProjectRoot();

export function dataDir(): string {
  const dir = process.env.WEB_AGENT_DATA_DIR
    ? path.resolve(process.env.WEB_AGENT_DATA_DIR)
    : path.join(projectRoot, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function workspacesRoot(): string {
  const dir = process.env.WEB_AGENT_WORKSPACES
    ? path.resolve(process.env.WEB_AGENT_WORKSPACES)
    : path.join(projectRoot, 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function clientDist(): string {
  return path.join(projectRoot, 'dist', 'client');
}
