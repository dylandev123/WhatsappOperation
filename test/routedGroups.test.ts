import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Payload } from "./fakeInbox.js";
import * as fx from "./fixtures/inbox.js";
import { setup, staffGroupMsg, type Env } from "./helpers.js";

const MESSAGE = "/api/bridge/ai-agent/message";
const URGENT = "120363011111111112@g.us";
const COMPLAINTS = "120363011111111113@g.us";
const OTHER = "120363011111111199@g.us";
const forwarded = (env: Env) => env.inbox.calls(MESSAGE).map((c) => (c.body as Payload).chatId);

function config(env: Env, mode: "observe" | "approval_pilot" | "assisted", routed: string[] | null = [URGENT, COMPLAINTS], notices = false) {
  env.inbox.config = {
    pollOutboxSeconds: 10,
    businesses: [{ businessSlug: fx.SLUG, forwardMessages: true, mode, staffGroupJid: fx.STAFF_GROUP, staffNoticesEnabled: notices, ...(routed ? { routedGroupJids: routed } : {}) }]
  };
}
const inGroup = (env: Env, jid: string, text: string) => staffGroupMsg(env.clock, text, { group: jid });

describe("Rules & Routing groups", () => {
  test("messages from a routed group are forwarded like the staff group's; other groups still are not", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot");
    await env.live(inGroup(env, URGENT, "!approve"));
    await env.live(inGroup(env, COMPLAINTS, "!approve"));
    await env.live(inGroup(env, OTHER, "!approve"));
    await env.live(inGroup(env, fx.STAFF_GROUP, "!approve"));
    await env.settle();
    assert.deepEqual(forwarded(env).sort(), [COMPLAINTS, URGENT, fx.STAFF_GROUP].sort());
  });

  test("an older Inbox (no routedGroupJids) changes nothing", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot", null);
    await env.live(inGroup(env, URGENT, "!approve"));
    await env.settle();
    assert.deepEqual(forwarded(env), []);
  });

  test("notices, drafts and feedback go to a routed group in Approval Pilot; relays and customer kinds never do", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot");
    env.inbox.respond = () => ({
      decision: "NO_REPLY",
      reasons: [],
      items: [
        { kind: "staff_notice", to: URGENT, body: "🔔 notice" },
        { kind: "staff_draft", to: URGENT, body: "✍️ draft" },
        { kind: "staff_feedback", to: URGENT, body: "ok" },
        { kind: "staff_relay", to: URGENT, body: "relay" },
        { kind: "customer_reply", to: URGENT, body: "reply" }
      ]
    });
    await env.live(inGroup(env, URGENT, "!approve"));
    await env.settle(30_000);
    assert.deepEqual(env.sender.sent.map((s) => s.body).sort(), ["ok", "✍️ draft", "🔔 notice"].sort());
    assert.ok(env.sender.sent.every((s) => s.jid === URGENT));
  });

  test("a group the Inbox did not list as routed gets nothing", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot");
    env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [{ kind: "staff_notice", to: OTHER, body: "leak" }] });
    await env.live(inGroup(env, URGENT, "!approve"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
  });

  test("Observe: a staff_notice reaches a routed group only with notices on; feedback never", async (t) => {
    for (const [notices, expected] of [[true, ["🔔 notice"]], [false, []]] as const) {
      const env = await setup(t);
      config(env, "observe", [URGENT], notices);
      env.inbox.misbehaveInObserve = true;
      env.inbox.respond = () => ({
        decision: "NO_REPLY",
        reasons: [],
        items: [{ kind: "staff_notice", to: URGENT, body: "🔔 notice" }, { kind: "staff_feedback", to: URGENT, body: "fb" }]
      });
      await env.live(inGroup(env, URGENT, "hello"));
      await env.settle();
      assert.deepEqual(env.sender.sent.map((s) => s.body), expected, `notices=${notices}`);
    }
  });

  test("an item the Inbox claims for a routed group is sent; one for an unlisted group is never even handed out", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot");
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "staff_notice", to: COMPLAINTS, body: "📋 queued" });
    env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "staff_notice", to: OTHER, body: "📋 nope" });
    await env.settle(11_000);
    assert.deepEqual(env.sender.sent.map((s) => s.jid), [COMPLAINTS]);
    assert.equal(env.inbox.outbox.find((r) => r.to_jid === OTHER)?.status, "pending");
  });
});
