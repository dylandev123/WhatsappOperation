"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSession = startSession;
exports.startAllSessions = startAllSessions;
exports.getSessionStatus = getSessionStatus;
exports.getQrDataUrl = getQrDataUrl;
exports.sendTextMessage = sendTextMessage;
exports.restartSession = restartSession;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const qrcode_1 = __importDefault(require("qrcode"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_js_1 = require("./config.js");
const supabase_js_1 = require("./supabase.js");
const logger = (0, pino_1.default)({ level: "info" });
const sessions = new Map();
function ensureDir(dir) {
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
}
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
async function saveMediaIfAny(businessSlug, message) {
    const msg = message.message;
    const type = getMessageType(msg);
    if (!["image", "video", "document", "audio", "sticker"].includes(type)) {
        return null;
    }
    try {
        ensureDir(config_js_1.config.mediaDir);
        const businessMediaDir = path_1.default.join(config_js_1.config.mediaDir, businessSlug);
        ensureDir(businessMediaDir);
        const buffer = await (0, baileys_1.downloadMediaMessage)(message, "buffer", {}, {
            logger,
            // Baileys types this as required even though it's only needed when a
            // media message has expired and must be re-fetched; the session's
            // socket is always set by the time this handler can fire.
            reuploadRequest: sessions.get(businessSlug)?.socket?.updateMediaMessage
        });
        const extension = type === "image" ? "jpg" :
            type === "video" ? "mp4" :
                type === "audio" ? "ogg" :
                    type === "sticker" ? "webp" : "bin";
        const filename = `${Date.now()}-${message.key.id || "media"}.${extension}`;
        const filepath = path_1.default.join(businessMediaDir, filename);
        fs_1.default.writeFileSync(filepath, buffer);
        return `${config_js_1.config.publicBaseUrl}/media/${businessSlug}/${filename}`;
    }
    catch (error) {
        console.error(`Failed saving media for ${businessSlug}:`, error);
        return null;
    }
}
async function startSession(businessSlug) {
    ensureDir(config_js_1.config.authDir);
    const session = sessions.get(businessSlug) || {
        businessSlug,
        status: "starting",
        sentMessageIds: new Set()
    };
    session.status = "starting";
    sessions.set(businessSlug, session);
    await (0, supabase_js_1.upsertSessionStatus)(businessSlug, "starting");
    const authPath = path_1.default.join(config_js_1.config.authDir, businessSlug);
    ensureDir(authPath);
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(authPath);
    const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
    const socket = (0, baileys_1.default)({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: (0, baileys_1.makeCacheableSignalKeyStore)(state.keys, logger)
        },
        printQRInTerminal: false,
        browser: ["Devaux Operations", "Chrome", "1.0.0"]
    });
    session.socket = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            session.qr = qr;
            session.qrDataUrl = await qrcode_1.default.toDataURL(qr);
            session.status = "qr";
            await (0, supabase_js_1.upsertSessionStatus)(businessSlug, "qr", {
                last_qr_at: new Date().toISOString()
            });
            console.log(`[${businessSlug}] QR ready`);
        }
        if (connection === "open") {
            session.status = "connected";
            session.qr = undefined;
            session.qrDataUrl = undefined;
            await (0, supabase_js_1.upsertSessionStatus)(businessSlug, "connected", {
                last_connected_at: new Date().toISOString()
            });
            console.log(`[${businessSlug}] connected`);
        }
        if (connection === "close") {
            session.status = "disconnected";
            await (0, supabase_js_1.upsertSessionStatus)(businessSlug, "disconnected", {
                last_disconnected_at: new Date().toISOString()
            });
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== baileys_1.DisconnectReason.loggedOut;
            console.log(`[${businessSlug}] disconnected. reconnect=${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(() => startSession(businessSlug).catch(console.error), 5000);
            }
        }
    });
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify")
            return;
        for (const msg of messages) {
            if (!msg.message)
                continue;
            // sendTextMessage() already saved this exact message when the app sent
            // it; this event is just Baileys echoing it back. Messages sent from
            // the phone directly (not through the app) are fromMe too, but have no
            // entry here, so they still fall through and get saved below.
            if (msg.key.fromMe && msg.key.id && session.sentMessageIds.has(msg.key.id)) {
                session.sentMessageIds.delete(msg.key.id);
                continue;
            }
            const chatId = msg.key.remoteJid || "";
            const messageBody = getTextMessage(msg.message);
            const messageType = getMessageType(msg.message);
            const mediaUrl = await saveMediaIfAny(businessSlug, msg);
            const direction = msg.key.fromMe ? "outbound" : "inbound";
            await (0, supabase_js_1.saveMessage)({
                business_slug: businessSlug,
                whatsapp_message_id: msg.key.id,
                chat_id: chatId,
                contact_number: contactFromChatId(chatId),
                contact_name: msg.key.fromMe ? null : msg.pushName || null,
                message_body: messageBody,
                message_type: messageType,
                media_url: mediaUrl,
                direction,
                timestamp: msg.messageTimestamp
                    ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
                    : new Date().toISOString(),
                raw: msg
            });
            console.log(`[${businessSlug}] ${direction} ${msg.key.fromMe ? "from phone " : ""}${chatId}: ${messageBody}`);
        }
    });
    return session;
}
async function startAllSessions() {
    for (const business of config_js_1.config.businesses) {
        await startSession(business);
    }
}
function getSessionStatus() {
    return Array.from(sessions.values()).map((session) => ({
        businessSlug: session.businessSlug,
        status: session.status,
        hasQr: Boolean(session.qrDataUrl)
    }));
}
function getQrDataUrl(businessSlug) {
    return sessions.get(businessSlug)?.qrDataUrl || null;
}
async function sendTextMessage(businessSlug, to, body) {
    const session = sessions.get(businessSlug);
    if (!session?.socket || session.status !== "connected") {
        throw new Error(`WhatsApp session ${businessSlug} is not connected`);
    }
    const chatId = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    const result = await session.socket.sendMessage(chatId, { text: body });
    if (result?.key?.id)
        session.sentMessageIds.add(result.key.id);
    await (0, supabase_js_1.saveMessage)({
        business_slug: businessSlug,
        whatsapp_message_id: result?.key?.id || null,
        chat_id: chatId,
        contact_number: contactFromChatId(chatId),
        contact_name: null,
        message_body: body,
        message_type: "text",
        media_url: null,
        direction: "outbound",
        timestamp: new Date().toISOString(),
        raw: result || null
    });
    return result;
}
async function restartSession(businessSlug) {
    const session = sessions.get(businessSlug);
    try {
        session?.socket?.end(undefined);
    }
    catch { }
    return startSession(businessSlug);
}
