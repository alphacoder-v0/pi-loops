import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// A write to a child's stdin after the child closed it is an `error` event on the pipe. With no
// listener it ends the process in every mode pi-loops runs in. The page's
// front end learned this in 9cb321c and the MCP stdio client did not, until a flaky test showed it.
// This reads the source text, so it holds that a file that writes to a child's stdin has an error
// listener on one, not that each child has its own; test/mcp.test.ts runs the MCP behaviour.
test("every file of src/ that writes to a child's stdin listens for its error", () => {
	const dir = path.join(process.cwd(), "src");
	const writes = /\bstdin[!?]?\.(write|end)\(|\.pipe\([^)]*stdin/;
	const listens = /\bstdin[!?]?\.(on|once)\(\s*"error"/;
	const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.(ts|mjs|js)$/.test(f)).filter((f) => writes.test(fs.readFileSync(path.join(dir, f), "utf8").replaceAll("process.stdin", "")));
	assert.ok(files.length >= 3, `the control: the files that write to a child's stdin are found (${files.join(", ")})`);
	for (const f of files) assert.match(fs.readFileSync(path.join(dir, f), "utf8"), listens, `src/${f} writes to a child's stdin and has no error listener on it`);
});
