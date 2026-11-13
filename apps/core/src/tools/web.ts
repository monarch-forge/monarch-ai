/** Web tools: search (DuckDuckGo HTML), fetch (readable text), open in the user's browser. */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool, type ToolDef } from '../kernel.ts';

/** generic desktop browser UA — never includes anything about the user */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAX_TEXT = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** crude but robust HTML → readable text */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // prefer <main>/<article> when present
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(s);
  if (main && main[2].replace(/<[^>]+>/g, '').trim().length > 500) s = main[2];
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/(p|div|section|article|h[1-6]|ul|ol|table|tr|blockquote|pre|header|main)>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: s };
}

async function readCapped(res: Response, max = MAX_BYTES): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const ct = res.headers.get('content-type') ?? '';
  const charset = /charset=([\w-]+)/i.exec(ct)?.[1] ?? 'utf-8';
  let dec: TextDecoder;
  try {
    dec = new TextDecoder(charset);
  } catch {
    dec = new TextDecoder('utf-8');
  }
  return dec.decode(Buffer.concat(chunks).subarray(0, max));
}

const signalFor = (ctx: { signal: AbortSignal }, ms: number) => AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]);

/* ─────────────── web_search ─────────────── */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function ddgTarget(href: string): string | null {
  const h = decodeEntities(href);
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com')) {
      if (u.pathname === '/y.js') return null; // ad
      const target = u.searchParams.get('uddg');
      return target ? target : null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function getHtml(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function searchDuckDuckGo(query: string, max: number, signal: AbortSignal): Promise<SearchResult[]> {
  const html = await getHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, signal);
  const out: SearchResult[] = [];
  // each organic result: <a class="result__a" href="…">title</a> … <a class="result__snippet" …>snippet</a>
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    if (/result--ad/.test(b.slice(0, 200))) continue;
    const a =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b) ??
      /<a[^>]+href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = ddgTarget(a[1]);
    if (!url || out.some((r) => r.url === url)) continue;
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(b);
    out.push({ title: clean(a[2]), url, snippet: sn ? clean(sn[1]) : '' });
    if (out.length >= max) break;
  }
  if (!out.length && /anomaly|captcha|challenge/i.test(html)) throw new Error('rate-limited');
  return out;
}

function bingTarget(href: string): string | null {
  const h = decodeEntities(href);
  try {
    const u = new URL(h, 'https://www.bing.com');
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const enc = u.searchParams.get('u');
      if (!enc?.startsWith('a1')) return null;
      return Buffer.from(enc.slice(2), 'base64url').toString('utf8');
    }
    return u.hostname.endsWith('bing.com') ? null : u.toString();
  } catch {
    return null;
  }
}

async function searchBing(query: string, max: number, signal: AbortSignal): Promise<SearchResult[]> {
  const html = await getHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=en-US&setlang=en-US&adlt=strict&form=QBLH`, signal);
  const out: SearchResult[] = [];
  for (const b of html.split('<li class="b_algo"').slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = bingTarget(a[1]);
    if (!url || !/^https?:/.test(url) || out.some((r) => r.url === url)) continue;
    const sn = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(b);
    out.push({ title: clean(a[2]), url, snippet: sn ? clean(sn[1]) : '' });
    if (out.length >= max) break;
  }
  return out;
}

const PROVIDERS = [
  { name: 'duckduckgo', fn: searchDuckDuckGo },
  { name: 'bing', fn: searchBing },
];
/** provider name -> time until which it is skipped after a failure (e.g. blocked network, rate limit) */
const backoff = new Map<string, number>();

/** web search with provider fallback (DuckDuckGo HTML, then Bing); a failing provider is skipped for 10 minutes */
export async function webSearch(query: string, max = 8, signal?: AbortSignal): Promise<SearchResult[]> {
  const errors: string[] = [];
  const active = PROVIDERS.filter((p) => (backoff.get(p.name) ?? 0) < Date.now());
  for (const p of active.length ? active : PROVIDERS) {
    const sig = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(7000)]);
    try {
      const r = await p.fn(query, max, sig);
      backoff.delete(p.name);
      if (r.length) return r;
      errors.push(`${p.name}: no results`);
    } catch (e) {
      if (signal?.aborted) throw e;
      backoff.set(p.name, Date.now() + 10 * 60e3);
      errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
  if (errors.every((e) => e.endsWith('no results'))) return [];
  throw new Error(`web search failed (${errors.join('; ')}); try again later or use web_fetch on a known URL`);
}

const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Search the web (DuckDuckGo, falling back to Bing) and return up to 8 results with title, URL and snippet. Use for current events, facts you are unsure of, documentation, prices, etc. Follow up with web_fetch to read a result.',
  risk: 'safe',
  tag: 'NET',
  schema: z.object({
    query: z.string().min(1).describe('Search query (plain keywords work best).'),
    max: z.number().int().min(1).max(8).optional().describe('Max results (default 8).'),
  }),
  summarize: (i) => `Search: ${i.query}`,
  run: async ({ query, max = 8 }, ctx) => {
    const results = await webSearch(query, max, signalFor(ctx, 20_000));
    if (!results.length) return `No results for "${query}".`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n');
  },
});

/* ─────────────── web_fetch ─────────────── */

const webFetchTool = defineTool({
  name: 'web_fetch',
  description:
    'Fetch a URL (HTTP GET) and return its readable text: HTML is stripped to text (scripts/styles/navigation removed), JSON is pretty-printed, plain text is returned as-is. Output is capped at ~20k characters; use `offset` to page through long documents.',
  risk: 'safe',
  tag: 'NET',
  schema: z.object({
    url: z.string().describe('Absolute http(s) URL.'),
    offset: z.number().int().min(0).optional().describe('Character offset into the extracted text (for paging; default 0).'),
  }),
  summarize: (i) => `Fetch ${i.url}`,
  run: async ({ url, offset = 0 }, ctx) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`invalid URL: ${url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs can be fetched');
    const res = await fetch(u, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: signalFor(ctx, 20_000),
    });
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const head = `URL: ${res.url}\nStatus: ${res.status} ${res.statusText}\nContent-Type: ${ct || 'unknown'}`;
    const textual = !ct || /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|csv|markdown/.test(ct);
    if (!textual) {
      res.body?.cancel().catch(() => {});
      const len = res.headers.get('content-length');
      return `${head}\nBinary content${len ? ` (${len} bytes)` : ''} — not shown. Use open_url to open it in the browser.`;
    }
    const raw = await readCapped(res);
    let body: string;
    let title = '';
    if (ct.includes('json')) {
      try {
        body = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        body = raw;
      }
    } else if (ct.includes('html') || (!ct && /<html|<body|<!doctype html/i.test(raw.slice(0, 2000)))) {
      ({ title, text: body } = htmlToText(raw));
    } else {
      body = raw;
    }
    const slice = body.slice(offset);
    const more = slice.length > MAX_TEXT ? `\n… [${slice.length - MAX_TEXT} more chars — call again with offset=${offset + MAX_TEXT}]` : '';
    return `${head}${title ? `\nTitle: ${title}` : ''}\nLength: ${body.length} chars\n\n${slice.slice(0, MAX_TEXT)}${more}`;
  },
});

/* ─────────────── open_url ─────────────── */

const openUrlTool = defineTool({
  name: 'open_url',
  description: "Open a URL in the user's default web browser (or mail client for mailto:). Use when the user asks to open/show a page.",
  risk: 'sensitive',
  tag: 'NET',
  schema: z.object({ url: z.string().describe('http(s) or mailto: URL.') }),
  summarize: (i) => `Open ${i.url}`,
  run: async ({ url }) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`invalid URL: ${url}`);
    }
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new Error('only http(s) and mailto: URLs can be opened');
    const href = u.toString();
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [href]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '""', href.replace(/&/g, '^&')]]
          : ['xdg-open', [href]];
    await new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
      p.once('error', (e) => reject(new Error(`could not launch ${cmd}: ${e.message}`)));
      p.once('spawn', () => {
        p.unref();
        resolve();
      });
    });
    return `Opened ${href} in the default browser.`;
  },
});

export const tools: ToolDef[] = [webSearchTool, webFetchTool, openUrlTool];
