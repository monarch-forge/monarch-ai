/**
 * Tiny, safe markdown renderer for memory notes (Obsidian flavour).
 * Everything is HTML-escaped FIRST; only a fixed set of tags is generated afterwards.
 * Supports: headings, paragraphs, bold/italic/strike, inline + fenced code, blockquotes, hr,
 * ordered/unordered/task lists, [text](http…) links, [[wikilinks|alias]] and #tags.
 * Wikilinks render as <a class="md-wikilink" data-wikilink="target">; tags as <span class="md-tag" data-tag="tag">.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface MdOptions {
  /** return false for wikilink targets that don't exist (rendered as ghost links) */
  exists?: (target: string) => boolean;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** inline formatting on an already-escaped string */
function inline(src: string, opts: MdOptions): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = src;
  // inline code first — its content is never formatted further
  s = s.replace(/`([^`]+)`/g, (_, c: string) => hold(`<code>${c}</code>`));
  // wikilinks [[target#heading|alias]]
  s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, rawTarget: string, alias?: string) => {
    const target = rawTarget.split('#')[0].trim();
    const label = (alias ?? rawTarget).trim();
    const ghost = opts.exists ? !opts.exists(unescapeHtml(target)) : false;
    return hold(`<a class="md-wikilink${ghost ? ' md-ghost' : ''}" data-wikilink="${target}" href="#" title="${target}">${label}</a>`);
  });
  // markdown links (only http/https/mailto)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    const u = unescapeHtml(url);
    if (!SAFE_URL.test(u)) return m;
    return hold(`<a class="md-ext" href="${url}" data-external="${url}" rel="noreferrer noopener">${label}</a>`);
  });
  // bare urls
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => `${pre}${hold(`<a class="md-ext" href="${url}" data-external="${url}" rel="noreferrer noopener">${url}</a>`)}`);
  // tags (#tag, #area/sub) — not inside words, not pure numbers
  s = s.replace(/(^|[\s(])#([A-Za-z_][\w\-/]*)/g, (_, pre: string, tag: string) => `${pre}${hold(`<span class="md-tag" data-tag="${tag}">#${tag}</span>`)}`);
  // emphasis
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  // restore held fragments
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
}

function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function renderMarkdown(source: string, opts: MdOptions = {}): string {
  const lines = escapeHtml(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, opts)).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map((l) => inline(l, opts)).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushAll();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      out.push(`<pre><code${fence[2] ? ` data-lang="${fence[2]}"` : ''}>${body.join('\n')}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushAll();
      const lvl = Math.min(h[1].length, 4);
      out.push(`<h${lvl}>${inline(h[2].replace(/\s+#+\s*$/, ''), opts)}</h${lvl}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }
    const q = line.match(/^\s*&gt;\s?(.*)$/);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      flushQuote();
      const type = ul ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      let text = (ul ?? ol)![1];
      const task = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        const done = task[1] !== ' ';
        text = `<span class="md-task${done ? ' md-task-done' : ''}" aria-hidden="true"></span>${inline(task[2], opts)}`;
        list.items.push(text);
      } else list.items.push(inline(text, opts));
      continue;
    }
    // continuation of a list item (indented line)
    if (list && /^\s{2,}\S/.test(line)) {
      const items = list.items;
      items[items.length - 1] += `<br>${inline(line.trim(), opts)}`;
      continue;
    }
    flushList();
    flushQuote();
    para.push(line);
  }
  flushAll();
  return out.join('\n');
}

/** quick plain-text excerpt (for list rows) */
export function plainExcerpt(md: string, max = 140): string {
  const t = (md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a)
    .replace(/[#>*_`~=-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
