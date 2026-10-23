"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyMessage = classifyMessage;
const messageFields_js_1 = require("../messageFields.js");
const DIRECT_JID = /^[^@\s]+@(s\.whatsapp\.net|lid)$/;
const GROUP_JID = /^[^@\s]+@g\.us$/;
const MEDIA_TYPES = new Set(["image", "video", "document", "audio", "sticker"]);
function contextInfo(message) {
    return (message.extendedTextMessage?.contextInfo ??
        message.imageMessage?.contextInfo ??
        message.videoMessage?.contextInfo ??
        message.documentMessage?.contextInfo ??
        message.audioMessage?.contextInfo ??
        message.stickerMessage?.contextInfo);
}
// Phone for an @lid group participant, only when WhatsApp supplied it as
// participantPn. Never derived from the @lid's own digits; anything that is not
// a plain phone JID is dropped.
function verifiedParticipantPhone(key) {
    const participant = key.participant || "";
    if (!participant.endsWith("@lid"))
        return null;
    const pn = key.participantPn;
    const match = typeof pn === "string" ? /^(\d{5,20})(?::\d+)?@s\.whatsapp\.net$/.exec(pn) : null;
    return match ? match[1] : null;
}
function classifyMessage(msg) {
    const chatId = msg.key.remoteJid || "";
    const messageId = msg.key.id || "";
    if (!chatId || !messageId)
        return { kind: "ignore", reason: "missing_key" };
    if (chatId.endsWith("@broadcast") || chatId.endsWith("@newsletter"))
        return { kind: "ignore", reason: "system_chat" };
    if (msg.messageStubType)
        return { kind: "ignore", reason: "system_event" };
    const message = msg.message;
    if (!message)
        return { kind: "ignore", reason: "no_content" };
    if (message.protocolMessage || message.reactionMessage || message.pollUpdateMessage || message.editedMessage) {
        return { kind: "ignore", reason: "system_event" };
    }
    const text = (0, messageFields_js_1.getTextMessage)(message);
    const hasMedia = MEDIA_TYPES.has((0, messageFields_js_1.getMessageType)(message));
    if (!text.trim() && !hasMedia)
        return { kind: "ignore", reason: "empty_or_unsupported" };
    const isGroup = GROUP_JID.test(chatId);
    if (!isGroup && !DIRECT_JID.test(chatId))
        return { kind: "ignore", reason: "unsupported_chat" };
    const payload = {
        whatsappMessageId: messageId,
        chatId,
        contactNumber: (0, messageFields_js_1.forwardContactNumber)(msg.key, chatId),
        fromMe: Boolean(msg.key.fromMe),
        text,
        hasMedia,
        quotedMessageId: contextInfo(message)?.stanzaId || null,
        senderJid: isGroup ? msg.key.participant || null : null,
        senderPhone: isGroup ? verifiedParticipantPhone(msg.key) : null,
        timestamp: new Date(msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()).toISOString()
    };
    return isGroup ? { kind: "group", payload } : { kind: "direct", payload };
}
