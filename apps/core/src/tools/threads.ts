/**
 * Open-threads board tools (chat sessions only; filtered out of coding sessions in toolset.ts).
 * thread_upsert is up front: the board is pinned every turn and small models must be able to update it
 * without a tool_search round trip. thread_close is a deferred convenience (= upsert status done).
 */
import { z } from 'zod';
import { defineTool, type ToolDef } from '../kernel.ts';
import { boardSummary, broadcastThreads, threadsOf, upsertThread } from '../agent/threads.ts';

const sess = () => import('../agent/sessions.ts');

async function chatRec(id: string) {
  const r = (await sess()).getSession(id);
  if (!r || r.kind !== 'chat') throw new Error('Threads exist only in Chat sessions.');
  return r;
}

const link = z.object({ kind: z.enum(['worker', 'pr', 'mail', 'slack', 'task', 'url']), ref: z.string().min(1), label: z.string().optional() });
const common = { group: 'threads', keywords: ['thread', 'board', 'open threads', 'follow up', 'todo'], tag: 'AGT' as const };

async function save(id: string, i: Parameters<typeof upsertThread>[1]) {
  const S = await sess();
  const rec = await chatRec(id);
  const t = upsertThread(threadsOf(rec), i);
  S.saveSession(rec);
  broadcastThreads(rec.id);
  return `Thread [${t.id}] ${t.title} (${t.area}) · ${t.status}. Board:\n${boardSummary(threadsOf(rec)) || '(no open threads)'}`;
}

export const tools: ToolDef[] = [
  defineTool({
    ...common,
    name: 'thread_upsert',
    description: 'Create or update an open thread on your board (match by id, else title). Set area, status, next step, links (worker session id, PR URL, mail/slack id).',
    risk: 'safe',
    loading: 'always',
    schema: z.object({
      id: z.string().optional(),
      title: z.string().optional(),
      area: z.string().optional().describe('work | personal | repo:<name> | person:<name> …'),
      status: z.enum(['open', 'waiting', 'done']).optional(),
      next: z.string().optional().describe('next step'),
      links: z.array(link).optional(),
    }),
    summarize: (i) => `Thread: ${i.title ?? i.id ?? ''}${i.status ? ` → ${i.status}` : ''}`,
    run: (i, ctx) => save(ctx.sessionId, i),
  }),
  defineTool({
    ...common,
    name: 'thread_close',
    description: 'Mark an open thread done (by id or title).',
    risk: 'safe',
    schema: z.object({ id: z.string().optional(), title: z.string().optional() }),
    summarize: (i) => `Close thread ${i.title ?? i.id ?? ''}`,
    run: (i, ctx) => save(ctx.sessionId, { ...i, status: 'done' }),
  }),
];
