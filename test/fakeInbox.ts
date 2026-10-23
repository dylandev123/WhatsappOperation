import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { configAssisted, errorMissingFields, errorNotConfigured, errorUnauthorized } from "./fixtures/inbox.js";

// An HTTP stand-in for the Inbox's /api/bridge/ai-agent/* routes that
// reproduces their actual semantics, line for line where it matters:
//   auth.ts verifyBridgeSecret      503 when unset, 401 on mismatch
//   message/route.ts                400 validation, 500 on throw
//   decide.ts processBridgeMessage  ignored when disabled, agent-echo drop,
//                                   (slug, messageId) idempotency → duplicate
//                                   with every item send:false, canSend()
//                                   only in assisted mode
//   outbox.ts ackOutbox             404 / idempotent ok / 409 / update
//   outbox.ts claimOutbox           each pending item handed out once
// What the "model" decides is scripted per test via `respond`.

export type OutboxRow = {
  id: string;
  business_slug: string;
  chat_id: string;
  kind: string;
  to_jid: string;
  body: string;
  status: "pending" | "dispatched" | "sent" | "failed";
  whatsapp_message_id: string | null;
  error: string | null;
  event_key: string | null;
};

export type ScriptedItem = { kind: string; to: string; body: string };
export type Scripted = { decision: string; reasons: string[]; items: ScriptedItem[] } | "error" | "throw";
export type Payload = Record<string, unknown> & { businessSlug: string; whatsappMessageId: string; chatId: string; fromMe: boolean; text: string };

export type RecordedRequest = { method: string; path: string; headers: http.IncomingHttpHeaders; body: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FakeInbox {
  secret: string | null;
  config: { pollOutboxSeconds: number; businesses: Array<{ businessSlug: string; forwardMessages: boolean; mode: string; staffGroupJid: string | null }> } =
    structuredClone(configAssisted);
  // Return items even when not in assisted mode, to prove the bridge's own guard.
  misbehaveInObserve = false;
  respond: (payload: Payload, inbox: FakeInbox) => Scripted = () => ({ decision: "NO_REPLY", reasons: ["no_action"], items: [] });
  // Force an HTTP status for a path (e.g. simulate 500s / outages).
  forceStatus = new Map<string, number>();
  outbox: OutboxRow[] = [];
  events = new Map<string, { decision: string | null; reasons: string[] }>();
  requests: RecordedRequest[] = [];
  noticeMessageIds: string[] = [];

  private server = http.createServer((req, res) => void this.handle(req, res));
  url = "";

  constructor(secret: string | null) {
    this.secret = secret;
  }

  async listen() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  calls(path: string) {
    return this.requests.filter((r) => r.path === path);
  }

  queueAdminAnswer(item: { businessSlug: string; kind: string; to: string; body: string }) {
    const row = this.insert(item.businessSlug, item.to, item, "pending", null);
    return row.id;
  }

  private insert(slug: string, chatId: string, item: ScriptedItem, status: OutboxRow["status"], eventKey: string | null): OutboxRow {
    const row: OutboxRow = {
      id: randomUUID(),
      business_slug: slug,
      chat_id: chatId,
      kind: item.kind,
      to_jid: item.to,
      body: item.body.slice(0, 4096),
      status,
      whatsapp_message_id: null,
      error: null,
      event_key: eventKey
    };
    this.outbox.push(row);
    return row;
  }

  private bridgeItem(row: OutboxRow, send: boolean) {
    return { id: row.id, businessSlug: row.business_slug, kind: row.kind, to: row.to_jid, body: row.body, send };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const path = (req.url ?? "").split("?")[0];
    this.requests.push({ method: req.method ?? "", path, headers: req.headers, body });

    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };

    if (!this.secret) return send(503, errorNotConfigured);
    if (req.headers["x-ai-agent-secret"] !== this.secret) return send(401, errorUnauthorized);
    const forced = this.forceStatus.get(path);
    if (forced) return send(forced, { error: "forced" });

    if (path === "/api/bridge/ai-agent/config" && req.method === "GET") return send(200, this.config);
    if (req.method !== "POST") return send(405, { error: "method" });
    if (body === null && raw) return send(400, { error: "Invalid JSON body" });

    if (path === "/api/bridge/ai-agent/message") return this.message(body as Record<string, unknown> | null, send);
    if (path === "/api/bridge/ai-agent/ack") return this.ack(body as Record<string, unknown> | null, send);
    if (path === "/api/bridge/ai-agent/outbox/claim") {
      const b = (body ?? {}) as { businessSlug?: string; limit?: number };
      const limit = typeof b.limit === "number" ? Math.max(1, Math.min(100, Math.floor(b.limit))) : 20;
      const rows = this.outbox
        .filter((r) => r.status === "pending" && (!b.businessSlug || r.business_slug === b.businessSlug))
        .slice(0, limit);
      for (const r of rows) r.status = "dispatched";
      return send(200, { items: rows.map((r) => this.bridgeItem(r, true)) });
    }
    return send(404, { error: "not found" });
  }

  private message(b: Record<string, unknown> | null, send: (s: number, j: unknown) => void) {
    if (!b) return send(400, { error: "Invalid JSON body" });
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const slug = str(b.businessSlug);
    const messageId = str(b.whatsappMessageId);
    const chatId = str(b.chatId);
    if (!slug || !messageId || !chatId) return send(400, errorMissingFields);
    if (typeof b.fromMe !== "boolean") return send(400, { error: "fromMe must be a boolean" });

    const settings = this.config.businesses.find((x) => x.businessSlug === slug);
    const ignored = (reason: string) => send(200, { eventId: null, status: "ignored", decision: "NO_REPLY", reasons: [reason], outbox: [] });
    if (!settings?.forwardMessages) return ignored("agent_disabled");

    const text = typeof b.text === "string" ? b.text : "";
    const isStaffGroup = Boolean(settings.staffGroupJid) && chatId === settings.staffGroupJid;
    if (isStaffGroup || b.fromMe) {
      const echo = this.outbox.some(
        (r) => r.business_slug === slug && (r.whatsapp_message_id === messageId || (text.trim() && r.to_jid === chatId && r.body.trim() === text.trim()))
      );
      if (echo) return ignored("agent_echo");
    }

    const key = `${slug}|${messageId}`;
    const existing = this.events.get(key);
    if (existing) {
      const items = this.outbox.filter((r) => r.event_key === key).map((r) => this.bridgeItem(r, false));
      return send(200, { eventId: key, status: "duplicate", decision: existing.decision, reasons: existing.reasons, outbox: items });
    }
    this.events.set(key, { decision: null, reasons: [] });

    const scripted = this.respond({ ...(b as Payload), businessSlug: slug, chatId, whatsappMessageId: messageId, text }, this);
    if (scripted === "throw") return send(500, { error: "AI agent failed to process the message" });
    if (scripted === "error") {
      this.events.set(key, { decision: null, reasons: ["internal_error"] });
      return send(200, { eventId: key, status: "error", decision: null, reasons: ["internal_error"], outbox: [] });
    }
    this.events.set(key, { decision: scripted.decision, reasons: scripted.reasons });
    const sendable = settings.mode === "assisted" || this.misbehaveInObserve;
    const rows = sendable ? scripted.items.map((i) => this.insert(slug, chatId, i, "dispatched", key)) : [];
    return send(200, {
      eventId: key,
      status: "done",
      decision: scripted.decision,
      reasons: scripted.reasons,
      outbox: rows.map((r) => this.bridgeItem(r, true))
    });
  }

  private ack(b: Record<string, unknown> | null, send: (s: number, j: unknown) => void) {
    if (!b) return send(400, { error: "Invalid JSON body" });
    if (typeof b.outboxId !== "string" || !UUID.test(b.outboxId)) return send(400, { error: "outboxId must be a uuid" });
    if (b.status !== "sent" && b.status !== "failed") return send(400, { error: 'status must be "sent" or "failed"' });
    const row = this.outbox.find((r) => r.id === b.outboxId);
    if (!row) return send(404, { error: "Outbox item not found" });
    if (row.status === b.status) return send(200, { ok: true });
    if (row.status !== "dispatched") return send(409, { error: "Outbox item is not awaiting an ack" });
    row.status = b.status;
    row.whatsapp_message_id = typeof b.whatsappMessageId === "string" ? b.whatsappMessageId : null;
    row.error = typeof b.error === "string" ? b.error : null;
    if (row.status === "sent" && row.kind === "staff_notice" && row.whatsapp_message_id) this.noticeMessageIds.push(row.whatsapp_message_id);
    return send(200, { ok: true });
  }
}
