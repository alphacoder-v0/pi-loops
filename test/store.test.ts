import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Inbox, inProject, resolveInboxRef } from "../src/inbox.ts";
import { withFileLock } from "../src/lock.ts";
import { withinProject } from "../src/presence.ts";
import { JOBS_FILE_VERSION, JobStore, type LoopJob, type RunRecord, newId, owningSessionId, resolveJobRef, sessionExists } from "../src/store.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-test-"));

function job(over: Partial<LoopJob> = {}): LoopJob {
	return {
		id: newId("cron"),
		schedule: { kind: "every", ms: 60_000 },
		stateful: true,
		prompt: "p",
		cwd: "/tmp",
		enabled: true,
		catchUp: true,
		createdAt: new Date().toISOString(),
		runCount: 0,
		skippedOverlap: 0,
		...over,
	};
}

test("job store round trip, update, remove keeps state unless purged", async () => {
	const store = new JobStore(tmp());
	assert.deepEqual(store.load(), []);
	const a = await store.add(job({ name: "a" }));
	const b = await store.add(job({ name: "b" }));
	assert.equal(store.load().length, 2);
	await store.update(a.id, (j) => {
		j.runCount = 5;
	});
	assert.equal(store.load().find((j) => j.id === a.id)?.runCount, 5);
	store.writeState(a.id, "notes " + "x".repeat(5000));
	assert.ok(Array.from(store.readState(a.id)!).length <= 2001);
	assert.equal(store.readState(b.id), undefined);
	assert.equal(resolveJobRef(store.load(), "2")?.id, b.id);
	assert.equal(resolveJobRef(store.load(), "a")?.id, a.id);
	assert.equal(resolveJobRef(store.load(), a.id.slice(0, 8))?.id, a.id);
	// Removing keeps the notes: remove-and-re-add is how a schedule or prompt is changed, and a
	// stateful loop's accumulated state is the thing that makes it able to report only what changed.
	await store.remove(a.id);
	assert.ok(fs.existsSync(store.statePath(a.id)), "the loop state survives a plain remove");
	assert.deepEqual(store.orphanStates().map((o) => o.id), [a.id], "and is listed as orphaned");
	await store.remove(a.id, { purge: true });
	store.purgeState(a.id);
	assert.equal(store.load().length, 1);
	assert.ok(!fs.existsSync(store.statePath(a.id)));
});

test("a pass that changes nothing writes nothing, and an empty store creates no file at all", async () => {
	const store = new JobStore(tmp());
	// What the scheduler does on every 30s tick, in every open pi window.
	await store.mutate((jobs) => ({ jobs, result: undefined }));
	assert.equal(fs.existsSync(store.jobsFile), false, "an idle store must not accrete a sidecar file");
	const a = await store.add(job({ name: "a" }));
	const before = fs.statSync(store.jobsFile).ino;
	await store.mutate((jobs) => ({ jobs, result: undefined }));
	await store.update("cron-missing", () => undefined);
	assert.equal(fs.statSync(store.jobsFile).ino, before, "an unchanged tick does not rewrite jobs.json");
	await store.update(a.id, (j) => {
		j.runCount = 1;
	});
	assert.notEqual(fs.statSync(store.jobsFile).ino, before, "a real change is still persisted");
});

test("a jobs.json written by a newer pi-loops is refused, not rewritten in the old shape", async () => {
	const store = new JobStore(tmp());
	const future = `${JSON.stringify({ version: JOBS_FILE_VERSION + 1, jobs: [{ ...job({ name: "from-the-future" }), somethingNew: true }] }, null, 2)}\n`;
	fs.mkdirSync(store.dir, { recursive: true });
	fs.writeFileSync(store.jobsFile, future);
	assert.throws(() => store.load(), /newer pi-loops/);
	await assert.rejects(store.add(job()), /newer pi-loops/);
	assert.equal(fs.readFileSync(store.jobsFile, "utf8"), future, "the file the newer build owns is left untouched");
});

test("run log append/list/rotation", () => {
	const store = new JobStore(tmp());
	for (let i = 0; i < 5; i++) {
		store.appendRun({ runId: `r${i}`, jobId: i % 2 ? "x" : "y", stateful: true, cwd: "/", pid: 1, startedAt: "a", finishedAt: "b", ok: true, findings: 0, droppedFindings: 0, stateUpdated: false });
	}
	assert.equal(store.listRuns().length, 5);
	assert.equal(store.listRuns("x").length, 2);
	assert.equal(store.listRuns(undefined, 2).length, 2);
});

test("run log appends take the rotation lock, so a rotation elsewhere cannot drop them", () => {
	const dir = tmp();
	const store = new JobStore(dir);
	const record: RunRecord = { runId: "r-waited", jobId: "j", stateful: true, cwd: "/", pid: 1, startedAt: "a", finishedAt: "b", ok: true, findings: 0, droppedFindings: 0, stateUpdated: false };
	// Another process is mid-rotation: it read the file and is about to rewrite it. An append that
	// walks in now is lost, so it has to wait. The lock is aged so it goes stale ~200ms from here.
	const lock = path.join(dir, "runs.lock");
	fs.mkdirSync(lock);
	const held = new Date(Date.now() - 9_800);
	fs.utimesSync(lock, held, held);
	const started = Date.now();
	store.appendRun(record);
	assert.ok(Date.now() - started >= 100, "the append waited for the lock instead of racing the rotation");
	assert.deepEqual(store.listRuns().map((r) => r.runId), ["r-waited"]);
});

test("inbox append/list/claim/dismiss, corrupt lines skipped", async () => {
	const inbox = new Inbox(tmp());
	assert.equal(inbox.newCount(), 0);
	const a = await inbox.append({ source: "loop:x", text: "  found a flaky test  ", runId: "r", jobId: "j", cwd: "/" });
	const b = await inbox.append({ source: "loop:x", text: "x".repeat(2000), runId: "r", jobId: "j", cwd: "/" });
	assert.equal(a.text, "found a flaky test");
	assert.ok(Array.from(b.text).length <= 501);
	fs.appendFileSync(inbox.file, "{not json\n");
	const c = await inbox.append({ source: "loop:y", text: "after corruption", runId: "r2", jobId: "j", cwd: "/" });
	assert.equal(inbox.list().length, 3);
	assert.equal(inbox.newCount(), 3);
	assert.equal(resolveInboxRef(inbox.listNew(), "1")?.id, a.id);
	assert.equal(resolveInboxRef(inbox.listNew(), c.id.slice(0, 8))?.id, c.id);
	const claimed = await inbox.setStatus(a.id, "claimed", "sess");
	assert.equal(claimed?.status, "claimed");
	assert.equal(inbox.newCount(), 2);
	assert.equal(await inbox.setStatus("inb-missing", "claimed"), undefined);
	assert.equal(await inbox.dismissAllNew(), 2);
	assert.equal(inbox.newCount(), 0);
	assert.equal(inbox.list().length, 3);
});

test("findings are scoped to a project: what /inbox lists, what a number resolves to, what clear dismisses", async () => {
	const root = tmp();
	const here = path.join(root, "repo-a");
	const sub = path.join(here, "src");
	const there = path.join(root, "repo-b");
	// pi-loops' own test for "the same project" — a worktree, a symlink or a subdirectory of the
	// project root all belong to a job that names the root.
	const sameProject = (a: string, b: string) => withinProject(b, a) || withinProject(a, b);
	const inbox = new Inbox(tmp());
	const elsewhere = await inbox.append({ source: "loop:b", text: "b's finding", runId: "r", jobId: "j-b", cwd: there });
	const mine = await inbox.append({ source: "loop:a", text: "a's finding", runId: "r", jobId: "j-a", cwd: sub });
	const homeless = await inbox.append({ source: "loop:?", text: "written without a cwd", runId: "r", jobId: "j-?", cwd: "" });

	const listed = inProject(inbox.listNew(), here, sameProject);
	assert.deepEqual(listed.map((e) => e.id), [mine.id, homeless.id], "this project's findings, plus one that belongs to no project");
	// The numbers on screen are the numbers `/inbox claim <n>` resolves — the whole point of the
	// scoping: claiming #1 must not run another repository's finding in this directory.
	assert.equal(resolveInboxRef(listed, "1")?.id, mine.id);
	assert.equal(resolveInboxRef(inbox.listNew(), elsewhere.id.slice(0, 8))?.id, elsewhere.id, "an id still resolves machine-wide");

	assert.equal(await inbox.dismissAllNew((e) => listed.some((l) => l.id === e.id)), 2, "clear dismisses what was listed");
	assert.deepEqual(inbox.listNew().map((e) => e.id), [elsewhere.id], "and leaves the other project's findings alone");
	assert.equal(await inbox.dismissAllNew(), 1, "with no filter it still dismisses everything");
});

test("file lock serializes and breaks stale locks", async () => {
	const dir = tmp();
	const lock = path.join(dir, "x.lock");
	let inside = 0;
	let maxInside = 0;
	await Promise.all(
		Array.from({ length: 5 }, () =>
			withFileLock(lock, async () => {
				inside++;
				maxInside = Math.max(maxInside, inside);
				await new Promise((r) => setTimeout(r, 15));
				inside--;
			}),
		),
	);
	assert.equal(maxInside, 1);
	fs.mkdirSync(lock);
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(lock, old, old);
	await withFileLock(lock, () => 1, { staleMs: 1000 });
	assert.ok(!fs.existsSync(lock));
});

test("inbox.jsonl uses pie's record shape on disk and still reads pi-loops ≤ 0.1.2 lines", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-inbox-"));
	const inbox = new Inbox(dir);
	const a = await inbox.append({ source: "loop:x", text: "finding", runId: "run-1", jobId: "cron-1", cwd: "/p", sessionId: "s1", verified: true, verifiedReason: "checked" });
	const raw = JSON.parse(fs.readFileSync(inbox.file, "utf8").trim());
	assert.deepEqual(Object.keys(raw).slice(0, 7), ["id", "created_at", "source", "text", "trace_id", "session_id", "status"], "pie's fields first, in pie's order");
	assert.equal(raw.trace_id, "run-1");
	assert.equal(raw.session_id, "s1");
	assert.equal(raw.job_id, "cron-1");
	assert.equal(raw.verified_reason, "checked");
	fs.appendFileSync(inbox.file, `${JSON.stringify({ id: "inb-old", createdAt: "2026-09-08T00:00:00.000Z", source: "loop:y", text: "legacy", runId: "r0", jobId: "j0", cwd: "/q", status: "new", claimedBy: "s0" })}\n`);
	const all = inbox.list();
	assert.deepEqual(all.map((e) => [e.id, e.runId, e.claimedBy]), [[a.id, "run-1", undefined], ["inb-old", "r0", "s0"]]);
	assert.equal(all[0].sessionId, "s1");
});

test("ids are pie-shaped: <prefix>-<32 hex>", () => {
	assert.match(newId("cron"), /^cron-[0-9a-f]{32}$/);
});

test("owningSessionId: plain jobs created by a sub-agent bind to the parent session, loops to none", () => {
	assert.equal(owningSessionId(false, "child-session", "parent-session"), "parent-session");
	assert.equal(owningSessionId(false, "interactive-session", undefined), "interactive-session");
	assert.equal(owningSessionId(true, "any", "parent-session"), undefined);
});

test("sessionExists scans pi's sessions root; removeWhere drops jobs with their state and transcripts", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-sess-"));
	fs.mkdirSync(path.join(root, "--home-x-proj--"), { recursive: true });
	fs.writeFileSync(path.join(root, "--home-x-proj--", "2026-09-09T00-00-00-000Z_abc-123.jsonl"), "{}\n");
	assert.equal(sessionExists(root, "abc-123"), true);
	assert.equal(sessionExists(root, "nope"), false);
	assert.equal(sessionExists(path.join(root, "missing"), "abc-123"), false);
	const store = new JobStore(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-store-")));
	const a = await store.add({ id: newId("cron"), schedule: { kind: "every", ms: 1000 }, stateful: true, prompt: "p", cwd: "/", enabled: false, catchUp: true, createdAt: "t", runCount: 0, skippedOverlap: 0, lastError: "disabled: session x no longer exists" });
	const b = await store.add({ id: newId("cron"), schedule: { kind: "every", ms: 1000 }, stateful: true, prompt: "p", cwd: "/", enabled: true, catchUp: true, createdAt: "t", runCount: 0, skippedOverlap: 0 });
	store.writeState(a.id, "notes");
	const removed = await store.removeWhere((j) => !j.enabled);
	assert.deepEqual(removed.map((j) => j.id), [a.id]);
	assert.deepEqual(store.load().map((j) => j.id), [b.id]);
	assert.equal(fs.existsSync(store.statePath(a.id)), false);
});

test("an empty jobs.json is damage, not an empty store, and the last good copy is kept", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-empty-"));
	const store = new JobStore(dir);
	const job: LoopJob = { id: "cron-keepme", schedule: { kind: "every", ms: 60_000 }, stateful: true, prompt: "irreplaceable", cwd: dir, enabled: true, catchUp: true, createdAt: new Date().toISOString(), runCount: 0, skippedOverlap: 0 };
	await store.add(job);
	await store.update("cron-keepme", (j) => {
		j.runCount = 1;
	});
	assert.ok(fs.existsSync(path.join(dir, "jobs.json.bak")), "a good copy is kept alongside");

	// A torn write / external truncation leaves the file empty.
	fs.writeFileSync(path.join(dir, "jobs.json"), "");
	assert.throws(() => store.load(), /is empty; restore it/, "an empty file must not read as 'no jobs'");
	// …and the next tick must not be able to overwrite it with an empty store.
	await assert.rejects(store.mutate((jobs) => ({ jobs, result: undefined })), /is empty/);
	assert.match(fs.readFileSync(path.join(dir, "jobs.json.bak"), "utf8"), /irreplaceable/, "the job is still recoverable");

	// Restoring the backup brings it back.
	fs.copyFileSync(path.join(dir, "jobs.json.bak"), path.join(dir, "jobs.json"));
	assert.equal(store.load()[0].id, "cron-keepme");

	// A machine that never had jobs still reads as empty and creates nothing.
	const fresh = new JobStore(fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-fresh-")));
	assert.deepEqual(fresh.load(), []);
	await fresh.mutate((jobs) => ({ jobs, result: undefined }));
	assert.equal(fs.existsSync(path.join(fresh.jobsFile)), false);
});

test("spend() adds up what automation cost, by job and by window", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-spend-"));
	const store = new JobStore(dir);
	const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
	const rec = (jobId: string, cost: number, hoursAgo: number, checker?: number) => ({
		runId: `run-${jobId}-${hoursAgo}`, jobId, jobName: jobId === "cron-a" ? "nightly" : undefined, stateful: true, cwd: dir, pid: 1,
		startedAt: at(hoursAgo), finishedAt: at(hoursAgo), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false,
		usage: { input: 1, output: 1, cost, turns: 1 }, ...(checker ? { checker: { runId: "c", ok: true, kept: 0, dropped: [], cost: checker, startedAt: at(hoursAgo), finishedAt: at(hoursAgo) } } : {}),
	});
	for (const r of [rec("cron-a", 0.05, 1, 0.02), rec("cron-a", 0.05, 2), rec("cron-b", 0.10, 3), rec("cron-a", 999, 72)]) store.appendRun(r as any);

	const day = store.spend(Date.now() - 24 * 3_600_000);
	assert.equal(day.runs, 3, "the 3-day-old run is outside the window");
	assert.ok(Math.abs(day.total - 0.22) < 1e-9, `${day.total} = 0.05+0.02 checker +0.05 +0.10`);
	assert.ok(Math.abs(day.byJob.get("cron-a")!.cost - 0.12) < 1e-9, "the checker's cost counts against its job");
	assert.equal(day.byJob.get("cron-a")!.name, "nightly");
	assert.equal(day.byJob.get("cron-b")!.runs, 1);

	assert.equal(store.spend(0).runs, 4, "all = everything still in the log");
	assert.equal(store.spend(Date.now() + 1000).runs, 0, "a window in the future is empty, not an error");
});

test("a run stamped with nonsense does not count against today's budget forever", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-spend-nan-"));
	const store = new JobStore(dir);
	store.appendRun({
		runId: "run-bad", jobId: "cron-a", stateful: true, cwd: dir, pid: 1,
		startedAt: "not a date", finishedAt: "not a date", ok: true, findings: 0, droppedFindings: 0, stateUpdated: false,
		usage: { input: 1, output: 1, cost: 99, turns: 1 },
	} as any);
	// Date.parse of that is NaN, and `NaN < since` is false — so a plain comparison would let this
	// one record sit above any cap for the rest of time and pause every job.
	assert.equal(store.spend(Date.now() - 3_600_000).total, 0);
	assert.equal(store.spend(Date.now() - 3_600_000).runs, 0);
});

test("what rotation drops still counts toward the day's spend", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-spend-rot-"));
	const store = new JobStore(dir);
	const now = new Date().toISOString();
	const rec = (n: number) => ({
		runId: `run-${n}`, jobId: "cron-a", stateful: true, cwd: dir, pid: 1,
		startedAt: now, finishedAt: now, ok: true, findings: 0, droppedFindings: 0, stateUpdated: false,
		// A wide `notes` field is what actually makes the log cross 1 MB in a handful of records.
		notes: "x".repeat(4_000), usage: { input: 1, output: 1, cost: 0.01, turns: 1 },
	});
	const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
	// Rotation halves the file as soon as it passes 1 MB, so the size never climbs past that —
	// what says it happened is the log holding fewer records than were appended.
	let n = 0;
	let kept = 0;
	while (n < 2_000) {
		store.appendRun(rec(n++) as any);
		if (n % 50 === 0) {
			kept = store.allRuns().length;
			if (kept < n) break;
		}
	}
	assert.ok(kept < n, `rotation happened: ${kept} of ${n} records left`);
	const spend = store.spend(midnight.getTime());
	assert.ok(spend.rotated > 0, "the dropped records were folded into a ledger rotation cannot eat");
	assert.ok(Math.abs(spend.total - n * 0.01) < 1e-6, `${spend.total} still adds up to all ${n} runs`);
	// Yesterday's folded total must not leak into a window that starts today.
	assert.equal(store.spend(Date.now() + 86_400_000).total, 0);
});

test("a holder that overran the stale window does not delete the next holder's lock", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-lockown-"));
	const lock = path.join(dir, "x.lock");
	const order: string[] = [];

	// A holds the lock far longer than staleMs, so B breaks it and takes over.
	const a = withFileLock(lock, async () => {
		order.push("a-in");
		await new Promise((r) => setTimeout(r, 400));
		order.push("a-out");
	}, { staleMs: 50, timeoutMs: 2000 });
	await new Promise((r) => setTimeout(r, 120));
	const b = withFileLock(lock, async () => {
		order.push("b-in");
		await new Promise((r) => setTimeout(r, 400));
		// While B works, A finishes and its `finally` runs. It must not remove B's lock.
		assert.ok(fs.existsSync(lock), "B still holds a lock when A releases");
		order.push("b-out");
	}, { staleMs: 50, timeoutMs: 2000 });
	await Promise.all([a, b]);
	assert.deepEqual(order, ["a-in", "b-in", "a-out", "b-out"]);
	assert.equal(fs.existsSync(lock), false, "and the real holder's release does remove it");
});
