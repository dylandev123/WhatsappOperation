import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  proto,
  downloadMediaMessage
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
};

const logger = P({ level: "info" });
const sessions = new Map<string, Session>();

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
      { logger, reuploadRequest: sessions.get(businessSlug)?.socket?.updateMediaMessage }
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

export async function startSession(businessSlug: string) {
  ensureDir(config.authDir);

  const session: Session = sessions.get(businessSlug) || {
    businessSlug,
    status: "starting"
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
    browser: ["Devaux Operations", "Chrome", "1.0.0"]
  });

  session.socket = socket;

  socket.ev.on("creds.update", saveCreds);

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
      if (msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid || "";
      const messageBody = getTextMessage(msg.message);
      const messageType = getMessageType(msg.message);
      const mediaUrl = await saveMediaIfAny(businessSlug, msg);

      await saveMessage({
        business_slug: businessSlug,
        whatsapp_message_id: msg.key.id,
        chat_id: chatId,
        contact_number: contactFromChatId(chatId),
        contact_name: msg.pushName || null,
        message_body: messageBody,
        message_type: messageType,
        media_url: mediaUrl,
        direction: "inbound",
        timestamp: msg.messageTimestamp
          ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        raw: msg
      });

      console.log(`[${businessSlug}] inbound from ${chatId}: ${messageBody}`);
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

export function getQrDataUrl(businessSlug: string) {
  return sessions.get(businessSlug)?.qrDataUrl || null;
}

export async function sendTextMessage(businessSlug: string, to: string, body: string) {
  const session = sessions.get(businessSlug);
  if (!session?.socket || session.status !== "connected") {
    throw new Error(`WhatsApp session ${businessSlug} is not connected`);
  }

  const chatId = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
  const result = await session.socket.sendMessage(chatId, { text: body });

  await saveMessage({
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

export async function restartSession(businessSlug: string) {
  const session = sessions.get(businessSlug);
  try {
    session?.socket?.end(undefined);
  } catch {}
  return startSession(businessSlug);
}
