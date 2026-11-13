/** Slack tools (Core-C) — multiple workspaces. */
import { z } from 'zod';
import type { SlackMessage } from '@monarch/shared';
import { defineTool, type ToolDef } from '../kernel.ts';
import {
  channelHistory,
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
  description:
    'Post a message to a Slack channel or DM (optionally as a thread reply via threadTs). ALWAYS requires the user\'s approval. With a user token the message is sent as the user. Slack mrkdwn formatting is supported (*bold*, _italic_, `code`, <@U123> mentions).',
  risk: 'dangerous',
  tag: 'SLK',
  schema: z.object({
    channel: z.string().describe('Channel id, "#name", or DM person name.'),
    text: z.string().min(1).describe('Message text.'),
    workspace: workspaceArg,
    threadTs: z.string().optional().describe('Reply in this thread (ts of the parent message).'),
  }),
  summarize: (i) => `Post to Slack ${i.channel}${i.workspace ? ` (${i.workspace})` : ''}: ${i.text.length > 80 ? `${i.text.slice(0, 80)}…` : i.text}`,
  run: async (i) => {
    requireWorkspaces();
    const ws = resolveWorkspace(i.workspace);
    const ch = await resolveChannel(ws.id, i.channel);
    const m = await postMessage(ws.id, ch.id, i.text, i.threadTs);
    return `Posted to ${ch.name} in ${ws.name} (ts ${m.ts}${m.threadTs ? `, thread ${m.threadTs}` : ''}).`;
  },
});

export const tools: ToolDef[] = [slackWorkspaces, slackChannels, slackRead, slackSearch, slackPost] as unknown as ToolDef[];
