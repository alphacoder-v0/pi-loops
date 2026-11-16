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
import { cancelRow, conversationHas, enqueue, personRow, plainJobRow, plainRunId, requestFingerprint, ringProduced, ruleResultRow, stopRow } from "../src/engine.ts";
import { createChecker } from "./sim/invariants.ts";
import { type Mode, EPOCH, PAGE_PID, REWRITTEN, advance, auditedExits, clearQueue, createWorld, drainAs, kill, label, noFacts, piMove, piMoves } from "./sim/world.ts";

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
		/** A stop is queued: for row `id`, or with `"running"` for the turn that runs now. */
		stop: (n: number, id: string): Promise<void> =>
			step(() => {
				world.labels.set(`stop-${n}`, `stop#${n}`);
				if (id !== "running") world.targeted.add(id);
				const target = id === "running" ? { current: true as const, started_before: new Date(world.clock + 1000).toISOString() } : { id };
				world.store.append({ ...stopRow("c0", target, "cli", { pid: 1, instance: "cli", version: "sim" }, world.clock), id: `stop-${n}` });
			}),
		/** The page clears the queue: a cancel for every input row, and pi's queue emptied. Returns the number of cancels. */
		clear: (): Promise<number> =>
			step(() => {
				let n = 0;
				const cancels = clearQueue(world, conversation, (target) => {
					const id = `cancel-${++n}`;
					world.labels.set(id, `cancel#${n}`);
					world.targeted.add(target);
					world.store.append({ ...cancelRow("c0", { id: target }, "person", { pid: PAGE_PID, instance: "page", version: "sim" }, world.clock), id });
					return id;
				});
				return cancels?.length ?? -1;
			}),
		/** The names of what the page's pi keeps, in order. */
		kept: (): string[] => window.pi.kept.map((item) => label(world, item.copy!.rowId)),
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
	assert.deepEqual(s.kept(), ["j1#1", "j2#2"]);
	assert.ok(!piMoves(s.window).includes("start") && !piMoves(s.window).includes("refuse"), "pi starts no run for what a stop left, and refuses none of it");
	assert.ok(!piMoves(s.window).includes("enter"), "an empty editor has nothing to send");
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

// P2 (VIA=ctx), g5: an abort asked before the settle. A stop row names the turn that runs, the window asks pi to abort it.
test("a stop row that names the running turn ends it with what waits behind it kept, as the page's Stop does", async (t) => {
	const s = scene(t, "rpc");
	const one = await s.job("j1", 1);
	await s.drains();
	await s.job("j2", 2);
	await s.drains();
	await s.pi("start");
	await s.pi("write");
	await s.stop(3, "running");
	await s.drains();
	const before = s.texts().length;
	await s.pi("settle");
	assert.equal(s.texts().length, before, "nothing behind the aborted turn is written");
	assert.deepEqual(s.kept(), ["j2#2"]);
	assert.equal(s.world.copies.filter((copy) => copy.rowId === one && copy.state === "written").length, 1);
});

// G3, then a run with no stop: the abort is over with the run that it ended.
for (const mode of ["rpc", "tui"] as const) {
	test(`an abort ends with its run: the next run in ${mode === "rpc" ? "the page's pi" : "a terminal"} writes its follow-ups`, async (t) => {
		const s = scene(t, mode);
		const one = await s.job("j1", 1);
		await s.drains();
		await s.pi("type");
		await s.stop(3, one);
		await s.drains();
		await s.pi("settle");
		assert.equal(s.copyOf(one).abortedAtStart, true);
		assert.equal(s.window.pi.aborts, 0);
		await s.drains();
		await s.job("j2", 2);
		await s.drains();
		await s.job("j1", 4);
		await s.drains();
		assert.equal(s.window.pi.queue.length, 2);
		const before = s.texts().length;
		await s.pi("start");
		await s.pi("settle");
		assert.equal(s.texts().length, before + 2, "both prompts of the next run are written");
	});
}

// g10: a second Stop in the page's pi while it keeps messages.
test("a second Stop in the page's pi writes nothing and keeps everything, the new follow-up behind what was kept", async (t) => {
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
	await s.pi("esc");
	assert.equal(s.texts().length, before, "a stopped run writes nothing of what waits");
	assert.deepEqual(s.kept(), ["j1#1", "j2#2", "rule#10"]);
	await s.person(11);
	await s.drains();
	await s.pi("start");
	await s.pi("settle");
	const written = s.texts().slice(before);
	assert.equal(written[0], "the person says 11.");
	assert.match(written[1], /run j1, slot 1\.$/);
	assert.match(written[2], /run j2, slot 2\.$/);
	assert.equal(written[3], "[Trigger rule-10] rule result 10.");
});

// P11: a custom message that asks for a turn reaches the idle pi while it keeps prompts. It starts the run, and what pi kept is written behind it.
test("a custom message can start the run that writes what the page's pi kept", async (t) => {
	const s = scene(t, "rpc");
	await s.job("j1", 1);
	await s.drains();
	await s.job("j2", 2);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	assert.deepEqual(s.kept(), ["j1#1", "j2#2"]);
	// The window took pi for busy and sent the result as a follow-up that asks for a turn; pi had settled by then.
	await s.rule(10);
	await s.step(() => s.window.window!.append(s.world.store.list("c0").find((row) => row.id === "rule-10")!, true));
	assert.deepEqual(piMoves(s.window).filter((move) => move === "start").length, 3, "a message that asks for a turn starts a run");
	const before = s.texts().length;
	await s.pi("start");
	await s.pi("settle");
	const written = s.texts().slice(before);
	assert.equal(written[0], "[Trigger rule-10] rule result 10.", "the run's first message is the custom one");
	assert.match(written[1], /run j1, slot 1\.$/);
	assert.match(written[2], /run j2, slot 2\.$/);
	assert.equal(written.length, 3);
});

// g9: a message the person sends to the page's pi while a turn runs. No row of ours is involved.
test("a message the person sends behind a running turn in the page is a follow-up of no row, and the Stop keeps it", async (t) => {
	const s = scene(t, "rpc");
	await s.pi("type");
	assert.ok(piMoves(s.window).includes("typeBehind"));
	await s.pi("typeBehind");
	assert.equal(s.window.pi.queue.length, 1);
	assert.equal(s.window.pi.queue[0].copy, undefined, "it is no hand-over of ours");
	await s.pi("esc");
	assert.equal(s.window.pi.kept.length, 1);
	assert.equal(s.window.ctx!.hasPendingMessages(), true, "pending is true with nothing of ours held");
	const before = s.texts().length;
	await s.pi("type");
	await s.pi("settle");
	const written = s.texts().slice(before);
	assert.equal(written.length, 2);
	assert.match(written[0], /^typed #/);
	assert.match(written[1], /^typed behind #/, "what pi kept is written behind the starter");
});

test("in a terminal the person cannot queue a message behind a turn: Enter during a run steers (g13)", async (t) => {
	const s = scene(t, "tui");
	await s.pi("type");
	assert.ok(!piMoves(s.window).includes("typeBehind"));
	assert.ok(piMoves(s.window).includes("otherSends"));
});

// P6 (other-sends), G2: another extension's own sendUserMessage.
for (const mode of ["rpc", "tui"] as const) {
	test(`another extension's message is a follow-up of no row; a stop ${mode === "rpc" ? "in the page's pi keeps it" : "in a terminal puts it into the editor"}`, async (t) => {
		const s = scene(t, mode);
		await s.pi("type");
		await s.pi("otherSends");
		assert.equal(s.window.pi.queue.length, 1);
		assert.equal(s.window.pi.queue[0].copy, undefined);
		const text = s.window.pi.queue[0].text;
		const before = s.texts().length;
		await s.pi("esc");
		assert.equal(s.texts().length, before, "a stopped run does not write it");
		if (mode === "rpc") assert.deepEqual(s.window.pi.kept.map((item) => item.text), [text]);
		else assert.equal(s.window.pi.editor.text, text);
	});
}

test("another extension's message to an idle pi starts the run, and a prompt of ours that pi had not started is behind it", async (t) => {
	const s = scene(t, "rpc");
	await s.job("j1", 1);
	assert.deepEqual(await s.drains(), ["j1#1"]);
	const before = s.texts().length;
	await s.pi("otherSends");
	assert.equal(s.window.pi.running, true);
	assert.match(s.texts()[before], /^another extension says #/, "the run's first message is theirs");
	assert.equal(s.window.pi.queue.length, 1, "our prompt is a follow-up now");
	await s.pi("settle");
	assert.match(s.texts().at(-1)!, /run j1, slot 1\.$/);
});

// P10: rpc `clear_queue`, as the page's "clear queue" sends it after its cancels.
test("the page's clear queue during a turn takes the follow-ups out of pi, custom ones too, and the run writes none of them", async (t) => {
	const s = scene(t, "rpc");
	const one = await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.rule(10);
	await s.drains();
	assert.deepEqual(s.window.pi.queue.map((item) => item.custom), [false, true]);
	assert.equal(await s.clear(), 2, "one cancel for each input row");
	assert.deepEqual(s.window.pi.queue, []);
	assert.equal(s.copyOf(one).state, "dropped");
	assert.equal(s.copyOf("rule-10").state, "dropped");
	assert.equal(s.window.ctx!.hasPendingMessages(), false);
	const before = s.texts().length;
	s.world.facts = noFacts();
	piMove(s.world, s.window, "settle");
	assert.equal(s.texts().length, before, "nothing that was cleared is written");
});

test("the page's clear queue after a Stop empties what pi kept, and the next run writes its own message only", async (t) => {
	const s = scene(t, "rpc");
	await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	assert.deepEqual(s.kept(), ["j1#1"]);
	await s.clear();
	assert.deepEqual(s.window.pi.kept, []);
	assert.equal(s.window.ctx!.hasPendingMessages(), false);
	await s.drains();
	const before = s.texts().length;
	await s.pi("type");
	await s.pi("settle");
	assert.equal(s.texts().length, before + 1);
});

test("the page's clear queue does not take a prompt that an idle pi is about to start", async (t) => {
	const s = scene(t, "rpc");
	const one = await s.job("j1", 1);
	await s.drains();
	assert.equal(s.window.pi.queue.length, 1);
	await s.clear();
	assert.equal(s.window.pi.queue.length, 1, "that prompt is not in pi's queue of follow-ups");
	assert.equal(s.copyOf(one).state, "held");
});

/** The window's `personInput` and `inputSeen`, counted, for the scenes that pin whose an input is. */
function counted(window: object) {
	const w = window as { personInput: () => void; inputSeen: (at: number) => void };
	const counts = { person: 0, input: 0 };
	const personInput = w.personInput.bind(w);
	const inputSeen = w.inputSeen.bind(w);
	w.personInput = () => (counts.person++, personInput());
	w.inputSeen = (at: number) => (counts.input++, inputSeen(at));
	return counts;
}

// g9 (source rpc), P6 and g11 (source extension): whose an input is.
test("the person's message behind a turn in the page is their submission, and another extension's is not, to a busy pi or an idle one", async (t) => {
	const s = scene(t, "rpc");
	await s.job("j1", 1);
	await s.drains();
	const counts = counted(s.window.window!);
	// `messageStarted` restarts the grace too, so an input is counted as "at least one more".
	let inputs = counts.input;
	await s.pi("otherSends");
	assert.equal(counts.person, 0, "another extension's message to an idle pi is no submission of the person");
	assert.ok(counts.input > inputs, "and the window is told of its input");
	inputs = counts.input;
	await s.pi("typeBehind");
	assert.equal(counts.person, 1, "the person's message behind a turn is their submission");
	assert.ok(counts.input > inputs, "and the window is told of its input");
	inputs = counts.input;
	await s.pi("otherSends");
	assert.equal(counts.person, 1, "another extension's message during a run is no submission of the person");
	assert.ok(counts.input > inputs, "and the window is told of its input");
});

// g11, g14: another extension can send to an idle pi that holds a prompt of ours unstarted, and theirs goes first.
test("another extension's message is a move the schedules can draw for an idle pi that holds a prompt of ours", async (t) => {
	const s = scene(t, "rpc");
	await s.job("j1", 1);
	await s.drains();
	assert.ok(piMoves(s.window).includes("otherSends"));
	assert.ok(!piMoves(s.window).includes("otherRejected"), "with no run on, pi takes a message sent with no deliverAs");
});

// P10, g12: the page's "clear queue" is the page's: a terminal's pi has none.
test("the page's clear queue reaches the page's pi only: a terminal's pi keeps its follow-ups", async (t) => {
	const s = scene(t, "tui");
	await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.rule(10);
	await s.drains();
	assert.equal(s.window.pi.queue.length, 2);
	assert.equal(await s.clear(), -1, "no page's pi on the conversation");
	assert.equal(s.window.pi.queue.length, 2);
});

// g13: Enter during a run in a terminal steers.
test("a steer in a terminal is the person's submission, goes ahead of the follow-ups, and Esc puts it first into the editor as their words", async (t) => {
	const s = scene(t, "tui");
	const one = await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	assert.ok(piMoves(s.window).includes("steer"));
	const counts = counted(s.window.window!);
	await s.pi("steer");
	assert.deepEqual(counts, { person: 1, input: 1 });
	const steered = s.window.pi.queue[0].text;
	assert.match(steered, /^steered #/, "ahead of the prompt that was queued before it");
	assert.equal(s.window.ctx!.hasPendingMessages(), true);
	await s.pi("esc");
	assert.equal(s.window.pi.editor.text, `${steered}\n\n[Trigger ${one}] run j1, slot 1.`);
	assert.deepEqual(s.window.pi.editor.typed, [steered], "the person's words, which a cleanup must leave");
});

test("a steer that pi takes is written right after the current turn, before the follow-ups", async (t) => {
	const s = scene(t, "tui");
	await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("steer");
	const before = s.texts().length;
	await s.pi("settle");
	const written = s.texts().slice(before);
	assert.match(written[0], /^steered #/);
	assert.match(written[1], /run j1, slot 1\.$/);
});

// g16: two steers keep the order the person sent them, behind the steers and ahead of the follow-ups.
test("two steers are written in the order the person sent them, before the follow-ups", async (t) => {
	const s = scene(t, "tui");
	await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("steer");
	await s.pi("steer");
	const steers = s.window.pi.queue.slice(0, 2).map((item) => item.text);
	const before = s.texts().length;
	await s.pi("settle");
	const written = s.texts().slice(before);
	assert.deepEqual(written.slice(0, 2), steers);
	assert.ok(steers[0] < steers[1], "the first steer is written first");
	assert.match(written[2], /run j1, slot 1\.$/);
});

// g16: Enter during a run sends the editor's whole text as the steer, and empties the editor.
test("a steer with text in the editor is that text: the editor is empty, and a prompt of ours in it is sent again, by the person", async (t) => {
	const s = scene(t, "tui");
	const one = await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	assert.equal(s.window.pi.editor.text, `[Trigger ${one}] run j1, slot 1.`);
	await s.drains(); // the window takes j1 for dropped and hands it over again
	await s.pi("start");
	assert.ok(s.window.pi.current, "pi is in the turn's first message");
	assert.ok(piMoves(s.window).includes("steer"), "the person can press Enter while pi has not written the turn's message yet");
	assert.ok(piMoves(s.window).includes("otherRejected"), "another extension's send with no deliverAs is refused in a terminal too");
	await s.pi("steer");
	assert.deepEqual(s.window.pi.editor, { text: "", put: [], typed: [] }, "the editor is empty after Enter");
	assert.equal(s.window.pi.queue[0].text, `[Trigger ${one}] run j1, slot 1.`, "the steer is what the editor held");
	await s.pi("settle");
	const sent = s.world.copies.filter((copy) => copy.rowId === one && copy.state === "written");
	assert.equal(sent.length, 2, "the turn's own message, and the steer that carried it again");
	assert.equal(sent.filter((copy) => copy.fromTheEditor).length, 1, "the second is the person's, from the editor");
});

test("a steer that carried the editor goes back into it at Esc: the person's words stay theirs, and the prompts of ours stay known", async (t) => {
	const s = scene(t, "tui");
	const one = await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	await s.pi("type"); // words of the person's own, behind the prompt in the editor
	const typed = [...s.window.pi.editor.typed];
	await s.pi("otherSends");
	await s.pi("steer");
	await s.pi("esc");
	assert.ok(s.window.pi.editor.text.includes(`[Trigger ${one}] run j1, slot 1.`));
	assert.deepEqual(s.window.pi.editor.typed, typed);
	assert.equal(s.window.pi.editor.put.filter((put) => put.copy?.rowId === one).length, 1);
});

test("the page's pi has no steer: the person's message during a run there is a follow-up (typeBehind)", async (t) => {
	const s = scene(t, "rpc");
	await s.pi("type");
	assert.ok(!piMoves(s.window).includes("steer"));
	assert.ok(piMoves(s.window).includes("typeBehind"));
});

// g11 (ours first, no deliverAs): pi refuses another extension's send during a run, after its input.
test("another extension's message sent with no deliverAs during a run is an input and no message", async (t) => {
	const s = scene(t, "rpc");
	await s.pi("type");
	assert.ok(piMoves(s.window).includes("otherRejected"));
	const counts = counted(s.window.window!);
	const before = s.texts().length;
	const queued = s.window.pi.queue.length;
	await s.pi("otherRejected");
	assert.deepEqual(counts, { person: 0, input: 1 });
	assert.equal(s.window.pi.queue.length, queued, "nothing is queued");
	await s.pi("settle");
	assert.equal(s.texts().length, before, "and nothing is written");
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
