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
