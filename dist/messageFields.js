"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTextMessage = getTextMessage;
exports.getMessageType = getMessageType;
exports.contactFromChatId = contactFromChatId;
exports.digitsOnly = digitsOnly;
exports.resolveInboundContactNumber = resolveInboundContactNumber;
exports.rowContactNumber = rowContactNumber;
// Pure field extraction shared by the whatsapp_messages row builder
// (whatsapp.ts) and the AI agent bridge (src/agent), so a forwarded message
// always carries exactly the chat_id/contact_number/text that was saved.
// No session state, no env: importable from tests.
function getTextMessage(message) {
    if (!message)
        return "";
    return (message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        "");
}
function getMessageType(message) {
    if (!message)
        return "unknown";
    if (message.conversation || message.extendedTextMessage)
        return "text";
    if (message.imageMessage)
        return "image";
    if (message.videoMessage)
        return "video";
    if (message.documentMessage)
        return "document";
    if (message.audioMessage)
        return "audio";
    if (message.stickerMessage)
        return "sticker";
    return "unknown";
}
function contactFromChatId(chatId) {
    return chatId.replace("@s.whatsapp.net", "").replace("@g.us", "");
}
function digitsOnly(value) {
    return value.replace(/[^0-9]/g, "");
}
// remoteJid can be a WhatsApp @lid privacy id (not a real, dialable number)
// instead of the contact's actual phone number. senderPn/participantPn carry
// the real number when Baileys has it, so prefer those for inbound messages;
// fall back to remoteJid only when neither is present. Digits-only strips
// @s.whatsapp.net/@lid (and anything else non-numeric) in one step.
function resolveInboundContactNumber(key, chatId) {
    return digitsOnly(key.senderPn || key.participantPn || chatId);
}
// contact_number exactly as buildMessageRow()/recordOutbound() write it.
function rowContactNumber(key, chatId) {
    return key.fromMe ? contactFromChatId(chatId) : resolveInboundContactNumber(key, chatId);
}
