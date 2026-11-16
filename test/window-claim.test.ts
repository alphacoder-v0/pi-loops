import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { markFor } from "../src/mark.ts";
import type { OtherSlot, Phase, Slot, TurnSlot } from "../src/window-claim.ts";
import { claimOf, cleanEditor, narrowestCap, settleSlots } from "../src/window-claim.ts";

function turn(id: string, text: string, phase: Phase, opts: { prefix?: string; stop?: true; echoed?: boolean } = {}): TurnSlot {
	return {
		whose: "turn",
		mark: markFor({ lane: "s1", id }),
		text,
		...(opts.prefix === undefined ? {} : { prefix: opts.prefix }),
		cap: { kind: "row", id, mode: "attended" },
		phase,
		...(opts.stop ? { stop: true as const } : {}),
		echoed: opts.echoed ?? false,
	};
}

function other(text: string, from: "person" | "extension" = "person"): Slot {
	return { whose: "other", from, text };
}

function append(id: string): Slot {
	return { whose: "append", mark: markFor({ lane: "s1", id }) };
}

function writingTurn(id: string, text: string): TurnSlot {
	const pending = turn(id, text, { is: "pending", since: 0 });
	const claim = claimOf(text, [pending]);
	if (claim.by !== "turn") throw new Error("pending turn did not claim its exact text");
	return turn(id, text, { is: "writing", claim });
}

function assertTurnClaim(result: ReturnType<typeof claimOf>, id: string, message?: string): void {
	assert.equal(result.by, "turn", message);
	if (result.by === "turn") assert.equal(result.slot.mark.id, id, message);
}

function assertOtherClaim(result: ReturnType<typeof claimOf>, expected: Slot, message?: string): void {
	assert.equal(result.by, "other", message);
	if (result.by === "other") assert.equal(result.slot, expected, message);
}

test("claimOf assigns ordered trigger prompts to their own rows", () => {
	const a = turn("a", "[Trigger a] one", { is: "queued" });
	const b = turn("b", "[Trigger b] two", { is: "queued" });
	assertTurnClaim(claimOf(a.text, [a, b]), "a");
	assertTurnClaim(claimOf(b.text, [a, b]), "b");
});

test("claimOf chooses the oldest exact turn with duplicate text", () => {
	const a = turn("a", "yes", { is: "queued" });
	const b = turn("b", "yes", { is: "queued" });
	assertTurnClaim(claimOf("yes", [a, b]), "a");
});

test("claimOf prefers an opening exact turn over an older queued turn", () => {
	const queued = turn("queued", "yes", { is: "queued" });
	const opening = turn("opening", "yes", { is: "opening" });
	assertTurnClaim(claimOf("yes", [queued, opening]), "opening");
});

test("claimOf gives exact text to the person's other slot", () => {
	const person = other("yes");
	const row = turn("row", "yes", { is: "queued" });
	assertOtherClaim(claimOf("yes", [person, row]), person);
});

test("claimOf strips pi's trailing image note", () => {
	// A refused slot claims by the very text only: the note must go for the text to be the same.
	const row = turn("row", "describe this", { is: "refused" });
	assertTurnClaim(claimOf("describe this [Image omitted: unsupported format]", [row]), "row");
});

test("claimOf matches a rewritten prompt with words around it", () => {
	const row = turn("row", "Run the tests", { is: "queued" });
	assertTurnClaim(claimOf("[rewritten] Run the tests", [row]), "row");
});

test("claimOf chooses the longest matching turn text", () => {
	const short = turn("short", "fix", { is: "queued" });
	const long = turn("long", "fix it and push", { is: "queued" });
	assertTurnClaim(claimOf("[rewritten] fix it and push", [short, long]), "long");
});

test("claimOf gives an exact turn match priority over a waiting other slot", () => {
	const waiting = other("/review the engine");
	const row = turn("row", "Run the tests and report what fails. the engine", { is: "queued" });
	assertTurnClaim(claimOf(row.text, [waiting, row]), "row");
});

test("claimOf gives a waiting other slot priority over approximate turn text", () => {
	const waiting = other("/review");
	const row = turn("row", "Run the", { is: "queued" });
	assertOtherClaim(claimOf("Run the tests.", [waiting, row]), waiting);
});

test("claimOf matches an other slot with words around its text", () => {
	const extension = other("ok", "extension");
	assertOtherClaim(claimOf("ok, now run it", [extension]), extension);
});

test("claimOf gives words around to the other slot whose text they are, not to the oldest other slot", () => {
	const older = other("/review", "person");
	const extension = other("now run it", "extension");
	assertOtherClaim(claimOf("ok, now run it", [older, extension]), extension);
});

test("claimOf gives a rewritten message with no prefix to the prompt of ours only when no input of someone else waits", () => {
	const ours = turn("ours", "the person says 1.", { is: "opening" });
	assertTurnClaim(claimOf("[rewritten] the person says 1.", [ours]), "ours");
	for (const behind of [undefined, "followUp", "steer"] as const) {
		const waiting: OtherSlot = { ...other("another extension says 2.", "extension"), ...(behind ? { behind } : {}) };
		assertOtherClaim(claimOf("[rewritten] the person says 1.", [ours, waiting]), waiting, `${behind ?? "idle"}: no mark`);
	}
});

test("claimOf reads no order of pi: with someone else's input waiting, words around a prompt of ours are ours only with its prefix", () => {
	const prefixed = turn("ours", "[Trigger ours] run j1.", { is: "queued" }, { prefix: "[Trigger ours] " });
	const plain = turn("plain", "address finding 1.", { is: "queued" });
	for (const order of ["before", "after"] as const) {
		const theirs: OtherSlot = { ...other("another extension says 2.", "extension"), behind: "followUp" };
		const slots = (ours: TurnSlot) => (order === "before" ? [ours, theirs] : [theirs, ours]);
		assertTurnClaim(claimOf("[rewritten] [Trigger ours] run j1.", slots(prefixed)), "ours", `prefix, ${order}`);
		assertOtherClaim(claimOf("[rewritten] address finding 1.", slots(plain)), theirs, `no prefix, ${order}: no mark`);
	}
});

test("claimOf gives the very same words to the run's starter before a refused slot: pi may have dropped the refused one, and either message answers one of the two", () => {
	const late = turn("late", "yes", { is: "refused" });
	const starter = turn("starter", "yes", { is: "opening" });
	assertTurnClaim(claimOf("yes", [late, starter]), "starter");
	const queued = turn("queued", "yes", { is: "queued" });
	assertTurnClaim(claimOf("yes", [late, queued]), "queued");
});

test("claimOf gives a rewritten message with a prompt's [Trigger <id>] to that prompt, though another's input waits", () => {
	const ours = turn("ours", "[Trigger run-a] run j1.", { is: "refused" }, { prefix: "[Trigger run-a] " });
	const stale = other("another extension says 1.", "extension");
	assertTurnClaim(claimOf("[rewritten] [Trigger run-a] run j1.", [stale, ours]), "ours");
	const unprefixed = turn("plain", "address finding 1.", { is: "queued" });
	assertOtherClaim(claimOf("[rewritten] address finding 1.", [stale, unprefixed]), stale);
});

test("claimOf gives the very same words to a prompt no stop named before one a stop named: a wrong guess must not abort a message that is owed", () => {
	const stopped: TurnSlot = { ...turn("stopped", "the person says 3.", { is: "refused" }, { stop: true }), left: true };
	const owed = turn("owed", "the person says 3.", { is: "opening" });
	assertTurnClaim(claimOf("the person says 3.", [stopped, owed]), "owed");
	assertTurnClaim(claimOf("[rewritten] the person says 3.", [stopped, owed]), "owed");
	assertTurnClaim(claimOf("the person says 3.", [stopped]), "stopped");
	const stoppedOpening: TurnSlot = turn("stopped-opening", "the person says 3.", { is: "opening" }, { stop: true });
	const queuedOwed = turn("queued-owed", "the person says 3.", { is: "queued" });
	assertTurnClaim(claimOf("the person says 3.", [stoppedOpening, queuedOwed]), "queued-owed", "a stop named the run's starter: the owed one claims");
});

test("settleSlots puts no slot whose row left the file into gone: the same row may be queued again", () => {
	const left: TurnSlot = { ...turn("same", "run j1.", { is: "written" }, { stop: true }), left: true };
	const opening: TurnSlot = { ...turn("same", "run j1.", { is: "opening" }, { stop: true }), left: true };
	for (const how of [{ aborted: false, terminal: false }, { aborted: true, terminal: true }, { aborted: true, terminal: false }]) {
		assert.equal(settleSlots([left], how, () => false).gone.size, 0);
		assert.equal(settleSlots([opening], how, () => false).gone.size, 0);
	}
});

test("claimOf gives a refused prompt a late send in its words, rewritten or not, and a prompt pi holds before it with the same words", () => {
	const row = turn("row", "report status", { is: "refused" });
	assertTurnClaim(claimOf("report status", [row]), "row");
	assertTurnClaim(claimOf("[rewritten] report status", [row]), "row");
	const queued = turn("queued", "report status", { is: "opening" });
	assertTurnClaim(claimOf("[rewritten] report status", [queued, row]), "queued", "pi may have dropped the refused one");
	assert.equal(claimOf("report status, please", [row, other("report")]).by, "other");
});

test("claimOf never claims writing, written or append slots", () => {
	const writing = writingTurn("writing", "same");
	const written = turn("written", "same", { is: "written" });
	const app = append("append");
	assert.equal(claimOf("same", [writing, written, app]).by, "nobody");
});

test("claimOf returns nobody when no slot explains the message", () => {
	assert.deepEqual(claimOf("unmatched", []), { by: "nobody" });
});

test("claimOf gives an empty image-only message to an empty other slot", () => {
	const image = other("");
	assertOtherClaim(claimOf("[Image omitted: unsupported format]", [image]), image);
});

type Column = "no stop" | "terminal stop" | "non-terminal stop";
interface SettleCase {
	name: string;
	slot: Slot;
	landed?: boolean;
	expect: (column: Column) => { kept: boolean; reason?: string; editor?: boolean };
}
const settleCases: SettleCase[] = [
	{
		name: "landed turn or append",
		slot: turn("landed", "prompt", { is: "queued" }),
		landed: true,
		expect: () => ({ kept: false }),
	},
	{
		name: "pending turn",
		slot: turn("pending", "prompt", { is: "pending", since: 1 }),
		expect: () => ({ kept: true }),
	},
	{
		name: "opening or queued turn",
		slot: turn("waiting", "prompt", { is: "queued" }, { prefix: "[Trigger waiting] " }),
		expect: (column) => column === "no stop" ? { kept: false, reason: "lost" } : column === "terminal stop" ? { kept: false, reason: "dropped", editor: true } : { kept: true },
	},
	{
		name: "written turn",
		slot: turn("written", "prompt", { is: "written" }),
		expect: () => ({ kept: false, reason: "lost" }),
	},
	{
		name: "refused turn",
		slot: turn("refused", "prompt", { is: "refused" }),
		expect: (column) => (column === "terminal stop" ? { kept: false, editor: true } : column === "no stop" ? { kept: false } : { kept: true }),
	},
	{
		name: "append",
		slot: append("append"),
		expect: (column) => column === "no stop" ? { kept: false, reason: "lost" } : column === "terminal stop" ? { kept: false, reason: "dropped" } : { kept: true },
	},
	{
		name: "other slot",
		slot: other("person text"),
		expect: (column) => column === "non-terminal stop" ? { kept: true } : { kept: false },
	},
];
const columns: Array<{ name: Column; how: { aborted: boolean; terminal: boolean } }> = [
	{ name: "no stop", how: { aborted: false, terminal: false } },
	{ name: "terminal stop", how: { aborted: true, terminal: true } },
	{ name: "non-terminal stop", how: { aborted: true, terminal: false } },
];
for (const row of settleCases) {
	for (const column of columns) {
		test(`settleSlots ${row.name}: ${column.name}`, () => {
			let asked = 0;
			const slots = row.landed ? [row.slot, append("landed-append")] : [row.slot];
			const result = settleSlots(slots, column.how, (id) => { asked++; return row.landed === true || id === "landed-append"; });
			const expected = row.expect(column.name);
			assert.equal(result.slots.length, expected.kept ? slots.length : 0);
			assert.deepEqual([...result.gone], expected.reason ? [[row.slot.whose === "other" ? "" : row.slot.mark.id, expected.reason]] : []);
			assert.equal(result.editor.length === 1, expected.editor ?? false);
			assert.equal(asked, row.slot.whose === "other" ? 0 : slots.length);
		});
	}
}

test("settleSlots reads writing turns as queued in every column", () => {
	for (const column of columns) {
		const slot = writingTurn("writing", "prompt");
		const result = settleSlots([slot], column.how, () => false);
		assert.equal(result.slots.length === 1, column.name === "non-terminal stop");
		if (result.slots[0]?.whose === "turn") assert.deepEqual(result.slots[0].phase, { is: "queued" });
	}
});

test("settleSlots turns stopped prompts into stopped gone reasons", () => {
	for (const column of columns.slice(0, 2)) {
		const slot = turn("stop-row", "prompt", { is: "queued" }, { stop: true });
		const result = settleSlots([slot], column.how, () => false);
		assert.equal(result.gone.get("stop-row"), "stopped");
	}
	const written = turn("stop-written", "prompt", { is: "written" }, { stop: true });
	assert.equal(settleSlots([written], columns[0].how, () => false).gone.get("stop-written"), "stopped");
});

test("settleSlots returns dropped editor prompts in list order with their prefixes", () => {
	const first = turn("first", "first prompt", { is: "queued" }, { prefix: "[Trigger first] " });
	const second = turn("second", "second prompt", { is: "opening" }, { prefix: "[Trigger second] " });
	const result = settleSlots([first, second], { aborted: true, terminal: true }, () => false);
	assert.deepEqual(result.editor, [
		{ text: "first prompt", prefix: "[Trigger first] " },
		{ text: "second prompt", prefix: "[Trigger second] " },
	]);
});

test("settleSlots does not change the input slots or their objects", () => {
	const input: Slot[] = [
		writingTurn("writing", "one"),
		turn("queued", "two", { is: "queued" }),
		append("append"),
		other("person"),
	];
	const before = structuredClone(input);
	settleSlots(input, { aborted: true, terminal: false }, () => false);
	assert.deepEqual(input, before);
});

test("cleanEditor removes ordered prompts from paragraphs", () => {
	const editor = "[Trigger run-aaa] queued one\n\nqueued two\n\nwords the person typed";
	assert.equal(cleanEditor(editor, [
		{ text: "[Trigger run-aaa] queued one", prefix: "[Trigger run-aaa] " },
		{ text: "queued two" },
	]), "words the person typed");
});

test("cleanEditor removes rewritten prompts", () => {
	const editor = "[rewritten] [Trigger run-aaa] queued one\n\n[rewritten] queued two\n\nwords the person typed";
	assert.equal(cleanEditor(editor, [
		{ text: "[Trigger run-aaa] queued one", prefix: "[Trigger run-aaa] " },
		{ text: "queued two" },
	]), "words the person typed");
});

test("cleanEditor removes a prefixed prompt with appended handler words", () => {
	assert.equal(cleanEditor("[Trigger run-aaa] queued one (sent by bot)\n\nmine", [
		{ text: "[Trigger run-aaa] queued one", prefix: "[Trigger run-aaa] " },
	]), "mine");
});

test("cleanEditor returns the same string when a prompt is absent", () => {
	const editor = "[Trigger run-aaa] queued one (sent by bot)\n\nmine";
	assert.equal(cleanEditor(editor, [{ text: "[Trigger other] missing", prefix: "[Trigger other] " }]) === editor, true);
});

test("cleanEditor removes a two-paragraph prompt", () => {
	assert.equal(cleanEditor("line one\n\nline two\n\nmine", [{ text: "line one\n\nline two" }]), "mine");
});

test("cleanEditor takes the first ending match for an unprefixed prompt", () => {
	assert.equal(cleanEditor("queued two\n\nI said queued two", [{ text: "queued two" }]), "I said queued two");
});

test("cleanEditor removes separate blocks for repeated prompts", () => {
	assert.equal(cleanEditor("go\n\ngo\n\nmine", [{ text: "go" }, { text: "go" }]), "mine");
});

test("cleanEditor preserves the string for no prompts and empty unprefixed prompts", () => {
	const editor = "mine\n\nkeep this";
	assert.equal(cleanEditor(editor, []), editor);
	assert.equal(cleanEditor(editor, [{ text: "" }]) === editor, true);
});

test("cleanEditor removes only the prompt named by this stop", () => {
	assert.equal(cleanEditor("[Trigger run-ccc] third\n\n[Trigger run-aaa] queued one\n\nmine", [
		{ text: "[Trigger run-ccc] third", prefix: "[Trigger run-ccc] " },
	]), "[Trigger run-aaa] queued one\n\nmine");
});


test("narrowestCap: unattended before attended, only the tools every unattended prompt declared, and a built-in list caps a declared one", () => {
	const cap = (id: string, mode: "attended" | "unattended", tools?: string[], builtinTools?: string[]) => ({ kind: "row" as const, id, mode, ...(tools ? { tools } : {}), ...(builtinTools ? { builtinTools } : {}) });
	assert.equal(narrowestCap([]), undefined);
	assert.deepEqual(narrowestCap([cap("a", "attended")]), cap("a", "attended"));
	assert.deepEqual(narrowestCap([cap("a", "attended"), cap("u", "unattended")]), cap("u", "unattended"));
	assert.deepEqual(narrowestCap([cap("u1", "unattended", ["read", "bash"]), cap("u2", "unattended", ["read"])]), cap("u1", "unattended", ["read"]));
	assert.deepEqual(narrowestCap([cap("u1", "unattended"), cap("u2", "unattended", ["read"])]), cap("u1", "unattended", ["read"]), "one that declares nothing narrows nothing");
	assert.deepEqual(narrowestCap([cap("u1", "unattended", ["read", "bash", "my_tool"]), cap("u2", "unattended", undefined, ["read"])]), cap("u1", "unattended", ["read", "my_tool"], ["read"]));
});

test("pi-loops.ts hands the window pi's own delivery of an input: the rule of whose a message is reads it", () => {
	// pi-loops.ts has no harness: its source is the thing pinned (as test/lease.test.ts does).
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	assert.match(source, /executor\.inputSeen\(\{ source: e\.source, text: e\.text, streamingBehavior: e\.streamingBehavior \}, Date\.now\(\)\)/);
});

test("narrowestCap meets the lists whatever order pi holds the prompts in", () => {
	const cap = (id: string, tools?: string[], builtinTools?: string[]) => ({ kind: "row" as const, id, mode: "unattended" as const, ...(tools ? { tools } : {}), ...(builtinTools ? { builtinTools } : {}) });
	assert.deepEqual(narrowestCap([cap("u1", ["read"]), cap("u2", ["read", "bash"])])?.tools, ["read"]);
	assert.deepEqual(narrowestCap([cap("u1", ["read"]), cap("u2")])?.tools, ["read"], "the narrow one first, then one that declares nothing");
	assert.deepEqual(narrowestCap([cap("u1", undefined, ["read"]), cap("u2", undefined, ["read", "bash"])])?.builtinTools, ["read"]);
	assert.deepEqual(narrowestCap([cap("u1", undefined, ["read"]), cap("u2")])?.builtinTools, ["read"]);
});
