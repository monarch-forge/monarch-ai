/**
 * Coding-worker navigation + discipline (pi engine, coding sessions only — see codingTools()):
 * repo_map (find where things are defined) and plan_set / plan_step (plan-then-execute, gated before done).
 * Loaded up front: small models rarely discover them via tool search, and the done-gate relies on them.
 */
import { z } from 'zod';
import { bus, defineTool, newId, nowIso, type ToolDef } from '../kernel.ts';
import { broadcastSession, getSession, saveSession } from '../agent/sessions.ts';
import { AUTO_APPROVE_STEPS, formatPlan, newPlan, openSteps } from '../agent/plan.ts';
import { getRepoMap, searchMap } from '../services/repomap.ts';
import { repoRootOf } from '../services/projects.ts';

const repoMap = defineTool({
  name: 'repo_map',
  loading: 'always',
  description: 'Find where code lives: tracked files + their defined symbols (with line numbers) matching a query. Use it before reading files.',
  risk: 'safe',
  schema: z.object({
    query: z.string().optional().describe('Symbol or words, e.g. "getRepoProfile" or "session plan ui".'),
    path: z.string().optional().describe('Limit to this folder (repo-relative).'),
    limit: z.number().int().optional().describe('Max files (default 20).'),
  }),
  summarize: (i) => `Repo map: ${i.query ?? i.path ?? 'overview'}`,
  run: async (i, ctx) => {
    const root = repoRootOf(ctx.cwd);
    if (!root) return `${ctx.cwd} is not inside a git repository; use fs_list / grep.`;
    const map = await getRepoMap(root);
    return map ? searchMap(map, i) : 'Repo map unavailable (no commits yet?); use fs_list / grep.';
  },
});

function pushSystem(id: string, text: string): void {
  const rec = getSession(id);
  if (!rec) return;
  const item = { kind: 'system' as const, id: newId(), ts: nowIso(), text };
  rec.items.push(item);
  saveSession(rec);
  bus.broadcast({ type: 'chat.item', sessionId: rec.id, item });
}

const planSet = defineTool({
  name: 'plan_set',
  loading: 'always',
  description: `Set your plan before editing (1-${8} short steps; replaces any previous plan). Tick steps with plan_step.`,
  risk: 'safe',
  schema: z.object({
    steps: z.array(z.object({ text: z.string(), files: z.array(z.string()).optional() })).describe('Ordered steps; files = paths you expect to touch.'),
  }),
  summarize: (i) => `Plan: ${i.steps.length} steps`,
  run: async ({ steps }, ctx) => {
    const rec = getSession(ctx.sessionId);
    if (!rec) throw new Error('session not found');
    rec.plan = newPlan(steps);
    saveSession(rec);
    broadcastSession(rec);
    const text = formatPlan(rec.plan);
    if (rec.plan.length > AUTO_APPROVE_STEPS && rec.parentSessionId) pushSystem(rec.parentSessionId, `Worker "${rec.title}" plan (${rec.plan.length} steps):\n${text}`);
    return `Plan set:\n${text}`;
  },
});

const planStep = defineTool({
  name: 'plan_step',
  loading: 'always',
  description: 'Mark a plan step done or skipped (skipped needs a reason in note).',
  risk: 'safe',
  schema: z.object({
    index: z.number().int().describe('1-based step number.'),
    status: z.enum(['done', 'skipped']),
    note: z.string().optional(),
  }),
  summarize: (i) => `Plan step ${i.index}: ${i.status}`,
  run: async ({ index, status, note }, ctx) => {
    const rec = getSession(ctx.sessionId);
    const step = rec?.plan?.[index - 1];
    if (!rec || !step) throw new Error(`No step ${index}. Set a plan first with plan_set.`);
    if (status === 'skipped' && !note?.trim()) throw new Error('Give the reason for skipping in note.');
    Object.assign(step, { status }, note?.trim() ? { note: note.trim().slice(0, 200) } : {});
    saveSession(rec);
    broadcastSession(rec);
    const open = openSteps(rec.plan);
    return open.length ? `Step ${index} ${status}. Open: ${open.join(', ')}.` : `Step ${index} ${status}. All steps closed.`;
  },
});

export const tools: ToolDef[] = [repoMap, planSet, planStep];
