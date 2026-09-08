/**
 * pi-loops — pie's "Loops: stateful cron jobs + the triage inbox" as a plain pi
 * extension. Nothing in pi is patched: timers start in session_start and stop in
 * session_shutdown, loop runs are `pi -p` child processes, state is Markdown on
 * disk, findings go to a global JSONL inbox, and /inbox claim turns a finding
 * into a real user turn via pi.sendUserMessage().
 *
 * Commands:  /cron … (pie's surface: /cron add [--stateful] "<schedule>" <prompt>)   /inbox …
 * Tools:     cron_create (stateful flag, like pie's NewCronJob), cron_list, cron_remove
 * Storage:   ~/.pi/agent/loops/{jobs.json,state/<id>.md,inbox.jsonl,runs.jsonl}
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION, getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ARCHIVE_EXT, defaultExportPath, exportSession, importSession } from "./archive.ts";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseAddArgs, splitCommand } from "./args.ts";
import { loadConfig } from "./config.ts";
import { HookRunner, type HookEventData, messageKind, messageSummary, resultSummary, truncateSummary } from "./hooks.ts";
import { type InboxEntry, resolveInboxRef } from "./inbox.ts";
import { McpSource, type McpServerConfig, type McpToolDef, droppedNotificationMessage, mapNotification, mergeMcpConfigs, parseMcpConfig } from "./mcp.ts";
import { previewRedacted } from "./redact.ts";
import { computeNext, formatLocal, formatSchedule, parseSchedule } from "./schedule.ts";
import { LoopScheduler, type SessionSnapshot } from "./scheduler.ts";
import { MAX_PROMPT_BYTES, type LoopJob, type RunRecord, defaultLoopsDir, newId, resolveJobRef } from "./store.ts";
import { parseToml } from "./toml.ts";
import { summarizeSessionFile } from "./transcript.ts";
import { TriggerRuntime, type TriggerOutcome } from "./trigger-runtime.ts";
import { TriggerStore, looksLikeFixedScheduleRequest, parseTriggerRule, resolveRuleRef } from "./triggers.ts";
import * as fs from "node:fs";

const VIEW_ENTRY = "pi-loops:view";
const STATUS_KEY = "pi-loops";
/** Version from package.json (shown in /cron scheduler and written into archives). */
const PI_LOOPS_VERSION = (() => {
	try {
		return String(JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8")).version ?? "0.0.0");
	} catch {
		return "0.0.0";
	}
})();

interface ViewData {
	title: string;
	lines: string[];
}

export default function piLoops(pi: ExtensionAPI) {
	const isChild = process.env.PI_LOOPS_CHILD === "1";
	const dir = defaultLoopsDir(getAgentDir());

	let session: SessionSnapshot = { cwd: process.cwd() };
	let lastCtx: ExtensionContext | undefined;
	let started = false;

	const snapshot = (ctx: ExtensionContext): SessionSnapshot => ({
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinking: ctx.thinkingLevel,
	});

	const scheduler: LoopScheduler = new LoopScheduler({
		dir,
		getSession: () => session,
		hooks: {
			onInject: (_job, prompt) => {
				if (!lastCtx) return;
				pi.sendUserMessage(prompt, lastCtx.isIdle() ? undefined : { deliverAs: "followUp" });
			},
			onRunStart: (job, runId) => {
				const summary = `cron \`${job.id}\`${job.name ? ` "${job.name}"` : ""} due at ${job.lastDueAt ?? job.lastFiredAt ?? new Date().toISOString()}: ${previewRedacted(job.prompt, 120)}`;
				triggers.store.appendAudit({ type: "trigger", traceId: runId, state: "accepted", sourceLabel: "Cron", eventLabel: job.id, summary, details: { delivery: job.stateful ? "sub_agent" : "inject_and_run", evaluator_decision: { outcome: "accept", permission: "allow" } } });
				triggers.store.appendAudit({ type: "trigger_result", traceId: runId, state: "running", sourceLabel: "Cron", eventLabel: job.id, details: { cwd: job.cwd } });
				refreshBadge();
			},
			onCatchUp: (job, dueAt) => {
				if (lastCtx?.hasUI) lastCtx.ui.notify(`cron ${job.name ?? job.id}: catching up the run missed at ${formatLocal(dueAt)}`, "info");
			},
			onRunFinished: ({ job, record, findings, result }) => {
				triggers.store.appendAudit({
					type: "trigger_result",
					traceId: record.runId,
					state: result.stopReason === "aborted" ? "aborted" : record.ok ? "completed" : "failed",
					sourceLabel: "Cron",
					eventLabel: job.id,
					summary: record.ok ? record.summary : record.error,
					details: { findings: record.findings, state_updated: record.stateUpdated, cost_usd: record.usage?.cost ?? 0, exit_code: record.exitCode, session_file: record.sessionFile, checker: record.checker ? { ok: record.checker.ok, kept: record.checker.kept, dropped: record.checker.dropped.length } : undefined },
				});
				refreshBadge();
				if (!lastCtx?.hasUI) return;
				showRunCard(lastCtx, job, record, findings);
			},
			onInboxChanged: () => refreshBadge(),
			// Dynamic triggers piggyback on the same 30s tick; push sources follow the timer so
			// exactly one pi process on the machine listens to a given MCP server.
			onTick: (now, leader): Promise<void> => triggers.tick(now, leader),
			onLeadership: async () => refreshBadge(),
			log: (msg) => {
				if (lastCtx?.hasUI) lastCtx.ui.notify(`[cron] ${msg}`, "info");
			},
		},
	});

	/* ---------------------------------------------------------- triggers */

	let config = loadConfig(dir);
	const triggers: TriggerRuntime = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: scheduler.store,
		getSession: () => session,
		pollIntervalSecs: config.triggerPollIntervalSecs,
		hooks: {
			onPromote: (content) => {
				// Promotion = the result becomes visible to future turns (pie inserts a `[Trigger …]` user
				// message into the parent session). A custom message reaches the LLM context without a turn.
				pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: false, deliverAs: lastCtx?.isIdle() ? undefined : "nextTurn" });
			},
			onInjectAndRun: (prompt) => {
				pi.sendUserMessage(prompt, lastCtx?.isIdle() ? undefined : { deliverAs: "followUp" });
			},
			onStarted: () => refreshBadge(),
			onFinished: (outcome) => {
				refreshBadge();
				if (lastCtx?.hasUI) showTriggerCard(lastCtx, outcome);
			},
			log: (msg) => {
				if (lastCtx?.hasUI) lastCtx.ui.notify(`[triggers] ${msg}`, "info");
			},
		},
	});
	pi.registerFlag("trigger-poll-secs", { type: "string", description: "Dynamic trigger poll interval in seconds (pi-loops; default 600 or config.toml [triggers].poll_interval_secs)" });

	const mcpSources: McpSource[] = [];
	let mcpConfigs: McpServerConfig[] = [];
	let mcpConfigError: string | undefined;
	const mcpDiagnostics: string[] = [];

	/** pie's `load_all`: user `mcp.toml` + project `.pi/mcp.toml` (same name → project wins). Project config needs project trust. */
	function loadMcpConfig(projectTrusted: boolean): void {
		mcpConfigs = [];
		mcpConfigError = undefined;
		mcpDiagnostics.length = 0;
		const read = (file: string, source: "user" | "project"): McpServerConfig[] => {
			let text: string;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch (err: any) {
				if (err?.code !== "ENOENT") mcpDiagnostics.push(`mcp config (${source}, ${file}): read failed: ${err?.message ?? err}`);
				return [];
			}
			try {
				const parsed = parseMcpConfig(parseToml(text), source);
				mcpDiagnostics.push(...parsed.diagnostics);
				return parsed.servers;
			} catch (err: any) {
				mcpDiagnostics.push(`mcp config (${source}, ${file}): parse failed: ${err?.message ?? err}`);
				return [];
			}
		};
		const user = read(path.join(dir, "mcp.toml"), "user");
		const projectFile = path.join(session.cwd, ".pi", "mcp.toml");
		let project: McpServerConfig[] = [];
		if (fs.existsSync(projectFile)) {
			if (projectTrusted) project = read(projectFile, "project");
			else mcpDiagnostics.push(`project MCP config ignored at ${projectFile}: project is not trusted (pi --approve, or trust it when prompted)`);
		}
		mcpConfigs = mergeMcpConfigs(user, project);
		if (mcpDiagnostics.length) mcpConfigError = mcpDiagnostics.join("; ");
	}

	/** `auth.token_keychain_ref` → environment variable, then pi's credential store (`/login`-style api keys). */
	function resolveMcpToken(ref: string): string | undefined {
		const fromEnv = process.env[ref];
		if (fromEnv) return fromEnv;
		try {
			const cred: any = readStoredCredential(ref);
			if (cred && typeof cred === "object") {
				if (typeof cred.key === "string") return cred.key;
				if (typeof cred.access === "string") return cred.access;
				if (typeof cred.token === "string") return cred.token;
			}
			if (typeof cred === "string") return cred;
		} catch {
			/* no store */
		}
		return undefined;
	}

	/** MCP tool names registered with pi, per server (pie's `McpAgentTool`s). */
	const mcpToolNames = new Map<string, string[]>();
	/** Notifications ignored because this process does not own the timer. */
	let mcpStandbyIgnored = 0;

	/**
	 * pie's `connect_one`: after the handshake, `tools/list` and register every server tool with
	 * the agent. Registration is per extension instance; a reconnect refreshes the catalog but
	 * cannot re-register names pi already knows, so new tools appear after /reload.
	 */
	async function registerMcpTools(source: McpSource): Promise<void> {
		let tools: McpToolDef[];
		try {
			tools = await source.listTools();
		} catch (err: any) {
			source.status.lastError = `tools/list failed: ${err?.message ?? err}`;
			return;
		}
		const already = mcpToolNames.get(source.config.name) ?? [];
		const taken = new Set(pi.getAllTools().map((t) => t.name));
		for (const tool of tools) {
			const registeredName = already.find((n) => n === tool.name || n === `${source.config.name}_${tool.name}`);
			if (registeredName) continue;
			const name = taken.has(tool.name) ? `${source.config.name}_${tool.name}` : tool.name;
			if (taken.has(name)) continue;
			taken.add(name);
			already.push(name);
			pi.registerTool({
				name,
				label: `${source.config.name}: ${tool.name}`,
				description: tool.description ?? `${tool.name} (MCP server ${source.config.name})`,
				parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
				async execute(_id, params, signal) {
					let result: Awaited<ReturnType<McpSource["callTool"]>>;
					try {
						result = await source.callTool(tool.name, params, signal);
					} catch (err: any) {
						const msg = err?.message ?? String(err);
						return { content: [{ type: "text", text: msg === "cancelled" ? "cancelled" : `mcp call: ${msg}` }], isError: true, details: { name: tool.name, server: source.config.name, isError: true } };
					}
					const content = result.content.map((b) => (b.type === "text" ? { type: "text" as const, text: b.text } : b.type === "image" ? { type: "image" as const, data: b.data, mimeType: b.mimeType } : { type: "text" as const, text: `<resource>${JSON.stringify(b.resource)}</resource>` }));
					if (result.isError) {
						return { content: [{ type: "text", text: content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n") || "tool reported an error" }], isError: true, details: { name: tool.name, server: source.config.name, isError: true } };
					}
					return { content: content.length ? content : [{ type: "text", text: "(no content)" }], details: { name: tool.name, server: source.config.name, isError: false } };
				},
			});
		}
		mcpToolNames.set(source.config.name, already);
	}

	function startMcpSources(): void {
		if (mcpSources.length) return;
		for (const cfg of mcpConfigs) {
			const source = new McpSource(cfg, {
				onConnected: (src) => registerMcpTools(src),
				onNotification: (n) => {
					if (!scheduler.isLeader) {
						// Every pi connects (for tools); exactly one consumes pushes, or a burst would run N times.
						mcpStandbyIgnored++;
						return;
					}
					const trigger = mapNotification(cfg.name, n);
					if (!trigger) {
						source.status.droppedCount++;
						source.status.lastError = droppedNotificationMessage(n.method);
						return;
					}
					trigger.cwd = session.cwd;
					const delivery = cfg.injectAndRun ? "inject_and_run" : cfg.injectSummary ? "inject_summary" : "sub_agent";
					void triggers.handle(trigger, delivery).then((out) => {
						if (!out) source.status.dedupedCount++;
					});
				},
				onStatus: () => refreshBadge(),
				resolveToken: resolveMcpToken,
				log: (msg) => {
					if (lastCtx?.hasUI) lastCtx.ui.notify(`mcp server '${cfg.name}' failed: ${msg}`, "warning");
				},
			});
			mcpSources.push(source);
			source.start();
		}
	}

	async function stopMcpSources(): Promise<void> {
		const sources = mcpSources.splice(0);
		await Promise.all(sources.map((s) => s.stop()));
	}


	function showTriggerCard(ctx: ExtensionContext, o: TriggerOutcome): void {
		const quiet = o.ok && o.delivery === "sub_agent" && o.matchedRules.length === 0;
		if (quiet) return; // quiet checks stay in /triggers status + audit, like pie's panel
		const secs = Math.round(o.durationMs / 1000);
		const cost = o.cost ? ` · $${o.cost.toFixed(3)}` : "";
		const title = o.ok
			? `trigger ${o.trigger.sourceLabel} · ${o.trigger.eventLabel} · ${secs}s${cost}${o.matchedRules.length ? ` · matched ${o.matchedRules.length}` : ""}${o.promoted ? " · promoted to chat" : ""}`
			: `trigger ${o.trigger.sourceLabel} FAILED · ${secs}s`;
		const lines: string[] = [];
		if (!o.ok) lines.push(`! ${o.error ?? "unknown error"}`);
		for (const r of o.matchedRules) lines.push(`• ${r.id.slice(0, 12)} when ${previewRedacted(r.condition, 60)} -> ${previewRedacted(r.action, 60)}${r.fireOnce ? " (fired once, now disabled)" : ""}`);
		if (o.summary) lines.push(...previewRedacted(o.summary, 600).split("\n").slice(0, 8));
		lines.push(`trace ${o.trigger.traceId.slice(0, 8)} · /triggers audit`);
		if (ctx.mode === "tui") show(ctx, title, lines);
		else ctx.ui.notify([title, ...lines].join("\n"), o.ok ? "info" : "warning");
	}

	/* ------------------------------------------------------ lifecycle hooks */

	let hookRunner: HookRunner | undefined;

	function fireHook(data: HookEventData, ctx?: ExtensionContext): void {
		// Sub-agents (loop runs, trigger checks) load this extension too; only the parent fires hooks.
		if (isChild || !hookRunner?.hasHooksFor(data.event)) return;
		void hookRunner.fire(data, ctx?.signal);
	}

	/* ------------------------------------------------------------ panel */

	const PANEL_KEY = "pi-loops-panel";
	const PANEL_RULE_LIMIT = 5; // pie: TRIGGER_PANEL_RULE_LIMIT
	const uiPrefsFile = path.join(dir, "ui.json");
	let panelEnabled = (() => {
		try {
			return JSON.parse(fs.readFileSync(uiPrefsFile, "utf8")).panel !== false;
		} catch {
			return true;
		}
	})();

	function setPanelEnabled(on: boolean): void {
		panelEnabled = on;
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(uiPrefsFile, `${JSON.stringify({ panel: on })}\n`);
		} catch {
			/* best effort */
		}
		refreshPanel();
	}

	/**
	 * pie's TUI right rail (Triggers / Polling / Inbox / Cron / sources), rendered as a widget
	 * above the editor. Hidden when there is nothing to show, like pie's empty panel.
	 */
	function refreshPanel(): void {
		if (!lastCtx || lastCtx.mode !== "tui") return;
		if (!panelEnabled || !started) {
			lastCtx.ui.setWidget(PANEL_KEY, undefined);
			return;
		}
		const rules = triggers.store.load().filter((r) => r.cwd === session.cwd);
		const jobs = scheduler.store.load().filter((j) => j.cwd === session.cwd);
		const inboxNew = scheduler.inbox.newCount();
		const poll = triggers.lastPoll;
		const sources = mcpSources.map((src) => ({ name: src.config.name, state: src.status.state, tools: (mcpToolNames.get(src.config.name) ?? []).length }));
		if (!rules.length && !jobs.length && !inboxNew && !sources.length) {
			lastCtx.ui.setWidget(PANEL_KEY, undefined);
			return;
		}
		const clip = (x: string, n: number) => previewRedacted(x, n);
		lastCtx.ui.setWidget(PANEL_KEY, (_tui, theme) => {
			const dim = (x: string) => theme.fg("dim", x);
			const head = (x: string) => theme.fg("accent", x);
			const ok = (x: string) => theme.fg("success", x);
			const warn = (x: string) => theme.fg("warning", x);
			const lines: string[] = [];
			if (rules.length) {
				lines.push(head("Triggers"));
				for (const r of rules.slice(0, PANEL_RULE_LIMIT)) {
					lines.push((r.enabled ? ok : dim)(`${r.id.slice(0, 12)} [${r.enabled ? "enabled" : "disabled"}, ${r.fireOnce ? "once" : "repeat"}]`) + dim(`  when ${clip(r.condition, 40)}  do ${clip(r.action, 40)}`));
				}
				if (rules.length > PANEL_RULE_LIMIT) lines.push(dim(`… ${rules.length - PANEL_RULE_LIMIT} more`));
				if (poll) lines.push(warn(`Polling ${formatLocal(Date.parse(poll.at))} · ${poll.outcome}`));
			}
			if (inboxNew > 0) lines.push(warn(`Inbox  ${inboxNew} new — /inbox`));
			if (jobs.length) {
				const enabled = jobs.filter((j) => j.enabled).length;
				lines.push(head("Cron") + (enabled === jobs.length ? ok : warn)(`  enabled ${enabled} · disabled ${jobs.length - enabled}`));
				for (const j of jobs.slice(0, PANEL_RULE_LIMIT)) {
					const label = j.name ?? j.id.slice(0, 12);
					lines.push((j.enabled ? ok : dim)(`${label} [${j.enabled ? "enabled" : "disabled"}${j.stateful ? ", stateful" : ""}] ${formatSchedule(j.schedule)}`) + dim(`  do ${clip(j.prompt, 48)}`) + (j.skippedOverlap ? warn(`  skipped overlaps ${j.skippedOverlap}`) : ""));
				}
				if (jobs.length > PANEL_RULE_LIMIT) lines.push(dim(`… ${jobs.length - PANEL_RULE_LIMIT} more`));
			}
			if (sources.length) {
				lines.push(head("MCP") + sources.map((src) => (src.state === "connected" ? ok : src.state === "disabled" ? dim : warn)(`  ${src.name} ${src.state}${src.tools ? ` · ${src.tools} tool${src.tools === 1 ? "" : "s"}` : ""}`)).join(""));
			}
			const text = new Text(lines.join("\n"), 0, 0);
			return text;
		});
	}

	function refreshBadge(): void {
		refreshPanel();
		if (!lastCtx?.hasUI) return;
		const parts: string[] = [];
		const n = scheduler.inbox.newCount();
		if (n > 0) parts.push(`Inbox: ${n} new`);
		const running = [...scheduler.runningLabels(), ...triggers.runningList().map((r) => (r.sourceLabel === "local:dynamic" ? "trigger-check" : r.sourceLabel))];
		if (running.length) parts.push(`running: ${running.join(", ")}`);
		const attention = mcpSources.filter((s) => s.status.state === "disconnected" || s.status.state === "auth_failed").length;
		if (attention) parts.push(`mcp: ${attention} source${attention === 1 ? "" : "s"} down`);
		if (started && !scheduler.isLeader) parts.push("loops standby");
		lastCtx.ui.setStatus(STATUS_KEY, parts.length ? parts.join(" · ") : undefined);
	}

	/** Like pie's TUI showing trigger output: a bounded card in the transcript, never an LLM message. */
	function showRunCard(ctx: ExtensionContext, job: LoopJob, record: RunRecord, findings: string[]): void {
		const label = job.name ?? job.id;
		const secs = Math.max(0, Math.round((Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000));
		const cost = record.usage?.cost ? ` · $${record.usage.cost.toFixed(3)}` : "";
		const title = record.ok
			? `cron ${label} · ${secs}s${cost} · ${findings.length} finding${findings.length === 1 ? "" : "s"}${record.checker?.ok ? " (verified)" : ""}${record.stateUpdated ? " · state updated" : ""}`
			: `cron ${label} FAILED · ${secs}s`;
		const lines: string[] = [];
		if (!record.ok) lines.push(`! ${record.error ?? "unknown error"}`);
		if (record.summary) lines.push(...record.summary.split("\n").slice(0, 6));
		for (const f of findings) lines.push(`• ${previewRedacted(f, 160)}`);
		if (record.droppedFindings) lines.push(`(${record.droppedFindings} more findings dropped: per-run cap)`);
		if (record.checker) {
			const c = record.checker;
			if (!c.ok) lines.push(`checker FAILED (${c.error}); findings entered unverified`);
			else lines.push(`checker kept ${c.kept}, dropped ${c.dropped.length}${c.unreviewed ? `, ${c.unreviewed} unreviewed` : ""}${c.cost ? ` · $${c.cost.toFixed(3)}` : ""} — /cron trace ${label} 1 checker`);
			for (const d of c.dropped) lines.push(`  ✗ ${previewRedacted(d.text, 100)} — ${previewRedacted(d.reason, 100)}`);
		}
		lines.push(`/cron trace ${label} · /inbox`);
		if (ctx.mode === "tui") show(ctx, title, lines);
		else ctx.ui.notify([title, ...lines].join("\n"), record.ok ? "info" : "warning");
	}

	/* ------------------------------------------------------------ views */

	pi.registerEntryRenderer<ViewData>(VIEW_ENTRY, (entry, _opts, theme) => {
		const data = entry.data ?? { title: "", lines: [] };
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", data.title), 0, 0));
		for (const line of data.lines) box.addChild(new Text(line, 0, 0));
		return box;
	});

	function show(ctx: ExtensionContext, title: string, lines: string[]): void {
		if (ctx.mode === "tui") pi.appendEntry<ViewData>(VIEW_ENTRY, { title, lines });
		else if (ctx.hasUI) ctx.ui.notify([title, ...lines].join("\n"), "info");
		else console.log([title, ...lines].join("\n"));
	}

	const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
	const homeRel = (p: string) => {
		const home = process.env.HOME ?? "";
		return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	function jobLines(jobs: LoopJob[]): string[] {
		const now = Date.now();
		return jobs.map((job, i) => {
			const next = job.enabled
				? computeNext(
						{
							schedule: job.schedule,
							createdAt: Date.parse(job.createdAt),
							lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined,
						},
						now,
					)
				: undefined;
			const marks = [job.stateful ? "[stateful]" : undefined, job.verify ? "[verify]" : undefined, job.running ? `running ${job.running.runId}` : undefined, job.catchUp ? undefined : "[no-catchup]"]
				.filter(Boolean)
				.join("  ");
			const head = `${String(i + 1).padStart(2)}. ${job.id}${job.name ? ` "${job.name}"` : ""}  ${job.enabled ? "enabled" : "disabled"}  ${formatSchedule(job.schedule)}${marks ? `  ${marks}` : ""}`;
			const action = `    action: ${previewRedacted(job.prompt, 120)}`;
			const meta = `    next ${next ? formatLocal(next) : "—"} · runs ${job.runCount}${job.skippedOverlap ? ` · overlap skips ${job.skippedOverlap}` : ""} · ${homeRel(job.cwd)}`;
			const err = job.lastError ? `    last error: ${previewRedacted(job.lastError, 100)}` : undefined;
			return [head, action, meta, err].filter((l): l is string => !!l);
		}).flat();
	}

	/* --------------------------------------------------------- creation */

	async function createJob(input: {
		schedule: LoopJob["schedule"];
		prompt: string;
		stateful: boolean;
		name?: string;
		cwd?: string;
		model?: string;
		thinking?: string;
		tools?: string[];
		timeoutMs?: number;
		catchUp: boolean;
		verify?: boolean;
		checkerModel?: string;
	}): Promise<LoopJob> {
		if (!input.prompt.trim()) throw new Error("cron action cannot be empty");
		if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error(`cron action exceeds ${MAX_PROMPT_BYTES} bytes`);
		if (input.name && !/^[\w.-]{1,40}$/.test(input.name)) throw new Error("name must be 1-40 chars of letters, digits, . _ -");
		const existing = scheduler.store.load();
		if (input.name && existing.some((j) => j.name === input.name)) throw new Error(`a cron job named "${input.name}" already exists`);
		if (!input.stateful && !session.sessionId) throw new Error("a non-stateful cron job needs a persistent session to inject into (not --no-session)");
		const job: LoopJob = {
			id: newId("cron"),
			name: input.name,
			schedule: input.schedule,
			stateful: input.stateful,
			prompt: input.prompt,
			cwd: path.resolve(session.cwd, input.cwd ?? "."),
			model: input.model,
			thinking: input.thinking,
			tools: input.tools,
			enabled: true,
			verify: input.stateful && input.verify ? true : undefined,
			checkerModel: input.stateful && input.verify ? input.checkerModel : undefined,
			catchUp: input.catchUp,
			timeoutMs: input.timeoutMs,
			createdAt: new Date().toISOString(),
			createdBy: { sessionId: session.sessionId, cwd: session.cwd },
			sessionId: input.stateful ? undefined : session.sessionId,
			runCount: 0,
			skippedOverlap: 0,
		};
		await scheduler.store.add(job);
		return job;
	}

	/**
	 * pie's `cron_control_plane` audit: every add / enable / disable / remove, from a slash
	 * command or a tool, leaves a custom entry in the session (never in LLM context).
	 */
	function cronControlAudit(op: "add" | "enable" | "disable" | "remove", actor: "slash" | "tool", before?: LoopJob, after?: LoopJob): void {
		const job = after ?? before;
		const next = after?.enabled ? computeNext({ schedule: after.schedule, createdAt: Date.parse(after.createdAt), lastFiredAt: after.lastFiredAt ? Date.parse(after.lastFiredAt) : undefined }, Date.now()) : undefined;
		pi.appendEntry("pi-loops:cron_control_plane", {
			op,
			actor,
			job_id: job?.id,
			schedule: job ? formatSchedule(job.schedule) : undefined,
			action_preview: job ? previewRedacted(job.prompt, 120) : undefined,
			before_enabled: before?.enabled,
			after_enabled: after?.enabled,
			next_run: next ? new Date(next).toISOString() : undefined,
			removed: !!before && !after,
		});
	}

	/* --------------------------------------------------------- commands */

	const CRON_HELP = [
		"/cron                          jobs of this project        /cron all   every project on this machine",
		'/cron add [--stateful] "<minute hour dom month dow>" <prompt>',
		'    plain job: result appears in this chat (inject-and-run).  --stateful: loop with memory, findings go to /inbox',
		'    e.g. /cron add --stateful "0 9 * * *" check the repo issues and report anything new since the last run',
		"    schedule also accepts @daily | every 30m | in 10m | at 2026-09-08T18:00",
		"    --verify: maker/checker — a second adversarial sub-agent reviews findings before they enter /inbox (--checker-model <provider/id> to use another model)",
		"    more flags: --name <n> --cwd <dir> --model <provider/id> --thinking <lvl> --tools a,b --timeout 20m --no-catchup",
		"/cron enable|disable|remove <n|id|name>      /cron run <n|id|name>   fire now",
		"/cron state <n|id|name>        the loop's notes (state spine)",
		"/cron runs [n|id|name]         recent runs          /cron trace [n|id|name] [k] [checker]   k-th latest run's transcript (maker, or its checker)",
		"/cron scheduler                who owns the timer     /cron panel on|off   pie-style side panel above the editor",
		"/inbox                         triage findings from stateful jobs (/inbox help)",
		`/session-export [path] [--exclude-triggers]      pie's /session export: transcript + this project's cron jobs, trigger rules and loop state as one ${ARCHIVE_EXT} archive`,
		"/session-import <path> [--activate-triggers=on|off] [--cwd <dir>] [--resume]   restore it here (automation stays off unless activated)",
	];

	const cronCompletions = (prefix: string) => {
		const subs = ["add", "list", "all", "enable", "disable", "remove", "run", "state", "runs", "trace", "scheduler", "panel", "help"];
		const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
		return items.length ? items : null;
	};
	const cronHandler = async (args: string, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const { sub, rest } = splitCommand(args);
			const jobs = () => scheduler.store.load();
			// Numbers refer to the project-scoped list (/loop); ids and names resolve machine-wide.
			const pick = (ref: string): LoopJob | undefined => {
				const all = jobs();
				const job = /^\d+$/.test(ref.trim()) ? resolveJobRef(all.filter((j) => j.cwd === session.cwd), ref) : resolveJobRef(all, ref);
				if (!job) ctx.ui.notify(ref ? `no cron job with id '${ref}'` : `usage: /cron ${sub} <id>`, "warning");
				return job;
			};
			try {
				switch (sub) {
					case "":
					case "list":
					case "ls":
					case "status":
					case "all": {
						const all = jobs();
						if (!all.length) {
							show(ctx, "Cron jobs: none", ['/cron add [--stateful] "0 9 * * *" <prompt>   (/cron help for more)']);
							return;
						}
						if (sub === "all") {
							show(ctx, `Cron jobs (this machine, ${all.length}):`, jobLines(all));
							return;
						}
						const here = all.filter((j) => j.cwd === session.cwd);
						const elsewhere = all.length - here.length;
						const lines = here.length ? jobLines(here) : ["(none in this project)"];
						if (elsewhere) lines.push(`+ ${elsewhere} job${elsewhere === 1 ? "" : "s"} in other projects — /cron all`);
						show(ctx, `Cron jobs (${homeRel(session.cwd)}, ${here.length}):`, lines);
						return;
					}
					case "help":
						show(ctx, "/cron", CRON_HELP);
						return;
					case "panel": {
						const on = rest.trim() === "on" ? true : rest.trim() === "off" ? false : !panelEnabled;
						setPanelEnabled(on);
						ctx.ui.notify(`panel ${on ? "on" : "off"} (pie-style Triggers / Inbox / Cron / MCP widget above the editor)`, "info");
						return;
					}
					case "add": {
						const parsed = parseAddArgs(rest);
						const job = await createJob({
							schedule: parsed.schedule,
							prompt: parsed.prompt,
							stateful: parsed.stateful,
							name: parsed.name,
							cwd: parsed.cwd,
							model: parsed.model,
							thinking: parsed.thinking,
							tools: parsed.tools,
							timeoutMs: parsed.timeoutMs,
							catchUp: parsed.catchUp,
							verify: parsed.verify,
							checkerModel: parsed.checkerModel,
						});
						const next = computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt) }, Date.now());
						cronControlAudit("add", "slash", undefined, job);
						show(ctx, `added cron job ${job.id}${job.name ? ` "${job.name}"` : ""}`, [
							`  schedule: ${formatSchedule(job.schedule)}${next ? ` (next run ${formatLocal(next)})` : ""}`,
							...(job.stateful ? [`  mode: stateful loop (findings go to /inbox${job.verify ? " after the checker" : ""})`] : ["  mode: inject-and-run (the result appears in this chat)"]),
							`  action: ${previewRedacted(job.prompt, 120)}`,
						]);
						refreshBadge();
						return;
					}
					case "run": {
						const job = pick(rest);
						if (!job) return;
						if (job.stateful && !started) {
							ctx.ui.notify("the scheduler is not running in this session (child or non-interactive mode)", "warning");
							return;
						}
						const ok = await scheduler.runNow(job.id);
						ctx.ui.notify(ok ? `running ${job.name ?? job.id} in the background…` : `${job.name ?? job.id} is already running`, ok ? "info" : "warning");
						return;
					}
					case "enable":
					case "resume":
					case "disable":
					case "pause": {
						const enable = sub === "enable" || sub === "resume";
						const job = pick(rest);
						if (!job) return;
						const after = await scheduler.store.update(job.id, (j) => {
							j.enabled = enable;
							if (enable) j.lastError = undefined;
						});
						cronControlAudit(enable ? "enable" : "disable", "slash", job, after ?? job);
						ctx.ui.notify(`${enable ? "enabled" : "disabled"} cron job ${job.id}${job.name ? ` "${job.name}"` : ""}`, "info");
						return;
					}
					case "remove":
					case "rm":
					case "delete": {
						const job = pick(rest);
						if (!job) return;
						await scheduler.store.remove(job.id);
						cronControlAudit("remove", "slash", job, undefined);
						ctx.ui.notify(`removed cron job ${job.id}${job.name ? ` "${job.name}"` : ""}${job.stateful ? " and its loop state" : ""}`, "info");
						return;
					}
					case "state": {
						const job = pick(rest);
						if (!job) return;
						if (!job.stateful) {
							ctx.ui.notify(`${job.name ?? job.id} is not stateful; only --stateful jobs keep notes`, "warning");
							return;
						}
						const state = scheduler.store.readState(job.id);
						show(ctx, `loop state of ${job.name ?? job.id} (${homeRel(scheduler.store.statePath(job.id))})`, state ? state.split("\n") : ["(first run — no notes yet)"]);
						return;
					}
					case "runs": {
						const job = rest ? pick(rest) : undefined;
						if (rest && !job) return;
						const runs = scheduler.store.listRuns(job?.id, 15);
						if (!runs.length) {
							show(ctx, "Runs: none yet", []);
							return;
						}
						const newestFirst = [...runs].reverse();
						show(ctx, `Recent runs${job ? ` of ${job.name ?? job.id}` : ""} (${runs.length}, newest first)`, [
							...newestFirst.map((r, i) => {
								const secs = Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000));
								const who = job ? "" : `${r.jobName ?? r.jobId} `;
								const cost = r.usage?.cost ? ` $${r.usage.cost.toFixed(3)}` : "";
								const chk = r.checker ? (r.checker.ok ? `, checker kept ${r.checker.kept}/${r.checker.kept + r.checker.dropped.length + r.checker.unreviewed}` : ", checker FAILED") : "";
								const tail = r.ok ? `${r.findings} finding${r.findings === 1 ? "" : "s"}${chk}${r.stateUpdated ? ", state updated" : ""}` : `FAILED: ${previewRedacted(r.error ?? "?", 80)}`;
								return `${String(i + 1).padStart(2)}. ${formatLocal(Date.parse(r.startedAt))} ${who}${secs}s${cost} · ${tail}${r.sessionFile ? "" : " (no transcript)"}`;
							}),
							job ? `transcript: /cron trace ${job.name ?? job.id} <k>` : "transcript: /cron trace <job> <k>",
						]);
						return;
					}
					case "trace": {
						const parts = rest.split(/\s+/).filter(Boolean);
						const wantChecker = parts[parts.length - 1]?.toLowerCase() === "checker";
						if (wantChecker) parts.pop();
						const k = parts.length > 1 ? Number(parts[parts.length - 1]) : 1;
						const ref = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] ?? "";
						const job = ref ? pick(ref) : undefined;
						if (ref && !job) return;
						if (!Number.isInteger(k) || k < 1) {
							ctx.ui.notify("usage: /cron trace [job] [k]   (k = 1 is the latest run)", "warning");
							return;
						}
						const runs = scheduler.store.listRuns(job?.id, 200).reverse();
						const run = runs[k - 1];
						if (!run) {
							ctx.ui.notify(`no run #${k}${job ? ` for ${job.name ?? job.id}` : ""} (have ${runs.length})`, "warning");
							return;
						}
						const head = `${run.jobName ?? run.jobId} · ${formatLocal(Date.parse(run.startedAt))} · ${run.ok ? "ok" : "FAILED"}`;
						if (wantChecker) {
							if (!run.checker) {
								ctx.ui.notify("that run had no checker (job not created with --verify, or the maker reported nothing)", "warning");
								return;
							}
							const c = run.checker;
							const lines = [`checker ${c.ok ? "ok" : `FAILED: ${c.error}`} · kept ${c.kept} · dropped ${c.dropped.length} · unreviewed ${c.unreviewed} · ${Math.round(c.durationMs / 1000)}s${c.cost ? ` $${c.cost.toFixed(3)}` : ""}${c.model ? ` · ${c.model}` : ""}`];
							for (const d of c.dropped) lines.push(`  dropped: ${d.text} — ${d.reason}`);
							if (c.sessionFile) lines.push("", ...summarizeSessionFile(c.sessionFile, { maxLines: 60 }).map((l) => l.text), "", `full transcript: pi --session ${c.sessionFile}`);
							show(ctx, `checker trace: ${head}`, lines);
							return;
						}
						if (!run.sessionFile) {
							show(ctx, `trace: ${head}`, [run.error ? `! ${run.error}` : "", run.summary ?? "(no transcript kept for this run)"].filter(Boolean));
							return;
						}
						const lines = summarizeSessionFile(run.sessionFile, { maxLines: 60 }).map((l) => l.text);
						lines.push("", `full transcript: pi --session ${run.sessionFile}`);
						show(ctx, `trace: ${head}`, lines);
						return;
					}
					case "scheduler": {
						const leader = scheduler.readLeader();
						const me = process.pid;
						show(ctx, `Cron scheduler (pi-loops ${PI_LOOPS_VERSION} on pi ${PI_VERSION})`, [
							`this process: pid ${me}, ${started ? (scheduler.isLeader ? "owns the timer" : "standby") : "not scheduling (child/non-interactive)"}, ${scheduler.runningCount} run(s) in flight${scheduler.runningCount ? ` (${scheduler.runningLabels().join(", ")})` : ""}`,
							`timer owner: ${leader ? `pid ${leader.pid}@${leader.host}, heartbeat ${formatLocal(Date.parse(leader.heartbeatAt))}` : "none"}`,
							`store: ${homeRel(dir)}`,
							`inbox: ${scheduler.inbox.newCount()} new`,
						]);
						return;
					}
					default:
						ctx.ui.notify(`unknown /cron subcommand "${sub}" — /cron help`, "warning");
				}
			} catch (err: any) {
				ctx.ui.notify(`cron: ${err?.message ?? err}`, "error");
			}
	};

	pi.registerCommand("cron", {
		description: 'Scheduled jobs, pie-style: /cron add [--stateful] "<schedule>" <prompt> — /cron help',
		getArgumentCompletions: cronCompletions,
		handler: cronHandler,
	});
	pi.registerCommand("crontab", { description: "Alias of /cron", getArgumentCompletions: cronCompletions, handler: cronHandler });
	pi.registerCommand("loop", { description: "Alias of /cron", getArgumentCompletions: cronCompletions, handler: cronHandler });

	const INBOX_HELP = [
		"/inbox                list new findings",
		"/inbox all            include claimed/dismissed history",
		"/inbox claim <n|id>   mark claimed and hand it to the agent as a real turn",
		"/inbox dismiss <n|id> mark dismissed        /inbox clear   dismiss all new",
	];

	function inboxLines(entries: InboxEntry[], numbered: boolean): string[] {
		return entries.map((e, i) => {
			const when = formatLocal(Date.parse(e.createdAt));
			const mark = e.verified ? "✓ " : "";
			if (!numbered) return `  [${e.status}] ${mark}${previewRedacted(e.text, 200)}  (${e.source})`;
			return `  ${i + 1}. [${e.id.slice(0, 12)}] ${mark}${previewRedacted(e.text, 200)}  (${e.source}, ${when})`;
		});
	}

	function claimPrompt(e: InboxEntry): string {
		const verified = e.verified ? `\n(An independent checker reviewed and kept this finding${e.verifiedReason ? `: ${e.verifiedReason}` : ""}.)` : "";
		return `A recurring loop (${e.source}, running in ${e.cwd}) reported this finding — investigate and address it:\n${e.text}${verified}`;
	}

	pi.registerCommand("inbox", {
		description: "Triage findings from stateful cron jobs — /inbox help",
		getArgumentCompletions: (prefix) => {
			const subs = ["all", "claim", "dismiss", "clear", "help"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const { sub, rest } = splitCommand(args);
			try {
				switch (sub) {
					case "":
					case "list": {
						const entries = scheduler.inbox.listNew();
						if (!entries.length) {
							show(ctx, "inbox: empty — stateful loops (/cron add --stateful) report findings here", []);
							return;
						}
						show(ctx, `Inbox (${entries.length} new):`, [...inboxLines(entries, true), "claim with /inbox claim <n>, dismiss with /inbox dismiss <n>"]);
						return;
					}
					case "all": {
						const entries = scheduler.inbox.list();
						show(ctx, `Inbox history (${entries.length} total):`, entries.length ? inboxLines(entries, false) : ["(empty)"]);
						return;
					}
					case "help":
						show(ctx, "inbox", INBOX_HELP);
						return;
					case "claim":
					case "dismiss": {
						const entries = scheduler.inbox.listNew();
						const entry = resolveInboxRef(entries, rest);
						if (!entry) {
							const n = Number(rest);
							ctx.ui.notify(!rest ? "usage: /inbox claim|dismiss <n or inb-id>" : Number.isInteger(n) ? `no inbox entry #${n} (have ${entries.length})` : `no new inbox entry matching '${rest}'`, "warning");
							return;
						}
						await scheduler.inbox.setStatus(entry.id, sub === "claim" ? "claimed" : "dismissed", sub === "claim" ? session.sessionId : undefined);
						refreshBadge();
						if (sub === "dismiss") {
							ctx.ui.notify(`dismissed: ${previewRedacted(entry.text, 80)}`, "info");
							return;
						}
						pi.sendUserMessage(claimPrompt(entry), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
						return;
					}
					case "clear": {
						const n = await scheduler.inbox.dismissAllNew();
						refreshBadge();
						ctx.ui.notify(`dismissed ${n} inbox entr${n === 1 ? "y" : "ies"}`, "info");
						return;
					}
					default:
						ctx.ui.notify(`unknown /inbox subcommand: ${sub}; usage: /inbox [all|claim <n>|dismiss <n>|clear]`, "warning");
				}
			} catch (err: any) {
				ctx.ui.notify(`inbox: ${err?.message ?? err}`, "error");
			}
		},
	});

	/* ---------------------------------------------------------- /triggers */

	const TRIGGERS_USAGE = "[status|rules|sources|enable <id>|disable <id>|remove <id>|remove --all|running|audit [N]|abort <trace_id>|abort --all]";

	function ruleLines(rules: ReturnType<TriggerStore["load"]>, numbered: boolean): string[] {
		return rules.map((r, i) => {
			const state = r.enabled ? "enabled" : "disabled";
			const fire = r.fireOnce ? "fire_once" : "repeat";
			const out = r.promoteToChat ? "promote_to_chat" : "audit_only";
			const fired = r.firedAt ? `, fired_at=${r.firedAt}` : "";
			const head = numbered ? `${String(i + 1).padStart(2)}. ` : "  - ";
			return `${head}${r.id} [${state}, ${fire}, ${out}${fired}] when ${previewRedacted(r.condition, 80)} -> ${previewRedacted(r.action, 80)}${r.cwd !== session.cwd ? `  (${homeRel(r.cwd)})` : ""}`;
		});
	}

	pi.registerCommand("triggers", {
		description: "Show trigger sources, rules, running actions, and recent audit — /triggers " + TRIGGERS_USAGE,
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "rules", "sources", "enable", "disable", "remove", "running", "audit", "abort", "help"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const { sub, rest } = splitCommand(args);
			const store = triggers.store;
			const pickRule = (ref: string) => {
				const all = store.load();
				const rule = /^\d+$/.test(ref.trim()) ? resolveRuleRef(all.filter((r) => r.cwd === session.cwd), ref) : resolveRuleRef(all, ref);
				if (!rule) ctx.ui.notify(ref ? `no dynamic trigger rule with id '${ref}'` : `usage: /triggers ${sub} <id>`, "warning");
				return rule;
			};
			try {
				switch (sub) {
					case "":
					case "status": {
						const rules = store.load();
						const enabled = rules.filter((r) => r.enabled).length;
						const fireOnce = rules.filter((r) => r.fireOnce).length;
						const promote = rules.filter((r) => r.promoteToChat).length;
						const leader = scheduler.readLeader();
						show(ctx, "Trigger status:", [
							`  dynamic rules: ${rules.length} total, ${enabled} enabled, ${rules.length - enabled} disabled (${fireOnce} fire_once, ${rules.length - fireOnce} repeat, ${promote} promote_to_chat)`,
							`  local dynamic checker: ${started ? (scheduler.isLeader ? "this process" : `standby (timer owned by pid ${leader?.pid ?? "?"})`) : "not running here"}, polls every ${triggers.pollIntervalSecs}s while enabled rules exist`,
							`  last check: ${triggers.lastPoll ? `${formatLocal(Date.parse(triggers.lastPoll.at))} in ${homeRel(triggers.lastPoll.cwd)} — ${triggers.lastPoll.outcome}` : "none yet"}`,
							`  push trigger sources: ${mcpConfigs.length} configured MCP server(s) feed server-pushed events into the same trigger runtime${mcpConfigError ? ` (config error: ${mcpConfigError})` : ""}`,
							`  running: ${triggers.runningList().length} · deduped: ${triggers.dedupedCount} · storage: ${homeRel(store.rulesFile)}`,
							`  audit: ${homeRel(store.auditFile)} (/triggers audit [N])`,
						]);
						return;
					}
					case "rules": {
						const all = store.load();
						const here = all.filter((r) => r.cwd === session.cwd);
						const elsewhere = all.length - here.length;
						const lines = here.length ? ruleLines(here, true) : ["none"];
						if (elsewhere) lines.push(`  + ${elsewhere} rule${elsewhere === 1 ? "" : "s"} in other projects — /triggers rules --all`);
						if (rest.trim() === "--all") {
							show(ctx, `Dynamic trigger rules (this machine, ${all.length}):`, all.length ? ruleLines(all, false) : ["none"]);
							return;
						}
						show(ctx, `Dynamic trigger rules (${here.length}):`, lines);
						return;
					}
					case "sources":
					case "hooks": {
						const lines: string[] = [];
						lines.push(`  - source #1: ${started ? (scheduler.isLeader ? "connected" : "standby") : "disabled"} queued=${triggers.runningList().filter((r) => r.sourceLabel === "local:dynamic").length} dropped=0 deduped=${triggers.dedupedCount} last_event=${triggers.lastPoll?.at ?? "never"}`);
						lines.push("      subscriptions: dynamic trigger periodic check");
						mcpSources.forEach((s, i) => {
							const st = s.status;
							lines.push(`  - source #${i + 2}: ${st.state}${st.reason ? ` (${previewRedacted(st.reason, 80)})` : ""} queued=${st.queuedCount} dropped=${st.droppedCount} deduped=${st.dedupedCount} last_event=${st.lastEventAt ?? "never"}${st.requiresAttention ? `  ! ${st.requiresAttention}` : ""}`);
							lines.push(`      subscriptions: ${st.subscriptionLabels.join(", ")}${s.config.injectAndRun ? " [inject_and_run]" : s.config.injectSummary ? " [inject_summary]" : ""} (${s.config.kind}, ${s.config.source}) · tools: ${(mcpToolNames.get(s.config.name) ?? []).length ? (mcpToolNames.get(s.config.name) ?? []).join(", ") : "none"}`);
							if (st.lastError) lines.push(`      last error: ${previewRedacted(st.lastError, 160)}`);
						});
						if (mcpSources.length && started && !scheduler.isLeader) lines.push(`  (notifications are consumed by the timer owner; ${mcpStandbyIgnored} ignored here as standby)`);
						if (mcpConfigError) lines.push(`  ! ${mcpConfigError}`);
						show(ctx, `Trigger sources (${1 + mcpSources.length}):`, lines);
						return;
					}
					case "enable":
					case "resume":
					case "disable":
					case "pause": {
						const rule = pickRule(rest);
						if (!rule) return;
						const enable = sub === "enable" || sub === "resume";
						await store.setEnabled(rule.id, enable);
						ctx.ui.notify(`${enable ? "enabled" : "disabled"} trigger ${rule.id}`, "info");
						return;
					}
					case "remove":
					case "rm":
					case "delete": {
						if (rest.trim() === "--all") {
							const n = await store.clear();
							ctx.ui.notify(`removed ${n} dynamic trigger rule(s)`, "info");
							return;
						}
						const rule = pickRule(rest);
						if (!rule) return;
						await store.remove(rule.id);
						show(ctx, `removed trigger ${rule.id}`, [`  condition: ${previewRedacted(rule.condition, 120)}`, `  action: ${previewRedacted(rule.action, 120)}`]);
						return;
					}
					case "running": {
						const running = [
							...triggers.runningList().map((r) => ({ traceId: r.traceId, sourceLabel: r.sourceLabel, eventLabel: r.eventLabel, startedAt: r.startedAt, promptPreview: r.promptPreview })),
							...scheduler.runningRuns().map((r) => ({ traceId: r.runId, sourceLabel: "Cron", eventLabel: r.jobId, startedAt: r.startedAt, promptPreview: r.promptPreview })),
						];
						show(ctx, running.length ? `Running triggers (${running.length}):` : "(no running triggers)", running.flatMap((r) => [`  - ${r.traceId}  ${r.sourceLabel} / ${r.eventLabel}  since ${r.startedAt}`, `      prompt: ${previewRedacted(r.promptPreview, 120)}`]));
						return;
					}
					case "audit": {
						const limit = Number.parseInt(rest, 10) || 10;
						const rows = store.listAudit(limit);
						show(
							ctx,
							rows.length ? `Recent trigger audit (${rows.length}):` : "(no trigger audit entries)",
							rows.flatMap((r) => {
								const lines = [`  - ${r.ts}  ${r.type}/${r.state}  trace=${r.traceId.slice(0, 8)}  ${r.sourceLabel ?? "-"} / ${r.eventLabel ?? "-"}`];
								if (r.summary) lines.push(`      ${previewRedacted(r.summary, 160)}`);
								const d = r.details as any;
								if (d?.evaluator_decision?.outcome) lines.push(`      decision: ${d.evaluator_decision.outcome}${d.evaluator_decision.permission ? `, permission: ${d.evaluator_decision.permission}` : ""}`);
								if (d?.previous_trace_id) lines.push(`      previous_trace_id: ${String(d.previous_trace_id).slice(0, 8)}`);
								if (Array.isArray(d?.matched_rule_ids) && d.matched_rule_ids.length) lines.push(`      matched: ${d.matched_rule_ids.join(", ")}`);
								if (d?.session_file) lines.push(`      transcript: pi --session ${d.session_file}`);
								return lines;
							}),
						);
						return;
					}
					case "abort": {
						if (rest.trim() === "--all") {
							let n = triggers.abortAll();
							for (const r of scheduler.runningRuns()) if (scheduler.abortRun(r.runId)) n++;
							ctx.ui.notify(`requested abort for ${n} running trigger(s)`, "info");
							return;
						}
						const target = rest.trim();
						const hit = triggers.runningList().find((r) => r.traceId === target || r.traceId.startsWith(target));
						const cronHit = scheduler.runningRuns().find((r) => r.runId === target || r.runId.startsWith(target));
						if (!target || (!hit && !cronHit)) {
							ctx.ui.notify(target ? `no running trigger with trace_id '${target}'` : "usage: /triggers abort <trace_id>|--all", "warning");
							return;
						}
						if (hit) triggers.abort(hit.traceId);
						if (cronHit) scheduler.abortRun(cronHit.runId);
						ctx.ui.notify(`requested abort for trigger ${hit?.traceId ?? cronHit?.runId}`, "info");
						return;
					}
					case "panel": {
						const on = rest.trim() === "on" ? true : rest.trim() === "off" ? false : !panelEnabled;
						setPanelEnabled(on);
						ctx.ui.notify(`panel ${on ? "on" : "off"}`, "info");
						return;
					}
					case "help":
						show(ctx, "/triggers", [`usage: /triggers ${TRIGGERS_USAGE}`, "create one: /new-trigger when ~/build.done exists, run cargo test and show me the result", "config: ~/.pi/agent/loops/config.toml [triggers] poll_interval_secs, mcp.toml for push sources, hooks.toml for lifecycle hooks"]);
						return;
					default:
						ctx.ui.notify(`unknown /triggers command: ${sub}. usage: /triggers ${TRIGGERS_USAGE}`, "warning");
				}
			} catch (err: any) {
				ctx.ui.notify(`triggers: ${err?.message ?? err}`, "error");
			}
		},
	});

	/* ------------------------------------------------ session archives */


	const ARCHIVE_WARNING = `warning: ${ARCHIVE_EXT} archives include transcript and tool history. They do not include separate auth stores, provider credentials, OAuth tokens, MCP config, or the inbox.`;

	pi.registerCommand("session-export", {
		description: `Export this session + its cron jobs, trigger rules and loop state to a ${ARCHIVE_EXT} archive (pie's /session export)`,
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = args.split(/\s+/).filter(Boolean);
			const excludeTriggers = parts.includes("--exclude-triggers");
			const pathArgs = parts.filter((p) => !p.startsWith("--"));
			if (pathArgs.length > 1) {
				ctx.ui.notify("usage: /session-export [path] [--exclude-triggers]", "warning");
				return;
			}
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("this session is ephemeral (--no-session); nothing to export", "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const outputPath = path.resolve(session.cwd, pathArgs[0] ?? defaultExportPath(session.cwd, sessionId));
			try {
				const jobs = scheduler.store.load().filter((j) => j.cwd === session.cwd);
				const rules = triggers.store.load().filter((r) => r.cwd === session.cwd);
				const states: Record<string, string> = {};
				for (const j of jobs) {
					const st = j.stateful ? scheduler.store.readState(j.id) : undefined;
					if (st) states[j.id] = st;
				}
				const summary = exportSession({ sessionFile, cwd: session.cwd, jobs, rules, states, excludeTriggers, outputPath, piVersion: PI_VERSION, piLoopsVersion: PI_LOOPS_VERSION });
				show(ctx, `exported session archive: ${homeRel(summary.outputPath)}`, [
					ARCHIVE_WARNING,
					`session ${summary.sessionId.slice(0, 16)} entries=${summary.entryCount} triggers=${summary.hasTriggers ? "yes" : "no"} cron=${summary.hasCron ? "yes" : "no"} loop_state=${summary.loopStateCount}`,
				]);
			} catch (err: any) {
				ctx.ui.notify(`session export failed: ${err?.code === "EEXIST" ? `${homeRel(outputPath)} already exists (refusing to overwrite)` : (err?.message ?? err)}`, "error");
			}
		},
	});

	pi.registerCommand("session-import", {
		description: `Import a ${ARCHIVE_EXT} archive: new session file here, cron jobs / trigger rules / loop state restored (pie's /session import)`,
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = args.split(/\s+/).filter(Boolean);
			let activate = false;
			let resume = false;
			let targetCwd = session.cwd;
			const positional: string[] = [];
			for (let i = 0; i < parts.length; i++) {
				const p = parts[i];
				if (p === "--resume") resume = true;
				else if (p.startsWith("--activate-triggers=")) {
					const v = p.slice("--activate-triggers=".length);
					if (v === "on") activate = true;
					else if (v === "off") activate = false;
					else {
						ctx.ui.notify(`--activate-triggers=${v} is not supported (use on|off)`, "warning");
						return;
					}
				} else if (p === "--cwd") targetCwd = path.resolve(session.cwd, parts[++i] ?? ".");
				else positional.push(p);
			}
			if (positional.length !== 1) {
				ctx.ui.notify("usage: /session-import <path> [--activate-triggers=on|off] [--cwd <dir>] [--resume]", "warning");
				return;
			}
			const archivePath = path.resolve(session.cwd, positional[0]);
			try {
				const store = scheduler.store;
				const imp = importSession({
					archivePath,
					sessionDir: ctx.sessionManager.getSessionDir(),
					targetCwd,
					activate,
					existingJobIds: new Set(store.load().map((j) => j.id)),
					existingRuleIds: new Set(triggers.store.load().map((r) => r.id)),
				});
				for (const job of imp.jobs) {
					await store.add(job);
					cronControlAudit("add", "slash", undefined, job);
				}
				for (const [id, text] of Object.entries(imp.states)) store.writeState(id, text);
				if (imp.rules.length) await triggers.store.mutate((rules) => rules.push(...imp.rules));
				refreshBadge();
				show(ctx, `imported session: ${imp.sessionId.slice(0, 16)}`, [
					ARCHIVE_WARNING,
					`path: ${homeRel(imp.sessionPath)}`,
					`entries=${imp.entryCount} triggers=${imp.rules.length} cron=${imp.jobs.length} loop_state=${Object.keys(imp.states).length} automation=${imp.automationEnabled ? "enabled" : "disabled"}`,
					`resume with: pi --session ${imp.sessionPath}`,
				]);
				// pie's SessionImportActivation: offer to switch originally-enabled automation back on.
				const pending = imp.originallyEnabledJobs.length + imp.originallyEnabledRules.length;
				if (!activate && pending && ctx.hasUI) {
					const ok = await ctx.ui.confirm("Enable imported automation?", `${imp.originallyEnabledJobs.length} cron job(s) and ${imp.originallyEnabledRules.length} trigger rule(s) were enabled in the source session. Enable them here now?`);
					if (ok) {
						for (const id of imp.originallyEnabledJobs) {
							const before = store.load().find((j) => j.id === id);
							const after = await store.update(id, (j) => {
								j.enabled = true;
							});
							if (before && after) cronControlAudit("enable", "slash", before, after);
						}
						for (const id of imp.originallyEnabledRules) await triggers.store.setEnabled(id, true);
						refreshBadge();
						ctx.ui.notify(`enabled ${imp.originallyEnabledJobs.length} cron job(s) and ${imp.originallyEnabledRules.length} trigger rule(s)`, "info");
					}
				}
				if (resume) await ctx.switchSession(imp.sessionPath);
			} catch (err: any) {
				ctx.ui.notify(`session import failed: ${err?.message ?? err}`, "error");
			}
		},
	});

	pi.registerCommand("new-trigger", {
		description: "Create a dynamic natural-language trigger rule — /new-trigger <request>",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			if (!args.trim()) {
				ctx.ui.notify("usage: /new-trigger <natural-language trigger request>", "warning");
				return;
			}
			const prompt =
				"The user asked pi to create a dynamic trigger. Extract the trigger condition and action from the request, then call new_trigger with structured condition and action fields. Dynamic triggers fire once by default; set fire_once=false only when the user explicitly asks for a repeating trigger. Trigger output is shown in the TUI and audit by default; set promote_to_chat=true only when the user explicitly asks for trigger results to enter the main chat context or be visible to future turns. Do not require a fixed syntax. If either the condition or action is missing, ask one concise clarification question instead of calling tools.\n\nUser request:\n" +
				args.trim();
			pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});

	/* ------------------------------------------------------------ tools */

	/**
	 * pie classifies trigger creation/removal and cron enable as `PermissionClassification::Prompt`:
	 * the user confirms before the tool runs. pi has no built-in permission popups, so the tool
	 * asks through ctx.ui.confirm itself. Without a UI the call is refused rather than silently allowed.
	 */
	async function confirmTool(ctx: ExtensionContext, title: string, reason: string): Promise<string | undefined> {
		if (!ctx.hasUI) return `${reason} requires interactive confirmation; use the slash command instead`;
		const ok = await ctx.ui.confirm(title, reason);
		return ok ? undefined : `user declined: ${reason}`;
	}
	const deny = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: { id: undefined as string | undefined } });

	/** pie's `render_trigger_rules_for_tool`. */
	function renderTriggerRulesForTool(rules: ReturnType<TriggerStore["load"]>): string {
		if (!rules.length) return "dynamic trigger rules: none";
		return [`dynamic trigger rules: ${rules.length}`, ...rules.map((r) => `- ${r.id} [${r.enabled ? "enabled" : "disabled"}, ${r.fireOnce ? "fire_once" : "repeat"}, ${r.promoteToChat ? "promote_to_chat" : "audit_only"}] created_at=${r.createdAt} condition: ${previewRedacted(r.condition, 200)} action: ${previewRedacted(r.action, 200)}${r.cwd !== session.cwd ? ` cwd: ${r.cwd}` : ""}`)].join("\n");
	}

	/** pie's `render_cron_jobs_for_tool`. */
	function renderCronJobsForTool(jobs: LoopJob[]): string {
		if (!jobs.length) return "cron jobs: none";
		const now = Date.now();
		const lines = [`cron jobs: ${jobs.length}`];
		for (const job of jobs) {
			lines.push(`- ${job.id}${job.name ? ` "${job.name}"` : ""} [${job.enabled ? "enabled" : "disabled"}${job.stateful ? ", stateful" : ""}${job.verify ? ", verify" : ""}] schedule: ${formatSchedule(job.schedule)} action: ${previewRedacted(job.prompt, 120)}${job.cwd !== session.cwd ? ` cwd: ${job.cwd}` : ""}`);
			const next = job.enabled ? computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined }, now) : undefined;
			if (next) lines.push(`  next_run: ${new Date(next).toISOString()}`);
			if (job.running) lines.push(`  running_run_id: ${job.running.runId}`);
			if (job.lastError) lines.push(`  last_error: ${previewRedacted(job.lastError, 120)}`);
			if (job.skippedOverlap) lines.push(`  skipped_overlap_count: ${job.skippedOverlap}`);
		}
		return lines.join("\n");
	}

	if (!isChild) {
		pi.registerTool({
			name: "new_trigger",
			label: "Create trigger",
			description:
				"Create an event/condition-based dynamic trigger rule. Use this for future events such as a browser tab, file, MCP notification, webhook, or other condition becoming true. Do not use this for fixed time, recurring, scheduled, hourly, daily, weekly, cron, crontab, 定时任务, 每小时, or similar time-based jobs; use cron_create instead.",
			parameters: Type.Object({
				condition: Type.Optional(Type.String({ description: "The natural-language condition that should be evaluated against future trigger events." })),
				action: Type.Optional(Type.String({ description: "The action to perform when the condition matches. This may be a shell command or a natural-language instruction." })),
				spec: Type.Optional(Type.String({ description: "Fallback complete trigger rule text when condition and action cannot be supplied separately." })),
				fire_once: Type.Optional(Type.Boolean({ description: "Whether to disable the rule after the first successful match. Defaults to true unless the user explicitly asks for a repeating trigger." })),
				promote_to_chat: Type.Optional(Type.Boolean({ description: "Whether successful trigger output should be inserted into the parent chat context so future turns can see it. Defaults to false unless the user explicitly asks for that behavior." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if ([params.condition, params.action, params.spec].some((t) => t && looksLikeFixedScheduleRequest(t))) return deny("fixed scheduled jobs must use cron_create, not new_trigger");
				let condition = params.condition?.trim() ?? "";
				let action = params.action?.trim() ?? "";
				const fromSpec = !condition || !action;
				if (fromSpec) {
					if (!params.spec) return deny("missing required args: provide condition and action");
					try {
						({ condition, action } = parseTriggerRule(params.spec));
					} catch (err: any) {
						return deny(err?.message ?? String(err));
					}
				}
				const reason = fromSpec ? "create dynamic trigger from `spec` field" : "create dynamic trigger from `condition` + `action` fields";
				const denied = await confirmTool(ctx, "Create dynamic trigger", `${reason}\nwhen ${previewRedacted(condition, 120)}\n-> ${previewRedacted(action, 120)}`);
				if (denied) return deny(denied);
				const rule = await triggers.store.add({ condition, action, fireOnce: params.fire_once ?? true, promoteToChat: params.promote_to_chat ?? false, cwd: session.cwd, sessionId: session.sessionId });
				refreshBadge();
				return {
					content: [{ type: "text", text: `created dynamic trigger ${rule.id}\ncondition: ${rule.condition}\naction: ${rule.action}\nfire_once: ${rule.fireOnce}\npromote_to_chat: ${rule.promoteToChat}\n(checked every ${triggers.pollIntervalSecs}s by a background sub-agent)` }],
					details: { id: rule.id as string | undefined, condition: rule.condition, action: rule.action, enabled: rule.enabled, fire_once: rule.fireOnce, fired_at: rule.firedAt, promote_to_chat: rule.promoteToChat },
				};
			},
		});
		pi.registerTool({
			name: "list_triggers",
			label: "List triggers",
			description: "List dynamic trigger rules currently registered. Use this when the user asks to view, list, show, inspect, or find trigger ids.",
			parameters: Type.Object({}),
			async execute() {
				const rules = triggers.store.load();
				return { content: [{ type: "text", text: renderTriggerRulesForTool(rules) }], details: { count: rules.length, rules, storage_path: triggers.store.rulesFile } };
			},
		});
		pi.registerTool({
			name: "remove_trigger",
			label: "Remove trigger",
			description: "Delete dynamic trigger rules. Use this when the user asks to delete, remove, or clear an existing dynamic trigger.",
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "The exact dynamic trigger rule id to remove." })),
				all: Type.Optional(Type.Boolean({ description: "Set true only when the user explicitly asks to remove all dynamic trigger rules." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: { removed_count: 0 } });
				if (params.all) {
					const denied = await confirmTool(ctx, "Remove ALL dynamic triggers", "remove ALL dynamic triggers");
					if (denied) return err(denied);
					const n = await triggers.store.clear();
					return { content: [{ type: "text", text: `removed ${n} dynamic trigger rule(s)` }], details: { removed_count: n } };
				}
				if (!params.id) return err("missing required arg: id");
				const rule = resolveRuleRef(triggers.store.load(), params.id);
				if (!rule) return err(`no dynamic trigger rule with id '${params.id}'`);
				const denied = await confirmTool(ctx, "Remove dynamic trigger", `remove dynamic trigger \`${rule.id}\`\nwhen ${previewRedacted(rule.condition, 120)}`);
				if (denied) return err(denied);
				await triggers.store.remove(rule.id);
				return { content: [{ type: "text", text: `removed dynamic trigger ${rule.id}\ncondition: ${rule.condition}\naction: ${rule.action}` }], details: { removed_count: 1 } };
			},
		});
		pi.registerTool({
			name: "set_trigger_state",
			label: "Enable/disable trigger",
			description: "Enable or disable an existing dynamic trigger rule without deleting it. Use this when the user asks to pause, disable, enable, or resume a trigger.",
			parameters: Type.Object({
				id: Type.String({ description: "The exact dynamic trigger rule id to update." }),
				enabled: Type.Boolean({ description: "Set false to pause or disable the trigger; set true to enable or resume it." }),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const rule = resolveRuleRef(triggers.store.load(), params.id);
				if (!rule) return deny(`no dynamic trigger rule with id '${params.id}'`);
				if (params.enabled) {
					const denied = await confirmTool(ctx, "Re-enable dynamic trigger", `re-enable dynamic trigger \`${rule.id}\``);
					if (denied) return deny(denied);
				}
				const updated = (await triggers.store.setEnabled(rule.id, params.enabled)) ?? rule;
				return {
					content: [{ type: "text", text: `updated dynamic trigger ${updated.id}\nstate: ${updated.enabled ? "enabled" : "disabled"}\ncondition: ${updated.condition}\naction: ${updated.action}` }],
					details: { id: updated.id as string | undefined, condition: updated.condition, action: updated.action, enabled: updated.enabled, fire_once: updated.fireOnce, fired_at: updated.firedAt, promote_to_chat: updated.promoteToChat },
				};
			},
		});

		pi.registerTool({
			name: "cron_create",
			label: "Create cron job",
			description:
				"Create a scheduled job (like pie's NewCronJob). Use when the user asks for a fixed time, recurring, scheduled, hourly, daily, weekly, crontab, 定时任务, 每小时, 每天, or similar time-based job. Jobs persist across pi restarts. A plain job runs its prompt in this chat when due. Set stateful=true for loop mode: a fresh sub-agent runs it, keeps persistent notes across runs (injected each time), and routes findings to the user's /inbox instead of the chat — use that for recurring watch/triage jobs like \"check for new issues and report only what changed\".",
			parameters: Type.Object({
				schedule: Type.String({
					description: 'Local-time schedule: 5-field cron ("0 9 * * *", "*/30 * * * 1-5"), "@daily", "every 30m", "in 10m", or "at 2026-09-08T18:00".',
				}),
				action: Type.String({ description: "Natural-language instruction to run when the schedule is due. For stateful jobs, write it for a fresh agent whose only memory is its own notes." }),
				stateful: Type.Optional(Type.Boolean({ description: "Loop mode: sub-agent + notes between runs + findings to /inbox (default false)." })),
				verify: Type.Optional(Type.Boolean({ description: "Maker/checker: a second adversarial sub-agent verifies each finding before it enters the inbox (stateful jobs only, default false). Use when the user asks for verified, double-checked, or high-precision findings." })),
				name: Type.Optional(Type.String({ description: "Short unique label (letters, digits, . _ -)." })),
				cwd: Type.Optional(Type.String({ description: "Directory a stateful job's sub-agent runs in. Default: current project." })),
				catch_up: Type.Optional(Type.Boolean({ description: "Run once at startup if a tick was missed while no pi was open (default true)." })),
			}),
			async execute(_id, params) {
				const schedule = parseSchedule(params.schedule);
				const job = await createJob({
					schedule,
					prompt: params.action,
					stateful: params.stateful ?? false,
					verify: params.verify ?? false,
					name: params.name,
					cwd: params.cwd,
					catchUp: params.catch_up ?? true,
				});
				cronControlAudit("add", "tool", undefined, job);
				refreshBadge();
				const next = computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt) }, Date.now());
				const where = job.stateful ? `Findings will appear in /inbox${job.verify ? " after an independent checker reviews them" : ""}.` : "Its result will appear in this chat.";
				return {
					content: [{ type: "text", text: `Created cron job ${job.id}${job.name ? ` "${job.name}"` : ""}${job.stateful ? " [stateful]" : ""}${job.verify ? " [verify]" : ""}: ${formatSchedule(job.schedule)}, next run ${next ? formatLocal(next) : "—"}. ${where}` }],
					details: { id: job.id, name: job.name, stateful: job.stateful, schedule: formatSchedule(job.schedule), next },
				};
			},
		});

		pi.registerTool({
			name: "cron_list",
			label: "List cron jobs",
			description: "List the user's scheduled jobs with schedule, next run, [stateful] marker and last error. Also reports how many unread inbox findings exist.",
			parameters: Type.Object({}),
			async execute() {
				const jobs = scheduler.store.load();
				const text = `${renderCronJobsForTool(jobs)}\ninbox: ${scheduler.inbox.newCount()} new finding(s)`;
				return { content: [{ type: "text", text }], details: { count: jobs.length, scope: "machine", storage_path: scheduler.store.jobsFile, jobs: jobs.map((j) => ({ id: j.id, name: j.name, schedule: formatSchedule(j.schedule), action_preview: previewRedacted(j.prompt, 120), enabled: j.enabled, stateful: j.stateful, verify: j.verify ?? false, cwd: j.cwd, running_run_id: j.running?.runId, last_fired_at: j.lastFiredAt, last_completed_at: j.lastCompletedAt, last_error: j.lastError ? previewRedacted(j.lastError, 120) : undefined, skipped_overlap_count: j.skippedOverlap, created_at: j.createdAt })) } };
			},
		});

		pi.registerTool({
			name: "cron_remove",
			label: "Remove cron job",
			description:
				"Preview or confirm removal of a scheduled job by id or name. Use confirm=false first when the user asks to delete, remove, or clear a scheduled job, cron job, crontab entry, or 定时任务. Call confirm=true only after the user explicitly confirms removal. Removal also deletes the job's saved notes and transcripts.",
			parameters: Type.Object({
				ref: Type.String({ description: "Job id (for example cron-abc123), unique id prefix, or name." }),
				confirm: Type.Optional(Type.Boolean({ description: "false to preview the removal; true only after explicit user confirmation." })),
			}),
			async execute(_id, params) {
				const job = resolveJobRef(scheduler.store.load(), params.ref);
				if (!job) return { content: [{ type: "text", text: `no cron job with id '${params.ref}'` }], isError: true, details: { id: undefined as string | undefined, removed_count: 0, confirmation_required: false } };
				const label = `${job.id}${job.name ? ` "${job.name}"` : ""}`;
				if (!params.confirm) {
					return {
						content: [{ type: "text", text: `remove cron job ${label} requires confirmation\nschedule: ${formatSchedule(job.schedule)}\naction: ${previewRedacted(job.prompt, 120)}\ncall cron_remove again with confirm=true only after the user confirms` }],
						details: { id: job.id as string | undefined, removed_count: 0, confirmation_required: true },
					};
				}
				await scheduler.store.remove(job.id);
				cronControlAudit("remove", "tool", job, undefined);
				return { content: [{ type: "text", text: `removed cron job ${label}\nschedule: ${formatSchedule(job.schedule)}\naction: ${previewRedacted(job.prompt, 120)}` }], details: { id: job.id as string | undefined, removed_count: 1, confirmation_required: false } };
			},
		});

		pi.registerTool({
			name: "set_cron_job_state",
			label: "Enable/disable cron job",
			description: "Disable (pause) or enable (resume) a scheduled job by id or name. Enabling asks the user to confirm first.",
			parameters: Type.Object({
				ref: Type.String({ description: "Job id (for example cron-abc123), unique id prefix, or name." }),
				enabled: Type.Boolean({ description: "true to enable/resume the cron job; false to disable/pause it." }),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const job = resolveJobRef(scheduler.store.load(), params.ref);
				if (!job) return deny(`no cron job with id '${params.ref}'`);
				if (params.enabled) {
					const denied = await confirmTool(ctx, "Enable cron job", `enable cron job \`${job.name ?? job.id}\` (${formatSchedule(job.schedule)})`);
					if (denied) return deny(`${denied}; use /cron enable <id>`);
				}
				const updated = (await scheduler.store.update(job.id, (j) => {
					j.enabled = params.enabled;
					if (params.enabled) j.lastError = undefined;
				})) ?? job;
				cronControlAudit(params.enabled ? "enable" : "disable", "tool", job, updated);
				return {
					content: [{ type: "text", text: `updated cron job ${updated.id}\nstate: ${updated.enabled ? "enabled" : "disabled"}\nschedule: ${formatSchedule(updated.schedule)}\naction: ${previewRedacted(updated.prompt, 120)}` }],
					details: { id: updated.id as string | undefined, schedule: formatSchedule(updated.schedule), enabled: updated.enabled, stateful: updated.stateful },
				};
			},
		});
	}

	/* -------------------------------------------------------- lifecycle */

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		session = snapshot(ctx);
		config = loadConfig(dir);
		const flagSecs = Number(pi.getFlag("trigger-poll-secs"));
		triggers.pollIntervalSecs = Number.isFinite(flagSecs) && flagSecs > 0 ? Math.floor(flagSecs) : config.triggerPollIntervalSecs;
		hookRunner = new HookRunner({ loopsDir: dir, projectCwd: ctx.cwd, allowProjectHooks: config.allowProjectHooks, getSession: () => session, warn: (m) => ctx.hasUI && ctx.ui.notify(`[hooks] ${m}`, "warning") });
		hookRunner.load();
		for (const e of [...config.errors, ...hookRunner.diagnostics]) if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${e}`, "warning");
		loadMcpConfig(ctx.isProjectTrusted());
		for (const d of mcpDiagnostics) if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${d}`, "warning");
		startMcpSources(); // tools for this session; notifications are consumed only by the timer owner
		const hostMode = ctx.mode === "tui" || ctx.mode === "rpc";
		if (isChild || !hostMode) return;
		scheduler.start();
		started = true;
		refreshBadge();
	});

	// pie's hooks.toml events, mapped from pi's lifecycle events.
	pi.on("agent_start", async (_e, ctx) => fireHook({ event: "agent_start" }, ctx));
	pi.on("turn_start", async (_e, ctx) => fireHook({ event: "turn_start" }, ctx));
	pi.on("turn_end", async (e, ctx) => fireHook({ event: "turn_end", message_kind: messageKind(e.message), message_summary: messageSummary(e.message) }, ctx));
	pi.on("message_start", async (e, ctx) => fireHook({ event: "message_start", message_kind: messageKind(e.message), message_summary: messageSummary(e.message) }, ctx));
	pi.on("message_update", async (e, ctx) => fireHook({ event: "message_update", message_kind: messageKind(e.message), message_summary: messageSummary(e.message), assistant_event: (e.assistantMessageEvent as any)?.type }, ctx));
	pi.on("message_end", async (e, ctx) => fireHook({ event: "message_end", message_kind: messageKind(e.message), message_summary: messageSummary(e.message) }, ctx));
	pi.on("tool_execution_start", async (e, ctx) => fireHook({ event: "tool_start", tool_call_id: e.toolCallId, tool_name: e.toolName, tool_args: e.args }, ctx));
	pi.on("tool_execution_update", async (e, ctx) => fireHook({ event: "tool_update", tool_call_id: e.toolCallId, tool_name: e.toolName, tool_args: e.args, tool_result_summary: resultSummary(e.partialResult) }, ctx));
	pi.on("tool_execution_end", async (e: any, ctx) => fireHook({ event: "tool_end", tool_call_id: e.toolCallId, tool_name: e.toolName, tool_is_error: !!e.isError, tool_result_summary: resultSummary(e.result) }, ctx));
	pi.on("session_compact", async (e, ctx) => fireHook({ event: "compaction", compaction_trigger: e.reason === "manual" ? "manual" : "auto", compaction_tokens_before: e.compactionEntry?.tokensBefore, compaction_summary: e.compactionEntry?.summary ? truncateSummary(e.compactionEntry.summary) : undefined }, ctx));

	pi.on("model_select", async (_event, ctx) => {
		session = snapshot(ctx);
	});
	pi.on("thinking_level_select", async (_event, ctx) => {
		session = snapshot(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		fireHook({ event: "agent_end" }, ctx);
		refreshBadge();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (started) {
			started = false;
			await triggers.stop();
			await scheduler.stop();
		}
		await stopMcpSources();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		if (ctx.mode === "tui") ctx.ui.setWidget(PANEL_KEY, undefined);
	});
}
