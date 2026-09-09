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

test("[limits] daily_budget_usd is read, validated and defaults to no cap", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-budget-"));
	assert.equal(loadConfig(dir).dailyBudgetUsd, 0, "no cap unless asked for");

	fs.writeFileSync(path.join(dir, "config.toml"), "[limits]\ndaily_budget_usd = 12.5\n");
	assert.equal(loadConfig(dir).dailyBudgetUsd, 12.5);

	fs.writeFileSync(path.join(dir, "config.toml"), "[limits]\ndaily_budget_usd = 0\n");
	assert.equal(loadConfig(dir).dailyBudgetUsd, 0, "0 is a valid way to say no cap");

	fs.writeFileSync(path.join(dir, "config.toml"), '[limits]\ndaily_budget_usd = "lots"\n');
	const bad = loadConfig(dir);
	assert.equal(bad.dailyBudgetUsd, 0);
	assert.match(bad.errors.join("\n"), /daily_budget_usd/);

	fs.writeFileSync(path.join(dir, "config.toml"), "[limits]\ndaily_budget_usd = -1\n");
	assert.match(loadConfig(dir).errors.join("\n"), /≥ 0/);
});

test("[danger] allow is read as a list of prefixes and validated", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-allow-"));
	assert.deepEqual(loadConfig(dir).allowCommands, []);
	fs.writeFileSync(path.join(dir, "config.toml"), '[danger]\nallow = ["rm -rf /var/cache/x", "sudo systemctl reload y"]\n');
	assert.deepEqual(loadConfig(dir).allowCommands, ["rm -rf /var/cache/x", "sudo systemctl reload y"]);
	fs.writeFileSync(path.join(dir, "config.toml"), '[danger]\nallow = "rm -rf /"\n');
	const bad = loadConfig(dir);
	assert.deepEqual(bad.allowCommands, [], "a non-list is refused rather than half-read");
	assert.match(bad.errors.join("\n"), /\[danger\] allow/);
});

test("a jobs.json from a newer pi-loops is refused, not silently downgraded", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-ver-"));
	const { JobStore, JOBS_FILE_VERSION } = await import("../src/store.ts");
	fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify({ version: JOBS_FILE_VERSION + 1, jobs: [{ id: "cron-x", futureField: true }] }));
	const store = new JobStore(dir);
	assert.throws(() => store.load(), /written by a newer pi-loops/);
	// The file is left exactly as it was, so the newer build still reads it.
	const raw = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"));
	assert.equal(raw.version, JOBS_FILE_VERSION + 1);
	assert.equal(raw.jobs[0].futureField, true);
});
