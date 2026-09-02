import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  proto,
  downloadMediaMessage,
  WAMessageKey,
  Contact
} from "@whiskeysockets/baileys";
import P from "pino";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { Boom } from "@hapi/boom";
import { config } from "./config.js";
import { saveMessage, upsertSessionStatus } from "./supabase.js";

type Session = {
  businessSlug: string;
  socket?: ReturnType<typeof makeWASocket>;
  qr?: string;
  qrDataUrl?: string;
  status: "starting" | "qr" | "connected" | "disconnected";
  // IDs of messages sendTextMessage() already saved directly, so the
  // messages.upsert echo of that same send (fromMe: true) isn't saved twice.
  sentMessageIds: Set<string>;
  // JID -> device/saved contact name (Baileys Contact.name), from
  // contacts.upsert/contacts.update and the messaging-history.set backfill.
  // Keyed by both contact.id and contact.jid since either may match a
  // message's remoteJid depending on whether it's a @lid or phone-based jid.
  contactNames: Map<string, string>;
};

const logger = P({ level: "info" });
const sessions = new Map<string, Session>();

// Only import messages from the last 2 days on link/relink history sync.
const HISTORY_IMPORT_WINDOW_SECONDS = 2 * 24 * 60 * 60;

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getTextMessage(message?: proto.IMessage | null): string {
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

function getMessageType(message?: proto.IMessage | null): string {
  if (!message) return "unknown";
  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.documentMessage) return "document";
  if (message.audioMessage) return "audio";
  if (message.stickerMessage) return "sticker";
  return "unknown";
}

function contactFromChatId(chatId: string): string {
  return chatId.replace("@s.whatsapp.net", "").replace("@g.us", "");
}

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

// remoteJid can be a WhatsApp @lid privacy id (not a real, dialable number)
// instead of the contact's actual phone number. senderPn/participantPn carry
// the real number when Baileys has it, so prefer those for inbound messages;
// fall back to remoteJid only when neither is present. Digits-only strips
// @s.whatsapp.net/@lid (and anything else non-numeric) in one step.
function resolveInboundContactNumber(key: WAMessageKey, chatId: string): string {
  return digitsOnly(key.senderPn || key.participantPn || chatId);
}

async function saveMediaIfAny(businessSlug: string, message: proto.IWebMessageInfo) {
  const msg = message.message;
  const type = getMessageType(msg);

  if (!["image", "video", "document", "audio", "sticker"].includes(type)) {
    return null;
  }

  try {
    ensureDir(config.mediaDir);
    const businessMediaDir = path.join(config.mediaDir, businessSlug);
    ensureDir(businessMediaDir);

    const buffer = await downloadMediaMessage(
      message,
      "buffer",
      {},
      {
        logger,
        // Baileys types this as required even though it's only needed when a
        // media message has expired and must be re-fetched; the session's
        // socket is always set by the time this handler can fire.
        reuploadRequest: sessions.get(businessSlug)?.socket?.updateMediaMessage as NonNullable<
          Parameters<typeof downloadMediaMessage>[3]
        >["reuploadRequest"]
      }
    );

    const extension =
      type === "image" ? "jpg" :
      type === "video" ? "mp4" :
      type === "audio" ? "ogg" :
      type === "sticker" ? "webp" : "bin";

    const filename = `${Date.now()}-${message.key.id || "media"}.${extension}`;
    const filepath = path.join(businessMediaDir, filename);
    fs.writeFileSync(filepath, buffer as Buffer);

    return `${config.publicBaseUrl}/media/${businessSlug}/${filename}`;
  } catch (error) {
    console.error(`Failed saving media for ${businessSlug}:`, error);
    return null;
  }
}

function updateContactNames(session: Session, contacts: Array<Partial<Contact>> | undefined) {
  if (!contacts?.length) return;

  let namedCount = 0;
  for (const contact of contacts) {
    if (!contact.name) continue;
    namedCount++;
    // Root cause of business_contact_name never populating: many chats on
    // this account are keyed by the WhatsApp @lid privacy id rather than the
    // phone-based jid (see resolveInboundContactNumber above), but the saved
    // name only ever arrived indexed by contact.id/contact.jid (the
    // phone-based jid) — contact.lid was never stored, so a message whose
    // chat_id is the @lid form could never match. Index all three forms.
    if (contact.id) session.contactNames.set(contact.id, contact.name);
    if (contact.jid) session.contactNames.set(contact.jid, contact.name);
    if (contact.lid) session.contactNames.set(contact.lid, contact.name);
  }

  // TEMPORARY diagnostic log — remove once business_contact_name is
  // confirmed flowing to Supabase. Counts only, no contact/message content.
  console.log(
    `[${session.businessSlug}] contact event: received=${contacts.length} withSavedName=${namedCount} mapSize=${session.contactNames.size}`
  );
}

function getBusinessContactName(session: Session, jid: string): string | null {
  return session.contactNames.get(jid) ?? null;
}

// Shared row shape for both the live messages.upsert handler and history
// import, so a historical row's chat_id/contact fields always match what a
// live message for the same chat would get (same thread, not a split one).
async function buildMessageRow(
  businessSlug: string,
  session: Session,
  msg: proto.IWebMessageInfo
): Promise<Record<string, unknown> | null> {
  if (!msg.message) return null;

  const chatId = msg.key.remoteJid || "";
  const messageBody = getTextMessage(msg.message);
  const messageType = getMessageType(msg.message);
  const mediaUrl = await saveMediaIfAny(businessSlug, msg);
  const direction = msg.key.fromMe ? "outbound" : "inbound";
  const contactNumber = msg.key.fromMe
    ? contactFromChatId(chatId)
    : resolveInboundContactNumber(msg.key, chatId);
  const businessContactName = getBusinessContactName(session, chatId);

  // TEMPORARY diagnostic log — remove once business_contact_name is
  // confirmed flowing to Supabase. chat_id/resolved name only, no body text.
  console.log(
    `[${businessSlug}] business_contact_name lookup chat_id=${chatId} resolved=${businessContactName ?? "none"}`
  );

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
function shouldSkipHistoryMessage(msg: proto.IWebMessageInfo, cutoffSeconds: number): boolean {
  const timestamp = Number(msg.messageTimestamp || 0);
  if (timestamp < cutoffSeconds) return true;

  const remoteJid = msg.key.remoteJid || "";
  if (remoteJid === "status@broadcast" || remoteJid.endsWith("@broadcast")) return true;

  if (msg.messageStubType) return true;

  const message = msg.message;
  if (!message) return true;
  // protocolMessage carries key distribution / app-state sync / history-sync
  // notifications with no user-visible content unless a real text payload
  // rides alongside it.
  if (message.protocolMessage && !message.conversation && !message.extendedTextMessage) return true;

  return false;
}

async function importHistory(businessSlug: string, session: Session, messages: proto.IWebMessageInfo[]) {
  const cutoffSeconds = Math.floor(Date.now() / 1000) - HISTORY_IMPORT_WINDOW_SECONDS;
  const candidates = messages.filter((msg) => !shouldSkipHistoryMessage(msg, cutoffSeconds));

  if (!candidates.length) return;

  // Bounded concurrency, not a single multi-row insert: saveMessage() relies
  // on the whatsapp_messages_dedupe_idx unique-violation error to skip
  // duplicates (see supabase.ts), which only works one row at a time — a
  // multi-row insert would fail (and drop) the whole batch on one conflict.
  const CONCURRENCY = 20;
  let imported = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(chunk.map((msg) => buildMessageRow(businessSlug, session, msg)));
    await Promise.all(
      rows.filter((row): row is Record<string, unknown> => row !== null).map((row) => saveMessage(row))
    );
    imported += rows.length;
  }

  console.log(`[${businessSlug}] history import: processed ${imported} messages from the last 2 days`);
}

export async function startSession(businessSlug: string) {
  ensureDir(config.authDir);

  const session: Session = sessions.get(businessSlug) || {
    businessSlug,
    status: "starting",
    sentMessageIds: new Set(),
    contactNames: new Map()
  };

  session.status = "starting";
  sessions.set(businessSlug, session);
  await upsertSessionStatus(businessSlug, "starting");

  const authPath = path.join(config.authDir, businessSlug);
  ensureDir(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: ["Devaux Operations", "Chrome", "1.0.0"],
    // Needed so Baileys actually requests/emits historical messages (via
    // messaging-history.set) on link/relink, not just the chat/contact list.
    syncFullHistory: true
  });

  session.socket = socket;

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("contacts.upsert", (contacts) => updateContactNames(session, contacts));
  socket.ev.on("contacts.update", (contacts) => updateContactNames(session, contacts));

  // Fires once per connection (fresh QR link or session restore) with the
  // synced backlog. Dispatched, not awaited, so a large import never blocks
  // the messages.upsert handler below (realtime keeps working throughout).
  socket.ev.on("messaging-history.set", ({ contacts, messages }) => {
    updateContactNames(session, contacts);
    void importHistory(businessSlug, session, messages).catch((err) =>
      console.error(`[${businessSlug}] history import failed:`, err)
    );
  });

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      session.qrDataUrl = await QRCode.toDataURL(qr);
      session.status = "qr";
      await upsertSessionStatus(businessSlug, "qr", {
        last_qr_at: new Date().toISOString()
      });
      console.log(`[${businessSlug}] QR ready`);
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = undefined;
      session.qrDataUrl = undefined;
      await upsertSessionStatus(businessSlug, "connected", {
        last_connected_at: new Date().toISOString()
      });
      console.log(`[${businessSlug}] connected`);
    }

    if (connection === "close") {
      session.status = "disconnected";
      await upsertSessionStatus(businessSlug, "disconnected", {
        last_disconnected_at: new Date().toISOString()
      });

      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[${businessSlug}] disconnected. reconnect=${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => startSession(businessSlug).catch(console.error), 5000);
      }
    }
  });

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;

      // sendTextMessage() already saved this exact message when the app sent
      // it; this event is just Baileys echoing it back. Messages sent from
      // the phone directly (not through the app) are fromMe too, but have no
      // entry here, so they still fall through and get saved below.
      if (msg.key.fromMe && msg.key.id && session.sentMessageIds.has(msg.key.id)) {
        session.sentMessageIds.delete(msg.key.id);
        continue;
      }

      const row = await buildMessageRow(businessSlug, session, msg);
      if (!row) continue;

      if (!msg.key.fromMe) {
        console.log(`[${businessSlug}] inbound chat_id=${row.chat_id} contact_number=${row.contact_number}`);
      }

      await saveMessage(row);

      console.log(
        `[${businessSlug}] ${row.direction} ${msg.key.fromMe ? "from phone " : ""}${row.chat_id}: ${row.message_body}`
      );
    }
  });

  return session;
}

export async function startAllSessions() {
  for (const business of config.businesses) {
    await startSession(business);
  }
}

export function getSessionStatus() {
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
export function findSession(businessSlug: string): Session | undefined {
  const exact = sessions.get(businessSlug);
  if (exact) return exact;
  const lower = businessSlug.toLowerCase();
  for (const [key, session] of sessions) {
    if (key.toLowerCase() === lower) return session;
  }
  return undefined;
}

export function getQrDataUrl(businessSlug: string) {
  return findSession(businessSlug)?.qrDataUrl || null;
}

export async function sendTextMessage(businessSlug: string, to: string, body: string) {
  const session = sessions.get(businessSlug);
  if (!session?.socket || session.status !== "connected") {
    throw new Error(`WhatsApp session ${businessSlug} is not connected`);
  }

  const chatId = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
  const result = await session.socket.sendMessage(chatId, { text: body });

  if (result?.key?.id) session.sentMessageIds.add(result.key.id);

  await saveMessage({
    business_slug: businessSlug,
    whatsapp_message_id: result?.key?.id || null,
    chat_id: chatId,
    contact_number: contactFromChatId(chatId),
    contact_name: null,
    business_contact_name: getBusinessContactName(session, chatId),
    message_body: body,
    message_type: "text",
    media_url: null,
    direction: "outbound",
    timestamp: new Date().toISOString(),
    raw: result || null
  });

  return result;
}

export async function restartSession(businessSlug: string) {
  const session = sessions.get(businessSlug);
  try {
    session?.socket?.end(undefined);
  } catch {}
  return startSession(businessSlug);
}
