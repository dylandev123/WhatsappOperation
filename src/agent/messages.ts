import type { proto } from "@whiskeysockets/baileys";
import { forwardContactNumber, getMessageType, getTextMessage } from "../messageFields.js";
import type { ForwardPayload } from "./types.js";

// Turns a live Baileys message into the Inbox /message payload, using the
// same field helpers as the whatsapp_messages row builder so chatId and
// contactNumber always match the saved row. Pure: no session state.

export type Classification =
  | { kind: "direct"; payload: Omit<ForwardPayload, "businessSlug"> } // 1:1 chat, either direction
  | { kind: "group"; payload: Omit<ForwardPayload, "businessSlug"> }
  | { kind: "ignore"; reason: string };

const DIRECT_JID = /^[^@\s]+@(s\.whatsapp\.net|lid)$/;
const GROUP_JID = /^[^@\s]+@g\.us$/;
const MEDIA_TYPES = new Set(["image", "video", "document", "audio", "sticker"]);

function contextInfo(message: proto.IMessage): proto.IContextInfo | null | undefined {
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.stickerMessage?.contextInfo
  );
}

export function classifyMessage(msg: proto.IWebMessageInfo): Classification {
  const chatId = msg.key.remoteJid || "";
  const messageId = msg.key.id || "";
  if (!chatId || !messageId) return { kind: "ignore", reason: "missing_key" };
  if (chatId.endsWith("@broadcast") || chatId.endsWith("@newsletter")) return { kind: "ignore", reason: "system_chat" };
  if (msg.messageStubType) return { kind: "ignore", reason: "system_event" };

  const message = msg.message;
  if (!message) return { kind: "ignore", reason: "no_content" };
  if (message.protocolMessage || message.reactionMessage || message.pollUpdateMessage || message.editedMessage) {
    return { kind: "ignore", reason: "system_event" };
  }

  const text = getTextMessage(message);
  const hasMedia = MEDIA_TYPES.has(getMessageType(message));
  if (!text.trim() && !hasMedia) return { kind: "ignore", reason: "empty_or_unsupported" };

  const isGroup = GROUP_JID.test(chatId);
  if (!isGroup && !DIRECT_JID.test(chatId)) return { kind: "ignore", reason: "unsupported_chat" };

  const payload: Omit<ForwardPayload, "businessSlug"> = {
    whatsappMessageId: messageId,
    chatId,
    contactNumber: forwardContactNumber(msg.key, chatId),
    fromMe: Boolean(msg.key.fromMe),
    text,
    hasMedia,
    quotedMessageId: contextInfo(message)?.stanzaId || null,
    senderJid: isGroup ? msg.key.participant || null : null,
    timestamp: new Date(msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()).toISOString()
  };
  return isGroup ? { kind: "group", payload } : { kind: "direct", payload };
}
