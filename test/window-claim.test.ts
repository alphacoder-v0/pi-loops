import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { markFor } from "../src/mark.ts";
import type { PersonSlot, Phase, Slot, TurnSlot } from "../src/window-claim.ts";
import { claimOf, settleSlots } from "../src/window-claim.ts";

function person(id: string, text: string, phase: Phase, opts: { stop?: true; left?: true } = {}): PersonSlot {
	return { whose: "person", mark: markFor({ lane: "s1", id }), text, phase, ...(opts.stop ? { stop: true as const } : {}), ...(opts.left ? { left: true as const } : {}), echoed: false };
}

function turn(id: string, at: TurnSlot["at"], opts: { stop?: true; left?: true } = {}): TurnSlot {
	return { whose: "turn", mark: markFor({ lane: "s1", id }), at, ...opts };
}

function other(text: string, from: "person" | "extension" = "person"): Slot {
	return { whose: "other", from, text };
}

function append(id: string): Slot {
	return { whose: "append", mark: markFor({ lane: "s1", id }) };
}

function writingPerson(id: string, text: string): PersonSlot {
	const pending = person(id, text, { is: "pending", since: 0 });
	const claim = claimOf(text, [pending]);
	if (claim.by !== "person") throw new Error("a pending person slot did not claim its exact text");
	return person(id, text, { is: "writing", claim });
}

function assertPersonClaim(result: ReturnType<typeof claimOf>, id: string, message?: string): void {
	assert.equal(result.by, "person", message);
	if (result.by === "person") assert.equal(result.slot.mark.id, id, message);
}

function assertOtherClaim(result: ReturnType<typeof claimOf>, expected: Slot, message?: string): void {
	assert.equal(result.by, "other", message);
	if (result.by === "other") assert.equal(result.slot, expected, message);
}

test("claimOf gives the very same words to the person row whose prompt they are, the oldest of two", () => {
	const a = person("a", "do it", { is: "queued" });
	const b = person("b", "do it", { is: "opening" });
	const c = person("c", "something else", { is: "queued" });
	assertPersonClaim(claimOf("do it", [a, b, c]), "a");
	assertPersonClaim(claimOf("something else", [a, b, c]), "c");
});

test("claimOf gives the very same words to a waiting input of someone else before a person row's prompt", () => {
	const ours = person("a", "same", { is: "queued" });
	const theirs = other("same");
	assertOtherClaim(claimOf("same", [ours, theirs]), theirs);
});

test("claimOf strips pi's trailing image note", () => {
	const ours = person("a", "look", { is: "pending", since: 1 });
	assertPersonClaim(claimOf("look\n\n[Image: original 2400x16, displayed at 2000x13. Multiply coordinates by 1.20 to map to original image.]", [ours]), "a");
});

test("claimOf gives an image-only message to the slot with no words", () => {
	const image = other("");
	assertOtherClaim(claimOf("[Image omitted: unsupported format]", [image]), image);
	assertPersonClaim(claimOf("[Image omitted: unsupported format]", [person("a", "", { is: "queued" })]), "a");
});

test("claimOf knows a person row's message by its words at the start, and by nothing else", () => {
	const ours = person("a", "the person says 9.", { is: "queued" });
	assertPersonClaim(claimOf("the person says 9. And a handler added this.", [ours]), "a");
	assert.equal(claimOf("[rewritten] the person says 9.", [ours]).by, "nobody", "its words at the end prove nothing");
	assert.equal(claimOf("before the person says 9. after", [ours]).by, "nobody", "nor in the middle");
});

test("claimOf gives words at the start to the slot with the longest words; between two as long, to someone else's", () => {
	const short = person("short", "run", { is: "queued" });
	const long = person("long", "run the tests", { is: "queued" });
	assertPersonClaim(claimOf("run the tests now", [short, long]), "long");
	const theirs = other("run the tests and more");
	assertOtherClaim(claimOf("run the tests and more, please", [short, long, theirs]), theirs);
	const tie = other("run the tests");
	assertOtherClaim(claimOf("run the tests now", [long, tie]), tie);
});

test("claimOf gives someone else's waiting input nothing it does not start: a message no words place is nobody's, and no slot is taken for want of a better", () => {
	const theirs = other("another extension says this");
	const ours = person("a", "mine", { is: "queued" });
	assert.equal(claimOf("a third thing", [theirs, ours]).by, "nobody");
});

test("claimOf asks only person slots pi may still write and waiting inputs: never a writing or written one, a turn row's slot or an append", () => {
	const slots: Slot[] = [writingPerson("writing", "words"), person("written", "words", { is: "written" }), turn("turn", "held"), append("append")];
	assert.equal(claimOf("words", slots).by, "nobody");
	assertPersonClaim(claimOf("words", [...slots, person("refused", "words", { is: "refused" })]), "refused", "a refused prompt pi may still send late is asked");
});

type Column = "no stop" | "terminal stop" | "page stop";
interface SettleCase {
	name: string;
	slot: Slot;
	landed?: boolean;
	expect: (column: Column) => { kept: boolean; reason?: string };
}
const unwritten = (column: Column) => (column === "no stop" ? { kept: false, reason: "lost" } : column === "terminal stop" ? { kept: false, reason: "dropped" } : { kept: true });
const settleCases: SettleCase[] = [
	{ name: "a person slot whose mark landed", slot: person("landed", "prompt", { is: "queued" }), landed: true, expect: () => ({ kept: false }) },
	{ name: "a pending person slot", slot: person("pending", "prompt", { is: "pending", since: 1 }), expect: () => ({ kept: true }) },
	{ name: "an opening or queued person slot", slot: person("waiting", "prompt", { is: "queued" }), expect: unwritten },
	{ name: "a written person slot", slot: person("written", "prompt", { is: "written" }), expect: () => ({ kept: false, reason: "lost" }) },
	{ name: "a refused person slot", slot: person("refused", "prompt", { is: "refused" }), expect: (column) => ({ kept: column === "page stop" }) },
	{ name: "a turn slot whose mark landed", slot: turn("landed", "started"), landed: true, expect: () => ({ kept: false }) },
	{ name: "an unstarted turn slot", slot: turn("unstarted", "unstarted"), expect: () => ({ kept: true }) },
	{ name: "a turn slot pi holds", slot: turn("held", "held"), expect: unwritten },
	{ name: "a turn slot whose message started and whose mark is not there", slot: turn("started", "started"), expect: () => ({ kept: false, reason: "lost" }) },
	{ name: "a turn slot pi holds whose row left the file", slot: turn("left", "held", { left: true }), expect: (column) => ({ kept: column === "page stop" }) },
	{ name: "an append", slot: append("append"), expect: unwritten },
	{ name: "an other slot", slot: other("person text"), expect: (column) => ({ kept: column === "page stop" }) },
];
const columns: Array<{ name: Column; how: { aborted: boolean; terminal: boolean } }> = [
	{ name: "no stop", how: { aborted: false, terminal: false } },
	{ name: "terminal stop", how: { aborted: true, terminal: true } },
	{ name: "page stop", how: { aborted: true, terminal: false } },
];
for (const row of settleCases) {
	for (const column of columns) {
		test(`settleSlots ${row.name}: ${column.name}`, () => {
			const result = settleSlots([row.slot], column.how, () => row.landed === true);
			const expected = row.expect(column.name);
			assert.equal(result.slots.length, expected.kept ? 1 : 0);
			assert.deepEqual([...result.gone], expected.reason ? [[row.slot.whose === "other" ? "" : row.slot.mark.id, expected.reason]] : []);
		});
	}
}

test("settleSlots reads a writing person slot as queued in every column", () => {
	for (const column of columns) {
		const result = settleSlots([writingPerson("writing", "prompt")], column.how, () => false);
		assert.equal(result.slots.length === 1, column.name === "page stop");
		if (result.slots[0]?.whose === "person") assert.deepEqual(result.slots[0].phase, { is: "queued" });
	}
});

test("settleSlots gives a slot a stop named the reason stopped when it goes unwritten", () => {
	for (const column of columns.slice(0, 2)) {
		for (const slot of [person("row", "prompt", { is: "queued" }, { stop: true }), turn("row", "held", { stop: true }), { ...append("row"), stop: true as const }]) assert.equal(settleSlots([slot], column.how, () => false).gone.get("row"), "stopped");
	}
	assert.equal(settleSlots([person("row", "prompt", { is: "written" }, { stop: true })], columns[0].how, () => false).gone.get("row"), "stopped");
	assert.equal(settleSlots([turn("row", "started", { stop: true })], columns[2].how, () => false).gone.get("row"), "stopped", "a turn aborted as it started, with no mark in the conversation");
});

test("settleSlots puts no slot whose row left the file into gone: the same row may be queued again", () => {
	for (const column of columns) {
		for (const slot of [person("row", "prompt", { is: "queued" }, { stop: true, left: true }), turn("row", "held", { stop: true, left: true }), turn("row", "started", { left: true })]) assert.deepEqual([...settleSlots([slot], column.how, () => false).gone], []);
	}
});

test("settleSlots keeps a turn slot whose row left the file while another hand-over's mark is in the conversation: the page's pi may still write its own message", () => {
	const left = turn("row", "held", { stop: true, left: true });
	assert.deepEqual(settleSlots([left], { aborted: true, terminal: false }, () => true).slots, [left]);
	assert.deepEqual(settleSlots([turn("row", "started", { left: true })], { aborted: true, terminal: false }, () => true).slots, [], "its own message, once started and written, is the end of it");
});

test("settleSlots does not change the input slots or their objects", () => {
	const input: Slot[] = [writingPerson("writing", "one"), person("queued", "two", { is: "queued" }), turn("turn", "held"), append("append"), other("person")];
	const before = structuredClone(input);
	settleSlots(input, { aborted: true, terminal: false }, () => false);
	assert.deepEqual(input, before);
});

test("pi-loops.ts hands the window pi's own delivery of an input: the rule of whose a message is reads it", () => {
	// pi-loops.ts has no harness: its source is the thing pinned (as test/lease.test.ts does).
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	assert.match(source, /executor\.inputSeen\(\{ source: e\.source, text: e\.text, streamingBehavior: e\.streamingBehavior \}, Date\.now\(\)\)/);
});

test("pi-loops.ts tells the window when pi compacts and when the compaction ends, done or not", () => {
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	assert.match(source, /pi\.on\("session_before_compact", async \(\) => \{\n\t\texecutor\.compaction\(true\);/);
	assert.match(source, /pi\.on\("session_compact", async \(e, ctx\) => \{\n\t\texecutor\.compaction\(false\);/);
	assert.match(source, /pi\.on\("session_compact_failed", async \(e, ctx\) => \{\n\t\texecutor\.compaction\(false\);/);
});

test("pi-loops.ts drains after a custom message ends as after a user message: a turn row's proof is in the conversation once the handler returns", () => {
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	assert.match(source, /if \(\(role === "user" \|\| role === "custom"\) && executor\.handedOver\.size\) setImmediate\(/);
});
