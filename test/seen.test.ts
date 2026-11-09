import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { sameProject } from "../src/paths.ts";
import { ALL_PROJECTS, awayFor, awayLine, awaySentence, FIRST_WINDOW_MS, markProjectSeen, pruneSeen, readSeen, type AwaySummary, sinceWords } from "../src/seen.ts";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const run = (over: Record<string, unknown> = {}) => ({ runId: "r", jobId: "j", stateful: true, cwd: "/", pid: 1, startedAt: ago(2), finishedAt: ago(1), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, ...over }) as any;
let n = 0;
const finding = (over: Record<string, unknown> = {}) => ({ id: `inb-${(++n).toString(16).padStart(32, "0")}`, created_at: ago(1), status: "new", source: "cron:x", text: "t", run_id: "r", job_id: "j", cwd: "/", verified: null, dismiss_reason: null, ...over }) as any;
/** Two projects on disk, one with a subdirectory: matching resolves real paths. */
function projects() {
	const p = tmp("pi-loops-away-p-");
	const q = tmp("pi-loops-away-q-");
	const sub = path.join(p, "sub");
	fs.mkdirSync(sub);
	return { p, q, sub, dir: tmp("pi-loops-away-dir-") };
}
const away = (dir: string, cwd: string, runs: any[], findings: any[], sessionId?: string, now = NOW) => awayFor({ seen: readSeen(dir), runs, findings, cwd, sessionId, now, inProject: sameProject });
const same = (a: string | null, b: string, why?: string) => assert.equal(Date.parse(a ?? ""), Date.parse(b), why);
const counts = (s: AwaySummary) => ({ runs: s.runs, failedRuns: s.failedRuns, findings: s.findings, decisions: s.decisions, fromThisConversation: s.fromThisConversation });

test("a recipe-created loop's finding is counted in its project, from any conversation there", () => {
	const { p, dir } = projects();
	markProjectSeen(dir, p, ago(10), NOW);
	// The recipe's loop was installed from conversation A; the finding names A, as the scheduler files it.
	const findings = [finding({ source: "cron:pr-watch", cwd: p, session_id: "A" }), finding({ cwd: p })];
	const s = away(dir, p, [run({ cwd: p, forSession: "A" })], findings, "B");
	assert.deepEqual(counts(s), { runs: 1, failedRuns: 0, findings: 2, decisions: 0, fromThisConversation: 0 });
});

test("another conversation's finding is counted and not marked as this one's", () => {
	const { p, dir } = projects();
	markProjectSeen(dir, p, ago(10), NOW);
	const findings = [finding({ cwd: p, session_id: "A" }), finding({ cwd: p, session_id: "B" })];
	assert.deepEqual(counts(away(dir, p, [], findings, "A")), { runs: 0, failedRuns: 0, findings: 2, decisions: 0, fromThisConversation: 1 });
	assert.equal(away(dir, p, [], findings, "B").fromThisConversation, 1);
});

test("Mark all seen clears the project and its subdirectories, not another project; * clears every one", () => {
	const { p, q, sub, dir } = projects();
	markProjectSeen(dir, p, ago(10), NOW);
	markProjectSeen(dir, q, ago(10), NOW);
	const runs = [run({ cwd: p }), run({ cwd: sub }), run({ cwd: q })];
	const findings = [finding({ cwd: p }), finding({ cwd: q })];
	assert.equal(away(dir, p, runs, findings).runs, 2, "a subdirectory's run is the project's");
	const at = away(dir, p, runs, findings).asOf;
	assert.equal(markProjectSeen(dir, p, at, NOW), at);
	assert.deepEqual(counts(away(dir, p, runs, findings)), { runs: 0, failedRuns: 0, findings: 0, decisions: 0, fromThisConversation: 0 });
	assert.equal(away(dir, sub, runs, findings).runs, 0, "asked from the subdirectory too");
	assert.deepEqual(counts(away(dir, q, runs, findings)), { runs: 1, failedRuns: 0, findings: 1, decisions: 0, fromThisConversation: 0 });
	markProjectSeen(dir, ALL_PROJECTS, at, NOW);
	assert.equal(away(dir, q, runs, findings).findings, 0);
	// A look from the subdirectory is a key of its own, and still clears the project it is in.
	const { p: p2, sub: sub2, dir: dir2 } = projects();
	markProjectSeen(dir2, sub2, ago(0), NOW);
	assert.equal(away(dir2, p2, [run({ cwd: p2 })], []).runs, 0, "/repo/sub's cursor counts for /repo");
});

test("a cursor only moves forward, and a cursor from a clock that ran ahead is replaced by now", () => {
	const { p, dir } = projects();
	markProjectSeen(dir, p, ago(1), NOW);
	assert.equal(markProjectSeen(dir, p, ago(5), NOW), ago(1), "an older look does not move it back");
	same(markProjectSeen(dir, p, ago(-3), NOW), ago(0), "a look later than now is now");
	const skewed = { v: 2, projects: { [fs.realpathSync(p)]: ago(-1) }, sessions: {} };
	fs.writeFileSync(path.join(dir, "seen.json"), JSON.stringify(skewed));
	const s = away(dir, p, [run({ cwd: p, finishedAt: ago(30) }), run({ cwd: p })], []);
	assert.equal(s.since, null, "a cursor an hour ahead is the first window");
	assert.equal(s.runs, 1);
	assert.equal(markProjectSeen(dir, p, s.asOf, NOW), s.asOf, "and the next mark repairs it");
});

test("a seen.json with very many cursors is read without overflowing the stack", () => {
	const { p, dir } = projects();
	const sessions: Record<string, string> = {};
	for (let i = 0; i < 200_000; i++) sessions[`s${i}`] = ago(5 + (i % 3));
	fs.writeFileSync(path.join(dir, "seen.json"), JSON.stringify({ v: 2, projects: {}, sessions }));
	const runs = Array.from({ length: 200_000 }, (_, i) => run({ runId: `r${i}`, cwd: p, forSession: `s${i}`, finishedAt: ago(30) }));
	const s = away(dir, p, runs, []);
	same(s.since, ago(5));
	assert.equal(s.runs, 0);
});

test("with no seen.json only the first window counts, not the whole run log", () => {
	const { p, dir } = projects();
	assert.deepEqual(readSeen(dir), { v: 2, projects: {}, sessions: {} });
	const runs = Array.from({ length: 30 }, (_, d) => run({ runId: `r${d}`, cwd: p, finishedAt: ago(d * 24 + 1) }));
	const findings = [finding({ cwd: p, created_at: ago(2) }), finding({ cwd: p, created_at: ago(72) })];
	const s = away(dir, p, runs, findings);
	assert.equal(s.since, null);
	assert.deepEqual(counts(s), { runs: 1, failedRuns: 0, findings: 1, decisions: 0, fromThisConversation: 0 });
	assert.equal(FIRST_WINDOW_MS, 24 * 3_600_000);
	assert.match(awaySentence(s) ?? "", /^In the last day · 1 finding$/);
	fs.writeFileSync(path.join(dir, "seen.json"), "{ torn");
	assert.equal(away(dir, p, runs, findings).since, null, "a torn file is the first window too");
});

test("a v1 file's per-conversation cursors are folded per project, and nothing is counted twice", () => {
	const { p, q, dir } = projects();
	fs.writeFileSync(path.join(dir, "seen.json"), JSON.stringify({ v: 1, seen: { A: ago(9), B: ago(8), C: ago(1) } }));
	const runs = [run({ runId: "a", cwd: p, forSession: "A", finishedAt: ago(8.5) }), run({ runId: "b", cwd: p, forSession: "B", finishedAt: ago(7) }), run({ runId: "c", cwd: q, forSession: "C", finishedAt: ago(4) })];
	const findings = [finding({ cwd: p, session_id: "A", created_at: ago(8.5) }), finding({ cwd: p, session_id: "B", created_at: ago(7) })];
	const first = away(dir, p, runs, findings);
	same(first.since, ago(8), "the latest look in any conversation of the project");
	assert.deepEqual(counts(first), { runs: 1, failedRuns: 0, findings: 1, decisions: 0, fromThisConversation: 0 });
	assert.equal(away(dir, q, runs, findings).runs, 0, "C's look was after q's run");
	assert.deepEqual(counts(away(dir, p, runs, findings)), counts(first), "read again: the same counts");
	markProjectSeen(dir, q, ago(0.5), NOW);
	assert.deepEqual(readSeen(dir).sessions, { A: ago(9), B: ago(8), C: ago(1) }, "the v1 cursors are kept until the sweep");
	assert.deepEqual(counts(away(dir, p, runs, findings)), counts(first), "and writing does not count them again");
});

test("the sweep forgets v1 cursors nothing refers to and project cursors whose directory is gone", () => {
	const { p, q, dir } = projects();
	fs.writeFileSync(path.join(dir, "seen.json"), JSON.stringify({ v: 1, seen: { kept: ago(1), gone: ago(1) } }));
	markProjectSeen(dir, p, ago(1), NOW);
	markProjectSeen(dir, q, ago(1), NOW);
	markProjectSeen(dir, ALL_PROJECTS, ago(1), NOW);
	fs.rmSync(q, { recursive: true });
	assert.equal(pruneSeen(dir, (id) => id === "kept"), 2);
	assert.deepEqual(Object.keys(readSeen(dir).sessions), ["kept"]);
	assert.deepEqual(Object.keys(readSeen(dir).projects).sort(), [ALL_PROJECTS, fs.realpathSync(p)].sort());
});

test("failures, stops, decisions, cost, a finding with no cwd, a handled finding and a rule check's findings", () => {
	const { p, q, dir } = projects();
	markProjectSeen(dir, p, ago(10), NOW);
	const runs = [
		run({ runId: "1", cwd: p, ok: false, usage: { input: 0, output: 0, turns: 1, cost: 0.25 } }),
		run({ runId: "2", cwd: p, ok: false, aborted: true }),
		run({ runId: "3", cwd: p, usage: { input: 0, output: 0, turns: 1, cost: 0.1 }, checker: { ok: true, kept: 1, dropped: [], unreviewed: 0, durationMs: 1, cost: 0.06 } }),
		run({ runId: "4", cwd: p, stateful: false }),
		run({ runId: "5", cwd: p, finishedAt: ago(11) }),
	];
	const findings = [
		finding({ cwd: p, kind: "checkpoint", session_id: "me" }),
		finding({ cwd: "" }),
		finding({ cwd: p, status: "dismissed" }),
		finding({ cwd: q }),
		// One rule check filed for two conversations: one result.
		finding({ cwd: p, source: "trigger:local:dynamic", run_id: "trace-1", session_id: "me" }),
		finding({ cwd: p, source: "trigger:local:dynamic", run_id: "trace-1", session_id: "other" }),
	];
	const s = away(dir, p, runs, findings, "me");
	assert.deepEqual(counts(s), { runs: 3, failedRuns: 1, findings: 3, decisions: 1, fromThisConversation: 2 });
	assert.equal(s.costUsd, 0.41);
	same(s.since, ago(10));
	same(s.asOf, ago(0));
	// A record stamped a little ahead of the clock: counted once its time has come, so asOf (now) is a
	// time the page's POST /inbox/seen takes, and the mark clears exactly what the card counted.
	const ahead = [run({ cwd: p, finishedAt: ago(-0.01) })];
	const early = away(dir, p, ahead, [finding({ cwd: p, created_at: ago(-0.01) })]);
	same(early.asOf, ago(0));
	assert.deepEqual([early.runs, early.findings], [0, 0]);
	assert.deepEqual([away(dir, p, ahead, [], undefined, NOW + 3_600_000).runs], [1], "and counted once its time has come");
});

test("a line that is not an object is no record", () => {
	const { p, dir } = projects();
	const s = away(dir, p, [null, 5, "x", run({ cwd: p })] as any[], [null, finding({ cwd: p })] as any[]);
	assert.deepEqual([s.runs, s.findings], [1, 1]);
	fs.writeFileSync(path.join(dir, "seen.json"), JSON.stringify({ v: 1, seen: { A: ago(30) } }));
	assert.equal(away(dir, p, [null, run({ cwd: p, forSession: "A" })] as any[], [null] as any[]).runs, 1, "the v1 fold skips them too");
});

test("the sentence and the terminal line have the specified forms, and say nothing at zero", () => {
	const s: AwaySummary = { cwd: "/p", since: "2026-03-09T23:10:00", asOf: "2026-03-10T08:00:00", runs: 41, failedRuns: 3, findings: 3, decisions: 1, fromThisConversation: 1, costUsd: 0.41 };
	const local = (iso: string) => new Date(iso).toISOString();
	const t = { ...s, since: local(s.since as string), asOf: local(s.asOf) };
	assert.equal(awaySentence(t), "Since yesterday 23:10 · 3 findings, 1 from this conversation · 1 needs you · $0.41");
	assert.equal(awayLine(t), "[inbox] since you last looked (yesterday 23:10): 41 loop runs (3 failed), 3 new findings (1 from this conversation) — /inbox");
	const one = { ...t, runs: 1, failedRuns: 0, findings: 1, decisions: 0, fromThisConversation: 0, costUsd: 0 };
	assert.equal(awaySentence(one), "Since yesterday 23:10 · 1 finding");
	assert.equal(awaySentence({ ...one, findings: 0 }), undefined, "runs alone are the activity strip's");
	assert.equal(awayLine(one), "[inbox] since you last looked (yesterday 23:10): 1 loop run, 1 new finding — /inbox");
	assert.equal(awayLine({ ...one, runs: 0 }), "[inbox] since you last looked (yesterday 23:10): 1 new finding — /inbox");
	assert.equal(awayLine({ ...one, since: null }), "[inbox] since you last looked (in the last day): 1 loop run, 1 new finding — /inbox");
	const zero = { ...t, runs: 0, failedRuns: 0, findings: 0, decisions: 0, fromThisConversation: 0, costUsd: 0 };
	assert.equal(awaySentence(zero), undefined);
	assert.equal(awayLine(zero), undefined);
});

/** `since`, `now` as local wall-clock times, and the words: what both copies of `sinceWords` must say. */
const SINCE_CASES: Array<[string, string, string]> = [
	["2026-03-10T09:14", "2026-03-10T18:00", "09:14"],
	["2026-03-09T23:10", "2026-03-10T00:30", "yesterday 23:10"],
	["2026-03-09T00:05", "2026-03-10T23:55", "yesterday 00:05"],
	["2026-03-05T23:10", "2026-03-10T08:00", "Thu 23:10"],
	["2026-03-04T08:00", "2026-03-10T08:00", "Wed 08:00"],
	["2026-03-03T08:00", "2026-03-10T08:00", "Mar 3 08:00"],
	["2025-12-31T23:10", "2026-01-01T00:20", "yesterday 23:10"],
	["2025-12-20T23:10", "2026-01-02T00:20", "Dec 20 2025 23:10"],
	// The nights the clocks change in New York (Mar 8, Nov 1) and none in Shanghai: still one day.
	["2026-03-07T23:30", "2026-03-08T23:30", "yesterday 23:30"],
	["2026-10-31T23:30", "2026-11-01T23:30", "yesterday 23:30"],
];
/** A local wall-clock time in the current TZ, as an instant. */
const wall = (s: string) => new Date(s).getTime();

test("since words across midnight, in local time, in two time zones", () => {
	const was = process.env.TZ;
	try {
		for (const tz of ["Asia/Shanghai", "America/New_York"]) {
			process.env.TZ = tz;
			for (const [since, now, words] of SINCE_CASES) assert.equal(sinceWords(wall(since), wall(now)), words, `${tz}: ${since} from ${now}`);
		}
	} finally {
		if (was === undefined) delete process.env.TZ;
		else process.env.TZ = was;
	}
});
