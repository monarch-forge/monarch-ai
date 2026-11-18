/**
 * Memory auto-learn: after a top-level chat goes idle (first after 2 user turns, then every 10) or compacts,
 * extract durable facts about the user with the default pi model and merge them into the vault note
 * Monarch/Profile.md (sections below). Background only — never blocks a turn; errors are logged.
 */
import type { SessionRecord } from './sessions.ts';
import { getSettings } from '../settings.ts';
import { piModels, resolvePiModel } from './pi-models.ts';
import { getNote, noteExists, putNote } from '../integrations/memory/index.ts';

export const PROFILE_NOTE = 'Monarch/Profile';
export const SECTIONS = ['Preferences', 'People', 'Work', 'Personal'] as const;
export type Profile = Record<string, string[]>;

const PROMPT = `Extract durable facts about the USER from this chat: preferences (tone, format, habits), people (teammates, family, contacts and their roles), work (company, repos, projects, tools), personal (location, interests).
Only stable facts useful in future chats; skip one-off tasks, secrets and anything already known.
Output one fact per line as "Section: fact" with Section in Preferences|People|Work|Personal. Output NONE if nothing new.`;

export function parseProfile(body: string): Profile {
  const p: Profile = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  let cur = 'Preferences';
  for (const line of body.split('\n')) {
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) (cur = h[1]), (p[cur] ??= []);
    else if (/^\s*[-*]\s+\S/.test(line)) p[cur].push(line.replace(/^\s*[-*]\s+/, '').trim());
  }
  return p;
}

export function renderProfile(p: Profile): string {
  return Object.entries(p)
    .map(([s, lines]) => `## ${s}\n${lines.map((l) => `- ${l}`).join('\n')}`)
    .join('\n\n') + '\n';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@]+/g, ' ').trim();

/** merge "Section: fact" lines into the profile; returns how many were new */
export function mergeFacts(p: Profile, raw: string): number {
  const seen = new Set(Object.values(p).flat().map(norm));
  let added = 0;
  for (const line of raw.split('\n')) {
    const m = line.replace(/^\s*[-*]\s*/, '').match(/^(Preferences|People|Work|Personal)\s*:\s*(.{3,200})$/i);
    if (!m) continue;
    const sec = SECTIONS.find((s) => s.toLowerCase() === m[1].toLowerCase())!;
    const fact = m[2].trim();
    if (seen.has(norm(fact))) continue;
    seen.add(norm(fact));
    (p[sec] ??= []).push(fact);
    added++;
  }
  return added;
}

// shortcut: per-process counter, so a restart may re-learn once from the same chat (dedup absorbs it)
const learnedAt = new Map<string, number>();
const running = new Set<string>();

/** call when a top-level session goes idle; `force` on compaction */
export function maybeLearn(rec: SessionRecord, force = false): void {
  if (rec.kind !== 'chat' || rec.parentSessionId || running.has(rec.id)) return;
  const turns = rec.items.filter((i) => i.kind === 'user').length;
  const last = learnedAt.get(rec.id) ?? 0;
  if (turns <= last || (!force && turns - last < (last ? 10 : 2))) return;
  learnedAt.set(rec.id, turns);
  running.add(rec.id);
  learnFrom(rec)
    .catch((e) => console.warn('[memory] profile learn failed:', e instanceof Error ? e.message : e))
    .finally(() => running.delete(rec.id));
}

export async function learnFrom(rec: SessionRecord): Promise<number> {
  const s = getSettings().pi;
  const { model } = resolvePiModel(s.provider, s.model);
  if (!model) return 0;
  const transcript = rec.items
    .flatMap((i) => (i.kind === 'user' ? [`User: ${i.text}`] : i.kind === 'assistant' && i.text ? [`Assistant: ${i.text.slice(0, 600)}`] : []))
    .join('\n')
    .slice(-12_000);
  const existing = (await noteExists(PROFILE_NOTE)) ? (await getNote(PROFILE_NOTE)).body : '';
  const res = await piModels().completeSimple(
    model,
    {
      systemPrompt: PROMPT,
      messages: [{ role: 'user', content: `<known>\n${existing}\n</known>\n<chat>\n${transcript}\n</chat>`, timestamp: Date.now() }],
    },
    { maxTokens: 600, signal: AbortSignal.timeout(60_000) },
  );
  if (res.stopReason === 'error' || res.stopReason === 'aborted') throw new Error(res.errorMessage || res.stopReason);
  const out = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const profile = parseProfile(existing);
  const added = mergeFacts(profile, out);
  if (added) await putNote(PROFILE_NOTE, { title: 'Profile', body: renderProfile(profile), source: 'agent' });
  return added;
}
