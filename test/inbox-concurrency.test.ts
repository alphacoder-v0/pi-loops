import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Inbox } from "../src/inbox.ts";

test("a finding appended while another process rewrites the inbox is not lost", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-inbox-race-"));
	const inbox = new Inbox(dir);
	for (let i = 0; i < 40; i++) inbox.append({ source: "cron:seed", text: `seed ${i}`, runId: "r", jobId: "j", cwd: dir });

	// A second process appends while this one dismisses everything (read-modify-rewrite).
	const script = `
	import { Inbox } from ${JSON.stringify(path.resolve("src/inbox.ts"))};
	const inbox = new Inbox(${JSON.stringify(dir)});
	const until = Date.now() + 3000;
	let i = 0;
	while (Date.now() < until && i < 200) inbox.append({ source: "cron:child", text: "child " + i++, runId: "r", jobId: "j", cwd: ${JSON.stringify(dir)} });
	process.stdout.write(String(i));
	`;
	const file = path.join(dir, "child.ts");
	fs.writeFileSync(file, script);
	const child = spawn(process.execPath, ["--import", path.resolve("src/register-pi.mjs"), file], { stdio: ["ignore", "pipe", "inherit"] });
	let appended = "";
	child.stdout.on("data", (d) => (appended += d));
	const exited = new Promise<number>((r) => child.on("exit", (c) => r(c ?? -1)));
	// Rewrite the whole file repeatedly while the child appends to it.
	for (let i = 0; i < 25; i++) {
		await inbox.dismissAllNew();
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.equal(await exited, 0);
	const wrote = Number(appended);
	assert.ok(wrote > 0, "the child appended something");

	const all = inbox.list();
	assert.equal(all.filter((e) => e.source === "cron:child").length, wrote, "every appended finding survived the concurrent rewrites");
	assert.equal(all.filter((e) => e.source === "cron:seed").length, 40);
});
