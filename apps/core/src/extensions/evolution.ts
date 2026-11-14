/** Evolution: stats, proposals (accept → build session), forge, periodic self-reflection. */
import type { EvolutionStats } from '@monarch/shared';
import { activity, HttpError, nowIso } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { listExtensions } from './service.ts';
import { listSkills } from './skills.ts';
import { evoStore, getProposal, listProposals, patchProposal, record } from './timeline.ts';

/* ─────────────── stats ─────────────── */

export async function evolutionStats(): Promise<EvolutionStats> {
  const exts = listExtensions();
  // lazy: tools/index imports extensions/index (cycle at module-eval time otherwise)
  const { assistantTools, codingTools } = await import('../tools/index.ts');
  const { isAlwaysLoaded } = await import('../kernel.ts');
  const all = [...assistantTools(), ...codingTools()];
  const always = all.filter((t) => isAlwaysLoaded(t)).length;
  const weekAgo = Date.now() - 7 * 86400e3;
  const s = evoStore.get();
  return {
    extensions: {
      total: exts.length,
      active: exts.filter((e) => e.status === 'active').length,
      error: exts.filter((e) => e.status === 'error').length,
    },
    tools: { always, deferred: all.length - always },
    skills: listSkills().length,
    openProposals: s.proposals.filter((p) => p.status === 'open').length,
    changes7d: s.timeline.filter((e) => e.kind !== 'reflection' && Date.parse(e.ts) >= weekAgo).length,
    ...(s.lastReflectionAt ? { lastReflectionAt: s.lastReflectionAt } : {}),
  };
}

/* ─────────────── build sessions ─────────────── */

function buildPrompt(spec: { title: string; plan: string; kind: 'extension' | 'skill'; rationale?: string }): string {
  if (spec.kind === 'skill') {
    return [
      `Self-evolution task: write a reusable SKILL — "${spec.title}".`,
      spec.rationale ? `Why: ${spec.rationale}` : '',
      `What it should cover:\n${spec.plan}`,
      '',
      'Steps:',
      '1. Check existing skills with skill_list (update one instead of duplicating).',
      '2. Write it with skill_write: a kebab-case id, a clear name, a one-line description that says WHEN to use it, and a concise markdown procedure that names the exact tools to call and in which order.',
      '3. Reply with a short summary of the skill and when it will be used.',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `Self-evolution task: build a new capability as a Monarch EXTENSION — "${spec.title}".`,
    spec.rationale ? `Why: ${spec.rationale}` : '',
    `What to build:\n${spec.plan}`,
    '',
    'Steps (the evolve tools are deferred — load them with tool search if they are not visible):',
    '1. Call extension_api_docs and read it fully. Check extension_list so you extend/replace rather than duplicate.',
    '2. Design the smallest useful extension: few, well-described tools with zod inputs; request the fewest permissions; declare secrets if an API key is needed.',
    '3. Write it with extension_write. If activation fails, read the error, fix, and write again.',
    '4. Test EVERY tool with extension_test using realistic arguments; fix anything that fails (extension_logs helps).',
    "5. Finish with a short summary: what was built, its tools, permissions, any secrets the user must fill in (in Evolve), and what you couldn't verify.",
  ]
    .filter(Boolean)
    .join('\n');
}

async function startBuild(title: string, text: string, kind: 'chat' | 'automation' = 'chat') {
  const { startPrompt } = await import('../agent/orchestrator.ts');
  return startPrompt({ kind, title, text });
}

export async function acceptProposal(id: string): Promise<{ sessionId: string }> {
  const p = getProposal(id);
  if (!p) throw new HttpError(404, 'proposal not found');
  if (p.status !== 'open') throw new HttpError(409, `proposal is already ${p.status}`);
  const { sessionId } = await startBuild(`Forge: ${p.title}`.slice(0, 80), buildPrompt(p));
  patchProposal(id, (x) => {
    x.status = 'accepted';
    x.buildSessionId = sessionId;
  });
  record('proposal.accepted', `Accepted: ${p.title}`, { actor: 'user', sessionId, ref: id });
  activity('EVO', `Building proposal "${p.title}"`, 'info', sessionId);
  return { sessionId };
}

export function dismissProposal(id: string): void {
  const p = patchProposal(id, (x) => (x.status = 'dismissed'));
  if (!p) throw new HttpError(404, 'proposal not found');
  record('proposal.dismissed', `Dismissed: ${p.title}`, { actor: 'user', ref: id });
}

export async function forge(text: string): Promise<{ sessionId: string }> {
  const t = String(text ?? '').trim();
  if (!t) throw new HttpError(400, 'text is required');
  const title = `Forge: ${t.replace(/\s+/g, ' ').slice(0, 60)}`;
  const { sessionId } = await startBuild(title, buildPrompt({ title: t.slice(0, 120), plan: t, kind: 'extension' }) + '\n\nIf this is better served by a skill (a procedure over existing tools) than new code, write a skill instead and say why.');
  activity('EVO', `Forging: ${t.slice(0, 80)}`, 'info', sessionId);
  return { sessionId };
}

/* ─────────────── reflection ─────────────── */

const REFLECTION_PROMPT = `Self-reflection run. Review how well you have been serving the user and turn friction into improvements.

1. Call activity_recent (deferred evolve tool — load it with tool search) to see the recent activity log and failed/denied tool calls.
2. Look for: tools that failed repeatedly, requests you could not fulfil, recurring multi-step requests, and manual work an extension or a skill could automate.
3. Check what already exists with extension_list and skill_list (don't duplicate).
4. Propose AT MOST 3 high-value improvements with evolution_propose (kind "extension" for new code/tools, "skill" for a procedure over existing tools). Each needs a concrete rationale (cite what you saw) and a plan precise enough for another agent to implement.
   For an obvious, low-risk procedure you may write the skill directly with skill_write instead of proposing it.
5. If nothing is worth proposing, say so. Do NOT build extensions in this run.
End with a 3–6 line summary of what you found and proposed.`;

let reflecting = false;

export async function runReflection(trigger: 'manual' | 'schedule'): Promise<{ sessionId: string }> {
  if (reflecting) throw new HttpError(409, 'a reflection is already running');
  reflecting = true;
  try {
    const { sessionId, done } = await startBuild('Self-reflection', REFLECTION_PROMPT, 'automation');
    evoStore.update((s) => void (s.lastReflectionAt = nowIso()));
    activity('EVO', `Self-reflection started (${trigger})`, 'info', sessionId);
    const guard = setTimeout(() => (reflecting = false), 30 * 60_000); // never wedge the scheduler
    guard.unref?.();
    void done.then((r) => {
      clearTimeout(guard);
      reflecting = false;
      const opened = listProposals().filter((p) => p.sessionId === sessionId).length;
      record('reflection', r.error ? 'Reflection failed' : `Reflection: ${opened} proposal(s)`, {
        detail: (r.error ?? r.text ?? '').slice(0, 2000),
        actor: 'agent',
        sessionId,
      });
    });
    return { sessionId };
  } catch (e) {
    reflecting = false;
    throw e;
  }
}

let reflectTimer: NodeJS.Timeout | null = null;

function reflectionDue(): boolean {
  const evo = getSettings().evolution;
  if (!evo?.enabled || evo.reflect === 'off') {
    if (evoStore.get().reflectArmedAt) evoStore.update((s) => void delete s.reflectArmedAt);
    return false;
  }
  const s = evoStore.get();
  if (!s.reflectArmedAt) {
    evoStore.update((x) => void (x.reflectArmedAt = nowIso()));
    return false;
  }
  const period = evo.reflect === 'weekly' ? 7 * 86400e3 : 86400e3;
  const last = Math.max(Date.parse(s.lastReflectionAt ?? '') || 0, Date.parse(s.reflectArmedAt) || 0);
  return Date.now() - last >= period;
}

export function startReflectionTimer(): void {
  if (reflectTimer) return;
  const tick = () => {
    try {
      if (!reflecting && reflectionDue()) void runReflection('schedule').catch((e) => console.error('[evo] reflection failed:', e));
    } catch (e) {
      console.error('[evo] reflection check failed:', e);
    }
  };
  reflectTimer = setInterval(tick, 10 * 60_000);
  reflectTimer.unref?.();
  setTimeout(tick, 30_000).unref?.();
}

export function stopReflectionTimer(): void {
  if (reflectTimer) clearInterval(reflectTimer);
  reflectTimer = null;
}
