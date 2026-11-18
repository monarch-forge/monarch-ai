/** WhatsApp tools (personal number via QR-linked bridge). */
import { z } from 'zod';
import type { WhatsAppChat, WhatsAppMessage } from '@monarch/shared';
import { defineTool, type ToolDef } from '../kernel.ts';
import { chatName, findChats, markRead, messages, resolveChat, sendText, unreadChats } from '../integrations/whatsapp/index.ts';

const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtChat = (c: WhatsAppChat) => `${c.name} (${c.id})${c.unread ? ` · ${c.unread} unread` : ''}${c.lastText ? ` · last: ${c.lastText.slice(0, 80)}` : ''}`;
const fmtMsg = (m: WhatsAppMessage) => `[${fmtTime(m.ts)}] ${m.senderName ?? m.sender}: ${m.text}`;
const chatArg = z.string().describe('Chat JID, phone number, or contact/group name');

const whatsappUnread = defineTool({
  name: 'whatsapp_unread',
  description: 'WhatsApp chats with unread messages, with the latest unread messages.',
  risk: 'safe',
  group: 'whatsapp',
  schema: z.object({}),
  run: () => {
    const list = unreadChats();
    if (!list.length) return 'No unread WhatsApp messages.';
    return list
      .map((c) => `${fmtChat(c)}\n${messages(c.id, Math.min(c.unread, 10)).map((m) => `  ${fmtMsg(m)}`).join('\n')}`)
      .join('\n');
  },
});

const whatsappRead = defineTool({
  name: 'whatsapp_read',
  description: 'Recent messages of a WhatsApp chat (only what arrived since linking).',
  risk: 'safe',
  group: 'whatsapp',
  schema: z.object({ chat: chatArg, limit: z.number().int().min(1).max(200).optional() }),
  summarize: (i) => `Read WhatsApp ${i.chat}`,
  run: ({ chat, limit }) => {
    const id = resolveChat(chat);
    const list = messages(id, limit ?? 30);
    return `${chatName(id)} (${id})\n${list.map(fmtMsg).join('\n') || '(no stored messages)'}`;
  },
});

const whatsappSearch = defineTool({
  name: 'whatsapp_search',
  description: 'Find WhatsApp chats/contacts by name or number.',
  risk: 'safe',
  group: 'whatsapp',
  schema: z.object({ query: z.string().min(1) }),
  run: ({ query }) => findChats(query).map(fmtChat).join('\n') || 'No match.',
});

const whatsappSend = defineTool({
  name: 'whatsapp_send',
  description: 'Send a WhatsApp text message from the user\'s own number.',
  risk: 'dangerous',
  group: 'whatsapp',
  keywords: ['message', 'reply', 'text'],
  schema: z.object({ chat: chatArg, text: z.string().min(1) }),
  summarize: (i) => `WhatsApp to ${i.chat}: ${i.text.slice(0, 80)}`,
  target: (i) => {
    try {
      return `whatsapp:${resolveChat(i.chat)}`;
    } catch {
      return undefined; // run() throws the same resolve error, so nothing is sent
    }
  },
  run: async ({ chat, text }) => {
    const id = resolveChat(chat);
    await sendText(id, text);
    return `Sent to ${chatName(id)}.`;
  },
});

const whatsappMarkRead = defineTool({
  name: 'whatsapp_mark_read',
  description: 'Mark a WhatsApp chat as read.',
  risk: 'sensitive',
  group: 'whatsapp',
  schema: z.object({ chat: chatArg }),
  run: async ({ chat }) => {
    const id = resolveChat(chat);
    await markRead(id);
    return `Marked ${chatName(id)} read.`;
  },
});

export const tools: ToolDef[] = [whatsappUnread, whatsappRead, whatsappSearch, whatsappSend, whatsappMarkRead];
