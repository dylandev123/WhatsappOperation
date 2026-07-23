import express from "express";
import cors from "cors";
import path from "path";
import { config } from "./config.js";
import { requireAdmin } from "./auth.js";
import {
  getQrDataUrl,
  getSessionStatus,
  restartSession,
  sendTextMessage,
  startAllSessions
} from "./whatsapp.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use("/media", express.static(path.resolve(config.mediaDir)));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "devaux-whatsapp" });
});

app.get("/admin", requireAdmin, (_req, res) => {
  const statuses = getSessionStatus();

  const cards = statuses.map((s) => {
    const qrUrl = `/admin/qr/${s.businessSlug}?secret=${encodeURIComponent(config.adminSecret)}`;
    return `
      <div style="border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0;">
        <h2>${s.businessSlug}</h2>
        <p>Status: <strong>${s.status}</strong></p>
        <p>QR available: ${s.hasQr ? "yes" : "no"}</p>
        <p><a href="${qrUrl}">Open QR</a></p>
        <form method="post" action="/admin/restart/${s.businessSlug}?secret=${encodeURIComponent(config.adminSecret)}">
          <button type="submit">Restart Session</button>
        </form>
      </div>
    `;
  }).join("");

  res.send(`
    <!doctype html>
    <html>
      <head>
        <title>Devaux WhatsApp Admin</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 16px;">
        <h1>Devaux WhatsApp Admin</h1>
        <p>Scan each QR code with the correct business phone.</p>
        ${cards}
      </body>
    </html>
  `);
});

app.get("/admin/qr/:businessSlug", requireAdmin, (req, res) => {
  const businessSlug = req.params.businessSlug;
  const qr = getQrDataUrl(businessSlug);

  if (!qr) {
    return res.send(`
      <body style="font-family: Arial, sans-serif;">
        <h1>${businessSlug}</h1>
        <p>No QR available. The session may already be connected or still starting.</p>
        <p><a href="/admin?secret=${encodeURIComponent(config.adminSecret)}">Back</a></p>
      </body>
    `);
  }

  res.send(`
    <body style="font-family: Arial, sans-serif; text-align:center;">
      <h1>${businessSlug}</h1>
      <img src="${qr}" style="width:320px;height:320px;" />
      <p>Open WhatsApp on the correct phone → Linked Devices → Link a Device.</p>
      <p><a href="/admin?secret=${encodeURIComponent(config.adminSecret)}">Back</a></p>
    </body>
  `);
});

app.post("/admin/restart/:businessSlug", requireAdmin, async (req, res) => {
  await restartSession(req.params.businessSlug);
  res.redirect(`/admin?secret=${encodeURIComponent(config.adminSecret)}`);
});

app.get("/api/status", requireAdmin, (_req, res) => {
  res.json({ sessions: getSessionStatus() });
});

// The app's lib/server/whatsappBridge.ts calls this path (its default
// QR_PATH_TEMPLATE) expecting JSON — distinct from the /admin/qr/:businessSlug
// HTML page above, which existed but was never the route the app called.
app.get("/api/session/:slug/qr", requireAdmin, (req, res) => {
  const qr = getQrDataUrl(req.params.slug);
  if (!qr) {
    return res.status(404).json({
      error: "No QR available. The session may already be connected or still starting."
    });
  }
  res.json({ qr });
});

app.post("/api/send", requireAdmin, async (req, res) => {
  try {
    const { businessSlug, to, body } = req.body;

    if (!businessSlug || !to || !body) {
      return res.status(400).json({
        error: "businessSlug, to, and body are required"
      });
    }

    const result = await sendTextMessage(businessSlug, to, body);
    res.json({ ok: true, messageId: result?.key?.id || null });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

app.listen(config.port, async () => {
  console.log(`Devaux WhatsApp service running on port ${config.port}`);
  await startAllSessions();
});
