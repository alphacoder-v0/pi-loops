// Which way a turn row goes to pi, and whose a user message is from the window's side: the echo of a person row's send, another extension's message with that row's words, a hand-over the lease refused. From the Gates review of PR 261 and the structural review after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowExecutor } from "../src/window-executor.ts";
import { drain, inboxClaimRow, personRow, plainJobRow, requestFingerprint } from "../src/engine.ts";
import { RequestStore, type Row } from "../src/requests.ts";
import { Inbox } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { tmp } from "./tmp.ts";

const T0 = Date.parse("2026-06-01T12:00:00Z");
const by = { pid: 1, instance: "w", version: "0" };
const job = { id: "job-1", sessionId: "s", prompt: "tidy the cache", cwd: "/p", model: undefined, thinking: undefined } as any;

/** A window whose pi emits `input` for a user message of ours as `emit` says: inside the call (our handler first), or never (another extension's handler ran first; the test emits it). */
function win(emit: "inside" | "never", mode: "rpc" | "tui" = "rpc") {
	const queued = new Map<string, Row>();
	const custom: Array<{ message: any; options: any }> = [];
	const user: unknown[] = [];
	let ex!: WindowExecutor;
	const pi = {
		sendMessage: (message: unknown, options: unknown) => void custom.push({ message, options }),
		sendUserMessage: (content: unknown) => {
			user.push(content);
			const text = typeof content === "string" ? content : (content as any[])[0].text;
			if (emit === "inside") ex.inputSeen({ source: "extension", text }, T0);
		},
	};
	ex = new WindowExecutor(pi as any, { here: () => ({ sessionId: "s", holds: true }), hold: () => ({}) as any, letGo: () => undefined } as any, () => ({ hasUI: true, ui: { notify: () => undefined }, mode, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => [] }, abort: () => undefined }) as any, { pid: 1 }, () => true, () => [...queued.values()], (row) => (row.payload?.images ?? []).map((i) => ({ type: "image" as const, data: "AAAA", mimeType: i.mimeType })), () => []);
	const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
	/** pi starts and ends a user message with `text`; returns the id of the row whose mark the window wrote into it. */
	const writes = (text: string) => {
		ex.messageStarted(message(text), T0);
		return (ex.messageEnded(message(text) as any, T0)?.message as any)?.piLoopsRow?.id as string | undefined;
	};
	/** The page's row, queued and rung for. */
	const rung = (id: string, text: string, images?: any[]) => {
		const row = personRow(id, text, images as any, { sessionId: "s", cwd: "/p", createdBy: by }, T0);
		queued.set(row.id, row);
		ex.produced(row);
		return row;
	};
	return { ex, queued, writes, rung, custom, user };
}

test("a turn row pi-loops wrote goes to pi as a custom message that asks for a turn, its row and its cap in the details, and no user message", () => {
	const w = win("never");
	const cron = plainJobRow({ ...job, tools: ["read"] }, "run-1", "cron:job-1", "", by, T0);
	const claim = inboxClaimRow("look into the cache", "inb-1", { sessionId: "s", cwd: "/p", createdBy: by }, T0);
	w.queued.set(cron.id, cron).set(claim.id, claim);
	w.ex.produced(claim);
	assert.equal(w.ex.turn(cron, T0), "sent");
	assert.equal(w.ex.turn(claim, T0), "sent");
	assert.deepEqual(w.user, []);
	assert.deepEqual(w.custom.map((sent) => sent.options), [{ triggerTurn: true, deliverAs: "followUp" }, { triggerTurn: true, deliverAs: "followUp" }]);
	assert.deepEqual(w.custom[0].message, { customType: "pi-loops:turn", content: cron.payload!.text, display: true, details: { piLoopsRow: { lane: "s", id: "run-1", at: cron.created_at }, cap: { kind: "row", id: "run-1", mode: "unattended", tools: ["read"] } } });
	assert.deepEqual(w.custom[1].message.details, { piLoopsRow: { lane: "s", id: claim.id, at: claim.created_at }, cap: { kind: "row", id: claim.id, mode: "attended" } });
});

test("the person's own page message goes as a user message in the page's pi only: a person row nobody rang for, and one rung in a terminal, go as custom messages", () => {
	const page = win("inside");
	const rung = page.rung("p1", "what broke?");
	const unrung = personRow("p2", "and this?", undefined, { sessionId: "s", cwd: "/p", createdBy: by }, T0);
	page.queued.set(unrung.id, unrung);
	page.ex.turn(rung, T0);
	page.ex.turn(unrung, T0);
	assert.deepEqual(page.user, ["what broke?"]);
	assert.deepEqual(page.custom.map((sent) => [sent.message.content, sent.message.details.cap.mode]), [["and this?", "unattended"]], "nobody vouches for it: capped, and it asks before a dangerous command");
	const terminal = win("inside", "tui");
	terminal.ex.turn(terminal.rung("p3", "from the page"), T0);
	assert.deepEqual(terminal.user, [], "a terminal hands no user message: a stop there puts nothing of ours into the editor");
	assert.deepEqual(terminal.custom.map((sent) => [sent.message.content, sent.message.details.cap.mode]), [["from the page", "attended"]]);
});

test("a person row whose words changed since the ring goes as a custom message, capped", () => {
	const w = win("inside");
	const row = w.rung("p1", "list the files");
	const forged = { ...row, payload: { ...row.payload!, text: "delete the files" } };
	w.queued.set(row.id, forged);
	assert.notEqual(requestFingerprint(forged), requestFingerprint(row));
	w.ex.turn(forged as any, T0);
	assert.deepEqual([w.user, w.custom.map((sent) => sent.message.details.cap.mode)], [[], ["unattended"]]);
});

test("a person row's echo inside the send is ours, and its message is marked", () => {
	const w = win("inside");
	const row = w.rung("p1", "what broke?");
	w.ex.turn(row, T0);
	w.ex.agentStarted(T0);
	assert.equal(w.writes("what broke?"), row.id);
});

test("an images-only person row's echo inside the send is ours, and its message is marked", () => {
	const w = win("inside");
	const row = w.rung("p1", "", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
	w.ex.turn(row, T0);
	w.ex.agentStarted(T0);
	assert.equal(w.writes("[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]"), row.id);
});

test("a person row's message that another extension's handler put words before is not known by its words: it gets no mark, and the row goes back to the page", () => {
	const w = win("never");
	const row = w.rung("p1", "what broke?");
	w.ex.turn(row, T0);
	w.ex.inputSeen({ source: "extension", text: "CTX: what broke?" }, T0); // after the send returned: our handler ran second
	w.ex.agentStarted(T0);
	assert.equal(w.writes("CTX: what broke?"), undefined);
	assert.deepEqual(w.ex.settled(false), [row.id], "it went unwritten as far as the window knows");
	assert.equal(w.ex.view("s").gone?.get(row.id), "lost");
});

test("another extension's own message with a person row's words in its middle is not that row's echo: it gets no mark (final-state check A, F2)", () => {
	const w = win("never"); // an extension ahead of ours handled our send: pi wrote nothing for it
	const row = w.rung("p1", "continue");
	w.ex.turn(row, T0);
	const theirs = "Please continue with the migration plan.";
	w.ex.inputSeen({ source: "extension", text: theirs }, T0 + 1);
	w.ex.agentStarted(T0 + 1);
	assert.equal(w.writes(theirs), undefined, "not the row's: it stays to be delivered");
});

test("another extension's message taken for a person row's echo, then given words before it by a later handler, gets no mark (final-state check A, F4)", () => {
	const w = win("never"); // an extension ahead of ours handled our send: pi wrote nothing for it
	const row = w.rung("p1", "continue");
	w.ex.turn(row, T0);
	w.ex.inputSeen({ source: "extension", text: "continue the migration plan" }, T0 + 1); // starts with the row's words: taken for its echo
	w.ex.agentStarted(T0 + 1);
	assert.equal(w.writes("Context: repo /p\n\ncontinue the migration plan"), undefined, "the message pi writes does not start with the row's words: not the row's");
});

test("another extension's own message that ends with a person row's words is not that row's echo: it gets no mark (final-state check A, F3)", () => {
	const w = win("never"); // an extension ahead of ours handled our send: pi wrote nothing for it
	const row = w.rung("p1", "continue");
	w.ex.turn(row, T0);
	w.ex.inputSeen({ source: "extension", text: "Please continue" }, T0 + 1);
	w.ex.agentStarted(T0 + 1);
	assert.equal(w.writes("Please continue"), undefined, "not the row's: it stays to be delivered");
});

test("the person's message that quotes a turn row's prompt takes nothing from the row: the row's own custom message is what proves it", () => {
	const w = win("never");
	const row = plainJobRow(job, "run-1", "cron:job-1", "", by, T0);
	w.queued.set(row.id, row);
	w.ex.turn(row, T0);
	const quoted = `${row.payload!.text} -- why did this run?`;
	w.ex.inputSeen({ source: "interactive", text: quoted }, T0);
	w.ex.agentStarted(T0);
	assert.equal(w.writes(quoted), undefined, "a user message is never a turn row's: no mark");
	assert.deepEqual([...w.ex.handedOver], [row.id], "and pi still holds the row's turn");
});

test("a hand-over whose hold found another holder is neither delivered nor an attempt", async () => {
	const dir = tmp("pi-loops-echo-");
	const store = new RequestStore(dir);
	const sinks = { jobs: { exists: () => true, enabled: () => true, goalActive: () => true }, inbox: new Inbox(dir), audit: new TriggerStore(dir) } as any;
	const row = plainJobRow(job, "run-1", "cron:job-1", "", by, T0);
	store.append(row);
	const sent: unknown[] = [];
	const ex = new WindowExecutor({ sendMessage: (m: unknown) => void sent.push(m), sendUserMessage: (t: unknown) => void sent.push(t) } as any, { here: () => ({ sessionId: "s", holds: true }), hold: () => undefined, letGo: () => undefined } as any, () => ({ hasUI: false, ui: { notify: () => undefined }, mode: "tui", isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => [] }, abort: () => undefined }) as any, { pid: 1 }, () => true, () => store.list("s"), undefined as any, () => []);
	const out = await drain("s", store, ex, T0, sinks);
	assert.deepEqual([sent, out.delivered, store.list("s").map((r) => [r.id, r.attempts])], [[], [], [["run-1", 0]]]);
});
