import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { boot } from "./journey/boot.mjs";

const get = async (url: string) => fetch(url, { redirect: "manual" });

test("journey boot isolates its page and reaps a marked stray", { timeout: 120_000 }, async () => {
	const out = path.join(tmp("pi-loops-journey-"), "boot");
	fs.mkdirSync(out);
	const canonicalOut = fs.realpathSync(out);
	const run = await boot({ out, page: "new" });
	try {
		assert.equal((await get(run.url)).status, 403);
		assert.equal((await get(`${run.url}?token=${run.token}`)).status, 200);
		assert.equal(run.root, canonicalOut);
		assert.equal(run.env.HOME, path.join(canonicalOut, "home"));
		assert.equal(run.env.PATH, `${path.join(canonicalOut, "bin")}:/usr/bin:/bin`);
		assert.equal("PI_LOOPS_HOST" in run.env, false);
		assert.equal("TMPDIR" in run.env, false);
		const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: run.root, env: run.env, stdio: "ignore" });
		const strayExited = new Promise<void>((resolve) => stray.once("exit", () => resolve()));
		await new Promise<void>((resolve, reject) => {
			stray.once("spawn", () => resolve());
			stray.once("error", reject);
		});
		const stopped = await run.stop();
		await strayExited;
		assert.equal(stopped.survivors.length, 0);
		assert.throws(() => process.kill(stray.pid!, 0), { code: "ESRCH" });
	} finally {
		await run.stop();
	}
});

test("journey boot runs an archived product tree", { timeout: 120_000 }, async () => {
	const out = path.join(tmp("pi-loops-journey-"), "archive");
	fs.mkdirSync(out);
	const run = await boot({ out, against: "HEAD", page: "new" });
	try {
		assert.equal((await get(`${run.url}?token=${run.token}`)).status, 200);
		assert.ok(fs.existsSync(path.join(run.product, "src", "cli-entry.mjs")));
	} finally {
		assert.equal((await run.stop()).survivors.length, 0);
	}
});
