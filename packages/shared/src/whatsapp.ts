/** WhatsApp (personal number via the unofficial Baileys QR bridge). REST: /api/whatsapp/* */
export type WhatsAppState = 'unlinked' | 'connecting' | 'pairing' | 'open' | 'closed';

export interface WhatsAppStatus {
  state: WhatsAppState;
  /** QR as a PNG data URL while pairing */
  qr?: string;
  /** linked account: own JID + push name */
  me?: { id: string; name?: string };
  error?: string;
}

export interface WhatsAppMessage {
  id: string;
  chatId: string;
  fromMe: boolean;
  /** sender JID (group participant or chat JID) */
  sender: string;
  senderName?: string;
  text: string;
  /** epoch ms */
  ts: number;
}

export interface WhatsAppChat {
  id: string; // JID
  name: string;
  isGroup: boolean;
  unread: number;
  lastTs: number;
  lastText?: string;
}
