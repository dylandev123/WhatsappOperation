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
exports.PreSendError = void 0;
exports.setMessageHooks = setMessageHooks;
exports.startSession = startSession;
exports.startAllSessions = startAllSessions;
exports.getSessionStatus = getSessionStatus;
exports.findSession = findSession;
exports.getQrDataUrl = getQrDataUrl;
exports.sendTextMessage = sendTextMessage;
exports.isSessionConnected = isSessionConnected;
exports.sendScheduledText = sendScheduledText;
exports.sendAgentText = sendAgentText;
exports.restartSession = restartSession;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const qrcode_1 = __importDefault(require("qrcode"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_js_1 = require("./config.js");
const supabase_js_1 = require("./supabase.js");
const messageFields_js_1 = require("./messageFields.js");
// Thrown by sendScheduledText when the message provably never reached
// WhatsApp (no session, not connected, invalid JID). Anything else thrown from
// a send is ambiguous: the message may or may not have been delivered.
class PreSendError extends Error {
    constructor(message) {
        super(message);
        this.name = "PreSendError";
    }
}
exports.PreSendError = PreSendError;
let messageHooks = null;
function setMessageHooks(hooks) {
    messageHooks = hooks;
}
function notifyHooks(businessSlug, msg, origin) {
    if (!messageHooks)
        return;
    void messageHooks.onLiveMessage(businessSlug, msg, origin).catch((err) => console.error(`[${businessSlug}] agent hook failed:`, err instanceof Error ? err.message : err));
}
const SEND_TIMEOUT_MS = 60_000;
const AMBIGUOUS_ECHO_GRACE_MS = 10 * 60_000;
let pendingSendSeq = 0;
const SCHEDULED_JID_PATTERN = /^[^@\s]+@(s\.whatsapp\.net|lid|g\.us)$/;
const logger = (0, pino_1.default)({ level: "info" });
const sessions = new Map();
// Only import messages from the last 2 days on link/relink history sync.
const HISTORY_IMPORT_WINDOW_SECONDS = 2 * 24 * 60 * 60;
function ensureDir(dir) {
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
}
async function saveMediaIfAny(businessSlug, message) {
    const msg = message.message;
    const type = (0, messageFields_js_1.getMessageType)(msg);
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
function updateContactNames(session, contacts) {
    if (!contacts?.length)
        return;
    let namedCount = 0;
    for (const contact of contacts) {
        if (!contact.name)
            continue;
        namedCount++;
        // Root cause of business_contact_name never populating: many chats on
        // this account are keyed by the WhatsApp @lid privacy id rather than the
        // phone-based jid (see resolveInboundContactNumber in messageFields.ts), but the saved
        // name only ever arrived indexed by contact.id/contact.jid (the
        // phone-based jid) — contact.lid was never stored, so a message whose
        // chat_id is the @lid form could never match. Index all three forms.
        if (contact.id)
            session.contactNames.set(contact.id, contact.name);
        if (contact.jid)
            session.contactNames.set(contact.jid, contact.name);
        if (contact.lid)
            session.contactNames.set(contact.lid, contact.name);
    }
    // TEMPORARY diagnostic log — remove once business_contact_name is
    // confirmed flowing to Supabase. Counts only, no contact/message content.
    console.log(`[${session.businessSlug}] contact event: received=${contacts.length} withSavedName=${namedCount} mapSize=${session.contactNames.size}`);
}
function takePendingOwnSend(session, msg) {
    const jid = msg.key.remoteJid || "";
    const body = (0, messageFields_js_1.getTextMessage)(msg.message).trim();
    if (!jid || !body)
        return null;
    for (const [token, pending] of session.pendingOwnSends) {
        if (pending.jid === jid && pending.body === body) {
            session.pendingOwnSends.delete(token);
            return pending.origin;
        }
    }
    return null;
}
function getBusinessContactName(session, jid) {
    return session.contactNames.get(jid) ?? null;
}
// Shared row shape for both the live messages.upsert handler and history
// import, so a historical row's chat_id/contact fields always match what a
// live message for the same chat would get (same thread, not a split one).
async function buildMessageRow(businessSlug, session, msg) {
    if (!msg.message)
        return null;
    const chatId = msg.key.remoteJid || "";
    const messageBody = (0, messageFields_js_1.getTextMessage)(msg.message);
    const messageType = (0, messageFields_js_1.getMessageType)(msg.message);
    const mediaUrl = await saveMediaIfAny(businessSlug, msg);
    const direction = msg.key.fromMe ? "outbound" : "inbound";
    const contactNumber = (0, messageFields_js_1.rowContactNumber)(msg.key, chatId);
    const businessContactName = getBusinessContactName(session, chatId);
    // TEMPORARY diagnostic log — remove once business_contact_name is
    // confirmed flowing to Supabase. chat_id/resolved name only, no body text.
    console.log(`[${businessSlug}] business_contact_name lookup chat_id=${chatId} resolved=${businessContactName ?? "none"}`);
    return {
        business_slug: businessSlug,
        whatsapp_message_id: msg.key.id,
        chat_id: chatId,
        contact_number: contactNumber,
        contact_name: msg.key.fromMe ? null : msg.pushName || null,
        business_contact_name: businessContactName,
        message_body: messageBody,
        message_type: messageType,
        media_url: mediaUrl,
        direction,
        timestamp: msg.messageTimestamp
            ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
            : new Date().toISOString(),
        raw: msg
    };
}
// Mirrors isSystemChatId()-style filtering plus the noise Baileys' history
// sync includes that a live messages.upsert never sends (protocol/app-state
// messages, history-sync notifications, WA-generated stub events).
function shouldSkipHistoryMessage(msg, cutoffSeconds) {
    const timestamp = Number(msg.messageTimestamp || 0);
    if (timestamp < cutoffSeconds)
        return true;
    const remoteJid = msg.key.remoteJid || "";
    if (remoteJid === "status@broadcast" || remoteJid.endsWith("@broadcast"))
        return true;
    if (msg.messageStubType)
        return true;
    const message = msg.message;
    if (!message)
        return true;
    // protocolMessage carries key distribution / app-state sync / history-sync
    // notifications with no user-visible content unless a real text payload
    // rides alongside it.
    if (message.protocolMessage && !message.conversation && !message.extendedTextMessage)
        return true;
    return false;
}
async function importHistory(businessSlug, session, messages) {
    const cutoffSeconds = Math.floor(Date.now() / 1000) - HISTORY_IMPORT_WINDOW_SECONDS;
    const candidates = messages.filter((msg) => !shouldSkipHistoryMessage(msg, cutoffSeconds));
    if (!candidates.length)
        return;
    // Bounded concurrency, not a single multi-row insert: saveMessage() relies
    // on the whatsapp_messages_dedupe_idx unique-violation error to skip
    // duplicates (see supabase.ts), which only works one row at a time — a
    // multi-row insert would fail (and drop) the whole batch on one conflict.
    const CONCURRENCY = 20;
    let imported = 0;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
        const chunk = candidates.slice(i, i + CONCURRENCY);
        const rows = await Promise.all(chunk.map((msg) => buildMessageRow(businessSlug, session, msg)));
        await Promise.all(rows.filter((row) => row !== null).map((row) => (0, supabase_js_1.saveMessage)(row)));
        imported += rows.length;
    }
    console.log(`[${businessSlug}] history import: processed ${imported} messages from the last 2 days`);
}
async function startSession(businessSlug) {
    ensureDir(config_js_1.config.authDir);
    const session = sessions.get(businessSlug) || {
        businessSlug,
        status: "starting",
        sentMessageIds: new Map(),
        pendingOwnSends: new Map(),
        contactNames: new Map()
    };
    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = undefined;
    }
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
        browser: ["Devaux Operations", "Chrome", "1.0.0"],
        // Needed so Baileys actually requests/emits historical messages (via
        // messaging-history.set) on link/relink, not just the chat/contact list.
        syncFullHistory: true
    });
    session.socket = socket;
    // restartSession() and reconnects replace session.socket while the old
    // socket can still emit events (notably its own "close"). Only the current
    // socket may drive session state, reconnects and message saves; otherwise a
    // stale close schedules a second startSession() and two sockets end up
    // fighting over the same auth state.
    const isCurrent = () => session.socket === socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("contacts.upsert", (contacts) => updateContactNames(session, contacts));
    socket.ev.on("contacts.update", (contacts) => updateContactNames(session, contacts));
    // Fires once per connection (fresh QR link or session restore) with the
    // synced backlog. Dispatched, not awaited, so a large import never blocks
    // the messages.upsert handler below (realtime keeps working throughout).
    socket.ev.on("messaging-history.set", ({ contacts, messages }) => {
        updateContactNames(session, contacts);
        void importHistory(businessSlug, session, messages).catch((err) => console.error(`[${businessSlug}] history import failed:`, err));
    });
    socket.ev.on("connection.update", async (update) => {
        if (!isCurrent())
            return;
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
                if (session.reconnectTimer)
                    clearTimeout(session.reconnectTimer);
                session.reconnectTimer = setTimeout(() => {
                    session.reconnectTimer = undefined;
                    if (!isCurrent())
                        return;
                    startSession(businessSlug).catch(console.error);
                }, 5000);
            }
        }
    });
    socket.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!isCurrent())
            return;
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
                const origin = session.sentMessageIds.get(msg.key.id) ?? null;
                session.sentMessageIds.delete(msg.key.id);
                notifyHooks(businessSlug, msg, origin);
                continue;
            }
            const pendingOrigin = msg.key.fromMe ? takePendingOwnSend(session, msg) : null;
            const row = await buildMessageRow(businessSlug, session, msg);
            if (!row)
                continue;
            if (!msg.key.fromMe) {
                console.log(`[${businessSlug}] inbound chat_id=${row.chat_id} contact_number=${row.contact_number}`);
            }
            await (0, supabase_js_1.saveMessage)(row);
            console.log(`[${businessSlug}] ${row.direction} ${msg.key.fromMe ? "from phone " : ""}${row.chat_id}: ${row.message_body}`);
            notifyHooks(businessSlug, msg, pendingOrigin ?? (msg.key.fromMe ? "phone" : null));
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
// Session keys are whatever string config.businesses (the BUSINESSES env
// var) or an admin action first started a session with — case is preserved
// as-is, not normalized. QR lookups can arrive with a differently-cased
// slug (e.g. the app's canonical "by_sea" vs. a legacy "By_Sea" session), so
// fall back to a case-insensitive scan rather than renaming/duplicating the
// live session.
function findSession(businessSlug) {
    const exact = sessions.get(businessSlug);
    if (exact)
        return exact;
    const lower = businessSlug.toLowerCase();
    for (const [key, session] of sessions) {
        if (key.toLowerCase() === lower)
            return session;
    }
    return undefined;
}
function getQrDataUrl(businessSlug) {
    return findSession(businessSlug)?.qrDataUrl || null;
}
// Saves the outbound row and registers the id so the messages.upsert echo of
// this send isn't saved twice. saveMessage() never throws (it logs), so a DB
// failure here can't turn a delivered message into a reported failure.
async function recordOutbound(session, chatId, body, result, origin) {
    if (result?.key?.id)
        session.sentMessageIds.set(result.key.id, origin);
    await (0, supabase_js_1.saveMessage)({
        business_slug: session.businessSlug,
        whatsapp_message_id: result?.key?.id || null,
        chat_id: chatId,
        contact_number: (0, messageFields_js_1.contactFromChatId)(chatId),
        contact_name: null,
        business_contact_name: getBusinessContactName(session, chatId),
        message_body: body,
        message_type: "text",
        media_url: null,
        direction: "outbound",
        timestamp: new Date().toISOString(),
        raw: result || null
    });
}
async function sendTextMessage(businessSlug, to, body) {
    const session = sessions.get(businessSlug);
    if (!session?.socket || session.status !== "connected") {
        throw new Error(`WhatsApp session ${businessSlug} is not connected`);
    }
    const chatId = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    const result = await session.socket.sendMessage(chatId, { text: body });
    await recordOutbound(session, chatId, body, result, "api");
    // Echoes of app sends usually arrive as 'append' (ignored above), so tell
    // the agent directly: a send from the inbox is a manual staff reply.
    if (result?.key)
        notifyHooks(businessSlug, { key: result.key, message: result.message, messageTimestamp: result.messageTimestamp }, "api");
    return result;
}
function isSessionConnected(businessSlug) {
    const session = findSession(businessSlug);
    return Boolean(session?.socket && session.status === "connected");
}
// Scheduled sends: the recipient is already a chat JID (@s.whatsapp.net, @lid
// or @g.us) and is used exactly as stored. Throws PreSendError when nothing
// could have been sent; any other error means the outcome is unknown.
async function sendScheduledText(businessSlug, jid, body) {
    return sendGuardedText(businessSlug, jid, body, "scheduled");
}
// Same guarded path as scheduled sends, recorded as an agent send.
async function sendAgentText(businessSlug, jid, body) {
    return sendGuardedText(businessSlug, jid, body, "agent");
}
async function sendGuardedText(businessSlug, jid, body, origin) {
    const session = findSession(businessSlug);
    if (!session?.socket || session.status !== "connected") {
        throw new PreSendError(`WhatsApp session ${businessSlug} is not connected`);
    }
    if (!SCHEDULED_JID_PATTERN.test(jid)) {
        throw new PreSendError("Recipient is not a valid chat JID");
    }
    if (!body.trim()) {
        throw new PreSendError("Message body is empty");
    }
    const socket = session.socket;
    const token = ++pendingSendSeq;
    session.pendingOwnSends.set(token, { jid, body: body.trim(), origin });
    let timer;
    let result;
    try {
        result = await Promise.race([
            socket.sendMessage(jid, { text: body }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("send timed out")), SEND_TIMEOUT_MS);
            })
        ]);
    }
    catch (error) {
        // Outcome unknown: a late echo may still arrive, so keep it recognisable.
        setTimeout(() => session.pendingOwnSends.delete(token), AMBIGUOUS_ECHO_GRACE_MS).unref();
        throw error;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
    const messageId = result?.key?.id;
    if (!messageId) {
        setTimeout(() => session.pendingOwnSends.delete(token), AMBIGUOUS_ECHO_GRACE_MS).unref();
        throw new Error("send returned no message id");
    }
    session.pendingOwnSends.delete(token);
    await recordOutbound(session, jid, body, result, origin);
    return { messageId };
}
async function restartSession(businessSlug) {
    const session = sessions.get(businessSlug);
    if (session?.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = undefined;
    }
    // Detach before ending: startSession() swaps session.socket, and the
    // isCurrent() guards then ignore anything the old socket still emits.
    const oldSocket = session?.socket;
    if (session)
        session.socket = undefined;
    try {
        oldSocket?.end(undefined);
    }
    catch { }
    return startSession(businessSlug);
}
