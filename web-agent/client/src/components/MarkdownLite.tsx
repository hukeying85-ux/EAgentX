/** 轻量 Markdown 渲染（标题 / 列表 / 粗体 / 行内代码 / 代码块），不额外引入依赖。 */

import type { ReactNode } from 'react';

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((part) => part.length > 0);
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-day-bg px-1.5 py-0.5 text-[12.5px] text-day-text dark:bg-night-bg dark:text-night-text"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

interface Block {
  type: 'code' | 'text';
  lang?: string;
  content: string;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const regex = /```([A-Za-z0-9_+#:.-]*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) blocks.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    blocks.push({ type: 'code', lang: match[1], content: match[2] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) blocks.push({ type: 'text', content: text.slice(lastIndex) });
  return blocks;
}

export function MarkdownLite({ text }: { text: string }) {
  const cleaned = text.replace(/\[TASK_DONE\]/gi, '').replace(/\[NEED_INPUT\]/gi, '');
  const blocks = splitBlocks(cleaned);

  return (
    <div className="space-y-2 text-[14px] leading-relaxed">
      {blocks.map((block, blockIndex) => {
        if (block.type === 'code') {
          return (
            <pre
              key={`code-${blockIndex}`}
              className="scrollbar-thin max-h-80 overflow-auto rounded-xl border border-day-line bg-day-bg p-3 text-[12.5px] leading-relaxed text-day-text dark:border-night-line dark:bg-night-bg dark:text-night-text"
            >
              <code>{block.content.replace(/\s+$/, '')}</code>
            </pre>
          );
        }

        const lines = block.content.split('\n');
        const nodes: ReactNode[] = [];
        let listBuffer: string[] = [];

        const flushList = () => {
          if (listBuffer.length === 0) return;
          nodes.push(
            <ul key={`ul-${nodes.length}`} className="ml-4 list-disc space-y-1">
              {listBuffer.map((item, index) => (
                <li key={`li-${index}`}>{renderInline(item, `li-${blockIndex}-${index}`)}</li>
              ))}
            </ul>,
          );
          listBuffer = [];
        };

        lines.forEach((rawLine, lineIndex) => {
          const line = rawLine.trimEnd();
          const trimmed = line.trim();
          const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
          if (bullet) {
            listBuffer.push(bullet[1]);
            return;
          }
          flushList();

          if (!trimmed) {
            return;
          }
          const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
          if (heading) {
            const level = heading[1].length;
            const className =
              level <= 2
                ? 'text-[15px] font-semibold pt-1'
                : 'text-[13px] font-semibold uppercase tracking-wide text-day-muted dark:text-night-muted pt-1';
            nodes.push(
              <p key={`h-${blockIndex}-${lineIndex}`} className={className}>
                {renderInline(heading[2], `h-${blockIndex}-${lineIndex}`)}
              </p>,
            );
            return;
          }
          const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
          if (numbered) {
            nodes.push(
              <p key={`n-${blockIndex}-${lineIndex}`} className="pl-1">
                <span className="mr-1.5 text-day-muted dark:text-night-muted">{numbered[1]}.</span>
                {renderInline(numbered[2], `n-${blockIndex}-${lineIndex}`)}
              </p>,
            );
            return;
          }
          nodes.push(
            <p key={`p-${blockIndex}-${lineIndex}`}>{renderInline(line, `p-${blockIndex}-${lineIndex}`)}</p>,
          );
        });
        flushList();

        return <div key={`text-${blockIndex}`} className="space-y-1.5">{nodes}</div>;
      })}
    </div>
  );
}
