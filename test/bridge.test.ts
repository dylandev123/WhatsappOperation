import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { emptyJournalState } from "../src/agent/journal.js";
import type { Payload } from "./fakeInbox.js";
import * as fx from "./fixtures/inbox.js";
import { Clock, customerMsg, FakeSender, phoneMsg, reply, setup, staffGroupMsg } from "./helpers.js";

const MESSAGE = "/api/bridge/ai-agent/message";
const ACK = "/api/bridge/ai-agent/ack";
const CLAIM = "/api/bridge/ai-agent/outbox/claim";

const acks = (env: { inbox: { calls: (p: string) => Array<{ body: unknown }> } }) =>
  env.inbox.calls(ACK).map((c) => c.body as { outboxId: string; status: string; whatsappMessageId: string | null; error: string | null });

describe("defaults and switches", () => {
  test("AGENT_ENABLED=false: nothing is forwarded, no Inbox calls", async (t) => {
    const env = await setup(t, { config: { enabled: false } });
    assert.equal(await env.live(customerMsg(env.clock, "hi")), "agent_disabled");
    await env.settle();
    assert.equal(env.inbox.requests.length, 0);
  });

  test("Inbox seeded OFF (forwardMessages false): nothing is forwarded", async (t) => {
    const env = await setup(t);
    env.inbox.config = structuredClone(fx.configSeeded);
    assert.equal(await env.live(customerMsg(env.clock, "hi")), "not_forwarding");
    await env.settle();
    assert.equal(env.inbox.calls(MESSAGE).length, 0);
  });

  test("Inbox config unreachable: fail closed, nothing forwarded", async (t) => {
    const env = await setup(t);
    env.inbox.forceStatus.set("/api/bridge/ai-agent/config", 500);
    assert.equal(await env.live(customerMsg(env.clock, "hi")), "not_forwarding");
  });

  test("AGENT_SEND_ENABLED=false: decision recorded, nothing sent, item acked failed, no claims", async (t) => {
    const env = await setup(t, { config: { sendEnabled: false } });
    env.inbox.respond = () => reply("We open at 9.");
    env.inbox.queueAdminAnswer({ ...fx.claimResponse.items[0] });
    await env.live(customerMsg(env.clock, "when do you open?"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].status, "failed");
    assert.equal(acks(env)[0].error, "bridge_send_disabled");
    assert.equal(env.inbox.calls(CLAIM).length, 0);
    assert.equal(env.inbox.outbox.find((r) => r.kind === "staff_relay")!.status, "pending"); // left for later
  });
});

describe("Observe mode never sends", () => {
  test("Inbox in observe returns no items: forwarded, nothing sent", async (t) => {
    const env = await setup(t);
    env.inbox.config = structuredClone(fx.configObserve);
    env.inbox.respond = () => reply("We open at 9.");
    await env.live(customerMsg(env.clock, "when do you open?"));
    await env.settle();
    assert.equal(env.inbox.calls(MESSAGE).length, 1);
    assert.equal(env.sender.attempts, 0);
  });

  test("even if the Inbox returned sendable items in observe, the bridge blocks them", async (t) => {
    const env = await setup(t);
    env.inbox.config = structuredClone(fx.configObserve);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => reply("We open at 9.");
    await env.live(customerMsg(env.clock, "when do you open?"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "observe_mode");
  });

  test("observe: outbox is never claimed", async (t) => {
    const env = await setup(t);
    env.inbox.config = structuredClone(fx.configObserve);
    await env.settle();
    assert.equal(env.inbox.calls(CLAIM).length, 0);
  });
});

describe("what is never forwarded as human activity", () => {
  test("the bridge's own sends and scheduled sends", async (t) => {
    const env = await setup(t);
    assert.equal(await env.live(phoneMsg(env.clock, "AI reply text"), "agent"), "bridge_send");
    assert.equal(await env.live(phoneMsg(env.clock, "Weekly promo"), "scheduled"), "bridge_send");
    assert.equal(await env.live(staffGroupMsg(env.clock, "🔔 AI escalation #E-7K3QX", { fromMe: true }), "agent"), "bridge_send");
    await env.settle();
    assert.equal(env.inbox.calls(MESSAGE).length, 0);
  });

  test("manual phone and inbox /api/send messages ARE forwarded as fromMe", async (t) => {
    const env = await setup(t);
    assert.equal(await env.live(phoneMsg(env.clock, "typed on the phone"), "phone"), "queued");
    assert.equal(await env.live(phoneMsg(env.clock, "sent from inbox"), "api"), "queued");
    await env.settle(1);
    assert.ok(env.inbox.calls(MESSAGE).every((c) => (c.body as Payload).fromMe === true));
    assert.equal(env.inbox.calls(MESSAGE).length, 2);
  });

  test("other groups, broadcasts, protocol messages and stale catch-up messages", async (t) => {
    const env = await setup(t);
    assert.equal(await env.live(staffGroupMsg(env.clock, "hi", { group: "999@g.us" })), "not_staff_group");
    assert.equal(await env.live({ ...customerMsg(env.clock, "x"), key: { remoteJid: "status@broadcast", id: "S1" } }), "system_chat");
    assert.equal(await env.live({ ...customerMsg(env.clock, "x"), message: { protocolMessage: {} } }), "system_event");
    assert.equal(await env.live(customerMsg(env.clock, "old", { tsMs: env.clock.now() - 11 * 60_000 })), "too_old");
  });
});

describe("batching", () => {
  test("a burst waits for the inactivity window, then is forwarded in order; only the last reply is sent", async (t) => {
    const env = await setup(t);
    env.inbox.respond = (p) => reply(`answer to: ${p.text}`);
    for (const text of ["hi", "do you have 15kg bags", "and delivery to Vieux Fort?"]) {
      await env.live(customerMsg(env.clock, text));
      env.clock.advance(3_000);
    }
    await env.bridge.tick();
    assert.equal(env.inbox.calls(MESSAGE).length, 0, "still inside the window");

    await env.settle();
    assert.deepEqual(
      env.inbox.calls(MESSAGE).map((c) => (c.body as Payload).text),
      ["hi", "do you have 15kg bags", "and delivery to Vieux Fort?"]
    );
    assert.deepEqual(env.sender.sent.map((s) => s.body), ["answer to: and delivery to Vieux Fort?"]);
    assert.deepEqual(
      acks(env).map((a) => a.error ?? a.status),
      ["superseded_by_newer_message", "superseded_by_newer_message", "sent"]
    );
  });

  test("a message arriving while the Inbox is deciding supersedes that reply; the next one is answered", async (t) => {
    const env = await setup(t);
    let first = true;
    env.inbox.respond = (p) => {
      if (first) {
        first = false;
        void env.live(customerMsg(env.clock, "actually make it 2 bags"));
      }
      return reply(`answer to: ${p.text}`);
    };
    await env.live(customerMsg(env.clock, "1 bag please"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
    assert.equal(acks(env)[0].error, "superseded_by_newer_message");
    await env.settle();
    assert.deepEqual(env.sender.sent.map((s) => s.body), ["answer to: actually make it 2 bags"]);
  });

  test("an escalation from an earlier message in the burst is still delivered", async (t) => {
    const env = await setup(t);
    env.inbox.respond = (p) =>
      p.text.includes("torn")
        ? { decision: "ESCALATE", reasons: ["complaint"], items: fx.messageResponseEscalate.outbox.map(({ kind, to, body }) => ({ kind, to, body })) }
        : { decision: "ESCALATE", reasons: ["open_escalation"], items: [] };
    await env.live(customerMsg(env.clock, "The bag arrived torn"));
    await env.live(customerMsg(env.clock, "hello??"));
    await env.settle();
    assert.deepEqual(env.sender.sent.map((s) => s.jid), [fx.STAFF_GROUP, fx.CUSTOMER_JID]);
  });
});

describe("human takeover", () => {
  test("a human message flushes the chat at once and blocks the AI reply to earlier messages", async (t) => {
    const env = await setup(t);
    env.inbox.respond = (p) => (p.fromMe ? { decision: "HUMAN", reasons: ["staff_message"], items: [] } : reply("AI answer"));
    await env.live(customerMsg(env.clock, "price of 15kg?"));
    env.clock.advance(1_000);
    await env.live(phoneMsg(env.clock, "It's EC$120, Jane"));
    await env.settle(1); // no window wait needed
    assert.equal(env.inbox.calls(MESSAGE).length, 2);
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "human_takeover");
  });

  test("a human typing while the Inbox decides also blocks the reply", async (t) => {
    const env = await setup(t);
    env.inbox.respond = (p) => {
      if (!p.fromMe) void env.live(phoneMsg(env.clock, "got it, I'll answer"));
      return p.fromMe ? { decision: "HUMAN", reasons: ["staff_message"], items: [] } : reply("AI answer");
    };
    await env.live(customerMsg(env.clock, "question"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "human_takeover");
  });

  test("a staff answer (staff_relay) is human-authored and is still delivered", async (t) => {
    const env = await setup(t);
    await env.live(phoneMsg(env.clock, "manual message"));
    env.inbox.queueAdminAnswer({ ...fx.claimResponse.items[0] });
    await env.settle(1);
    assert.deepEqual(env.sender.sent.map((s) => s.body), [fx.claimResponse.items[0].body]);
  });
});

describe("staff escalation protocol (#E-XXXXX, quoted replies) — owned by the Inbox", () => {
  test("notice ack carries the WhatsApp id; a quoted staff reply is relayed verbatim", async (t) => {
    const env = await setup(t);
    env.inbox.respond = (p, inbox) => {
      if (p.chatId === fx.STAFF_GROUP) {
        // escalations.ts matchCandidates: quoted id must be an acked staff_notice.
        if (!inbox.noticeMessageIds.includes(p.quotedMessageId as string)) return { decision: "NO_REPLY", reasons: ["staff_group_unmatched"], items: [] };
        return {
          decision: "NO_REPLY",
          reasons: ["staff_group_matched:send"],
          items: [
            { kind: "staff_relay", to: fx.CUSTOMER_JID, body: p.text },
            { kind: "staff_feedback", to: fx.STAFF_GROUP, body: "✅ #7K3QX: sending your answer to the customer." }
          ]
        };
      }
      return { decision: "ESCALATE", reasons: ["complaint"], items: fx.messageResponseEscalate.outbox.map(({ kind, to, body }) => ({ kind, to, body })) };
    };

    await env.live(customerMsg(env.clock, "The bag arrived torn"));
    await env.settle();
    const notice = env.sender.sent.find((s) => s.jid === fx.STAFF_GROUP)!;
    assert.match(notice.body, /#E-7K3QX/);
    const noticeAck = acks(env).find((a) => a.whatsappMessageId === notice.messageId)!;
    assert.equal(noticeAck.status, "sent");

    // The bot's own notice echo is never forwarded.
    assert.equal(await env.live(staffGroupMsg(env.clock, notice.body, { fromMe: true }), "agent"), "bridge_send");

    const answer = "So sorry Jane — a replacement bag goes out on Friday's run.";
    await env.live(staffGroupMsg(env.clock, answer, { quoted: notice.messageId }));
    await env.settle(1);
    const relay = env.sender.sent.find((s) => s.jid === fx.CUSTOMER_JID && s.body === answer);
    assert.ok(relay, "staff answer relayed verbatim");
    assert.ok(env.sender.sent.some((s) => s.jid === fx.STAFF_GROUP && s.body.startsWith("✅")));
  });

  test("#E code answers are forwarded untouched — the bridge never parses or rewrites them", async (t) => {
    const env = await setup(t);
    await env.live(staffGroupMsg(env.clock, "#E-7K3QX Replacement Friday"));
    await env.live(staffGroupMsg(env.clock, "!takeover #E-7K3QX"));
    await env.settle(1);
    assert.deepEqual(
      env.inbox.calls(MESSAGE).map((c) => (c.body as Payload).text),
      ["#E-7K3QX Replacement Friday", "!takeover #E-7K3QX"]
    );
  });

  test("staff items go only to the configured staff group", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => ({ decision: "ESCALATE", reasons: ["complaint"], items: [{ kind: "staff_notice", to: "999@g.us", body: "x" }] });
    await env.live(customerMsg(env.clock, "complaint"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "not_staff_group");
  });
});

describe("deduplication and idempotency", () => {
  test("the same WhatsApp message is forwarded once", async (t) => {
    const env = await setup(t);
    const msg = phoneMsg(env.clock, "sent from inbox");
    assert.equal(await env.live(msg, "api"), "queued");
    assert.equal(await env.live(msg, "api"), "duplicate"); // direct notify + upsert echo
    await env.settle(1);
    assert.equal(await env.live(msg, "phone"), "duplicate");
    assert.equal(env.inbox.calls(MESSAGE).length, 1);
  });

  test("a re-forward after losing the journal gets 'duplicate' from the Inbox and sends nothing", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => reply("Yes.");
    const msg = customerMsg(env.clock, "q");
    await env.live(msg);
    await env.settle();
    assert.equal(env.sender.sent.length, 1);

    const fresh = await setup(t, { inbox: env.inbox, clock: env.clock, sender: env.sender }); // empty journal
    await fresh.live(msg);
    await fresh.settle();
    assert.equal(env.sender.sent.length, 1);
  });

  test("an outbox id already in the journal is never sent again", async (t) => {
    const env = await setup(t);
    const id = env.inbox.queueAdminAnswer({ ...fx.claimResponse.items[0] });
    await env.settle(1);
    env.inbox.outbox.find((r) => r.id === id)!.status = "pending"; // pathological re-delivery
    env.clock.advance(11_000);
    await env.bridge.tick();
    assert.equal(env.sender.sent.length, 1);
  });
});

describe("rate limiting", () => {
  test("per-chat AI replies per hour", async (t) => {
    const env = await setup(t, { config: { maxBusinessSendsPerMinute: 100 } });
    env.inbox.respond = (p) => reply(`a:${p.text}`);
    for (let i = 0; i < 5; i += 1) {
      await env.live(customerMsg(env.clock, `q${i}`));
      await env.settle();
    }
    assert.equal(env.sender.sent.length, 4);
    assert.equal(acks(env).at(-1)!.error, "chat_rate_limited");
  });

  test("per-business AI sends per minute, and a minimum gap between sends", async (t) => {
    const env = await setup(t);
    env.inbox.respond = (p) => reply(`a:${p.text}`, p.chatId);
    for (let i = 0; i < 4; i += 1) await env.live(customerMsg(env.clock, `q${i}`, { chatId: `1758555000${i}@s.whatsapp.net` }));
    await env.settle();
    assert.equal(env.sender.sent.length, 3);
    assert.equal(acks(env).at(-1)!.error, "business_rate_limited");
  });

  test("minimum gap is honoured between consecutive sends", async (t) => {
    const env = await setup(t, { config: { maxBusinessSendsPerMinute: 100 } });
    const times: number[] = [];
    env.sender.beforeSend = () => void times.push(env.clock.now());
    env.inbox.respond = () => ({ decision: "ESCALATE", reasons: ["complaint"], items: fx.messageResponseEscalate.outbox.map(({ kind, to, body }) => ({ kind, to, body })) });
    await env.live(customerMsg(env.clock, "torn bag"));
    await env.settle();
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 5_000);
  });

  test("an AI reply that reads as an unapproved commitment is not sent", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => reply("Great news, your order is confirmed!");
    await env.live(customerMsg(env.clock, "order 2 bags"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "unapproved_commitment");
  });
});

describe("send outcomes: failed and unknown are never reported as sent", () => {
  test("provably not sent → ack failed", async (t) => {
    const env = await setup(t);
    env.sender.mode = "not_sent";
    env.inbox.respond = () => reply("Yes.");
    await env.live(customerMsg(env.clock, "q"));
    await env.settle();
    assert.equal(acks(env)[0].status, "failed");
    assert.match(acks(env)[0].error!, /^not_sent/);
    assert.equal(env.inbox.outbox[0].status, "failed");
  });

  test("ambiguous send → NOT acked (stays dispatched), never retried, chat held for AI", async (t) => {
    const env = await setup(t);
    env.sender.mode = "ambiguous";
    env.inbox.respond = () => reply("Yes.");
    await env.live(customerMsg(env.clock, "q1"));
    await env.settle();
    assert.equal(acks(env).length, 0);
    assert.equal(env.inbox.outbox[0].status, "dispatched");
    assert.equal(env.bridge.status().unknownSends.length, 1);
    assert.equal(env.bridge.status().holds.length, 1);

    env.sender.mode = "ok";
    await env.settle(); // retry pass: still nothing re-sent
    assert.equal(env.sender.attempts, 1);

    await env.live(customerMsg(env.clock, "q2"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
    assert.equal(acks(env)[0].error, "held_after_unknown_send");

    // Human-authored answers still go out; clearing the hold re-enables AI.
    env.inbox.queueAdminAnswer({ ...fx.claimResponse.items[0] });
    await env.settle();
    assert.equal(env.sender.sent.length, 1);
    assert.equal(env.bridge.clearHold(fx.SLUG, fx.CUSTOMER_JID), true);
    await env.live(customerMsg(env.clock, "q3"));
    await env.settle();
    assert.equal(env.sender.sent.length, 2);
  });

  test("a transient ack failure is retried; the send never is", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => reply("Yes.");
    env.inbox.forceStatus.set(ACK, 500);
    await env.live(customerMsg(env.clock, "q"));
    await env.settle();
    assert.equal(env.inbox.outbox[0].status, "dispatched");
    env.inbox.forceStatus.delete(ACK);
    await env.settle(1);
    assert.equal(env.inbox.outbox[0].status, "sent");
    assert.equal(env.sender.attempts, 1);
  });
});

describe("restart safety", () => {
  test("a crash mid-send is recovered as unknown: not resent, not acked, chat held", async (t) => {
    const env = await setup(t);
    let crashedState: ReturnType<typeof emptyJournalState> | null = null;
    env.sender.beforeSend = () => {
      crashedState = structuredClone(env.journal.state); // snapshot as written before the socket call
      throw new Error("process killed");
    };
    env.inbox.respond = () => reply("Yes.");
    await env.live(customerMsg(env.clock, "q"));
    await env.settle();
    assert.equal(Object.values(crashedState!.outbox)[0].state, "sending");

    const sender = new FakeSender();
    const restarted = await setup(t, { inbox: env.inbox, clock: env.clock, sender, state: crashedState! });
    const acksBefore = acks(env).length;
    await restarted.settle(1);
    assert.equal(sender.attempts, 0);
    assert.equal(acks(env).length, acksBefore);
    assert.equal(restarted.bridge.status().unknownSends.length, 1);
    assert.equal(restarted.bridge.status().holds.length, 1);
  });

  test("pending forwards and recorded-but-unsent items survive a restart and are processed once", async (t) => {
    const clock = new Clock();
    const env = await setup(t, { clock });
    env.inbox.respond = (p) => reply(`a:${p.text}`);
    await env.live(customerMsg(clock, "queued before restart"));
    const state = structuredClone(env.journal.state);
    assert.equal(state.forwards.length, 1);

    const restarted = await setup(t, { inbox: env.inbox, clock, state });
    await restarted.settle();
    assert.deepEqual(restarted.sender.sent.map((s) => s.body), ["a:queued before restart"]);
    await restarted.settle();
    assert.equal(restarted.sender.sent.length, 1);
  });

  test("a disconnected session keeps work queued until reconnect", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => reply("Yes.");
    env.sender.connected = false;
    env.inbox.queueAdminAnswer({ ...fx.claimResponse.items[0] });
    await env.live(customerMsg(env.clock, "q"));
    await env.settle();
    assert.equal(env.inbox.calls(MESSAGE).length, 0);
    assert.equal(env.inbox.calls(CLAIM).length, 0);
    env.sender.connected = true;
    await env.settle();
    assert.equal(env.sender.sent.length, 2);
  });
});

describe("Inbox failures fail closed", () => {
  test("500s are retried with backoff then dropped; nothing is sent", async (t) => {
    const env = await setup(t);
    env.inbox.forceStatus.set(MESSAGE, 500);
    await env.live(customerMsg(env.clock, "q"));
    for (let i = 0; i < 5; i += 1) await env.settle(60_000);
    assert.equal(env.inbox.calls(MESSAGE).length, 3);
    assert.equal(env.journal.state.forwards.length, 0);
    assert.equal(env.sender.attempts, 0);
  });

  test("status 'error' → nothing to send", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => "error";
    await env.live(customerMsg(env.clock, "q"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env).length, 0);
  });

  test("claimed admin answers are sent and acked with the WhatsApp id, respecting pollOutboxSeconds", async (t) => {
    const env = await setup(t);
    env.inbox.queueAdminAnswer({ ...fx.claimResponse.items[0] });
    await env.settle(1);
    await env.settle(1_000);
    assert.equal(env.inbox.calls(CLAIM).length, 1);
    assert.equal(acks(env)[0].status, "sent");
    assert.equal(acks(env)[0].whatsappMessageId, env.sender.sent[0].messageId);
    await env.settle(10_000);
    assert.equal(env.inbox.calls(CLAIM).length, 2);
  });
});

describe("Observe mode staff notices", () => {
  const escalate = (extra: Array<{ kind: string; to: string; body: string }> = []) => () => ({
    decision: "ESCALATE",
    reasons: ["unverified_question"],
    items: [{ kind: "staff_notice", to: fx.STAFF_GROUP, body: "🔔 AI escalation #E-7K3QX (NORMAL)" }, ...extra]
  });
  const observeNotices = (env: { inbox: { config: unknown } }) => {
    env.inbox.config = structuredClone(fx.configObserveNotices);
  };

  test("an escalation notice is sent to the staff group and acked with its WhatsApp id; the customer gets nothing", async (t) => {
    const env = await setup(t);
    observeNotices(env);
    env.inbox.respond = escalate();
    await env.live(customerMsg(env.clock, "Do you have a vet discount?"));
    await env.settle();
    assert.equal(env.sender.sent.length, 1);
    assert.equal(env.sender.sent[0].jid, fx.STAFF_GROUP);
    assert.equal(env.sender.sent.filter((s) => s.jid === fx.CUSTOMER_JID).length, 0);
    assert.equal(acks(env)[0].status, "sent");
    assert.ok(acks(env)[0].whatsappMessageId);
  });

  test("customer-bound kinds are blocked even if the Inbox returns them next to the notice", async (t) => {
    const env = await setup(t);
    observeNotices(env);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = escalate([
      { kind: "holding_reply", to: fx.CUSTOMER_JID, body: "Passed to our team" },
      { kind: "customer_reply", to: fx.CUSTOMER_JID, body: "We open at 9." },
      { kind: "staff_relay", to: fx.CUSTOMER_JID, body: "Staff answer" },
      { kind: "staff_feedback", to: fx.STAFF_GROUP, body: "ack" },
      { kind: "brand_new_kind", to: fx.CUSTOMER_JID, body: "?" }
    ]);
    await env.live(customerMsg(env.clock, "Do you have a vet discount?"));
    await env.settle();
    assert.deepEqual(env.sender.sent.map((s) => s.jid), [fx.STAFF_GROUP]);
    const errors = acks(env).filter((a) => a.status === "failed").map((a) => a.error);
    assert.equal(errors.length, 5); // everything but the notice
    assert.ok(errors.every((e) => e === "observe_mode"));
  });

  test("staff notices switched off (default): the notice is blocked, not sent", async (t) => {
    const env = await setup(t);
    env.inbox.config = structuredClone(fx.configObserve);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = escalate();
    await env.live(customerMsg(env.clock, "Do you have a vet discount?"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "staff_notices_disabled");
  });

  test("an older Inbox that does not send staffNoticesEnabled is treated as off", async (t) => {
    const env = await setup(t);
    env.inbox.config = {
      pollOutboxSeconds: 10,
      businesses: [{ businessSlug: fx.SLUG, forwardMessages: true, mode: "observe", staffGroupJid: fx.STAFF_GROUP }]
    };
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = escalate();
    await env.live(customerMsg(env.clock, "hi"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "staff_notices_disabled");
  });

  test("AGENT_SEND_ENABLED=false blocks staff notices too", async (t) => {
    const env = await setup(t, { config: { sendEnabled: false } });
    observeNotices(env);
    env.inbox.respond = escalate();
    await env.live(customerMsg(env.clock, "Do you have a vet discount?"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "bridge_send_disabled");
  });

  test("a staff notice addressed to a customer chat or another business's group is blocked", async (t) => {
    const env = await setup(t);
    observeNotices(env);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => ({
      decision: "ESCALATE",
      reasons: ["x"],
      items: [
        { kind: "staff_notice", to: fx.CUSTOMER_JID, body: "to customer" },
        { kind: "staff_notice", to: "120363099999999999@g.us", body: "other business group" }
      ]
    });
    await env.live(customerMsg(env.clock, "hi"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.deepEqual(acks(env).map((a) => a.error), ["not_staff_group", "not_staff_group"]);
  });

  test("a repeated forward of the same message sends one notice", async (t) => {
    const env = await setup(t);
    observeNotices(env);
    env.inbox.respond = escalate();
    const msg = customerMsg(env.clock, "Do you have a vet discount?", { id: "3EB0SAMEMSG0000000001" });
    await env.live(msg);
    assert.equal(await env.live(msg), "duplicate");
    await env.settle();
    await env.settle();
    assert.equal(env.inbox.calls(MESSAGE).length, 1);
    assert.equal(env.sender.sent.length, 1);
  });

  test("a burst of notices is rate limited per business", async (t) => {
    const env = await setup(t);
    observeNotices(env);
    env.inbox.respond = () => ({
      decision: "ESCALATE",
      reasons: ["x"],
      items: Array.from({ length: 5 }, (_, i) => ({ kind: "staff_notice", to: fx.STAFF_GROUP, body: `notice ${i}` }))
    });
    await env.live(customerMsg(env.clock, "hi"));
    await env.settle();
    assert.equal(env.sender.sent.length, 3);
    assert.deepEqual(acks(env).filter((a) => a.status === "failed").map((a) => a.error), ["business_rate_limited", "business_rate_limited"]);
  });

  test("a staff reply to an Observe notice is forwarded for recording and nothing is sent anywhere", async (t) => {
    const env = await setup(t);
    observeNotices(env);
    env.inbox.respond = (p) =>
      p.chatId === fx.STAFF_GROUP
        ? { decision: "NO_REPLY", reasons: ["staff_group_matched:send"], items: [] }
        : { decision: "ESCALATE", reasons: ["x"], items: [{ kind: "staff_notice", to: fx.STAFF_GROUP, body: "🔔 notice" }] };
    await env.live(customerMsg(env.clock, "Do you have a vet discount?"));
    await env.settle();
    const noticeId = env.sender.sent[0].messageId;
    await env.live(staffGroupMsg(env.clock, "Yes, 10% for vets", { quoted: noticeId }));
    await env.settle();
    const forwarded = env.inbox.calls(MESSAGE).map((c) => c.body as { chatId: string; quotedMessageId: string | null });
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[1].chatId, fx.STAFF_GROUP);
    assert.equal(forwarded[1].quotedMessageId, noticeId);
    assert.equal(env.sender.sent.length, 1); // only the notice; the answer is never relayed
  });

  test("observe: the outbox is still never claimed, even with notices on", async (t) => {
    const env = await setup(t);
    observeNotices(env);
    await env.settle();
    assert.equal(env.inbox.calls(CLAIM).length, 0);
  });
});
