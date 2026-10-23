import type { proto } from "@whiskeysockets/baileys";
import type { TestContext } from "node:test";
import { AgentBridge, type LiveOrigin } from "../src/agent/bridge.js";
import { createInboxClient } from "../src/agent/inboxClient.js";
import { createMemoryJournal, emptyJournalState, type JournalState } from "../src/agent/journal.js";
import { NotSentError, type AgentConfig, type Sender } from "../src/agent/types.js";
import { FakeInbox } from "./fakeInbox.js";
import { CUSTOMER_JID, SECRET, SLUG, STAFF_GROUP, STAFF_MEMBER } from "./fixtures/inbox.js";

export class Clock {
  constructor(public ms = Date.parse("2026-10-22T14:00:00.000Z")) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
}

export type SendMode = "ok" | "not_sent" | "ambiguous";

export class FakeSender implements Sender {
  connected = true;
  mode: SendMode = "ok";
  sent: Array<{ businessSlug: string; jid: string; body: string; messageId: string }> = [];
  attempts = 0;
  // Called just before a send resolves (e.g. a human types meanwhile).
  beforeSend: (() => Promise<void> | void) | null = null;
  private seq = 0;

  isConnected() {
    return this.connected;
  }

  async send(businessSlug: string, jid: string, body: string) {
    this.attempts += 1;
    if (this.beforeSend) await this.beforeSend();
    if (this.mode === "not_sent") throw new NotSentError("WhatsApp session dog_food is not connected");
    if (this.mode === "ambiguous") throw new Error("send timed out");
    const messageId = `3EB0BOT${String(++this.seq).padStart(13, "0")}`;
    this.sent.push({ businessSlug, jid, body, messageId });
    return { messageId };
  }
}

export const baseConfig: AgentConfig = {
  enabled: true,
  sendEnabled: true,
  batchWindowMs: 10_000,
  tickMs: 2_000,
  configTtlMs: 60_000,
  maxMessageAgeMs: 10 * 60_000,
  maxChatRepliesPerHour: 4,
  maxBusinessSendsPerMinute: 3,
  minSendGapMs: 5_000,
  maxForwardAttempts: 3,
  unknownSendHoldMs: 6 * 60 * 60_000
};

let msgSeq = 0;
const nextId = () => `3EB0MSG${String(++msgSeq).padStart(13, "0")}`;

export function customerMsg(clock: Clock, text: string, extra: { id?: string; chatId?: string; senderPn?: string; tsMs?: number; quoted?: string } = {}): proto.IWebMessageInfo {
  return {
    key: { remoteJid: extra.chatId ?? CUSTOMER_JID, fromMe: false, id: extra.id ?? nextId(), ...(extra.senderPn ? { senderPn: extra.senderPn } : {}) } as proto.IMessageKey,
    message: extra.quoted ? { extendedTextMessage: { text, contextInfo: { stanzaId: extra.quoted } } } : { conversation: text },
    messageTimestamp: Math.floor((extra.tsMs ?? clock.now()) / 1000),
    pushName: "Jane"
  };
}

export function phoneMsg(clock: Clock, text: string, chatId = CUSTOMER_JID): proto.IWebMessageInfo {
  return { key: { remoteJid: chatId, fromMe: true, id: nextId() }, message: { conversation: text }, messageTimestamp: Math.floor(clock.now() / 1000) };
}

export function staffGroupMsg(clock: Clock, text: string, opts: { quoted?: string; participant?: string; fromMe?: boolean; group?: string } = {}): proto.IWebMessageInfo {
  return {
    key: { remoteJid: opts.group ?? STAFF_GROUP, fromMe: opts.fromMe ?? false, id: nextId(), participant: opts.fromMe ? undefined : opts.participant ?? STAFF_MEMBER },
    message: opts.quoted ? { extendedTextMessage: { text, contextInfo: { stanzaId: opts.quoted } } } : { conversation: text },
    messageTimestamp: Math.floor(clock.now() / 1000)
  };
}

export type Env = Awaited<ReturnType<typeof setup>>;

export async function setup(
  t: TestContext,
  opts: { config?: Partial<AgentConfig>; state?: JournalState; inbox?: FakeInbox; clock?: Clock; sender?: FakeSender } = {}
) {
  const inbox = opts.inbox ?? new FakeInbox(SECRET);
  if (!inbox.url) {
    await inbox.listen();
    t.after(() => inbox.close());
  }
  const clock = opts.clock ?? new Clock();
  const sender = opts.sender ?? new FakeSender();
  const journal = createMemoryJournal(opts.state ?? emptyJournalState());
  const logs: string[] = [];
  const bridge = new AgentBridge({
    inbox: createInboxClient({ baseUrl: inbox.url, secret: SECRET }),
    sender,
    journal,
    config: { ...baseConfig, ...opts.config },
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    log: (m) => logs.push(m)
  });

  const live = (msg: proto.IWebMessageInfo, origin: LiveOrigin = null) => bridge.onLiveMessage(SLUG, msg, msg.key.fromMe && origin === null ? "phone" : origin);
  // Wait out the batching window, then run one worker tick.
  const settle = async (ms = baseConfig.batchWindowMs + 1) => {
    clock.advance(ms);
    await bridge.tick();
  };
  return { inbox, clock, sender, journal, bridge, logs, live, settle };
}

export function reply(body: string, to = CUSTOMER_JID) {
  return { decision: "REPLY", reasons: ["verified_answer"], items: [{ kind: "customer_reply", to, body }] };
}
