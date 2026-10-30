import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpPool } from "../src/mcp-pool.ts";

const FAKE_SERVER = path.resolve("test/fake-mcp-server.mjs");

function project(name: string): string {
	const dir = tmp(`pi-loops-${name}-`);
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(path.join(dir, ".pi", "mcp.toml"), `[[server]]\nname = "${name}"\nkind = "stdio"\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FAKE_SERVER)}]\n`);
	return dir;
}

test("a run gets its own project's MCP servers, not the ones the process happens to have", async () => {
	const proj = project("projsrv");
	const pool = new McpPool({ isTrusted: () => true });
	try {
		const tools = await pool.toolsFor(proj, new Set());
		assert.ok(tools.length > 0, "the project's own server is connected on demand");
		assert.ok(tools.some((t) => t.name === "echo" || t.name === "projsrv_echo"), tools.map((t) => t.name).join(","));

		// A name already taken by a built-in or a user-level server is not shadowed.
		const taken = new Set(["echo"]);
		const second = await pool.toolsFor(proj, taken);
		assert.equal(second.some((t) => t.name === "echo"), false, "an existing name is never replaced");
	} finally {
		await pool.stopAll();
	}
});

test("a project trusted after a first, untrusted run is picked up without restarting", async () => {
	const proj = project("latertrust");
	let trusted = false;
	const pool = new McpPool({ isTrusted: () => trusted });
	try {
		assert.deepEqual(await pool.toolsFor(proj, new Set()), [], "untrusted: nothing, and nothing cached");
		trusted = true;
		const tools = await pool.toolsFor(proj, new Set());
		assert.ok(tools.length > 0, "the same pool now connects the project's servers");
	} finally {
		await pool.stopAll();
	}
});

test("an untrusted project lends nothing, and a project with no config is not an error", async () => {
	const proj = project("untrusted");
	const bare = tmp("pi-loops-bare-");
	const logs: string[] = [];
	const pool = new McpPool({ isTrusted: () => false, log: (m) => logs.push(m) });
	try {
		assert.deepEqual(await pool.toolsFor(proj, new Set()), []);
		assert.match(logs.join("\n"), /not trusted/);
		assert.deepEqual(await pool.toolsFor(proj, new Set()), [], "asking twice does not repeat the warning");
		assert.equal(logs.filter((m) => /not trusted/.test(m)).length, 1);
		assert.deepEqual(await pool.toolsFor(bare, new Set()), []);
		assert.deepEqual(await pool.toolsFor("", new Set()), [], "the host's empty cwd asks for nothing");
	} finally {
		await pool.stopAll();
	}
});

test("a project with rules keeps its push servers connected, and their pushes reach the host with the project's directory", async () => {
	const proj = project("pushsrv");
	const untrusted = project("untrusted");
	const pushes: Array<{ cwd: string; server: string; method: string }> = [];
	// Real paths on both sides: a temp dir is a symlink on macOS (/var -> /private/var), and the pool
	// keys projects by their real path, as pi's own trust check does.
	const real = (p: string) => fs.realpathSync(p);
	const pool = new McpPool({ isTrusted: (cwd) => real(cwd) === real(proj), onNotification: (cwd, cfg, n) => pushes.push({ cwd, server: cfg.name, method: n.method }) });
	try {
		pool.watch([proj, untrusted]);
		for (let i = 0; i < 100 && !pushes.some((p) => p.method === "notifications/custom/thing"); i++) await new Promise((r) => setTimeout(r, 50));
		assert.ok(pushes.some((p) => real(p.cwd) === real(proj) && p.server === "pushsrv" && p.method === "notifications/custom/thing"), JSON.stringify(pushes));
		assert.equal(pushes.some((p) => real(p.cwd) === real(untrusted)), false, "an untrusted project is not connected");
	} finally {
		await pool.stopAll();
	}
});

test("watch keeps exactly the wanted projects connected: revoked or rule-less ones are stopped, spellings collapse, and the cap does not churn", async () => {
	const a = project("watcha");
	let trusted = new Set([a]);
	const pool = new McpPool({ isTrusted: (cwd) => [...trusted].some((t) => fs.realpathSync(t) === fs.realpathSync(cwd)), onNotification: () => undefined });
	const connected = () => [...(pool as any).entries.keys()] as string[];
	try {
		pool.watch([a, `${a}/`]);
		assert.deepEqual(connected(), [fs.realpathSync(a)], "one connection for two spellings of one project");
		trusted = new Set();
		pool.watch([a]);
		assert.deepEqual(connected(), [], "trust revoked: its servers are stopped");
		trusted = new Set([a]);
		pool.watch([a]);
		pool.watch([]);
		assert.deepEqual(connected(), [], "no rules left: stopped too");
		const many = Array.from({ length: 9 }, (_, i) => project(`cap${i}`));
		trusted = new Set(many);
		pool.watch(many);
		const first = connected();
		assert.equal(first.length, 8);
		pool.watch(many);
		assert.deepEqual(connected(), first, "a minute later the same eight, not a reconnect of all of them");
	} finally {
		await pool.stopAll();
	}
});

test("a loop's run without exact trust does not take away the servers a held turn connected on its owner's trust", async () => {
	// One directory, two kinds of run: a held turn may load it on pi's saved trust for a parent, a
	// loop only on saved trust for this exact directory. The loop's refusal used to stop the held
	// turn's servers mid-turn, every time a check ran there.
	const proj = project("ownertrust");
	let exact = false;
	const pool = new McpPool({ isTrusted: () => exact });
	try {
		const held = await pool.toolsFor(proj, new Set(), true);
		assert.ok(held.length > 0, "the held turn gets the project's servers");
		assert.deepEqual(await pool.toolsFor(proj, new Set()), [], "a loop there does not");
		const again = await pool.toolsFor(proj, new Set(), true);
		assert.equal(again[0], held[0], "the same connection, not one stopped and opened again");
		// The owner no longer trusts it: the held turn is refused, and its servers are stopped.
		assert.deepEqual(await pool.toolsFor(proj, new Set(), false), []);
		const reopened = await pool.toolsFor(proj, new Set(), true);
		assert.notEqual(reopened[0], held[0], "revoked owner trust stopped them; trusting again starts new ones");
		// Saved exact trust that is then revoked still stops lending, and stops the servers.
		exact = true;
		assert.ok((await pool.toolsFor(proj, new Set())).length > 0);
		exact = false;
		assert.deepEqual(await pool.toolsFor(proj, new Set()), [], "revoked: nothing lent");
	} finally {
		await pool.stopAll();
	}
});
