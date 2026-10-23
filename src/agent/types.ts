// Wire types for the Inbox AI agent bridge contract. The Inbox repo
// (devaux-whatsapp-inbox) owns the contract, the ai_agent_* schema and every
// decision: docs/ai-agent-bridge-contract.md there is authoritative, and these
// types mirror app/api/bridge/ai-agent/* and lib/server/aiAgent/outbox.ts.
// Nothing in src/agent decides what to say; it forwards, sends verbatim, acks.

// POST /api/bridge/ai-agent/message request body.
export type ForwardPayload = {
  businessSlug: string;
  whatsappMessageId: string;
  chatId: string;
  contactNumber: string | null;
  fromMe: boolean;
  text: string;
  hasMedia: boolean;
  quotedMessageId: string | null;
  senderJid: string | null;
  timestamp: string;
};

export type InboxDecision = "REPLY" | "ASK" | "ESCALATE" | "NO_REPLY" | "HUMAN";
export type MessageStatus = "done" | "duplicate" | "in_progress" | "ignored" | "error";

// Known kinds; unknown ones are kept (the contract says honour `send`).
export type OutboxKind = "customer_reply" | "holding_reply" | "staff_notice" | "staff_feedback" | "staff_relay";

export type OutboxItem = {
  id: string;
  businessSlug: string;
  kind: OutboxKind | string;
  to: string;
  body: string;
  send: boolean;
};

export type MessageResponse = {
  eventId: string | null;
  status: MessageStatus;
  decision: InboxDecision | null;
  reasons: string[];
  outbox: OutboxItem[];
};

export type BusinessConfig = {
  businessSlug: string;
  forwardMessages: boolean;
  mode: "observe" | "assisted" | string;
  staffGroupJid: string | null;
};

export type ConfigResponse = {
  pollOutboxSeconds: number;
  businesses: BusinessConfig[];
};

export type AckPayload = {
  outboxId: string;
  status: "sent" | "failed";
  whatsappMessageId: string | null;
  error: string | null;
};

// "rejected" = 404/409: terminal, never retried. "error" = transport or 5xx:
// the ack may be retried (the Inbox treats a repeated identical ack as ok).
export type AckResult = "ok" | "rejected" | "error";

export interface InboxClient {
  getConfig(): Promise<ConfigResponse>;
  // Throws InboxHttpError on transport errors and non-2xx; `retryable` says
  // whether the same whatsappMessageId may be forwarded again.
  forwardMessage(payload: ForwardPayload): Promise<MessageResponse>;
  ack(payload: AckPayload): Promise<AckResult>;
  // Every returned item was claimed (dispatched) and must be acked.
  claimOutbox(businessSlug: string, limit: number): Promise<OutboxItem[]>;
}

export class InboxHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "InboxHttpError";
  }
}

// Thrown by Sender.send when the message provably never reached WhatsApp.
// Any other error from send() is treated as an ambiguous outcome.
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

export interface Sender {
  isConnected(businessSlug: string): boolean;
  send(businessSlug: string, jid: string, body: string): Promise<{ messageId: string }>;
}

export type AgentConfig = {
  enabled: boolean;
  sendEnabled: boolean;
  batchWindowMs: number;
  tickMs: number;
  configTtlMs: number;
  maxMessageAgeMs: number;
  maxChatRepliesPerHour: number;
  maxBusinessSendsPerMinute: number;
  minSendGapMs: number;
  maxForwardAttempts: number;
  unknownSendHoldMs: number;
};
