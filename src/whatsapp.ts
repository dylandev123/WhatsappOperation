import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  proto,
  downloadMediaMessage,
  Contact,
  WAMessageKey
} from "@whiskeysockets/baileys";
import P from "pino";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { Boom } from "@hapi/boom";
import { config } from "./config.js";
import { saveMessage, upsertSessionStatus } from "./supabase.js";
import { contactFromChatId, digitsOnly, getMessageType, getTextMessage, rowContactNumber } from "./messageFields.js";

type Session = {
  businessSlug: string;
  socket?: ReturnType<typeof makeWASocket>;
  qr?: string;
  qrDataUrl?: string;
  status: "starting" | "qr" | "connected" | "disconnected";
  // IDs of messages this service already saved directly, so the
  // messages.upsert echo of that same send (fromMe: true) isn't saved twice.
  // The value records who sent it, so the agent can tell a manual staff send
  // (/api/send) from its own and the scheduler's.
  sentMessageIds: Map<string, SendOrigin>;
  // Guarded sends whose sendMessage() hasn't resolved (or ended ambiguously),
  // keyed by token. An echo that arrives before the id is registered above is
  // matched here by chat + body, so a bot or scheduled send can never be
  // mistaken for a manual message from the phone.
  pendingOwnSends: Map<number, { jid: string; body: string; origin: SendOrigin }>;
  // JID -> device/saved contact name (Baileys Contact.name), from
  // contacts.upsert/contacts.update and the messaging-history.set backfill.
  // Keyed by both contact.id and contact.jid since either may match a
  // message's remoteJid depending on whether it's a @lid or phone-based jid.
  contactNames: Map<string, string>;
  // @lid JID -> phone digits, only from (lid, phone JID) pairs WhatsApp itself
  // reported on one contact event. Never inferred from names or digits.
  lidToPhone: Map<string, string>;
  // Recent group messages by "<group>|<id>", so a staff draft can quote the
  // staff message it answers. In memory only; a miss just sends unquoted.
  recentGroupMessages: Map<string, proto.IWebMessageInfo>;
  // Pending auto-reconnect timer, so a restart (or a second close event) can
  // cancel it instead of racing it into a second startSession().
  reconnectTimer?: NodeJS.Timeout;
};

// Thrown by sendScheduledText when the message provably never reached
// WhatsApp (no session, not connected, invalid JID). Anything else thrown from
// a send is ambiguous: the message may or may not have been delivered.
export class PreSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreSendError";
  }
}

export type SendOrigin = "api" | "scheduled" | "agent";

// Optional observers for the Assisted AI Agent (src/agent). Called only for
// live 'notify' messages, after the row is saved; never for history imports.
// Unset unless AGENT_ENABLED, so existing behavior is unchanged by default.
export type MessageHooks = {
  onLiveMessage(businessSlug: string, msg: proto.IWebMessageInfo, origin: SendOrigin | "phone" | null): Promise<string | void>;
};
let messageHooks: MessageHooks | null = null;

export function setMessageHooks(hooks: MessageHooks | null) {
  messageHooks = hooks;
}

function notifyHooks(businessSlug: string, msg: proto.IWebMessageInfo, origin: SendOrigin | "phone" | null) {
  if (!messageHooks) return;
  void messageHooks.onLiveMessage(businessSlug, msg, origin).then(
    (outcome) => {
      // Every drop reason used to be discarded silently. Ids/reasons only, no bodies.
      if (outcome && outcome !== "queued") console.log(`[${businessSlug}] [agent] not forwarded ${msg.key.id}: ${outcome}`);
    }
  ).catch((err) =>
    console.error(`[${businessSlug}] agent hook failed:`, err instanceof Error ? err.message : err)
  );
}

const SEND_TIMEOUT_MS = 60_000;
const AMBIGUOUS_ECHO_GRACE_MS = 10 * 60_000;
let pendingSendSeq = 0;
const SCHEDULED_JID_PATTERN = /^[^@\s]+@(s\.whatsapp\.net|lid|g\.us)$/;

const logger = P({ level: "info" });
const sessions = new Map<string, Session>();

// Only import messages from the last 2 days on link/relink history sync.
const HISTORY_IMPORT_WINDOW_SECONDS = 2 * 24 * 60 * 60;

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
    const lidJid = contact.lid || (contact.id?.endsWith("@lid") ? contact.id : undefined);
    const phoneJid = contact.jid || (contact.id?.endsWith("@s.whatsapp.net") ? contact.id : undefined);
    if (lidJid?.endsWith("@lid") && phoneJid?.endsWith("@s.whatsapp.net")) {
      const phone = digitsOnly(phoneJid.split("@")[0].split(":")[0]);
      if (phone) session.lidToPhone.set(lidJid, phone);
    }
    if (!contact.name) continue;
    namedCount++;
    // Root cause of business_contact_name never populating: many chats on
    // this account are keyed by the WhatsApp @lid privacy id rather than the
    // phone-based jid (see resolveInboundContactNumber in messageFields.ts), but the saved
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

function takePendingOwnSend(session: Session, msg: proto.IWebMessageInfo): SendOrigin | null {
  const jid = msg.key.remoteJid || "";
  const body = getTextMessage(msg.message).trim();
  if (!jid || !body) return null;
  for (const [token, pending] of session.pendingOwnSends) {
    if (pending.jid === jid && pending.body === body) {
      session.pendingOwnSends.delete(token);
      return pending.origin;
    }
  }
  return null;
}

// An inbound @lid message without senderPn/participantPn gets the phone
// WhatsApp reported for that @lid (contact events), if any, so the saved row and
// the agent payload carry a real number instead of the @lid's own digits.
function addVerifiedPn(session: Session, msg: proto.IWebMessageInfo) {
  const key = msg.key as WAMessageKey;
  const jid = key.remoteJid || "";
  if (key.fromMe || !jid.endsWith("@lid") || key.senderPn || key.participantPn) return;
  const phone = session.lidToPhone.get(jid);
  if (phone) key.senderPn = `${phone}@s.whatsapp.net`;
}

const RECENT_GROUP_MESSAGES = 500;

function rememberGroupMessage(session: Session, msg: proto.IWebMessageInfo) {
  const jid = msg.key.remoteJid || "";
  if (!jid.endsWith("@g.us") || !msg.key.id) return;
  const cache = session.recentGroupMessages;
  cache.set(`${jid}|${msg.key.id}`, msg);
  if (cache.size > RECENT_GROUP_MESSAGES) cache.delete(cache.keys().next().value as string);
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
  const contactNumber = rowContactNumber(msg.key, chatId);
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
    sentMessageIds: new Map(),
    pendingOwnSends: new Map(),
    contactNames: new Map(),
    lidToPhone: new Map(),
    recentGroupMessages: new Map()
  };

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = undefined;
  }

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
    void importHistory(businessSlug, session, messages).catch((err) =>
      console.error(`[${businessSlug}] history import failed:`, err)
    );
  });

  socket.ev.on("connection.update", async (update) => {
    if (!isCurrent()) return;
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
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        session.reconnectTimer = setTimeout(() => {
          session.reconnectTimer = undefined;
          if (!isCurrent()) return;
          startSession(businessSlug).catch(console.error);
        }, 5000);
      }
    }
  });

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!isCurrent()) return;
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;

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

      rememberGroupMessage(session, msg);
      const pendingOrigin = msg.key.fromMe ? takePendingOwnSend(session, msg) : null;
      addVerifiedPn(session, msg);

      const row = await buildMessageRow(businessSlug, session, msg);
      if (!row) continue;

      if (!msg.key.fromMe) {
        console.log(`[${businessSlug}] inbound chat_id=${row.chat_id} contact_number=${row.contact_number}`);
      }

      await saveMessage(row);

      console.log(
        `[${businessSlug}] ${row.direction} ${msg.key.fromMe ? "from phone " : ""}${row.chat_id}: ${row.message_body}`
      );

      notifyHooks(businessSlug, msg, pendingOrigin ?? (msg.key.fromMe ? "phone" : null));
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

// Saves the outbound row and registers the id so the messages.upsert echo of
// this send isn't saved twice. saveMessage() never throws (it logs), so a DB
// failure here can't turn a delivered message into a reported failure.
async function recordOutbound(
  session: Session,
  chatId: string,
  body: string,
  result: Awaited<ReturnType<ReturnType<typeof makeWASocket>["sendMessage"]>>,
  origin: SendOrigin
) {
  if (result?.key?.id) session.sentMessageIds.set(result.key.id, origin);

  await saveMessage({
    business_slug: session.businessSlug,
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
}

export async function sendTextMessage(businessSlug: string, to: string, body: string) {
  const session = sessions.get(businessSlug);
  if (!session?.socket || session.status !== "connected") {
    throw new Error(`WhatsApp session ${businessSlug} is not connected`);
  }

  const chatId = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
  const result = await session.socket.sendMessage(chatId, { text: body });

  await recordOutbound(session, chatId, body, result, "api");
  // Echoes of app sends usually arrive as 'append' (ignored above), so tell
  // the agent directly: a send from the inbox is a manual staff reply.
  if (result?.key) notifyHooks(businessSlug, { key: result.key, message: result.message, messageTimestamp: result.messageTimestamp }, "api");

  return result;
}

export function isSessionConnected(businessSlug: string): boolean {
  const session = findSession(businessSlug);
  return Boolean(session?.socket && session.status === "connected");
}

// Scheduled sends: the recipient is already a chat JID (@s.whatsapp.net, @lid
// or @g.us) and is used exactly as stored. Throws PreSendError when nothing
// could have been sent; any other error means the outcome is unknown.
export async function sendScheduledText(
  businessSlug: string,
  jid: string,
  body: string
): Promise<{ messageId: string }> {
  return sendGuardedText(businessSlug, jid, body, "scheduled");
}

// Same guarded path as scheduled sends, recorded as an agent send.
export async function sendAgentText(
  businessSlug: string,
  jid: string,
  body: string,
  quotedMessageId?: string | null
): Promise<{ messageId: string }> {
  return sendGuardedText(businessSlug, jid, body, "agent", quotedMessageId);
}

async function sendGuardedText(
  businessSlug: string,
  jid: string,
  body: string,
  origin: SendOrigin,
  quotedMessageId?: string | null
): Promise<{ messageId: string }> {
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
  // Group quotes only, and only of a message seen in that same group.
  const quoted = quotedMessageId && jid.endsWith("@g.us") ? session.recentGroupMessages.get(`${jid}|${quotedMessageId}`) : undefined;
  const token = ++pendingSendSeq;
  session.pendingOwnSends.set(token, { jid, body: body.trim(), origin });
  let timer: NodeJS.Timeout | undefined;
  let result: Awaited<ReturnType<typeof socket.sendMessage>>;
  try {
    result = await Promise.race([
      socket.sendMessage(jid, { text: body }, quoted ? { quoted } : undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("send timed out")), SEND_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    // Outcome unknown: a late echo may still arrive, so keep it recognisable.
    setTimeout(() => session.pendingOwnSends.delete(token), AMBIGUOUS_ECHO_GRACE_MS).unref();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
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

export async function restartSession(businessSlug: string) {
  const session = sessions.get(businessSlug);
  if (session?.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = undefined;
  }
  // Detach before ending: startSession() swaps session.socket, and the
  // isCurrent() guards then ignore anything the old socket still emits.
  const oldSocket = session?.socket;
  if (session) session.socket = undefined;
  try {
    oldSocket?.end(undefined);
  } catch {}
  return startSession(businessSlug);
}
