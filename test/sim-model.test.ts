/**
 * The simulated pi of test/sim/world.ts, held to what a real pi was measured to do, in scenes
 * written out step by step. The seeded schedules of test/sim.test.ts reach each of these by chance,
 * some of them in one seed of a thousand; here each is reached every time, and a model that says
 * something else of pi fails by name.
 *
 * The measurements are of pi 1.2.0: after the page's Stop a row handed over later is written
 * before what pi kept; after Esc in a terminal the queued prompts are in the editor, one text with
 * what the person typed, as another extension's `input` handler left them.
 */
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmp } from "./tmp.ts";
import { conversationHas, enqueue, personRow, plainJobRow, plainRunId, requestFingerprint, ringProduced, stopRow } from "../src/engine.ts";
import { createChecker } from "./sim/invariants.ts";
import { type Mode, EPOCH, PAGE_PID, REWRITTEN, advance, auditedExits, createWorld, drainAs, label, noFacts, piMove, piMoves } from "./sim/world.ts";

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
	await s.step(() => {
		s.world.labels.set("person-9", "person#9");
		const row = personRow("person-9", "the person says 9.", undefined, { sessionId: "c0", cwd: CWD, createdBy: { pid: PAGE_PID, instance: "page", version: "sim" } }, s.world.clock);
		s.world.store.append(row);
		ringProduced(s.world.store.list("c0"), "person-9", requestFingerprint(row), (queued) => s.window.window!.produced(queued));
		advance(s.world, 1000);
	});
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

test("a cleanup that empties the editor loses what the person typed, and the simulation says so", async (t) => {
	const s = scene(t, "tui");
	await s.job("j1", 1);
	await s.drains();
	await s.pi("type");
	await s.pi("esc");
	await s.pi("type");
	s.window.pi.editor.text = "";
	s.world.facts = noFacts();
	assert.equal(s.checker.check().violation?.invariant, TYPED_KEPT);
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
