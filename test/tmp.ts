/**
 * Temporary directories for tests, and what happens to them afterwards.
 *
 * `tmp(prefix)` is `fs.mkdtempSync` under the OS temp dir with a record kept. A directory made
 * inside a test is removed when that test **passes** and kept when it fails, with its path printed,
 * because a failed run's session files, logs and fake-pi scripts are the evidence someone will want
 * at nine in the morning. A directory made outside any test (a module-level fixture shared by the
 * file) is removed when the file ends, unless a test in it failed. `PI_LOOPS_KEEP_TMP=1` keeps
 * everything.
 *
 * Processes are the other half. `src/web.mjs` starts its pi in a process group of its own, so a
 * test that ends web.mjs does not always end the fake pi behind it: one interrupted run left
 * twenty-one of them, and a week of runs left fifty thousand directories. Anything whose command
 * line points into a directory made here is ended before the directory goes — and ended even when
 * the directory is kept, since a process is not evidence and its output is already in the test's.
 */
import { after, afterEach, beforeEach } from "node:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const KEEP_ALL = !!process.env.PI_LOOPS_KEEP_TMP;
/** Made by the test that is running now. */
let current: string[] = [];
/** Made outside any test: fixtures a file shares between its tests. */
const shared: string[] = [];
/** Removed once already: a timer or a child a test left running can write one back, so they go again at the end. */
const settled: string[] = [];
let inTest = false;
let anyFailed = false;

export function tmp(prefix = "pi-loops-"): string {
	return track(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A path a test derives itself — `${dir}2`, a sibling it needs by that exact name — settled like one `tmp` made. */
export function track(dir: string): string {
	(inTest ? current : shared).push(dir);
	return dir;
}

/** End every process whose command line points into one of `dirs` — a fake pi web.mjs started, a stray host. */
function endStrays(dirs: string[]): void {
	if (!dirs.length) return;
	let listing = "";
	try {
		listing = execSync("ps -eo pid=,args=", { encoding: "utf8" });
	} catch {
		return; // no ps here: the directories still go
	}
	for (const line of listing.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(.*)$/);
		if (!m || Number(m[1]) === process.pid || !dirs.some((d) => m[2].includes(`${d}/`))) continue;
		try {
			process.kill(Number(m[1]), "SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

function settle(dirs: string[], keep: boolean, why: string): void {
	if (!dirs.length) return;
	endStrays(dirs);
	if (keep) {
		process.stderr.write(`${why}: kept for inspection\n${dirs.map((d) => `  ${d}`).join("\n")}\n`);
		return;
	}
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	settled.push(...dirs);
}

beforeEach(() => {
	inTest = true;
	current = [];
});

afterEach((t) => {
	inTest = false;
	// `passed` is on the context node:test hands a hook (Node ≥ 22); an older Node has no verdict, and no verdict keeps nothing.
	const failed = (t as unknown as { passed?: boolean }).passed === false;
	if (failed) anyFailed = true;
	settle(current, failed || KEEP_ALL, `${t.name}: ${failed ? "failed" : "kept by PI_LOOPS_KEEP_TMP"}`);
	current = [];
});

after(() => {
	settle(shared, anyFailed || KEEP_ALL, anyFailed ? "a test in this file failed" : "kept by PI_LOOPS_KEEP_TMP");
	endStrays(settled);
	for (const dir of settled) fs.rmSync(dir, { recursive: true, force: true });
});
