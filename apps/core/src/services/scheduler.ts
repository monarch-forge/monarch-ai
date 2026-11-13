/** Background scheduler: automations (croner + interval ticker) and task reminders. */
import { startAutomations, stopAutomations, tickIntervalAutomations } from './automations.ts';
import { checkReminders } from './tasks.ts';

let ticker: NodeJS.Timeout | null = null;

function tick(): void {
  try {
    checkReminders();
  } catch (e) {
    console.error('[scheduler] reminders failed:', e);
  }
  try {
    tickIntervalAutomations();
  } catch (e) {
    console.error('[scheduler] automations tick failed:', e);
  }
}

export function startScheduler(): void {
  if (ticker) return;
  startAutomations();
  tick();
  ticker = setInterval(tick, 30_000);
}

export function stopScheduler(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  stopAutomations();
}
