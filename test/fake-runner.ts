// Fake SubagentRunner for tests: replies from FAKE_PI_REPLY (checker: FAKE_PI_CHECKER_REPLY),
// fails with FAKE_PI_FAIL / FAKE_PI_CHECKER_FAIL, sleeps FAKE_PI_SLEEP seconds (honouring the
// request timeout and abort signal), writes the prompt to FAKE_PI_PROMPT_FILE, and keeps a
// pi-style session file in `sessionDir` so transcript features can be tested. Records every request.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunnerResult, SubagentRequest, SubagentRunner } from "../src/runner.ts";

export interface FakeRunner extends SubagentRunner {
	calls: SubagentRequest[];
}

const DEFAULT_REPLY = "ok <inbox>something new</inbox> <loop-state>seen: 1</loop-state>";

export function fakeRunner(): FakeRunner {
	const calls: SubagentRequest[] = [];
	const run = async (req: SubagentRequest): Promise<RunnerResult> => {
		calls.push(req);
		if (process.env.FAKE_PI_PROMPT_FILE) fs.writeFileSync(process.env.FAKE_PI_PROMPT_FILE, req.prompt);
		const checker = req.kind === "checker";
		const usage = { input: 10, output: 5, cost: 0.001, turns: 1 };
		if (checker ? process.env.FAKE_PI_CHECKER_FAIL : process.env.FAKE_PI_FAIL) {
			return { ok: false, exitCode: checker ? 4 : 3, timedOut: false, text: "", errorMessage: checker ? "checker boom" : "boom", usage: { input: 0, output: 0, cost: 0, turns: 0 } };
		}
		const sleepMs = Number(process.env.FAKE_PI_SLEEP ?? 0) * 1000;
		if (sleepMs > 0) {
			const wait = Math.min(sleepMs, req.timeoutMs);
			await new Promise<void>((r) => {
				const t = setTimeout(r, wait);
				req.signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
			});
			if (req.signal?.aborted) return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "aborted", stopReason: "aborted", usage: { input: 0, output: 0, cost: 0, turns: 0 } };
			if (sleepMs > req.timeoutMs) return { ok: false, exitCode: 1, timedOut: true, text: "", errorMessage: `timed out after ${Math.round(req.timeoutMs / 1000)}s`, usage: { input: 0, output: 0, cost: 0, turns: 0 } };
		}
		const reply = checker ? (process.env.FAKE_PI_CHECKER_REPLY ?? process.env.FAKE_PI_REPLY ?? DEFAULT_REPLY) : (process.env.FAKE_PI_REPLY ?? DEFAULT_REPLY);
		const sessionId = randomUUID();
		let sessionFile: string | undefined;
		if (req.sessionDir) {
			fs.mkdirSync(req.sessionDir, { recursive: true });
			sessionFile = path.join(req.sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
			const asst = { role: "assistant", model: "fake/model", stopReason: "stop", usage: { input: 10, output: 5, cost: { total: 0.001 } }, content: [{ type: "text", text: reply }] };
			fs.writeFileSync(sessionFile, [
				JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: req.cwd }),
				JSON.stringify({ type: "message", id: "a", message: { role: "user", content: req.prompt } }),
				JSON.stringify({ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls src" } }] } }),
				JSON.stringify({ type: "message", id: "c", parentId: "b", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "a.ts\nb.ts" }] } }),
				JSON.stringify({ type: "message", id: "d", parentId: "c", message: asst }),
			].join("\n") + "\n");
		}
		return { ok: true, exitCode: 0, timedOut: false, text: reply, model: "fake/model", stopReason: "stop", usage, sessionId, sessionFile };
	};
	return Object.assign(run, { calls });
}
