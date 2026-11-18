/** Slack tools (Core-C) — multiple workspaces. */
import { z } from 'zod';
import type { SlackMessage } from '@monarch/shared';
import { defineTool, type ToolDef } from '../kernel.ts';
import { parseWhen } from '../services/dates.ts';
import {
  channelHistory,
  deleteMessage,
  findPeople,
  markRead,
  react,
  resolveOrOpenConversation,
  scheduleMessage,
  unreadOverview,
  updateMessage,
  listChannels,
  listWorkspaces,
  postMessage,
  resolveChannel,
  resolveWorkspace,
  searchMessages,
  threadReplies,
} from '../integrations/slack/index.ts';

const NOT_CONNECTED = 'No Slack workspace connected — connect one in Config → Accounts';

function requireWorkspaces() {
  const list = listWorkspaces();
  if (!list.length) throw new Error(NOT_CONNECTED);
  return list;
}

/** approval target (auto mode asks once per new channel/person) */
const slackTarget = (i: { channel: string; workspace?: string }) => `slack:${i.workspace ?? ''}:${i.channel.trim().toLowerCase()}`;

const workspaceArg = z
  .string()
  .optional()
  .describe('Workspace name or team id. Optional when only one Slack workspace is connected (see slack_workspaces).');

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtMsg(m: SlackMessage, opts: { channelName?: string } = {}): string {
  const meta = [fmtTime(m.date), opts.channelName, m.replyCount ? `${m.replyCount} replies (threadTs ${m.threadTs ?? m.ts})` : '', `ts ${m.ts}`]
    .filter(Boolean)
    .join(' · ');
  return `[${meta}] ${m.user}: ${m.text}${m.permalink ? `\n  ${m.permalink}` : ''}`;
}

const slackWorkspaces = defineTool({
  name: 'slack_workspaces',
  group: 'slack',
  keywords: ['slack teams', 'workspace list'],
  description: 'List connected Slack workspaces (name, team id, user, token type user/bot, connection errors).',
  risk: 'safe',
  tag: 'SLK',
  schema: z.object({}),
  run: () =>
    requireWorkspaces()
      .map((w) => `• ${w.name} — id ${w.id} — ${w.tokenType} token${w.user ? ` as @${w.user}` : ''}${w.error ? ` — ERROR: ${w.error}` : ''}`)
      .join('\n'),
});

const slackChannels = defineTool({
  name: 'slack_channels',
  group: 'slack',
  keywords: ['slack', 'channel list', 'dm', 'conversations'],
  description:
    'List Slack conversations the connected user (or bot) is a member of: public/private channels, DMs (named after the person) and group DMs. Returns ids usable with slack_read / slack_post.',
  risk: 'safe',
  tag: 'SLK',
  schema: z.object({
    workspace: workspaceArg,
    kind: z.enum(['all', 'channel', 'private', 'dm', 'group-dm']).optional().describe('Filter by conversation kind (default all).'),
    filter: z.string().optional().describe('Case-insensitive substring filter on the name.'),
  }),
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    let list = await listChannels(ws.id);
    if (i.kind && i.kind !== 'all') list = list.filter((c) => c.kind === i.kind);
    if (i.filter) list = list.filter((c) => c.name.toLowerCase().includes(i.filter!.toLowerCase()));
    if (!list.length) return 'No matching conversations.';
    const shown = list.slice(0, 300);
    const prefix = (k: string) => (k === 'channel' || k === 'private' ? '#' : k === 'dm' ? '@' : '');
    return `${ws.name}: ${list.length} conversation(s)${list.length > shown.length ? ` (showing ${shown.length})` : ''}\n${shown
      .map((c) => `• ${prefix(c.kind)}${c.name} — ${c.kind} — ${c.id}${c.topic ? ` — ${c.topic.slice(0, 80)}` : ''}`)
      .join('\n')}`;
  },
});

const slackRead = defineTool({
  name: 'slack_read',
  group: 'slack',
  keywords: ['slack', 'channel history', 'messages', 'thread'],
  description:
    'Read recent messages of a Slack channel or DM (oldest → newest), or the replies of one thread when threadTs is given. `channel` accepts an id (C…/D…/G…), "#channel-name", or a person\'s name for their DM.',
  risk: 'safe',
  tag: 'SLK',
  schema: z.object({
    channel: z.string().describe('Channel id, "#name", or DM person name.'),
    workspace: workspaceArg,
    limit: z.number().int().min(1).max(200).optional().describe('How many recent messages (default 30).'),
    threadTs: z.string().optional().describe('Read this thread\'s replies instead of the channel history.'),
  }),
  summarize: (i) => `Read Slack ${i.channel}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const ch = await resolveChannel(ws.id, i.channel);
    const msgs = i.threadTs ? await threadReplies(ws.id, ch.id, i.threadTs, i.limit ?? 100) : await channelHistory(ws.id, ch.id, i.limit ?? 30);
    if (!msgs.length) return `No messages in ${ch.name}.`;
    return `${ws.name} · ${ch.name} (${ch.id})${i.threadTs ? ` · thread ${i.threadTs}` : ''}\n${msgs.map((m) => fmtMsg(m)).join('\n')}`;
  },
});

const slackSearch = defineTool({
  name: 'slack_search',
  group: 'slack',
  keywords: ['slack', 'find messages'],
  description:
    'Search Slack messages (newest first) with Slack search syntax, e.g. "deploy in:#eng from:@alice after:2025-01-01", "has:link budget". Requires a user token (xoxp-); bot-token workspaces cannot search.',
  risk: 'safe',
  tag: 'SLK',
  schema: z.object({
    query: z.string().min(1).describe('Slack search query.'),
    workspace: workspaceArg,
    count: z.number().int().min(1).max(100).optional().describe('Max results (default 20).'),
  }),
  summarize: (i) => `Search Slack: ${i.query}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const msgs = await searchMessages(ws.id, i.query, i.count ?? 20);
    if (!msgs.length) return `No Slack messages match "${i.query}".`;
    return `${msgs.length} result(s) in ${ws.name}:\n${msgs.map((m) => fmtMsg(m, { channelName: m.channelId })).join('\n')}`;
  },
});

const slackPost = defineTool({
  name: 'slack_post',
  group: 'slack',
  keywords: ['slack', 'send message', 'reply', 'chat', 'dm'],
  description:
    'Post a message to a Slack channel or DM, or reply in a thread via threadTs (the parent message ts). `channel` may also be a person (name, email or user id) — a DM is opened if none exists. ALWAYS requires the user\'s approval. With a user token the message is sent as the user. Slack mrkdwn formatting is supported (*bold*, _italic_, `code`, <@U123> mentions).',
  risk: 'dangerous',
  tag: 'SLK',
  schema: z.object({
    channel: z.string().describe('Channel id, "#name", or a person (name, email, user id) for a DM.'),
    text: z.string().min(1).describe('Message text.'),
    workspace: workspaceArg,
    threadTs: z.string().optional().describe('Reply in this thread (ts of the parent message).'),
  }),
  target: (i) => slackTarget(i),
  summarize: (i) => `Post to Slack ${i.channel}${i.workspace ? ` (${i.workspace})` : ''}: ${i.text.length > 80 ? `${i.text.slice(0, 80)}…` : i.text}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const ch = await resolveOrOpenConversation(ws.id, i.channel);
    const m = await postMessage(ws.id, ch.id, i.text, i.threadTs);
    return `Posted to ${ch.name} in ${ws.name} (ts ${m.ts}${m.threadTs ? `, thread ${m.threadTs}` : ''}).`;
  },
});

const convArg = z.string().describe('Channel id, "#name", or a person (name/email/user id) for their DM.');
const tsArg = z.string().describe('Message ts (from slack_read / slack_search / slack_unread output).');
const SCOPE_HINT = ' Needs a user token (xoxp-) with the matching write scope; Monarch reports the exact missing scope if Slack refuses.';

const slackUnread = defineTool({
  name: 'slack_unread',
  group: 'slack',
  keywords: ['slack', 'unread', 'inbox', 'catch up', 'mentions', 'new messages'],
  description: 'List Slack conversations with unread messages (newest unread first, with a short preview). Use it to catch up, then slack_read for detail and slack_mark_read when done. User tokens only.',
  risk: 'safe',
  tag: 'SLK',
  schema: z.object({
    workspace: workspaceArg,
    preview: z.number().int().min(0).max(10).optional().describe('Unread messages to preview per conversation (default 3).'),
  }),
  summarize: () => 'List unread Slack conversations',
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const list = await unreadOverview(ws.id, { preview: i.preview ?? 3 });
    if (!list.length) return `No unread Slack messages in ${ws.name}.`;
    return `${list.length} conversation(s) with unread messages in ${ws.name}:\n` +
      list.map((c) => `• ${c.name} (${c.channelId}) — ${c.unread} unread${c.preview.length ? `\n${c.preview.map((m) => `    ${fmtMsg(m)}`).join('\n')}` : ''}`).join('\n');
  },
});

const slackMarkRead = defineTool({
  name: 'slack_mark_read',
  group: 'slack',
  keywords: ['slack', 'mark read', 'mark as read', 'clear unread', 'seen'],
  description: 'Mark one or more Slack conversations as read (up to their newest message, or up to a given ts).' + SCOPE_HINT,
  risk: 'sensitive',
  tag: 'SLK',
  schema: z.object({
    channels: z.array(z.string()).min(1).describe('Conversations to mark read: ids, "#names" or people for DMs. Use ["*"] for every conversation slack_unread reports.'),
    workspace: workspaceArg,
    ts: z.string().optional().describe('Mark read up to this message ts (single conversation only); default: newest message.'),
  }),
  summarize: (i) => `Mark Slack read: ${i.channels.join(', ')}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const refs = i.channels.includes('*') ? (await unreadOverview(ws.id, { preview: 0 })).map((c) => c.channelId) : i.channels;
    if (!refs.length) return 'Nothing to mark — no unread conversations.';
    const done: string[] = [];
    const failed: string[] = [];
    for (const ref of refs) {
      try {
        const ch = await resolveOrOpenConversation(ws.id, ref);
        await markRead(ws.id, ch.id, refs.length === 1 ? i.ts : undefined);
        done.push(ch.name);
      } catch (e) {
        failed.push(`${ref}: ${(e as Error).message}`);
      }
    }
    return [done.length ? `Marked read in ${ws.name}: ${done.join(', ')}.` : '', failed.length ? `Failed: ${failed.join('; ')}` : ''].filter(Boolean).join('\n');
  },
});

const slackReact = defineTool({
  name: 'slack_react',
  group: 'slack',
  keywords: ['slack', 'react', 'reaction', 'emoji', 'acknowledge', 'thumbs up'],
  description: 'Add (or remove) an emoji reaction on a Slack message, e.g. "white_check_mark", "eyes", "+1".' + SCOPE_HINT,
  risk: 'sensitive',
  tag: 'SLK',
  schema: z.object({ channel: convArg, ts: tsArg, emoji: z.string().min(1).describe('Emoji name without colons.'), remove: z.boolean().optional(), workspace: workspaceArg }),
  summarize: (i) => `${i.remove ? 'Remove' : 'Add'} :${i.emoji}: on Slack ${i.channel}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const ch = await resolveOrOpenConversation(ws.id, i.channel);
    await react(ws.id, ch.id, i.ts, i.emoji, i.remove);
    return `${i.remove ? 'Removed' : 'Added'} :${i.emoji.replace(/:/g, '')}: on ${ch.name} ${i.ts}.`;
  },
});

const slackEdit = defineTool({
  name: 'slack_edit',
  group: 'slack',
  keywords: ['slack', 'edit message', 'update message', 'fix typo'],
  description: "Edit one of the user's own Slack messages (replaces its text). Only when the user asks." + SCOPE_HINT,
  risk: 'dangerous',
  tag: 'SLK',
  schema: z.object({ channel: convArg, ts: tsArg, text: z.string().min(1).describe('New full message text.'), workspace: workspaceArg }),
  target: (i) => slackTarget(i),
  summarize: (i) => `Edit Slack message ${i.ts} in ${i.channel}: ${i.text.slice(0, 80)}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const ch = await resolveOrOpenConversation(ws.id, i.channel);
    await updateMessage(ws.id, ch.id, i.ts, i.text);
    return `Edited message ${i.ts} in ${ch.name}.`;
  },
});

const slackDelete = defineTool({
  name: 'slack_delete',
  group: 'slack',
  keywords: ['slack', 'delete message', 'unsend', 'remove message'],
  description: "Delete one of the user's own Slack messages. Irreversible — only when the user explicitly asks." + SCOPE_HINT,
  risk: 'dangerous',
  tag: 'SLK',
  schema: z.object({ channel: convArg, ts: tsArg, workspace: workspaceArg }),
  target: (i) => slackTarget(i),
  summarize: (i) => `Delete Slack message ${i.ts} in ${i.channel}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const ch = await resolveOrOpenConversation(ws.id, i.channel);
    await deleteMessage(ws.id, ch.id, i.ts);
    return `Deleted message ${i.ts} in ${ch.name}.`;
  },
});

const slackSchedule = defineTool({
  name: 'slack_schedule',
  group: 'slack',
  keywords: ['slack', 'schedule message', 'send later', 'remind channel'],
  description: 'Schedule a Slack message (or thread reply) to be sent later by Slack itself, even if Monarch is off. ALWAYS requires approval.' + SCOPE_HINT,
  risk: 'dangerous',
  tag: 'SLK',
  schema: z.object({
    channel: convArg,
    text: z.string().min(1),
    at: z.string().describe("When to send, ISO-8601 with the user's UTC offset, e.g. 2026-11-17T09:00:00+07:00 (work it out from get_datetime)."),
    threadTs: z.string().optional(),
    workspace: workspaceArg,
  }),
  target: (i) => slackTarget(i),
  summarize: (i) => `Schedule Slack message to ${i.channel} at ${i.at}: ${i.text.slice(0, 60)}`,
  run: async (i) => {
    requireWorkspaces();
    const when = parseWhen(i.at);
    if (!when) throw new Error(`Could not understand the time "${i.at}"`);
    const ws = resolveWorkspace(i.workspace);
    const ch = await resolveOrOpenConversation(ws.id, i.channel);
    const r = await scheduleMessage(ws.id, ch.id, i.text, when, i.threadTs);
    return `Scheduled for ${new Date(r.postAt).toLocaleString()} in ${ch.name} (id ${r.id}).`;
  },
});

const slackPeople = defineTool({
  name: 'slack_people',
  group: 'slack',
  keywords: ['slack', 'user', 'person', 'colleague', 'who is', 'member', 'email'],
  description: 'Find people in a Slack workspace by name, email or title (returns user ids usable as DM targets and <@id> mentions).',
  risk: 'safe',
  tag: 'SLK',
  schema: z.object({ query: z.string().min(1), workspace: workspaceArg }),
  summarize: (i) => `Find Slack people: ${i.query}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const ps = await findPeople(ws.id, i.query);
    if (!ps.length) return `No one in ${ws.name} matches "${i.query}".`;
    return ps
      .slice(0, 25)
      .map((p) => `- ${p.realName || p.name} (@${p.name}, ${p.id})${p.title ? ` · ${p.title}` : ''}${p.email ? ` · ${p.email}` : ''}${p.tz ? ` · ${p.tz}` : ''}`)
      .join('\n');
  },
});

export const tools: ToolDef[] = [slackWorkspaces, slackChannels, slackRead, slackSearch, slackPost, slackUnread, slackMarkRead, slackReact, slackEdit, slackDelete, slackSchedule, slackPeople] as unknown as ToolDef[];
