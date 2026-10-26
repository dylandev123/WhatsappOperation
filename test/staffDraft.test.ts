import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage } from "../src/agent/messages.js";
import { emptyJournalState } from "../src/agent/journal.js";
import type { Payload, ScriptedItem } from "./fakeInbox.js";
import * as fx from "./fixtures/inbox.js";
import { Clock, customerMsg, setup, staffGroupMsg, type Env } from "./helpers.js";

const MESSAGE = "/api/bridge/ai-agent/message";
const ACK = "/api/bridge/ai-agent/ack";
const CLAIM = "/api/bridge/ai-agent/outbox/claim";

const acks = (env: Env) =>
  env.inbox.calls(ACK).map((c) => c.body as { outboxId: string; status: string; whatsappMessageId: string | null; error: string | null });
const forwarded = (env: Env) => env.inbox.calls(MESSAGE).map((c) => c.body as Payload);

const CUSTOMER_B = "17585552222@s.whatsapp.net";
const draft = (body: string, extra: Partial<ScriptedItem> = {}): ScriptedItem => ({ kind: "staff_draft", to: fx.STAFF_GROUP, body, ...extra });

function observe(env: Env, enabled = true) {
  env.inbox.config = structuredClone(enabled ? fx.configObserveNotices : fx.configObserve);
}

describe("staff_draft delivery", () => {
  test("Observe + notices on: a draft is sent to the staff group, quoting the staff message, and acked with its WhatsApp id", async (t) => {
    const env = await setup(t);
    observe(env);
    env.inbox.respond = (p) =>
      p.chatId === fx.STAFF_GROUP ? { decision: "NO_REPLY", reasons: ["staff_answer"], items: [draft("✍️ Draft reply for #E-7K3QX", { replyToMessageId: p.whatsappMessageId })] } : { decision: "NO_REPLY", reasons: [], items: [] };
    const staff = staffGroupMsg(env.clock, "Yes, 10% for vets", { quoted: "3EB0NOTICE" });
    await env.live(staff);
    await env.settle();

    assert.equal(env.sender.sent.length, 1);
    assert.equal(env.sender.sent[0].jid, fx.STAFF_GROUP);
    assert.equal(env.sender.sent[0].quotedMessageId, staff.key.id);
    const [ack] = acks(env);
    assert.equal(ack.status, "sent");
    assert.equal(ack.whatsappMessageId, env.sender.sent[0].messageId);
    assert.deepEqual(env.inbox.draftMessageIds, [env.sender.sent[0].messageId]);
  });

  test("Assisted mode delivers drafts too, without a quote when none is supplied", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [draft("✍️ Draft")] });
    await env.live(staffGroupMsg(env.clock, "answer"));
    await env.settle();
    assert.equal(env.sender.sent[0].quotedMessageId, null);
    assert.equal(acks(env)[0].status, "sent");
  });

  test("a customer-addressed send never carries a quote target", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => ({ decision: "REPLY", reasons: [], items: [{ kind: "customer_reply", to: fx.CUSTOMER_JID, body: "Hi", replyToMessageId: "3EB0X" }] });
    await env.live(customerMsg(env.clock, "hello"));
    await env.settle();
    assert.equal(env.sender.sent[0].quotedMessageId, null);
  });

  test("the quote target survives a restart between /message and the send", async (t) => {
    const state = emptyJournalState();
    const env1 = await setup(t, { state });
    observe(env1);
    env1.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [draft("✍️ Draft", { replyToMessageId: "3EB0STAFFMSG" })] });
    // Disconnect so the item stays recorded-but-unsent, then "restart" with the same journal.
    env1.sender.beforeSend = null;
    env1.sender.connected = false;
    await env1.live(staffGroupMsg(env1.clock, "answer"));
    await env1.settle();
    assert.equal(env1.sender.sent.length, 0);

    const sender2 = new (env1.sender.constructor as new () => typeof env1.sender)();
    const env2 = await setup(t, { state, inbox: env1.inbox, clock: env1.clock, sender: sender2 });
    await env2.settle(1);
    assert.equal(sender2.sent.length, 1);
    assert.equal(sender2.sent[0].quotedMessageId, "3EB0STAFFMSG");
  });
});

describe("staff_draft restrictions", () => {
  test("Observe + notices off: drafts are blocked as staff_notices_disabled", async (t) => {
    const env = await setup(t);
    observe(env, false);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [draft("✍️ Draft")] });
    await env.live(staffGroupMsg(env.clock, "answer"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "staff_notices_disabled");
  });

  test("AGENT_SEND_ENABLED=false blocks drafts", async (t) => {
    const env = await setup(t, { config: { sendEnabled: false } });
    observe(env);
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [draft("✍️ Draft")] });
    await env.live(staffGroupMsg(env.clock, "answer"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
    assert.equal(acks(env)[0].error, "bridge_send_disabled");
  });

  test("a draft is never sent to a customer chat or another group, in Observe or Assisted", async (t) => {
    for (const assisted of [false, true]) {
      const env = await setup(t);
      if (!assisted) observe(env);
      env.inbox.misbehaveInObserve = true;
      env.inbox.respond = () => ({
        decision: "NO_REPLY",
        reasons: [],
        items: [draft("to customer", { to: fx.CUSTOMER_JID }), draft("to lid", { to: fx.LID_JID }), draft("other group", { to: "120363099999999999@g.us" })]
      });
      await env.live(staffGroupMsg(env.clock, "answer"));
      await env.settle();
      assert.equal(env.sender.attempts, 0, `assisted=${assisted}`);
      assert.deepEqual(acks(env).map((a) => a.error), ["not_staff_group", "not_staff_group", "not_staff_group"]);
    }
  });

  test("staff_notice and staff_feedback addressed to a customer are refused in Assisted mode too", async (t) => {
    const env = await setup(t);
    env.inbox.respond = () => ({
      decision: "NO_REPLY",
      reasons: [],
      items: [{ kind: "staff_notice", to: fx.CUSTOMER_JID, body: "n" }, { kind: "staff_feedback", to: fx.CUSTOMER_JID, body: "f" }]
    });
    await env.live(staffGroupMsg(env.clock, "answer"));
    await env.settle();
    assert.equal(env.sender.attempts, 0);
  });

  test("Observe: customer-bound kinds next to a draft are still blocked", async (t) => {
    const env = await setup(t);
    observe(env);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => ({
      decision: "NO_REPLY",
      reasons: [],
      items: [draft("✍️ Draft"), { kind: "staff_relay", to: fx.CUSTOMER_JID, body: "relay" }, { kind: "customer_reply", to: fx.CUSTOMER_JID, body: "reply" }]
    });
    await env.live(staffGroupMsg(env.clock, "!send"));
    await env.settle();
    assert.deepEqual(env.sender.sent.map((s) => s.jid), [fx.STAFF_GROUP]);
    assert.deepEqual(acks(env).filter((a) => a.status === "failed").map((a) => a.error), ["observe_mode", "observe_mode"]);
  });

  test("drafts are rate limited per business like notices", async (t) => {
    const env = await setup(t);
    observe(env);
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: Array.from({ length: 5 }, (_, i) => draft(`draft ${i}`)) });
    await env.live(staffGroupMsg(env.clock, "answer"));
    await env.settle();
    assert.equal(env.sender.sent.length, 3);
    assert.deepEqual(acks(env).filter((a) => a.status === "failed").map((a) => a.error), ["business_rate_limited", "business_rate_limited"]);
  });

  test("unknown-send hold on a customer chat does not touch staff-group drafts, and an ambiguous draft is not acked", async (t) => {
    const env = await setup(t);
    observe(env);
    env.sender.mode = "ambiguous";
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [draft("✍️ Draft")] });
    await env.live(staffGroupMsg(env.clock, "answer"));
    await env.settle();
    assert.equal(acks(env).length, 0);
    assert.equal(env.bridge.status().unknownSends.length, 1);
    assert.equal(env.bridge.status().holds.length, 0); // groups are never held
  });
});

describe("staff sender identity", () => {
  const clock = new Clock();

  test("senderJid is forwarded for every staff-group message that has one", () => {
    const c = classifyMessage(staffGroupMsg(clock, "x", { participant: "17585557777@s.whatsapp.net" }));
    assert.ok(c.kind === "group" && c.payload.senderJid === "17585557777@s.whatsapp.net" && c.payload.senderPhone === null);
  });

  test("@lid participant with participantPn forwards senderJid and the reported phone", () => {
    const c = classifyMessage(staffGroupMsg(clock, "x", { participant: "112233445566778@lid", participantPn: "17585551111@s.whatsapp.net" }));
    assert.ok(c.kind === "group");
    if (c.kind === "group") {
      assert.equal(c.payload.senderJid, "112233445566778@lid");
      assert.equal(c.payload.senderPhone, "17585551111");
    }
  });

  test("@lid participant without participantPn: senderPhone is null, never the @lid digits", () => {
    const c = classifyMessage(staffGroupMsg(clock, "x", { participant: "112233445566778@lid" }));
    assert.ok(c.kind === "group");
    if (c.kind === "group") {
      assert.equal(c.payload.senderJid, "112233445566778@lid");
      assert.equal(c.payload.senderPhone, null);
    }
  });

  test("garbage participantPn is rejected; participantPn on a phone-JID participant is ignored", () => {
    for (const participantPn of ["112233445566778@lid", "not a phone", "@s.whatsapp.net"]) {
      const c = classifyMessage(staffGroupMsg(clock, "x", { participant: "112233445566778@lid", participantPn }));
      assert.ok(c.kind === "group" && c.payload.senderPhone === null, participantPn);
    }
    const c = classifyMessage(staffGroupMsg(clock, "x", { participant: fx.STAFF_MEMBER, participantPn: "17585550000@s.whatsapp.net" }));
    assert.ok(c.kind === "group" && c.payload.senderPhone === null);
  });

  test("a fromMe staff-group message the bridge cannot attribute has senderJid null (the Inbox treats it as unauthorized)", () => {
    const c = classifyMessage(staffGroupMsg(clock, "!send", { fromMe: true }));
    assert.ok(c.kind === "group" && c.payload.senderJid === null && c.payload.senderPhone === null);
  });

  test("1:1 messages never carry sender identity", () => {
    const c = classifyMessage(customerMsg(clock, "hi", { chatId: fx.LID_JID, senderPn: "17585550000@s.whatsapp.net" }));
    assert.ok(c.kind === "direct" && c.payload.senderJid === null && c.payload.senderPhone === null);
  });

  test("the wire payload carries senderJid and senderPhone to the Inbox", async (t) => {
    const env = await setup(t);
    await env.live(staffGroupMsg(env.clock, "!send", { participant: "112233445566778@lid", participantPn: "17585551111@s.whatsapp.net", quoted: "3EB0DRAFT" }));
    await env.settle();
    const [p] = forwarded(env);
    assert.equal(p.senderJid, "112233445566778@lid");
    assert.equal(p.senderPhone, "17585551111");
    assert.equal(p.quotedMessageId, "3EB0DRAFT");
  });
});

describe("quoted !send replies resolve to the exact draft", () => {
  // Inbox stand-in: customers A and B each have an escalation and a draft; "send"
  // authorizes only the draft that the staff message quotes (escalations.ts).
  function twoDrafts(env: Env) {
    observe(env);
    const drafts = new Map<string, string>(); // WhatsApp draft id -> customer chat
    const pending: Array<{ customer: string; body: string }> = [];
    env.inbox.respond = (p, inbox) => {
      if (p.chatId !== fx.STAFF_GROUP) return { decision: "NO_REPLY", reasons: [], items: [] };
      const customer = drafts.get(p.quotedMessageId as string);
      if (/^(!send|send)$/i.test(p.text.trim()) && customer) {
        // Observe never sends to customers; a real Inbox would only record this.
        return { decision: "NO_REPLY", reasons: [`authorized:${customer}`], items: [{ kind: "staff_relay", to: customer, body: "relay" }] };
      }
      const next = pending.shift();
      return { decision: "NO_REPLY", reasons: [], items: next && !inbox.draftMessageIds.includes(p.quotedMessageId as string) ? [draft(next.body)] : [] };
    };
    return { drafts, pending };
  }

  test("!send quoting draft A forwards exactly A's WhatsApp id; B's id is never substituted", async (t) => {
    const env = await setup(t);
    const { drafts, pending } = twoDrafts(env);
    pending.push({ customer: fx.CUSTOMER_JID, body: "✍️ Draft for A" }, { customer: CUSTOMER_B, body: "✍️ Draft for B" });
    await env.live(staffGroupMsg(env.clock, "answer for A"));
    await env.settle();
    await env.live(staffGroupMsg(env.clock, "answer for B"));
    await env.settle();
    const [draftA, draftB] = env.sender.sent.map((s) => s.messageId);
    assert.notEqual(draftA, draftB);
    assert.deepEqual(env.inbox.draftMessageIds, [draftA, draftB]);
    drafts.set(draftA, fx.CUSTOMER_JID);
    drafts.set(draftB, CUSTOMER_B);

    await env.live(staffGroupMsg(env.clock, "!send", { quoted: draftA }));
    await env.settle();
    const last = forwarded(env).at(-1)!;
    assert.equal(last.quotedMessageId, draftA);
    assert.notEqual(last.quotedMessageId, draftB);
    // Observe: the (misbehaving) relay to the customer is blocked, nothing reaches A or B.
    assert.equal(env.sender.sent.filter((s) => s.jid !== fx.STAFF_GROUP).length, 0);
  });

  test("a bare !send with no quote is forwarded with quotedMessageId null — the bridge never guesses a draft", async (t) => {
    const env = await setup(t);
    const { drafts, pending } = twoDrafts(env);
    pending.push({ customer: fx.CUSTOMER_JID, body: "✍️ Draft for A" });
    await env.live(staffGroupMsg(env.clock, "answer for A"));
    await env.settle();
    drafts.set(env.sender.sent[0].messageId, fx.CUSTOMER_JID);
    await env.live(staffGroupMsg(env.clock, "!send"));
    await env.settle();
    assert.equal(forwarded(env).at(-1)!.quotedMessageId, null);
  });

  test("an explicit #E reference is forwarded verbatim alongside the exact quote", async (t) => {
    const env = await setup(t);
    await env.live(staffGroupMsg(env.clock, "#E-7K3QX !send", { quoted: "3EB0DRAFTB" }));
    await env.settle();
    const p = forwarded(env)[0];
    assert.equal(p.text, "#E-7K3QX !send");
    assert.equal(p.quotedMessageId, "3EB0DRAFTB");
  });

  test("two concurrent drafts are each acked with their own id", async (t) => {
    const env = await setup(t);
    observe(env);
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [draft("draft one"), draft("draft two")] });
    await env.live(staffGroupMsg(env.clock, "answers"));
    await env.settle();
    const sent = env.sender.sent;
    assert.equal(sent.length, 2);
    const byOutbox = acks(env);
    assert.deepEqual(byOutbox.map((a) => a.whatsappMessageId), sent.map((s) => s.messageId));
    assert.equal(new Set(byOutbox.map((a) => a.outboxId)).size, 2);
  });
});

describe("duplicate events", () => {
  test("a repeated staff-group event is forwarded once and yields one draft", async (t) => {
    const env = await setup(t);
    observe(env);
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [draft("✍️ Draft")] });
    const msg = staffGroupMsg(env.clock, "answer");
    await env.live(msg);
    assert.equal(await env.live(msg), "duplicate");
    await env.settle();
    await env.live(msg);
    await env.settle();
    assert.equal(env.inbox.calls(MESSAGE).length, 1);
    assert.equal(env.sender.sent.length, 1);
  });

  test("a re-forward after losing the journal comes back duplicate/send:false and sends no second draft", async (t) => {
    const env = await setup(t);
    observe(env);
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [draft("✍️ Draft")] });
    const msg = staffGroupMsg(env.clock, "answer");
    await env.live(msg);
    await env.settle();
    const env2 = await setup(t, { inbox: env.inbox, clock: env.clock });
    await env2.live(msg);
    await env2.settle();
    assert.equal(env.inbox.calls(MESSAGE).length, 2);
    assert.equal(env.sender.sent.length + env2.sender.sent.length, 1);
  });
});

describe("outbox polling does not depend on incoming messages", () => {
  test("Observe + notices: a queued batching result (staff_notice) is claimed, sent and acked with no new WhatsApp traffic", async (t) => {
    const env = await setup(t);
    observe(env);
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "staff_notice", to: fx.STAFF_GROUP, body: "🔔 AI escalation #E-7K3QX" });
    await env.settle(10_000);
    assert.equal(env.inbox.calls(MESSAGE).length, 0);
    assert.equal(env.inbox.calls(CLAIM).length, 1);
    assert.equal(env.sender.sent.length, 1);
    assert.equal(env.sender.sent[0].jid, fx.STAFF_GROUP);
    assert.equal(acks(env)[0].whatsappMessageId, env.sender.sent[0].messageId);
  });

  test("Assisted: a queued customer_reply from a finished batch is delivered by polling alone", async (t) => {
    const env = await setup(t);
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "customer_reply", to: fx.CUSTOMER_JID, body: "Batched answer" });
    await env.settle(10_000);
    assert.equal(env.inbox.calls(MESSAGE).length, 0);
    assert.equal(env.sender.sent[0].body, "Batched answer");
  });

  test("Observe: a claimed customer-bound item (Inbox misbehaviour) is blocked, never sent", async (t) => {
    const env = await setup(t);
    observe(env);
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "staff_notice", to: fx.STAFF_GROUP, body: "n" });
    // Not permitted by the claim function in Observe, so it is simply never handed out.
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "customer_reply", to: fx.CUSTOMER_JID, body: "x" });
    await env.settle(10_000);
    assert.deepEqual(env.sender.sent.map((s) => s.jid), [fx.STAFF_GROUP]);
    assert.equal(env.inbox.outbox.find((r) => r.kind === "customer_reply")!.status, "pending");
  });

  test("Observe + notices off: nothing is claimed", async (t) => {
    const env = await setup(t);
    observe(env, false);
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "staff_notice", to: fx.STAFF_GROUP, body: "n" });
    await env.settle(10_000);
    assert.equal(env.inbox.calls(CLAIM).length, 0);
    assert.equal(env.sender.attempts, 0);
  });

  test("AGENT_SEND_ENABLED=false: Observe items stay pending, not claimed", async (t) => {
    const env = await setup(t, { config: { sendEnabled: false } });
    observe(env);
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "staff_notice", to: fx.STAFF_GROUP, body: "n" });
    await env.settle(10_000);
    assert.equal(env.inbox.calls(CLAIM).length, 0);
  });
});
