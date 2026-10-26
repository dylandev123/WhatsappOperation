import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Payload } from "./fakeInbox.js";
import * as fx from "./fixtures/inbox.js";
import { setup, staffGroupMsg, customerMsg, type Env } from "./helpers.js";

const MESSAGE = "/api/bridge/ai-agent/message";
const ORDERS_GROUP = "120363099999999999@g.us";
const OTHER_GROUP = "120363011111111111@g.us";
const forwarded = (env: Env) => env.inbox.calls(MESSAGE).map((c) => c.body as Payload);

function config(env: Env, mode: "observe" | "approval_pilot" | "assisted", over: { staffNoticesEnabled?: boolean; ordersGroupJid?: string | null } = {}) {
  env.inbox.config = {
    pollOutboxSeconds: 10,
    businesses: [{ businessSlug: fx.SLUG, forwardMessages: true, mode, staffGroupJid: fx.STAFF_GROUP, staffNoticesEnabled: over.staffNoticesEnabled ?? false, ordersGroupJid: over.ordersGroupJid === undefined ? ORDERS_GROUP : over.ordersGroupJid } as never]
  };
}
const inGroup = (env: Env, jid: string, text: string) => {
  const msg = staffGroupMsg(env.clock, text);
  msg.key.remoteJid = jid;
  return msg;
};

describe("Orders group (daily order summary)", () => {
  test("messages from the configured orders group are forwarded; other groups still are not", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot");
    await env.live(inGroup(env, ORDERS_GROUP, "!update"));
    await env.live(inGroup(env, OTHER_GROUP, "!update"));
    await env.settle();
    assert.deepEqual(forwarded(env).map((p) => p.chatId), [ORDERS_GROUP]);
  });

  test("without an orders group nothing changes: only the staff group is forwarded", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot", { ordersGroupJid: null });
    await env.live(inGroup(env, ORDERS_GROUP, "!update"));
    await env.live(staffGroupMsg(env.clock, "hello"));
    await env.settle();
    assert.deepEqual(forwarded(env).map((p) => p.chatId), [fx.STAFF_GROUP]);
  });

  test("a staff_notice to the orders group is sent in Approval Pilot, and in Observe only with notices on", async (t) => {
    for (const [mode, notices, sends] of [["approval_pilot", false, 1], ["observe", true, 1], ["observe", false, 0], ["assisted", false, 1]] as const) {
      const env = await setup(t);
      config(env, mode, { staffNoticesEnabled: notices });
      env.inbox.respond = () => ({ decision: "NO_REPLY", reasons: [], items: [{ kind: "staff_notice", to: ORDERS_GROUP, body: "📋 Orders" }] });
      await env.live(inGroup(env, ORDERS_GROUP, "!update"));
      await env.settle();
      assert.equal(env.sender.sent.length, sends, `${mode}/${notices}`);
      if (sends) assert.equal(env.sender.sent[0].jid, ORDERS_GROUP);
    }
  });

  test("the orders group never receives drafts or relays, and an unconfigured group never receives anything", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot");
    env.inbox.respond = () => ({
      decision: "NO_REPLY",
      reasons: [],
      items: [
        { kind: "staff_draft", to: ORDERS_GROUP, body: "draft" },
        { kind: "staff_relay", to: ORDERS_GROUP, body: "relay" },
        { kind: "staff_notice", to: OTHER_GROUP, body: "stray" }
      ]
    });
    await env.live(inGroup(env, ORDERS_GROUP, "!update"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
  });

  test("Approval Pilot is unchanged: the AI's own customer reply is still blocked", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot");
    env.inbox.respond = () => ({ decision: "REPLY", reasons: [], items: [{ kind: "customer_reply", to: fx.CUSTOMER_JID, body: "Hi" }] });
    await env.live(customerMsg(env.clock, "hello"));
    await env.settle();
    assert.equal(env.sender.sent.length, 0);
  });

  test("a scheduled summary claimed from the outbox poll is delivered to the orders group (Approval Pilot and Observe)", async (t) => {
    for (const mode of ["approval_pilot", "observe"] as const) {
      const env = await setup(t);
      config(env, mode, { staffNoticesEnabled: true });
      env.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "staff_notice", to: ORDERS_GROUP, body: "📋 Orders" });
      await env.settle();
      assert.deepEqual(env.sender.sent.map((s) => s.jid), [ORDERS_GROUP], mode);
    }
  });
});
