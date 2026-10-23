"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECRET_HEADER = void 0;
exports.parseOutboxItem = parseOutboxItem;
exports.parseMessageResponse = parseMessageResponse;
exports.parseConfigResponse = parseConfigResponse;
exports.createInboxClient = createInboxClient;
const types_js_1 = require("./types.js");
// HTTP client for the Inbox bridge endpoints (/api/bridge/ai-agent/*),
// authenticated with x-ai-agent-secret. Responses are parsed strictly: a
// malformed body throws, and the caller sends nothing. An outbox item is only
// ever sendable when the Inbox said `send: true` literally.
exports.SECRET_HEADER = "x-ai-agent-secret";
const MESSAGE_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const STATUSES = new Set(["done", "duplicate", "in_progress", "ignored", "error"]);
const DECISIONS = new Set(["REPLY", "ASK", "ESCALATE", "NO_REPLY", "HUMAN"]);
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function nonEmpty(value) {
    return typeof value === "string" && value.length > 0;
}
function parseOutboxItem(raw) {
    if (!isObject(raw))
        throw new Error("outbox item is not an object");
    const { id, businessSlug, kind, to, body, send } = raw;
    if (!nonEmpty(id) || !nonEmpty(businessSlug) || !nonEmpty(kind) || !nonEmpty(to) || typeof body !== "string") {
        throw new Error("outbox item is missing id/businessSlug/kind/to/body");
    }
    return { id, businessSlug, kind, to, body, send: send === true };
}
function parseMessageResponse(raw) {
    if (!isObject(raw))
        throw new Error("message response is not an object");
    if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) {
        throw new Error(`invalid message status: ${JSON.stringify(raw.status)}`);
    }
    if (!Array.isArray(raw.outbox))
        throw new Error("message response has no outbox array");
    const status = raw.status;
    const outbox = raw.outbox.map(parseOutboxItem);
    return {
        eventId: nonEmpty(raw.eventId) ? raw.eventId : null,
        status,
        decision: typeof raw.decision === "string" && DECISIONS.has(raw.decision) ? raw.decision : null,
        reasons: Array.isArray(raw.reasons) ? raw.reasons.filter((r) => typeof r === "string") : [],
        // Contract 3.2 rules 3-4: retries and errors never send, whatever the items say.
        outbox: status === "done" ? outbox : outbox.map((item) => ({ ...item, send: false }))
    };
}
function parseConfigResponse(raw) {
    if (!isObject(raw) || !Array.isArray(raw.businesses))
        throw new Error("config response has no businesses array");
    const businesses = raw.businesses.filter(isObject).flatMap((b) => nonEmpty(b.businessSlug)
        ? [
            {
                businessSlug: b.businessSlug,
                forwardMessages: b.forwardMessages === true,
                mode: typeof b.mode === "string" ? b.mode : "observe",
                staffGroupJid: nonEmpty(b.staffGroupJid) ? b.staffGroupJid : null
            }
        ]
        : []);
    const poll = Number(raw.pollOutboxSeconds);
    return { pollOutboxSeconds: Number.isFinite(poll) && poll > 0 ? poll : 10, businesses };
}
// Same idempotency key forwarded again is safe (contract 3.2 rule 4), so
// transport failures and 5xx may be retried; 4xx will not get better.
function retryableStatus(status) {
    return status >= 500 || status === 408 || status === 429;
}
function createInboxClient(options) {
    const doFetch = options.fetchImpl ?? fetch;
    const base = options.baseUrl.replace(/\/+$/, "");
    async function call(method, path, body, timeoutMs) {
        let response;
        try {
            response = await doFetch(`${base}${path}`, {
                method,
                headers: { "Content-Type": "application/json", [exports.SECRET_HEADER]: options.secret },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
        }
        catch (error) {
            throw new types_js_1.InboxHttpError(`${path}: ${error instanceof Error ? error.message : String(error)}`, null, true);
        }
        let json = null;
        try {
            json = await response.json();
        }
        catch { }
        return { status: response.status, ok: response.ok, json };
    }
    return {
        async getConfig() {
            const res = await call("GET", "/api/bridge/ai-agent/config", undefined, DEFAULT_TIMEOUT_MS);
            if (!res.ok)
                throw new types_js_1.InboxHttpError(`config returned ${res.status}`, res.status, retryableStatus(res.status));
            return parseConfigResponse(res.json);
        },
        async forwardMessage(payload) {
            const res = await call("POST", "/api/bridge/ai-agent/message", payload, MESSAGE_TIMEOUT_MS);
            if (!res.ok)
                throw new types_js_1.InboxHttpError(`message returned ${res.status}`, res.status, retryableStatus(res.status));
            try {
                return parseMessageResponse(res.json);
            }
            catch (error) {
                // The Inbox processed it but we can't read the answer: send nothing.
                throw new types_js_1.InboxHttpError(`message response invalid: ${error instanceof Error ? error.message : error}`, res.status, false);
            }
        },
        async ack(payload) {
            try {
                const res = await call("POST", "/api/bridge/ai-agent/ack", payload, DEFAULT_TIMEOUT_MS);
                if (res.ok)
                    return "ok";
                if (res.status === 400 || res.status === 404 || res.status === 409)
                    return "rejected";
                return "error";
            }
            catch {
                return "error";
            }
        },
        async claimOutbox(businessSlug, limit) {
            const res = await call("POST", "/api/bridge/ai-agent/outbox/claim", { businessSlug, limit }, DEFAULT_TIMEOUT_MS);
            if (!res.ok)
                throw new types_js_1.InboxHttpError(`outbox/claim returned ${res.status}`, res.status, retryableStatus(res.status));
            const items = res.json?.items;
            if (!Array.isArray(items))
                throw new types_js_1.InboxHttpError("outbox/claim response has no items array", res.status, false);
            // Claimed items are already 'dispatched': a malformed one is kept as
            // unsendable (so the bridge can ack it failed) rather than failing the
            // whole claim and stranding the valid ones.
            return items.flatMap((raw) => {
                try {
                    return [parseOutboxItem(raw)];
                }
                catch {
                    const id = isObject(raw) && nonEmpty(raw.id) ? raw.id : null;
                    return id ? [{ id, businessSlug, kind: "invalid", to: "", body: "", send: false }] : [];
                }
            });
        }
    };
}
