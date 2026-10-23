"use strict";
// Wire types for the Inbox AI agent bridge contract. The Inbox repo
// (devaux-whatsapp-inbox) owns the contract, the ai_agent_* schema and every
// decision: docs/ai-agent-bridge-contract.md there is authoritative, and these
// types mirror app/api/bridge/ai-agent/* and lib/server/aiAgent/outbox.ts.
// Nothing in src/agent decides what to say; it forwards, sends verbatim, acks.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotSentError = exports.InboxHttpError = void 0;
class InboxHttpError extends Error {
    status;
    retryable;
    constructor(message, status, retryable) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.name = "InboxHttpError";
    }
}
exports.InboxHttpError = InboxHttpError;
// Thrown by Sender.send when the message provably never reached WhatsApp.
// Any other error from send() is treated as an ambiguous outcome.
class NotSentError extends Error {
    constructor(message) {
        super(message);
        this.name = "NotSentError";
    }
}
exports.NotSentError = NotSentError;
