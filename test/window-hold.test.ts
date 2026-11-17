// The lease's hold the window keeps while pi holds a turn of ours, how long a turn row's slot lives, and when it has the lane. From the Gates review of PR 261 and the structural review after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { type ImageResizer, WindowExecutor } from "../src/window-executor.ts";
import { type ExecutorView, cancelRow, decideDrain, personRow, plainJobRow, proofOf, ruleResultRow } from "../src/engine.ts";
import type { ImageContent, Row } from "../src/requests.ts";

const T0 = Date.parse("2026-06-01T12:00:00Z");
const by = { pid: 1, instance: "w", version: "0" };
const job = (id: string) => ({ id, sessionId: "s", prompt: `do ${id}`, cwd: "/p", model: undefined, thinking: undefined }) as any;
const jobs = { exists: () => true, enabled: () => true, goalActive: () => true };

function win(mode: "tui" | "rpc", resizer?: ImageResizer) {
	const lease = { held: false, holds: 0, letGos: 0 };
	const rows: Row[] = [];
	const entries: unknown[] = [];
	const sent: Array<{ customType: string; content: unknown; details: any }> = [];
	const aborts = { n: 0 };
	const ctx = { idle: true, pending: false, hasUI: true, mode, ui: { notify: () => undefined, getEditorText: () => "", setEditorText: () => undefined }, isIdle: () => ctx.idle, hasPendingMessages: () => ctx.pending, sessionManager: { getEntries: () => entries }, abort: () => void aborts.n++ };
	const binding = { here: () => ({ sessionId: "s", holds: true }), hold: () => ((lease.held = true), lease.holds++, {} as any), letGo: () => void ((lease.held = false), lease.letGos++) };
	const images = (row: Row): ImageContent[] => (row.payload?.images ?? []).map((i) => ({ type: "image", data: "AAAA", mimeType: i.mimeType }));
	const ex = new WindowExecutor({ sendMessage: (message: any) => void sent.push(message), sendUserMessage: () => undefined } as any, binding as any, () => ctx as any, { pid: 1 }, () => true, () => rows, images, () => [], resizer);
	/** pi starts, ends and persists the custom message the window sent for row `id`: the oldest one it has not written. */
	const writes = (id: string) => {
		const at = sent.findIndex((message) => message.details?.piLoopsRow?.id === id);
		const [message] = sent.splice(at, 1);
		ex.messageStarted({ role: "custom", ...message }, T0);
		const ended = ex.messageEnded({ role: "custom", ...message } as any, T0)?.message as any;
		entries.push({ type: "custom_message", timestamp: new Date(T0).toISOString(), ...message, details: ended?.details ?? message.details });
	};
	const view = (): ExecutorView => ex.view("s");
	const decide = (tick = false) => decideDrain("conversation", rows, proofOf("s", () => entries, () => []), jobs, view(), T0, { tick }).map((a) => `${a.do}${"row" in a ? ` ${a.row.id}` : ""}${a.do === "wait" ? `: ${a.why}` : a.do === "fail" ? `: ${a.retry}` : a.do === "exit" ? `: ${a.exit}` : ""}`);
	return { lease, rows, ctx, ex, writes, sent, aborts, view, decide, entries };
}

test("the window lets go of the lease's hold once pi wrote the turn it held", () => {
	const w = win("rpc");
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row);
	w.ex.turn(row, T0);
	assert.equal(w.lease.held, true, "held from the hand-over");
	w.ex.agentStarted(T0);
	w.view();
	assert.equal(w.lease.held, true, "still held while pi has not written it");
	w.writes(row.id);
	w.ex.agentEnded();
	w.ex.settled(false);
	w.rows.length = 0;
	w.view();
	assert.equal(w.lease.held, false, "let go: a terminal may take the conversation now");
});

test("after the page's Stop a turn pi keeps keeps the hold, though pi says nothing is pending", () => {
	const w = win("rpc");
	const one = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	const two = plainJobRow(job("j2"), "run-2", "cron:j2", "", by, T0);
	w.rows.push(one, two);
	w.ex.turn(one, T0);
	w.ex.agentStarted(T0);
	w.writes(one.id);
	w.ctx.idle = false;
	w.ex.turn(two, T0); // a run began between the engine's look and the send: queued behind it
	w.ctx.idle = true; // the page's Stop keeps it, and `hasPendingMessages()` never counts a custom message (probe P17)
	w.ex.agentEnded();
	assert.deepEqual(w.ex.settled(true), []);
	w.rows.splice(0, 1); // one left as delivered
	const v = w.view();
	assert.equal(w.lease.held, true, "pi keeps run-2: the hold stays, a terminal is a viewer");
	assert.deepEqual([[...v.inFlight], [...(v.unstarted ?? [])], [...(v.gone ?? [])]], [["run-2"], [], []], "handed over, not lost, and the lane is free for the turn that starts the run that writes it");
});

test("a rule's result handed as a follow-up during a run is held on the lease", () => {
	const w = win("rpc");
	w.ctx.idle = false;
	const r = ruleResultRow("s", "a result", { traceId: "tr-1", sourceLabel: "rule-1", cwd: "/p" }, by, T0);
	w.rows.push(r);
	w.ex.append(r, true);
	assert.equal(w.lease.held, true);
});

test("a turn handed to an idle pi has the lane until a run takes it up, with no grace; one handed while a run is on is queued behind it and has none", () => {
	const w = win("rpc");
	const one = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	const two = plainJobRow(job("j2"), "run-2", "cron:j2", "", by, T0);
	w.rows.push(one, two);
	w.ex.turn(one, T0);
	let v = w.view();
	assert.deepEqual([[...v.inFlight], [...(v.unstarted ?? [])], v.inFlightSince?.size], [["run-1"], ["run-1"], 0]);
	assert.deepEqual(w.decide(), ["wait run-1: handed to pi, not yet in the conversation", "wait run-2: pi is busy"], "pi says idle (it does, inside its agent_settled handlers), and the second turn waits all the same");
	// An hour later pi has still started no run: no tick judges a custom message refused.
	assert.deepEqual(decideDrain("conversation", w.rows, proofOf("s", () => [], () => []), jobs, w.view(), T0 + 3_600_000, { tick: true }).map((a) => a.do), ["wait", "wait"]);
	w.ex.agentStarted(T0);
	v = w.view();
	assert.deepEqual([[...v.inFlight], [...(v.unstarted ?? [])]], [["run-1"], []], "a run took it up");
	const busy = win("rpc");
	busy.ctx.idle = false;
	busy.rows.push(one);
	busy.ex.turn(one, T0);
	v = busy.view();
	assert.deepEqual([[...v.inFlight], [...(v.unstarted ?? [])], v.inFlightSince?.size], [["run-1"], [], 0]);
});

test("a turn's slot is the window's until its message is written: not gone when pi says nothing is pending, and not when its row leaves the file", () => {
	const w = win("rpc");
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row);
	w.ctx.idle = false;
	w.ex.turn(row, T0);
	w.ctx.idle = true; // idle, no run on, nothing pending: for a user message that reads as cleared out of pi
	let v = w.view();
	assert.deepEqual([[...v.inFlight], [...(v.gone ?? [])]], [["run-1"], []]);
	w.rows.length = 0; // the row left the file (another window delivered it, or the page took it back)
	v = w.view();
	assert.deepEqual([...v.inFlight], [], "nothing is owed for it");
	// pi writes it after all: its turn runs under the cap its message carries, though no row is in the file.
	w.ex.agentStarted(T0);
	w.writes(row.id);
	assert.deepEqual(w.ex.currentTurn(), { kind: "row", id: "run-1", mode: "unattended" });
	assert.equal(w.view().running?.requestId, "run-1");
	w.ex.agentEnded();
	assert.deepEqual(w.ex.settled(false), [], "and it owes no exit");
});

for (const [name, mode, aborted, gone, action] of [
	["a run that ends with no stop and did not write a turn pi held", "rpc", false, "lost", "fail run-1: backoff"],
	["a stop in a terminal", "tui", true, "dropped", "fail run-1: now"],
] as const) {
	test(`${name}: the turn is ${gone}, and its row is offered again with an attempt counted`, () => {
		const w = win(mode);
		const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
		w.rows.push(row);
		w.ctx.idle = false;
		w.ex.turn(row, T0);
		w.ex.agentEnded();
		w.ctx.idle = true;
		assert.deepEqual(w.ex.settled(aborted), ["run-1"]);
		assert.equal(w.view().gone?.get("run-1"), gone);
		assert.equal(w.decide()[0], action);
		assert.equal(w.lease.held, false);
	});
}

test("a turn whose message started and whose entry carries no mark (another extension replaced the message) is lost at the settle, also after the page's Stop", () => {
	const w = win("rpc");
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row);
	w.ex.turn(row, T0);
	w.ex.agentStarted(T0);
	w.ex.messageStarted({ role: "custom", ...w.sent[0] }, T0);
	assert.deepEqual(w.ex.currentTurn(), { kind: "row", id: "run-1", mode: "unattended" }, "the cap was read at message_start: nothing later takes it away");
	w.ex.agentEnded();
	assert.deepEqual(w.ex.settled(true), ["run-1"]);
	assert.equal(w.view().gone?.get("run-1"), "lost");
});

test("a stop for a turn pi holds aborts its run as its message starts; unwritten, the row leaves as cancelled", () => {
	const w = win("tui");
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row);
	w.ctx.idle = false;
	w.ex.turn(row, T0);
	w.ex.abortWhenStarted("run-1");
	w.writes(row.id);
	assert.equal(w.aborts.n, 1);
	const dropped = win("tui");
	dropped.rows.push(row);
	dropped.ctx.idle = false;
	dropped.ex.turn(row, T0);
	dropped.ex.abortWhenStarted("run-1");
	dropped.ctx.idle = true;
	assert.deepEqual(dropped.ex.settled(true), ["run-1"]);
	assert.equal(dropped.decide()[0], "exit run-1: cancelled");
});

test("a cancel takes a row out while the page's pi keeps its turn; the same row queued again is neither cancelled by that stop nor aborted, and the turn pi kept is", () => {
	const w = win("rpc");
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row, cancelRow("s", { id: "run-1" }, "person", by, T0));
	w.ctx.idle = false;
	w.ex.turn(row, T0);
	assert.deepEqual(w.decide().slice(0, 2), ["abortWhenStarted", "exit run-1: cancelled"]);
	w.ex.abortWhenStarted("run-1");
	w.ctx.idle = true;
	w.ex.agentEnded();
	w.ex.settled(true); // the page's Stop: pi keeps the turn
	w.rows.length = 0;
	assert.deepEqual([...w.view().inFlight], []);
	assert.equal(w.lease.held, false, "nothing owed is held");
	// The clock queues the same slot again, and the window hands it to the idle pi.
	w.rows.push(row);
	assert.deepEqual(w.decide(), ["turn run-1"]);
	w.ex.turn(row, T0);
	w.ex.agentStarted(T0);
	const kept = w.sent[0];
	w.writes("run-1"); // the run's starter is the new hand-over (probe P11): pi writes it first
	w.sent.unshift(kept);
	assert.equal(w.aborts.n, 0, "the turn no stop named takes the first message with its row's name");
	assert.deepEqual(w.decide(), ["exit run-1: delivered"], "its mark is in the conversation: the row queued again is done");
	w.rows.length = 0;
	w.view();
	w.ex.messageStarted({ role: "custom", ...kept }, T0); // then what pi kept
	assert.equal(w.aborts.n, 1, "and the one the cancel named is aborted as it starts, though the other hand-over's mark was there first");
	w.ex.agentEnded();
	assert.deepEqual(w.ex.settled(true), [], "nothing is owed for either");
	assert.deepEqual([...w.view().inFlight], []);
});

test("a turn a stop named whose row left before pi wrote it is marked aborted: the same row queued again later is not proved by it (#262)", () => {
	const w = win("rpc");
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row);
	w.ctx.idle = false; // pi holds the turn behind a run
	w.ex.agentStarted(T0);
	w.ex.turn(row, T0);
	w.ex.abortWhenStarted(row.id);
	w.rows.length = 0; // the cancel took the row out
	w.view();
	w.writes("run-1");
	assert.equal(w.aborts.n, 1, "aborted as it starts");
	assert.deepEqual((w.entries[0] as any).details, { piLoopsRow: { lane: "s", id: "run-1", at: row.created_at, aborted: true }, cap: { kind: "row", id: "run-1", mode: "unattended" } }, "written with the mark of the row it was sent for, as aborted");
	w.ex.agentEnded();
	w.ex.settled(true);
	w.ctx.idle = true;
	w.rows.push(plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0 + 60_000)); // the same row id, queued again a minute later
	assert.deepEqual(w.decide(), ["turn run-1"], "not proved by the aborted message");
});

test("while pi compacts the conversation no turn is handed over; an append still is, and the wait ends with the compaction, done or not", () => {
	const w = win("rpc");
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	const result = ruleResultRow("s", "[Trigger tr-1] a result", { traceId: "tr-1", sourceLabel: "rule-1", cwd: "/p" }, by, T0);
	w.rows.push(row, result);
	w.ex.compaction(true);
	w.ctx.idle = false; // pi is not idle while it compacts
	assert.deepEqual(w.decide(), ["wait run-1: pi is compacting the conversation", "append tr-1"]);
	assert.equal(w.view().blocked(result as any), undefined);
	w.ex.compaction(false);
	w.ctx.idle = true;
	assert.deepEqual(w.decide(), ["turn run-1", "append tr-1"]);
	// A compaction whose end the window was never told of holds nothing back once pi says it is idle.
	w.ex.compaction(true);
	assert.deepEqual(w.decide(), ["turn run-1", "append tr-1"]);
});

test("a turn row's images are resized before the send, as pi resizes a user message's: pi's note for one that changed, and one that cannot be brought within the limits is left out with pi's note", async () => {
	const seen: Array<[number, string]> = [];
	const resizer: ImageResizer = {
		resizeImage: async (bytes, mimeType) => {
			seen.push([bytes.length, mimeType]);
			if (mimeType === "image/gif") return null;
			return mimeType === "image/png" ? { data: "c21hbGw=", mimeType: "image/jpeg", originalWidth: 2400, originalHeight: 16, width: 2000, height: 13, wasResized: true } : { data: Buffer.from(bytes).toString("base64"), mimeType, originalWidth: 10, originalHeight: 10, width: 10, height: 10, wasResized: false };
		},
		formatDimensionNote: (r) => (r.wasResized ? `[Image: original ${r.originalWidth}x${r.originalHeight}, displayed at ${r.width}x${r.height}. Multiply coordinates by 1.20 to map to original image.]` : undefined),
	};
	const w = win("tui", resizer);
	const image = (mimeType: string): ImageContent => ({ type: "image", data: "AAAA", mimeType });
	const row = personRow("p1", "what is this?", [image("image/png"), image("image/webp"), image("image/gif")], { sessionId: "s", cwd: "/p", createdBy: by }, T0);
	w.rows.push(row);
	const handed = w.ex.turn(row, T0);
	assert.ok(handed instanceof Promise, "the resize is waited for");
	assert.deepEqual(w.sent, [], "nothing is sent before it");
	assert.equal(await handed, "sent");
	assert.deepEqual(seen, [[3, "image/png"], [3, "image/webp"], [3, "image/gif"]]);
	assert.deepEqual(w.sent[0].content, [
		{ type: "text", text: "what is this?\n\n[Image: original 2400x16, displayed at 2000x13. Multiply coordinates by 1.20 to map to original image.]\n[Image omitted: could not be resized below the inline image size limit.]" },
		{ type: "image", data: "c21hbGw=", mimeType: "image/jpeg" },
		{ type: "image", data: "AAAA", mimeType: "image/webp" },
	]);
	assert.equal(w.lease.held, true);
	assert.deepEqual([...w.view().inFlight], ["p1"]);
});

test("a turn row's image type is read as pi's user path reads it: image/jpg is a JPEG, and a type no provider takes is left out with pi's note", async () => {
	const seen: string[] = [];
	const same: ImageResizer = { resizeImage: async (bytes, mimeType) => (seen.push(mimeType), { data: Buffer.from(bytes).toString("base64"), mimeType, originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false }), formatDimensionNote: () => undefined };
	const w = win("tui", same);
	const image = (mimeType: string): ImageContent => ({ type: "image", data: "AAAA", mimeType });
	const row = personRow("p1", "what is this?", [image("image/JPG; q=1"), image('text/html; x="y"')], { sessionId: "s", cwd: "/p", createdBy: by }, T0);
	w.rows.push(row);
	assert.equal(await w.ex.turn(row, T0), "sent");
	assert.deepEqual(seen, ["image/jpeg"], "only the JPEG is resized, as image/jpeg");
	assert.deepEqual(w.sent[0].content, [{ type: "text", text: "what is this?\n\n[Image omitted: could not be converted to a supported inline image format.]" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }]);
});

test("a turn row whose images are being resized is in flight and has the lane: a drain that overlaps the resize hands over neither it nor another turn", async () => {
	const same: ImageResizer = { resizeImage: async (bytes, mimeType) => ({ data: Buffer.from(bytes).toString("base64"), mimeType, originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false }), formatDimensionNote: () => undefined };
	const w = win("tui", same);
	const row = personRow("p1", "what is this?", [{ type: "image", data: "AAAA", mimeType: "image/png" }], { sessionId: "s", cwd: "/p", createdBy: by }, T0);
	const cron = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row, cron);
	const handed = w.ex.turn(row, T0);
	assert.deepEqual([...w.view().inFlight], ["p1"], "in flight before it is sent");
	assert.deepEqual(w.decide().filter((action) => action.startsWith("turn")), [], "and nothing is handed over beside it");
	assert.equal(await handed, "sent");
	assert.equal(w.sent.length, 1);
	assert.deepEqual(w.decide().filter((action) => action.startsWith("turn")), [], "the sent turn has the lane until a run takes it up");
});

test("a turn row with images that left the queue while they were resized is not sent, nor one pi began to compact under, and a resize that fails sends nothing and holds nothing", async () => {
	const row = personRow("p1", "what is this?", [{ type: "image", data: "AAAA", mimeType: "image/png" }], { sessionId: "s", cwd: "/p", createdBy: by }, T0);
	const same: ImageResizer = { resizeImage: async (bytes, mimeType) => ({ data: Buffer.from(bytes).toString("base64"), mimeType, originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false }), formatDimensionNote: () => undefined };
	const w = win("tui", same);
	w.rows.push(row);
	const handed = w.ex.turn(row, T0) as Promise<unknown>;
	w.rows.length = 0; // the page took its message back
	await assert.rejects(handed, /left the queue while its images were resized/);
	assert.deepEqual([w.sent, w.lease.held], [[], false]);
	const compacting = win("tui", same);
	compacting.rows.push(row);
	const late = compacting.ex.turn(row, T0) as Promise<unknown>;
	compacting.ex.compaction(true); // the person typed /compact meanwhile
	compacting.ctx.idle = false;
	await assert.rejects(late, /began to compact the conversation/);
	assert.deepEqual([compacting.sent, compacting.lease.held], [[], false], "a turn sent now would run beside the compaction");
	const broken = win("tui"); // wired with no resizer
	broken.rows.push(row);
	await assert.rejects(broken.ex.turn(row, T0) as Promise<unknown>, /no way to resize/);
	assert.deepEqual([broken.sent, broken.lease.held, [...broken.view().inFlight]], [[], false, []]);
});
