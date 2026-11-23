import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { COMMAND_OUTPUT_CHARS, PathLooks, commandDigest, gateDecision, gateOf, lookAt, lookCommand, lookLine, pathOnlyCondition, pathReading, precheckOf, type Look, type PathGate } from "../src/gate.ts";
import { TriggerStore } from "../src/triggers.ts";

const at = { cwd: "/work/proj", home: "/home/me" };
const watched = (condition: string) => {
	const r = pathOnlyCondition(condition, at);
	assert.ok("gate" in r, `${condition}: refused (${"why" in r ? r.why : ""})`);
	return r.gate;
};
const refused = (condition: string) => {
	const r = pathOnlyCondition(condition, at);
	assert.ok("why" in r, `${condition}: accepted as ${JSON.stringify(r)}`);
	return r.why;
};
const gate = (p: string): PathGate => ({ kind: "path", of: "x", raw: p, resolved: p });

test("[gate-decision] a path wakes unless it is absent; a command wakes when its digest is not the one seen; a failed look wakes", () => {
	const path_ = (state: "present" | "absent" | "unknown"): Look => ({ kind: "path", state });
	assert.equal(gateDecision(undefined, path_("present")), "wake");
	assert.equal(gateDecision(undefined, path_("absent")), "hold");
	assert.equal(gateDecision(undefined, path_("unknown")), "wake", "a look that cannot answer asks the model");
	assert.equal(gateDecision("seen", path_("absent")), "hold", "a path gate does not read seen");
	const digest = commandDigest(0, "3 open\n");
	assert.equal(digest, "62204aa65fbb75c8a6ef3084c9aab6a0636e907dc9d631702fce6e46e542dfde", "sha256 of the exit code, a newline and stdout");
	assert.notEqual(commandDigest(1, "3 open\n"), digest, "the exit code is part of the digest");
	const command: Look = { kind: "command", digest, output: "3 open\n" };
	assert.equal(gateDecision(undefined, command), "wake", "nothing seen yet");
	assert.equal(gateDecision(digest, command), "hold", "the same reading as the last gated run saw");
	assert.equal(gateDecision(commandDigest(0, "2 open\n"), command), "wake", "a changed reading");
});

test("[gate-failed-wakes] a failed look wakes, whatever was seen: a timeout, an exit of 126 or more, a command that cannot start", async () => {
	const dir = tmp("pi-loops-gate-failed-");
	assert.equal(gateDecision("anything", { kind: "failed", why: "timed out after 5s" }), "wake");
	const t0 = Date.now();
	const slow = await lookCommand("sleep 5", { cwd: dir, timeoutMs: 100 });
	assert.ok(Date.now() - t0 < 2000, "the timeout ends the look");
	assert.deepEqual(slow.look, { kind: "failed", why: "timed out after 0.1s" });
	assert.equal(gateDecision(undefined, slow.look), "wake");
	const missing = await lookCommand("no-such-program-for-a-gate", { cwd: dir });
	assert.equal(missing.look.kind, "failed", "exit 127");
	assert.equal(JSON.parse(missing.raw).exit, 127);
	assert.equal(gateDecision("x", missing.look), "wake");
	const plain = await lookCommand("printf 'a'; exit 1", { cwd: dir });
	assert.equal(plain.look.kind, "command", "an exit under 126 is a reading");
	assert.equal(plain.look.kind === "command" && plain.look.digest, commandDigest(1, "a"));
});

test("[gate-policy] a command gate passes the dangerous-command policy first: a refusal is a failed look and the command does not run", async () => {
	const dir = tmp("pi-loops-gate-policy-");
	const reading = await lookCommand("touch ran; echo x | eval cat", { cwd: dir });
	assert.equal(reading.look.kind, "failed");
	assert.match(reading.look.kind === "failed" ? reading.look.why : "", /^refused: piping or substituting into eval$/);
	assert.equal(fs.existsSync(path.join(dir, "ran")), false, "the command did not run");
	assert.deepEqual(JSON.parse(reading.raw), { command: "touch ran; echo x | eval cat", refused: "piping or substituting into eval" });
	assert.equal(gateDecision(undefined, reading.look), "wake");
	const allowed = await lookCommand("touch ran; printf ok", { cwd: dir });
	assert.equal(allowed.look.kind, "command");
	assert.ok(fs.existsSync(path.join(dir, "ran")), "a command the policy allows runs in cwd");
});

test("a command look reads at most 4000 characters of stdout, and its raw reading is the command, the exit code and stdout", async () => {
	const dir = tmp("pi-loops-gate-cmd-");
	const reading = await lookCommand(`node -e "process.stdout.write('é'.repeat(5000))"`, { cwd: dir, policy: () => undefined });
	assert.equal(reading.look.kind, "command");
	const output = reading.look.kind === "command" ? reading.look.output : "";
	assert.equal(Array.from(output).length, COMMAND_OUTPUT_CHARS);
	assert.deepEqual(JSON.parse(reading.raw), { command: `node -e "process.stdout.write('é'.repeat(5000))"`, exit: 0, stdout: output });
	assert.equal(reading.look.kind === "command" && reading.look.digest, commandDigest(0, output));
});

test("a path reading's raw text is the path as typed, the path it resolved to, and its state", () => {
	const g = watched("~/build.done appears");
	assert.deepEqual(JSON.parse(pathReading(g, "absent").raw), { path: "~/build.done", resolved: "/home/me/build.done", state: "absent" });
	assert.deepEqual(pathReading(g, "present").look, { kind: "path", state: "present" });
});

test("path-only conditions: ~, $HOME, ${HOME}, absolute, relative, a quoted space, English and Chinese", () => {
	assert.deepEqual(watched("~/build.done appears"), { kind: "path", of: "~/build.done appears", raw: "~/build.done", resolved: "/home/me/build.done" });
	assert.equal(watched("when ~/build.done exists").resolved, "/home/me/build.done");
	assert.equal(watched("$HOME/helloworld exists").resolved, "/home/me/helloworld");
	assert.equal(watched("${HOME}/out/x.txt is created").resolved, "/home/me/out/x.txt");
	assert.equal(watched("$HOME/helloworld 存在").resolved, "/home/me/helloworld");
	assert.equal(watched("当 $HOME/helloworld 存在的时候").resolved, "/home/me/helloworld");
	assert.equal(watched("~/x 文件存在").resolved, "/home/me/x", "a noun set apart by a space is the noun");
	// A noun at the end of the path is part of its name.
	assert.equal(watched("~/备份文件 存在").resolved, "/home/me/备份文件");
	assert.equal(watched("~/data/备份目录 存在").resolved, "/home/me/data/备份目录");
	assert.equal(watched("/tmp/目录 存在").resolved, "/tmp/目录");
	assert.equal(watched("~/x文件存在").resolved, "/home/me/x文件");
	assert.equal(watched("./dist/app.js is created").resolved, "/work/proj/dist/app.js");
	assert.equal(watched("dist/app.js appears").resolved, "/work/proj/dist/app.js");
	assert.equal(watched("../other/ready shows up").resolved, "/work/other/ready");
	assert.equal(watched("build.done appears.").resolved, "/work/proj/build.done");
	assert.equal(watched('"~/My Files/done.txt" exists').resolved, "/home/me/My Files/done.txt");
	assert.equal(watched("the file `/tmp/ready` is there").resolved, "/tmp/ready");
	assert.equal(watched("/tmp/ready appears").raw, "/tmp/ready");
	assert.equal(watched("如果 ~/a/b 出现").resolved, "/home/me/a/b");
});

test("refused as path-only, each with why: a glob, an extra clause, two paths, not exists, a bare word, other variables, ~user, a URL", () => {
	assert.match(refused("~/logs/*.log appears"), /glob/);
	assert.match(refused("~/logs/{a,b} appears"), /glob/);
	assert.match(refused("~/x appears and it contains ERROR"), /extra clause/);
	assert.match(refused("when ~/x appears and it contains ERROR"), /extra clause/);
	assert.match(refused("~/x exists or ~/y exists"), /extra clause/);
	assert.match(refused("~/x 存在并且非空"), /extra clause/);
	assert.match(refused("~/a is newer than ~/b"), /not only that the path exists or appears/);
	assert.match(refused("~/a is deleted"), /not only/);
	assert.match(refused("README exists"), /not clearly a path/);
	assert.match(refused("$TMPDIR/x exists"), /only \$HOME/);
	assert.match(refused("/tmp/$USER/x exists"), /only \$HOME/);
	assert.match(refused("~bob/x exists"), /your own home/);
	assert.match(refused("https://example.com/x appears"), /URL/);
	for (const p of ["//server/share/x", "/net/box/x", "/Network/Servers/x"]) assert.equal(refused(`${p} exists`), "a network path needs the model");
	for (const p of ["/./net/h/x", "../../../../net/h/x", "$HOME/../../net/h/x", "/tmp/../Network/x"]) assert.equal(refused(`${p} exists`), "a network path needs the model", `${p}, once resolved`);
	assert.match(refused('"~/x exists'), /quote/);
	assert.match(refused("~/x"), /no verb/);
	assert.match(refused(""), /empty/);
	assert.match(refused(`/${"a".repeat(1100)} exists`), /longer than/);
	assert.match(refused("a PR of mine gets a review asking for changes"), /not/);
	// An aside in parentheses is a clause: it can make the condition true while the path is absent,
	// and nothing short of the model tells "(or /tmp/b exists)" from "(a build finished)".
	for (const c of ["/tmp/a exists (or /tmp/b exists)", "/tmp/a exists (any time the server is down)", "~/a 存在（还是 b.txt 存在）", "~/build.done exists (a build finished)", "~/x 存在（构建完成）"]) assert.match(refused(c), /extra clause/, c);
});

test("[triggers-v2] gateOf: the rule's gate, else 0.24.2's precheck, and only while the condition is the one it was read from", () => {
	const g = watched("~/build.done appears");
	const pre = precheckOf(g);
	assert.deepEqual(pre, { v: 1, of: "~/build.done appears", raw: "~/build.done", resolved: "/home/me/build.done" });
	assert.deepEqual(gateOf({ condition: "~/build.done appears", gate: g }), g);
	assert.deepEqual(gateOf({ condition: "~/build.done appears", precheck: pre }), g, "a rule 0.24.2 made");
	assert.deepEqual(gateOf({ condition: "~/build.done appears", gate: g, precheck: { ...pre, resolved: "/elsewhere" } }), g, "gate first");
	assert.equal(gateOf({ condition: "~/build.done appears", gate: { kind: "command", command: "true" }, precheck: pre }), undefined, "a gate that is not a path is not read as one, and precheck does not stand in for it");
	assert.equal(gateOf({ condition: "~/build.done appears and is not empty", gate: g }), undefined, "a hand edit is model-checked");
	assert.equal(gateOf({ condition: "~/build.done appears and is not empty", precheck: pre }), undefined);
	assert.equal(gateOf({ condition: "~/build.done appears" }), undefined, "a rule from before the pre-check");
	assert.equal(gateOf({ condition: "~/build.done appears", precheck: { ...pre, v: 2 } }), undefined);
	assert.equal(gateOf({ condition: "~/build.done appears", precheck: { ...pre, resolved: "rel/x" } }), undefined);
	assert.equal(gateOf({ condition: "~/build.done appears", gate: { ...g, resolved: "rel/x" } }), undefined);
});

test("lookAt: present, absent, a dangling symlink, an error and a hang are unknown", async () => {
	const dir = tmp("pi-loops-precheck-");
	const file = path.join(dir, "here");
	fs.writeFileSync(file, "");
	assert.equal(await lookAt(gate(file)), "present");
	assert.equal(await lookAt(gate(path.join(dir, "gone"))), "absent");
	assert.equal(await lookAt(gate(path.join(file, "under-a-file"))), "absent", "ENOTDIR");
	fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "link"));
	assert.equal(await lookAt(gate(path.join(dir, "link"))), "absent", "a dangling link");
	fs.writeFileSync(path.join(dir, "nowhere"), "");
	assert.equal(await lookAt(gate(path.join(dir, "link"))), "present", "the link's target exists now");
	assert.equal(await lookAt(gate(file), { stat: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) }), "unknown");
	const t0 = Date.now();
	assert.equal(await lookAt(gate(file), { stat: () => new Promise(() => {}), timeoutMs: 50 }), "unknown");
	assert.ok(Date.now() - t0 < 1000);
});

test("PathLooks: one stat in flight per rule; a second look while it hangs is unknown and starts nothing", async () => {
	let calls = 0;
	let settle: () => void = () => {};
	const looks = new PathLooks({ timeoutMs: 30, stat: () => { calls++; return new Promise<void>((resolve) => { settle = resolve; }); } });
	const w = gate("/x");
	assert.equal(await looks.look("dyn-a", w), "unknown", "timed out");
	assert.equal(await looks.look("dyn-a", w), "unknown");
	assert.equal(calls, 1, "no second stat while the first is out");
	settle();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(await looks.look("dyn-a", w), "unknown");
	assert.equal(calls, 2, "a new stat once the first settled");
});

test("PathLooks: at most two stats out in the whole process, and one per path; past the cap a look is unknown and starts nothing", async () => {
	let calls = 0;
	const hang = () => { calls++; return new Promise<void>(() => {}); };
	const looks = new PathLooks({ timeoutMs: 20, stat: hang });
	assert.equal(await looks.look("dyn-a", gate("/a")), "unknown");
	assert.equal(await looks.look("dyn-b", gate("/a")), "unknown", "the same path under another rule");
	assert.equal(calls, 1);
	assert.equal(await looks.look("dyn-c", gate("/c")), "unknown");
	assert.equal(calls, 2);
	assert.equal(await looks.look("dyn-d", gate("/d")), "unknown", "the third is past the cap");
	assert.equal(calls, 2, "and started nothing");
});

test("lookLine: the three things the rule row says", () => {
	const clock = () => "09:22";
	assert.equal(lookLine("absent", 1, clock), "next look 09:22 · no model call until the file exists");
	assert.equal(lookLine(undefined, undefined, clock), "no model call until the file exists");
	assert.equal(lookLine("present", 1, clock), "the file is there · the next look asks the model");
	assert.equal(lookLine("unknown", 1, clock), "could not look at the path · checked by the model");
});

test("[triggers-v2] TriggerStore.add records the gate and 0.24.2's precheck, with ~ resolved in the creating process; setEnabled keeps both; the file stays version 1", async () => {
	const dir = tmp("pi-loops-precheck-store-");
	const home = path.join(dir, "home");
	const saved = process.env.HOME;
	process.env.HOME = home;
	try {
		const store = new TriggerStore(dir);
		const rule = await store.add({ condition: "~/build.done appears", action: "tell me", cwd: dir });
		assert.deepEqual(rule.gate, { kind: "path", of: "~/build.done appears", raw: "~/build.done", resolved: path.join(home, "build.done") });
		assert.deepEqual(rule.precheck, { v: 1, of: "~/build.done appears", raw: "~/build.done", resolved: path.join(home, "build.done") }, "the same path, for 0.24.2");
		const rel = await store.add({ condition: "out/ready exists", action: "tell me", cwd: dir });
		assert.equal(rel.gate?.resolved, path.join(dir, "out/ready"));
		const not = await store.add({ condition: "~/x appears and it contains ERROR", action: "tell me", cwd: dir });
		assert.equal(not.gate, undefined);
		assert.equal(not.precheck, undefined);
		await store.setEnabled(rule.id, false);
		await store.setEnabled(rule.id, true);
		const back = store.load().find((r) => r.id === rule.id);
		assert.deepEqual(back?.gate, rule.gate, "survives a rewrite of the file");
		assert.deepEqual(back?.precheck, rule.precheck);
		assert.equal(JSON.parse(fs.readFileSync(store.rulesFile, "utf8")).version, 1);
	} finally {
		if (saved === undefined) delete process.env.HOME;
		else process.env.HOME = saved;
	}
});
