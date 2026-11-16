/**
 * Autonomy helpers shared by the engines and the worker-agent tools:
 * - detect replies that stop early (defer/skip requested work, announce work without doing it, ask
 *   "shall I…" right after an imperative instruction) so the engine can continue automatically;
 * - detect 9Router's "Token saver" (Ponytail / Caveman) signature and warn the user once a day.
 */
import { activity, dataStore, notify } from '../kernel.ts';
import { getSettings } from '../settings.ts';

/** extra model rounds the engine may add to one turn when the reply stopped early */
export const MAX_AUTO_CONTINUE = 3;

export const CONTINUE_NUDGE =
  'Continue and finish the task now; do not ask for confirmation for reversible steps; do not skip parts. Use your tools for every remaining step, verify, then give the final report.';

/** settings.agent.autonomy (default 'high') */
export function autonomyHigh(): boolean {
  return getSettings().agent?.autonomy !== 'normal';
}

const DEFER = [/\bskipped\b[^\n]*\badd (it |them )?when\b/i, /^\s*(?:[-*]\s*)?(?:→\s*)?skipped:/im, /^\s*(?:\/\/\s*)?ponytail:/im];
const NEXT_STEPS = /^\s*(?:#+\s*|\*\*)?next steps?\s*(?:\*\*)?\s*:/im;
const WILL_NOW = /\b(?:I will now|I'll now|let me now|I am going to now|I'll (?:go ahead and|start by|proceed to))\b/i;
const ASK = /\b(?:shall I|should I|would you like me to|do you want me to|want me to)\b[^?\n]*\?/i;
const IMPERATIVE =
  /^\s*(?:please\s+)?(?:add|create|make|build|write|fix|implement|run|set ?up|install|update|change|rename|move|refactor|commit|book|schedule|remind|organi[sz]e|clean|delete|remove|draft|send|plan|generate|finish|do|go|continue|test|deploy|in\s+\S+[:,])\b/i;

/** why a plain-text reply stopped early, or undefined when it reads as a finished answer */
export function earlyStopReason(reply: string, userText: string, toolCallsThisRound: number): string | undefined {
  const r = reply.trim();
  if (!r) return undefined;
  if (DEFER.some((p) => p.test(r))) return 'deferred or skipped part of the task';
  if (toolCallsThisRound > 0) return undefined;
  const tail = r.slice(-400);
  if (NEXT_STEPS.test(r)) return 'listed next steps without doing them';
  if (WILL_NOW.test(tail)) return 'announced work without doing it';
  if (ASK.test(tail) && IMPERATIVE.test(stripContext(userText))) return 'asked for confirmation of work already requested';
  return undefined;
}

function stripContext(text: string): string {
  return text.replace(/^<context>[\s\S]*?<\/context>\s*/, '');
}

/* ─────────────── 9Router token-saver detection ─────────────── */

const TOKEN_SAVER = [
  /\bskipped\b[^\n]*\badd (?:it |them )?when\b/i, // Ponytail: "[code] → skipped: [X], add when [Y]."
  /^\s*(?:\/\/|#)?\s*ponytail:/im, // Ponytail: deliberate simplifications marked with a `ponytail:` comment
  /\bme caveman\b|\bcaveman mode\b|\bcompressed mode active\b/i, // Caveman leaking its own style name
];

export function tokenSaverSignature(reply: string): boolean {
  return TOKEN_SAVER.some((p) => p.test(reply));
}

const warned = dataStore<{ day?: string }>('token-saver-warning', {});
export const TOKEN_SAVER_WARNING =
  "9Router's token saver (Ponytail/Caveman) is making your model skip work. Turn it off in 9Router → Dashboard → Token saver for Monarch's requests.";

/** at most one notification + activity entry per day */
export function noteTokenSaver(reply: string, sessionId?: string): void {
  if (!tokenSaverSignature(reply)) return;
  const day = new Date().toISOString().slice(0, 10);
  if (warned.get().day === day) return;
  warned.set({ day });
  activity('AGT', TOKEN_SAVER_WARNING, 'warn', sessionId);
  notify('Model is skipping work', TOKEN_SAVER_WARNING, 'warn', '#/router', { desktop: false });
}
