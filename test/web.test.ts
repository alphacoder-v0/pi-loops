import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WEB = path.join(process.cwd(), "src", "web.mjs");

/** Run the front end against a stand-in for pi, and collect everything it printed. */
function runWeb(piScript: string, port: number, ms = 4000): Promise<{ code: number | null; output: string }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-web-"));
	const fake = path.join(dir, "fakepi");
	fs.writeFileSync(fake, piScript, { mode: 0o755 });
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [WEB, "--port", String(port), "--no-open"], {
			env: { ...process.env, PI_BIN: fake, PI_LOOPS_DIR: path.join(dir, "loops") },
		});
		let output = "";
		child.stdout.on("data", (d) => (output += d.toString()));
		child.stderr.on("data", (d) => (output += d.toString()));
		const timer = setTimeout(() => child.kill("SIGTERM"), ms);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

test("a pi that refuses to start takes the front end down cleanly, saying why", { timeout: 30_000 }, async () => {
	// The real case: two copies of an extension installed, so pi exits before answering anything.
	// The front end used to write to a closed stdin and die of an unhandled EPIPE instead — which
	// left a browser tab pointing at nothing and the reason only in a terminal.
	const { code, output } = await runWeb('#!/bin/sh\necho \'Error: Tool "cron_create" conflicts with /somewhere/else\' >&2\nexit 1\n', 45231);
	assert.equal(code, 1, "it leaves with pi's own exit code");
    assert.match(output, /Tool "cron_create" conflicts/, "pi's reason reaches the terminal");
	assert.equal(/Unhandled|EPIPE\n\s+at /.test(output), false, `no crash, got:\n${output}`);
	assert.match(output, /pi exited \(1\)/);
});

test("a pi that starts is served, and the page is reachable", { timeout: 30_000 }, async () => {
	// `sleep` stands in for a pi that is up but has nothing to say: enough to prove the server binds
	// and answers, without a model call.
	const port = 45232;
	const running = runWeb("#!/bin/sh\nsleep 6\n", port, 5000);
	await new Promise((r) => setTimeout(r, 1500));
	const res = await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
	assert.equal(res?.status, 403, "the page needs the token, even from localhost");
	const { output } = await running;
	assert.match(output, /pi-web on http:\/\/127\.0\.0\.1:45232\/\?token=[0-9a-f]{32}/);
});
