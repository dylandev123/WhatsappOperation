import fs from "fs";
import path from "path";
import type { ForwardPayload } from "./types.js";

// The bridge's only durable state: a small local JSON file (on the ./auth
// volume by default). It holds transport bookkeeping, never business state —
// decisions, escalations, takeover and order requests all live in the
// Inbox's ai_agent_* tables. What it protects:
//   forwards  messages saved to whatsapp_messages but not yet accepted by
//             /message (batching window, Inbox outage, restart)
//   outbox    every outbox id the bridge has seen, so one is never sent twice,
//             and a write-ahead 'sending' mark so a crash mid-send is
//             recovered as 'unknown' instead of being retried or acked
//   holds     chats where a send outcome is unknown: no further AI sends
// Written synchronously (tmp + rename) after every change.

export type ForwardRole = "customer" | "human" | "staff_group";

export type ForwardEntry = {
  key: string;
  role: ForwardRole;
  payload: ForwardPayload;
  receivedAt: number;
  attempts: number;
  nextAttemptAt: number;
};

export type OutboxState = "queued" | "sending" | "sent" | "failed" | "unknown";
export type AckState = "pending" | "done" | "rejected" | "abandoned" | "none";

export type OutboxEntry = {
  id: string;
  businessSlug: string;
  kind: string;
  to: string;
  // Kept only while the item may still be sent; cleared once settled.
  body: string | null;
  source: "message" | "claim";
  // When the customer message that produced this item arrived (null for
  // claimed items): drives supersede, takeover and staleness checks.
  triggerReceivedAt: number | null;
  createdAt: number;
  state: OutboxState;
  sendingAt: number | null;
  settledAt: number | null;
  whatsappMessageId: string | null;
  error: string | null;
  ack: AckState;
  ackAttempts: number;
};

export type Hold = { until: number; reason: string; outboxId: string };

export type JournalState = {
  version: 1;
  forwards: ForwardEntry[];
  outbox: Record<string, OutboxEntry>;
  // slug|messageId -> when it was accepted or given up (dedupe)
  forwarded: Record<string, number>;
  // slug|chatId -> newest live customer / human message receive time
  customerActivity: Record<string, number>;
  humanActivity: Record<string, number>;
  holds: Record<string, Hold>;
  lastClaimAt: Record<string, number>;
};

export interface Journal {
  readonly state: JournalState;
  save(): void;
}

export function emptyJournalState(): JournalState {
  return {
    version: 1,
    forwards: [],
    outbox: {},
    forwarded: {},
    customerActivity: {},
    humanActivity: {},
    holds: {},
    lastClaimAt: {}
  };
}

export function createMemoryJournal(state: JournalState = emptyJournalState()): Journal & { saves: number } {
  return {
    state,
    saves: 0,
    save() {
      this.saves += 1;
    }
  };
}

export function createFileJournal(file: string, log: (message: string) => void = console.log): Journal {
  let state = emptyJournalState();
  if (fs.existsSync(file)) {
    try {
      state = { ...emptyJournalState(), ...(JSON.parse(fs.readFileSync(file, "utf8")) as JournalState) };
    } catch (error) {
      // Keep the unreadable file for inspection; starting empty can lose
      // pending forwards but can never cause a resend.
      const aside = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, aside);
      log(`journal unreadable, moved to ${aside}: ${error instanceof Error ? error.message : error}`);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });

  return {
    get state() {
      return state;
    },
    save() {
      const tmp = `${file}.tmp`;
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(state));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    }
  };
}
