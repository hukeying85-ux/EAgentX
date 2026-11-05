import { describe, expect, it } from 'vitest';
import { checkCommandShape, isComplete } from '../server/core/commandShape';

describe('commandShape（命令残片拦截）', () => {
  it('接受完整命令', () => {
    expect(isComplete('ls -la')).toBe(true);
    expect(isComplete('echo "hello world"')).toBe(true);
    expect(isComplete("echo 'it''s ok'")).toBe(true);
    expect(isComplete('Get-ChildItem | Where-Object { $_.Name -like "*.md" }')).toBe(true);
    expect(isComplete('cat <<EOF | grep foo\nbar\nfoo\nEOF')).toBe(true);
  });

  it('拦截未闭合的引号 / 括号 / heredoc', () => {
    expect(isComplete('echo "unterminated')).toBe(false);
    expect(isComplete("echo 'unterminated")).toBe(false);
    expect(isComplete('Get-ChildItem -Filter *.md (')).toBe(false);
    expect(isComplete('if (x) { echo hi')).toBe(false);
    expect(isComplete('cat <<EOF\nhello')).toBe(false);
    expect(isComplete("Add-Content -Path a.txt -Value '")).toBe(false);
  });

  it('拦截结尾停在操作符上的残片', () => {
    expect(isComplete('echo hello |')).toBe(false);
    expect(isComplete('echo hello &&')).toBe(false);
    expect(isComplete('$a =')).toBe(false);
    expect(isComplete('Get-Item -Path a.txt -')).toBe(false);
  });

  it('忽略注释内容', () => {
    expect(isComplete('# 只有注释\nls')).toBe(true);
    expect(isComplete('<# 块注释 #>\nls')).toBe(true);
    expect(isComplete('<# 未闭合的块注释')).toBe(false);
  });

  it('给出人类可读的原因', () => {
    const report = checkCommandShape('echo "abc');
    expect(report.complete).toBe(false);
    expect(report.reason).toContain('双引号');
  });
});
