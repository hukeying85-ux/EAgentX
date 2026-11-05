import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSkill, listSkills, loadSkills, renderSkillCatalog, resolveSkillZip } from '../server/core/skillRegistry';

describe('skillRegistry（真实读取 ../assets/skill_zip.zip）', () => {
  it('能找到仓库根目录的技能压缩包', () => {
    const zip = resolveSkillZip();
    expect(zip).toBeTruthy();
    expect(fs.existsSync(zip as string)).toBe(true);
    expect(path.basename(zip as string)).toBe('skill_zip.zip');
  });

  it('索引出至少 20 个 SKILL.md 技能', () => {
    const skills = loadSkills();
    expect(skills.length).toBeGreaterThanOrEqual(20);
    const ids = skills.map((skill) => skill.id);
    expect(ids).toContain('weather');
    expect(ids).toContain('frontend-design');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('解析 frontmatter 的名称与摘要', () => {
    const weather = findSkill('weather');
    expect(weather).not.toBeNull();
    expect(weather?.name).toBe('weather');
    expect(weather?.description.toLowerCase()).toContain('weather');
    expect(weather?.content).toContain('# Weather');
  });

  it('支持按名称模糊查找并给出附带文件', () => {
    const skill = findSkill('bad-apple');
    expect(skill?.id).toBe('bad-apple-cli');
    expect(skill?.files).toContain('render.cs');
  });

  it('清单文本包含分组与技能名', () => {
    const catalog = renderSkillCatalog();
    expect(catalog).toContain('共');
    expect(catalog).toContain('weather');
    expect(listSkills()[0].group.length).toBeGreaterThan(0);
  });
});
