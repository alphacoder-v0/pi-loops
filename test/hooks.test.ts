import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import * as http from "node:http";
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

test("summaries: placeholders, tool_result kind, truncation", () => {
	assert.equal(messageKind({ role: "toolResult" }), "tool_result");
	assert.equal(messageSummary({ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "hi" }, { type: "toolCall", name: "bash" }] }), "<thinking>\nhi\n<tool_call bash>");
	assert.equal(messageSummary({ role: "user", content: "plain" }), "plain");
	assert.equal(resultSummary({ content: [{ type: "text", text: "out" }, { type: "image", mimeType: "image/png" }] }), "out\n<image image/png>");
	assert.equal(Array.from(messageSummary({ role: "user", content: "x".repeat(5000) })!).length, 2001);
});

test("command hook: PI_ env + payload file (tool_args, source), webhook JSON, sequential order, failures warn, project gating, tree kill on timeout", async () => {
	const dir = tmp("pi-loops-hooks-");
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
		`[[hook]]`, `event = "tool_end"`, `tool = "bash"`, `command = "sleep 0.2; printf '%s|%s|%s' \\"$PI_TOOL_NAME\\" \\"$PI_TOOL_IS_ERROR\\" \\"$(cat $PI_HOOK_PAYLOAD)\\" > ${out}; echo first >> ${order}"`,
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
	assert.equal(viaToml.hooks.length, 1, "allow_project_hooks in the user hooks.toml opts project hooks in");
	server.close();
});


test("drain waits for queued hooks (bounded)", async () => {
	const dir = tmp("pi-loops-hooks-");
	const out = path.join(dir, "done.txt");
	fs.writeFileSync(path.join(dir, "hooks.toml"), `[[hook]]\nevent = "agent_end"\ncommand = "sleep 0.3; echo done > ${out}"\n`);
	const runner = new HookRunner({ loopsDir: dir, projectCwd: dir, warn: () => {}, getSession: () => ({ cwd: dir }) });
	runner.load();
	void runner.fire({ event: "agent_end" });
	assert.equal(await runner.drain(3000), true);
	assert.equal(fs.readFileSync(out, "utf8").trim(), "done");
	fs.writeFileSync(path.join(dir, "hooks.toml"), `[[hook]]\nevent = "agent_end"\ncommand = "sleep 5"\ntimeout_ms = 10000\n`);
	runner.load();
	void runner.fire({ event: "agent_end" });
	assert.equal(await runner.drain(200), false, "drain gives up after its timeout");
});

test("payload carries every field (null when absent); custom messages report their customType", async () => {
	const dir = tmp("pi-loops-hooks-");
	const file = path.join(dir, "payload.json");
	fs.writeFileSync(path.join(dir, "hooks.toml"), `[[hook]]\nevent = "agent_start"\ncommand = "cp \\"$PI_HOOK_PAYLOAD\\" ${file}"\n`);
	const runner = new HookRunner({ loopsDir: dir, projectCwd: dir, warn: () => {}, getSession: () => ({ cwd: dir }) });
	runner.load();
	await runner.fire({ event: "agent_start" });
	await runner.drain(3000);
	const payload = JSON.parse(fs.readFileSync(file, "utf8"));
	for (const k of ["message_kind", "message_summary", "assistant_event", "tool_call_id", "tool_name", "tool_is_error", "tool_args", "tool_result_summary", "compaction_trigger", "compaction_tokens_before", "compaction_summary", "compaction_failed"]) assert.equal(payload[k], null, k);
	assert.equal(messageKind({ role: "custom", customType: "pi-loops:trigger" }), "pi-loops:trigger");
	assert.equal(messageKind({ role: "toolResult" }), "tool_result");
});

test("a compaction that did not happen reaches the same hook, flagged", async () => {
	const dir = tmp("pi-loops-hooks-");
	const file = path.join(dir, "payload.json");
	const env = path.join(dir, "env.txt");
	fs.writeFileSync(path.join(dir, "hooks.toml"), `[[hook]]\nevent = "compaction"\ncommand = "cp \\"$PI_HOOK_PAYLOAD\\" ${file}; printf '%s|%s' \\"$PI_COMPACTION_FAILED\\" \\"$PI_COMPACTION_TRIGGER\\" > ${env}"\n`);
	const runner = new HookRunner({ loopsDir: dir, projectCwd: dir, warn: () => {}, getSession: () => ({ cwd: dir }) });
	runner.load();
	// A session that cannot compact is a session about to fail on context length: the watcher that
	// asked for `compaction` is exactly the one that wants to hear about it.
	await runner.fire({ event: "compaction", compaction_trigger: "manual", compaction_failed: true });
	await runner.drain(3000);
	const payload = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(payload.compaction_failed, true);
	assert.equal(payload.compaction_summary, null, "there is no summary: the compaction did not happen");
	assert.equal(fs.readFileSync(env, "utf8"), "true|manual");
});

test("hook stdout goes to the per-process log, bounded", async () => {
	const dir = tmp("pi-loops-hooks-");
	fs.writeFileSync(
		path.join(dir, "hooks.toml"),
		[`[[hook]]`, `event = "agent_start"`, `command = "echo 'wrote 3 lines to the log'"`, `[[hook]]`, `event = "turn_start"`, `command = "true"`, `[[hook]]`, `event = "turn_end"`, `command = "printf 'x%.0s' $(seq 1 20000)"`, ""].join("\n"),
	);
	const logged: string[] = [];
	const runner = new HookRunner({ loopsDir: dir, projectCwd: dir, warn: () => {}, getSession: () => ({ cwd: dir }), log: (m) => logged.push(m) });
	runner.load();
	await runner.fire({ event: "agent_start" });
	await runner.fire({ event: "turn_start" });
	await runner.fire({ event: "turn_end" });
	await runner.drain(3000);
	assert.equal(logged.length, 2, "a hook that printed nothing writes nothing");
	assert.match(logged[0], /^hook user agent_start: wrote 3 lines to the log$/);
	assert.ok(logged[1].length < 5000, `a hook that prints 20 KB must not put 20 KB in the log (got ${logged[1].length})`);
	assert.match(logged[1], /truncated/);
});

test("a run has its own two events, so a rule about your turns never sees automation", () => {
	const dir = tmp("pi-loops-hooks-run-");
	fs.writeFileSync(
		path.join(dir, "hooks.toml"),
		['[[hook]]', 'event = "run_end"', 'command = "true"', '', '[[hook]]', 'event = "agent_end"', 'command = "true"', ''].join("\n"),
	);
	const runner = new HookRunner({ loopsDir: dir, projectCwd: dir, allowProjectHooks: false, getSession: () => ({ sessionId: "s", cwd: dir, model: "p/m" }), warn: () => {} });
	runner.load();
	assert.deepEqual(runner.diagnostics, [], "run_end is a known event, not a typo");
	assert.equal(runner.hasHooksFor("run_end"), true);
	// The point of the separate pair: a rule written about the conversation does not start firing
	// for loop runs, and a rule written about runs does not fire on every turn you take.
	assert.equal(runner.hooks.filter((h) => h.event === "run_end").length, 1);
	assert.equal(runner.hooks.filter((h) => h.event === "agent_end").length, 1);

	const payload = (runner as any).payloadFor(runner.hooks[0], {
		event: "run_end", run_job: "nightly", run_id: "run-abc", run_ok: false, run_findings: 2, run_error: "boom", run_cost_usd: 0.04,
	});
	assert.equal(payload.run_job, "nightly");
	assert.equal(payload.run_ok, false);
	assert.equal(payload.run_findings, 2);
	assert.equal(payload.run_cost_usd, 0.04);
	// Every field is present on every event, null when it does not apply: that is the contract.
	const turn = (runner as any).payloadFor(runner.hooks[0], { event: "agent_end" });
	assert.equal(turn.run_job, null);
	assert.equal(turn.run_ok, null);
});

test("cwd = loops names the pi-loops directory; an unknown cwd is refused with its diagnostic", () => {
	const dir = tmp("pi-loops-hooks-");
	const project = tmp("pi-loops-proj-");
	fs.writeFileSync(
		path.join(dir, "hooks.toml"),
		'[[hook]]\nevent = "turn_end"\ncwd = "loops"\ncommand = "true"\n\n[[hook]]\nevent = "turn_end"\ncwd = "elsewhere"\ncommand = "true"\n',
	);
	const runner = new HookRunner({ loopsDir: dir, projectCwd: project, allowProjectHooks: false, getSession: () => ({}) as any, warn: () => {} });
	runner.load();
	// A hook whose cwd nobody recognises is skipped and said out loud: running it in the project
	// directory instead would not fail, it would quietly do the wrong thing somewhere else.
	assert.equal(runner.diagnostics.length, 1);
	assert.match(runner.diagnostics[0], /invalid cwd "elsewhere" \(project \| loops \| home\)/);
	const where = (runner as any).hooks.map((h: any) => (runner as any).resolveCwd(h));
	assert.deepEqual(where, [dir], "the one hook that loaded runs in the loops directory");
});
