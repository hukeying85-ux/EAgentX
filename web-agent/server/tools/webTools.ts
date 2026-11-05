/**
 * fetch_page：抓取网页并转成可读 Markdown（对标 arena.ai/agent 的网页阅读工具）。
 * 只允许 http/https；网络受限或目标站点拒绝时返回可读的错误说明，而不是抛异常中断会话。
 */

import type { ToolResult } from '../types';

const MAX_HTML = 2_000_000;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|table|blockquote|pre)>/gi, '\n');
  text = text.replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `${'#'.repeat(Number(level))} `);
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
    const clean = label.replace(/<[^>]+>/g, '').trim();
    if (!clean) return '';
    return clean === href ? href : `${clean} (${href})`;
  });
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export interface FetchPageArgs {
  url: string;
  max_chars?: number;
}

export async function fetchPage(args: FetchPageArgs, signal?: AbortSignal): Promise<ToolResult> {
  const url = (args.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, output: '只支持 http/https 链接。' };
  }
  const maxChars = Math.min(40000, Math.max(1000, Math.floor(args.max_chars ?? 12000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EAgentX-WebAgent/0.1; +https://github.com/) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    const contentType = response.headers.get('content-type') ?? '';
    const body = (await response.text()).slice(0, MAX_HTML);

    if (!response.ok) {
      return {
        ok: false,
        output: `抓取失败：HTTP ${response.status} ${response.statusText}\n${htmlToText(body).slice(0, 800)}`,
        meta: { status: response.status, url },
      };
    }

    const isHtml = /html|xml/i.test(contentType);
    const isJson = /json/i.test(contentType);
    const text = isHtml || (!isJson && body.includes('<html')) ? htmlToText(body) : body;
    const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n…（已截断，原文 ${text.length} 字符）` : text;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim();
    return {
      ok: true,
      output: `# ${title ? decodeEntities(title) : url}\n来源：${url}\n\n${truncated}`,
      meta: { status: response.status, url, chars: text.length, contentType },
    };
  } catch (error) {
    const message = (error as Error).message;
    const friendly = /abort/i.test(message)
      ? '请求超时或被中断（可能是网络受限）。'
      : `网络请求失败：${message}（沙箱可能没有出网权限，请改用其它方式获取信息）。`;
    return { ok: false, output: friendly, meta: { url } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
