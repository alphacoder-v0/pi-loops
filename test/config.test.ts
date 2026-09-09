import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.ts";

test("config.toml: pie's keys plus pi-loops' runtime knobs, invalid values diagnosed", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-cfg-"));
	fs.writeFileSync(path.join(dir, "config.toml"), `allow_project_hooks = true\n[triggers]\npoll_interval_secs = 120\nrun_timeout_secs = 3600\n[cron]\ncatch_up = false\nmax_concurrent_runs = 5\n[hooks]\nmode = "async"\n`);
	const cfg = loadConfig(dir);
	assert.equal(cfg.allowProjectHooks, true);
	assert.equal(cfg.triggerPollIntervalSecs, 120);
	assert.equal(cfg.triggerRunTimeoutMs, 3600_000);
	assert.equal(cfg.cronCatchUp, false);
	assert.equal(cfg.maxConcurrentRuns, 5);
	assert.equal(cfg.hooksMode, "async");
	assert.deepEqual(cfg.errors, []);
	fs.writeFileSync(path.join(dir, "config.toml"), `[triggers]\npoll_interval_secs = 0\nrun_timeout_secs = -1\n[cron]\nmax_concurrent_runs = 0\n[hooks]\nmode = "sometimes"\n`);
	const bad = loadConfig(dir);
	assert.equal(bad.triggerPollIntervalSecs, 600);
	assert.equal(bad.triggerRunTimeoutMs, 15 * 60_000);
	assert.equal(bad.maxConcurrentRuns, 3);
	assert.equal(bad.hooksMode, "sync", "pie awaits hooks inline; that is the default");
	assert.equal(bad.errors.length, 4, JSON.stringify(bad.errors));
});
