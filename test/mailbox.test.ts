import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { conversationHas, Mailbox, routePromotion, type Delivery } from "../src/mailbox.ts";

const delivery = (id: string): Delivery => ({ id, text: `[Trigger ${id}] hello`, cwd: "/", createdAt: "2026-01-01T00:00:00Z" });

test("enqueue then drain delivers in order and removes the file", () => {
	const box = new Mailbox(tmp());
	box.enqueue("s", delivery("1"));
	box.enqueue("s", delivery("2"));
	const seen: string[] = [];
	// Delivering writes it into the conversation, as an idle chat or the host's append does.
	assert.deepEqual(box.drain("s", { holds: () => true, alreadyDelivered: (id) => seen.includes(id), deliver: (d) => seen.push(d.id) }), { delivered: ["1", "2"], skipped: [] });
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
	const written = new Set<string>();
	box.drain("s", { holds: () => true, alreadyDelivered: (id) => written.has(id), deliver: (d) => (written.add(d.id), box.enqueue("s", delivery("2"))) });
	assert.deepEqual(box.pending("s").map((d) => d.id), ["2"]);
});

test("conversationHas checks user and custom messages and ignores other entries", () => {
	assert.equal(conversationHas([{ type: "message", message: { role: "user", content: "[Trigger x] text" } }], "x"), true);
	assert.equal(conversationHas([{ type: "message", message: { role: "user", content: [{ type: "text", text: "[Trigger x] text" }] } }], "x"), true);
	assert.equal(conversationHas([{ type: "custom_message", content: "[Trigger x] text" }], "x"), true);
	assert.equal(conversationHas([{ type: "message", message: { role: "assistant", content: "[Trigger x] text" } }, { type: "other", content: "[Trigger x] text" }], "x"), false);
});

test("a promotion goes to the conversation that created the rule, decided the same way by a window and the host", () => {
	const holders: Record<string, number> = { s2: 4242 };
	const view = { holderOf: (id: string) => holders[id], closed: (id: string) => id === "closed" };
	const window = { sessionId: "s1", holds: true };
	assert.deepEqual(routePromotion("s1", window, view), { to: "chat" });
	assert.deepEqual(routePromotion("s2", window, view), { to: "mailbox", sessionId: "s2" });
	assert.deepEqual(routePromotion("s2", { sessionId: "s2", holds: false }, view), { to: "mailbox", sessionId: "s2" }, "a viewer of the creating conversation hands it to the holder");
	assert.deepEqual(routePromotion("closed", window, view), { to: "mailbox", sessionId: "closed" }, "closed: a window queues it for the host");
	assert.deepEqual(routePromotion("closed", { holds: false, isHost: true }, view), { to: "append", sessionId: "closed" }, "closed: the host appends it");
	assert.deepEqual(routePromotion("unknown", window, view), { to: "inbox", sessionId: "unknown" }, "no file to write to: the inbox, marked for it");
	assert.deepEqual(routePromotion(undefined, window, view), { to: "chat" }, "no creating session: a window's own chat");
	assert.deepEqual(routePromotion(undefined, { holds: false, isHost: true }, view), { to: "inbox" }, "and the host's inbox");
});

test("a delivery leaves the queue only once it is in the conversation, and is not handed over twice meanwhile", () => {
	const box = new Mailbox(tmp());
	box.enqueue("s", delivery("1"));
	const handedOver = new Set<string>();
	const given: string[] = [];
	// A busy chat: pi queues the follow-up in memory and writes it later.
	const drain = (written: Set<string>) => box.drain("s", { holds: () => true, alreadyDelivered: (id) => written.has(id), deliver: (d) => given.push(d.id), handedOver });
	drain(new Set());
	assert.deepEqual(box.pending("s").map((d) => d.id), ["1"], "kept: a window that quits now must not lose it");
	drain(new Set());
	assert.deepEqual(given, ["1"], "not handed to pi a second time");
	drain(new Set(["1"]));
	assert.deepEqual(box.pending("s"), [], "gone once it is in the conversation");
	assert.deepEqual(box.sessions(), []);
});

test("a holder that loses the conversation mid-drain stops: the rest wait for whoever holds it now", () => {
	// Checked once at the start, the holder kept writing after a window had taken the conversation,
	// and the same rule result could reach it twice.
	const box = new Mailbox(tmp());
	for (const id of ["1", "2", "3"]) box.enqueue("s", delivery(id));
	let held = true;
	const given: string[] = [];
	box.drain("s", { holds: () => held, alreadyDelivered: (id) => given.includes(id), deliver: (d) => { given.push(d.id); held = false; } });
	assert.deepEqual(given, ["1"]);
	assert.deepEqual(box.pending("s").map((d) => d.id), ["2", "3"]);
});
