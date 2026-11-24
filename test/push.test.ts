import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { checkLane } from "../src/lane.ts";
import { type PushInput, MAX_PUSH_ROWS, decidePush, pushRowId, writePush } from "../src/push.ts";
import { RequestStore, type ClaimedRow, type Row, type UnclaimedRow } from "../src/requests.ts";
import type { RawEvent } from "../src/events.ts";
import { stamp } from "../src/schedule.ts";

const NOW = Date.parse("2026-11-23T10:00:00.000Z");
const MIN = 60_000;
const BY = { pid: 1, instance: "bg", version: "0" };

const event = (id: string, ago = 0): RawEvent => ({ id, received_at: stamp(NOW - ago), source: "mcp:ci", receiver: { pid: 1, kind: "background" }, raw: "{}" });

function push(ev: RawEvent, project: string, over: Partial<PushInput> = {}): PushInput {
	return { event: ev, key: "build-red", policy: "drop", label: "ci / build", sourceLabel: "ci", project, earlier: [], done: () => false, createdBy: BY, now: NOW, ...over };
}

function queuedRow(input: PushInput): UnclaimedRow {
	const d = decidePush(input, []);
	assert.equal(d.kind, "queued");
	return (d as Extract<typeof d, { kind: "queued" }>).row;
}

const claimed = (row: UnclaimedRow): ClaimedRow => ({ ...row, kind: "input", run: { id: "run-1", pid: 1, started_at: stamp(NOW - MIN) } });

test("[push-row-derived] a push is one row per project in its check lane, and deriving the same event again is a no-op", () => {
	const store = new RequestStore(tmp());
	const a = tmp("push-a-");
	const b = tmp("push-b-");
	const ev = event("evt-1");
	const label = `ci / build\nred token=abcdefgh12345678 ${"x".repeat(300)}`;
	assert.equal(writePush(store, push(ev, a, { label })).kind, "queued");
	const [row] = store.list(checkLane(a)!);
	assert.deepEqual(row, {
		v: 3,
		id: pushRowId(ev.id, a),
		lane: checkLane(a),
		kind: "input",
		source: "push:ci",
		mode: "unattended",
		wake: "turn",
		payload: { text: `[Trigger ${pushRowId(ev.id, a)}] ${`push ci / build red token=[REDACTED:keyed_value] ${"x".repeat(300)}`.slice(0, 200)}`, cwd: a, events: ["evt-1"] },
		created_at: stamp(NOW),
		created_by: BY,
		attempts: 0,
	});
	assert.match(row.id, /^evt-[0-9a-f]{32}$/);

	assert.equal(writePush(store, push(ev, b)).kind, "queued");
	const [other] = store.list(checkLane(b)!);
	assert.notEqual(other.lane, row.lane, "two projects, two lanes");
	assert.notEqual(other.id, row.id, "two projects, two rows");

	assert.deepEqual(writePush(store, push(ev, a)), { kind: "there" });
	assert.deepEqual(store.list(checkLane(a)!).map((r) => r.id), [row.id], "the same event twice is one row");

	const ended = event("evt-2");
	assert.deepEqual(writePush(store, push(ended, a, { done: (id) => id === pushRowId(ended.id, a) })), { kind: "there" }, "a row whose run ended is there too");
	assert.equal(store.list(checkLane(a)!).length, 1);
});

test("[push-identity-window] an earlier event with the same key inside five minutes whose run started or ended makes this push a duplicate", () => {
	const a = tmp("push-a-");
	const now = event("evt-new");
	const decide = (ago: number, key: string, rows: (earlier: RawEvent) => Row[], done: (id: string) => boolean = () => false) => {
		const earlier = event("evt-old", ago);
		return decidePush(push(now, a, { earlier: [{ id: earlier.id, key, received_at: earlier.received_at }], done }), rows(earlier));
	};
	const running = (e: RawEvent) => [claimed(queuedRow(push(e, a)))];
	assert.deepEqual(decide(4 * MIN, "build-red", running), { kind: "duplicate", of: "evt-old" });
	assert.equal(decide(6 * MIN, "build-red", running).kind, "queued", "outside the window");
	assert.equal(decide(4 * MIN, "deploy", running).kind, "queued", "another key");
	assert.deepEqual(decide(4 * MIN, "build-red", () => [], (id) => id === pushRowId("evt-old", a)), { kind: "duplicate", of: "evt-old" }, "its run ended and its row is gone");
});

test("[push-collapse] a same-key push while the earlier row waits is collapsed into it, and the lane is unchanged", () => {
	const store = new RequestStore(tmp());
	const a = tmp("push-a-");
	const first = event("evt-old", MIN);
	writePush(store, push(first, a));
	const before = fs.readFileSync(store.file(checkLane(a)!), "utf8");
	const second = event("evt-new");
	const decision = writePush(store, push(second, a, { earlier: [{ id: first.id, key: "build-red", received_at: first.received_at }] }));
	assert.deepEqual(decision, { kind: "collapsed", rowId: pushRowId(first.id, a), of: first.id });
	assert.equal(fs.readFileSync(store.file(checkLane(a)!), "utf8"), before);
});

test("[push-latest-replaces] with latest_replaces the waiting row is for the newer event only, and keeps its id, stamp and attempts", () => {
	const store = new RequestStore(tmp());
	const a = tmp("push-a-");
	const lane = checkLane(a)!;
	const first = event("evt-old", MIN);
	writePush(store, push(first, a, { policy: "latest_replaces" }));
	store.update(lane, pushRowId(first.id, a), { attempts: 2 });
	const [before] = store.list(lane);
	const second = event("evt-new");
	const decision = writePush(store, push(second, a, { policy: "latest_replaces", earlier: [{ id: first.id, key: "build-red", received_at: first.received_at }] }));
	assert.equal(decision.kind, "replaced");
	assert.deepEqual([(decision as { rowId: string }).rowId, (decision as { of: string }).of], [before.id, first.id]);
	assert.deepEqual(store.list(lane), [{ ...before, payload: { ...before.payload!, events: [second.id] } }]);
	assert.equal(before.attempts, 2);
});

test("[push-cap] a lane holding the most waiting pushes drops its oldest waiting push for the new one; a claimed push and an answer stay", () => {
	const store = new RequestStore(tmp());
	const a = tmp("push-a-");
	const lane = checkLane(a)!;
	const waiting = Array.from({ length: MAX_PUSH_ROWS }, (_, i) => ({ ...queuedRow(push(event(`evt-${i}`), a)), created_at: stamp(NOW - (i === 5 ? 50 : 40 - i) * MIN) }));
	const running = { ...claimed(queuedRow(push(event("evt-run"), a))), created_at: stamp(NOW - 90 * MIN) };
	const answer: UnclaimedRow = { v: 3, id: "ans-1", lane, kind: "input", source: "answer", mode: "unattended", wake: "turn", payload: { text: "yes", cwd: a, finding: "f-1" }, created_at: stamp(NOW - 99 * MIN), created_by: BY, attempts: 0 };
	fs.mkdirSync(store.dir + "/requests", { recursive: true });
	fs.writeFileSync(store.file(lane), [answer, running, ...waiting].map((r) => `${JSON.stringify(r)}\n`).join(""));

	const decision = writePush(store, push(event("evt-new"), a));
	assert.equal(decision.kind, "queued");
	const ids = store.list(lane).map((r) => r.id);
	assert.ok(!ids.includes(waiting[5].id), "the oldest waiting push is gone");
	assert.ok(ids.includes(running.id) && ids.includes("ans-1"), "the claimed push and the answer stay");
	assert.ok(ids.includes(pushRowId("evt-new", a)));
	assert.equal(ids.length, MAX_PUSH_ROWS + 2);
});

test("[events-replay] a replay's row has its own id and is written although the event's row is there, its run ended, and a same-key push ran inside the window", () => {
	const store = new RequestStore(tmp());
	const a = tmp("push-a-");
	const lane = checkLane(a)!;
	const ev = event("evt-1");
	const earlier = event("evt-old", MIN);
	writePush(store, push(ev, a));
	const ran = claimed(queuedRow(push(earlier, a)));
	fs.appendFileSync(store.file(lane), `${JSON.stringify(ran)}\n`);
	const replay = pushRowId(`${ev.id}#replay-${stamp(NOW)}`, a);
	const input = push(ev, a, { replay, done: () => true, earlier: [{ id: earlier.id, key: "build-red", received_at: earlier.received_at }] });
	assert.equal(writePush(store, input).kind, "queued");
	const row = store.list(lane).find((r) => r.id === replay);
	assert.deepEqual([row?.source, row?.payload?.events, row?.payload?.text.startsWith(`[Trigger ${replay}] `)], ["push:ci", [ev.id], true]);
	assert.deepEqual(writePush(store, input), { kind: "there" }, "the same replay twice is one row");
	assert.equal(store.list(lane).length, 3);
});
