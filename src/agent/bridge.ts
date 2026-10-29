import type { proto } from "@whiskeysockets/baileys";
import type { Journal, OutboxEntry, ForwardEntry, ForwardRole } from "./journal.js";
import { classifyMessage } from "./messages.js";
import {
  InboxHttpError,
  NotSentError,
  type AgentConfig,
  type BusinessConfig,
  type CallReportPayload,
  type ConfigResponse,
  type InboxClient,
  type OutboxItem,
  type Sender
} from "./types.js";

// The WhatsappOperation side of the Inbox AI agent (contract:
// devaux-whatsapp-inbox/docs/ai-agent-bridge-contract.md). The Inbox decides
// everything — eligibility, replies, escalations (#E-XXXXX), staff commands,
// takeover, order requests, audit. This bridge only:
//   1. forwards live messages to /message (never history imports, scheduled
//      sends or its own sends), batching a customer's burst by holding it for
//      an inactivity window and forwarding it in order;
//   2. sends returned `send: true` items verbatim, after transport-level
//      checks that can only ever block a send (never add or change one);
//   3. acks every attempted item with its true outcome.
// A send whose outcome is unknown is NOT acked: the item stays 'dispatched'
// in the Inbox (unconfirmed, and still counted toward its reply rate limit),
// and the chat is held locally so no further AI messages go to it.
//
// Logs carry ids, kinds and statuses — never message bodies.

export type LiveOrigin = "api" | "scheduled" | "agent" | "phone" | null;

const MAX_BODY_LENGTH = 4096; // the Inbox truncates outbox bodies to this
const CLAIM_LIMIT = 20;
const MAX_ACK_ATTEMPTS = 30;
const DIRECT_JID = /^[^@\s]+@(s\.whatsapp\.net|lid)$/;
const DAY_MS = 24 * 60 * 60_000;
const UNKNOWN_RETENTION_MS = 7 * DAY_MS;

// Kinds a human wrote. Everything else sent to a customer — including kinds
// this bridge doesn't know yet — is treated as AI-generated and gated.
const HUMAN_AUTHORED_KINDS = new Set(["staff_relay"]);

// Kinds addressed to the staff group, never to a customer, in any mode.
const STAFF_GROUP_KINDS = new Set(["staff_notice", "staff_draft", "staff_feedback"]);
// The only kinds Observe mode may send (and only to the staff group).
const OBSERVE_KINDS = new Set(["staff_notice", "staff_draft"]);
// Approval Pilot: the AI never sends on its own. Staff-group kinds, plus staff_relay — a reply an explicitly
// authorized staff member approved (!approve / !send / the dashboard button). Nothing else, whatever `send` says.
const ORDERS_GROUP_KINDS = new Set(["staff_notice", "staff_feedback"]);
const ORDERS_GROUP_OBSERVE_KINDS = new Set(["staff_notice"]);
const PILOT_KINDS = new Set([...STAFF_GROUP_KINDS, "staff_relay"]);

// Defense in depth on top of the Inbox's own reply safety checks: an AI reply
// that reads as an unapproved commitment is not sent.
const COMMITMENT_PATTERNS = [
  /\border\s+(is\s+|has\s+been\s+)?confirmed\b/i,
  /\bconfirm(ed)?\s+your\s+(order|booking|delivery|payment)\b/i,
  /\bpayment\s+(has\s+been\s+|was\s+|is\s+)?(received|confirmed)\b/i,
  /\bwe('ve|\s+have)\s+received\s+your\s+payment\b/i,
  /\bout\s+for\s+delivery\b/i,
  /\b(has|have)\s+been\s+(delivered|shipped|dispatched)\b/i,
  /\b(booking|delivery|reservation)\s+(is\s+)?confirmed\b/i
];

export type BridgeDeps = {
  inbox: InboxClient;
  sender: Sender;
  journal: Journal;
  config: AgentConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

const chatKey = (businessSlug: string, chatId: string) => `${businessSlug}|${chatId}`;

export class AgentBridge {
  private readonly inbox: InboxClient;
  private readonly sender: Sender;
  private readonly journal: Journal;
  private readonly config: AgentConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;

  private inboxConfig: ConfigResponse | null = null;
  private inboxConfigAt = 0;
  private configLoad: Promise<void> | null = null;
  private recovered = false;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private currentTick: Promise<void> | null = null;

  constructor(deps: BridgeDeps) {
    this.inbox = deps.inbox;
    this.sender = deps.sender;
    this.journal = deps.journal;
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = deps.log ?? ((message) => console.log(`[agent] ${message}`));
  }

  private get state() {
    return this.journal.state;
  }

  // ── Inbox config (/config, cached) ─────────────────────────────────────

  private async refreshConfig(force = false): Promise<void> {
    if (!force && this.inboxConfig && this.now() - this.inboxConfigAt < this.config.configTtlMs) return;
    this.configLoad ??= this.inbox
      .getConfig()
      .then((cfg) => {
        this.inboxConfig = cfg;
        this.inboxConfigAt = this.now();
      })
      .catch((error) => this.log(`config refresh failed (keeping last known): ${errorText(error)}`))
      .finally(() => {
        this.configLoad = null;
      });
    await this.configLoad;
  }

  // null = never loaded or business unknown: forward nothing, send nothing.
  private async businessConfig(businessSlug: string, force = false): Promise<BusinessConfig | null> {
    await this.refreshConfig(force);
    return this.inboxConfig?.businesses.find((b) => b.businessSlug === businessSlug) ?? null;
  }

  // ── Ingest (live messages.upsert / app sends only) ────────────────────

  async onLiveMessage(businessSlug: string, msg: proto.IWebMessageInfo, origin: LiveOrigin): Promise<string> {
    if (!this.config.enabled) return "agent_disabled";
    // Our own outbox sends and scheduled messages are never human activity
    // (contract 3.2: "Do not forward messages the bridge itself sent").
    if (origin === "agent" || origin === "scheduled") return "bridge_send";

    const classified = classifyMessage(msg);
    if (classified.kind === "ignore") return classified.reason;

    const business = await this.businessConfig(businessSlug);
    if (!business?.forwardMessages) return "not_forwarding";

    const payload = { ...classified.payload, businessSlug };
    let role: ForwardRole;
    if (classified.kind === "group") {
      const inStaffGroup = Boolean(business.staffGroupJid) && payload.chatId === business.staffGroupJid;
      const inOrdersGroup = Boolean(business.ordersGroupJid) && payload.chatId === business.ordersGroupJid;
      const inRoutedGroup = (business.routedGroupJids ?? []).includes(payload.chatId);
      if (!inStaffGroup && !inOrdersGroup && !inRoutedGroup) return "not_staff_group";
      role = "staff_group";
    } else if (payload.fromMe) {
      role = "human"; // business phone or the inbox's /api/send
    } else {
      // Offline catch-up delivered as 'notify' long after it was sent: not
      // answered automatically (staff still see it in the inbox).
      if (this.now() - Date.parse(payload.timestamp) > this.config.maxMessageAgeMs) return "too_old";
      role = "customer";
    }

    const key = `${businessSlug}|${payload.whatsappMessageId}`;
    if (this.state.forwarded[key] || this.state.forwards.some((f) => f.key === key)) return "duplicate";

    const chat = chatKey(businessSlug, payload.chatId);
    // Strictly increasing per chat, so "newer message" is never a tie.
    const at = Math.max(this.now(), (this.state.customerActivity[chat] ?? 0) + 1);
    if (role === "human") this.state.humanActivity[chat] = at;
    if (role === "customer") this.state.customerActivity[chat] = at;
    this.state.forwards.push({ key, role, payload, receivedAt: at, attempts: 0, nextAttemptAt: at });
    this.journal.save();
    return "queued";
  }

  // ── Calls ──────────────────────────────────────────────────────────────

  // One finished call (calls.ts). Reported only while the Inbox's last config says the missed-call rule is on; the Inbox decides
  // everything and answers with at most one missed_call_reply, which goes through the same guarded send as every other item.
  // A failed report is not retried: a missed call is only answered while it is fresh.
  async onCallReport(businessSlug: string, report: Omit<CallReportPayload, "businessSlug">): Promise<string> {
    if (!this.config.enabled) return "agent_disabled";
    const business = await this.businessConfig(businessSlug);
    if (!business?.forwardMessages) return "not_forwarding";
    if (business.missedCallsEnabled !== true) return "missed_calls_disabled";
    let response;
    try {
      response = await this.inbox.reportCall({ ...report, businessSlug });
    } catch (error) {
      this.log(`call report ${report.callId} failed: ${errorText(error)}`);
      return "report_failed";
    }
    const fresh = response.outbox.filter((item) => item.send && item.kind === "missed_call_reply" && !this.state.outbox[item.id]).map((item) => this.record(item, "message", null));
    this.journal.save();
    this.log(`call ${report.callId} (${report.finalStatus}): ${response.status} items=${fresh.length}`);
    for (const item of fresh) await this.deliver(item);
    return fresh.length > 0 ? "replied" : "reported";
  }

  // ── Worker ─────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.recovered) this.recoverAfterRestart();
    await this.refreshConfig();
    await this.retryAcks();
    await this.processForwards();
    await this.deliverQueued();
    await this.claimOutbox();
    this.prune();
  }

  // 'sending' at startup = the process died between the socket call and
  // recording its result. The message may have gone out: never resend, never
  // ack (the Inbox keeps it 'dispatched' = unconfirmed), hold the chat.
  private recoverAfterRestart() {
    this.recovered = true;
    let changed = false;
    for (const entry of Object.values(this.state.outbox)) {
      if (entry.state !== "sending") continue;
      this.markUnknown(entry, "process restarted mid-send; outcome unknown");
      changed = true;
    }
    if (changed) this.journal.save();
  }

  private async processForwards() {
    const byChat = new Map<string, ForwardEntry[]>();
    for (const entry of [...this.state.forwards].sort((a, b) => a.receivedAt - b.receivedAt)) {
      const key = chatKey(entry.payload.businessSlug, entry.payload.chatId);
      byChat.set(key, [...(byChat.get(key) ?? []), entry]);
    }

    const readyBefore = this.now() - this.config.batchWindowMs;
    for (const entries of byChat.values()) {
      if (this.stopping) return;
      const { businessSlug } = entries[0].payload;
      // Replies would have nowhere to go; keep the burst queued until reconnect.
      if (!this.sender.isConnected(businessSlug)) continue;
      // A burst is forwarded once the customer has been quiet for the window;
      // a human or staff-group message flushes the chat immediately.
      const urgent = entries.some((e) => e.role !== "customer");
      const newestCustomer = Math.max(0, ...entries.filter((e) => e.role === "customer").map((e) => e.receivedAt));
      if (!urgent && newestCustomer > readyBefore) continue;

      for (const entry of entries) {
        if (this.stopping) return;
        if (entry.nextAttemptAt > this.now()) break; // keep the chat's order
        if ((await this.forward(entry)) === "retry") break;
      }
    }
  }

  private finishForward(entry: ForwardEntry) {
    this.state.forwards = this.state.forwards.filter((f) => f.key !== entry.key);
    this.state.forwarded[entry.key] = this.now();
  }

  private async forward(entry: ForwardEntry): Promise<"done" | "retry" | "dropped"> {
    let response;
    try {
      response = await this.inbox.forwardMessage(entry.payload);
    } catch (error) {
      entry.attempts += 1;
      const retryable = !(error instanceof InboxHttpError) || error.retryable;
      if (retryable && entry.attempts < this.config.maxForwardAttempts) {
        entry.nextAttemptAt = this.now() + Math.min(60_000, 2_000 * 2 ** entry.attempts);
        this.journal.save();
        this.log(`forward ${entry.payload.whatsappMessageId} failed (attempt ${entry.attempts}), will retry: ${errorText(error)}`);
        return "retry";
      }
      // Fail closed: nothing is sent for this message.
      this.finishForward(entry);
      this.journal.save();
      this.log(`forward ${entry.payload.whatsappMessageId} dropped after ${entry.attempts} attempt(s): ${errorText(error)}`);
      return "dropped";
    }

    this.finishForward(entry);
    const fresh: OutboxEntry[] = [];
    // Only a fresh 'done' can carry send: true (duplicate / in_progress /
    // error / ignored are forced to send: false by the parser).
    for (const item of response.outbox) {
      if (!item.send || this.state.outbox[item.id]) continue;
      fresh.push(this.record(item, "message", entry.role === "customer" ? entry.receivedAt : null));
    }
    this.journal.save();
    this.log(
      `forwarded ${entry.role} ${entry.payload.whatsappMessageId}: ${response.status}` +
        ` ${response.decision ?? "-"} items=${fresh.length}`
    );
    for (const item of fresh) await this.deliver(item);
    return "done";
  }

  private record(item: OutboxItem, source: OutboxEntry["source"], triggerReceivedAt: number | null): OutboxEntry {
    const entry: OutboxEntry = {
      id: item.id,
      businessSlug: item.businessSlug,
      kind: item.kind,
      to: item.to,
      body: item.body,
      replyToMessageId: item.replyToMessageId ?? null,
      source,
      triggerReceivedAt,
      createdAt: this.now(),
      state: "queued",
      sendingAt: null,
      settledAt: null,
      whatsappMessageId: null,
      error: null,
      ack: "pending",
      ackAttempts: 0
    };
    this.state.outbox[item.id] = entry;
    return entry;
  }

  // Items recorded but not yet attempted (e.g. a restart between /message and
  // the send). They never left the bridge, so sending them is not a resend.
  private async deliverQueued() {
    const queued = Object.values(this.state.outbox)
      .filter((e) => e.state === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const entry of queued) {
      if (this.stopping) return;
      await this.deliver(entry);
    }
  }

  private async claimOutbox() {
    if (!this.config.sendEnabled) return; // leave admin answers 'pending' in the Inbox
    const pollMs = (this.inboxConfig?.pollOutboxSeconds ?? 10) * 1000;
    for (const business of this.inboxConfig?.businesses ?? []) {
      if (this.stopping) return;
      // Claim only what this bridge can send right now: a claimed item is
      // never handed out again.
      // Observe is polled only for staff-group items (batched escalation
      // notices); the Inbox hands out just what the current mode permits.
      if (!business.forwardMessages) continue;
      const observeStaffOnly = business.mode === "observe" && business.staffNoticesEnabled && Boolean(business.staffGroupJid || business.ordersGroupJid || business.routedGroupJids?.length);
      // Approval Pilot is polled for approved sends and staff-group posts; the Inbox hands out only what its mode permits.
      if (business.mode !== "assisted" && business.mode !== "approval_pilot" && !observeStaffOnly) continue;
      if (!this.sender.isConnected(business.businessSlug)) continue;
      if (this.now() - (this.state.lastClaimAt[business.businessSlug] ?? 0) < pollMs) continue;
      this.state.lastClaimAt[business.businessSlug] = this.now();

      let items: OutboxItem[];
      try {
        items = await this.inbox.claimOutbox(business.businessSlug, CLAIM_LIMIT);
      } catch (error) {
        this.log(`outbox claim failed for ${business.businessSlug}: ${errorText(error)}`);
        continue;
      }
      const fresh = items.filter((item) => !this.state.outbox[item.id]).map((item) => this.record(item, "claim", null));
      this.journal.save();
      for (const entry of fresh) {
        if (!items.find((i) => i.id === entry.id)?.send) await this.settle(entry, "failed", null, "invalid_outbox_item");
        else await this.deliver(entry);
      }
    }
  }

  // ── Sending ────────────────────────────────────────────────────────────

  // Why this item must not be sent right now, or null. Checks only ever
  // block; the bridge never alters or adds text.
  private async blockReason(entry: OutboxEntry): Promise<string | null> {
    if (!this.config.enabled) return "agent_disabled";
    if (!this.config.sendEnabled) return "bridge_send_disabled";
    let business = await this.businessConfig(entry.businessSlug);
    if (!business) return "bridge_config_unavailable";
    // Observe mode may send ONE kind of thing: a staff_notice or staff_draft to
    // the staff group, and only when the Inbox has switched staff notices on for
    // this business. Every other kind (customer replies, holding replies, relays,
    // feedback, kinds this bridge has never heard of) is blocked, whatever
    // `send` says.
    const observing = business.mode === "observe";
    const pilot = business.mode === "approval_pilot";
    if (pilot) {
      // Approval Pilot: only PILOT_KINDS, and a staff_relay only to a customer — never into the staff group.
      // (A missed_call_reply is the admin's own fixed text for a caller, switched on explicitly in the Inbox; checked below.)
      if (!PILOT_KINDS.has(entry.kind) && entry.kind !== "missed_call_reply") return "approval_pilot_mode";
      if (entry.kind === "staff_relay" && entry.to.endsWith("@g.us")) return "approval_pilot_mode";
    } else if (business.mode !== "assisted") {
      if (!observing || !OBSERVE_KINDS.has(entry.kind)) return "observe_mode";
      if (!business.staffNoticesEnabled) return "staff_notices_disabled";
    }
    if (!this.sender.isConnected(entry.businessSlug)) return "session_disconnected";
    // The missed-call reply needs the rule to be on in the Inbox's last config, whatever `send` says.
    if (entry.kind === "missed_call_reply" && business.missedCallsEnabled !== true) return "missed_calls_disabled";
    const body = entry.body ?? "";
    if (!body.trim() || body.length > MAX_BODY_LENGTH) return "invalid_body";
    // Staff-group kinds never reach a customer chat, in any mode.
    if ((observing || STAFF_GROUP_KINDS.has(entry.kind)) && !entry.to.endsWith("@g.us")) return "not_staff_group";

    // A missed-call reply is for the person who called: never into a group, in any mode.
    if (entry.kind === "missed_call_reply" && !DIRECT_JID.test(entry.to)) return "invalid_recipient";
    if (entry.to.endsWith("@g.us")) {
      const isRouted = (b: BusinessConfig) => (b.routedGroupJids ?? []).includes(entry.to);
      if (entry.to !== business.staffGroupJid && entry.to !== business.ordersGroupJid && !isRouted(business)) business = await this.businessConfig(entry.businessSlug, true);
      if (!business) return "not_staff_group";
      if (entry.to !== business.staffGroupJid) {
        if (isRouted(business)) {
          // A Rules & Routing group is a staff group: the staff-group kinds only, never a relay or a customer kind.
          if (!STAFF_GROUP_KINDS.has(entry.kind)) return "not_staff_group";
        } else {
          // The separate Orders group takes the order summary and refusals to "!update" only: never drafts or relays.
          const ordersKinds = observing ? ORDERS_GROUP_OBSERVE_KINDS : ORDERS_GROUP_KINDS;
          if (!business.ordersGroupJid || entry.to !== business.ordersGroupJid || !ordersKinds.has(entry.kind)) return "not_staff_group";
        }
      }
      if (observing || pilot) {
        // Flood guard for Observe / Approval Pilot staff-group posts (not counted as AI replies below).
        const minuteAgo = this.now() - 60_000;
        const groupKinds = observing ? OBSERVE_KINDS : STAFF_GROUP_KINDS;
        const recent = Object.values(this.state.outbox).filter(
          (e) => e.businessSlug === entry.businessSlug && groupKinds.has(e.kind) && e.sendingAt !== null && e.sendingAt >= minuteAgo
        );
        if (recent.length >= this.config.maxBusinessSendsPerMinute) return "business_rate_limited";
      }
      return null;
    }
    if (!DIRECT_JID.test(entry.to)) return "invalid_recipient";
    if (HUMAN_AUTHORED_KINDS.has(entry.kind)) {
      // An approved pilot send still respects a hold after a send whose outcome is unknown.
      if (pilot) {
        const held = this.state.holds[chatKey(entry.businessSlug, entry.to)];
        if (held && held.until > this.now()) return "held_after_unknown_send";
      }
      return null;
    }

    // AI-generated message to a customer.
    const chat = chatKey(entry.businessSlug, entry.to);
    const hold = this.state.holds[chat];
    if (hold && hold.until > this.now()) return "held_after_unknown_send";
    if (entry.triggerReceivedAt !== null) {
      // A human wrote in this chat after the message being answered.
      if ((this.state.humanActivity[chat] ?? -1) >= entry.triggerReceivedAt) return "human_takeover";
      if (this.now() - entry.triggerReceivedAt > this.config.maxMessageAgeMs) return "stale_reply";
      // Batching: the customer kept typing; the reply to their latest
      // message (which sees these ones in its transcript) answers instead.
      if (entry.kind === "customer_reply" && (this.state.customerActivity[chat] ?? -1) > entry.triggerReceivedAt) {
        return "superseded_by_newer_message";
      }
    }
    if (entry.kind === "customer_reply" && COMMITMENT_PATTERNS.some((p) => p.test(body))) return "unapproved_commitment";

    const aiSends = Object.values(this.state.outbox).filter(
      (e) => e.businessSlug === entry.businessSlug && e.sendingAt !== null && !HUMAN_AUTHORED_KINDS.has(e.kind) && DIRECT_JID.test(e.to)
    );
    const hourAgo = this.now() - 60 * 60_000;
    const minuteAgo = this.now() - 60_000;
    if (aiSends.filter((e) => e.to === entry.to && e.sendingAt! >= hourAgo).length >= this.config.maxChatRepliesPerHour) {
      return "chat_rate_limited";
    }
    if (aiSends.filter((e) => e.sendingAt! >= minuteAgo).length >= this.config.maxBusinessSendsPerMinute) {
      return "business_rate_limited";
    }
    return null;
  }

  private async waitForSendGap(businessSlug: string) {
    const last = Math.max(
      0,
      ...Object.values(this.state.outbox)
        .filter((e) => e.businessSlug === businessSlug && e.sendingAt !== null)
        .map((e) => e.sendingAt!)
    );
    const wait = last + this.config.minSendGapMs - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  async deliver(entry: OutboxEntry): Promise<void> {
    if (entry.state !== "queued") return; // each outbox id is attempted at most once
    let blocked = await this.blockReason(entry);
    if (!blocked) {
      await this.waitForSendGap(entry.businessSlug);
      blocked = await this.blockReason(entry); // takeover / newer messages during the wait
    }
    if (blocked) return this.settle(entry, "failed", null, blocked);

    // Write-ahead: from here a crash is recovered as 'unknown', never resent.
    entry.state = "sending";
    entry.sendingAt = this.now();
    this.journal.save();
    try {
      const { messageId } = await this.sender.send(
        entry.businessSlug,
        entry.to,
        entry.body!,
        entry.to.endsWith("@g.us") ? entry.replyToMessageId ?? null : null
      );
      await this.settle(entry, "sent", messageId, null);
    } catch (error) {
      if (error instanceof NotSentError) return this.settle(entry, "failed", null, `not_sent: ${errorText(error)}`);
      this.markUnknown(entry, `ambiguous send failure: ${errorText(error)}`);
      this.journal.save();
    }
  }

  private markUnknown(entry: OutboxEntry, error: string) {
    entry.state = "unknown";
    entry.settledAt = this.now();
    entry.error = error;
    entry.ack = "none"; // neither 'sent' nor 'failed' would be true
    entry.body = null;
    if (DIRECT_JID.test(entry.to)) {
      this.state.holds[chatKey(entry.businessSlug, entry.to)] = {
        until: this.now() + this.config.unknownSendHoldMs,
        reason: "unknown_send_outcome",
        outboxId: entry.id
      };
    }
    this.log(`outbox ${entry.id} ${entry.kind} outcome UNKNOWN — left dispatched in the Inbox, not acked, not retried`);
  }

  private async settle(entry: OutboxEntry, state: "sent" | "failed", messageId: string | null, error: string | null) {
    entry.state = state;
    entry.settledAt = this.now();
    entry.whatsappMessageId = messageId;
    entry.error = error;
    entry.body = null;
    this.journal.save();
    this.log(`outbox ${entry.id} ${entry.kind} ${state}${error ? ` (${error.split(":")[0]})` : ""}`);
    await this.sendAck(entry);
  }

  private async sendAck(entry: OutboxEntry) {
    if (entry.ack !== "pending" || (entry.state !== "sent" && entry.state !== "failed")) return;
    const result = await this.inbox.ack({
      outboxId: entry.id,
      status: entry.state,
      whatsappMessageId: entry.whatsappMessageId,
      error: entry.error
    });
    entry.ackAttempts += 1;
    if (result === "ok") entry.ack = "done";
    else if (result === "rejected") {
      entry.ack = "rejected";
      this.log(`ack for outbox ${entry.id} rejected by the Inbox (not retried)`);
    } else if (entry.ackAttempts >= MAX_ACK_ATTEMPTS) {
      entry.ack = "abandoned";
      this.log(`ack for outbox ${entry.id} abandoned after ${entry.ackAttempts} attempts`);
    }
    this.journal.save();
  }

  // Acks are retried (a repeated identical ack is ok in the Inbox); sends never.
  private async retryAcks() {
    for (const entry of Object.values(this.state.outbox)) {
      if (this.stopping) return;
      if (entry.ack === "pending" && (entry.state === "sent" || entry.state === "failed")) await this.sendAck(entry);
    }
  }

  private prune() {
    const now = this.now();
    let changed = false;
    for (const [id, e] of Object.entries(this.state.outbox)) {
      const settledFor = e.settledAt === null ? 0 : now - e.settledAt;
      const done = e.ack !== "pending" && e.state !== "queued" && e.state !== "sending";
      if (done && settledFor > (e.state === "unknown" ? UNKNOWN_RETENTION_MS : DAY_MS)) {
        delete this.state.outbox[id];
        changed = true;
      }
    }
    for (const map of [this.state.forwarded, this.state.customerActivity, this.state.humanActivity]) {
      for (const [k, at] of Object.entries(map)) {
        if (now - at > DAY_MS) {
          delete map[k];
          changed = true;
        }
      }
    }
    for (const [k, hold] of Object.entries(this.state.holds)) {
      if (hold.until <= now) {
        delete this.state.holds[k];
        changed = true;
      }
    }
    if (changed) this.journal.save();
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  clearHold(businessSlug: string, chatId: string): boolean {
    const key = chatKey(businessSlug, chatId);
    if (!this.state.holds[key]) return false;
    delete this.state.holds[key];
    this.journal.save();
    this.log(`hold cleared for a chat of ${businessSlug}`);
    return true;
  }

  status() {
    const outbox = Object.values(this.state.outbox);
    return {
      configLoaded: Boolean(this.inboxConfig),
      businesses: this.inboxConfig?.businesses.map(({ businessSlug, forwardMessages, mode }) => ({ businessSlug, forwardMessages, mode })) ?? [],
      pendingForwards: this.state.forwards.length,
      queuedSends: outbox.filter((e) => e.state === "queued").length,
      pendingAcks: outbox.filter((e) => e.ack === "pending" && e.state !== "queued").length,
      unknownSends: outbox
        .filter((e) => e.state === "unknown")
        .map((e) => ({ outboxId: e.id, businessSlug: e.businessSlug, kind: e.kind, to: e.to, at: new Date(e.settledAt ?? 0).toISOString() })),
      holds: Object.entries(this.state.holds).map(([key, hold]) => {
        const [businessSlug, chatId] = key.split("|");
        return { businessSlug, chatId, until: new Date(hold.until).toISOString(), outboxId: hold.outboxId };
      })
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start() {
    if (this.timer || this.currentTick || !this.config.enabled) return;
    this.stopping = false;
    this.log(`started sendEnabled=${this.config.sendEnabled} windowMs=${this.config.batchWindowMs}`);
    this.runTick();
  }

  private runTick() {
    this.currentTick = this.tick()
      .catch((error) => this.log(`tick error: ${errorText(error)}`))
      .finally(() => {
        this.currentTick = null;
        if (this.stopping) return;
        // Next tick only after this one finishes, so ticks never overlap.
        this.timer = setTimeout(() => this.runTick(), this.config.tickMs);
      });
  }

  async stop(waitMs = 8_000) {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.currentTick) await Promise.race([this.currentTick, new Promise((r) => setTimeout(r, waitMs))]);
    this.log("stopped");
  }
}
