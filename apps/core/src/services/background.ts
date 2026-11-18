/**
 * Background agent: three built-in automations (triage, ledger import, morning brief) stored with
 * `builtin` set so they reuse automations.ts scheduling but stay out of the user's automation list.
 * Also keeps the "what I handled" log and the latest morning brief.
 */
import type { Automation, BackgroundJob, BackgroundLogEntry, BackgroundStatus, BriefItem, MorningBrief } from '@monarch/shared';
import { changed, HttpError, nowIso } from '../kernel.ts';
import { onBuiltinRun, createAutomation, isAutomationRunning, listAutomations, runAutomationNow, updateAutomation } from './automations.ts';
import { serviceStore } from './persist.ts';

const cfg = serviceStore<{ briefTime: string; log: BackgroundLogEntry[] }>('background', { briefTime: '07:00', log: [] });
const briefStore = serviceStore<MorningBrief | null>('brief', null);

const SAFETY = 'Unattended: never send, post or delete anything. Use send_notification only if something urgently needs the user.';

const JOBS: Record<BackgroundJob, { name: string; schedule: () => string; prompt: string }> = {
  triage: {
    name: 'Background: triage',
    schedule: () => '0 8-20/2 * * 1-5',
    prompt: `Triage new messages since the last run. ${SAFETY}
1. Mail (mail_search, all accounts, unread): archive/label obvious noise (newsletters, promos, notifications) with mail_modify. For mail that needs a reply, create a draft with mail_draft (never mail_send).
2. Slack (slack_unread): slack_mark_read low-value channels. WhatsApp: whatsapp_unread, then whatsapp_mark_read for low-value chats (skip if not connected).
3. Reply with one line: counts of what you archived, marked read and drafted, plus anything that needs the user. If no accounts are connected, say so.`,
  },
  ledgerImport: {
    name: 'Background: ledger import',
    schedule: () => 'hourly',
    prompt: `Import new bank/card transactions from mail received in the last 2 hours. ${SAFETY}
1. mail_search for transaction, payment, purchase, transfer or card-charge notifications (newer_than:2h). If no mail account is connected, reply "nothing to import (no mail account)".
2. For each, read it and ledger_add with sourceRef "mail:<account>:<messageId>" (duplicates are skipped automatically). Use ledger_accounts to pick the account.
3. Reply with one line: how many recorded / skipped, or "nothing to import".`,
  },
  morningBrief: {
    name: 'Background: morning brief',
    schedule: () => `daily ${cfg.get().briefTime}`,
    prompt: `Build today's morning brief and save it with brief_save (load it via tool search). ${SAFETY}
Gather briefly, skipping any source that is not connected: calendar_list (today), tasks_list (due/overdue), mail_search unread important, slack_unread, whatsapp_unread, open PRs via gh_prs, ledger_accounts (cards due soon) and ledger_summary (budget alerts this month).
Call brief_save once: needsYou = items requiring action today; today = events; messages = unread counts + up to 5 top items; prs; money. Keep each title short. Then reply "brief saved".`,
  },
};

const KEYS = Object.keys(JOBS) as BackgroundJob[];

/** create missing built-ins (disabled) and return them keyed by job */
function ensure(): Record<BackgroundJob, Automation> {
  const all = listAutomations(true);
  const out = {} as Record<BackgroundJob, Automation>;
  for (const k of KEYS) {
    const j = JOBS[k];
    out[k] = all.find((a) => a.builtin === k) ?? createAutomation({ name: j.name, schedule: j.schedule(), prompt: j.prompt, enabled: false, notify: false, builtin: k });
    // keep prompt/schedule in sync with code (prompts evolve across releases)
    if (out[k].prompt !== j.prompt || out[k].schedule !== j.schedule()) out[k] = updateAutomation(out[k].id, { prompt: j.prompt, schedule: j.schedule() });
  }
  return out;
}

export function backgroundStatus(): BackgroundStatus {
  const jobs = ensure();
  return {
    briefTime: cfg.get().briefTime,
    jobs: KEYS.map((k) => {
      const a = jobs[k];
      return { job: k, id: a.id, name: a.name, schedule: a.schedule, enabled: a.enabled, lastRunAt: a.lastRunAt, nextRunAt: a.nextRunAt, lastStatus: a.lastStatus, lastResult: a.lastResult, running: isAutomationRunning(a.id) };
    }),
    log: cfg.get().log.slice(-30).reverse(),
  };
}

export function updateBackground(patch: Partial<Record<BackgroundJob, boolean>> & { briefTime?: string }): BackgroundStatus {
  if (patch.briefTime !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.briefTime)) throw new HttpError(400, 'briefTime must be HH:MM');
    cfg.update((c) => {
      c.briefTime = patch.briefTime!;
    });
  }
  const jobs = ensure(); // re-syncs the brief schedule with briefTime
  for (const k of KEYS) if (typeof patch[k] === 'boolean') updateAutomation(jobs[k].id, { enabled: patch[k] });
  return backgroundStatus();
}

export function runBackgroundJob(job: string): Promise<{ sessionId: string }> {
  if (!KEYS.includes(job as BackgroundJob)) throw new HttpError(404, `unknown background job ${job}`);
  return runAutomationNow(ensure()[job as BackgroundJob].id);
}

export function logHandled(job: BackgroundJob, summary: string): void {
  const s = summary.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!s) return;
  cfg.update((c) => {
    c.log.push({ at: nowIso(), job, summary: s });
    if (c.log.length > 200) c.log.splice(0, c.log.length - 200);
  });
}

onBuiltinRun((a, result) => {
  if (a.builtin && a.builtin !== 'morningBrief') logHandled(a.builtin, result);
});

export const latestBrief = (): MorningBrief | null => briefStore.get();

/** validate + store a brief; handled[] is filled from the log since the previous brief */
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
  const prev = briefStore.get()?.generatedAt ?? '';
  const m = input.messages ?? { top: [] };
  const brief: MorningBrief = {
    generatedAt: nowIso(),
    needsYou: items(input.needsYou, 'needsYou'),
    today: items(input.today, 'today'),
    messages: { mail: count(m.mail), slack: count(m.slack), whatsapp: count(m.whatsapp), top: items(m.top, 'messages.top') },
    prs: items(input.prs, 'prs'),
    money: items(input.money, 'money'),
    handled: cfg.get().log.filter((e) => e.at > prev).slice(-20),
  };
  briefStore.set(brief);
  changed('automations'); // UI refetches the brief alongside automation status
  return brief;
}
