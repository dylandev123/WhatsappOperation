import {
  InboxHttpError,
  type AckPayload,
  type AckResult,
  type BusinessConfig,
  type ConfigResponse,
  type ForwardPayload,
  type InboxClient,
  type MessageResponse,
  type MessageStatus,
  type OutboxItem
} from "./types.js";

// HTTP client for the Inbox bridge endpoints (/api/bridge/ai-agent/*),
// authenticated with x-ai-agent-secret. Responses are parsed strictly: a
// malformed body throws, and the caller sends nothing. An outbox item is only
// ever sendable when the Inbox said `send: true` literally.

export const SECRET_HEADER = "x-ai-agent-secret";
const MESSAGE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const STATUSES = new Set<MessageStatus>(["done", "duplicate", "in_progress", "ignored", "error"]);
const DECISIONS = new Set(["REPLY", "ASK", "ESCALATE", "NO_REPLY", "HUMAN"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseOutboxItem(raw: unknown): OutboxItem {
  if (!isObject(raw)) throw new Error("outbox item is not an object");
  const { id, businessSlug, kind, to, body, send, replyToMessageId } = raw;
  if (!nonEmpty(id) || !nonEmpty(businessSlug) || !nonEmpty(kind) || !nonEmpty(to) || typeof body !== "string") {
    throw new Error("outbox item is missing id/businessSlug/kind/to/body");
  }
  return { id, businessSlug, kind, to, body, send: send === true, replyToMessageId: nonEmpty(replyToMessageId) ? replyToMessageId : null };
}

export function parseMessageResponse(raw: unknown): MessageResponse {
  if (!isObject(raw)) throw new Error("message response is not an object");
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status as MessageStatus)) {
    throw new Error(`invalid message status: ${JSON.stringify(raw.status)}`);
  }
  if (!Array.isArray(raw.outbox)) throw new Error("message response has no outbox array");
  const status = raw.status as MessageStatus;
  const outbox = raw.outbox.map(parseOutboxItem);
  return {
    eventId: nonEmpty(raw.eventId) ? raw.eventId : null,
    status,
    decision: typeof raw.decision === "string" && DECISIONS.has(raw.decision) ? (raw.decision as MessageResponse["decision"]) : null,
    reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((r): r is string => typeof r === "string") : [],
    // Contract 3.2 rules 3-4: retries and errors never send, whatever the items say.
    outbox: status === "done" ? outbox : outbox.map((item) => ({ ...item, send: false }))
  };
}

export function parseConfigResponse(raw: unknown): ConfigResponse {
  if (!isObject(raw) || !Array.isArray(raw.businesses)) throw new Error("config response has no businesses array");
  const businesses: BusinessConfig[] = raw.businesses.filter(isObject).flatMap((b) =>
    nonEmpty(b.businessSlug)
      ? [
          {
            businessSlug: b.businessSlug,
            forwardMessages: b.forwardMessages === true,
            mode: typeof b.mode === "string" ? b.mode : "observe",
            staffGroupJid: nonEmpty(b.staffGroupJid) ? b.staffGroupJid : null,
            staffNoticesEnabled: b.staffNoticesEnabled === true,
            ...(nonEmpty(b.ordersGroupJid) ? { ordersGroupJid: b.ordersGroupJid } : {})
          }
        ]
      : []
  );
  const poll = Number(raw.pollOutboxSeconds);
  return { pollOutboxSeconds: Number.isFinite(poll) && poll > 0 ? poll : 10, businesses };
}

// Same idempotency key forwarded again is safe (contract 3.2 rule 4), so
// transport failures and 5xx may be retried; 4xx will not get better.
function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export function createInboxClient(options: { baseUrl: string; secret: string; fetchImpl?: typeof fetch }): InboxClient {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  async function call(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number) {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", [SECRET_HEADER]: options.secret },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new InboxHttpError(`${path}: ${error instanceof Error ? error.message : String(error)}`, null, true);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {}
    return { status: response.status, ok: response.ok, json };
  }

  return {
    async getConfig() {
      const res = await call("GET", "/api/bridge/ai-agent/config", undefined, DEFAULT_TIMEOUT_MS);
      if (!res.ok) throw new InboxHttpError(`config returned ${res.status}`, res.status, retryableStatus(res.status));
      return parseConfigResponse(res.json);
    },

    async forwardMessage(payload: ForwardPayload) {
      const res = await call("POST", "/api/bridge/ai-agent/message", payload, MESSAGE_TIMEOUT_MS);
      if (!res.ok) throw new InboxHttpError(`message returned ${res.status}`, res.status, retryableStatus(res.status));
      try {
        return parseMessageResponse(res.json);
      } catch (error) {
        // The Inbox processed it but we can't read the answer: send nothing.
        throw new InboxHttpError(`message response invalid: ${error instanceof Error ? error.message : error}`, res.status, false);
      }
    },

    async ack(payload: AckPayload): Promise<AckResult> {
      try {
        const res = await call("POST", "/api/bridge/ai-agent/ack", payload, DEFAULT_TIMEOUT_MS);
        if (res.ok) return "ok";
        if (res.status === 400 || res.status === 404 || res.status === 409) return "rejected";
        return "error";
      } catch {
        return "error";
      }
    },

    async claimOutbox(businessSlug: string, limit: number) {
      const res = await call("POST", "/api/bridge/ai-agent/outbox/claim", { businessSlug, limit }, DEFAULT_TIMEOUT_MS);
      if (!res.ok) throw new InboxHttpError(`outbox/claim returned ${res.status}`, res.status, retryableStatus(res.status));
      const items = (res.json as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) throw new InboxHttpError("outbox/claim response has no items array", res.status, false);
      // Claimed items are already 'dispatched': a malformed one is kept as
      // unsendable (so the bridge can ack it failed) rather than failing the
      // whole claim and stranding the valid ones.
      return items.flatMap((raw): OutboxItem[] => {
        try {
          return [parseOutboxItem(raw)];
        } catch {
          const id = isObject(raw) && nonEmpty(raw.id) ? raw.id : null;
          return id ? [{ id, businessSlug, kind: "invalid", to: "", body: "", send: false }] : [];
        }
      });
    }
  };
}
