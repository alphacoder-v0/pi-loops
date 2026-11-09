import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { fakePi, startTestPage } from "./page-harness.ts";
import { awayIn, awayLine, awaySentence } from "../src/seen.ts";

/**
 * The terminal's session-start line and the page's away card count the same things (docs/loops.md):
 * one set of files, read by the extension's helper and by the page's `GET /inbox`, gives one summary.
 * The extension itself cannot be imported, so this holds the two entry points to each other here.
 */
test("the terminal's helper and the page's GET /inbox give the same away summary from the same files", { timeout: 20_000 }, async () => {
	const dir = tmp("pi-loops-away-agree-");
	const project = path.join(dir, "proj");
	const other = path.join(dir, "other");
	fs.mkdirSync(path.join(project, "sub"), { recursive: true });
	fs.mkdirSync(other);
	const page = await startTestPage(dir, fakePi(dir, { sessionId: "s1" }));
	try {
		const loops = page.loops;
		fs.mkdirSync(loops, { recursive: true });
		const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
		fs.writeFileSync(path.join(loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-1", name: "triage", cwd: project }, { id: "cron-2", name: "pr-watch", recipe: "pr-watch", cwd: project, createdBy: { sessionId: "B" } }, { id: "cron-3", cwd: other }] }));
		// A v1 file, as a 0.23 build left it: A looked 50 minutes ago.
		fs.writeFileSync(path.join(loops, "seen.json"), JSON.stringify({ v: 1, seen: { A: ago(50) } }));
		const run = (over: Record<string, unknown>) => JSON.stringify({ runId: "r", jobId: "cron-1", stateful: true, cwd: project, pid: 1, startedAt: ago(41), finishedAt: ago(40), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, forSession: "A", ...over });
		fs.writeFileSync(path.join(loops, "runs.jsonl"), [run({ runId: "before", finishedAt: ago(55) }), run({ runId: "1", ok: false }), run({ runId: "2", jobId: "cron-2", forSession: "B", cwd: path.join(project, "sub"), usage: { input: 1, output: 1, turns: 1, cost: 0.3 } }), run({ runId: "3", ok: false, aborted: true }), run({ runId: "4", jobId: "cron-3", cwd: other })].join("\n") + "\n");
		const finding = (n: number, over: Record<string, unknown>) => JSON.stringify({ id: `inb-${n.toString(16).padStart(32, "0")}`, created_at: ago(30), status: "new", kind: "news", source: "cron:triage", run_id: "1", cwd: project, text: "t", verified: null, dismiss_reason: null, job_id: "cron-1", ...over });
		fs.writeFileSync(path.join(loops, "inbox.jsonl"), [
			finding(1, { session_id: "A" }),
			finding(2, { session_id: "B", source: "cron:pr-watch", job_id: "cron-2" }),
			finding(3, { session_id: "A", kind: "checkpoint", text: "ship it · waits: you" }),
			finding(4, { session_id: "A", source: "trigger:local:dynamic", run_id: "trace-1" }),
			finding(5, { session_id: "B", source: "trigger:local:dynamic", run_id: "trace-1" }),
			finding(6, { session_id: "A", created_at: ago(55) }),
			finding(7, { session_id: "A", status: "dismissed" }),
			finding(8, { cwd: other }),
		].join("\n") + "\n");
		for (const sessionId of ["A", "B"]) {
			const terminal = awayIn(loops, project, sessionId);
			const served = await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=${sessionId}`);
			assert.equal(served.status, 200);
			const { asOf: a, ...fromTerminal } = terminal;
			const { asOf: b, ...fromPage } = served.body.away;
			assert.deepEqual(fromPage, fromTerminal, `asked from ${sessionId}`);
			assert.ok(Math.abs(Date.parse(a) - Date.parse(b)) < 5000);
		}
		const mine = awayIn(loops, project, "A");
		assert.deepEqual([mine.runs, mine.failedRuns, mine.findings, mine.decisions, mine.fromThisConversation, mine.costUsd], [3, 1, 4, 1, 3, 0.3]);
		assert.match(awayLine(mine) ?? "", /: 3 loop runs \(1 failed\), 4 new findings \(3 from this conversation\) — \/inbox$/);
		assert.match(awaySentence(mine) ?? "", / · 4 findings, 3 from this conversation · 1 needs you · \$0\.30$/);
		// Mark all seen in the page: the terminal's next line has nothing to say.
		const seen = await page.post("inbox/seen", { cwd: project, at: served(await page.get(`inbox?cwd=${encodeURIComponent(project)}&session=A`)) });
		assert.equal(seen.status, 200);
		assert.equal(awayLine(awayIn(loops, project, "A")), undefined);
		assert.equal(awayIn(loops, other, "A").runs, 1, "another project is not cleared");
	} finally {
		await page.stop();
	}
});

const served = (r: { body: any }) => r.body.away.asOf as string;
