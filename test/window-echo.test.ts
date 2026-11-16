// Whose a message is, from the window's side: the echo of our own send, the person's quote of a prompt, words around and in the middle, a hand-over the lease refused, the editor. From the Gates review of PR 261.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markFor } from "../src/mark.ts";
import type { Phase, TurnSlot } from "../src/window-claim.ts";
import { claimOf } from "../src/window-claim.ts";
import { WindowExecutor } from "../src/window-executor.ts";
import { personRow, plainJobRow } from "../src/engine.ts";
import type { Row } from "../src/requests.ts";

const turn = (id: string, text: string, phase: Phase): TurnSlot => ({ whose: "turn", mark: markFor({ lane: "s", id }), text, cap: { kind: "row", id, mode: "attended" }, phase, echoed: false });

test("step 3 does not take a message with the row's words in its middle", () => {
	const row = turn("row", "Run the tests", { is: "queued" });
	assert.equal(claimOf("Please Run the tests now", [row]).by, "nobody");
	assert.equal(claimOf("[rewritten] Run the tests", [row]).by, "turn", "control: words before it");
});

const T0 = Date.parse("2026-06-01T12:00:00Z");
const by = { pid: 1, instance: "w", version: "0" };
const job = { id: "job-1", sessionId: "s", prompt: "tidy the cache", cwd: "/p", model: undefined, thinking: undefined } as any;

/** A window whose pi emits `input` for our send as `emit` says: inside the call (our handler first), after it (another's first, rewritten), or never. */
function win(emit: "inside" | "never" | ((text: string) => string)) {
	const queued = new Map<string, Row>();
	let ex!: WindowExecutor;
	const pi = {
		sendMessage: () => undefined,
		sendUserMessage: (content: unknown) => {
			const text = typeof content === "string" ? content : (content as any[])[0].text;
			if (emit === "inside") ex.inputSeen({ source: "extension", text }, T0);
		},
	};
	ex = new WindowExecutor(pi as any, { here: () => ({ sessionId: "s", holds: true }), hold: () => ({}) as any, letGo: () => undefined } as any, () => ({ hasUI: true, ui: { notify: () => undefined }, mode: "tui", isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => [] }, abort: () => undefined }) as any, { pid: 1 }, () => true, () => [...queued.values()], (row) => (row.payload?.images ?? []).map((i) => ({ type: "image" as const, data: "AAAA", mimeType: i.mimeType })), () => []);
	const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
	const writes = (text: string) => {
		ex.messageStarted(message(text), T0);
		return (ex.messageEnded(message(text) as any, T0)?.message as any)?.piLoopsRow?.id as string | undefined;
	};
	return { ex, queued, writes };
}

test("our echo that another extension handler prefixed (after the send) is ours, and the message is marked", () => {
	const w = win("never");
	const row = plainJobRow(job, "run-1", "cron:job-1", "", by, T0);
	w.queued.set(row.id, row);
	w.ex.turn(row, T0);
	const rewritten = `CTX: ${row.payload!.text}`;
	w.ex.inputSeen({ source: "extension", text: rewritten }, T0);
	w.ex.agentStarted(T0);
	assert.equal(w.writes(rewritten), row.id);
});

test("an images-only person row's echo inside the send is ours, and its message is marked", () => {
	const w = win("inside");
	const row = personRow("p1", "", [{ type: "image", data: "AAAA", mimeType: "image/png" }] as any, { sessionId: "s", cwd: "/p", createdBy: by }, T0);
	w.queued.set(row.id, row);
	w.ex.produced(row);
	w.ex.turn(row, T0);
	w.ex.agentStarted(T0);
	assert.equal(w.writes("[Image: original 2880x1800, displayed at 2000x1250. Multiply coordinates by 1.44 to map to original image.]"), row.id);
});

test("the person's message that quotes a prompt pi holds unechoed gets no mark", () => {
	const w = win("never");
	const row = plainJobRow(job, "run-1", "cron:job-1", "", by, T0);
	w.queued.set(row.id, row);
	w.ex.turn(row, T0);
	const quoted = `${row.payload!.text} -- why did this run?`;
	w.ex.inputSeen({ source: "interactive", text: quoted }, T0);
	w.ex.agentStarted(T0);
	assert.equal(w.writes(quoted), undefined, "a quoted prefix: no mark");
});

import { drain } from "../src/engine.ts";
import { RequestStore } from "../src/requests.ts";
import { Inbox } from "../src/inbox.ts";
import { TriggerStore } from "../src/triggers.ts";
import { tmp } from "./tmp.ts";

test("a hand-over whose hold found another holder is neither delivered nor an attempt", async () => {
	const dir = tmp("pi-loops-echo-");
	const store = new RequestStore(dir);
	const sinks = { jobs: { exists: () => true, enabled: () => true, goalActive: () => true }, inbox: new Inbox(dir), audit: new TriggerStore(dir) } as any;
	const row = plainJobRow(job, "run-1", "cron:job-1", "", by, T0);
	store.append(row);
	const sent: unknown[] = [];
	const ex = new WindowExecutor({ sendMessage: () => undefined, sendUserMessage: (t: unknown) => void sent.push(t) } as any, { here: () => ({ sessionId: "s", holds: true }), hold: () => undefined, letGo: () => undefined } as any, () => ({ hasUI: false, ui: { notify: () => undefined }, mode: "tui", isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => [] }, abort: () => undefined }) as any, { pid: 1 }, () => true, () => store.list("s"), undefined as any, () => []);
	const out = await drain("s", store, ex, T0, sinks);
	assert.deepEqual([sent, out.delivered, store.list("s").map((r) => [r.id, r.attempts])], [[], [], [["run-1", 0]]]);
});

import { cleanEditor } from "../src/window-claim.ts";
test("an unprefixed prompt in the middle of the person's words is not taken out of the editor", () => {
	assert.equal(cleanEditor("I said: run the tests, why?", [{ text: "run the tests" }]), "I said: run the tests, why?");
	assert.equal(cleanEditor("CTX run the tests", [{ text: "run the tests" }]), "", "control: a handler's words before it");
});
