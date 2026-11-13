/**
 * Tiny, dependency-free markdown helpers for an Obsidian-compatible vault:
 * YAML-ish frontmatter (scalars, inline [lists], block "- item" lists), [[wikilinks]], #tags.
 */

export type FrontValue = string | string[];
export type Frontmatter = Record<string, FrontValue>;

const FM_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    const inner = t.slice(1, -1);
    return t[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return t;
}

function splitInlineList(v: string): string[] {
  const inner = v.trim().slice(1, -1);
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of inner) {
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(unquote).filter((x) => x !== '');
}

/** split a note into frontmatter + body. Unparseable lines are ignored (kept out of the body). */
export function parseFrontmatter(src: string): { data: Frontmatter; body: string; hadFrontmatter: boolean } {
  const m = src.match(FM_RE);
  if (!m) return { data: {}, body: src.replace(/^\uFEFF/, ''), hadFrontmatter: false };
  const data: Frontmatter = {};
  const lines = m[1].split(/\r?\n/);
  let listKey: string | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s*(.*)$|^-\s+(.*)$/);
    if (item && listKey) {
      const v = unquote(item[1] ?? item[2] ?? '');
      const cur = data[listKey];
      data[listKey] = Array.isArray(cur) ? [...cur, v] : [v];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_][\w .-]*?)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const raw = kv[2].trim();
    if (raw === '') {
      listKey = key;
      data[key] = [];
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      listKey = null;
      data[key] = splitInlineList(raw);
    } else {
      listKey = null;
      data[key] = unquote(raw);
    }
  }
  return { data, body: src.slice(m[0].length), hadFrontmatter: true };
}

function needsQuote(s: string): boolean {
  return s === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || /:\s|\s#|[\r\n]|\s$/.test(s) || /^(true|false|null|yes|no|~)$/i.test(s);
}
const q = (s: string) => (needsQuote(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"` : s);

/** serialize frontmatter (keys in insertion order; lists as YAML block lists) + body */
export function stringifyNote(data: Frontmatter, body: string): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) return body;
  const lines: string[] = [];
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${k}: []`);
      else {
        lines.push(`${k}:`);
        for (const x of v) lines.push(`  - ${q(x)}`);
      }
    } else lines.push(`${k}: ${q(v)}`);
  }
  const b = body.replace(/^\r?\n+/, '');
  return `---\n${lines.join('\n')}\n---\n\n${b}${b.endsWith('\n') ? '' : '\n'}`;
}

/** normalize a tag: strip leading '#', trim, lowercase-insensitive compare is left to callers */
export function normalizeTag(t: string): string {
  return t.trim().replace(/^#+/, '').replace(/\s+/g, '-');
}

export function frontmatterTags(data: Frontmatter): string[] {
  const v = data.tags ?? data.tag;
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return arr.map(normalizeTag).filter(Boolean);
}

/** strip fenced code blocks and inline code so links/tags inside them are ignored */
export function stripCode(body: string): string {
  return body.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, '$1').replace(/`[^`\n]*`/g, '');
}

const WIKILINK_RE = /!?\[\[([^\]\n]+?)\]\]/g;

/** parse "[[Target#Heading|Alias]]" inner text */
export function parseWikilink(inner: string): { target: string; heading?: string; alias?: string } {
  let rest = inner;
  let alias: string | undefined;
  const pipe = rest.indexOf('|');
  if (pipe >= 0) {
    alias = rest.slice(pipe + 1).trim();
    rest = rest.slice(0, pipe);
  }
  let heading: string | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    heading = rest.slice(hash + 1).trim();
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim().replace(/\.md$/i, ''), heading, alias };
}

/** outgoing link targets as written (deduped, order preserved, same-note "[[#heading]]" skipped) */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of stripCode(body).matchAll(WIKILINK_RE)) {
    const { target } = parseWikilink(m[1]);
    if (!target) continue;
    const k = target.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(target);
    }
  }
  return out;
}

const TAG_RE = /(^|[\s(,;])#([\p{L}_][\p{L}\p{N}_/-]*)/gu;

/** inline #tags (not headings, not inside code, not URL fragments) */
export function extractInlineTags(body: string): string[] {
  const text = stripCode(body).replace(WIKILINK_RE, ' ');
  const out = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) out.add(m[2].replace(/[/-]+$/, ''));
  return [...out].filter(Boolean);
}

/** dedupe tags case-insensitively keeping first spelling */
export function uniqTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags.map(normalizeTag)) {
    const k = t.toLowerCase();
    if (t && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** plain-ish text for excerpts: drop headings markers, link syntax, emphasis */
export function plainText(body: string): string {
  return body
    .replace(/(^|\n)(```|~~~)[\s\S]*?\n\2/g, '\n')
    .replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
      const p = parseWikilink(inner);
      return p.alias || p.target;
    })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>]+/g, '')
    .replace(/^\s*[-+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
