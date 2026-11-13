/**
 * Slack mrkdwn → safe HTML.
 * Handles <url|label>, <@U…|name>, <#C…|chan>, <!here>, *bold*, _italic_, ~strike~, `code`, ```blocks```, > quotes.
 * Everything that isn't generated markup is HTML-escaped.
 */
import { escapeHtml } from '../memory/md.ts';

export function mrkdwn(text: string, users: Map<string, string> = new Map()): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  // Slack encodes &, <, > in message text; decode before re-escaping uniformly
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  let s = text ?? '';
  // code blocks
  s = s.replace(/```\n?([\s\S]*?)```/g, (_, c: string) => hold(`<pre><code>${escapeHtml(decode(c))}</code></pre>`));
  // inline code
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => hold(`<code>${escapeHtml(decode(c))}</code>`));
  // special tokens <...>
  s = s.replace(/<([^<>\n]+)>/g, (_, inner: string) => {
    const [target, label] = inner.split('|', 2) as [string, string | undefined];
    if (target.startsWith('@')) {
      const id = target.slice(1);
      const name = label || users.get(id) || id;
      return hold(`<span class="slk-mention">@${escapeHtml(decode(name))}</span>`);
    }
    if (target.startsWith('#')) return hold(`<span class="slk-mention">#${escapeHtml(decode(label || target.slice(1)))}</span>`);
    if (target.startsWith('!')) {
      const kw = target.slice(1).split('^')[0];
      return hold(`<span class="slk-mention">@${escapeHtml(label || kw)}</span>`);
    }
    const url = decode(target);
    if (/^(https?:\/\/|mailto:)/i.test(url)) {
      const shown = label ? decode(label) : url.replace(/^mailto:/i, '');
      return hold(`<a href="${escapeHtml(url)}" data-external="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(shown)}</a>`);
    }
    return hold(escapeHtml(decode(`<${inner}>`)));
  });
  s = escapeHtml(decode(s));
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?:;])/g, '$1<del>$2</del>');
  // quotes: lines starting with "> " (escaped as &gt;)
  s = s.replace(/(^|\n)&gt;\s?([^\n]*)\n?/g, '$1<span class="slk-quote">$2</span>');
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
}
