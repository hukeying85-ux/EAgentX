/**
 * 工具输出截断（移植自 EAgentX `PowerShellRunner` 的头 8000 / 尾 3000 策略）。
 * 超长输出直接回喂给模型既烧 Token 又容易挤掉关键信息，这里保留头尾并标注省略字数。
 */

export interface TruncateOptions {
  head?: number;
  tail?: number;
  /** 超过多少字符才截断 */
  threshold?: number;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  omittedChars: number;
  totalChars: number;
}

export function truncateOutput(raw: string, options: TruncateOptions = {}): TruncateResult {
  const head = options.head ?? 8000;
  const tail = options.tail ?? 3000;
  const threshold = options.threshold ?? 12000;
  const text = raw ?? '';
  if (text.length <= threshold) {
    return { text, truncated: false, omittedChars: 0, totalChars: text.length };
  }
  const omitted = text.length - head - tail;
  const merged = `${text.slice(0, head)}\n\n…（省略 ${omitted} 个字符）…\n\n${text.slice(text.length - tail)}`;
  return { text: merged, truncated: true, omittedChars: omitted, totalChars: text.length };
}
