import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createInboxClient, parseConfigResponse, parseMessageResponse, SECRET_HEADER } from "../src/agent/inboxClient.js";
import { InboxHttpError } from "../src/agent/types.js";
import { FakeInbox } from "./fakeInbox.js";
import * as fx from "./fixtures/inbox.js";
import { customerMsg, phoneMsg, reply, setup, staffGroupMsg } from "./helpers.js";

async function serve(t: { after: (fn: () => Promise<void>) => void }, secret: string | null = fx.SECRET) {
  const inbox = new FakeInbox(secret);
  await inbox.listen();
  t.after(() => inbox.close());
  return inbox;
}

describe("contract fixtures parse exactly as the Inbox sends them", () => {
  test("config: seeded OFF/observe and assisted", () => {
    assert.deepEqual(parseConfigResponse(fx.configSeeded).businesses[0], {
      businessSlug: "dog_food",
      forwardMessages: false,
      mode: "observe",
      staffGroupJid: null,
      staffNoticesEnabled: false
    });
    assert.equal(parseConfigResponse(fx.configAssisted).businesses[0].staffGroupJid, fx.STAFF_GROUP);
    assert.equal(parseConfigResponse(fx.configObserveNotices).businesses[0].staffNoticesEnabled, true);
    assert.equal(parseConfigResponse(fx.configObserve).businesses[0].staffNoticesEnabled, false);
  });

  test("message: done/REPLY keeps send:true; duplicate, error and ignored never send", () => {
    assert.equal(parseMessageResponse(fx.messageResponseReply).outbox[0].send, true);
    assert.ok(parseMessageResponse(fx.messageResponseDuplicate).outbox.every((i) => !i.send));
    assert.deepEqual(parseMessageResponse(fx.messageResponseError).outbox, []);
    assert.deepEqual(parseMessageResponse(fx.messageResponseIgnored).outbox, []);
    // Even if a non-done response carried send:true, it is forced off.
    const bogus = { ...fx.messageResponseDuplicate, outbox: fx.messageResponseReply.outbox };
    assert.ok(parseMessageResponse(bogus).outbox.every((i) => !i.send));
  });

  test("message: send must be literally true; unknown kinds are kept", () => {
    const r = parseMessageResponse({
      ...fx.messageResponseReply,
      outbox: [
        { ...fx.messageResponseReply.outbox[0], send: "true" },
        { ...fx.messageResponseReply.outbox[0], id: "x", kind: "future_kind" }
      ]
    });
    assert.equal(r.outbox[0].send, false);
    assert.equal(r.outbox[1].kind, "future_kind");
    assert.equal(r.outbox[1].send, true);
  });

  test("message: malformed responses throw (caller sends nothing)", () => {
    assert.throws(() => parseMessageResponse({ status: "done" }));
    assert.throws(() => parseMessageResponse({ status: "maybe", outbox: [] }));
    assert.throws(() => parseMessageResponse({ ...fx.messageResponseReply, outbox: [{ id: "x", send: true }] }));
  });
});

describe("HTTP client against Inbox route semantics", () => {
  test("sends x-ai-agent-secret and the exact contract payload", async (t) => {
    const inbox = await serve(t);
    inbox.respond = () => reply("Yes — we deliver to Gros Islet on Tuesdays and Fridays.");
    const client = createInboxClient({ baseUrl: `${inbox.url}/`, secret: fx.SECRET });
    const res = await client.forwardMessage(fx.messageRequestInbound);
    const call = inbox.calls("/api/bridge/ai-agent/message")[0];
    assert.equal(call.headers[SECRET_HEADER], fx.SECRET);
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.body, fx.messageRequestInbound);
    assert.equal(res.status, "done");
    assert.equal(res.outbox[0].kind, "customer_reply");
    assert.equal(res.outbox[0].send, true);
  });

  test("retry of the same whatsappMessageId → duplicate, send:false", async (t) => {
    const inbox = await serve(t);
    inbox.respond = () => reply("Yes.");
    const client = createInboxClient({ baseUrl: inbox.url, secret: fx.SECRET });
    await client.forwardMessage(fx.messageRequestInbound);
    const again = await client.forwardMessage(fx.messageRequestInbound);
    assert.equal(again.status, "duplicate");
    assert.equal(again.outbox.length, 1);
    assert.equal(again.outbox[0].send, false);
  });

  test("401 / 503 / 400 are not retryable; 500 and transport errors are", async (t) => {
    const inbox = await serve(t);
    const wrong = createInboxClient({ baseUrl: inbox.url, secret: "nope" });
    await assert.rejects(wrong.forwardMessage(fx.messageRequestInbound), (e: InboxHttpError) => e.status === 401 && !e.retryable);

    const unconfigured = await serve(t, null);
    const c503 = createInboxClient({ baseUrl: unconfigured.url, secret: fx.SECRET });
    await assert.rejects(c503.getConfig(), (e: InboxHttpError) => e.status === 503);

    const client = createInboxClient({ baseUrl: inbox.url, secret: fx.SECRET });
    await assert.rejects(
      client.forwardMessage({ ...fx.messageRequestInbound, chatId: "" }),
      (e: InboxHttpError) => e.status === 400 && !e.retryable
    );
    inbox.respond = () => "throw";
    await assert.rejects(
      client.forwardMessage({ ...fx.messageRequestInbound, whatsappMessageId: "OTHER" }),
      (e: InboxHttpError) => e.status === 500 && e.retryable
    );
    const down = createInboxClient({ baseUrl: "http://127.0.0.1:9", secret: fx.SECRET });
    await assert.rejects(down.forwardMessage(fx.messageRequestInbound), (e: InboxHttpError) => e.status === null && e.retryable);
  });

  test("ack: ok, idempotent repeat ok, 404 and 409 rejected", async (t) => {
    const inbox = await serve(t);
    inbox.respond = () => reply("Yes.");
    const client = createInboxClient({ baseUrl: inbox.url, secret: fx.SECRET });
    const { outbox } = await client.forwardMessage(fx.messageRequestInbound);
    const ack = { outboxId: outbox[0].id, status: "sent" as const, whatsappMessageId: "3EB0X", error: null };
    assert.equal(await client.ack(ack), "ok");
    assert.equal(await client.ack(ack), "ok");
    assert.equal(await client.ack({ ...ack, status: "failed" }), "rejected"); // 409
    assert.equal(await client.ack({ ...ack, outboxId: "00000000-0000-4000-8000-000000000000" }), "rejected"); // 404
    assert.equal(inbox.outbox[0].status, "sent");
    assert.equal(inbox.outbox[0].whatsapp_message_id, "3EB0X");
  });

  test("claim: each pending item is handed out exactly once", async (t) => {
    const inbox = await serve(t);
    inbox.queueAdminAnswer({ ...fx.claimResponse.items[0] });
    const client = createInboxClient({ baseUrl: inbox.url, secret: fx.SECRET });
    const first = await client.claimOutbox(fx.SLUG, 20);
    assert.equal(first.length, 1);
    assert.equal(first[0].kind, "staff_relay");
    assert.deepEqual(inbox.calls("/api/bridge/ai-agent/outbox/claim")[0].body, { businessSlug: fx.SLUG, limit: 20 });
    assert.equal((await client.claimOutbox(fx.SLUG, 20)).length, 0);
  });
});

describe("bridge → Inbox payloads", () => {
  test("inbound 1:1, @lid with senderPn, human fromMe and staff-group quote match the contract", async (t) => {
    const env = await setup(t);
    await env.live(customerMsg(env.clock, "Do you deliver to Gros Islet?"));
    await env.live(customerMsg(env.clock, "hello", { chatId: fx.LID_JID, senderPn: "17585550000@s.whatsapp.net" }));
    await env.live(phoneMsg(env.clock, "I'll handle this one"));
    await env.live(staffGroupMsg(env.clock, "Replacement goes Friday", { quoted: "3EB0NOTICE" }));
    await env.settle();

    const bodies = env.inbox.calls("/api/bridge/ai-agent/message").map((c) => c.body as Record<string, unknown>);
    const keys = Object.keys(fx.messageRequestInbound).sort();
    for (const b of bodies) assert.deepEqual(Object.keys(b).sort(), keys);

    const inbound = bodies.find((b) => b.text === "Do you deliver to Gros Islet?")!;
    assert.equal(inbound.businessSlug, fx.SLUG);
    assert.equal(inbound.chatId, fx.CUSTOMER_JID);
    assert.equal(inbound.contactNumber, fx.CUSTOMER_NUMBER);
    assert.equal(inbound.fromMe, false);
    assert.equal(inbound.senderJid, null);

    const lid = bodies.find((b) => b.chatId === fx.LID_JID)!;
    assert.equal(lid.contactNumber, "17585550000"); // same as whatsapp_messages.contact_number

    // Unverified @lid: the @lid's own digits must never be forwarded as a phone number.
    await env.live(customerMsg(env.clock, "who am i", { chatId: "998877665544@lid" }));
    await env.settle();
    const unresolved = env.inbox.calls("/api/bridge/ai-agent/message").map((c) => c.body as Record<string, unknown>).find((b) => b.chatId === "998877665544@lid")!;
    assert.equal(unresolved.contactNumber, null);

    const human = bodies.find((b) => b.fromMe === true && b.chatId === fx.CUSTOMER_JID)!;
    assert.equal(human.contactNumber, fx.CUSTOMER_NUMBER);

    const staff = bodies.find((b) => b.chatId === fx.STAFF_GROUP)!;
    assert.equal(staff.quotedMessageId, "3EB0NOTICE");
    assert.equal(staff.senderJid, fx.STAFF_MEMBER);
  });

  test("media without text is forwarded with hasMedia (the Inbox escalates it)", async (t) => {
    const env = await setup(t);
    const msg = customerMsg(env.clock, "");
    msg.message = { audioMessage: {} };
    assert.equal(await env.live(msg), "queued");
    await env.settle();
    const body = env.inbox.calls("/api/bridge/ai-agent/message")[0].body as Record<string, unknown>;
    assert.equal(body.hasMedia, true);
    assert.equal(body.text, "");
  });
});
