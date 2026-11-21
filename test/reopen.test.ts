/**
 * What the resume of an answered question stands on (design section 10, stage 5.0), against pi's
 * real SDK and the stand-in model of test/downstream/fake-model.mjs: a run whose `bash` call a
 * `tool_call` handler blocks ends normally and leaves the call and an error result for it in its
 * session file, with the arguments the handler saw; and that file reopens with
 * `SessionManager.open` and takes a second prompt whose request carries the first turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { type Grant, type ResolvedCap, askId, blockedCall, inputHash, resolveCap } from "../src/ask.ts";
import { laneTranscript } from "../src/session-head.ts";
import { GuardSeats, type GuardSeed } from "../src/guard.ts";
import { Inbox } from "../src/inbox.ts";
import type { SubagentRequest } from "../src/runner.ts";
import { createInProcessRunner } from "../src/sdk-runner.ts";
import { tmp } from "./tmp.ts";

const FAKE_MODEL = path.join(path.dirname(new URL(import.meta.url).pathname), "downstream", "fake-model.mjs");
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const lines = (file: string): any[] => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("[reopen-probe] a blocked call leaves the call and its error result, with the arguments the guard saw; the transcript reopens and a second prompt carries the first turn", async () => {
	const root = tmp("pi-loops-reopen-");
	const agentDir = path.join(root, "agent");
	const sessionDir = path.join(root, "sessions");
	const cwd = path.join(root, "proj");
	for (const dir of [agentDir, sessionDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	const requests = path.join(root, "requests.jsonl");
	const portFile = path.join(root, "port");
	const fake = spawn(process.execPath, [FAKE_MODEL, portFile], {
		env: { ...process.env, FAKE_MODEL_REPLY: "the first turn is over", FAKE_MODEL_LOG: requests, FAKE_MODEL_TOOL_SCRIPT: JSON.stringify([{ match: "PROMPT-ONE", tool: "bash", args: { command: "echo hi" } }]) },
		stdio: "ignore",
	});
	try {
		for (let i = 0; i < 200 && !(fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").trim()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
		const port = fs.readFileSync(portFile, "utf8").trim();
		fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }));
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
		const model = modelRuntime.getModel("fake", "fake-model");
		assert.ok(model, "the stand-in model is registered");

		const seen: unknown[] = [];
		const guard = { name: "guard", factory: (pi: any) => { pi.on("tool_call", (event: any) => (event.toolName === "bash" ? (seen.push(event.input), { block: true, reason: "blocked by the guard" }) : undefined)); } };
		const run = async (sessionManager: ReturnType<typeof SessionManager.create>, prompt: string): Promise<string> => {
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [guard] });
			await resourceLoader.reload();
			const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, resourceLoader, settingsManager, sessionManager, sessionStartEvent: { type: "session_start", reason: "new" } });
			await session.bindExtensions({ mode: "print" });
			await session.prompt(prompt);
			const file = session.sessionFile!;
			session.dispose();
			return file;
		};

		// The first run: its bash call is blocked, and the run ends normally.
		const file = await run(SessionManager.create(cwd, sessionDir), "PROMPT-ONE please run something");
		const messages = lines(file).filter((entry) => entry.type === "message").map((entry) => entry.message);
		const call = messages.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content : [])).find((part: any) => part.type === "toolCall" && part.name === "bash");
		assert.ok(call, "the session file holds the blocked call");
		const result = messages.find((m) => m.role === "toolResult" && m.toolCallId === call.id);
		assert.ok(result, "and a result for it");
		assert.equal(result.isError, true, "an error result");
		assert.equal(seen.length, 1, "the guard saw the call once");
		assert.equal(hash(seen[0]), hash(call.arguments), "the arguments the guard saw are the ones stored");
		assert.equal(messages.at(-1)?.role, "assistant", "the run's answer follows the pair");

		// The second run reopens the same file, and its request carries the first turn.
		const before = lines(requests).length;
		const again = await run(SessionManager.open(file), "PROMPT-TWO what happened before?");
		assert.equal(again, file, "the same transcript");
		const second = lines(requests)[before];
		const carried = JSON.stringify(second.messages);
		assert.match(carried, /PROMPT-ONE please run something/, "the first prompt");
		assert.match(carried, /blocked by the guard/, "the blocked call's error result");
		assert.match(carried, /the first turn is over/, "the model's first answer");
		assert.ok(second.messages.some((m: any) => Array.isArray(m.tool_calls) && m.tool_calls.some((c: any) => c.function?.name === "bash")), "the blocked call itself");
		assert.match(carried, /PROMPT-TWO what happened before\?/, "and the second prompt");
	} finally {
		fake.kill();
	}
});

/** A stand-in model on loopback that answers with `script`, and an agent directory that names it. */
async function standIn(root: string, script: Array<{ match: string; tool: string; args: unknown }>) {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const requests = path.join(root, "requests.jsonl");
	const portFile = path.join(root, "port");
	const fake = spawn(process.execPath, [FAKE_MODEL, portFile], { env: { ...process.env, FAKE_MODEL_REPLY: "done for now", FAKE_MODEL_LOG: requests, FAKE_MODEL_TOOL_SCRIPT: JSON.stringify(script) }, stdio: "ignore" });
	for (let i = 0; i < 200 && !(fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").trim()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
	const port = fs.readFileSync(portFile, "utf8").trim();
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }));
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
	const model = modelRuntime.getModel("fake", "fake-model");
	assert.ok(model, "the stand-in model is registered");
	return { agentDir, requests, fake, modelRuntime, model };
}

const LANE = "@cron-a1";
const PUSH = "git push --force origin main";
const flags = { extensionPaths: [] as string[], skillPaths: [], promptTemplatePaths: [], appendSystemPrompt: [], noSkills: true, noExtensions: false, noContextFiles: true, noPromptTemplates: true };

/** The real runner, with the guard's seats, an inbox, and `-e` extensions loaded before the guard. */
function guardedRunner(root: string, model: Awaited<ReturnType<typeof standIn>>, extensionPaths: string[] = []) {
	const inbox = new Inbox(path.join(root, "loops"));
	const seats = new GuardSeats();
	let parentModel: typeof model.model | undefined = model.model;
	const runner = createInProcessRunner({
		agentDir: model.agentDir,
		parentFlags: { ...flags, extensionPaths },
		getParentModel: () => parentModel,
		getParentModelRuntime: () => model.modelRuntime,
		getParentThinking: () => undefined,
		customTools: () => [],
		isTrusted: () => false,
		ownDir: tmp("pi-loops-own-"),
		guard: { seats, deps: { inbox, allowCommands: () => [], now: Date.now } },
	});
	return { runner, inbox, dropParentModel: () => (parentModel = undefined) };
}

const seed = (cwd: string, grant?: Grant): GuardSeed => ({ lane: LANE, origin: { source: "cron:a1", run_id: "run-1", cwd, job_id: "cron-a1", who: "the loop a1" }, cap: resolveCap({ cwd }, 20_000), ...(grant ? { grant } : {}) });

test("[reopen-probe] the real guard files the question of a blocked call; the transcript proves it to E3; an extension that changes the input first makes E3 refuse", { timeout: 30_000 }, async () => {
	const root = tmp("pi-loops-reopen-");
	const cwd = path.join(root, "proj");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(cwd, { recursive: true });
	const model = await standIn(root, [{ match: "PROMPT-ONE", tool: "bash", args: { command: PUSH } }]);
	try {
		const mutator = path.join(root, "mutator.ts");
		fs.writeFileSync(mutator, `export default function (pi: any) { pi.on("tool_call", (event: any) => { if (event.toolName === "bash") event.input.command = event.input.command + " --quiet"; }); }\n`);
		for (const [extensions, expected] of [[[], "there"], [[mutator], "another-input"]] as const) {
			const { runner, inbox } = guardedRunner(path.join(root, expected), model, [...extensions]);
			const result = await runner({ cwd, prompt: "PROMPT-ONE please push", timeoutMs: 20_000, hop: 1, kind: "loop", sessionDir, guard: seed(cwd) });
			assert.equal(result.ok, true, `${expected}: a blocked call does not end the run (${result.errorMessage})`);
			const file = result.sessionFile!;
			const asked = inbox.list();
			assert.equal(asked.length, 1, `${expected}: one question`);
			const ask = asked[0].ask!;
			assert.equal(ask.session_id, result.sessionId, "the question names the run's session by the id its SessionManager gave");
			assert.equal(laneTranscript(sessionDir, ask.session_id!), file, "and the lane's directory has that transcript by its header");
			assert.match(ask.id, /^ask-/);
			assert.deepEqual(result.guard, { asked: [ask.id] }, "the runner reports what its guard asked");
			assert.equal(blockedCall(lines(file), ask.call), expected, expected === "there" ? "the stored call is the asked one" : "the stored call is not the one the guard hashed: E3 refuses it");
			if (expected === "another-input") assert.equal(ask.call.command, `${PUSH} --quiet`, "the guard saw the input after the other extension changed it");
		}
	} finally {
		model.fake.kill();
	}
});

test("[reopen-probe] a resumed run opens the same transcript with the transcript's model, carries the first turn, and reports grant_used only when the granted call ran", { timeout: 30_000 }, async () => {
	const root = tmp("pi-loops-resume-");
	const cwd = path.join(root, "proj");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(cwd, { recursive: true });
	// `| eval` with nothing to evaluate does nothing; the policy still asks about it.
	const asked = "echo granted | eval";
	const model = await standIn(root, [
		{ match: "PROMPT-ONE", tool: "bash", args: { command: asked } },
		{ match: "PROMPT-TWO", tool: "bash", args: { command: asked } },
		{ match: "PROMPT-THREE", tool: "bash", args: { command: "echo other | eval" } },
	]);
	try {
		const { runner, inbox, dropParentModel } = guardedRunner(root, model);
		const first = await runner({ cwd, prompt: "PROMPT-ONE please run it", timeoutMs: 20_000, hop: 1, kind: "loop", sessionDir, guard: seed(cwd) });
		const file = first.sessionFile!;
		const finding = inbox.list()[0];
		assert.equal(finding.ask?.id, askId(first.sessionId!, finding.ask!.call.tool_call_id));
		assert.equal(laneTranscript(sessionDir, finding.ask!.session_id!), file, "the transcript is found in the lane's directory by its header");
		const grant = { finding: finding.id, ask: finding.ask!.id, call: finding.ask!.call } as unknown as Grant;
		assert.equal(grant.call.input_sha256, inputHash({ command: asked }));

		dropParentModel(); // only the transcript can name a model now
		const before = lines(model.requests).length;
		const resumed = await runner({ cwd, prompt: "PROMPT-TWO a person said yes", timeoutMs: 20_000, hop: 1, kind: "loop", resume: { file, sessionId: first.sessionId! }, guard: seed(cwd, grant) });
		assert.equal(resumed.ok, true, resumed.errorMessage ?? "");
		assert.equal(resumed.sessionFile, file, "the same transcript");
		assert.equal(resumed.model, "fake/fake-model", "the transcript's own model");
		assert.equal(resumed.usage.turns, 2, "its own turns, not the transcript's");
		const carried = JSON.stringify(lines(model.requests)[before].messages);
		assert.match(carried, /PROMPT-ONE please run it/, "the request carries the first turn");
		assert.match(carried, /asked a person/, "and the blocked call's result");
		assert.deepEqual(resumed.guard, { grant_used: true, asked: [] }, "the granted call ran");
		assert.equal(inbox.list().length, 1, "and asked nothing");

		const other = await runner({ cwd, prompt: "PROMPT-THREE a person said yes", timeoutMs: 20_000, hop: 1, kind: "loop", resume: { file, sessionId: first.sessionId! }, guard: seed(cwd, grant) });
		assert.equal(other.guard?.grant_used, false, "another call is not the granted one");
		assert.equal(other.guard?.asked.length, 1, "it is asked about");

		const gone = await runner({ cwd, prompt: "PROMPT-TWO", timeoutMs: 20_000, hop: 1, kind: "loop", resume: { file: path.join(root, "gone.jsonl"), sessionId: first.sessionId! }, guard: seed(cwd, grant) });
		assert.deepEqual([gone.ok, gone.guard], [false, undefined], "a resume whose file is gone fails before any session");
		assert.match(gone.errorMessage!, /the transcript to resume is gone/);
	} finally {
		model.fake.kill();
	}
});

test("a request opens an existing session one way only: sessionFile or resume", () => {
	const base = { cwd: "/p", prompt: "x", timeoutMs: 1, hop: 1, kind: "loop" } as const;
	const held: SubagentRequest = { ...base, sessionFile: "/a.jsonl", sessionId: "s" };
	const resumed: SubagentRequest = { ...base, resume: { file: "/a.jsonl", sessionId: "s" } };
	// @ts-expect-error resume and sessionFile together do not compile
	const both: SubagentRequest = { ...base, sessionFile: "/a.jsonl", resume: { file: "/a.jsonl", sessionId: "s" } };
	assert.deepEqual([held.sessionFile, resumed.resume?.file, both.kind], ["/a.jsonl", "/a.jsonl", "loop"]);
});

test("[review-F2] a session the runner did not seat has no seat, even when its file is a seated run's file", { timeout: 30_000 }, async () => {
	const root = tmp("pi-loops-impostor-");
	const cwd = path.join(root, "proj");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(cwd, { recursive: true });
	const granted = "echo granted | eval";
	const model = await standIn(root, [
		{ match: "PROMPT-ONE", tool: "bash", args: { command: granted } },
		{ match: "PROMPT-SLOW", tool: "bash", args: { command: "sleep 2" } },
		{ match: "PROMPT-IMPOSTOR", tool: "bash", args: { command: granted } },
	]);
	try {
		const { runner, inbox } = guardedRunner(root, model);
		const first = await runner({ cwd, prompt: "PROMPT-ONE please run it", timeoutMs: 20_000, hop: 1, kind: "loop", sessionDir, guard: seed(cwd) });
		const file = first.sessionFile!;
		const finding = inbox.list()[0];
		const grant = { finding: finding.id, ask: finding.ask!.id, call: finding.ask!.call } as unknown as Grant;
		// The seated run waits in `sleep 2` while a held turn with no seat opens the same file.
		const seated = runner({ cwd, prompt: "PROMPT-SLOW a person said yes", timeoutMs: 20_000, hop: 1, kind: "loop", resume: { file, sessionId: first.sessionId! }, guard: seed(cwd, grant) });
		await new Promise((resolve) => setTimeout(resolve, 700));
		const before = lines(model.requests).length;
		const impostor = await runner({ cwd, prompt: "PROMPT-IMPOSTOR", timeoutMs: 20_000, hop: 1, kind: "held", sessionFile: file, sessionId: first.sessionId! });
		const done = await seated;
		assert.equal(impostor.guard, undefined, "the held turn has no seat");
		const toolResults = lines(model.requests).slice(before).flatMap((r: any) => r.messages).filter((m: any) => m.role === "tool").map((m: any) => JSON.stringify(m.content));
		assert.ok(toolResults.some((c: string) => /This run is unattended/.test(c)), "its call is refused as a run with no seat");
		assert.deepEqual(done.guard, { grant_used: false, asked: [] }, "the seated run's grant is not spent by another session");
		assert.equal(inbox.list().length, 1, "and nothing is filed in its lane");
	} finally {
		model.fake.kill();
	}
});

test("[review-F3] a run with a seat gets no tool its cap leaves out, whatever the request asks for", { timeout: 30_000 }, async () => {
	const root = tmp("pi-loops-cap-");
	const cwd = path.join(root, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const model = await standIn(root, [{ match: "PROMPT-CAP", tool: "bash", args: { command: PUSH } }]);
	try {
		const capOf = (over: Partial<ResolvedCap>): ResolvedCap => ({ ...resolveCap({ cwd }, 20_000), ...over });
		const cases: Array<[string, Partial<SubagentRequest>, GuardSeed["cap"]]> = [
			["no tools asked, the cap names read", {}, capOf({ tools: ["read"] })],
			["bash asked, the cap names read", { tools: ["read", "bash"] }, capOf({ tools: ["read"] })],
			["bash asked, the cap's built-ins are read", { tools: ["read", "bash"] }, capOf({ builtinTools: ["read"] })],
			["built-ins asked, the cap's built-ins are read", { builtinTools: ["read", "bash"] }, capOf({ builtinTools: ["read"] })],
			["bash asked, the session's tools within read and grep", { tools: ["read", "bash"] }, capOf({ tools: { within: ["read", "grep"] } })],
			["the session's built-ins within read and grep", {}, capOf({ builtinTools: { within: ["read", "grep"] } })],
		];
		for (const [name, asked, cap] of cases) {
			const { runner, inbox } = guardedRunner(path.join(root, name.replace(/\W+/g, "-")), model);
			const before = fs.existsSync(model.requests) ? lines(model.requests).length : 0;
			const result = await runner({ cwd, prompt: "PROMPT-CAP push it", timeoutMs: 20_000, hop: 1, kind: "loop", sessionDir: path.join(root, "sessions"), ...asked, guard: { ...seed(cwd), cap } } as SubagentRequest);
			const offered = (lines(model.requests)[before].tools ?? []).map((t: any) => t.function?.name);
			assert.ok(offered.includes("read"), `${name}: the cap's tool is there (${offered})`);
			assert.equal(offered.includes("bash"), false, `${name}: the model is not offered bash (${offered})`);
			assert.equal(offered.includes("grep"), false, `${name}: a within names grep, which the session does not give, and does not add it (${offered})`);
			assert.deepEqual([result.guard?.asked, inbox.list().length], [[], 0], `${name}: nothing reaches the guard to ask about`);
		}
	} finally {
		model.fake.kill();
	}
});

test("[resume-swap] a resume whose file became a symlink, or opens as another session, is refused before any prompt and writes to no file", { timeout: 30_000 }, async () => {
	const root = tmp("pi-loops-swap-");
	const cwd = path.join(root, "proj");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(cwd, { recursive: true });
	const model = await standIn(root, [{ match: "PROMPT-SWAP", tool: "bash", args: { command: "echo hi" } }]);
	try {
		const { runner } = guardedRunner(root, model);
		const a = await runner({ cwd, prompt: "PROMPT-ONE the lane's run", timeoutMs: 20_000, hop: 1, kind: "loop", sessionDir, guard: seed(cwd) });
		const other = await runner({ cwd, prompt: "PROMPT-ONE another conversation", timeoutMs: 20_000, hop: 1, kind: "loop", sessionDir: path.join(root, "elsewhere"), guard: seed(cwd) });
		const copy = path.join(root, "elsewhere", "copy-of-a.jsonl");
		fs.copyFileSync(a.sessionFile!, copy);
		const cases: Array<[string, string, RegExp]> = [
			["a symlink to another conversation", path.join(sessionDir, "link-other.jsonl"), /no longer a regular file/],
			["a symlink to a copy of the lane's own session, outside the lane", path.join(sessionDir, "link-copy.jsonl"), /no longer a regular file/],
			["a regular file that opens as another session", other.sessionFile!, /opened as another session/],
		];
		fs.symlinkSync(other.sessionFile!, cases[0][1]);
		fs.symlinkSync(copy, cases[1][1]);
		for (const [name, file, why] of cases) {
			const sizes = [a.sessionFile!, other.sessionFile!, copy].map((f) => fs.statSync(f).size);
			const before = lines(model.requests).length;
			const out = await runner({ cwd, prompt: "PROMPT-SWAP a person said yes", timeoutMs: 20_000, hop: 1, kind: "loop", resume: { file, sessionId: a.sessionId! }, guard: seed(cwd) });
			assert.equal(out.ok, false, name);
			assert.match(out.errorMessage ?? "", why, name);
			assert.equal(lines(model.requests).length, before, `${name}: no prompt reached the model`);
			assert.deepEqual([a.sessionFile!, other.sessionFile!, copy].map((f) => fs.statSync(f).size), sizes, `${name}: no file was written`);
		}
	} finally {
		model.fake.kill();
	}
});
