// Google integration (Core-C). The first six exports are the cross-module contract — signatures are fixed.
import type { CalendarEvent } from '@monarch/shared';
import { listAccounts } from './auth.ts';
import { createEvent, deleteEvent, listEvents, listEventsDetailed, updateEvent, type CalendarAccountResult } from './calendar.ts';
export type { CalendarAccountResult };
import { unreadCount } from './gmail.ts';

/** events from every connected Google account's primary calendar in [from, to) */
export async function listGoogleEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  return listEvents(from, to);
}
/** like listGoogleEvents, plus a per-account result (count or error) for coverage reporting */
export async function listGoogleEventsDetailed(from: Date, to: Date) {
  return listEventsDetailed(from, to);
}
/** create on the account's primary calendar (ev.accountId required) */
export async function createGoogleEvent(ev: Omit<CalendarEvent, 'id' | 'source'>): Promise<CalendarEvent> {
  return createEvent(ev);
}
/** id is `${accountId}:${eventId}` */
export async function updateGoogleEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
  return updateEvent(id, patch);
}
export async function deleteGoogleEvent(id: string): Promise<void> {
  return deleteEvent(id);
}
/** total unread INBOX threads across all accounts (cached ~60s); 0 if none connected */
export async function mailUnreadCount(): Promise<number> {
  try {
    return await unreadCount();
  } catch {
    return 0;
  }
}
/** called once at startup */
export async function initGoogle(): Promise<void> {
  const n = listAccounts().length;
  if (n) console.log(`[google] ${n} account(s) loaded`);
}

export {
  listAccounts as listGoogleAccounts,
  getAccount as getGoogleAccount,
  resolveAccount as resolveGoogleAccount,
  removeAccount as removeGoogleAccount,
  getClientConfig as getGoogleClientConfig,
  setClientConfig as setGoogleClientConfig,
  startConnectFlow as startGoogleConnectFlow,
  cancelGoogleFlow,
  getGoogleFlow,
  handleOAuthCallback as handleGoogleOAuthCallback,
  callbackPage as googleCallbackPage,
  GOOGLE_REDIRECT_PATH,
} from './auth.ts';
export { listThreads, getThread, sendMail, createDraft, modifyThread, MAIL_ACTIONS } from './gmail.ts';
export type { MailAction, ListThreadsOpts } from './gmail.ts';
