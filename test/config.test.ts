import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { envFlag, loadConfig, pageBindPort } from "../src/config.ts";

test("config.toml: every key, and what an invalid values diagnosed", () => {
	const dir = tmp("pi-loops-cfg-");
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
	assert.equal(bad.hooksMode, "sync", "hooks are awaited inline; that is the default");
	assert.equal(bad.errors.length, 4, JSON.stringify(bad.errors));
});

test("[limits] daily_budget_usd is read, validated and defaults to no cap", () => {
	const dir = tmp("pi-loops-budget-");
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
	const dir = tmp("pi-loops-allow-");
	assert.deepEqual(loadConfig(dir).allowCommands, []);
	fs.writeFileSync(path.join(dir, "config.toml"), '[danger]\nallow = ["rm -rf /var/cache/x", "sudo systemctl reload y"]\n');
	assert.deepEqual(loadConfig(dir).allowCommands, ["rm -rf /var/cache/x", "sudo systemctl reload y"]);
	fs.writeFileSync(path.join(dir, "config.toml"), '[danger]\nallow = "rm -rf /"\n');
	const bad = loadConfig(dir);
	assert.deepEqual(bad.allowCommands, [], "a non-list is refused rather than half-read");
	assert.match(bad.errors.join("\n"), /\[danger\] allow/);
});

test("[engine] window_guard is read, on by default, and an invalid value is reported and ignored", () => {
	const dir = tmp("pi-loops-guard-");
	assert.equal(loadConfig(dir).windowGuard, true, "a scheduled turn in an open window is capped unless asked otherwise");
	fs.writeFileSync(path.join(dir, "config.toml"), "[engine]\nwindow_guard = false\n");
	assert.equal(loadConfig(dir).windowGuard, false);
	fs.writeFileSync(path.join(dir, "config.toml"), "[engine]\nwindow_guard = true\n");
	assert.equal(loadConfig(dir).windowGuard, true);
	fs.writeFileSync(path.join(dir, "config.toml"), '[engine]\nwindow_guard = "off"\n');
	const bad = loadConfig(dir);
	assert.equal(bad.windowGuard, true, "an unreadable value leaves the guard on");
	assert.equal(bad.errors.length, 1, JSON.stringify(bad.errors));
	assert.match(bad.errors[0], /\[engine\] window_guard.*must be true or false/);
});

test("[page] port, host and allow_host are read, default to loopback on 4173, and an invalid value is reported and ignored", () => {
	const dir = tmp("pi-loops-page-cfg-");
	const none = loadConfig(dir);
	assert.deepEqual([none.pagePort, none.pageHost, none.pageAllowHosts], [4173, "127.0.0.1", []]);

	fs.writeFileSync(path.join(dir, "config.toml"), '[page]\nport = 4200\nhost = "0.0.0.0"\nallow_host = ["box.example", "pi.example"]\n');
	const set = loadConfig(dir);
	assert.deepEqual([set.pagePort, set.pageHost, set.pageAllowHosts, set.errors], [4200, "0.0.0.0", ["box.example", "pi.example"], []]);

	fs.writeFileSync(path.join(dir, "config.toml"), '[page]\nport = 70000\nhost = ""\nallow_host = "box.example"\n');
	const bad = loadConfig(dir);
	assert.deepEqual([bad.pagePort, bad.pageHost, bad.pageAllowHosts], [4173, "127.0.0.1", []]);
	assert.deepEqual(
		bad.errors.map((e) => e.split(":")[0]),
		["[page] port", "[page] host", "[page] allow_host"],
	);
});

test("[page] port is honoured for any loops directory once it is set, and PI_LOOPS_PAGE_PORT wins over both", () => {
	const dir = tmp("pi-loops-page-port-");
	const unset = loadConfig(dir);
	assert.equal(unset.pagePortSet, false);
	assert.equal(pageBindPort(unset, { defaultDir: true }), 4173, "the default directory gets the address worth bookmarking");
	assert.equal(pageBindPort(unset, { defaultDir: false }), 0, "any other takes a free port, so two do not fight over one");

	fs.writeFileSync(path.join(dir, "config.toml"), "[page]\nport = 4200\n");
	const set = loadConfig(dir);
	assert.equal(set.pagePortSet, true);
	assert.equal(pageBindPort(set, { defaultDir: false }), 4200, "a PI_LOOPS_DIR that sets [page] port keeps it across restarts");
	assert.equal(pageBindPort(set, { defaultDir: true }), 4200);

	assert.equal(pageBindPort(set, { defaultDir: false, env: "4300" }), 4300, "the environment wins over the file");
	assert.equal(pageBindPort(unset, { defaultDir: true, env: "0" }), 0);
	assert.equal(pageBindPort(set, { defaultDir: false, env: "nope" }), 4200, "one that is not a port is ignored");
	assert.equal(pageBindPort(set, { defaultDir: false, env: "" }), 4200);

	fs.writeFileSync(path.join(dir, "config.toml"), "[page]\nport = 70000\n");
	assert.equal(loadConfig(dir).pagePortSet, false, "an invalid port is ignored, so it does not count as set");
});

test("a jobs.json from a newer pi-loops is refused, not silently downgraded", async () => {
	const dir = tmp("pi-loops-ver-");
	const { JobStore, JOBS_FILE_VERSION } = await import("../src/store.ts");
	fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify({ version: JOBS_FILE_VERSION + 1, jobs: [{ id: "cron-x", futureField: true }] }));
	const store = new JobStore(dir);
	assert.throws(() => store.load(), /written by a newer pi-loops/);
	// The file is left exactly as it was, so the newer build still reads it.
	const raw = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"));
	assert.equal(raw.version, JOBS_FILE_VERSION + 1);
	assert.equal(raw.jobs[0].futureField, true);
});

test("envFlag: 1 or true, and a typo is off", () => {
	const name = "LOOPS_TEST_FLAG";
	const restore = process.env[`PI_${name}`];
	const set = (value?: string) => {
		if (value === undefined) delete process.env[`PI_${name}`];
		else process.env[`PI_${name}`] = value;
	};
	try {
		set(undefined);
		assert.equal(envFlag(name), false, "unset is off");
		for (const on of ["1", "true", "TRUE", "True"]) {
			set(on);
			assert.equal(envFlag(name), true, on);
		}
		for (const off of ["0", "", "yes", "no", "2"]) {
			set(off);
			assert.equal(envFlag(name), false, `${JSON.stringify(off)} is not on: a typo fails closed`);
		}
	} finally {
		set(restore);
	}
});
