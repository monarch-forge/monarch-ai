import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMessage, emptyStore, listChats, MAX_PER_CHAT, MAX_CHATS, normalizeMessage, searchChats, setName } from './store.ts';

const raw = (over: any = {}) => ({
  key: { remoteJid: '4911@s.whatsapp.net', id: 'A1', fromMe: false, ...over.key },
  message: over.message ?? { conversation: 'hi' },
  messageTimestamp: over.ts ?? 1700000000,
  pushName: 'Ana',
});

test('normalizeMessage: text, wrappers, media, skips', () => {
  assert.equal(normalizeMessage(raw())?.text, 'hi');
  assert.equal(normalizeMessage(raw({ message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'x' } } } } }))?.text, 'x');
  assert.equal(normalizeMessage(raw({ message: { imageMessage: { caption: 'cat' } } }))?.text, '[image] cat');
  assert.equal(normalizeMessage(raw({ message: { protocolMessage: {} } })), null);
  assert.equal(normalizeMessage(raw({ key: { remoteJid: 'status@broadcast' } })), null);
  const g = normalizeMessage(raw({ key: { remoteJid: '1-2@g.us', participant: '4922@s.whatsapp.net' } }))!;
  assert.equal(g.sender, '4922@s.whatsapp.net');
  assert.equal(g.ts, 1700000000000);
});

test('store: dedupe, unread, per-chat cap, chat cap, names', () => {
  const s = emptyStore();
  const m = normalizeMessage(raw())!;
  assert.equal(addMessage(s, m, true), true);
  assert.equal(addMessage(s, m, true), false);
  assert.equal(s.chats[m.chatId]!.unread, 1);
  assert.equal(listChats(s)[0]!.name, 'Ana'); // from pushName
  setName(s, m.chatId, 'Ana B');
  assert.equal(searchChats(s, 'ana')[0]!.id, m.chatId);
  for (let i = 0; i < MAX_PER_CHAT + 10; i++) addMessage(s, { ...m, id: `m${i}`, ts: i }, false);
  assert.equal(s.messages[m.chatId]!.length, MAX_PER_CHAT);
  addMessage(s, { ...m, id: 'me', fromMe: true, ts: 9e12 }, false);
  assert.equal(s.chats[m.chatId]!.unread, 0);
  for (let i = 0; i < MAX_CHATS + 5; i++) addMessage(s, { ...m, chatId: `c${i}@s.whatsapp.net`, id: `x${i}`, ts: 1e13 + i }, false);
  assert.equal(Object.keys(s.chats).length, MAX_CHATS);
  assert.equal(s.chats[m.chatId], undefined); // oldest pruned
});
