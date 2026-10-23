import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyMessage } from "../src/agent/messages.js";
import { createFileJournal } from "../src/agent/journal.js";
import { rowContactNumber } from "../src/messageFields.js";
import * as fx from "./fixtures/inbox.js";
import { Clock, customerMsg, phoneMsg, staffGroupMsg } from "./helpers.js";

const clock = new Clock();

test("classify: inbound 1:1 text → direct, fields as the contract expects", () => {
  const c = classifyMessage(customerMsg(clock, "Do you deliver?", { id: "ABC" }));
  assert.equal(c.kind, "direct");
  if (c.kind !== "direct") return;
  assert.equal(c.payload.whatsappMessageId, "ABC");
  assert.equal(c.payload.contactNumber, fx.CUSTOMER_NUMBER);
  assert.equal(c.payload.fromMe, false);
  assert.equal(c.payload.senderJid, null);
  assert.equal(c.payload.timestamp, new Date(Math.floor(clock.now() / 1000) * 1000).toISOString());
});

test("classify: fromMe 1:1 and group messages", () => {
  assert.equal(classifyMessage(phoneMsg(clock, "hi")).kind, "direct");
  const g = classifyMessage(staffGroupMsg(clock, "x", { quoted: "Q1" }));
  assert.equal(g.kind, "group");
  if (g.kind === "group") {
    assert.equal(g.payload.quotedMessageId, "Q1");
    assert.equal(g.payload.senderJid, fx.STAFF_MEMBER);
  }
});

test("classify: system chats, stubs, reactions, edits and empty messages are ignored", () => {
  const base = customerMsg(clock, "x");
  assert.equal(classifyMessage({ ...base, key: { ...base.key, remoteJid: "123@newsletter" } }).kind, "ignore");
  assert.equal(classifyMessage({ ...base, messageStubType: 1 }).kind, "ignore");
  assert.equal(classifyMessage({ ...base, message: { reactionMessage: { text: "👍" } } }).kind, "ignore");
  assert.equal(classifyMessage({ ...base, message: { editedMessage: {} } }).kind, "ignore");
  assert.equal(classifyMessage({ ...base, message: { conversation: "   " } }).kind, "ignore");
  assert.equal(classifyMessage({ ...base, key: { ...base.key, remoteJid: "weird@server" } }).kind, "ignore");
});

test("contact number matches the whatsapp_messages row builder", () => {
  assert.equal(rowContactNumber({ remoteJid: fx.LID_JID, fromMe: false, senderPn: "17585550000@s.whatsapp.net" }, fx.LID_JID), "17585550000");
  assert.equal(rowContactNumber({ remoteJid: fx.LID_JID, fromMe: false }, fx.LID_JID), "112233445566778");
  assert.equal(rowContactNumber({ remoteJid: fx.CUSTOMER_JID, fromMe: true }, fx.CUSTOMER_JID), fx.CUSTOMER_NUMBER);
});

test("file journal: atomic round trip, corrupt file set aside", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-journal-"));
  const file = path.join(dir, "nested", "state.json");
  const j = createFileJournal(file, () => {});
  j.state.holds["dog_food|x@s.whatsapp.net"] = { until: 1, reason: "unknown_send_outcome", outboxId: "o1" };
  j.save();
  assert.equal(createFileJournal(file, () => {}).state.holds["dog_food|x@s.whatsapp.net"].outboxId, "o1");

  fs.writeFileSync(file, "{not json");
  const logs: string[] = [];
  const recovered = createFileJournal(file, (m) => logs.push(m));
  assert.deepEqual(recovered.state.holds, {});
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes(".corrupt-")));
  assert.equal(logs.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
