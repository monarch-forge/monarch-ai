/**
 * Pure helpers for Gmail: base64url, RFC 2822 MIME building, RFC 2047 header encoding,
 * HTML → text and HTML sanitizing. No network, no state — unit-testable.
 */

/* ─────────────── base64url ─────────────── */

export function base64UrlEncode(input: string | Uint8Array): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecodeBytes(data: string): Buffer {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/** decode a Gmail body part (base64url) using the part's charset (default utf-8). */
export function base64UrlDecode(data: string, charset = 'utf-8'): string {
  const bytes = base64UrlDecodeBytes(data);
  try {
    return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function normalizeCharset(cs: string): string {
  const c = cs.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!c || c === 'us-ascii' || c === 'ascii') return 'utf-8';
  return c;
}

/* ─────────────── RFC 2047 header encoding ─────────────── */

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Encode a header value as RFC 2047 encoded-words (UTF-8, base64) if it contains non-ASCII. */
export function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value;
  // chunk by whole code points so each encoded-word stays <= 75 chars (≤ 45 bytes of payload)
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Encode display names inside an address list: `Zoë <z@x.com>, b@y.com` → `=?UTF-8?B?...?= <z@x.com>, b@y.com` */
export function encodeAddressList(list: string): string {
  return splitAddressList(list)
    .map((addr) => {
      const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
      if (!m) return addr.trim();
      const name = m[1].trim();
      const email = m[2].trim();
      if (!name) return email;
      if (isAscii(name)) return /[,;:@<>()[\]\\"]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}" <${email}>` : `${name} <${email}>`;
      return `${encodeHeaderWord(name)} <${email}>`;
    })
    .join(', ');
}

/** split "A <a@x>, \"Doe, J\" <j@x>; c@x" on top-level commas/semicolons (respecting quotes and <>). */
export function splitAddressList(list: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let inAngle = false;
  for (const ch of list) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === '<' && !inQuote) inAngle = true;
    else if (ch === '>' && !inQuote) inAngle = false;
    if ((ch === ',' || ch === ';') && !inQuote && !inAngle) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** extract bare email from "Name <a@b>" */
export function emailOf(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim();
}

/* ─────────────── MIME builder ─────────────── */

export interface MimeInput {
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** plain-text body */
  text: string;
  inReplyTo?: string;
  references?: string;
  date?: Date;
}

/** wrap base64 at 76 cols */
function wrap76(s: string): string {
  return s.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

/** Build an RFC 2822 single-part text/plain UTF-8 message (CRLF line endings, base64 body). */
export function buildMime(m: MimeInput): string {
  const stripCrlf = (v: string) => v.replace(/[\r\n]+/g, ' ').trim(); // header injection guard
  const headers: string[] = [];
  if (m.from) headers.push(`From: ${encodeAddressList(stripCrlf(m.from))}`);
  headers.push(`To: ${encodeAddressList(stripCrlf(m.to))}`);
  if (m.cc?.trim()) headers.push(`Cc: ${encodeAddressList(stripCrlf(m.cc))}`);
  if (m.bcc?.trim()) headers.push(`Bcc: ${encodeAddressList(stripCrlf(m.bcc))}`);
  headers.push(`Subject: ${encodeHeaderWord(stripCrlf(m.subject))}`);
  headers.push(`Date: ${(m.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`);
  if (m.inReplyTo) headers.push(`In-Reply-To: ${stripCrlf(m.inReplyTo)}`);
  if (m.references) headers.push(`References: ${stripCrlf(m.references)}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64');
  const body = wrap76(Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/** "Re: " prefix unless already present */
export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/* ─────────────── HTML helpers ─────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷',
  laquo: '«', raquo: '»', zwnj: '', zwj: '', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

/** Convert an HTML email body to readable plain text. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(head|style|script|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  // links: keep the URL when it adds information
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!text) return '';
    if (/^(mailto:|#|javascript:)/i.test(href) || text === href || decodeEntities(text) === decodeEntities(href)) return text;
    return `${text} (${href})`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote|section|article|header|footer|pre)\s*>/gi, '\n');
  s = s.replace(/<(p|div|h[1-6]|tr|table|blockquote|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, ' ');
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Remove active content from email HTML: script/style/iframe/object/embed/form elements,
 * on* event-handler attributes, javascript:/vbscript: URLs and <meta http-equiv>/<base>.
 * The UI should still render it in a sandboxed iframe — this is defence in depth, not a full sanitizer.
 */
export function sanitizeHtml(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|iframe|object|embed|applet|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<\/?(script|style|iframe|object|embed|applet|form|input|button|textarea|select|base|meta|link|frame|frameset)\b[^>]*>/gi, '');
  // event handler attributes (quoted / unquoted)
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // javascript: / vbscript: / data:text/html URLs in attributes
  s = s.replace(
    /\s+(href|src|action|formaction|xlink:href|background|poster)\s*=\s*("\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*'|(?:javascript|vbscript):[^\s>]*)/gi,
    '',
  );
  // CSS expression()
  s = s.replace(/expression\s*\(/gi, 'blocked(');
  return s.trim();
}
