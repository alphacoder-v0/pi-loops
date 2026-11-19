import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createHostRuntime } from "../src/host-runtime.ts";
import { RUNTIME_RIDERS } from "../src/ticker.ts";
import { loopLane } from "../src/lane.ts";
import { tmp } from "./tmp.ts";

const USAGE = { input: 1, output: 1, cost: 0, turns: 1 };
const ID = "cron-0123456789abcdef0123456789abcdef";
const job = (cwd: string, t0: number, ms: number) => ({ id: ID, schedule: { kind: "every", ms }, stateful: true, prompt: "look", cwd, enabled: true, catchUp: true, createdAt: new Date(t0 - ms - 30_000).toISOString(), runCount: 0, skippedOverlap: 0 });

function host(dir: string, runner: (req: any) => Promise<any>, logs: string[]) {
	const h = createHostRuntime({ dir, config: () => loadConfig(dir), session: () => ({ cwd: "" }), mcpTools: () => [], log: (line) => void logs.push(line), runner: runner as any });
	// As src/ticker.ts does: a rider that throws is logged and the others still run.
	const tick = async (now: number) => {
		for (const name of RUNTIME_RIDERS) {
			try { await h.riders[name](now, { startedAt: 0, tickMs: 30_000 }); }
			catch (error) { logs.push(`tick: ${name} failed: ${(error as Error).message}`); }
		}
		await h.drain(2000);
	};
	return { h, tick };
}

test("a loop's run closes when jobs.json cannot be read as it ends: its row is spent, and the next slots run once the file reads again, as main", async () => {
	const dir = tmp();
	const calls: unknown[] = [];
	const logs: string[] = [];
	let saved = "";
	const { h, tick } = host(dir, async () => {
		calls.push(1);
		if (calls.length === 1) {
			saved = fs.readFileSync(path.join(dir, "jobs.json"), "utf8");
			fs.writeFileSync(path.join(dir, "jobs.json"), "{ half-typed");
		}
		return { ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE };
	}, logs);
	try {
		const t0 = Date.now();
		await h.stores.jobs.add(job(dir, t0, 60_000) as any);
		await tick(t0);
		assert.equal(calls.length, 1);
		assert.deepEqual(h.stores.requests.list(loopLane(ID)!), [], "the row of the slot that ran is gone: the lane is not left running");
		fs.writeFileSync(path.join(dir, "jobs.json"), saved);
		for (let minute = 1; minute <= 3; minute++) await tick(t0 + minute * 60_000);
		assert.ok(calls.length >= 2, `the next slots run: ${calls.length - 1} after the first`);
		assert.ok(logs.some((line) => line.includes("jobs read failed")), logs.join("\n"));
	} finally { await h.stop(); }
});

test("a loop's run whose record cannot be appended once is spent, not run again: the failure is logged, as main logs it", async () => {
	const dir = tmp();
	const prompts: unknown[] = [];
	const logs: string[] = [];
	const { h, tick } = host(dir, async () => { prompts.push(1); return { ok: true, exitCode: 0, timedOut: false, text: "done", usage: USAGE }; }, logs);
	try {
		const t0 = Date.now();
		await h.stores.jobs.add(job(dir, t0, 3_600_000) as any);
		const original = h.stores.jobs.appendRunOnce.bind(h.stores.jobs);
		let failOnce = true;
		h.stores.jobs.appendRunOnce = ((make: any) => { if (failOnce) { failOnce = false; throw new Error("ENOSPC: no space left on device"); } return original(make); }) as any;
		await tick(t0);
		await tick(t0 + 10_000);
		assert.equal(prompts.length, 1, "the slot ran once");
		assert.deepEqual(h.stores.requests.list(loopLane(ID)!), [], "its row is spent, with no claim left for a restart to close as interrupted");
		assert.ok(logs.some((line) => line.includes("run log append failed")), logs.join("\n"));
		assert.equal(h.stores.book().clock.jobs[ID]?.runs, 1, "the run counts, as main counts it in its own field");
	} finally { await h.stop(); }
});
