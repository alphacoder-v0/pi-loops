import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock } from "../src/lock.ts";

test("a lock path that exists for mkdir and not for stat times out instead of spinning", async () => {
	const dir = tmp("pi-loops-lock-");
	const lockPath = path.join(dir, "store.lock");
	// A dangling symlink: mkdir says EEXIST, stat says ENOENT. Neither the stale check nor the
	// sleep used to be reached, so this used to burn a core until the process was killed.
	fs.symlinkSync(path.join(dir, "nothing-here"), lockPath);
	const startedAt = Date.now();
	await assert.rejects(() => withFileLock(lockPath, () => "never runs", { timeoutMs: 120, staleMs: 60 }), /timed out waiting for lock/);
	assert.ok(Date.now() - startedAt >= 100, "it waited rather than failing on the first attempt");
});

test("a lock is held for the duration of the critical section and released after it", async () => {
	const dir = tmp("pi-loops-lock2-");
	const lockPath = path.join(dir, "jobs.lock");
	const order: string[] = [];
	const held = withFileLock(lockPath, async () => {
		order.push("first in");
		await new Promise((r) => setTimeout(r, 50));
		order.push("first out");
	});
	const waiting = withFileLock(lockPath, () => void order.push("second in"));
	await Promise.all([held, waiting]);
	assert.deepEqual(order, ["first in", "first out", "second in"]);
	assert.equal(fs.existsSync(lockPath), false, "and the lock directory is gone afterwards");
});
