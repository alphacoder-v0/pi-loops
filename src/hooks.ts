/**
 * Lifecycle hooks: user-configured shell commands and JSON
 * webhooks that fire on agent events. Best-effort side effects: they never mutate
 * agent state and failures never fail a turn.
 *
 *   ~/.pi/agent/loops/hooks.toml      user hooks (top-level `allow_project_hooks = true` opts project hooks in)
 *   <project>/.pi/hooks.toml          project hooks (ignored unless allowed)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envFlag } from "./config.ts";
import { previewRedacted } from "./redact.ts";
import { parseToml } from "./toml.ts";
import { PI_LOOPS_VERSION } from "./version.ts";

/**
 * `run_start` / `run_end` exist because a scheduled run is not a turn. A run can happen with no
 * conversation at all (the headless host) or beside one (a loop firing while you are typing), so
 * overloading `agent_*` would mean a rule written about your own turns quietly started firing for
 * automation too. A run gets its own pair, and `agent_*` keeps meaning what its author thought it
 * meant.
 */
export const HOOK_EVENTS = ["agent_start", "agent_end", "run_start", "run_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_start", "tool_update", "tool_end", "compaction"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_SUMMARY_CHARS = 2000;
/** What a hook may put in the log per run. The same bound stderr has used for the failure message. */
const MAX_OUTPUT_CHARS = 4000;

export interface HookConfig {
	event: HookEvent;
	command?: string;
	webhook?: string;
	timeoutMs: number;
	/**
	 * Where the command runs. `loops` is the pi-loops data directory. `pie` is an older name for
	 * that same directory, still accepted because it is written in `hooks.toml` files that already
	 * exist: a hook which silently starts running somewhere else is worse than an odd spelling.
	 */
	cwd: "project" | "loops" | "pie" | "home";
	onFailure: "warn" | "ignore";
	tool?: string;
	headers?: Record<string, string>;
	source: "user" | "project";
}

/** The payload (webhook body and `$PI_HOOK_PAYLOAD` file). */
export interface HookPayload {
	event: HookEvent;
	session_id: string;
	cwd: string;
	model_provider: string;
	model_id: string;
	thinking_level: string;
	source?: "user" | "project";
	message_kind?: string | null;
	message_summary?: string | null;
	assistant_event?: string | null;
	tool_call_id?: string | null;
	tool_name?: string | null;
	tool_is_error?: boolean | null;
	tool_args?: unknown | null;
	tool_result_summary?: string | null;
	compaction_trigger?: "auto" | "manual" | null;
	compaction_tokens_before?: number | null;
	compaction_summary?: string | null;
	/** `run_start` / `run_end`: which job, and how it went. Null for every other event. */
	run_job?: string | null;
	run_id?: string | null;
	run_ok?: boolean | null;
	run_findings?: number | null;
	run_error?: string | null;
	run_cost_usd?: number | null;
	/**
	 * pi also reports a compaction that failed or was cancelled, and that
	 * is the case a watcher most wants — a session that cannot compact is a session about to fail
	 * on context length. It reaches the same `compaction` hook with this set, and no summary.
	 */
	compaction_failed?: boolean | null;
}

/** Event-specific fields; the runner fills in the session-level ones. */
export type HookEventData = Pick<HookPayload, "event" | "message_kind" | "message_summary" | "assistant_event" | "tool_call_id" | "tool_name" | "tool_is_error" | "tool_args" | "tool_result_summary" | "compaction_trigger" | "compaction_tokens_before" | "compaction_summary" | "compaction_failed" | "run_job" | "run_id" | "run_ok" | "run_findings" | "run_error" | "run_cost_usd">;

export interface ParsedHooksFile {
	allowProjectHooks: boolean;
	hooks: HookConfig[];
	diagnostics: string[];
}

/** Bad rules are skipped with a diagnostic, the rest still load. */
export function parseHooksToml(text: string, source: "user" | "project"): ParsedHooksFile {
	const doc = parseToml(text);
	const out: ParsedHooksFile = { allowProjectHooks: doc.allow_project_hooks === true, hooks: [], diagnostics: [] };
	const hooks = Array.isArray(doc.hook) ? (doc.hook as any[]) : [];
	hooks.forEach((h, i) => {
		if (h?.enabled === false) return;
		if (!h || typeof h.event !== "string" || !(HOOK_EVENTS as readonly string[]).includes(h.event)) {
			out.diagnostics.push(`hooks ${source}: hook #${i + 1} has unknown event ${JSON.stringify(h?.event)}`);
			return;
		}
		const command = typeof h.command === "string" && h.command.trim() ? h.command : undefined;
		const webhook = typeof h.webhook === "string" ? h.webhook : undefined;
		if (!command && !webhook) {
			out.diagnostics.push(`hooks ${source}: hook #${i + 1} has neither command nor webhook`);
			return;
		}
		const cwd = h.cwd ?? "project";
		if (!["project", "loops", "pie", "home"].includes(cwd)) {
			out.diagnostics.push(`hooks ${source}: hook #${i + 1} has invalid cwd ${JSON.stringify(h.cwd)} (project | loops | home)`);
			return;
		}
		out.hooks.push({
			event: h.event,
			command,
			webhook,
			timeoutMs: typeof h.timeout_ms === "number" ? h.timeout_ms : DEFAULT_TIMEOUT_MS,
			cwd,
			onFailure: h.on_failure === "ignore" ? "ignore" : "warn",
			tool: typeof h.tool === "string" ? h.tool : undefined,
			headers: h.headers && typeof h.headers === "object" ? Object.fromEntries(Object.entries(h.headers).map(([k, v]) => [k, String(v)])) : undefined,
			source,
		});
	});
	return out;
}

export interface HookRunnerOptions {
	loopsDir: string;
	projectCwd: string;
	/** From config.toml; the user hooks.toml's own `allow_project_hooks` and PI_/PIE_ALLOW_PROJECT_HOOKS also count. */
	allowProjectHooks?: boolean;
	warn: (message: string) => void;
	/**
	 * Where a hook's own output goes (the per-process log, `logs/pi-<pid>.log`). Without it the
	 * usual debugging move — echo something and look at it — has nowhere to land, and that file is
	 * already the answer to "what did my automation do last night".
	 */
	log?: (message: string) => void;
	getSession: () => { sessionId?: string; cwd: string; model?: string; thinking?: string };
}

export class HookRunner {
	readonly hooks: HookConfig[] = [];
	readonly diagnostics: string[] = [];
	private readonly opts: HookRunnerOptions;
	/** Hooks run in event order, one rule at a time — but never block the agent. */
	private queue: Promise<void> = Promise.resolve();

	constructor(opts: HookRunnerOptions) {
		this.opts = opts;
	}

	load(): void {
		this.hooks.length = 0;
		this.diagnostics.length = 0;
		const userFile = path.join(this.opts.loopsDir, "hooks.toml");
		// `.pie/` is an older name for the project config directory, still read so a project already
		// carrying one needs no second copy. The `.pi/` path is the one reported when neither exists.
		const projectFile = [path.join(this.opts.projectCwd, ".pi", "hooks.toml"), path.join(this.opts.projectCwd, ".pie", "hooks.toml")].find((file) => fs.existsSync(file)) ?? path.join(this.opts.projectCwd, ".pi", "hooks.toml");
		const user = this.readFile(userFile, "user");
		const allowProject = envFlag("ALLOW_PROJECT_HOOKS") || !!this.opts.allowProjectHooks || !!user?.allowProjectHooks;
		if (user) this.hooks.push(...user.hooks);
		if (fs.existsSync(projectFile)) {
			if (allowProject) {
				const project = this.readFile(projectFile, "project");
				if (project) this.hooks.push(...project.hooks);
			} else {
				this.diagnostics.push(`project hooks ignored at ${projectFile}; set allow_project_hooks = true in ${userFile} or PI_ALLOW_PROJECT_HOOKS=1`);
			}
		}
	}

	private readFile(file: string, source: "user" | "project"): ParsedHooksFile | undefined {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (err: any) {
			if (err?.code !== "ENOENT") this.diagnostics.push(`hooks ${source}: read ${file} failed: ${err?.message ?? err}`);
			return undefined;
		}
		try {
			const parsed = parseHooksToml(text, source);
			this.diagnostics.push(...parsed.diagnostics);
			return parsed;
		} catch (err: any) {
			this.diagnostics.push(`hooks ${source}: parse ${file} failed: ${err?.message ?? err}`);
			return undefined;
		}
	}

	hasHooksFor(event: HookEvent): boolean {
		return this.hooks.some((h) => h.event === event);
	}

	/** Wait for queued hooks to finish; bounded so quitting never hangs. */
	async drain(timeoutMs = 3000): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<false>((r) => {
			timer = setTimeout(() => r(false), timeoutMs);
		});
		const done = this.queue.then(() => true as const, () => true as const);
		const result = await Promise.race([done, timeout]);
		if (timer) clearTimeout(timer);
		return result;
	}

	/** Queue every matching rule for this event. Returns when they have all run (tests await it; callers may not). */
	fire(data: HookEventData, signal?: AbortSignal): Promise<void> {
		const matching = this.hooks.filter((h) => h.event === data.event && (!h.tool || h.tool === data.tool_name));
		if (!matching.length) return this.queue;
		const run = async () => {
			for (const h of matching) {
				if (signal?.aborted) return;
				try {
					// Inside the try: building the payload reads the session and the event, and a throw
					// here would reject the shared queue promise — which callers deliberately do not
					// await, so it would surface as an unhandled rejection and take pi down.
					const payload = this.payloadFor(h, data);
					await this.runRule(h, payload, signal);
				} catch (err: any) {
					if (h.onFailure === "warn") this.opts.warn(`hook ${h.source} ${h.event}${h.tool ? ` (tool=${h.tool})` : ""} failed: ${previewRedacted(err?.message ?? String(err), 300)}`);
				}
			}
		};
		this.queue = this.queue.then(run, run);
		return this.queue;
	}

	/** Every payload field is serialized; absent optionals are `null`, never omitted. */
	private payloadFor(h: HookConfig, data: HookEventData): HookPayload {
		const s = this.opts.getSession();
		const [provider, ...rest] = (s.model ?? "").split("/");
		return {
			event: data.event,
			session_id: s.sessionId ?? "",
			cwd: s.cwd,
			model_provider: s.model ? provider : "",
			model_id: s.model ? rest.join("/") : "",
			thinking_level: s.thinking ?? "off",
			source: h.source,
			message_kind: data.message_kind ?? null,
			message_summary: data.message_summary ?? null,
			assistant_event: data.assistant_event ?? null,
			tool_call_id: data.tool_call_id ?? null,
			tool_name: data.tool_name ?? null,
			tool_is_error: data.tool_is_error ?? null,
			tool_args: data.tool_args ?? null,
			tool_result_summary: data.tool_result_summary ?? null,
			compaction_trigger: data.compaction_trigger ?? null,
			compaction_tokens_before: data.compaction_tokens_before ?? null,
			compaction_summary: data.compaction_summary ?? null,
			compaction_failed: data.compaction_failed ?? null,
			run_job: data.run_job ?? null,
			run_id: data.run_id ?? null,
			run_ok: data.run_ok ?? null,
			run_findings: data.run_findings ?? null,
			run_error: data.run_error ?? null,
			run_cost_usd: data.run_cost_usd ?? null,
		};
	}

	private resolveCwd(h: HookConfig): string {
		if (h.cwd === "home") return os.homedir();
		if (h.cwd === "loops" || h.cwd === "pie") return this.opts.loopsDir;
		return this.opts.projectCwd;
	}

	private async runRule(h: HookConfig, payload: HookPayload, signal?: AbortSignal): Promise<void> {
		const json = JSON.stringify(payload);
		const dir = path.join(os.tmpdir(), "pi-hooks");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const payloadFile = path.join(dir, `${randomUUID()}.json`);
		fs.writeFileSync(payloadFile, json, { mode: 0o600 });
		try {
			if (h.command) await this.runCommand(h, payload, payloadFile, signal);
			if (h.webhook) await this.postWebhook(h, json, signal);
		} finally {
			fs.rmSync(payloadFile, { force: true });
		}
	}

	private runCommand(h: HookConfig, payload: HookPayload, payloadFile: string, signal?: AbortSignal): Promise<void> {
		const vars: Record<string, string | null | undefined> = {
			HOOK_EVENT: payload.event,
			HOOK_PAYLOAD: payloadFile,
			SESSION_ID: payload.session_id,
			CWD: payload.cwd,
			MODEL_PROVIDER: payload.model_provider,
			MODEL_ID: payload.model_id,
			THINKING_LEVEL: payload.thinking_level,
			MESSAGE_KIND: payload.message_kind,
			ASSISTANT_EVENT: payload.assistant_event,
			TOOL_CALL_ID: payload.tool_call_id,
			TOOL_NAME: payload.tool_name,
			TOOL_IS_ERROR: payload.tool_is_error == null ? undefined : String(payload.tool_is_error),
			COMPACTION_TRIGGER: payload.compaction_trigger,
			COMPACTION_TOKENS_BEFORE: payload.compaction_tokens_before == null ? undefined : String(payload.compaction_tokens_before),
			COMPACTION_FAILED: payload.compaction_failed == null ? undefined : String(payload.compaction_failed),
			RUN_JOB: payload.run_job,
			RUN_ID: payload.run_id,
			// A string, because `[ "$PI_RUN_OK" = false ]` is the shape a shell hook will be written in.
			RUN_OK: payload.run_ok == null ? undefined : String(payload.run_ok),
			RUN_FINDINGS: payload.run_findings == null ? undefined : String(payload.run_findings),
			RUN_ERROR: payload.run_error,
			RUN_COST_USD: payload.run_cost_usd == null ? undefined : String(payload.run_cost_usd),
		};
		// Environment variables exist only when they have a value; the JSON payload carries nulls.
		const env: Record<string, string> = { ...(process.env as Record<string, string>) };
		for (const [key, value] of Object.entries(vars)) {
			if (value == null) continue;
			env[`PI_${key}`] = value;
			env[`PIE_${key}`] = value; // an older prefix, still set so hooks already written against it keep working
		}
		const isWin = process.platform === "win32";
		return new Promise<void>((resolve, reject) => {
			// Own process group (setsid equivalent) so a timeout kills the whole tree, not just `sh`.
			// stdout is piped only when there is somewhere to put it; otherwise it goes to /dev/null as before.
			const proc = spawn(isWin ? "cmd" : "sh", [isWin ? "/C" : "-c", h.command!], { cwd: this.resolveCwd(h), env, stdio: ["ignore", this.opts.log ? "pipe" : "ignore", "pipe"], detached: !isWin });
			let stderr = "";
			proc.stderr?.on("data", (d) => {
				if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString();
			});
			// What the hook itself printed. Bounded: a hook that prints a megabyte would otherwise put
			// a megabyte in the log and rotate away everything the automation had recorded before it.
			let stdout = "";
			let overflowed = false;
			proc.stdout?.on("data", (d) => {
				if (stdout.length >= MAX_OUTPUT_CHARS) overflowed = true;
				else stdout += d.toString();
			});
			const logOutput = () => {
				const text = stdout.trim();
				if (!text) return; // a silent hook stays silent
				const capped = overflowed || text.length > MAX_OUTPUT_CHARS;
				this.opts.log?.(`hook ${h.source} ${h.event}${h.tool ? ` (tool=${h.tool})` : ""}: ${capped ? `${text.slice(0, MAX_OUTPUT_CHARS)}… (output truncated)` : text}`);
			};
			const killTree = () => {
				try {
					if (!isWin && proc.pid) process.kill(-proc.pid, "SIGKILL");
					else proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			};
			let done = false;
			const finish = (err?: Error) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				err ? reject(err) : resolve();
			};
			const timer = setTimeout(() => {
				killTree();
				finish(new Error(`timed out after ${h.timeoutMs}ms`));
			}, h.timeoutMs);
			const onAbort = () => {
				killTree();
				finish(new Error("cancelled"));
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			proc.on("error", (err) => finish(new Error(`spawn: ${err.message}`)));
			proc.on("close", (code) => {
				// Also on a timeout or an abort, where `finish` has already rejected: what the hook
				// managed to say before it was killed is exactly what the reader needs.
				logOutput();
				if (code === 0) finish();
				else finish(new Error(`command exited ${code ?? -1}: ${stderr.trim()}`));
			});
		});
	}

	private async postWebhook(h: HookConfig, json: string, signal?: AbortSignal): Promise<void> {
		const signals = [AbortSignal.timeout(h.timeoutMs), ...(signal ? [signal] : [])];
		const res = await fetch(h.webhook!, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": `pi-loops/${PI_LOOPS_VERSION}`, ...(h.headers ?? {}) },
			body: json,
			signal: AbortSignal.any(signals),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`webhook status ${res.status}: ${Array.from(text).slice(0, 500).join("")}`);
		}
	}
}

/* ------------------------------------------------ pi event → payload data */

export function truncateSummary(text: string): string {
	const chars = Array.from(text);
	return chars.length <= MAX_SUMMARY_CHARS ? text : `${chars.slice(0, MAX_SUMMARY_CHARS).join("")}…`;
}

/** `message_kind`: user | assistant | tool_result | <custom role> (pi: the message's customType). */
export function messageKind(msg: any): string | undefined {
	const role = msg?.role;
	if (typeof role !== "string") return undefined;
	if (role === "toolResult") return "tool_result";
	if (role === "custom" && typeof msg.customType === "string" && msg.customType) return msg.customType;
	return role;
}

/** `message_summary`: text joined with placeholders for thinking / tool calls / images, truncated. */
export function messageSummary(msg: any): string | undefined {
	if (!msg) return undefined;
	const content = msg.content;
	if (typeof content === "string") return truncateSummary(content);
	if (!Array.isArray(content)) return truncateSummary(typeof msg === "object" ? JSON.stringify(msg.payload ?? msg.details ?? "") : "");
	return truncateSummary(
		content
			.map((b: any) => {
				switch (b?.type) {
					case "text":
						return b.text ?? "";
					case "thinking":
						return "<thinking>";
					case "toolCall":
						return `<tool_call ${b.name ?? ""}>`;
					case "image":
						return `<image ${b.mimeType ?? b.mime_type ?? ""}>`;
					default:
						return "";
				}
			})
			.join("\n"),
	);
}

/** `result_summary` for tool results / partial results. */
export function resultSummary(result: any): string | undefined {
	if (result === undefined || result === null) return undefined;
	if (typeof result === "string") return truncateSummary(result);
	const content = Array.isArray(result?.content) ? result.content : Array.isArray(result) ? result : undefined;
	if (!content) return truncateSummary(typeof result === "object" ? JSON.stringify(result) : String(result));
	return truncateSummary(content.map((b: any) => (b?.type === "text" ? (b.text ?? "") : b?.type === "image" ? `<image ${b.mimeType ?? ""}>` : "")).join("\n"));
}
