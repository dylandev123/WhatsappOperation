import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CallTracker, type CallEventLike, normalizeJid } from "../src/agent/calls.js";
import type { CallReportPayload } from "../src/agent/types.js";
import * as fx from "./fixtures/inbox.js";
import { setup, type Env } from "./helpers.js";

const CALLER = "17585550102@s.whatsapp.net";
const ME = "17585550001:7@s.whatsapp.net";
const MY_LID = "55500011122:7@lid";
const CALL = "/api/bridge/ai-agent/call";
const MISSED_TEXT = "Thanks for reaching out! Sorry we missed your call. We're unable to answer at the moment, but how can we help you?";

let seq = 0;
const ev = (status: string, over: Partial<CallEventLike> = {}): CallEventLike => ({
  chatId: CALLER, from: CALLER, id: "CALL-1", date: new Date("2026-10-22T14:00:00Z"), offline: false, status, ...over
});
function run(events: CallEventLike[], selfIds = [ME, MY_LID]): CallReportPayload[] {
  const tracker = new CallTracker(() => Date.parse("2026-10-22T14:00:30Z"));
  return events.flatMap((e) => tracker.handle("dog_food", e, selfIds) ?? []);
}

describe("call events → one report per finished call", () => {
  test("an incoming call that rings out: offer then timeout is one report with every fact", () => {
    const reports = run([ev("offer", { isVideo: false, isGroup: false, date: new Date("2026-10-22T14:00:00Z") }), ev("ringing"), ev("timeout", { date: new Date("2026-10-22T14:00:25Z") })]);
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0], {
      businessSlug: "dog_food", callId: "CALL-1", callerJid: CALLER, outgoing: false, isGroup: false, isVideo: false, offline: false,
      sawOffer: true, sawAccept: false, sawReject: false, finalStatus: "timeout", offerAt: "2026-10-22T14:00:00.000Z", endedAt: "2026-10-22T14:00:25.000Z"
    });
  });

  test("an answered call is reported once as answered; the terminate that follows is not a second report", () => {
    const reports = run([ev("offer"), ev("accept"), ev("terminate")]);
    assert.equal(reports.length, 1);
    assert.deepEqual([reports[0].finalStatus, reports[0].sawAccept], ["accept", true]);
  });

  test("a rejected call is reported as rejected", () => {
    const [r] = run([ev("offer"), ev("reject")]);
    assert.deepEqual([r.finalStatus, r.sawReject], ["reject", true]);
  });

  test("a call ended by a plain terminate is reported as terminate (the Inbox treats it as uncertain)", () => {
    const [r] = run([ev("offer"), ev("terminate")]);
    assert.equal(r.finalStatus, "terminate");
    assert.equal(r.sawAccept, false);
  });

  test("an outgoing call (created by this account, in either form) is flagged", () => {
    assert.equal(run([ev("offer", { from: ME, chatId: CALLER }), ev("timeout", { from: ME, chatId: CALLER })])[0].outgoing, true);
    assert.equal(run([ev("offer", { from: MY_LID, chatId: CALLER }), ev("timeout", { from: MY_LID, chatId: CALLER })])[0].outgoing, true);
    assert.equal(run([ev("offer"), ev("timeout")])[0].outgoing, false);
  });

  test("a group call is flagged however the group shows up", () => {
    assert.equal(run([ev("offer", { isGroup: true }), ev("timeout")])[0].isGroup, true);
    assert.equal(run([ev("offer", { groupJid: "120363000000000001@g.us" }), ev("timeout")])[0].isGroup, true);
    assert.equal(run([ev("offer", { chatId: "120363000000000001@g.us", from: CALLER }), ev("timeout", { chatId: "120363000000000001@g.us", from: CALLER })])[0].isGroup, true);
  });

  test("an offline replay, or a call whose offer was never seen, is flagged", () => {
    assert.equal(run([ev("offer", { offline: true }), ev("timeout", { offline: true })])[0].offline, true);
    const [r] = run([ev("timeout")]);
    assert.equal(r.sawOffer, false);
    assert.equal(r.offerAt, null);
  });

  test("the caller's device suffix is dropped, and an @lid caller is kept", () => {
    assert.equal(normalizeJid("17585550102:12@s.whatsapp.net"), CALLER);
    assert.equal(run([ev("offer", { chatId: "17585550102:12@s.whatsapp.net", from: "17585550102:12@s.whatsapp.net" }), ev("timeout", { chatId: "17585550102:12@s.whatsapp.net", from: "17585550102:12@s.whatsapp.net" })])[0].callerJid, CALLER);
    assert.equal(run([ev("offer", { chatId: "99887766@lid", from: "99887766@lid" }), ev("timeout", { chatId: "99887766@lid", from: "99887766@lid" })])[0].callerJid, "99887766@lid");
  });

  test("a call is reported once; a repeated timeout does not report again; calls do not mix", () => {
    const tracker = new CallTracker();
    const first = tracker.handle("dog_food", ev("offer"), [ME]);
    const t1 = tracker.handle("dog_food", ev("timeout"), [ME]);
    const t2 = tracker.handle("dog_food", ev("timeout"), [ME]);
    assert.deepEqual([first, t1 !== null, t2], [null, true, null]);
    assert.equal(tracker.handle("by_sea", ev("timeout"), [ME])?.sawOffer, false, "the same call id for another business is a different call");
  });
});

const callerReply = { kind: "missed_call_reply", to: CALLER, body: MISSED_TEXT };
function config(env: Env, mode: "observe" | "approval_pilot" | "assisted", over: { missedCallsEnabled?: boolean; staffNoticesEnabled?: boolean } = {}) {
  env.inbox.config = {
    pollOutboxSeconds: 10,
    businesses: [{ businessSlug: fx.SLUG, forwardMessages: true, mode, staffGroupJid: fx.STAFF_GROUP, staffNoticesEnabled: over.staffNoticesEnabled ?? false, missedCallsEnabled: over.missedCallsEnabled ?? true }]
  };
}
const report = (over: Partial<Omit<CallReportPayload, "businessSlug">> = {}): Omit<CallReportPayload, "businessSlug"> => ({
  callId: `C-${++seq}`, callerJid: CALLER, outgoing: false, isGroup: false, isVideo: false, offline: false, sawOffer: true, sawAccept: false, sawReject: false,
  finalStatus: "timeout", offerAt: "2026-10-22T13:59:40.000Z", endedAt: "2026-10-22T14:00:00.000Z", ...over
});

describe("the bridge and missed calls", () => {
  test("with the rule off (the default) a call is never even reported to the Inbox", async (t) => {
    const env = await setup(t);
    env.inbox.config = { pollOutboxSeconds: 10, businesses: [{ businessSlug: fx.SLUG, forwardMessages: true, mode: "assisted", staffGroupJid: fx.STAFF_GROUP }] };
    assert.equal(await env.bridge.onCallReport(fx.SLUG, report()), "missed_calls_disabled");
    config(env, "assisted", { missedCallsEnabled: false });
    await env.bridge.tick();
    assert.equal(await env.bridge.onCallReport(fx.SLUG, report()), "missed_calls_disabled");
    assert.equal(env.inbox.calls(CALL).length, 0);
    assert.equal(env.sender.sent.length, 0);
  });

  test("with the rule on, the report is sent and the Inbox's reply goes to the caller once, then is acked", async (t) => {
    const env = await setup(t);
    config(env, "assisted");
    env.inbox.callRespond = () => [callerReply];
    assert.equal(await env.bridge.onCallReport(fx.SLUG, report()), "replied");
    assert.equal(env.inbox.calls(CALL).length, 1);
    assert.equal((env.inbox.calls(CALL)[0].body as { businessSlug: string }).businessSlug, fx.SLUG);
    assert.deepEqual(env.sender.sent.map((s) => [s.jid, s.body]), [[CALLER, MISSED_TEXT]]);
    assert.equal(env.inbox.outbox[0].status, "sent");
    await env.settle();
    assert.equal(env.sender.sent.length, 1, "nothing is sent twice");
  });

  test("the Inbox saying nothing to send sends nothing", async (t) => {
    const env = await setup(t);
    config(env, "assisted");
    assert.equal(await env.bridge.onCallReport(fx.SLUG, report()), "reported");
    assert.equal(env.sender.sent.length, 0);
  });

  test("Observe mode never sends a missed-call reply, whatever the Inbox says", async (t) => {
    const env = await setup(t);
    config(env, "observe", { staffNoticesEnabled: true });
    env.inbox.callRespond = () => [callerReply];
    await env.bridge.onCallReport(fx.SLUG, report());
    assert.equal(env.sender.sent.length, 0);
    assert.match(env.inbox.outbox[0].error ?? "", /observe_mode/);
  });

  test("Approval Pilot sends it (an explicit, admin-written rule) but still sends no other AI kind from a call", async (t) => {
    const env = await setup(t);
    config(env, "approval_pilot");
    env.inbox.callRespond = () => [callerReply, { kind: "customer_reply", to: CALLER, body: "Anything else?" }, { kind: "staff_relay", to: CALLER, body: "x" }];
    await env.bridge.onCallReport(fx.SLUG, report());
    assert.deepEqual(env.sender.sent.map((s) => s.body), [MISSED_TEXT]);
  });

  test("if the rule was switched off since the last config, the reply is blocked at the bridge", async (t) => {
    const env = await setup(t);
    config(env, "assisted");
    env.inbox.callRespond = () => {
      // The admin turns it off while the report is in flight; the bridge's next config read sees it.
      config(env, "assisted", { missedCallsEnabled: false });
      return [callerReply];
    };
    await env.bridge.onCallReport(fx.SLUG, report());
    assert.equal(env.sender.sent.length, 1, "the cached config was still on when the item arrived");
    // A fresh config read blocks a queued one.
    const env2 = await setup(t);
    config(env2, "assisted");
    await env2.bridge.onCallReport(fx.SLUG, report());
    env2.inbox.queueAdminAnswer({ businessSlug: fx.SLUG, kind: "missed_call_reply", to: CALLER, body: MISSED_TEXT });
    config(env2, "assisted", { missedCallsEnabled: false });
    env2.clock.advance(61_000);
    await env2.bridge.tick();
    assert.equal(env2.sender.sent.length, 0);
    assert.match(env2.inbox.outbox[0].error ?? "", /missed_calls_disabled/);
  });

  test("a missed-call reply to a group is never sent", async (t) => {
    const env = await setup(t);
    config(env, "assisted");
    env.inbox.callRespond = () => [{ kind: "missed_call_reply", to: fx.STAFF_GROUP, body: MISSED_TEXT }];
    await env.bridge.onCallReport(fx.SLUG, report());
    assert.equal(env.sender.sent.length, 0);
  });

  test("an Inbox failure sends nothing and does not throw", async (t) => {
    const env = await setup(t);
    config(env, "assisted");
    env.inbox.forceStatus.set(CALL, 500);
    assert.equal(await env.bridge.onCallReport(fx.SLUG, report()), "report_failed");
    assert.equal(env.sender.sent.length, 0);
  });

  test("a per-chat reply limit still applies to missed-call replies", async (t) => {
    const env = await setup(t, { config: { maxChatRepliesPerHour: 1, minSendGapMs: 0 } });
    config(env, "assisted");
    env.inbox.callRespond = () => [callerReply];
    await env.bridge.onCallReport(fx.SLUG, report());
    await env.bridge.onCallReport(fx.SLUG, report());
    assert.equal(env.sender.sent.length, 1);
  });
});
