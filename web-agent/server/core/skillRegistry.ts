/**
 * 技能库（只读复用仓库根目录的 `assets/skill_zip.zip`，26 个 SKILL.md）。
 *
 * 设计要点（与 EAgentX 的 Skills.cs 一致）：
 *   1. 启动时不做解压落盘，直接在内存里索引压缩包，避免污染工作区；
 *   2. 给模型只暴露「名称 + 摘要」，需要细节时再 `read_skill` 渐进式加载，节省上下文；
 *   3. 找不到压缩包时优雅降级为空技能库，不影响主流程。
 */

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

export interface SkillInfo {
  /** 技能目录名，例如 `weather` */
  id: string;
  name: string;
  description: string;
  group: string;
  version: string;
  license: string;
  /** SKILL.md 全文（不含 frontmatter 之外的裁剪，原样保留） */
  content: string;
  /** 同目录下的其它资源文件（相对该技能目录） */
  files: string[];
  /** 压缩包内路径 */
  zipPath: string;
}

let cache: SkillInfo[] | null = null;
let cachePath: string | null = null;

/** 从当前文件 / 工作目录向上寻找 `assets/skill_zip.zip`。 */
export function resolveSkillZip(): string | null {
  const envPath = process.env.SKILL_ZIP_PATH;
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath);

  const starts = [__dirname, process.cwd()];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 8; depth++) {
      const candidate = path.join(dir, 'assets', 'skill_zip.zip');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const meta: Record<string, string> = {};
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta, body: text };
  const head = text.slice(3, end).split('\n');
  for (const line of head) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[match[1]] = value;
  }
  const bodyStart = text.indexOf('\n', end + 1);
  return { meta, body: bodyStart < 0 ? '' : text.slice(bodyStart + 1) };
}

export function loadSkills(force = false): SkillInfo[] {
  const zipPath = resolveSkillZip();
  if (!force && cache && cachePath === zipPath) return cache;
  cachePath = zipPath;
  cache = [];
  if (!zipPath) return cache;

  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const skillEntries = entries.filter((e) => !e.isDirectory && e.entryName.replace(/\\/g, '/').endsWith('/SKILL.md'));

    for (const entry of skillEntries) {
      const zipEntryPath = entry.entryName.replace(/\\/g, '/');
      const skillDir = zipEntryPath.slice(0, zipEntryPath.length - '/SKILL.md'.length);
      const raw = entry.getData().toString('utf8');
      const { meta, body } = parseFrontmatter(raw);
      const id = skillDir.split('/').pop() ?? skillDir;
      const group = skillDir.includes('/') ? skillDir.split('/')[0] : '未分组';
      const files = entries
        .filter((e) => !e.isDirectory)
        .map((e) => e.entryName.replace(/\\/g, '/'))
        .filter((name) => name.startsWith(skillDir + '/') && name !== zipEntryPath)
        .map((name) => name.slice(skillDir.length + 1));

      cache.push({
        id,
        name: meta.name || id,
        description: meta.description || firstParagraph(body) || '（无描述）',
        group,
        version: meta.version || '',
        license: meta.license || '',
        content: raw,
        files,
        zipPath: zipEntryPath,
      });
    }
    cache.sort((a, b) => (a.group + a.id).localeCompare(b.group + b.id));
  } catch {
    cache = [];
  }
  return cache;
}

function firstParagraph(body: string): string {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('>'));
  return (lines[0] ?? '').slice(0, 240);
}

export function skillsCount(): number {
  return loadSkills().length;
}

export function listSkills(): Array<Pick<SkillInfo, 'id' | 'name' | 'description' | 'group' | 'version' | 'files'>> {
  return loadSkills().map(({ id, name, description, group, version, files }) => ({
    id,
    name,
    description,
    group,
    version,
    files,
  }));
}

export function findSkill(nameOrId: string): SkillInfo | null {
  const key = (nameOrId ?? '').trim().toLowerCase();
  if (!key) return null;
  const skills = loadSkills();
  return (
    skills.find((s) => s.id.toLowerCase() === key) ??
    skills.find((s) => s.name.toLowerCase() === key) ??
    skills.find((s) => s.id.toLowerCase().includes(key) || s.name.toLowerCase().includes(key)) ??
    null
  );
}

/** 渲染技能清单为给模型看的紧凑文本。 */
export function renderSkillCatalog(): string {
  const skills = loadSkills();
  if (skills.length === 0) return '（技能库未加载：未找到 assets/skill_zip.zip）';
  const groups = new Map<string, SkillInfo[]>();
  for (const skill of skills) {
    const list = groups.get(skill.group) ?? [];
    list.push(skill);
    groups.set(skill.group, list);
  }
  const lines: string[] = [`共 ${skills.length} 个技能：`];
  for (const [group, list] of groups) {
    lines.push(`\n## ${group}`);
    for (const skill of list) {
      lines.push(`- ${skill.id} — ${skill.description}`);
    }
  }
  return lines.join('\n');
}
