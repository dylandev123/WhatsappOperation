import type { proto, WAMessageKey } from "@whiskeysockets/baileys";

// Pure field extraction shared by the whatsapp_messages row builder
// (whatsapp.ts) and the AI agent bridge (src/agent), so a forwarded message
// always carries exactly the chat_id/contact_number/text that was saved.
// No session state, no env: importable from tests.

export function getTextMessage(message?: proto.IMessage | null): string {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

export function getMessageType(message?: proto.IMessage | null): string {
  if (!message) return "unknown";
  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.documentMessage) return "document";
  if (message.audioMessage) return "audio";
  if (message.stickerMessage) return "sticker";
  return "unknown";
}

export function contactFromChatId(chatId: string): string {
  return chatId.replace("@s.whatsapp.net", "").replace("@g.us", "");
}

export function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

// remoteJid can be a WhatsApp @lid privacy id (not a real, dialable number)
// instead of the contact's actual phone number. senderPn/participantPn carry
// the real number when Baileys has it, so prefer those for inbound messages;
// fall back to remoteJid only when neither is present. Digits-only strips
// @s.whatsapp.net/@lid (and anything else non-numeric) in one step.
export function resolveInboundContactNumber(key: WAMessageKey, chatId: string): string {
  return digitsOnly(key.senderPn || key.participantPn || chatId);
}

// contact_number exactly as buildMessageRow()/recordOutbound() write it.
export function rowContactNumber(key: WAMessageKey, chatId: string): string {
  return key.fromMe ? contactFromChatId(chatId) : resolveInboundContactNumber(key, chatId);
}

// contact_number for the agent payload. Same as the saved row, except an @lid
// chat whose phone WhatsApp never reported yields null: the row's fallback is
// the @lid's own digits, which must not reach the agent as a phone number.
export function forwardContactNumber(key: WAMessageKey, chatId: string): string | null {
  if (chatId.endsWith("@lid") && (key.fromMe || !(key.senderPn || key.participantPn))) return null;
  return rowContactNumber(key, chatId) || null;
}
