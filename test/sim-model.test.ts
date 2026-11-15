/**
 * The simulated pi of test/sim/world.ts, held to what a real pi was measured to do, in scenes
 * written out step by step. The seeded schedules of test/sim.test.ts reach each of these by chance,
 * some of them in one seed of a thousand; here each is reached every time, and a model that says
 * something else of pi fails by name.
 *
 * The measurements are of pi 1.2.0 (.docs/redesign-0243/signatures/M3b-probes.md; the probe each
 * scene stands on is in its comment). A fact of pi that world.ts states and no scene here holds is
 * a fact nobody checks: a mutant of it passes every schedule.
 */
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmp } from "./tmp.ts";
import { conversationHas, enqueue, personRow, plainJobRow, plainRunId, requestFingerprint, ringProduced, ruleResultRow, stopRow } from "../src/engine.ts";
import { createChecker } from "./sim/invariants.ts";
import { type Mode, EPOCH, PAGE_PID, REWRITTEN, advance, auditedExits, createWorld, drainAs, kill, label, noFacts, piMove, piMoves } from "./sim/world.ts";

const CWD = "/p";
const TYPED_KEPT = "what the person typed stays in the editor until they send it";

/** One conversation with one window, its pi in `mode`, and every check of the simulation after every step. */
function scene(t: TestContext, mode: Mode, opts: { rewrites?: boolean } = {}) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: EPOCH });
	const fsync = fs.fsyncSync;
	fs.fsyncSync = () => undefined;
	syncBuiltinESMExports();
	t.after(() => {
		fs.fsyncSync = fsync;
		syncBuiltinESMExports();
	});
	const time = { setTime: (ms: number) => t.mock.timers.setTime(ms), tick: (ms: number) => t.mock.timers.tick(ms) };
	const world = createWorld(tmp("pi-loops-sim-model-"), time, [{ kind: "background", running: false, modes: [mode, "tui"] }], opts);
	const conversation = world.conversations[0];
	const window = conversation.slots[0].process!;
	const checker = createChecker(world);
	/** One step: what it did is checked as a step of a schedule is, and a known defect is not a failure here. */
	const step = async <T>(act: () => T | Promise<T>): Promise<T> => {
		world.facts = noFacts();
		const result = await act();
		assert.equal(checker.check().violation, undefined);
		return result;
	};
	return {
		world,
		window,
		step,
		checker,
		/** The clock queues a slot of job `id`; returns the row's id. */
		job: (id: string, slot: number): Promise<string> =>
			step(() => {
				const run = plainRunId(id, `c0:${slot}`);
				world.labels.set(run, `${id}#${slot}`);
				enqueue(world.store, plainJobRow({ id, sessionId: "c0", prompt: `run ${id}, slot ${slot}.`, cwd: CWD }, run, `cron:${id}`, "", { pid: window.pid, instance: window.name, version: "sim" }, world.clock), (queued) => conversationHas(conversation.entries, queued));
				return run;
			}),
		/** The window drains; returns the names of the rows it handed over. */
		drains: (): Promise<string[]> => step(async () => (await drainAs(world, window, false))!.delivered.map((id) => label(world, id))),
		/** The page queues a message of the person and rings the window. */
		person: (n: number): Promise<void> =>
			step(() => {
				world.labels.set(`person-${n}`, `person#${n}`);
				const row = personRow(`person-${n}`, `the person says ${n}.`, undefined, { sessionId: "c0", cwd: CWD, createdBy: { pid: PAGE_PID, instance: "page", version: "sim" } }, world.clock);
				world.store.append(row);
				ringProduced(world.store.list("c0"), row.id, requestFingerprint(row), (queued) => window.window!.produced(queued));
				advance(world, 1000);
			}),
		/** A rule's result is queued: a custom message, which starts no turn. */
		rule: (n: number): Promise<void> =>
			step(() => {
				world.labels.set(`rule-${n}`, `rule#${n}`);
				world.store.append(ruleResultRow("c0", `[Trigger rule-${n}] rule result ${n}.`, { traceId: `rule-${n}`, sourceLabel: "r1", cwd: CWD }, { pid: window.pid, instance: window.name, version: "sim" }, world.clock));
			}),
		/** A stop that names row `id` is queued. */
		stop: (n: number, id: string): Promise<void> =>
			step(() => {
				world.labels.set(`stop-${n}`, `stop#${n}`);
				world.targeted.add(id);
				world.store.append({ ...stopRow("c0", { id }, "cli", { pid: 1, instance: "cli", version: "sim" }, world.clock), id: `stop-${n}` });
			}),
		copyOf: (rowId: string) => world.copies.find((copy) => copy.rowId === rowId)!,
		pi: (move: Parameters<typeof piMove>[2]): Promise<void> => step(() => piMove(world, window, move)),
		/** The text of every message in the conversation, in the order pi wrote them. */
		texts: (): string[] => conversation.entries.map((entry) => (entry.type === "message" ? entry.message.content[0].text : entry.content)),
	};
}

test("after the page's Stop the simulated pi starts no run for what it kept, and writes it behind the message that starts the next one", async (t) => {
	const s = scene(t, "rpc");
	await s.job("j1", 1);
	assert.deepEqual(await s.drains(), ["j1#1"]);
	await s.job("j2", 2);
	assert.deepEqual(await s.drains(), ["j2#2"]);
	// A run begins before pi takes up either prompt: both are queued behind it. Then the page's Stop.
	await s.pi("type");
	await s.pi("esc");
	assert.deepEqual(s.window.pi.kept.map((item) => label(s.world, item.copy!.rowId)), ["j1#1", "j2#2"]);
	assert.deepEqual(piMoves(s.window), ["type"], "pi starts no run for what a stop left, and refuses none of it");
	// The page queues a message of the person, and the window hands it to the idle pi.
	await s.person(9);
	assert.deepEqual(await s.drains(), ["person#9"]);
	const before = s.texts().length;
	await s.pi("start");
	await s.pi("settle");
	const written = s.texts().slice(before);
	assert.equal(written.length, 3);
	assert.equal(written[0], "the person says 9.", "the row handed over after the stop is written first");
	assert.match(written[1], /^\[Trigger \S+\] run j1, slot 1\.$/);
	assert.match(written[2], /^\[Trigger \S+\] run j2, slot 2\.$/);
	assert.deepEqual(s.window.pi.kept, []);
});

for (const rewrites of [false, true]) {
	test(`after Esc in a terminal the editor is one text: the queued prompts, then what the person types, and Enter sends all of it${rewrites ? ", each as another extension rewrote it" : ""}`, async (t) => {
		const s = scene(t, "tui", { rewrites });
		const one = await s.job("j1", 1);
		await s.drains();
		const two = await s.job("j2", 2);
		await s.drains();
		await s.pi("type");
		const before = s.texts().length;
		await s.pi("esc");
		const queued = (id: string, words: string) => `${rewrites ? REWRITTEN : ""}[Trigger ${id}] ${words}`;
		const prompts = `${queued(one, "run j1, slot 1.")}\n\n${queued(two, "run j2, slot 2.")}`;
		assert.equal(s.window.pi.editor.text, prompts);
		assert.deepEqual(s.window.pi.queue, [], "a stop in a terminal clears pi's queue");
		// The person types into the editor that holds the prompts: no message, and their words come last.
		await s.pi("type");
		const [typed] = s.window.pi.editor.typed;
		assert.equal(s.window.pi.editor.text, `${prompts}\n\n${typed}`);
		assert.equal(s.texts().length, before, "what is in the editor is not sent");
		await s.pi("enter");
		assert.deepEqual(s.texts().slice(before), [`${rewrites ? REWRITTEN : ""}${prompts}\n\n${typed}`]);
		assert.equal(s.window.pi.editor.text, "");
	});
}

// G2 (ctx.ui): an extension reads and sets the editor's one text.
test("a cleanup that takes one prompt out of the editor leaves the rest, and Enter sends what is left", async (t) => {
	const s = scene(t, "tui");
	const one = await s.job("j1", 1);
	await s.drains();
	const two = await s.job("j2", 2);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	await s.pi("type");
	const [typed] = s.window.pi.editor.typed;
	const ui = s.window.ctx!.ui;
	assert.equal(ui.getEditorText(), `[Trigger ${one}] run j1, slot 1.\n\n[Trigger ${two}] run j2, slot 2.\n\n${typed}`);
	await s.step(() => ui.setEditorText(ui.getEditorText().replace(`[Trigger ${one}] run j1, slot 1.\n\n`, "")));
	const before = s.texts().length;
	await s.pi("enter");
	assert.deepEqual(s.texts().slice(before), [`[Trigger ${two}] run j2, slot 2.\n\n${typed}`]);
	const sent = s.world.copies.filter((copy) => copy.fromTheEditor).map((copy) => label(s.world, copy.rowId));
	assert.deepEqual(sent, ["j2#2"], "only the hand-over whose paragraph was still in the text is sent from the editor");
});

test("a cleanup that empties the editor loses what the person typed, and the simulation says so", async (t) => {
	const s = scene(t, "tui");
	await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	await s.pi("type");
	s.window.ctx!.ui.setEditorText("");
	s.world.facts = noFacts();
	assert.equal(s.checker.check().violation?.invariant, TYPED_KEPT);
});

// G2 (VIA=esc TYPED=...): the queued texts stand before what the editor holds.
test("a second stop in a terminal puts its texts before what the editor holds", async (t) => {
	const s = scene(t, "tui");
	const one = await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	await s.pi("type");
	const [typed] = s.window.pi.editor.typed;
	const held = `[Trigger ${one}] run j1, slot 1.\n\n${typed}`;
	assert.equal(s.window.pi.editor.text, held);
	// Two more prompts reach the idle pi; it starts the first, and Esc comes with the second queued.
	await s.job("j2", 2);
	await s.drains();
	await s.job("j1", 3);
	await s.drains();
	assert.equal(s.window.pi.queue.length, 2);
	const queued = s.window.pi.queue[1].text;
	await s.pi("start");
	await s.pi("esc");
	assert.equal(s.window.pi.editor.text, `${queued}\n\n${held}`);
});

// G2 (VIA=ctx): a custom follow-up is dropped by a stop in a terminal and is not in the editor.
test("a stop in a terminal drops a custom follow-up and puts only user messages into the editor", async (t) => {
	const s = scene(t, "tui");
	const one = await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.rule(10);
	await s.drains();
	assert.deepEqual(s.window.pi.queue.map((item) => item.custom), [false, true]);
	await s.pi("esc");
	assert.equal(s.window.pi.editor.text, `[Trigger ${one}] run j1, slot 1.`);
	assert.equal(s.copyOf("rule-10").state, "dropped");
});

// G4: what the page's Stop left is written before a follow-up queued in the next run.
test("the run after the page's Stop writes what pi kept before its own follow-ups", async (t) => {
	const s = scene(t, "rpc");
	await s.job("j1", 1);
	await s.drains();
	await s.job("j2", 2);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	await s.person(9);
	await s.drains();
	await s.pi("start");
	await s.pi("write");
	await s.rule(10);
	await s.drains();
	const before = s.texts().length;
	await s.pi("settle");
	const written = s.texts().slice(before);
	assert.equal(written.length, 3);
	assert.match(written[0], /run j1, slot 1\.$/);
	assert.match(written[1], /run j2, slot 2\.$/);
	assert.equal(written[2], "[Trigger rule-10] rule result 10.", "the follow-up of the new run comes last");
});

// G3: `ctx.abort()` asked at the `message_start` of a follow-up. Pi writes that message and stops there.
for (const mode of ["rpc", "tui"] as const) {
	test(`a follow-up that a stop named is written and aborted as it starts, and what waits behind it is ${mode === "rpc" ? "kept by the page's pi" : "in a terminal's editor"}`, async (t) => {
		const s = scene(t, mode);
		const one = await s.job("j1", 1);
		await s.drains();
		const two = await s.job("j2", 2);
		await s.drains();
		// A run begins with both prompts queued behind it, and a stop names the first of them.
		await s.pi("type");
		await s.stop(3, one);
		await s.drains();
		const before = s.texts().length;
		await s.pi("settle");
		assert.deepEqual(s.texts().slice(before), [`[Trigger ${one}] run j1, slot 1.`], "the named follow-up is written, and nothing behind it");
		assert.equal(s.copyOf(one).abortedAtStart, true);
		if (mode === "rpc") {
			assert.deepEqual(s.window.pi.kept.map((item) => label(s.world, item.copy!.rowId)), ["j2#2"]);
			assert.equal(s.copyOf(two).gaveUp, "stop");
			assert.equal(s.window.pi.editor.text, "");
		} else {
			assert.equal(s.copyOf(two).state, "dropped");
			assert.equal(s.window.pi.editor.text, `[Trigger ${two}] run j2, slot 2.`);
			assert.deepEqual(s.window.pi.kept, []);
		}
	});
}

// P2, P3, G1: `ctx.hasPendingMessages()` and rpc's `pendingMessageCount`.
test("hasPendingMessages is true for the user messages pi holds behind a turn, and for nothing else", async (t) => {
	const s = scene(t, "rpc");
	const pending = () => s.window.ctx!.hasPendingMessages();
	await s.job("j1", 1);
	await s.drains();
	assert.equal(pending(), false, "a prompt that an idle pi has not started is not pending");
	await s.pi("type");
	assert.equal(pending(), true, "a user follow-up behind a running turn");
	await s.pi("esc");
	assert.equal(pending(), true, "kept by the page's Stop");
	await s.pi("type");
	await s.pi("settle");
	assert.equal(pending(), false);
	await s.pi("type");
	await s.rule(10);
	await s.drains();
	await s.pi("esc");
	assert.equal(s.window.pi.kept.length, 1);
	assert.equal(pending(), false, "a custom follow-up that pi kept is not counted");
});

// P3: after a stop in a terminal nothing is pending.
test("after a stop in a terminal hasPendingMessages is false", async (t) => {
	const s = scene(t, "tui");
	await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	assert.equal(s.window.ctx!.hasPendingMessages(), true);
	await s.pi("esc");
	assert.equal(s.window.ctx!.hasPendingMessages(), false);
});

// G1: pi emits `message_start` and `message_end` for a custom message, with the role `custom`.
test("a custom message has its two events, and they do not say it is a user message", async (t) => {
	const s = scene(t, "rpc");
	const roles: string[] = [];
	const window = s.window.window!;
	const started = window.messageStarted.bind(window);
	window.messageStarted = (message, now) => {
		roles.push((message as { role: string }).role);
		started(message, now);
	};
	await s.rule(10);
	await s.drains();
	assert.deepEqual(s.texts(), ["[Trigger rule-10] rule result 10."]);
	assert.deepEqual(roles, ["custom"]);
});

test("a process that dies takes what its pi kept with it", async (t) => {
	const s = scene(t, "rpc");
	const one = await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	assert.equal(s.copyOf(one).state, "held");
	await s.step(() => kill(s.world, s.window));
	assert.equal(s.copyOf(one).state, "died");
});

test("a turn that a stop named while a terminal's pi held it unstarted, and that Esc then dropped, leaves as cancelled and is not offered again", async (t) => {
	const s = scene(t, "tui");
	const run = await s.job("j1", 1);
	assert.deepEqual(await s.drains(), ["j1#1"]);
	// A run begins before pi takes the prompt up, and a stop names the prompt's row while it is queued behind that run.
	await s.pi("type");
	await s.step(() => {
		s.world.labels.set("stop-1", "stop#1");
		s.world.targeted.add(run);
		s.world.store.append({ ...stopRow("c0", { id: run }, "cli", { pid: 1, instance: "cli", version: "sim" }, s.world.clock), id: "stop-1" });
	});
	await s.drains();
	assert.equal(s.world.copies.find((copy) => copy.rowId === run)?.stopNamed, true, "the stop found pi holding the turn unstarted");
	await s.pi("esc");
	assert.equal(s.world.copies.find((copy) => copy.rowId === run)?.state, "dropped");
	await s.drains();
	assert.deepEqual(s.world.store.list("c0").map((row) => label(s.world, row.id)), []);
	assert.equal(auditedExits(s.world, run)[0], "cancelled");
	// Past every backoff: nothing is left to hand over.
	await s.step(() => advance(s.world, 3_600_000));
	assert.deepEqual(await s.drains(), []);
	assert.equal(s.world.copies.filter((copy) => copy.rowId === run).length, 1, "the row was handed over once");
});
