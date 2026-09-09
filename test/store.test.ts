import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Inbox, resolveInboxRef } from "../src/inbox.ts";
import { withFileLock } from "../src/lock.ts";
import { JobStore, type LoopJob, newId, owningSessionId, resolveJobRef, sessionExists } from "../src/store.ts";

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

test("job store round trip, update, remove clears state", async () => {
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
	await store.remove(a.id);
	assert.equal(store.load().length, 1);
	assert.ok(!fs.existsSync(store.statePath(a.id)));
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

test("inbox append/list/claim/dismiss, corrupt lines skipped", async () => {
	const inbox = new Inbox(tmp());
	assert.equal(inbox.newCount(), 0);
	const a = inbox.append({ source: "loop:x", text: "  found a flaky test  ", runId: "r", jobId: "j", cwd: "/" });
	const b = inbox.append({ source: "loop:x", text: "x".repeat(2000), runId: "r", jobId: "j", cwd: "/" });
	assert.equal(a.text, "found a flaky test");
	assert.ok(Array.from(b.text).length <= 501);
	fs.appendFileSync(inbox.file, "{not json\n");
	const c = inbox.append({ source: "loop:y", text: "after corruption", runId: "r2", jobId: "j", cwd: "/" });
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

test("inbox.jsonl uses pie's record shape on disk and still reads pi-loops ≤ 0.1.2 lines", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-inbox-"));
	const inbox = new Inbox(dir);
	const a = inbox.append({ source: "loop:x", text: "finding", runId: "run-1", jobId: "cron-1", cwd: "/p", sessionId: "s1", verified: true, verifiedReason: "checked" });
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
