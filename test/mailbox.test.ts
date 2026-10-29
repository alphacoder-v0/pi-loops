import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { conversationHas, Mailbox, routePromotion, type Delivery } from "../src/mailbox.ts";

const delivery = (id: string): Delivery => ({ id, kind: "message", text: `[Trigger ${id}] hello`, cwd: "/", ruleIds: [], createdAt: "2026-01-01T00:00:00Z" });

test("enqueue then drain delivers in order and removes the file", () => {
	const box = new Mailbox(tmp());
	box.enqueue("s", delivery("1"));
	box.enqueue("s", delivery("2"));
	const seen: string[] = [];
	assert.deepEqual(box.drain("s", { holds: () => true, alreadyDelivered: () => false, deliver: (d) => seen.push(d.id) }), { delivered: ["1", "2"], skipped: [] });
	assert.deepEqual(seen, ["1", "2"]);
	assert.equal(fs.existsSync(box.file("s")), false);
});

test("entry already in the conversation is skipped", () => {
	const box = new Mailbox(tmp());
	box.enqueue("s", delivery("x"));
	assert.deepEqual(box.drain("s", { holds: () => true, alreadyDelivered: (id) => id === "x", deliver: () => assert.fail("duplicate delivery") }), { delivered: [], skipped: ["x"] });
});

test("viewer does not drain", () => {
	const box = new Mailbox(tmp());
	box.enqueue("s", delivery("x"));
	assert.deepEqual(box.drain("s", { holds: () => false, alreadyDelivered: () => false, deliver: () => assert.fail("viewer delivered") }), { delivered: [], skipped: [] });
	assert.equal(box.pending("s").length, 1);
});

test("delivery failure keeps that entry and later entries", () => {
	const box = new Mailbox(tmp());
	box.enqueue("s", delivery("1"));
	box.enqueue("s", delivery("2"));
	assert.deepEqual(box.drain("s", { holds: () => true, alreadyDelivered: () => false, deliver: () => { throw new Error("stop"); } }), { delivered: [], skipped: [] });
	assert.deepEqual(box.pending("s").map((d) => d.id), ["1", "2"]);
});

test("entry enqueued during drain survives", () => {
	const dir = tmp();
	const box = new Mailbox(dir);
	box.enqueue("s", delivery("1"));
	box.drain("s", { holds: () => true, alreadyDelivered: () => false, deliver: () => box.enqueue("s", delivery("2")) });
	assert.deepEqual(box.pending("s").map((d) => d.id), ["2"]);
});

test("conversationHas checks user and custom messages and ignores other entries", () => {
	assert.equal(conversationHas([{ type: "message", message: { role: "user", content: "[Trigger x] text" } }], "x"), true);
	assert.equal(conversationHas([{ type: "message", message: { role: "user", content: [{ type: "text", text: "[Trigger x] text" }] } }], "x"), true);
	assert.equal(conversationHas([{ type: "custom_message", content: "[Trigger x] text" }], "x"), true);
	assert.equal(conversationHas([{ type: "message", message: { role: "assistant", content: "[Trigger x] text" } }, { type: "other", content: "[Trigger x] text" }], "x"), false);
});

test("a promotion goes to the conversation that created the rule: here, through its holder's mailbox, or the inbox marked for it", () => {
	const holders: Record<string, number> = { s2: 4242 };
	const holderOf = (id: string) => holders[id];
	assert.deepEqual(routePromotion("s1", { sessionId: "s1", holds: true }, holderOf), { to: "chat" });
	assert.deepEqual(routePromotion("s2", { sessionId: "s1", holds: true }, holderOf), { to: "mailbox", sessionId: "s2" });
	assert.deepEqual(routePromotion("s3", { sessionId: "s1", holds: true }, holderOf), { to: "inbox", sessionId: "s3" }, "closed: the inbox, marked for it");
	assert.deepEqual(routePromotion("s2", { sessionId: "s2", holds: false }, holderOf), { to: "mailbox", sessionId: "s2" }, "a viewer of the creating conversation hands it to the holder");
	assert.deepEqual(routePromotion(undefined, { sessionId: "s1", holds: true }, holderOf), { to: "chat" }, "no creating session: the caller's project rule decides");
});
