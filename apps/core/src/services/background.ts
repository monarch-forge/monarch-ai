/**
 * Morning brief store: the latest structured brief saved by an automation via brief_save, shown on Home.
 * (The built-in "background agent" jobs were removed; the same jobs are now example automation templates.)
 */
import type { BriefItem, MorningBrief } from '@monarch/shared';
import { changed, HttpError, nowIso } from '../kernel.ts';
import { serviceStore } from './persist.ts';

const briefStore = serviceStore<MorningBrief | null>('brief', null);

export const latestBrief = (): MorningBrief | null => briefStore.get();

/** validate + store a brief */
export function saveBrief(input: Partial<Omit<MorningBrief, 'generatedAt' | 'handled'>>): MorningBrief {
  const items = (v: unknown, field: string): BriefItem[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new HttpError(400, `${field} must be an array`);
    return v.slice(0, 20).map((x, i) => {
      const t = typeof x === 'string' ? x : x?.title;
      if (typeof t !== 'string' || !t.trim()) throw new HttpError(400, `${field}[${i}].title is required`);
      const it: BriefItem = { title: t.trim().slice(0, 200) };
      if (typeof x?.detail === 'string' && x.detail.trim()) it.detail = x.detail.trim().slice(0, 400);
      if (typeof x?.href === 'string' && x.href.trim()) it.href = x.href.trim();
      return it;
    });
  };
  const count = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.round(v) : undefined);
  const m = input.messages ?? { top: [] };
  const brief: MorningBrief = {
    generatedAt: nowIso(),
    needsYou: items(input.needsYou, 'needsYou'),
    today: items(input.today, 'today'),
    messages: { mail: count(m.mail), slack: count(m.slack), whatsapp: count(m.whatsapp), top: items(m.top, 'messages.top') },
    prs: items(input.prs, 'prs'),
    money: items(input.money, 'money'),
  };
  briefStore.set(brief);
  changed('automations'); // the brief card refetches on automation changes
  return brief;
}
