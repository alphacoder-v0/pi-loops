import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { HookRunner, messageKind, messageSummary, parseHooksToml, resultSummary } from "../src/hooks.ts";

test("parseHooksToml: defaults, per-rule diagnostics, allow_project_hooks, enabled=false skipped", () => {
	const r = parseHooksToml(`allow_project_hooks = true\n[[hook]]\nevent = "tool_end"\ntool = "bash"\ncommand = "true"\n\n[[hook]]\nevent = "nope"\ncommand = "x"\n\n[[hook]]\nevent = "turn_end"\n\n[[hook]]\nevent = "agent_end"\nenabled = false\ncommand = "x"\n\n[[hook]]\nevent = "turn_end"\nwebhook = "http://x"\ntimeout_ms = 100\ncwd = "home"\non_failure = "ignore"\n[hook.headers]\nX = "y"\n`, "user");
	assert.equal(r.allowProjectHooks, true);
	assert.equal(r.hooks.length, 2, "bad rules skipped, good ones kept");
	assert.equal(r.hooks[0].timeoutMs, 5000);
	assert.equal(r.hooks[0].cwd, "project");
	assert.deepEqual(r.hooks[1].headers, { X: "y" });
	assert.equal(r.hooks[1].onFailure, "ignore");
	assert.equal(r.diagnostics.length, 2);
	assert.match(r.diagnostics[0], /unknown event "nope"/);
	assert.match(r.diagnostics[1], /neither command nor webhook/);
});

test("summaries mirror pie: placeholders, tool_result kind, truncation", () => {
	assert.equal(messageKind({ role: "toolResult" }), "tool_result");
	assert.equal(messageSummary({ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "hi" }, { type: "toolCall", name: "bash" }] }), "<thinking>\nhi\n<tool_call bash>");
	assert.equal(messageSummary({ role: "user", content: "plain" }), "plain");
	assert.equal(resultSummary({ content: [{ type: "text", text: "out" }, { type: "image", mimeType: "image/png" }] }), "out\n<image image/png>");
	assert.equal(Array.from(messageSummary({ role: "user", content: "x".repeat(5000) })!).length, 2001);
});

test("command hook: PI_/PIE_ env + payload file (tool_args, source), webhook JSON, sequential order, failures warn, project gating, tree kill on timeout", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-hooks-"));
	const project = path.join(dir, "proj");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	const out = path.join(dir, "out.txt");
	const order = path.join(dir, "order.txt");
	const received: any[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			received.push({ headers: req.headers, body: JSON.parse(body) });
			res.statusCode = req.url === "/fail" ? 500 : 200;
			res.end(req.url === "/fail" ? "nope, bad payload" : "");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as any).port;
	fs.writeFileSync(path.join(dir, "hooks.toml"), [
		`[[hook]]`, `event = "tool_end"`, `tool = "bash"`, `command = "sleep 0.2; printf '%s|%s|%s' \\"$PIE_TOOL_NAME\\" \\"$PI_TOOL_IS_ERROR\\" \\"$(cat $PI_HOOK_PAYLOAD)\\" > ${out}; echo first >> ${order}"`,
		`[[hook]]`, `event = "tool_end"`, `command = "echo second >> ${order}; [ -z \\"\${PI_COMPACTION_TRIGGER+x}\\" ] || exit 9"`,
		`[[hook]]`, `event = "tool_end"`, `webhook = "http://127.0.0.1:${port}/ok"`, `[hook.headers]`, `Authorization = "Bearer t"`,
		`[[hook]]`, `event = "turn_end"`, `webhook = "http://127.0.0.1:${port}/fail"`, `timeout_ms = 2000`,
		`[[hook]]`, `event = "agent_start"`, `timeout_ms = 300`, `command = "(sleep 30 & echo $! > ${dir}/child.pid; wait)"`,
		"",
	].join("\n"));
	fs.writeFileSync(path.join(project, ".pi", "hooks.toml"), `[[hook]]\nevent = "agent_end"\ncommand = "true"\n`);
	const warnings: string[] = [];
	const session = { sessionId: "sess-1", cwd: project, model: "openai/gpt-5.5", thinking: "medium" };
	const runner = new HookRunner({ loopsDir: dir, projectCwd: project, warn: (m) => warnings.push(m), getSession: () => session });
	runner.load();
	assert.equal(runner.hooks.length, 5, "project hooks ignored by default");
	assert.match(runner.diagnostics[0], /allow_project_hooks/);

	await runner.fire({ event: "tool_end", tool_name: "bash", tool_is_error: false, tool_call_id: "c1", tool_args: { command: "ls" } });
	const [name, isErr, payloadJson] = fs.readFileSync(out, "utf8").split("|");
	assert.equal(name, "bash");
	assert.equal(isErr, "false");
	const payload = JSON.parse(payloadJson);
	assert.equal(payload.source, "user");
	assert.equal(payload.model_provider, "openai");
	assert.equal(payload.model_id, "gpt-5.5");
	assert.equal(payload.thinking_level, "medium");
	assert.deepEqual(payload.tool_args, { command: "ls" });
	assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["first", "second"], "rules run sequentially in file order");
	assert.equal(received.length, 1);
	assert.equal(received[0].headers.authorization, "Bearer t");
	assert.match(received[0].headers["user-agent"], /pi-loops/);
	assert.equal(received[0].body.tool_name, "bash");

	await runner.fire({ event: "tool_end", tool_name: "read" });
	assert.equal(received.length, 2, "tool filter: only untargeted hooks fired");
	await runner.fire({ event: "turn_end" });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /webhook status 500: nope, bad payload/);

	await runner.fire({ event: "agent_start" });
	assert.match(warnings[1], /timed out after 300ms/);
	const childPid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8").trim());
	await new Promise((r) => setTimeout(r, 100));
	let alive = true;
	try {
		process.kill(childPid, 0);
	} catch {
		alive = false;
	}
	assert.equal(alive, false, "timeout killed the whole process tree, not just sh");

	const allowed = new HookRunner({ loopsDir: dir, projectCwd: project, allowProjectHooks: true, warn: () => {}, getSession: () => session });
	allowed.load();
	assert.equal(allowed.hooks.length, 6);
	fs.writeFileSync(path.join(dir, "hooks.toml"), `allow_project_hooks = true\n`);
	const viaToml = new HookRunner({ loopsDir: dir, projectCwd: project, warn: () => {}, getSession: () => session });
	viaToml.load();
	assert.equal(viaToml.hooks.length, 1, "allow_project_hooks in the user hooks.toml opts project hooks in, like pie");
	server.close();
});
