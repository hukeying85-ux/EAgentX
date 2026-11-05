/**
 * 命令完整性检查（移植自 EAgentX `src/Core/CommandShape.cs`）。
 *
 * 模型的长回复被截断时，会剩下 `$a`、`(`、`Add-Content ... '` 这类残片，
 * 直接丢给 shell 只会得到一堆语法错误，还会污染上下文。这里做一次轻量扫描：
 *   - 单/双引号是否闭合（PowerShell 的 `''` / `` ` ``、Bash 的 `\` 转义）
 *   - here-string `@' ... '@` / `@" ... "@` 是否闭合
 *   - Bash heredoc `<< 'EOF' ... EOF` 是否有结束行
 *   - `()` / `[]` / `{}` 是否配对
 *   - 结尾是否停在 `& + , - = \` |` 这类操作符上
 */

export interface ShapeReport {
  complete: boolean;
  reason?: string;
}

const TRAILING_OPERATORS = new Set(['&', '+', ',', '-', '=', '`', '|']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function isHeredocDelimiterStart(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z_"']/.test(ch);
}

interface HeredocScan {
  found: boolean;
  delimiter: string;
  end: number;
}

/** 从 `<<` 之后解析 heredoc 头，并逐行找结束行；返回结束位置之后的下标。 */
function scanHeredoc(text: string, at: number): HeredocScan | null {
  let j = at + 2;
  let stripTabs = false;
  if (text[j] === '-') {
    stripTabs = true;
    j++;
  }
  while (text[j] === ' ' || text[j] === '\t') j++;
  if (!isHeredocDelimiterStart(text[j])) return null;
  const quote = text[j] === "'" || text[j] === '"' ? text[j] : '';
  if (quote) j++;
  const start = j;
  while (j < text.length && /[A-Za-z0-9_.:-]/.test(text[j])) j++;
  const delimiter = text.slice(start, j);
  if (!delimiter) return null;
  if (quote && text[j] === quote) j++;

  let lineStart = text.indexOf('\n', j);
  if (lineStart < 0) return { found: false, delimiter, end: text.length };
  lineStart += 1;

  while (lineStart <= text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    const candidate = stripTabs ? line.replace(/^\t+/, '') : line;
    if (candidate.trim() === delimiter) {
      return { found: true, delimiter, end: lineEnd < 0 ? text.length : lineEnd + 1 };
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return { found: false, delimiter, end: text.length };
}

/** 行首的 here-string 结束符（`'@` 或 `"@`），返回结束符之后的下标。 */
function findHereStringEnd(text: string, start: number, quote: string): number {
  if (start >= text.length) return -1;
  let newline = text.indexOf('\n', start);
  while (newline >= 0) {
    let lineStart = newline + 1;
    while (lineStart < text.length && (text[lineStart] === ' ' || text[lineStart] === '\t')) lineStart++;
    if (lineStart + 1 < text.length && text[lineStart] === quote && text[lineStart + 1] === '@') {
      return lineStart + 2;
    }
    newline = text.indexOf('\n', newline + 1);
  }
  return -1;
}

export function checkCommandShape(command: string | null | undefined): ShapeReport {
  if (command == null) return { complete: false, reason: '命令为空' };
  const text = command.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.trim().length === 0) return { complete: false, reason: '命令为空' };

  const open: string[] = [];
  let lastSignificant = '\0';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }

    // 行注释：# 到行尾
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    // 块注释：<# ... #>
    if (ch === '<' && text[i + 1] === '#') {
      const commentEnd = text.indexOf('#>', i + 2);
      if (commentEnd < 0) return { complete: false, reason: '块注释 <# 没有闭合' };
      i = commentEnd + 2;
      continue;
    }

    // Bash heredoc：<< 'EOF' ... EOF
    if (ch === '<' && text[i + 1] === '<') {
      const heredoc = scanHeredoc(text, i);
      if (heredoc) {
        if (!heredoc.found) {
          return { complete: false, reason: `heredoc 缺少结束行 ${heredoc.delimiter}` };
        }
        lastSignificant = '\n';
        i = heredoc.end;
        continue;
      }
    }

    // 单引号字符串：PowerShell 内部 '' 表示一个转义的单引号
    if (ch === "'") {
      let scan = i + 1;
      let closed = false;
      while (scan < text.length) {
        if (text[scan] === "'") {
          if (scan + 1 >= text.length || text[scan + 1] !== "'") {
            closed = true;
            break;
          }
          scan += 2;
        } else {
          scan++;
        }
      }
      if (!closed) return { complete: false, reason: '单引号没有闭合' };
      lastSignificant = "'";
      i = scan + 1;
      continue;
    }

    // 双引号字符串：` 转义下一个字符，"" 表示一个转义的双引号
    if (ch === '"') {
      let scan = i + 1;
      let closed = false;
      while (scan < text.length) {
        if (text[scan] === '`' && scan + 1 < text.length) {
          scan += 2;
        } else if (text[scan] === '"') {
          if (scan + 1 >= text.length || text[scan + 1] !== '"') {
            closed = true;
            break;
          }
          scan += 2;
        } else {
          scan++;
        }
      }
      if (!closed) return { complete: false, reason: '双引号没有闭合' };
      lastSignificant = '"';
      i = scan + 1;
      continue;
    }

    // here-string：@' ... '@ 或 @" ... "@，结束符必须在行首
    if (ch === '@' && (text[i + 1] === "'" || text[i + 1] === '"')) {
      let bodyStart = i + 2;
      while (bodyStart < text.length && (text[bodyStart] === ' ' || text[bodyStart] === '\t')) bodyStart++;
      if (bodyStart >= text.length || text[bodyStart] === '\n') {
        const quote = text[i + 1];
        const hereEnd = findHereStringEnd(text, bodyStart, quote);
        if (hereEnd < 0) return { complete: false, reason: 'here-string 没有闭合' };
        lastSignificant = quote;
        i = hereEnd;
        continue;
      }
    }

    if (OPENERS.has(ch)) {
      open.push(ch);
      lastSignificant = ch;
      i++;
      continue;
    }

    if (CLOSERS[ch]) {
      const pair = open.pop();
      if (pair === undefined) return { complete: false, reason: `多余的右括号 ${ch}` };
      if (pair !== CLOSERS[ch]) return { complete: false, reason: `括号不配对：${pair} ... ${ch}` };
      lastSignificant = ch;
      i++;
      continue;
    }

    lastSignificant = ch;
    i++;
  }

  if (open.length > 0) return { complete: false, reason: `括号没有闭合：${open.join('')}` };
  if (lastSignificant === '\0') return { complete: false, reason: '命令为空' };
  if (TRAILING_OPERATORS.has(lastSignificant)) {
    return { complete: false, reason: `结尾停在操作符 "${lastSignificant}" 上，命令可能被截断` };
  }
  return { complete: true };
}

export function isComplete(command: string | null | undefined): boolean {
  return checkCommandShape(command).complete;
}
