/**
 * Learned skills: after a turn succeeds, compute a task signature (session kind + the tools it used). When the
 * same signature has succeeded twice and nothing was drafted for it yet, one cheap background completion turns the
 * latest transcript into a short skill, saved as a draft (status: draft) that stays hidden from the agent until the
 * user approves it in Evolve → Skills. Background only — never blocks a turn; errors are logged.
 */
import type { ChatItem } from '@monarch/shared';
import type { SessionRecord } from './sessions.ts';
import { dataStore, notify } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { piModels, resolvePiModel } from './pi-models.ts';
import { listSkills, skillIdFrom, writeSkill, recordEvolution } from '../extensions/index.ts';

/** bookkeeping/meta tools that say nothing about the task type */
const META = /^(skill_|tool_search|todo_|memory_recall|ask_user)/;
const REPEATS = 2;

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
type Entry = { count: number; skillId?: string; lastAt: string };
const store = dataStore<Record<string, Entry>>('skill-signatures', {});

/** items of the latest turn (after the last user message) */
export function lastTurn(items: ChatItem[]): ChatItem[] {
  let i = items.length - 1;
  while (i >= 0 && items[i].kind !== 'user') i--;
  return items.slice(i + 1);
}

/** "chat:ledger_add+mail_search"; null when the turn is too small to be a reusable task */
export function taskSignature(kind: string, turn: ChatItem[]): string | null {
  const ok = turn.filter((i): i is ToolItem => i.kind === 'tool' && i.status === 'ok' && !META.test(i.name));
  if (ok.length < 2) return null;
  const names = [...new Set(ok.map((t) => t.name.replace(/^mcp__/, '')))].sort().slice(0, 4);
  return `${kind}:${names.join('+')}`;
}

/** count a success; true when this signature should be drafted now */
export function countSuccess(sig: string): boolean {
  let draft = false;
  store.update((m) => {
    const e = (m[sig] ??= { count: 0, lastAt: '' });
    e.count++;
    e.lastAt = new Date().toISOString();
    // once drafted, never again: a discarded draft stays discarded
    draft = e.count >= REPEATS && !e.skillId;
  });
  return draft;
}

function markDrafted(sig: string, skillId: string): void {
  store.update((m) => {
    if (m[sig]) m[sig].skillId = skillId;
  });
}

const PROMPT = `You write reusable SKILLS for an AI assistant from a transcript of a task it just completed successfully.
Output exactly:
NAME: <short title, 2-5 words>
WHEN: <one line: when to use this skill>
## Steps
1. ...
## Tools
- \`tool_name\` — argument tips
## Pitfalls
- ...
Max 250 words. Generalize: no one-off values (names, ids, dates) unless they are stable preferences. Output NONE if the task is not reusable.`;

export function transcript(turn: ChatItem[], userText: string): string {
  const lines = [`User: ${userText.slice(0, 600)}`];
  for (const i of turn) {
    if (i.kind === 'tool') lines.push(`Tool ${i.name}(${JSON.stringify(i.input ?? {}).slice(0, 300)}) [${i.status}] → ${(i.output ?? '').slice(0, 300)}`);
    else if (i.kind === 'assistant' && i.text) lines.push(`Assistant: ${i.text.slice(0, 800)}`);
  }
  return lines.join('\n').slice(-8000);
}

export function parseDraft(out: string): { name: string; description: string; body: string } | null {
  const name = /^\s*NAME:\s*(.+)$/m.exec(out)?.[1].trim();
  const description = /^\s*WHEN:\s*(.+)$/m.exec(out)?.[1].trim();
  const at = out.search(/^##\s/m);
  if (!name || !description || at < 0 || /^\s*NONE\s*$/.test(out)) return null;
  return { name: name.slice(0, 80), description: description.slice(0, 300), body: out.slice(at).trim() };
}

type Complete = (system: string, user: string) => Promise<string>;

const piComplete: Complete = async (systemPrompt, content) => {
  const s = getSettings().pi;
  const { model } = resolvePiModel(s.provider, s.model);
  if (!model) return 'NONE';
  const res = await piModels().completeSimple(model, { systemPrompt, messages: [{ role: 'user', content, timestamp: Date.now() }] }, { maxTokens: 700, signal: AbortSignal.timeout(60_000) });
  if (res.stopReason === 'error' || res.stopReason === 'aborted') throw new Error(res.errorMessage || res.stopReason);
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
};

/** draft a skill for `sig` from the latest turn; returns the skill id or null */
export async function draftSkill(rec: SessionRecord, sig: string, complete: Complete = piComplete): Promise<string | null> {
  const turn = lastTurn(rec.items);
  const user = [...rec.items].reverse().find((i) => i.kind === 'user');
  const d = parseDraft(await complete(PROMPT, transcript(turn, user && 'text' in user ? String(user.text) : '')));
  markDrafted(sig, '-'); // one completion per signature, even when it says NONE
  if (!d) return null;
  const taken = new Set(listSkills().map((s) => s.id));
  let id = skillIdFrom(d.name);
  for (let n = 2; taken.has(id); n++) id = `${skillIdFrom(d.name).slice(0, 60)}-${n}`;
  const { skill } = writeSkill(id, { ...d, body: `${d.body}\n\n<!-- signature: ${sig} -->` }, 'agent', { draft: true });
  markDrafted(sig, skill.id);
  recordEvolution('skill.created', `Drafted skill: ${skill.name}`, { actor: 'agent', ref: skill.id, sessionId: rec.id, detail: `from repeated task ${sig}` });
  notify(`New skill drafted: ${skill.name}`, 'Review in System → Evolve', 'info', `#/evolve/skills/${encodeURIComponent(skill.id)}`, { desktop: false });
  return skill.id;
}

const running = new Set<string>();

/** call after a top-level turn / worker session finished successfully (coding: after its check passed) */
export function maybeDraftSkill(rec: SessionRecord): void {
  const evo = getSettings().evolution;
  if (!evo?.enabled || evo.draftSkills === false || rec.kind === 'automation') return;
  const sig = taskSignature(rec.kind, lastTurn(rec.items));
  if (!sig || running.has(sig)) return;
  if (!countSuccess(sig)) return;
  running.add(sig);
  draftSkill(rec, sig)
    .catch((e) => console.warn('[skills] draft failed:', e instanceof Error ? e.message : e))
    .finally(() => running.delete(sig));
}
