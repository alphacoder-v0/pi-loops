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
