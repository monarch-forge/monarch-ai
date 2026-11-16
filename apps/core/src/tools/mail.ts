/** Gmail tools (Core-C) — multiple Google accounts. */
import { z } from 'zod';
import type { MailThreadSummary } from '@monarch/shared';
import { defineTool, type ToolDef } from '../kernel.ts';
import {
  BULK_HARD_CAP,
  MAIL_ACTIONS,
  bulkModifyByQuery,
  estimateMatches,
  createDraft,
  getThread,
  listGoogleAccounts,
  listThreads,
  modifyThread,
  resolveGoogleAccount,
  sendMail,
  type MailAction,
} from '../integrations/google/index.ts';

const NOT_CONNECTED = 'No Gmail account connected — connect one in Config → Accounts';

function requireAccounts() {
  const list = listGoogleAccounts();
  if (!list.length) throw new Error(NOT_CONNECTED);
  return list;
}

const accountArg = z
  .string()
  .optional()
  .describe('Account email or id. Optional when only one Gmail account is connected (see mail_accounts).');

function emailFor(accountId: string): string {
  return listGoogleAccounts().find((a) => a.id === accountId)?.email ?? accountId;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtSummary(t: MailThreadSummary, multi: boolean): string {
  const flags = [t.unread ? 'UNREAD' : '', t.labels.includes('STARRED') ? 'STARRED' : '', t.labels.includes('INBOX') ? '' : 'archived']
    .filter(Boolean)
    .join(',');
  return [
    `• ${t.subject}`,
    `  from: ${t.from} · ${fmtDate(t.date)}${t.messageCount > 1 ? ` · ${t.messageCount} msgs` : ''}${flags ? ` · ${flags}` : ''}`,
    `  threadId: ${t.id}${multi ? ` · account: ${emailFor(t.accountId)}` : ''}`,
    t.snippet ? `  ${t.snippet}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const mailAccounts = defineTool({
  name: 'mail_accounts',
  group: 'mail',
  keywords: ['gmail', 'email accounts', 'inbox'],
  description: 'List the Gmail accounts connected to Monarch (email, display name, id, and any connection error). Use the email as the `account` argument of other mail tools.',
  risk: 'safe',
  tag: 'MAIL',
  schema: z.object({}),
  run: () => {
    const list = requireAccounts();
    return list.map((a) => `• ${a.email}${a.name ? ` (${a.name})` : ''} — id ${a.id}${a.error ? ` — ERROR: ${a.error}` : ''}`).join('\n');
  },
});

const mailSearch = defineTool({
  name: 'mail_search',
  loading: 'always',
  group: 'mail',
  keywords: ['gmail', 'email', 'inbox', 'unread', 'messages'],
  description: [
    'Search or list email threads using Gmail search syntax. Searches ALL connected accounts (merged, newest first) unless `account` is given.',
    'Query examples: "is:unread in:inbox", "from:alice@example.com newer_than:7d", "subject:invoice has:attachment", "label:work is:starred", "in:sent to:bob".',
    'Leave `query` empty to list the inbox. Returns subject, sender, date, unread/starred flags, snippet and the threadId to use with mail_read_thread.',
  ].join(' '),
  risk: 'safe',
  tag: 'MAIL',
  schema: z.object({
    query: z.string().optional().describe('Gmail search query (same syntax as the Gmail search box). Empty = inbox.'),
    account: accountArg.describe('Account email or id to search. Omit to search all connected accounts.'),
    max: z.number().int().min(1).max(50).optional().describe('Max threads to return (default 15).'),
  }),
  summarize: (i) => `Search mail: ${i.query || 'inbox'}`,
  run: async (i) => {
    const accounts = requireAccounts();
    const q = i.query?.trim() || undefined;
    const accountId = i.account ? resolveGoogleAccount(i.account).id : undefined;
    const labelIds = q ? [] : ['INBOX'];
    const scope = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
    const [threads, estimates] = await Promise.all([
      listThreads({ accountId, q, labelIds, max: i.max ?? 15 }),
      Promise.all(scope.map((a) => estimateMatches(a.id, q, labelIds).then((n) => ({ email: a.email, n })).catch(() => null))),
    ]);
    const est = estimates.filter((e): e is { email: string; n: number } => !!e);
    const total = est.reduce((s, e) => s + e.n, 0);
    const scale = est.length
      ? `About ${total.toLocaleString('en-US')} matching message(s)${est.length > 1 ? ` (${est.map((e) => `${e.email}: ~${e.n.toLocaleString('en-US')}`).join(', ')})` : ''}.` +
        (total > 50 ? ' To change all of them at once use mail_cleanup with this query (dry run first).' : '')
      : '';
    if (!threads.length) return `No threads found${q ? ` for "${q}"` : ''}.`;
    const multi = !i.account && accounts.length > 1;
    return `${scale ? `${scale}\n` : ''}Showing ${threads.length} thread(s):\n${threads.map((t) => fmtSummary(t, multi)).join('\n')}`;
  },
});

const mailReadThread = defineTool({
  name: 'mail_read_thread',
  group: 'mail',
  keywords: ['gmail', 'email', 'open message', 'conversation'],
  description:
    'Read a full email thread (all messages, plain text bodies, headers incl. Message-ID). Get the threadId from mail_search. Long bodies are truncated per message.',
  risk: 'safe',
  tag: 'MAIL',
  schema: z.object({
    threadId: z.string().describe('Gmail thread id (from mail_search).'),
    account: accountArg,
    maxCharsPerMessage: z.number().int().min(200).max(20000).optional().describe('Truncate each message body to this many characters (default 4000).'),
  }),
  summarize: (i) => `Read mail thread ${i.threadId}`,
  run: async (i) => {
    requireAccounts();
    const acct = resolveGoogleAccount(i.account);
    const t = await getThread(acct.id, i.threadId);
    const max = i.maxCharsPerMessage ?? 4000;
    const msgs = t.messages.map((m, idx) => {
      const body = m.text.length > max ? `${m.text.slice(0, max)}\n… [truncated ${m.text.length - max} chars]` : m.text;
      return [
        `── message ${idx + 1}/${t.messages.length} · ${fmtDate(m.date)}${m.labels.includes('UNREAD') ? ' · UNREAD' : ''}`,
        `From: ${m.from}`,
        `To: ${m.to}`,
        m.cc ? `Cc: ${m.cc}` : '',
        m.messageIdHeader ? `Message-ID: ${m.messageIdHeader}` : '',
        '',
        body || '(empty body)',
      ]
        .filter((l, j) => l !== '' || j === 5)
        .join('\n');
    });
    return `Thread: ${t.subject}\nAccount: ${acct.email} · threadId: ${t.id}\n\n${msgs.join('\n\n')}`;
  },
});

const sendSchema = z.object({
  to: z.string().describe('Recipient(s), comma-separated. "Name <email>" or plain emails.'),
  subject: z.string().describe('Subject line. For replies you may leave the original subject; "Re:" is added automatically.'),
  body: z.string().describe('Plain-text body. Write the complete message, including greeting and sign-off.'),
  cc: z.string().optional().describe('Cc recipients, comma-separated.'),
  account: accountArg.describe('Account email or id to send FROM. Required when several accounts are connected.'),
  threadId: z.string().optional().describe('Reply within this Gmail thread (sets In-Reply-To/References automatically).'),
});

const mailSend = defineTool({
  name: 'mail_send',
  group: 'mail',
  keywords: ['gmail', 'email', 'reply', 'compose', 'send message'],
  description:
    'Send an email (or a reply when threadId is given) from a connected Gmail account. ALWAYS requires the user\'s approval. Prefer mail_draft when the user has not explicitly asked to send. Confirm the recipient and content are what the user wants.',
  risk: 'dangerous',
  tag: 'MAIL',
  schema: sendSchema,
  summarize: (i) => `Send email to ${i.to}: ${i.subject || '(reply)'}`,
  run: async (i) => {
    requireAccounts();
    const acct = resolveGoogleAccount(i.account);
    const r = await sendMail({ accountId: acct.id, to: i.to, cc: i.cc, subject: i.subject, body: i.body, threadId: i.threadId });
    return `Sent from ${acct.email} to ${i.to} (message id ${r.id}${r.threadId ? `, thread ${r.threadId}` : ''}).`;
  },
});

const mailDraft = defineTool({
  name: 'mail_draft',
  group: 'mail',
  keywords: ['gmail', 'email', 'compose', 'reply draft'],
  description:
    'Save an email (or reply, with threadId) as a Gmail DRAFT without sending it. The user can review and send it from Gmail. Use this by default when composing on the user\'s behalf.',
  risk: 'sensitive',
  tag: 'MAIL',
  schema: sendSchema,
  summarize: (i) => `Draft email to ${i.to}: ${i.subject || '(reply)'}`,
  run: async (i) => {
    requireAccounts();
    const acct = resolveGoogleAccount(i.account);
    const r = await createDraft({ accountId: acct.id, to: i.to, cc: i.cc, subject: i.subject, body: i.body, threadId: i.threadId });
    return `Draft saved in ${acct.email} (draft id ${r.id}).`;
  },
});

const actions = Object.keys(MAIL_ACTIONS) as [MailAction, ...MailAction[]];

const mailModify = defineTool({
  name: 'mail_modify',
  group: 'mail',
  keywords: ['gmail', 'archive', 'label', 'mark read', 'unread', 'trash', 'star'],
  description:
    'Change the state of one or more email threads: read (mark read), unread, archive (remove from inbox), unarchive, star, unstar. Nothing is deleted.',
  risk: 'sensitive',
  tag: 'MAIL',
  schema: z.object({
    threadIds: z.array(z.string()).min(1).max(50).describe('Gmail thread ids (from mail_search).'),
    action: z.enum(actions).describe('What to do with the threads.'),
    account: accountArg,
  }),
  summarize: (i) => `Mark ${i.threadIds.length} thread(s) as ${i.action}`,
  run: async (i) => {
    requireAccounts();
    const acct = resolveGoogleAccount(i.account);
    const a = MAIL_ACTIONS[i.action] as { add?: readonly string[]; remove?: readonly string[] };
    const failed: string[] = [];
    for (const id of i.threadIds) {
      try {
        await modifyThread(acct.id, id, [...(a.add ?? [])], [...(a.remove ?? [])]);
      } catch (e) {
        failed.push(`${id}: ${(e as Error).message}`);
      }
    }
    const ok = i.threadIds.length - failed.length;
    return `${i.action}: ${ok}/${i.threadIds.length} thread(s) updated in ${acct.email}.${failed.length ? `\nFailed:\n${failed.join('\n')}` : ''}`;
  },
});

const n = (x: number) => x.toLocaleString('en-US');

const mailCleanup = defineTool({
  name: 'mail_cleanup',
  group: 'mail',
  keywords: ['gmail', 'bulk', 'cleanup', 'clean up inbox', 'mark all read', 'archive all', 'newsletters', 'promotions', 'inbox zero', 'mass archive', 'thousands of emails'],
  description: [
    'Bulk inbox cleanup: apply ONE action to EVERY email matching a Gmail search query, across all connected accounts (or one `account`), in a single call — thousands of messages at once.',
    'Actions: read, unread, archive, unarchive, star, unstar. Never deletes or trashes anything.',
    'ALWAYS call first with dryRun=true (the default) to see how many messages match plus a few samples; then call again with dryRun=false to apply.',
    'Query examples: "category:promotions is:unread", "in:inbox older_than:30d", "from:newsletter@example.com", "label:updates in:inbox", "is:unread older_than:7d".',
    'Use this instead of looping mail_search/mail_modify for hundreds or thousands of emails.',
  ].join(' '),
  risk: 'sensitive',
  tag: 'MAIL',
  schema: z.object({
    query: z.string().min(1).describe('Gmail search query selecting the messages (same syntax as the Gmail search box), e.g. "category:promotions in:inbox".'),
    action: z.enum(actions).describe('What to do with every matching message.'),
    account: accountArg.describe('Account email or id. Omit to clean up ALL connected accounts.'),
    dryRun: z.boolean().optional().describe('Default true: only count and preview. Set false to actually apply the action.'),
    limit: z.number().int().min(1).max(BULK_HARD_CAP).optional().describe(`Max messages per account (default and cap ${n(BULK_HARD_CAP)}).`),
  }),
  summarize: (i) => `${i.dryRun === false ? 'Bulk' : 'Preview bulk'} ${i.action}: ${i.query}${i.account ? ` (${i.account})` : ''}`,
  run: async (i, ctx) => {
    const accounts = requireAccounts();
    const dryRun = i.dryRun !== false;
    const scope = i.account ? [resolveGoogleAccount(i.account)] : accounts;
    const a = MAIL_ACTIONS[i.action] as { add?: readonly string[]; remove?: readonly string[] };
    const lines: string[] = [];
    let matched = 0;
    let modified = 0;
    let aborted = false;
    for (const acct of scope) {
      if (ctx.signal.aborted) {
        aborted = true;
        lines.push(`${acct.email}: skipped (aborted)`);
        continue;
      }
      try {
        const r = await bulkModifyByQuery(acct.id, i.query, [...(a.add ?? [])], [...(a.remove ?? [])], {
          dryRun,
          limit: i.limit,
          signal: ctx.signal,
          onProgress: (p) =>
            ctx.progress(`${acct.email}: ${p.phase === 'collect' ? 'found' : `${i.action}`} ${n(p.done)}/${n(p.total)}${p.phase === 'collect' ? ' …' : ''}`),
        });
        matched += r.matched;
        modified += r.modified;
        if (r.aborted) aborted = true;
        const head = dryRun
          ? `${acct.email}: ${n(r.matched)} matching${r.truncated ? ` (stopped at limit ${n(r.matched)}; more exist)` : ''}`
          : `${acct.email}: ${n(r.modified)}/${n(r.matched)} updated (${i.action})${r.aborted ? ' — ABORTED part-way' : ''}${r.truncated ? ' (limit reached; more remain)' : ''}`;
        lines.push(head, ...r.samples.map((s) => `  • ${s.subject} — ${s.from} · ${fmtDate(s.date)}`));
      } catch (e) {
        if (ctx.signal.aborted) {
          aborted = true;
          lines.push(`${acct.email}: aborted`);
        } else lines.push(`${acct.email}: ERROR ${(e as Error).message}`);
      }
    }
    const summary = dryRun
      ? `DRY RUN — nothing changed. ${n(matched)} message(s) match "${i.query}" across ${scope.length} account(s); action would be: ${i.action}.`
      : `${aborted ? 'ABORTED — ' : ''}${i.action}: ${n(modified)} of ${n(matched)} matching message(s) updated across ${scope.length} account(s).`;
    const hint = dryRun && matched ? '\nRun again with dryRun=false to apply.' : '';
    return `${summary}\n${lines.join('\n')}${hint}`;
  },
});

export const tools: ToolDef[] = [mailAccounts, mailSearch, mailReadThread, mailSend, mailDraft, mailModify, mailCleanup] as unknown as ToolDef[];
