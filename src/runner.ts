/**
 * Sub-agent runs — pie's `SubAgent` delivery. A run is a fresh conversation (no parent history)
 * with the parent's tools, model and skills, executed by a `SubagentRunner`. The production
 * runner (`sdk-runner.ts`) opens the conversation *inside the interactive pi process* through
 * pi's SDK, exactly like pie's in-process sub-agents, so the parent's live MCP servers, `-e`
 * extensions and system prompt are shared. Tests inject a fake runner.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface RunnerUsage {
	input: number;
	output: number;
	/** Cached prompt tokens (pi bills them differently from `input`); optional — a fake runner may omit them. */
	cacheRead?: number;
	cacheWrite?: number;
	cost: number;
	turns: number;
}

export interface RunnerResult {
	ok: boolean;
	timedOut: boolean;
	/** Final assistant text (last assistant message with text content). */
	text: string;
	errorMessage?: string;
	stopReason?: string;
	/**
	 * The run finished, but not as configured — a pinned model that no longer resolves, say. Kept
	 * apart from `errorMessage` so a self-healed run is not reported as a failure.
	 */
	warning?: string;
	model?: string;
	/** What the run had to do to get through: silent provider retries and context compactions. */
	retries?: number;
	compactions?: number;
	usage: RunnerUsage;
	sessionId?: string;
	/** Transcript file when `sessionDir` was given. */
	sessionFile?: string;
	/** Kept for run records: 0 on success, 1 on failure (there is no child process any more). */
	exitCode?: number;
}

export interface SubagentRequest {
	cwd: string;
	prompt: string;
	/** "provider/id"; undefined → the interactive session's current model. */
	model?: string;
	thinking?: string;
	/** Allowlist of tool names (built-in, MCP and automation tools alike). */
	tools?: string[];
	timeoutMs: number;
	signal?: AbortSignal;
	/** Keep the transcript here (a pi session file); omit for an in-memory run. */
	sessionDir?: string;
	/** Trigger hop: 1 for a sub-agent of the interactive pi (pie's cycle suppression). */
	hop: number;
	/** The interactive session this run acts for; plain cron jobs it schedules bind to it. */
	parentSessionId?: string;
	parentCwd?: string;
	kind: "loop" | "checker" | "trigger";
	jobId?: string;
	runId?: string;
	traceId?: string;
}

export type SubagentRunner = (req: SubagentRequest) => Promise<RunnerResult>;

export function failedRun(message: string, extra: Partial<RunnerResult> = {}): RunnerResult {
	return { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: message, usage: { input: 0, output: 0, cost: 0, turns: 0 }, ...extra };
}

/* ------------------------------------------- the parent's runtime shape */

/** What the interactive pi was started with that a sub-agent should share (pie: the parent harness). */
export interface ParentRuntimeFlags {
	extensionPaths: string[];
	skillPaths: string[];
	promptTemplatePaths: string[];
	appendSystemPrompt: string[];
	systemPrompt?: string;
	noSkills: boolean;
	noExtensions: boolean;
	noContextFiles: boolean;
	noPromptTemplates: boolean;
}

/**
 * A sub-agent may run in another project's cwd, and pi resolves `-e ./ext.ts` against its cwd
 * and loads explicit `-e` paths regardless of trust — so a relative path is pinned to the
 * parent's cwd here, or a same-named file in an untrusted project would be executed. Package
 * specs (`npm:…`, `git:…`, bare names) are left alone.
 */
export function absolutizeFlagValue(value: string, parentCwd: string): string {
	if (/^(npm|git|https?|file):/.test(value)) return value;
	if (value.startsWith("~/")) return path.join(process.env.HOME ?? "", value.slice(2));
	if (value.startsWith("./") || value.startsWith("../") || value.includes("/") || value === "." || value === "..") return path.resolve(parentCwd, value);
	if (fs.existsSync(path.resolve(parentCwd, value))) return path.resolve(parentCwd, value);
	return value;
}

/** Parse the parent pi's argv for the flags a sub-agent inherits. Secrets, identity, mode and tool selection stay with the job. */
export function parentRuntimeFlags(argv: string[], parentCwd = process.cwd()): ParentRuntimeFlags {
	const out: ParentRuntimeFlags = { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], appendSystemPrompt: [], noSkills: false, noExtensions: false, noContextFiles: false, noPromptTemplates: false };
	const valued = new Set(["-e", "--extension", "--skill", "--prompt-template", "--append-system-prompt", "--system-prompt"]);
	const skipValued = new Set(["--api-key", "--provider", "--model", "--thinking", "--session", "--session-id", "--session-dir", "--fork", "--name", "-n", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--mode", "--export", "--list-models", "--tui-mode", "--use-theme", "--theme", "--trigger-poll-secs"]);
	const take = (flag: string, value: string) => {
		switch (flag) {
			case "-e":
			case "--extension":
				out.extensionPaths.push(absolutizeFlagValue(value, parentCwd));
				break;
			case "--skill":
				out.skillPaths.push(absolutizeFlagValue(value, parentCwd));
				break;
			case "--prompt-template":
				out.promptTemplatePaths.push(absolutizeFlagValue(value, parentCwd));
				break;
			case "--append-system-prompt":
				out.appendSystemPrompt.push(value);
				break;
			case "--system-prompt":
				out.systemPrompt = value;
				break;
		}
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") break;
		if (valued.has(a)) {
			if (i + 1 < argv.length) take(a, argv[++i]);
		} else if (a === "--no-skills" || a === "-ns") out.noSkills = true;
		else if (a === "--no-extensions" || a === "-ne") out.noExtensions = true;
		else if (a === "--no-context-files" || a === "-nc") out.noContextFiles = true;
		else if (a === "--no-prompt-templates" || a === "-np") out.noPromptTemplates = true;
		else if (skipValued.has(a)) i++;
		else if (a.startsWith("--") && a.includes("=")) {
			const [k, v] = a.split(/=(.*)/s);
			if (valued.has(k)) take(k, v);
		}
	}
	return out;
}
