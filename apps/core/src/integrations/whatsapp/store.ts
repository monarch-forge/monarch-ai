/** Lightweight WhatsApp chat/message store. Baileys keeps no history, so we keep the recent tail ourselves. */
import type { WhatsAppChat, WhatsAppMessage } from '@monarch/shared';

export const MAX_PER_CHAT = 200;
export const MAX_CHATS = 300;
const MAX_TEXT = 4000;

export interface StoreShape {
  chats: Record<string, WhatsAppChat>;
  messages: Record<string, WhatsAppMessage[]>;
  names: Record<string, string>;
}

export const emptyStore = (): StoreShape => ({ chats: {}, messages: {}, names: {} });

/** Minimal shape of a Baileys WAMessage we read (kept structural so tests need no Baileys). */
export interface RawMessage {
  key: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null };
  message?: Record<string, any> | null;
  messageTimestamp?: number | { toNumber(): number } | null;
  pushName?: string | null;
}

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];
const LABELS: Record<string, string> = {
  imageMessage: '[image]',
  videoMessage: '[video]',
  audioMessage: '[voice note]',
  documentMessage: '[document]',
  stickerMessage: '[sticker]',
  locationMessage: '[location]',
  contactMessage: '[contact]',
  pollCreationMessage: '[poll]',
};

export function messageText(m: Record<string, any> | null | undefined): string | null {
  if (!m) return null;
  for (const w of WRAPPERS) if (m[w]?.message) return messageText(m[w].message);
  if (typeof m.conversation === 'string') return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  for (const [k, label] of Object.entries(LABELS)) {
    if (m[k]) {
      const cap = m[k].caption ?? m[k].fileName ?? m[k].name;
      return cap ? `${label} ${cap}` : label;
    }
  }
  return null; // protocol / reaction / key-distribution messages: not shown
}

export const isGroupJid = (jid: string) => jid.endsWith('@g.us');

/** Baileys WAMessage -> our message, or null for things we don't keep. */
export function normalizeMessage(raw: RawMessage): WhatsAppMessage | null {
  const chatId = raw.key.remoteJid;
  const id = raw.key.id;
  if (!chatId || !id || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) return null;
  const text = messageText(raw.message);
  if (text == null) return null;
  const t = raw.messageTimestamp;
  const secs = typeof t === 'number' ? t : t ? t.toNumber() : Date.now() / 1000;
  const fromMe = !!raw.key.fromMe;
  return {
    id,
    chatId,
    fromMe,
    sender: (isGroupJid(chatId) ? raw.key.participant : chatId) ?? chatId,
    senderName: fromMe ? undefined : raw.pushName ?? undefined,
    text: text.slice(0, MAX_TEXT),
    ts: secs * 1000,
  };
}

export const displayName = (s: StoreShape, jid: string): string => s.names[jid] ?? `+${jid.split('@')[0]?.split(':')[0]}`;

/** Add a message; returns true if new. `countUnread` for live incoming messages. */
export function addMessage(s: StoreShape, m: WhatsAppMessage, countUnread: boolean): boolean {
  const list = (s.messages[m.chatId] ??= []);
  if (list.some((x) => x.id === m.id)) return false;
  list.push(m);
  list.sort((a, b) => a.ts - b.ts);
  if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
  if (m.senderName && !m.fromMe && !s.names[m.sender]) s.names[m.sender] = m.senderName;
  const chat = (s.chats[m.chatId] ??= { id: m.chatId, name: displayName(s, m.chatId), isGroup: isGroupJid(m.chatId), unread: 0, lastTs: 0 });
  if (m.ts >= chat.lastTs) {
    chat.lastTs = m.ts;
    chat.lastText = m.text.slice(0, 200);
  }
  if (countUnread && !m.fromMe) chat.unread++;
  if (m.fromMe) chat.unread = 0; // replying from the phone reads the chat
  prune(s);
  return true;
}

/** keep at most MAX_CHATS chats (most recent) */
export function prune(s: StoreShape): void {
  const ids = Object.keys(s.chats);
  if (ids.length <= MAX_CHATS) return;
  ids.sort((a, b) => s.chats[b]!.lastTs - s.chats[a]!.lastTs);
  for (const id of ids.slice(MAX_CHATS)) {
    delete s.chats[id];
    delete s.messages[id];
  }
}

export function setName(s: StoreShape, jid: string, name: string | null | undefined): void {
  if (!name) return;
  s.names[jid] = name;
  if (s.chats[jid]) s.chats[jid].name = name;
}

export function listChats(s: StoreShape): WhatsAppChat[] {
  return Object.values(s.chats)
    .map((c) => ({ ...c, name: s.names[c.id] ?? c.name }))
    .sort((a, b) => b.lastTs - a.lastTs);
}

export function searchChats(s: StoreShape, q: string): WhatsAppChat[] {
  const needle = q.toLowerCase();
  const found = listChats(s).filter((c) => c.name.toLowerCase().includes(needle) || c.id.includes(needle));
  // contacts we know by name but have no chat with yet
  for (const [jid, name] of Object.entries(s.names))
    if (!s.chats[jid] && !isGroupJid(jid) && name.toLowerCase().includes(needle)) found.push({ id: jid, name, isGroup: false, unread: 0, lastTs: 0 });
  return found.slice(0, 30);
}
