// Realistic Inbox bridge API fixtures, taken from
// devaux-whatsapp-inbox/docs/ai-agent-bridge-contract.md and the route /
// library code that implements it (app/api/bridge/ai-agent/*,
// lib/server/aiAgent/{decide,outbox,escalations}.ts, lib/aiAgent/engine.ts).

export const SLUG = "dog_food";
export const CUSTOMER_JID = "17585551234@s.whatsapp.net";
export const CUSTOMER_NUMBER = "17585551234";
export const LID_JID = "112233445566778@lid";
export const STAFF_GROUP = "120363025555555555@g.us";
export const STAFF_MEMBER = "17585559999@s.whatsapp.net";
export const SECRET = "test-bridge-secret-0123456789abcdef";

// GET /api/bridge/ai-agent/config — as seeded by the migration (OFF/observe).
export const configSeeded = {
  pollOutboxSeconds: 10,
  businesses: [{ businessSlug: SLUG, forwardMessages: false, mode: "observe", staffGroupJid: null }]
};

export const configAssisted = {
  pollOutboxSeconds: 10,
  businesses: [{ businessSlug: SLUG, forwardMessages: true, mode: "assisted", staffGroupJid: STAFF_GROUP }]
};

export const configObserve = {
  pollOutboxSeconds: 10,
  businesses: [{ businessSlug: SLUG, forwardMessages: true, mode: "observe", staffGroupJid: STAFF_GROUP }]
};

// POST /api/bridge/ai-agent/message — request, inbound 1:1 (contract 3.2).
export const messageRequestInbound = {
  businessSlug: SLUG,
  whatsappMessageId: "3EB0C767F26A1D2B1F3A",
  chatId: CUSTOMER_JID,
  contactNumber: CUSTOMER_NUMBER,
  fromMe: false,
  text: "Do you deliver to Gros Islet?",
  hasMedia: false,
  quotedMessageId: null,
  senderJid: null,
  timestamp: "2026-10-22T14:03:11.000Z"
};

// status: done, decision REPLY (decide.ts handleCustomerMessage REPLY branch).
export const messageResponseReply = {
  eventId: "6d0c2a8e-4f1b-4c3e-9a7d-2b5e8f1c0a91",
  status: "done",
  decision: "REPLY",
  reasons: ["verified_answer"],
  outbox: [
    {
      id: "a1b2c3d4-0000-4000-8000-000000000001",
      businessSlug: SLUG,
      kind: "customer_reply",
      to: CUSTOMER_JID,
      body: "Yes — we deliver to Gros Islet on Tuesdays and Fridays.",
      send: true
    }
  ]
};

// A retry of the same whatsappMessageId (decide.ts claimEvent 23505 path).
export const messageResponseDuplicate = {
  ...messageResponseReply,
  status: "duplicate",
  outbox: messageResponseReply.outbox.map((item) => ({ ...item, send: false }))
};

// ESCALATE with staff notice + holding reply (decide.ts ESCALATE branch,
// engine.ts buildStaffNotice / HOLDING_REPLY_GENERAL).
export const messageResponseEscalate = {
  eventId: "7e1d3b9f-5a2c-4d4f-8b8e-3c6f9a2d1b02",
  status: "done",
  decision: "ESCALATE",
  reasons: ["complaint"],
  outbox: [
    {
      id: "b2c3d4e5-0000-4000-8000-000000000002",
      businessSlug: SLUG,
      kind: "staff_notice",
      to: STAFF_GROUP,
      body:
        '🔔 AI escalation #E-7K3QX (HIGH)\nCustomer: Jane · 17585551234\nReason: complaint\nMessage: "The bag arrived torn"\n' +
        "↩️ Reply to this message (or include #E-7K3QX) with the exact text to send the customer.\n" +
        "Commands: !note <text> · !close · !takeover · !resume",
      send: true
    },
    {
      id: "c3d4e5f6-0000-4000-8000-000000000003",
      businessSlug: SLUG,
      kind: "holding_reply",
      to: CUSTOMER_JID,
      body: "Thanks for your message! I've passed this to our team and someone will get back to you shortly.",
      send: true
    }
  ]
};

// Staff-group answer matched by quoted notice (escalations.ts applyStaffAction "send").
export const messageResponseStaffAnswer = {
  eventId: "8f2e4c0a-6b3d-4e5a-9c9f-4d7a0b3e2c03",
  status: "done",
  decision: "NO_REPLY",
  reasons: ["staff_group_matched:send"],
  outbox: [
    {
      id: "d4e5f6a7-0000-4000-8000-000000000004",
      businessSlug: SLUG,
      kind: "staff_relay",
      to: CUSTOMER_JID,
      body: "So sorry Jane — a replacement bag goes out on Friday's run.",
      send: true
    },
    {
      id: "e5f6a7b8-0000-4000-8000-000000000005",
      businessSlug: SLUG,
      kind: "staff_feedback",
      to: STAFF_GROUP,
      body: "✅ #7K3QX: sending your answer to the customer.",
      send: true
    }
  ]
};

export const messageResponseIgnored = {
  eventId: null,
  status: "ignored",
  decision: "NO_REPLY",
  reasons: ["agent_disabled"],
  outbox: []
};

export const messageResponseError = {
  eventId: "9a3f5d1b-7c4e-4f6b-8d0a-5e8b1c4f3d04",
  status: "error",
  decision: null,
  reasons: ["internal_error"],
  outbox: []
};

// POST /api/bridge/ai-agent/ack (contract 3.3).
export const ackSentStaffNotice = {
  outboxId: "b2c3d4e5-0000-4000-8000-000000000002",
  status: "sent",
  whatsappMessageId: "3EB0AA11BB22CC33DD44",
  error: null
};

// POST /api/bridge/ai-agent/outbox/claim (contract 3.4) — admin-UI answer.
export const claimResponse = {
  items: [
    {
      id: "f6a7b8c9-0000-4000-8000-000000000006",
      businessSlug: SLUG,
      kind: "staff_relay",
      to: CUSTOMER_JID,
      body: "Hi Jane, your refund was approved by the manager.",
      send: true
    }
  ]
};

// Error bodies (lib/server/aiAgent/auth.ts and the routes).
export const errorUnauthorized = { error: "Unauthorized" };
export const errorNotConfigured = { error: "AI agent bridge is not configured" };
export const errorMissingFields = { error: "businessSlug, whatsappMessageId and chatId are required" };
