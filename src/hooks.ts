/**
 * Lifecycle hooks — pie's `hooks.rs`: user-configured shell commands and JSON
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
import { previewRedacted } from "./redact.ts";
import { parseToml } from "./toml.ts";
import { PI_LOOPS_VERSION } from "./version.ts";

export const HOOK_EVENTS = ["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_start", "tool_update", "tool_end", "compaction"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_SUMMARY_CHARS = 2000;

export interface HookConfig {
	event: HookEvent;
	command?: string;
	webhook?: string;
	timeoutMs: number;
	cwd: "project" | "pie" | "home";
	onFailure: "warn" | "ignore";
	tool?: string;
	headers?: Record<string, string>;
	source: "user" | "project";
}

/** Same field set and names as pie's `HookPayload` (webhook body and `$PI_HOOK_PAYLOAD` file). */
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
}

/** Event-specific fields; the runner fills in the session-level ones. */
export type HookEventData = Pick<HookPayload, "event" | "message_kind" | "message_summary" | "assistant_event" | "tool_call_id" | "tool_name" | "tool_is_error" | "tool_args" | "tool_result_summary" | "compaction_trigger" | "compaction_tokens_before" | "compaction_summary">;

export interface ParsedHooksFile {
	allowProjectHooks: boolean;
	hooks: HookConfig[];
	diagnostics: string[];
}

/** pie's `push_rules`: bad rules are skipped with a diagnostic, the rest still load. */
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
		if (!["project", "pie", "home"].includes(cwd)) {
			out.diagnostics.push(`hooks ${source}: hook #${i + 1} has invalid cwd ${JSON.stringify(h.cwd)} (project | pie | home)`);
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
	getSession: () => { sessionId?: string; cwd: string; model?: string; thinking?: string };
}

export class HookRunner {
	readonly hooks: HookConfig[] = [];
	readonly diagnostics: string[] = [];
	private readonly opts: HookRunnerOptions;
	/** Hooks run in event order, one rule at a time, exactly like pie — but never block the agent. */
	private queue: Promise<void> = Promise.resolve();

	constructor(opts: HookRunnerOptions) {
		this.opts = opts;
	}

	load(): void {
		this.hooks.length = 0;
		this.diagnostics.length = 0;
		const userFile = path.join(this.opts.loopsDir, "hooks.toml");
		// `<project>/.pi/hooks.toml`, or pie's `<project>/.pie/hooks.toml` so a pie checkout works verbatim.
		const projectFile = [path.join(this.opts.projectCwd, ".pi", "hooks.toml"), path.join(this.opts.projectCwd, ".pie", "hooks.toml")].find((f) => fs.existsSync(f)) ?? path.join(this.opts.projectCwd, ".pi", "hooks.toml");
		const user = this.readFile(userFile, "user");
		const envAllow = [process.env.PI_ALLOW_PROJECT_HOOKS, process.env.PIE_ALLOW_PROJECT_HOOKS].some((v) => v === "1" || v?.toLowerCase() === "true");
		const allowProject = envAllow || !!this.opts.allowProjectHooks || !!user?.allowProjectHooks;
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

	/** Wait for queued hooks to finish (pie awaits its listeners); bounded so quitting never hangs. */
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
				const payload = this.payloadFor(h, data);
				try {
					await this.runRule(h, payload, signal);
				} catch (err: any) {
					if (h.onFailure === "warn") this.opts.warn(`hook ${h.source} ${h.event}${h.tool ? ` (tool=${h.tool})` : ""} failed: ${previewRedacted(err?.message ?? String(err), 300)}`);
				}
			}
		};
		this.queue = this.queue.then(run, run);
		return this.queue;
	}

	/** pie serializes every payload field; absent optionals are `null`, never omitted. */
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
		};
	}

	private resolveCwd(h: HookConfig): string {
		if (h.cwd === "home") return os.homedir();
		if (h.cwd === "pie") return this.opts.loopsDir;
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
		};
		// Environment variables exist only when they have a value (pie); the JSON payload carries nulls.
		const env: Record<string, string> = { ...(process.env as Record<string, string>) };
		for (const [k, v] of Object.entries(vars)) {
			if (v == null) continue;
			env[`PI_${k}`] = v;
			env[`PIE_${k}`] = v; // pie-compatible names so existing hooks.toml files work verbatim
		}
		const isWin = process.platform === "win32";
		return new Promise<void>((resolve, reject) => {
			// Own process group (setsid equivalent) so a timeout kills the whole tree, not just `sh`.
			const proc = spawn(isWin ? "cmd" : "sh", [isWin ? "/C" : "-c", h.command!], { cwd: this.resolveCwd(h), env, stdio: ["ignore", "ignore", "pipe"], detached: !isWin });
			let stderr = "";
			proc.stderr?.on("data", (d) => {
				if (stderr.length < 4000) stderr += d.toString();
			});
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

/** pie's `message_kind`: user | assistant | tool_result | <custom role> (pi: the message's customType). */
export function messageKind(msg: any): string | undefined {
	const role = msg?.role;
	if (typeof role !== "string") return undefined;
	if (role === "toolResult") return "tool_result";
	if (role === "custom" && typeof msg.customType === "string" && msg.customType) return msg.customType;
	return role;
}

/** pie's `message_summary`: text joined with placeholders for thinking / tool calls / images, truncated. */
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

/** pie's `result_summary` for tool results / partial results. */
export function resultSummary(result: any): string | undefined {
	if (result === undefined || result === null) return undefined;
	if (typeof result === "string") return truncateSummary(result);
	const content = Array.isArray(result?.content) ? result.content : Array.isArray(result) ? result : undefined;
	if (!content) return truncateSummary(typeof result === "object" ? JSON.stringify(result) : String(result));
	return truncateSummary(content.map((b: any) => (b?.type === "text" ? (b.text ?? "") : b?.type === "image" ? `<image ${b.mimeType ?? ""}>` : "")).join("\n"));
}
