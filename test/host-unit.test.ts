import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { unitCommands, unitFile, unitKind, unitState, renderUnit, refreshUnit, type UnitSpec } from "../src/host-unit.ts";

// A node that exists on every machine the suite runs on: "other" and "stale" turn on whether the recorded node is there.
const spec = (over: Partial<UnitSpec> = {}): UnitSpec => ({ node: process.execPath, args: ["--trace", "/pkg/src/host-entry.mjs"], env: { ZED: "z", PATH: "/bin" }, logFile: "/home/u/host.log", home: "/home/u", ...over });
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test("unitKind selects only supported login managers", () => {
	assert.equal(unitKind("darwin", () => false), "launchd");
	assert.equal(unitKind("linux", (p) => p === "/run/systemd/system"), "systemd");
	assert.equal(unitKind("linux", () => false), undefined);
	assert.equal(unitKind("win32", () => true), undefined);
});

test("unitFile uses the platform's per-user location", () => {
	assert.equal(unitFile("systemd", "/home/a"), "/home/a/.config/systemd/user/pi-loops-host.service");
	assert.equal(unitFile("launchd", "/home/a"), "/home/a/Library/LaunchAgents/dev.pi-loops.host.plist");
});

test("systemd renderer quotes arguments, escapes expansion and sorts environment", () => {
	const rendered = renderUnit("systemd", spec({ node: "/some path/node%", args: ["--dollar=$HOME", "/pkg name/host.mjs"], env: { ZED: "$HOME%", ALPHA: "a b" }, home: "/home/u%", logFile: "/tmp/log%" }));
	assert.ok(rendered.startsWith("# pi-loops host unit, written by `pi-loops host install`.\n# pi-loops-host: "));
	assert.ok(rendered.includes('ExecStart="/some path/node%%" "--dollar=$$HOME" "/pkg name/host.mjs"'));
	assert.ok(rendered.indexOf('Environment="ALPHA=a b"') < rendered.indexOf('Environment="ZED=$HOME%%"'));
	assert.ok(rendered.includes("WorkingDirectory=/home/u%%"));
	assert.ok(rendered.includes("StandardOutput=append:/tmp/log%%"));
	assert.ok(rendered.endsWith("WantedBy=default.target\n"));
});

test("renderer refuses newlines and invalid environment names", () => {
	assert.throws(() => renderUnit("systemd", spec({ args: ["bad\narg"] })), /cannot write the host unit: argument contains a line break/);
	assert.throws(() => renderUnit("systemd", spec({ env: { "BAD-NAME": "x" } })), /cannot write the host unit: bad environment name BAD-NAME/);
});

test("launchd renderer XML-escapes and keeps a parseable record comment", () => {
	const dir = tmp("pi-loops-unit-");
	const file = path.join(dir, "agent.plist");
	const s = spec({ node: "/node--tool&", args: ["/pkg--old/src/host-entry.mjs"], env: { A: "x&<>'\"" } });
	const rendered = renderUnit("launchd", s);
	assert.ok(rendered.includes("/node--tool&amp;"));
	const recordLine = rendered.split("\n").find((line) => line.includes("pi-loops-host:"))!;
	assert.equal(recordLine.slice(recordLine.indexOf("pi-loops-host:")).replace(/ -->$/, "").includes("--"), false);
	write(file, rendered);
	assert.deepEqual(unitState("launchd", file, s), { file, state: "current" });
});

test("unitState distinguishes absent, current, foreign, stale, other and env-only changes", () => {
	const dir = tmp("pi-loops-unit-state-");
	const file = path.join(dir, "service");
	const s = spec();
	assert.equal(unitState("systemd", file, s).state, "absent");
	write(file, renderUnit("systemd", s));
	assert.equal(unitState("systemd", file, s).state, "current");
	assert.equal(unitState("systemd", file, spec({ env: { OTHER: "value" } })).state, "current");
	write(file, "# somebody else's unit\n");
	assert.equal(unitState("systemd", file, s).state, "foreign");
	write(file, "# pi-loops host unit, written by `pi-loops host install`.\n# pi-loops-host: {bad}\n");
	assert.equal(unitState("systemd", file, s).state, "stale");
	write(file, "# pi-loops host unit, written by `pi-loops host install`.\n# pi-loops-host: {\"node\":\"/missing-node\",\"entry\":\"/pkg/src/host-entry.mjs\"}\n");
	assert.equal(unitState("systemd", file, s).state, "stale");
	const liveEntry = path.join(dir, "different", "src", "host-entry.mjs");
	fs.mkdirSync(path.dirname(liveEntry), { recursive: true });
	fs.writeFileSync(liveEntry, "");
	const elsewhere = spec({ args: [liveEntry] });
	write(file, renderUnit("systemd", elsewhere));
	assert.equal(unitState("systemd", file, s).state, "other");
});

test("refresh rewrites stale only, and leaves foreign and other files unchanged", () => {
	const dir = tmp("pi-loops-unit-refresh-");
	const file = path.join(dir, "service");
	const before = spec({ node: "/old-node" });
	const after = spec();
	write(file, renderUnit("systemd", before));
	const refreshed = refreshUnit("systemd", file, after);
	assert.deepEqual(refreshed, { ok: true, message: `refreshed the pi-loops host unit at ${file}: the node it runs changed` });
	assert.equal(fs.readFileSync(file, "utf8"), renderUnit("systemd", after));
	write(file, "my own file\n");
	const foreign = fs.readFileSync(file, "utf8");
	assert.equal(refreshUnit("systemd", file, after), undefined);
	assert.equal(fs.readFileSync(file, "utf8"), foreign);
	const liveEntry = path.join(dir, "another", "src", "host-entry.mjs");
	fs.mkdirSync(path.dirname(liveEntry), { recursive: true });
	fs.writeFileSync(liveEntry, "");
	const other = spec({ args: [liveEntry] });
	write(file, renderUnit("systemd", other));
	const bytes = fs.readFileSync(file, "utf8");
	assert.equal(refreshUnit("systemd", file, after), undefined);
	assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("unitCommands returns the specified argv for every action", () => {
	const ctx = { uid: 501, file: "/home/u/agent.plist" };
	assert.deepEqual(unitCommands("systemd", "install", ctx), [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "pi-loops-host.service"]]);
	assert.deepEqual(unitCommands("systemd", "uninstall", ctx), [["systemctl", "--user", "disable", "pi-loops-host.service"]]);
	assert.deepEqual(unitCommands("systemd", "start", ctx), [["systemctl", "--user", "start", "pi-loops-host.service"]]);
	assert.deepEqual(unitCommands("systemd", "reload", ctx), [["systemctl", "--user", "daemon-reload"]]);
	assert.deepEqual(unitCommands("launchd", "install", ctx), [["launchctl", "bootstrap", "gui/501", ctx.file]]);
	assert.deepEqual(unitCommands("launchd", "uninstall", ctx), [["launchctl", "bootout", "gui/501/dev.pi-loops.host"]]);
	assert.deepEqual(unitCommands("launchd", "start", ctx), [["launchctl", "kickstart", "gui/501/dev.pi-loops.host"]]);
	assert.deepEqual(unitCommands("launchd", "reload", ctx), [["launchctl", "bootout", "gui/501/dev.pi-loops.host"], ["launchctl", "bootstrap", "gui/501", ctx.file]]);
});
