// The lease's hold the window keeps while pi holds a prompt of ours, and the phase a hand-over gets. From the Gates review of PR 261.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowExecutor } from "../src/window-executor.ts";
import { plainJobRow, ruleResultRow } from "../src/engine.ts";
import type { Row } from "../src/requests.ts";

const T0 = Date.parse("2026-06-01T12:00:00Z");
const by = { pid: 1, instance: "w", version: "0" };
const job = (id: string) => ({ id, sessionId: "s", prompt: `do ${id}`, cwd: "/p", model: undefined, thinking: undefined }) as any;

function win(mode: "tui" | "rpc") {
	const lease = { held: false, holds: 0, letGos: 0 };
	const rows: Row[] = [];
	const entries: unknown[] = [];
	const ctx = { idle: true, pending: false, hasUI: true, mode, ui: { notify: () => undefined, getEditorText: () => "", setEditorText: () => undefined }, isIdle: () => ctx.idle, hasPendingMessages: () => ctx.pending, sessionManager: { getEntries: () => entries }, abort: () => undefined };
	const binding = { here: () => ({ sessionId: "s", holds: true }), hold: () => ((lease.held = true), lease.holds++, {} as any), letGo: () => void ((lease.held = false), lease.letGos++) };
	const ex = new WindowExecutor({ sendMessage: () => undefined, sendUserMessage: () => undefined } as any, binding as any, () => ctx as any, { pid: 1 }, () => true, () => rows, undefined as any, () => []);
	const writes = (text: string) => {
		const message = { role: "user", content: [{ type: "text", text }] };
		ex.messageStarted(message, T0);
		entries.push({ type: "message", timestamp: new Date(T0).toISOString(), message: ex.messageEnded(message as any, T0)?.message ?? message });
	};
	return { lease, rows, ctx, ex, writes };
}

test("the window lets go of the lease's hold once pi wrote the prompt it held", () => {
	const w = win("rpc");
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row);
	w.ex.turn(row, T0);
	assert.equal(w.lease.held, true, "held from the hand-over");
	w.ex.agentStarted(T0);
	w.ex.view("s");
	assert.equal(w.lease.held, true, "still held while pi has not written it");
	w.writes(row.payload!.text);
	w.ex.agentEnded();
	w.ex.settled(false);
	w.rows.length = 0;
	w.ex.view("s");
	assert.equal(w.lease.held, false, "let go: a terminal may take the conversation now");
});

test("after the page's Stop a prompt pi keeps keeps the hold", () => {
	const w = win("rpc");
	const one = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	const two = plainJobRow(job("j2"), "run-2", "cron:j2", "", by, T0);
	w.rows.push(one, two);
	w.ex.turn(one, T0);
	w.ex.agentStarted(T0);
	w.writes(one.payload!.text);
	w.ctx.idle = false;
	w.ex.turn(two, T0); // a run began between the engine's look and the send: queued behind it
	w.ctx.idle = true; w.ctx.pending = true; // the page's Stop keeps it
	w.ex.agentEnded();
	w.ex.settled(true);
	w.rows.splice(0, 1); // one left as delivered
	w.ex.view("s");
	assert.equal(w.lease.held, true, "pi keeps run-2: the hold stays, a terminal is a viewer");
});

test("a rule's result handed as a follow-up during a run is held on the lease", () => {
	const w = win("rpc");
	w.ctx.idle = false;
	const r = ruleResultRow("s", "a result", { traceId: "tr-1", sourceLabel: "rule-1", cwd: "/p" }, by, T0);
	w.rows.push(r);
	w.ex.append(r, true);
	assert.equal(w.lease.held, true);
});

test("a prompt handed while a run is on is queued behind it, never judged by the grace of an idle pi", () => {
	const w = win("rpc");
	w.ctx.idle = false;
	const row = plainJobRow(job("j1"), "run-1", "cron:j1", "", by, T0);
	w.rows.push(row);
	w.ex.turn(row, T0);
	const v = w.ex.view("s");
	assert.equal(v.inFlight.has(row.id), true);
	assert.equal(v.inFlightSince?.has(row.id) ?? false, false);
});
