import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Inbox, resolveInboxRef } from "../src/inbox.ts";
import { withFileLock } from "../src/lock.ts";
import { JobStore, type LoopJob, newId, resolveJobRef } from "../src/store.ts";

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
