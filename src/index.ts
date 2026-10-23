import express from "express";
import cors from "cors";
import path from "path";
import { config } from "./config.js";
import { requireAdmin } from "./auth.js";
import {
  findSession,
  getQrDataUrl,
  getSessionStatus,
  restartSession,
  sendTextMessage,
  startAllSessions
} from "./whatsapp.js";
import { sendScheduledTest, startScheduler, stopScheduler, TestSendInputError } from "./scheduler.js";
import { getAgent, startAgent, stopAgent } from "./agent/index.js";

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

// Same gap as the QR route above: the app calls this JSON path (its default
// RESTART_PATH_TEMPLATE), which never existed — only the HTML
// /admin/restart/:businessSlug route above did. Resolves the slug the same
// case-insensitive way as the QR route, then reuses restartSession() as-is
// (unchanged) on the session's actual stored key, so a differently-cased
// request can't spin up a second session under a new key.
app.post("/api/session/:slug/restart", requireAdmin, async (req, res) => {
  const session = findSession(req.params.slug);
  if (!session) {
    return res.status(404).json({ error: "Unknown session" });
  }
  await restartSession(session.businessSlug);
  res.json({ ok: true });
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

// Single-recipient test for a scheduled message. Same send path and
// classification as scheduled deliveries; `to` must be a chat JID. Pass
// scheduleId to also record the attempt in the schedule's history.
app.post("/api/scheduled-messages/test", requireAdmin, async (req, res) => {
  try {
    const { businessSlug, to, body, scheduleId } = req.body ?? {};

    if (
      typeof businessSlug !== "string" ||
      typeof to !== "string" ||
      typeof body !== "string" ||
      (scheduleId !== undefined && typeof scheduleId !== "string")
    ) {
      return res.status(400).json({ error: "businessSlug, to, and body are required strings" });
    }

    const result = await sendScheduledTest({ businessSlug, to, body, scheduleId });
    const httpStatus = result.status === "sent" ? 200 : result.status === "failed" ? 409 : 502;
    res.status(httpStatus).json({ ok: result.status === "sent", ...result });
  } catch (error) {
    if (error instanceof TestSendInputError) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

app.get("/api/agent/status", requireAdmin, (_req, res) => {
  const agent = getAgent();
  res.json({
    enabled: config.agentEnabled,
    running: Boolean(agent),
    sendEnabled: config.agentSendEnabled,
    ...(agent ? agent.status() : {})
  });
});

// Clears the bridge's local send hold on a chat after a send whose outcome
// was unknown (check the customer's chat first). Takeover/resume is owned by
// the inbox (/admin/ai-agent, or !takeover / !resume in the staff group).
app.post("/api/agent/holds/clear", requireAdmin, (req, res) => {
  const agent = getAgent();
  if (!agent) return res.status(409).json({ error: "Agent is not running" });
  const { businessSlug, chatId } = req.body ?? {};
  if (typeof businessSlug !== "string" || typeof chatId !== "string") {
    return res.status(400).json({ error: "businessSlug and chatId are required strings" });
  }
  res.json({ ok: true, cleared: agent.clearHold(businessSlug, chatId) });
});

app.listen(config.port, async () => {
  console.log(`Devaux WhatsApp service running on port ${config.port}`);
  await startAllSessions();

  if (config.schedulerEnabled) startScheduler();
  const agent = startAgent();

  // Stop claiming new work, let in-flight sends finish, then exit. Only
  // registered when a worker runs, so default signal handling is unchanged
  // otherwise.
  if (config.schedulerEnabled || agent) {
    process.once("SIGTERM", () => {
      void Promise.allSettled([
        config.schedulerEnabled ? stopScheduler() : Promise.resolve(),
        stopAgent()
      ]).finally(() => process.exit(0));
    });
  }
});
