import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Payload, ScriptedItem } from "./fakeInbox.js";
import * as fx from "./fixtures/inbox.js";
import { customerMsg, setup, staffGroupMsg, type Env } from "./helpers.js";

const ACK = "/api/bridge/ai-agent/ack";
const CLAIM = "/api/bridge/ai-agent/outbox/claim";
const acks = (env: Env) => env.inbox.calls(ACK).map((c) => c.body as { outboxId: string; status: string; whatsappMessageId: string | null; error: string | null });

const pilot = (env: Env) => {
  env.inbox.config = structuredClone(fx.configPilot);
};
const staffItem = (kind: string, body = "post"): ScriptedItem => ({ kind, to: fx.STAFF_GROUP, body });
const relay = (body = "Approved: EC$90", to = fx.CUSTOMER_JID): ScriptedItem => ({ kind: "staff_relay", to, body });

describe("Approval Pilot mode", () => {
  test("the staff group gets notices, drafts and feedback (no staffNoticesEnabled needed); each is acked with its WhatsApp id", async (t) => {
    const env = await setup(t);
    pilot(env);
    env.inbox.respond = () => ({ decision: "ESCALATE", reasons: [], items: [staffItem("staff_notice"), staffItem("staff_draft", "draft"), staffItem("staff_feedback", "ok")] });
    await env.live(customerMsg(env.clock, "How much is the bag?"));
    await env.settle();
    assert.equal(env.sender.sent.length, 3);
    assert.ok(env.sender.sent.every((s) => s.jid === fx.STAFF_GROUP));
    assert.ok(acks(env).every((a) => a.status === "sent" && a.whatsappMessageId));
  });

  test("an approved reply (staff_relay) is delivered to the customer verbatim", async (t) => {
    const env = await setup(t);
    pilot(env);
    env.inbox.respond = (p: Payload) => (p.chatId === fx.STAFF_GROUP ? { decision: "NO_REPLY", reasons: [], items: [relay("The 15kg bag costs EC$90.")] } : { decision: "NO_REPLY", reasons: [], items: [] });
    await env.live(staffGroupMsg(env.clock, "!approve", { quoted: "3EB0NOTICE" }));
    await env.settle();
    assert.equal(env.sender.sent.length, 1);
    assert.equal(env.sender.sent[0].jid, fx.CUSTOMER_JID);
    assert.equal(env.sender.sent[0].body, "The 15kg bag costs EC$90.");
    assert.equal(acks(env)[0].status, "sent");
  });

  test("the AI's own customer kinds are blocked even if the Inbox returned them as sendable", async (t) => {
    const env = await setup(t);
    pilot(env);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => ({
      decision: "REPLY",
      reasons: [],
      items: [{ kind: "customer_reply", to: fx.CUSTOMER_JID, body: "Hi" }, { kind: "holding_reply", to: fx.CUSTOMER_JID, body: "Passed to the team" }, { kind: "mystery_kind", to: fx.CUSTOMER_JID, body: "?" }]
    });
    await env.live(customerMsg(env.clock, "hello"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
    assert.deepEqual(acks(env).map((a) => a.error), ["approval_pilot_mode", "approval_pilot_mode", "approval_pilot_mode"]);
  });

  test("a staff_relay is never posted into the staff group, and a staff-group kind never goes to a customer", async (t) => {
    const env = await setup(t);
    pilot(env);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [relay("x", fx.STAFF_GROUP), { kind: "staff_notice", to: fx.CUSTOMER_JID, body: "internal" }] });
    await env.live(staffGroupMsg(env.clock, "!approve"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
    assert.deepEqual(acks(env).map((a) => a.error), ["approval_pilot_mode", "not_staff_group"]);
  });

  test("a staff-group post to a different group is refused", async (t) => {
    const env = await setup(t);
    pilot(env);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [{ kind: "staff_feedback", to: "120363099999999999@g.us", body: "x" }] });
    await env.live(staffGroupMsg(env.clock, "!status"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
    assert.equal(acks(env)[0].error, "not_staff_group");
  });

  test("the outbox is polled in Approval Pilot, so an approved dashboard send is delivered", async (t) => {
    const env = await setup(t);
    pilot(env);
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "staff_relay", to: fx.CUSTOMER_JID, body: "Approved from the dashboard" });
    await env.settle();
    assert.ok(env.inbox.calls(CLAIM).length >= 1);
    assert.equal(env.sender.sent.length, 1);
    assert.equal(env.sender.sent[0].body, "Approved from the dashboard");
  });

  test("an approved send respects a hold after an earlier send of unknown outcome; clearing the hold lets it through", async (t) => {
    const env = await setup(t);
    pilot(env);
    env.sender.mode = "ambiguous";
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [relay("first")] });
    await env.live(staffGroupMsg(env.clock, "!approve"));
    await env.settle();
    assert.equal(env.bridge.status().holds.length, 1);

    env.sender.mode = "ok";
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [relay("second")] });
    await env.live(staffGroupMsg(env.clock, "!approve again"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
    assert.equal(acks(env).at(-1)!.error, "held_after_unknown_send");
  });

  test("a mode the bridge does not know still fails closed", async (t) => {
    const env = await setup(t);
    env.inbox.config = { pollOutboxSeconds: 10, businesses: [{ businessSlug: fx.SLUG, forwardMessages: true, mode: "approval_pilot_v2", staffGroupJid: fx.STAFF_GROUP }] };
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [relay("x")] });
    await env.live(staffGroupMsg(env.clock, "!approve"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
    assert.equal(acks(env)[0].error, "observe_mode");
  });

  test("Observe is unchanged: a staff_relay and staff_feedback are still refused", async (t) => {
    const env = await setup(t);
    env.inbox.config = structuredClone(fx.configObserveNotices);
    env.inbox.misbehaveInObserve = true;
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [relay("x"), staffItem("staff_feedback")] });
    await env.live(staffGroupMsg(env.clock, "!approve"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
    assert.deepEqual(acks(env).map((a) => a.error), ["observe_mode", "observe_mode"]);
  });
});
