"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const config_js_1 = require("./config.js");
const auth_js_1 = require("./auth.js");
const whatsapp_js_1 = require("./whatsapp.js");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: "10mb" }));
app.use("/media", express_1.default.static(path_1.default.resolve(config_js_1.config.mediaDir)));
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "devaux-whatsapp" });
});
app.get("/admin", auth_js_1.requireAdmin, (_req, res) => {
    const statuses = (0, whatsapp_js_1.getSessionStatus)();
    const cards = statuses.map((s) => {
        const qrUrl = `/admin/qr/${s.businessSlug}?secret=${encodeURIComponent(config_js_1.config.adminSecret)}`;
        return `
      <div style="border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0;">
        <h2>${s.businessSlug}</h2>
        <p>Status: <strong>${s.status}</strong></p>
        <p>QR available: ${s.hasQr ? "yes" : "no"}</p>
        <p><a href="${qrUrl}">Open QR</a></p>
        <form method="post" action="/admin/restart/${s.businessSlug}?secret=${encodeURIComponent(config_js_1.config.adminSecret)}">
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
app.get("/admin/qr/:businessSlug", auth_js_1.requireAdmin, (req, res) => {
    const businessSlug = req.params.businessSlug;
    const qr = (0, whatsapp_js_1.getQrDataUrl)(businessSlug);
    if (!qr) {
        return res.send(`
      <body style="font-family: Arial, sans-serif;">
        <h1>${businessSlug}</h1>
        <p>No QR available. The session may already be connected or still starting.</p>
        <p><a href="/admin?secret=${encodeURIComponent(config_js_1.config.adminSecret)}">Back</a></p>
      </body>
    `);
    }
    res.send(`
    <body style="font-family: Arial, sans-serif; text-align:center;">
      <h1>${businessSlug}</h1>
      <img src="${qr}" style="width:320px;height:320px;" />
      <p>Open WhatsApp on the correct phone → Linked Devices → Link a Device.</p>
      <p><a href="/admin?secret=${encodeURIComponent(config_js_1.config.adminSecret)}">Back</a></p>
    </body>
  `);
});
app.post("/admin/restart/:businessSlug", auth_js_1.requireAdmin, async (req, res) => {
    await (0, whatsapp_js_1.restartSession)(req.params.businessSlug);
    res.redirect(`/admin?secret=${encodeURIComponent(config_js_1.config.adminSecret)}`);
});
app.get("/api/status", auth_js_1.requireAdmin, (_req, res) => {
    res.json({ sessions: (0, whatsapp_js_1.getSessionStatus)() });
});
// The app's lib/server/whatsappBridge.ts calls this path (its default
// QR_PATH_TEMPLATE) expecting JSON — distinct from the /admin/qr/:businessSlug
// HTML page above, which existed but was never the route the app called.
app.get("/api/session/:slug/qr", auth_js_1.requireAdmin, (req, res) => {
    const qr = (0, whatsapp_js_1.getQrDataUrl)(req.params.slug);
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
app.post("/api/session/:slug/restart", auth_js_1.requireAdmin, async (req, res) => {
    const session = (0, whatsapp_js_1.findSession)(req.params.slug);
    if (!session) {
        return res.status(404).json({ error: "Unknown session" });
    }
    await (0, whatsapp_js_1.restartSession)(session.businessSlug);
    res.json({ ok: true });
});
app.post("/api/send", auth_js_1.requireAdmin, async (req, res) => {
    try {
        const { businessSlug, to, body } = req.body;
        if (!businessSlug || !to || !body) {
            return res.status(400).json({
                error: "businessSlug, to, and body are required"
            });
        }
        const result = await (0, whatsapp_js_1.sendTextMessage)(businessSlug, to, body);
        res.json({ ok: true, messageId: result?.key?.id || null });
    }
    catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : "Unknown error"
        });
    }
});
app.listen(config_js_1.config.port, async () => {
    console.log(`Devaux WhatsApp service running on port ${config_js_1.config.port}`);
    await (0, whatsapp_js_1.startAllSessions)();
});
