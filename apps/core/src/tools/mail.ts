/** Gmail tools (Core-C) — multiple Google accounts. */
import { z } from 'zod';
import type { MailThreadSummary } from '@monarch/shared';
import { defineTool, type ToolDef } from '../kernel.ts';
import {
  MAIL_ACTIONS,
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
    const threads = await listThreads({
      accountId: i.account ? resolveGoogleAccount(i.account).id : undefined,
      q,
      labelIds: q ? [] : ['INBOX'],
      max: i.max ?? 15,
    });
    if (!threads.length) return `No threads found${q ? ` for "${q}"` : ''}.`;
    const multi = !i.account && accounts.length > 1;
    return `${threads.length} thread(s):\n${threads.map((t) => fmtSummary(t, multi)).join('\n')}`;
  },
});

const mailReadThread = defineTool({
  name: 'mail_read_thread',
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

export const tools: ToolDef[] = [mailAccounts, mailSearch, mailReadThread, mailSend, mailDraft, mailModify] as unknown as ToolDef[];
