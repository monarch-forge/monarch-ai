/**
 * WhatsApp personal number via Baileys (unofficial multi-device bridge, QR pairing).
 * Auth state + message tail live in ~/.monarch-ai/whatsapp (0700, outside the synced data dir).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WhatsAppChat, WhatsAppMessage, WhatsAppStatus } from '@monarch/shared';
import { activity, changed, HttpError, paths } from '../../kernel.ts';
import { addMessage, displayName, emptyStore, isGroupJid, listChats, normalizeMessage, searchChats, setName, type StoreShape } from './store.ts';

const DIR = join(paths.home, 'whatsapp');
const AUTH = join(DIR, 'auth');
const STORE = join(DIR, 'store.json');

type Sock = ReturnType<typeof import('@whiskeysockets/baileys').makeWASocket>;

let sock: Sock | null = null;
let status: WhatsAppStatus = { state: existsSync(join(AUTH, 'creds.json')) ? 'closed' : 'unlinked' };
let retries = 0;
let retryTimer: NodeJS.Timeout | null = null;
let store: StoreShape = load();

function load(): StoreShape {
  try {
    return { ...emptyStore(), ...JSON.parse(readFileSync(STORE, 'utf8')) };
  } catch {
    return emptyStore();
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function touch(): void {
  changed('whatsapp');
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${STORE}.tmp`, JSON.stringify(store), { mode: 0o600 });
    renameSync(`${STORE}.tmp`, STORE);
  }, 1000);
}

const silent = { level: 'silent', child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

export function getStatus(): WhatsAppStatus {
  return status;
}

function setStatus(s: WhatsAppStatus): void {
  status = s;
  changed('whatsapp');
}

/** Start (or resume) the connection. While unlinked this produces a QR in status.qr. */
export async function connect(): Promise<WhatsAppStatus> {
  if (sock && status.state !== 'closed') return status;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  mkdirSync(AUTH, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  const B = await import('@whiskeysockets/baileys');
  const QR = await import('qrcode');
  const { state, saveCreds } = await B.useMultiFileAuthState(AUTH);
  setStatus({ state: 'connecting' });
  const s = B.makeWASocket({ auth: state, logger: silent as any, browser: B.Browsers.appropriate('Desktop'), markOnlineOnConnect: false, syncFullHistory: false });
  sock = s;
  s.ev.on('creds.update', saveCreds);
  s.ev.on('connection.update', async (u) => {
    if (sock !== s) return;
    if (u.qr) setStatus({ state: 'pairing', qr: await QR.toDataURL(u.qr, { margin: 1, width: 264 }) });
    if (u.connection === 'open') {
      retries = 0;
      setStatus({ state: 'open', me: s.user ? { id: B.jidNormalizedUser(s.user.id), name: s.user.name } : undefined });
      activity('SYS', 'WhatsApp connected');
    }
    if (u.connection === 'close') {
      sock = null;
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
      if (code === B.DisconnectReason.loggedOut) {
        wipeAuth();
        setStatus({ state: 'unlinked', error: 'Logged out from the phone' });
        return;
      }
      // pairing QR expired without a scan: stop instead of cycling QRs forever
      if (status.state === 'pairing' && code === B.DisconnectReason.timedOut) return setStatus({ state: 'unlinked', error: 'QR expired — try again' });
      const delay = code === B.DisconnectReason.restartRequired ? 0 : Math.min(60_000, 1000 * 2 ** retries++);
      setStatus({ state: 'closed', error: u.lastDisconnect?.error?.message });
      retryTimer = setTimeout(() => void connect().catch(() => {}), delay);
    }
  });
  s.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    for (const c of contacts) setName(store, c.id, c.name ?? c.notify);
    for (const m of messages) {
      const n = normalizeMessage(m as any);
      if (n) addMessage(store, n, false);
    }
    for (const c of chats) {
      if (!c.id) continue;
      if (c.name) setName(store, c.id, c.name);
      if (store.chats[c.id] && typeof c.unreadCount === 'number') store.chats[c.id]!.unread = Math.max(0, c.unreadCount);
    }
    touch();
  });
  s.ev.on('contacts.upsert', (cs) => {
    for (const c of cs) setName(store, c.id, c.name ?? c.notify);
    touch();
  });
  s.ev.on('contacts.update', (cs) => {
    for (const c of cs) if (c.id) setName(store, c.id, c.name ?? c.notify);
    touch();
  });
  s.ev.on('messages.upsert', ({ messages, type }) => {
    let any = false;
    for (const m of messages) {
      const n = normalizeMessage(m as any);
      if (n && addMessage(store, n, type === 'notify')) any = true;
    }
    if (any) touch();
  });
  s.ev.on('chats.update', (us) => {
    for (const u of us) if (u.id && store.chats[u.id] && typeof u.unreadCount === 'number') store.chats[u.id]!.unread = Math.max(0, u.unreadCount);
    touch();
  });
  return status;
}

function wipeAuth(): void {
  rmSync(AUTH, { recursive: true, force: true });
}

/** Unlink this device and forget the local message tail. */
export async function logout(): Promise<void> {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const s = sock;
  sock = null;
  try {
    if (s && status.state === 'open') await s.logout();
    else s?.end(undefined);
  } catch {
    /* already gone */
  }
  wipeAuth();
  store = emptyStore();
  rmSync(STORE, { force: true });
  setStatus({ state: 'unlinked' });
}

/** resume a previously linked session at startup */
export function autoStart(): void {
  if (status.state === 'closed') void connect().catch((e) => setStatus({ state: 'closed', error: String(e?.message ?? e) }));
}

function requireOpen(): Sock {
  if (!sock || status.state !== 'open') throw new HttpError(409, 'WhatsApp is not connected — link it in Config → Accounts');
  return sock;
}

export const chats = (): WhatsAppChat[] => listChats(store);
export const unreadChats = (): WhatsAppChat[] => chats().filter((c) => c.unread > 0);
export const findChats = (q: string): WhatsAppChat[] => searchChats(store, q);

export function messages(chatId: string, limit = 50): WhatsAppMessage[] {
  return (store.messages[chatId] ?? []).slice(-limit).map((m) => ({ ...m, senderName: m.fromMe ? 'me' : store.names[m.sender] ?? m.senderName ?? displayName(store, m.sender) }));
}

/** chat JID from a JID, a phone number, or a unique name match */
export function resolveChat(ref: string): string {
  const r = ref.trim();
  if (r.includes('@')) return r;
  const digits = r.replace(/[\s+()-]/g, '');
  if (/^\d{6,15}$/.test(digits)) return `${digits}@s.whatsapp.net`;
  const hits = findChats(r);
  const exact = hits.filter((c) => c.name.toLowerCase() === r.toLowerCase());
  const pick = exact.length === 1 ? exact : hits;
  if (pick.length === 1) return pick[0]!.id;
  throw new HttpError(pick.length ? 409 : 404, pick.length ? `Ambiguous chat "${r}": ${pick.slice(0, 5).map((c) => `${c.name} (${c.id})`).join(', ')}` : `No chat matching "${r}"`);
}

export const chatName = (jid: string): string => store.chats[jid]?.name ?? displayName(store, jid);

export async function sendText(chatId: string, text: string): Promise<WhatsAppMessage | null> {
  const s = requireOpen();
  const sent = await s.sendMessage(chatId, { text });
  const n = sent ? normalizeMessage(sent as any) : null;
  if (n) addMessage(store, n, false);
  touch();
  return n;
}

export async function markRead(chatId: string): Promise<void> {
  const s = requireOpen();
  const chat = store.chats[chatId];
  const incoming = (store.messages[chatId] ?? []).filter((m) => !m.fromMe).slice(-Math.max(1, chat?.unread ?? 1));
  if (incoming.length)
    await s.readMessages(incoming.map((m) => ({ remoteJid: chatId, id: m.id, fromMe: false, participant: isGroupJid(chatId) ? m.sender : undefined })));
  if (chat) chat.unread = 0;
  touch();
}
