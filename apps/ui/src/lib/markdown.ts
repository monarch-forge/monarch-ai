/**
 * Tiny, dependency-free, XSS-safe markdown → HTML renderer for chat transcripts (UI-B).
 *
 * Everything that comes from the input is HTML-escaped before any markup is added, and link targets are
 * restricted to http(s)/mailto. Supported: ATX headings, paragraphs, bold/italic/strike, inline code,
 * fenced code blocks (``` / ~~~ with a language label + copy button), nested ordered/unordered/task lists,
 * blockquotes, GFM tables, horizontal rules, autolinks.
 *
 * Interactive bits are emitted as data attributes and handled by the <Markdown> component via event delegation:
 *   - links:        <a data-ext href="…">         → openExternal(href)
 *   - copy buttons: <button data-copy>            → copies the sibling <pre><code> text
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** allow only safe link schemes; returns escaped href or null */
function safeHref(raw: string): string | null {
  const url = raw.trim().replace(/^<|>$/g, '');
  if (/^(https?:|mailto:)/i.test(url)) return escapeHtml(url);
  if (/^www\./i.test(url)) return escapeHtml(`https://${url}`);
  return null;
}

/* ───────────────────────── inline ───────────────────────── */

function renderInline(src: string): string {
  // 1. pull out code spans so their content is never formatted
  const slots: string[] = [];
  const stash = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) => stash(`<code>${escapeHtml(code.trim() === '' ? code : code.replace(/^ (.*) $/, '$1'))}</code>`));

  // 2. links [text](url "title") and images (rendered as links — no remote image loads)
  s = s.replace(/!?\[([^\]]*)\]\(\s*(<[^>]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/g, (_m, text: string, url: string) => {
    const href = safeHref(url);
    const label = renderEmphasis(escapeHtml(text || url));
    return href ? stash(`<a data-ext href="${href}" title="${href}">${label}</a>`) : stash(label);
  });

  // 3. bare autolinks
  s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"])/g, (_m, pre: string, url: string) => {
    const href = safeHref(url);
    return href ? `${pre}${stash(`<a data-ext href="${href}">${escapeHtml(url)}</a>`)}` : _m;
  });

  // 4. escape the rest, then apply emphasis
  s = renderEmphasis(escapeHtml(s));

  // 5. hard line breaks (two trailing spaces or backslash)
  s = s.replace(/(?: {2,}|\\)\n/g, '<br>');

  // restore stashed fragments (may be nested once, e.g. code inside link text)
  for (let i = 0; i < 2; i++) s = s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => slots[Number(n)] ?? '');
  return s;
}

function renderEmphasis(s: string): string {
  return s
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

/* ───────────────────────── blocks ───────────────────────── */

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^ {0,3}> ?/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function codeBlock(lang: string, code: string): string {
  const label = lang ? escapeHtml(lang.toLowerCase()) : 'text';
  return (
    `<div class="md-code relative my-2 border border-line bg-[#121213] rounded-[2px]">` +
    `<div class="flex items-center justify-between px-3 h-7 border-b border-line font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3">` +
    `<span>${label}</span>` +
    `<button type="button" data-copy class="hover:text-fg cursor-pointer uppercase tracking-[0.12em]">copy</button></div>` +
    `<pre class="m-0 border-0 rounded-none bg-transparent"><code${lang ? ` data-lang="${label}"` : ''}>${escapeHtml(code)}</code></pre></div>`
  );
}

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '\\' && l[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      inCode = !inCode;
      cur += c;
    } else if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(lines: string[]): string {
  const head = splitRow(lines[0]);
  const aligns = splitRow(lines[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const al = (i: number) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
  let html = '<div class="overflow-x-auto"><table><thead><tr>';
  head.forEach((h, i) => (html += `<th${al(i)}>${renderInline(h)}</th>`));
  html += '</tr></thead><tbody>';
  for (const row of lines.slice(2)) {
    const cells = splitRow(row);
    html += '<tr>';
    for (let i = 0; i < head.length; i++) html += `<td${al(i)}>${renderInline(cells[i] ?? '')}</td>`;
    html += '</tr>';
  }
  return html + '</tbody></table></div>';
}

interface ListItem {
  text: string[];
}

function renderList(lines: string[]): string {
  // lines: the raw list block (items + continuation lines)
  const first = RE_LIST.exec(lines[0])!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items: ListItem[] = [];
  for (const line of lines) {
    const m = RE_LIST.exec(line);
    if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
      items.push({ text: [m[3]] });
    } else if (items.length) {
      // continuation / nested content — dedent relative to the item content
      items[items.length - 1].text.push(line.replace(new RegExp(`^ {0,${baseIndent + 4}}`), ''));
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  let html = `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`;
  for (const it of items) {
    let body = it.text.join('\n');
    let check = '';
    const task = /^\[([ xX])\]\s+/.exec(body);
    if (task) {
      check = `<span class="font-mono text-fg-3 mr-1">${task[1] === ' ' ? '[ ]' : '[x]'}</span>`;
      body = body.slice(task[0].length);
    }
    const inner = renderBlocks(body);
    // tight list: unwrap a single paragraph
    const tight = inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
    html += `<li>${check}${tight}</li>`;
  }
  return html + `</${tag}>`;
}

function renderBlocks(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${renderInline(para.join('\n').trim())}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code (an unterminated fence runs to the end — handy while streaming)
    const fence = RE_FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const code: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      i++; // skip closing fence
      out.push(codeBlock(fence[2], code.join('\n')));
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    const h = RE_HEADING.exec(line);
    if (h) {
      flush();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      // "text\n---" is a setext heading in CommonMark; treat as h2 when a paragraph is open
      if (para.length && /^ {0,3}-+\s*$/.test(line)) {
        out.push(`<h2>${renderInline(para.join(' ').trim())}</h2>`);
        para = [];
      } else {
        flush();
        out.push('<hr>');
      }
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && lines[i].trim() && (RE_QUOTE.test(lines[i]) || q.length)) {
        if (!RE_QUOTE.test(lines[i]) && (RE_LIST.test(lines[i]) || RE_FENCE.test(lines[i]))) break;
        q.push(lines[i].replace(RE_QUOTE, ''));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(q.join('\n'))}</blockquote>`);
      continue;
    }

    // table: header row + separator row
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const t: string[] = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) t.push(lines[i++]);
      out.push(renderTable(t));
      continue;
    }

    if (RE_LIST.test(line) && (!para.length || !/^\s/.test(line))) {
      flush();
      const block: string[] = [line];
      const baseMatch = RE_LIST.exec(line)!;
      const baseIndent = baseMatch[1].length;
      const baseOrdered = /\d/.test(baseMatch[2]);
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // blank line: continue only if the next non-blank line is indented or another item
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = lines[j];
          if (next !== undefined && (/^\s{2,}/.test(next) || (RE_LIST.exec(next)?.[1].length ?? -1) >= baseIndent)) {
            block.push('');
            i++;
            continue;
          }
          break;
        }
        const lm = RE_LIST.exec(l);
        if (lm && lm[1].length <= baseIndent && /\d/.test(lm[2]) !== baseOrdered) break; // list type changed
        if (lm || /^\s{2,}/.test(l)) {
          block.push(l);
          i++;
          continue;
        }
        // lazy continuation of the last item paragraph
        if (!RE_HEADING.test(l) && !RE_FENCE.test(l) && !RE_QUOTE.test(l) && !RE_HR.test(l) && block[block.length - 1].trim()) {
          block.push('  ' + l);
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(block));
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

/** Render markdown to sanitized HTML. Pass `caret` to append a streaming caret inside the last text block. */
export function renderMarkdown(src: string, opts: { caret?: boolean } = {}): string {
  let html = renderBlocks(src ?? '');
  if (opts.caret) {
    const caret = '<span class="md-caret inline-block w-[7px] h-[1em] -mb-[0.15em] ml-0.5 bg-fg-2 hud-blink"></span>';
    const m = /<\/(p|li|h[1-6]|td)>(\s*<\/(?:ul|ol|tbody|table|div|blockquote)>)*\s*$/.exec(html);
    html = m ? html.slice(0, m.index) + caret + html.slice(m.index) : html + caret;
  }
  return html;
}
