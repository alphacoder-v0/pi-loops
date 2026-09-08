/**
 * Runs one loop iteration in a fresh `pi` process (`pi -p --mode json --no-session`).
 * Fresh context in, final assistant text out — the pie "SubAgent" delivery, only the
 * isolation boundary is a process instead of a task. The child inherits the parent's
 * model/thinking unless the job overrides them, and sees PI_LOOPS_CHILD=1 so its own
 * copy of this extension stays dormant.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RunnerOptions {
	cwd: string;
	prompt: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	timeoutMs: number;
	env?: Record<string, string>;
	signal?: AbortSignal;
	/** Override the pi executable (tests use a fake). */
	piBin?: string;
	/** Keep the child's transcript here (`--session-dir`); omit for an ephemeral run. */
	sessionDir?: string;
}

export interface RunnerUsage {
	input: number;
	output: number;
	cost: number;
	turns: number;
}

export interface RunnerResult {
	ok: boolean;
	exitCode: number;
	timedOut: boolean;
	/** Final assistant text (last assistant message with text content). */
	text: string;
	stderr: string;
	errorMessage?: string;
	stopReason?: string;
	model?: string;
	usage: RunnerUsage;
	sessionId?: string;
	/** Transcript file when `sessionDir` was given and the child wrote one. */
	sessionFile?: string;
}

/** Same resolution the bundled subagent example uses: re-run whatever launched us. */
export function resolvePiInvocation(args: string[], piBin?: string): { command: string; args: string[] } {
	if (piBin) return { command: piBin, args };
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	// Only re-run argv[1] when it plausibly is pi itself (avoids recursion when this
	// module is driven from an unrelated node script).
	const looksLikePi = !!currentScript && /pi-coding-agent|(^|[\/])(pi|cli\.(js|mjs))$/.test(currentScript);
	if (currentScript && !isBunVirtual && looksLikePi && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** pi names session files `<timestamp>_<sessionId>.jsonl` inside the session dir. */
export function findSessionFile(sessionDir: string, sessionId: string): string | undefined {
	try {
		const hit = fs.readdirSync(sessionDir).find((f) => f.endsWith(`_${sessionId}.jsonl`) || f === `${sessionId}.jsonl`);
		return hit ? path.join(sessionDir, hit) : undefined;
	} catch {
		return undefined;
	}
}

export function buildPiArgs(opts: RunnerOptions): string[] {
	const args = ["-p", "--mode", "json"];
	if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
	else args.push("--no-session");
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
	args.push("--", opts.prompt);
	return args;
}

export function runPiSubagent(opts: RunnerOptions): Promise<RunnerResult> {
	const result: RunnerResult = {
		ok: false,
		exitCode: -1,
		timedOut: false,
		text: "",
		stderr: "",
		usage: { input: 0, output: 0, cost: 0, turns: 0 },
	};
	const invocation = resolvePiInvocation(buildPiArgs(opts), opts.piBin ?? process.env.PI_LOOPS_PI_BIN);

	return new Promise<RunnerResult>((resolve) => {
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			result.exitCode = code;
			result.ok = code === 0 && !result.timedOut && result.stopReason !== "error" && result.stopReason !== "aborted";
			if (!result.ok && !result.errorMessage) {
				result.errorMessage = result.timedOut
					? `timed out after ${Math.round(opts.timeoutMs / 1000)}s`
					: result.stderr.trim().split("\n").slice(-3).join("\n") || `pi exited with code ${code}`;
			}
			resolve(result);
		};

		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_LOOPS_CHILD: "1", ...(opts.env ?? {}) },
			});
		} catch (err: any) {
			result.errorMessage = `failed to spawn pi: ${err?.message ?? err}`;
			resolve({ ...result, exitCode: 1 });
			return;
		}

		const kill = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, 5000).unref();
		};
		const timer = setTimeout(() => {
			result.timedOut = true;
			kill();
		}, opts.timeoutMs);
		timer.unref();
		if (opts.signal) {
			const onAbort = () => {
				result.stopReason = "aborted";
				kill();
			};
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event?.type === "session" && typeof event.id === "string") {
				result.sessionId = event.id;
				return;
			}
			if (event?.type !== "message_end" || !event.message) return;
			const msg = event.message;
			if (msg.role !== "assistant") return;
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cost += usage.cost?.total || 0;
			}
			if (msg.model && !result.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
			const text = Array.isArray(msg.content)
				? msg.content
						.filter((p: any) => p?.type === "text" && typeof p.text === "string")
						.map((p: any) => p.text)
						.join("\n")
				: "";
			if (text.trim()) result.text = text;
		};

		proc.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data) => {
			if (result.stderr.length < 64_000) result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			if (opts.sessionDir && result.sessionId) result.sessionFile = findSessionFile(opts.sessionDir, result.sessionId);
			finish(code ?? 1);
		});
		proc.on("error", (err) => {
			result.errorMessage = `failed to spawn pi: ${err.message}`;
			finish(1);
		});
	});
}
