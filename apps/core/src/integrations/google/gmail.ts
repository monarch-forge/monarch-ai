/** Gmail REST (v1) across multiple accounts. */
import type { MailDraft, MailMessage, MailThread, MailThreadSummary } from '@monarch/shared';
import { HttpError, activity, changed } from '../../kernel.ts';
import { getAccount, googleFetch, listAccounts, mapLimit, resolveAccount } from './auth.ts';
import { base64UrlDecode, base64UrlEncode, buildMime, htmlToText, replySubject, sanitizeHtml } from './mime.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/* ─────────────── Gmail API shapes (subset) ─────────────── */

interface GHeader {
  name: string;
  value: string;
}
interface GPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GPart[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}
interface GThread {
  id: string;
  snippet?: string;
  historyId?: string;
  messages?: GMessage[];
}

/* ─────────────── parsing helpers (exported for tests) ─────────────── */

export function header(part: GPart | undefined, name: string): string {
  const n = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';
}

function charsetOf(part: GPart): string {
  const ct = header(part, 'Content-Type');
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1] : 'utf-8';
}

/** walk the MIME tree collecting text/plain and text/html bodies (skips attachments). */
export function extractBodies(payload: GPart | undefined): { text: string; html: string } {
  const texts: string[] = [];
  const htmls: string[] = [];
  const walk = (p: GPart | undefined) => {
    if (!p) return;
    const type = (p.mimeType ?? '').toLowerCase();
    const isAttachment = !!p.filename || /attachment/i.test(header(p, 'Content-Disposition'));
    if (p.parts?.length) {
      // multipart/alternative: both text & html live here; recurse all
      for (const c of p.parts) walk(c);
      return;
    }
    if (isAttachment || !p.body?.data) return;
    if (type === 'text/plain') texts.push(base64UrlDecode(p.body.data, charsetOf(p)));
    else if (type === 'text/html') htmls.push(base64UrlDecode(p.body.data, charsetOf(p)));
  };
  walk(payload);
  return { text: texts.join('\n\n').trim(), html: htmls.join('\n<hr>\n').trim() };
}

function isoFromMessage(m: GMessage): string {
  if (m.internalDate) return new Date(Number(m.internalDate)).toISOString();
  const d = new Date(header(m.payload, 'Date'));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

export function toMessage(accountId: string, m: GMessage): MailMessage {
  const { text, html } = extractBodies(m.payload);
  const msg: MailMessage = {
    id: m.id,
    threadId: m.threadId,
    accountId,
    from: header(m.payload, 'From'),
    to: header(m.payload, 'To'),
    subject: header(m.payload, 'Subject'),
    date: isoFromMessage(m),
    text: text || (html ? htmlToText(html) : (m.snippet ?? '')),
    labels: m.labelIds ?? [],
  };
  const cc = header(m.payload, 'Cc');
  if (cc) msg.cc = cc;
  if (html) msg.html = sanitizeHtml(html);
  const mid = header(m.payload, 'Message-ID') || header(m.payload, 'Message-Id');
  if (mid) msg.messageIdHeader = mid;
  return msg;
}

export function toSummary(accountId: string, t: GThread): MailThreadSummary {
  const msgs = t.messages ?? [];
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  const labels = [...new Set(msgs.flatMap((m) => m.labelIds ?? []))];
  // show the most recent message not sent by us as "from" when possible
  const lastIncoming = [...msgs].reverse().find((m) => !(m.labelIds ?? []).includes('SENT')) ?? last;
  return {
    id: t.id,
    accountId,
    subject: header(first?.payload, 'Subject') || '(no subject)',
    from: header(lastIncoming?.payload, 'From'),
    snippet: decodeSnippet(last?.snippet ?? t.snippet ?? ''),
    date: last ? isoFromMessage(last) : new Date(0).toISOString(),
    unread: msgs.some((m) => (m.labelIds ?? []).includes('UNREAD')),
    labels,
    messageCount: msgs.length,
  };
}

/** Gmail snippets are HTML-escaped */
function decodeSnippet(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/* ─────────────── list / get ─────────────── */

export interface ListThreadsOpts {
  accountId?: string;
  q?: string;
  labelIds?: string[];
  max?: number;
}

async function listThreadsForAccount(accountId: string, opts: ListThreadsOpts): Promise<MailThreadSummary[]> {
  const max = Math.max(1, Math.min(100, opts.max ?? 30));
  const list = await googleFetch<{ threads?: { id: string }[] }>(accountId, `${GMAIL}/threads`, {
    query: { q: opts.q, labelIds: opts.labelIds?.length ? opts.labelIds : undefined, maxResults: max },
  });
  const ids = (list.threads ?? []).map((t) => t.id);
  const threads = await mapLimit(ids, 6, (id) =>
    googleFetch<GThread>(accountId, `${GMAIL}/threads/${encodeURIComponent(id)}`, {
      query: { format: 'metadata', metadataHeaders: ['Subject', 'From', 'To', 'Date'] },
    }).catch((e) => {
      console.warn(`[gmail] thread ${id} failed: ${(e as Error).message}`);
      return null;
    }),
  );
  return threads.filter((t): t is GThread => !!t).map((t) => toSummary(accountId, t));
}

/** list threads for one account, or (accountId omitted) all accounts merged by date desc */
export async function listThreads(opts: ListThreadsOpts = {}): Promise<MailThreadSummary[]> {
  const max = Math.max(1, Math.min(100, opts.max ?? 30));
  if (opts.accountId) {
    const acct = resolveAccount(opts.accountId);
    return listThreadsForAccount(acct.id, opts);
  }
  const accounts = listAccounts();
  if (!accounts.length) throw new HttpError(409, 'No Gmail account connected — connect one in Config → Accounts');
  const results = await Promise.allSettled(accounts.map((a) => listThreadsForAccount(a.id, opts)));
  const ok = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length === accounts.length) throw failures[0].reason;
  for (const f of failures) console.warn(`[gmail] account listing failed: ${(f.reason as Error)?.message}`);
  return ok.sort((a, b) => b.date.localeCompare(a.date)).slice(0, max);
}

export async function getThread(accountId: string, threadId: string): Promise<MailThread> {
  const acct = resolveAccount(accountId);
  const t = await googleFetch<GThread>(acct.id, `${GMAIL}/threads/${encodeURIComponent(threadId)}`, { query: { format: 'full' } });
  const messages = (t.messages ?? []).map((m) => toMessage(acct.id, m));
  return { id: t.id, accountId: acct.id, subject: messages[0]?.subject || '(no subject)', messages };
}

/* ─────────────── send / draft ─────────────── */

async function buildRaw(d: MailDraft): Promise<{ raw: string; threadId?: string }> {
  const acct = resolveAccount(d.accountId);
  if (!d.to?.trim()) throw new HttpError(400, 'Recipient (to) is required');
  let subject = d.subject ?? '';
  let inReplyTo = d.inReplyTo;
  let references: string | undefined;
  if (d.threadId) {
    // reply: thread the message properly (In-Reply-To + References + Re: subject)
    try {
      const t = await googleFetch<GThread>(acct.id, `${GMAIL}/threads/${encodeURIComponent(d.threadId)}`, {
        query: { format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'Subject'] },
      });
      const last = t.messages?.[t.messages.length - 1];
      const lastId = header(last?.payload, 'Message-ID');
      inReplyTo ||= lastId || undefined;
      const prevRefs = header(last?.payload, 'References');
      references = [prevRefs, inReplyTo].filter(Boolean).join(' ').trim() || undefined;
      if (!subject) subject = header(t.messages?.[0]?.payload, 'Subject');
    } catch (e) {
      if ((e as HttpError).status === 404) throw new HttpError(404, `Thread ${d.threadId} not found in ${acct.email}`);
      throw e;
    }
    subject = replySubject(subject || '');
  } else if (inReplyTo) {
    references = inReplyTo;
  }
  const from = acct.name ? `${acct.name} <${acct.email}>` : acct.email;
  const mime = buildMime({ from, to: d.to, cc: d.cc, subject, text: d.body ?? '', inReplyTo, references });
  return { raw: base64UrlEncode(mime), threadId: d.threadId };
}

export async function sendMail(d: MailDraft): Promise<{ id: string; threadId?: string }> {
  const acct = resolveAccount(d.accountId);
  const { raw, threadId } = await buildRaw({ ...d, accountId: acct.id });
  const r = await googleFetch<{ id: string; threadId: string }>(acct.id, `${GMAIL}/messages/send`, {
    method: 'POST',
    body: threadId ? { raw, threadId } : { raw },
  });
  unreadCache = null;
  changed('mail');
  activity('MAIL', `Sent "${d.subject || '(reply)'}" to ${d.to} from ${acct.email}`);
  return { id: r.id, threadId: r.threadId };
}

export async function createDraft(d: MailDraft): Promise<{ id: string }> {
  const acct = resolveAccount(d.accountId);
  const { raw, threadId } = await buildRaw({ ...d, accountId: acct.id });
  const r = await googleFetch<{ id: string }>(acct.id, `${GMAIL}/drafts`, {
    method: 'POST',
    body: { message: threadId ? { raw, threadId } : { raw } },
  });
  changed('mail');
  activity('MAIL', `Draft saved in ${acct.email}: "${d.subject || '(reply)'}"`);
  return { id: r.id };
}

/* ─────────────── labels ─────────────── */

export async function modifyThread(accountId: string, threadId: string, addLabels: string[] = [], removeLabels: string[] = []): Promise<void> {
  const acct = resolveAccount(accountId);
  if (!addLabels.length && !removeLabels.length) throw new HttpError(400, 'Nothing to change: pass addLabels and/or removeLabels');
  await googleFetch(acct.id, `${GMAIL}/threads/${encodeURIComponent(threadId)}/modify`, {
    method: 'POST',
    body: { addLabelIds: addLabels, removeLabelIds: removeLabels },
  });
  unreadCache = null;
  changed('mail');
}

export const MAIL_ACTIONS = {
  read: { remove: ['UNREAD'] },
  unread: { add: ['UNREAD'] },
  archive: { remove: ['INBOX'] },
  unarchive: { add: ['INBOX'] },
  star: { add: ['STARRED'] },
  unstar: { remove: ['STARRED'] },
} as const satisfies Record<string, { add?: readonly string[]; remove?: readonly string[] }>;
export type MailAction = keyof typeof MAIL_ACTIONS;

/* ─────────────── unread count ─────────────── */

let unreadCache: { value: number; at: number } | null = null;
let unreadPending: Promise<number> | null = null;

export async function unreadCount(): Promise<number> {
  const accounts = listAccounts().filter((a) => !a.error);
  if (!accounts.length) return 0;
  if (unreadCache && Date.now() - unreadCache.at < 60_000) return unreadCache.value;
  if (unreadPending) return unreadPending;
  unreadPending = (async () => {
    const counts = await Promise.all(
      accounts.map((a) =>
        googleFetch<{ threadsUnread?: number }>(a.id, `${GMAIL}/labels/INBOX`)
          .then((l) => l.threadsUnread ?? 0)
          .catch(() => 0),
      ),
    );
    const value = counts.reduce((s, n) => s + n, 0);
    unreadCache = { value, at: Date.now() };
    return value;
  })().finally(() => {
    unreadPending = null;
  });
  return unreadPending;
}

export function accountLabel(accountId: string): string {
  return getAccount(accountId)?.email ?? accountId;
}
