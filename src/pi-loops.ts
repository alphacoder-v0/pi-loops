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
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore, VERSION as PI_VERSION, getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ARCHIVE_EXT, defaultExportPath, exportSession, importSession } from "./archive.ts";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseAddArgs, parseSetArgs, splitCommand } from "./args.ts";
import { loadConfig } from "./config.ts";
import { GOAL_ENTRY, type GoalAction, type GoalState, MAX_CONTINUATIONS, applyDecision, continuationPrompt, evaluatorPrompt, latestGoal, newGoal, parseDecision, pauseFor, transcriptFromMessages } from "./goal.ts";
import { withinProject } from "./presence.ts";
import { isExactlyTrusted } from "./trust.ts";
import { HookRunner, type HookEventData, messageKind, messageSummary, resultSummary, truncateSummary } from "./hooks.ts";
import { type InboxEntry, resolveInboxRef } from "./inbox.ts";
import { McpPool } from "./mcp-pool.ts";
import { McpSource, PI_BUILTIN_TOOL_NAMES, type McpServerConfig, type McpToolDef, droppedNotificationMessage, loadMcpConfigFiles, mapNotification, mcpToolDefinitions, mcpTokenFromEnv } from "./mcp.ts";
import { capRedacted, previewRedacted, redact } from "./redact.ts";
import { createHash } from "node:crypto";
import { computeNext, formatLocal, formatSchedule, parseSchedule } from "./schedule.ts";
import { LoopScheduler, type SessionSnapshot } from "./scheduler.ts";
import { type LoopJob, type RunRecord, defaultLoopsDir, newId, resolveJobRef, sessionExists } from "./store.ts";
import { parentRuntimeFlags, type SubagentRequest } from "./runner.ts";
import { createInProcessRunner } from "./sdk-runner.ts";
import { askHost, renderHostSnapshot } from "./host-control-channel.ts";
import { HOST_LOG, crashedHost, hostPushWork, liveHost, piPackageDir, shouldHandOff, spawnHost, stopHost } from "./host-control.ts";
import { summarizeSessionFile } from "./transcript.ts";
import { TriggerRuntime, type TriggerOutcome } from "./trigger-runtime.ts";
import { TriggerStore, controlPlanePreflight, resolveRuleRef } from "./triggers.ts";
import { type ControlPlaneRequest, type CreateJobInput, type JobScope, type ToolHost, automationTools, createLoopJob } from "./tools.ts";
import * as fs from "node:fs";
import * as os from "node:os";

const VIEW_ENTRY = "pi-loops:view";
const STATUS_KEY = "pi-loops";
const GOAL_STATUS_KEY = "pi-loops-goal";
/** The evaluator is one tool-less read of a capped transcript; it must not hold a turn for 15 minutes. */
const GOAL_EVALUATOR_TIMEOUT_MS = 120_000;
import { PI_LOOPS_VERSION } from "./version.ts";

interface ViewData {
	title: string;
	lines: string[];
}

export default function piLoops(pi: ExtensionAPI) {
	/** Trigger hop (pie's cycle suppression): the interactive pi is 0; the sub-agents it runs are 1. */
	const hop = 0;
	/** `/cron host start|stop`: this pi's override of `[host] auto` for the hand-off when it quits. */
	let handOffOnQuit: boolean | undefined;
	const dir = defaultLoopsDir(getAgentDir());
	/** This package's directory: a sub-session must not load a second copy of this extension. */
	const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

	let session: SessionSnapshot = { cwd: process.cwd() };
	let lastCtx: ExtensionContext | undefined;
	let started = false;

	const snapshot = (ctx: ExtensionContext): SessionSnapshot => ({
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinking: ctx.thinkingLevel,
		trusted: ctx.isProjectTrusted(),
	});
	/**
	 * Sub-agents run inside this process through pi's SDK (pie's in-process SubAgent): the same
	 * live MCP clients, the parent's `-e` extensions, system prompt and skills, the parent's model
	 * unless the job pins one, its own transcript file. `customTools` hands each run the parent's
	 * MCP tools plus the automation tools at hop 1.
	 */
	const runner = createInProcessRunner({
		agentDir: getAgentDir(),
		parentFlags: parentRuntimeFlags(process.argv),
		getParentModel: () => lastCtx?.model,
		getParentThinking: () => session.thinking,
		getParentTools: () => pi.getActiveTools(),
		// The parent's own runtime: `pi --api-key`, `/login` and a rotated credential reach a run
		// through it, the way pie's sub-agent inherits the parent's stream_fn.
		getParentModelRuntime: () => lastCtx?.modelRegistry as any,
		// The tools act in the run's own project and model — a loop for project B that schedules a
		// follow-up must not pin it to whichever project this pi happens to be open in.
		customTools: async (req: SubagentRequest) => {
			const shared = allMcpToolDefs();
			const automation = automationTools({ hop: req.hop, actor: "sub-agent", parentSessionId: req.parentSessionId, parentCwd: req.parentCwd }, toolHostFor(req));
			// A run in another project gets that project's own MCP servers too — this process only
			// loaded its own project's, and a loop belongs to its project, not to this window.
			const taken = new Set([...PI_BUILTIN_TOOL_NAMES, ...pi.getAllTools().map((t) => t.name), ...shared.map((t) => t.name), ...automation.map((t) => t.name)]);
			const project = req.cwd && req.cwd !== session.cwd ? await mcpPool.toolsFor(req.cwd, taken) : [];
			return [...shared, ...project, ...automation];
		},
		// The project this session trusted, or one the user trusted before (pi's saved decisions); nothing else.
		// Exact trust only: a job's cwd can be model-chosen, and pi's inherited trust would make
		// every directory under a trusted repo (node_modules, a submodule, an extracted tarball)
		// able to load its own extensions and MCP servers in an unattended run. See src/trust.ts.
		isTrusted: (cwd) => (!!session.trusted && sameProject(cwd, session.cwd)) || isExactlyTrusted(getAgentDir(), cwd),
		ownDir: PACKAGE_DIR,
		log: (msg) => {
			if (lastCtx?.hasUI) lastCtx.ui.notify(`[sub-agent] ${msg}`, "warning");
		},
	});

	const scheduler: LoopScheduler = new LoopScheduler({
		dir,
		hop,
		getSession: () => session,
		getSettings: () => ({ maxConcurrentRuns: config.maxConcurrentRuns, catchUp: config.cronCatchUp }),
		runner,
		kind: "interactive",
		// pie loses a session's jobs with its sidecars; here a plain job whose session is gone is parked, /cron gc removes it.
		sessionExists: (id) => sessionExists(path.join(getAgentDir(), "sessions"), id),
		hooks: {
			onInject: (_job, prompt) => {
				if (!lastCtx) return;
				const idle = lastCtx.isIdle();
				pi.sendUserMessage(prompt, idle ? undefined : { deliverAs: "followUp" });
				triggeredTurnLine(prompt.match(/^\[Trigger ([^\]]+)\]/)?.[1] ?? "?", idle);
			},
			onRunStart: (job, runId) => {
				const summary = `cron \`${job.id}\`${job.name ? ` "${job.name}"` : ""} due at ${job.lastDueAt ?? job.lastFiredAt ?? new Date().toISOString()}: ${previewRedacted(job.prompt, 120)}`;
				triggers.store.appendAudit({ type: "trigger", traceId: runId, state: "accepted", sourceLabel: "Cron", eventLabel: job.id, summary, details: { delivery: job.stateful ? "sub_agent" : "inject_and_run", evaluator_decision: { outcome: "accept", permission: "allow" } } });
				triggers.store.appendAudit({ type: "trigger_result", traceId: runId, state: "running", sourceLabel: "Cron", eventLabel: job.id, details: { cwd: job.cwd } });
				refreshBadge();
			},
			onCatchUp: (job, dueAt) => {
				if (lastCtx?.hasUI && sameProject(job.cwd, session.cwd)) lastCtx.ui.notify(`cron ${job.name ?? job.id}: catching up the run missed at ${formatLocal(dueAt)}`, "info");
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
				// Another project's findings and prompt previews do not belong in this transcript; the
				// audit sink below and the inbox already carry them to where they do.
				if (sameProject(job.cwd, session.cwd)) showRunCard(lastCtx, job, record, findings);
			},
			onInboxChanged: () => refreshBadge(),
			// Dynamic triggers piggyback on the same 30s tick (leader only). MCP pushes are consumed
			// by every interactive process and deduplicated machine-wide (see startMcpSources).
			onTick: (now, leader): Promise<void> => triggers.tick(now, leader),
			onLeadership: async () => refreshBadge(),
			log: (msg) => {
				if (lastCtx?.hasUI) lastCtx.ui.notify(`[cron] ${msg}`, "info");
			},
			// A whole tick failing means nothing ran at all; that must not read like routine chatter,
			// and it has to be visible without a UI too.
			onSchedulerError: (msg) => {
				if (lastCtx?.hasUI) lastCtx.ui.notify(`[cron] ${msg}`, "warning");
				else process.stderr.write(`[pi-loops] ${msg}\n`);
			},
		},
	});

	/* ---------------------------------------------------------- triggers */

	let config = loadConfig(dir);
	// pie keeps trigger audit as session custom entries (trigger / trigger_result / trigger_promotion):
	// it resumes with the session and travels in archives. Same here, on top of the machine-wide JSONL.
	
	const triggers: TriggerRuntime = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: scheduler.store,
		getSession: () => session,
		pollIntervalSecs: config.triggerPollIntervalSecs,
		runTimeoutMs: config.triggerRunTimeoutMs,
		runner,
		dedupFile: path.join(dir, "dedup.json"),
		hop,
		// A project's checks run in a pi open in that project (pie's session scoping, restored by routing).
		self: scheduler.self,
		presence: () => scheduler.presenceList(),
		isLeader: () => scheduler.isLeader,
		hooks: {
			onPromote: async (content, trigger) => {
				// Promotion = the result becomes visible to future turns (pie inserts a `[Trigger …]` user
				// message into the parent session). Only into a chat that belongs to the rule's project;
				// a different project's chat gets nothing — the finding goes to the inbox instead.
				if (trigger.cwd && !sameProject(trigger.cwd, session.cwd)) {
					await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: content.replace(/^\[Trigger [^\]]+\]\s*/, ""), runId: trigger.traceId, jobId: trigger.sourceLabel, cwd: trigger.cwd });
					refreshBadge();
					return "inbox";
				}
				// pie: idle → inserted without a model call; streaming → follow-up queue, which runs a turn
				// once the current one ends so the agent sees it without waiting for the next prompt.
				if (lastCtx?.isIdle() ?? true) pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: false });
				else pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return "chat";
			},
			onInjectAndRun: async (prompt, trigger) => {
				if (trigger.cwd && !sameProject(trigger.cwd, session.cwd)) {
					await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: prompt.replace(/^\[Trigger [^\]]+\]\s*/, ""), runId: trigger.traceId, jobId: trigger.sourceLabel, cwd: trigger.cwd });
					refreshBadge();
					return "inbox";
				}
				const idle = lastCtx?.isIdle() ?? true;
				pi.sendUserMessage(prompt, idle ? undefined : { deliverAs: "followUp" });
				triggeredTurnLine(trigger.traceId, idle);
				return "chat";
			},
			onStarted: () => refreshBadge(),
			onFinished: (outcome) => {
				refreshBadge();
				if (lastCtx?.hasUI && (!outcome.trigger.cwd || sameProject(outcome.trigger.cwd, session.cwd))) showTriggerCard(lastCtx, outcome);
			},
			log: (msg) => {
				if (lastCtx?.hasUI) lastCtx.ui.notify(`[triggers] ${msg}`, "info");
			},
		},
	});
	triggers.store.onAudit = (record) => {
		if (!lastCtx) return;
		// Only this project's rows: the leader covering another project must not put that project's
		// output into this session (and its archives).
		if (record.cwd && !sameProject(record.cwd, session.cwd)) return;
		pi.appendEntry(record.type, record);
	};
	pi.registerFlag("trigger-poll-secs", { type: "string", description: "Dynamic trigger poll interval in seconds (pi-loops; default 600 or config.toml [triggers].poll_interval_secs)" });

	const mcpSources: McpSource[] = [];
	/** Project-level MCP servers of *other* projects, connected on demand for their loops. */
	const mcpPool = new McpPool({ isTrusted: (cwd) => isExactlyTrusted(getAgentDir(), cwd), resolveToken: resolveMcpToken, log: (m) => lastCtx?.hasUI && lastCtx.ui.notify(`[mcp] ${m}`, "warning") });
	let mcpConfigs: McpServerConfig[] = [];
	let mcpConfigError: string | undefined;
	const mcpDiagnostics: string[] = [];

	/** pie's `load_all`: user `mcp.toml` + project `.pi/mcp.toml` (same name → project wins). Project config needs project trust. */
	function loadMcpConfig(projectTrusted: boolean): void {
		mcpDiagnostics.length = 0;
		const loaded = loadMcpConfigFiles({ dir, cwd: session.cwd, projectTrusted });
		mcpConfigs = loaded.servers;
		mcpDiagnostics.push(...loaded.diagnostics);
		mcpConfigError = mcpDiagnostics.length ? mcpDiagnostics.join("; ") : undefined;
	}

	/** `auth.token_keychain_ref` → environment variable, then pi's credential store (`/login`-style api keys). */
	function resolveMcpToken(ref: string): string | undefined {
		const fromEnv = mcpTokenFromEnv(ref);
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
	/** The registered tool definitions per server — handed to every sub-session as customTools. */
	const mcpToolDefs = new Map<string, ToolDefinition<any, any>[]>();
	function allMcpToolDefs(): ToolDefinition<any, any>[] {
		return [...mcpToolDefs.values()].flat();
	}

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
		const defs = mcpToolDefs.get(source.config.name) ?? [];
		for (const { def } of mcpToolDefinitions(source, tools, new Set(pi.getAllTools().map((t) => t.name)), already)) {
			defs.push(def);
			pi.registerTool(def);
		}
		mcpToolNames.set(source.config.name, already);
		mcpToolDefs.set(source.config.name, defs);
	}

	/** What the running sources were started from, so a session swap can tell whether they still match. */
	let mcpRunningKey = "";
	const mcpConfigKey = (): string => JSON.stringify(mcpConfigs.map((c) => ({ ...c })));

	async function startMcpSources(): Promise<void> {
		// `/new`, `/resume` and `/reload` reload the config (and may change the project's trust)
		// without quitting. If what we are running no longer matches, restart the sources —
		// otherwise the panel would describe one set of servers while another kept running.
		if (mcpSources.length) {
			if (mcpRunningKey === mcpConfigKey()) return;
			await stopMcpSources();
			mcpToolDefs.clear();
			mcpToolNames.clear();
		}
		mcpRunningKey = mcpConfigKey();
		for (const cfg of mcpConfigs) {
			const source = new McpSource(cfg, {
				onConnected: (src) => registerMcpTools(src),
				onNotification: (n) => {
					// Every interactive process consumes what it receives; the machine-wide dedup window
					// (dedup.json) guarantees a push that several pi processes see is handled exactly
					// once, and the promotion hooks route results to the right project's chat or inbox.
					const trigger = mapNotification(cfg.name, n);
					if (!trigger) {
						source.status.droppedCount++;
						source.status.lastError = droppedNotificationMessage(n.method);
						return;
					}
					trigger.cwd = session.cwd;
					const delivery = cfg.injectAndRun ? "inject_and_run" : cfg.injectSummary ? "inject_summary" : "sub_agent";
					void triggers
						.handle(trigger, delivery)
						.then((out) => {
							if (!out) source.status.dedupedCount++;
						})
						.catch((err) => {
							try {
								if (lastCtx?.hasUI) lastCtx.ui.notify(`[triggers] ${err?.message ?? err}`, "warning");
							} catch {
								/* the notifier itself failed; nothing left to report to */
							}
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
		mcpRunningKey = "";
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

	async function fireHook(data: HookEventData, ctx?: ExtensionContext): Promise<void> {
		// Sub-agents are in-process sessions without this extension; only the interactive session fires hooks.
		if (!hookRunner?.hasHooksFor(data.event)) return;
		// pie awaits its hook listener inline, so a hook always completes before the agent moves on
		// (and nothing is lost at exit). `[hooks] mode = "async"` restores the queued-off-turn behavior.
		if (config.hooksMode === "async") void hookRunner.fire(data, ctx?.signal);
		else await hookRunner.fire(data, ctx?.signal);
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
		try {
			refreshPanelInner();
		} catch (err: any) {
			storeReadFailed(err);
		}
	}

	function refreshPanelInner(): void {
		if (!lastCtx || lastCtx.mode !== "tui") return;
		if (!panelEnabled || !started) {
			lastCtx.ui.setWidget(PANEL_KEY, undefined);
			return;
		}
		const rules = triggers.store.load().filter((r) => sameProject(r.cwd, session.cwd));
		const jobs = scheduler.store.load().filter((j) => sameProject(j.cwd, session.cwd));
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
			}
			if (poll) {
				// pie's Polling section: checked_at · outcome, source / event, trace, summary.
				lines.push(head("Polling") + warn(`  ${formatLocal(Date.parse(poll.at))} · ${poll.outcome}`));
				lines.push(dim(`  ${poll.sourceLabel} / ${poll.eventLabel}  trace ${poll.traceId.slice(0, 8)}`));
				lines.push(dim(`    ${clip(poll.summary, 80)}`));
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
				const tools = sources.reduce((n, s) => n + s.tools, 0);
				lines.push(head("MCP") + dim(`  servers ${sources.length} · tools ${tools} · notification hooks ${sources.length}`));
				lines.push(sources.map((src) => (src.state === "connected" ? ok : src.state === "disabled" ? dim : warn)(`  ${src.name} ${src.state}${src.tools ? ` · ${src.tools} tool${src.tools === 1 ? "" : "s"}` : ""}`)).join(""));
			}
			const hookCount = hookRunner?.hooks.length ?? 0;
			lines.push(head("Hooks") + dim(hookCount ? `  cli_hooks ${hookCount} rule${hookCount === 1 ? "" : "s"} (${[...new Set(hookRunner!.hooks.map((h) => h.event))].join(", ")})` : "  none"));
			lines.push(head("Runtime") + dim("  dedup · cycle suppress · fire-once rules · inject-and-run"));
			const text = new Text(lines.join("\n"), 0, 0);
			return text;
		});
	}

	/** pie's TUI system line when an inject-and-run turn starts (or is queued behind the current one). */
	function triggeredTurnLine(traceId: string, idle: boolean): void {
		if (!lastCtx?.hasUI) return;
		lastCtx.ui.notify(idle ? `running triggered turn (trace ${traceId.slice(0, 8)})` : `queued triggered turn (trace ${traceId.slice(0, 8)}) after the current one`, "info");
	}

	/**
	 * A corrupt or truncated store must not take the session down with it. Both of these read the
	 * stores, and both are reached from the tick (`onLeadership` → `refreshBadge`) which runs as
	 * `void this.tick()` — pi installs no `unhandledRejection` handler, so a throw here kills pi.
	 */
	function refreshBadge(): void {
		try {
			refreshBadgeInner();
		} catch (err: any) {
			storeReadFailed(err);
		}
	}

	let storeErrorShown: string | undefined;
	function storeReadFailed(err: any): void {
		const message = err?.message ?? String(err);
		if (message === storeErrorShown) return; // say it once per distinct problem, not once per tick
		storeErrorShown = message;
		if (lastCtx?.hasUI) lastCtx.ui.notify(`[cron] cannot read the automation store: ${message}`, "warning");
		else process.stderr.write(`[pi-loops] cannot read the automation store: ${message}\n`);
	}

	function refreshBadgeInner(): void {
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
	/** A run that fell back or retried looks identical to a clean one unless it is said out loud. */
	function runNotes(record: { warning?: string; retries?: number; compactions?: number }): string[] {
		const notes: string[] = [];
		if (record.warning) notes.push(`! ${previewRedacted(record.warning, 200)}`);
		if (record.retries) notes.push(`  ${record.retries} provider retry/retries`);
		if (record.compactions) notes.push(`  ${record.compactions} context compaction(s)`);
		return notes;
	}

	function showRunCard(ctx: ExtensionContext, job: LoopJob, record: RunRecord, findings: string[]): void {
		const label = job.name ?? job.id;
		const secs = Math.max(0, Math.round((Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000));
		const cost = record.usage?.cost ? ` · $${record.usage.cost.toFixed(3)}` : "";
		const title = record.ok
			? `cron ${label} · ${secs}s${cost} · ${findings.length} finding${findings.length === 1 ? "" : "s"}${record.checker?.ok ? " (verified)" : ""}${record.stateUpdated ? " · state updated" : ""}`
			: `cron ${label} FAILED · ${secs}s`;
		const lines: string[] = [];
		if (!record.ok) lines.push(`! ${record.error ?? "unknown error"}`);
		lines.push(...runNotes(record as any));
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
		const here = os.hostname();
		return jobs.map((job, i) => {
			// A job stamped with another machine's hostname is filtered out by the scheduler
			// (`job.host !== os.hostname()`), so promising a next run would be a lie. This also
			// catches a renamed machine or a rebuilt container, which needs no second machine at all.
			const elsewhere = job.host && job.host !== here ? `[other host: ${job.host} — /cron set ${i + 1} --host here]` : undefined;
			const next = job.enabled && !elsewhere
				? computeNext(
						{
							schedule: job.schedule,
							createdAt: Date.parse(job.createdAt),
							lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined,
						},
						now,
					)
				: undefined;
			const dormant = !job.stateful && job.sessionId !== session.sessionId ? `[dormant: session ${(job.sessionId ?? "?").slice(0, 8)} not open here]` : undefined;
			const orphan = job.stateful && !fs.existsSync(job.cwd) ? "[orphan: cwd missing]" : undefined;
			const marks = [job.stateful ? "[stateful]" : undefined, job.verify ? "[verify]" : undefined, elsewhere, dormant, orphan, job.running ? `running ${job.running.runId}` : undefined, job.catchUp ? undefined : "[no-catchup]"]
				.filter(Boolean)
				.join("  ");
			const head = `${String(i + 1).padStart(2)}. ${job.id}${job.name ? ` "${job.name}"` : ""}  ${job.enabled ? "enabled" : "disabled"}  ${formatSchedule(job.schedule)}${marks ? `  ${marks}` : ""}`;
			const action = `    action: ${previewRedacted(job.prompt, 120)}`;
			const meta = `    next ${next ? formatLocal(next) : "—"} · runs ${job.runCount}${job.skippedOverlap ? ` · overlap skips ${job.skippedOverlap}` : ""} · ${homeRel(job.cwd)}`;
			const err = job.lastError ? `    last error: ${previewRedacted(job.lastError, 100)}` : job.lastFiredAt ? `    last fired: ${job.lastFiredAt}` : undefined;
			return [head, action, meta, err].filter((l): l is string => !!l);
		}).flat();
	}

	/* --------------------------------------------------------- creation */

	const createJob = (input: CreateJobInput, scope?: JobScope) => createLoopJob(toolHost, input, scope);

	/**
	 * pie's `cron_control_plane` audit: every add / enable / disable / remove, from a slash
	 * command or a tool, leaves a custom entry in the session (never in LLM context).
	 */
	function cronControlAudit(op: "add" | "enable" | "disable" | "remove", actor: "slash" | "tool" | "sub-agent", before?: LoopJob, after?: LoopJob): string {
		const job = after ?? before;
		const next = after?.enabled ? computeNext({ schedule: after.schedule, createdAt: Date.parse(after.createdAt), lastFiredAt: after.lastFiredAt ? Date.parse(after.lastFiredAt) : undefined }, Date.now()) : undefined;
		// pi.appendEntry returns no id; mint one so tool results can point at the entry like pie's.
		const auditEntryId = newId("audit");
		pi.appendEntry("cron_control_plane", {
			audit_entry_id: auditEntryId,
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
		return auditEntryId;
	}

	/* --------------------------------------------------------- commands */

	const CRON_HELP = [
		"/cron                          jobs of this project        /cron all   every project on this machine",
		'/cron add [--stateful] "<minute hour dom month dow>" <prompt>',
		'    plain job: result appears in this chat (inject-and-run).  --stateful: loop with memory, findings go to /inbox',
		'    e.g. /cron add --stateful "0 9 * * *" check the repo issues and report anything new since the last run',
		"    schedule also accepts @daily | every 30m | in 10m | at 2026-09-08T18:00",
		"    --verify: maker/checker — a second adversarial sub-agent reviews findings before they enter /inbox (--checker-model <provider/id> to use another model)",
		"    more flags: --name <n> --cwd <dir> --model <provider/id> --thinking <lvl> --tools a,b --timeout 20m --catchup|--no-catchup (default: loops catch up a missed tick, plain jobs do not)",
		"/cron enable|disable|remove <n|id|name>      /cron run <n|id|name>   fire now",
		"/cron set <n|id|name> [--model <p/id>|-] [--thinking <lvl>|-] [--timeout <dur>|-] [--name <n>|-] [--host here|-]   change what a job runs with (- = use the session's current)",
		"/cron state <n|id|name>        the loop's notes (state spine)",
		"/cron runs [n|id|name]         recent runs          /cron trace [n|id|name] [k] [checker]   k-th latest run's transcript (maker, or its checker)",
		"/cron scheduler                who owns the timer     /cron panel on|off   pie-style side panel above the editor",
		"/cron gc                       remove plain jobs whose session was deleted (they are parked as disabled first)",
		"/cron host [start|stop]        the headless host that keeps the clock after the last pi quits; start = hand off on quit even with [host] auto = false",
		"/inbox                         triage findings from stateful jobs (/inbox help)",
		`/session-export [path] [--exclude-triggers]      pie's /session export: transcript + this project's cron jobs, trigger rules and loop state as one ${ARCHIVE_EXT} archive`,
		"/session-import <path> [--activate-triggers=on|off] [--cwd <dir>] [--resume]   restore it here (automation stays off unless activated)",
	];

	const cronCompletions = (prefix: string) => {
		const subs = ["add", "list", "all", "enable", "disable", "remove", "set", "gc", "host", "run", "state", "runs", "trace", "scheduler", "panel", "help"];
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
				const job = /^\d+$/.test(ref.trim()) ? resolveJobRef(all.filter((j) => sameProject(j.cwd, session.cwd)), ref) : resolveJobRef(all, ref);
				if (!job) ctx.ui.notify(ref ? `no cron job with id '${ref}'` : `usage: /cron ${sub} <id>`, "warning");
				return job;
			};
			const CRON_USAGE = '[list|add [--stateful] "<5-field-cron>" <prompt>|enable <id>|disable <id>|remove <id>|run <id>|state <id>|runs|trace|scheduler|panel|all|help]';
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
						const here = all.filter((j) => sameProject(j.cwd, session.cwd));
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
							ctx.ui.notify("the scheduler is not running in this session (non-interactive mode)", "warning");
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
					case "host": {
						// While a pi is open it owns the clock; the host only ever runs when nobody is around.
						const action = rest.trim();
						if (action === "stop") {
							handOffOnQuit = false;
							const pid = stopHost(dir);
							ctx.ui.notify(pid ? `stopped the background host (pid ${pid}); none will be started when this pi quits` : "no background host is running; none will be started when this pi quits", "info");
							return;
						}
						if (action === "start") {
							handOffOnQuit = true;
							ctx.ui.notify("a background host will keep the clock when this pi quits (this pi owns it while open)", "info");
							return;
						}
						const live = liveHost(dir);
						const answer = live ? await askHost(dir, { op: "status" }) : undefined;
						const snapshot = answer?.ok ? answer.snapshot : undefined;
						show(ctx, "Background host", [
							live ? `  running: pid ${live.pid} since ${formatLocal(Date.parse(live.startedAt))} — unexpected while a pi is open; it exits on its next tick` : "  not running (it runs only while no pi is open)",
							...(snapshot ? renderHostSnapshot(snapshot) : []),
							`  hand-off on quit: ${handOffOnQuit === undefined ? `${config.hostAuto ? "on" : "off"} ([host] auto = ${config.hostAuto}; /cron host start|stop overrides it for this pi)` : handOffOnQuit ? "on (/cron host start)" : "off (/cron host stop)"}`,
							`  log: ${homeRel(path.join(dir, HOST_LOG))}`,
							"  /cron host start | stop",
						]);
						return;
					}
					case "gc": {
						const removed = await scheduler.gc();
						for (const job of removed) cronControlAudit("remove", "slash", job, undefined);
						show(ctx, `removed ${removed.length} job(s) whose session no longer exists`, removed.map((j) => `  - ${j.id}${j.name ? ` "${j.name}"` : ""}  (session ${(j.sessionId ?? "?").slice(0, 8)})`));
						refreshBadge();
						return;
					}
					case "set": {
						// pie re-reads the parent's model every run; a pin here is explicit and editable.
						const change = parseSetArgs(rest);
						const job = pick(change.ref);
						if (!job) return;
						const updated = await scheduler.store.update(job.id, (j) => {
							if (change.model !== undefined) j.model = change.model ?? undefined;
							if (change.thinking !== undefined) j.thinking = change.thinking ?? undefined;
							if (change.timeoutMs !== undefined) j.timeoutMs = change.timeoutMs ?? undefined;
							if (change.name !== undefined) j.name = change.name ?? undefined;
							if (change.host !== undefined) j.host = change.host === "here" ? os.hostname() : undefined;
						});
						if (!updated) return;
						show(ctx, `updated cron job ${updated.id}${updated.name ? ` "${updated.name}"` : ""}`, [
							`  model: ${updated.model ?? "(the running session's current model)"}`,
							`  thinking: ${updated.thinking ?? "(the running session's current level)"}`,
							`  timeout: ${updated.timeoutMs ? `${Math.round(updated.timeoutMs / 1000)}s` : "default"}`,
							`  host: ${updated.host ?? "(any machine)"}`,
						]);
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
							`this process: pid ${me}, ${started ? (scheduler.isLeader ? "owns the timer" : "standby") : "not scheduling (non-interactive)"}, ${scheduler.runningCount} run(s) in flight${scheduler.runningCount ? ` (${scheduler.runningLabels().join(", ")})` : ""}`,
							`timer owner: ${leader ? `pid ${leader.pid}@${leader.host}${(leader as any).kind === "host" ? " (background host)" : ""}, heartbeat ${formatLocal(Date.parse(leader.heartbeatAt))}` : "none"}`,
							`background host: ${liveHost(dir) ? `pid ${liveHost(dir)!.pid} (exits on its next tick: a pi is open)` : "not running (runs only while no pi is open)"} · hand-off on quit: ${handOffOnQuit ?? config.hostAuto ? "on" : "off"}`,
							`store: ${homeRel(dir)}`,
							`inbox: ${scheduler.inbox.newCount()} new`,
						]);
						return;
					}
					default:
						ctx.ui.notify(`unknown /cron command: ${sub}. usage: /cron ${CRON_USAGE}`, "warning");
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

	/** pie's list lines: the full (≤500-char) finding, id prefix, source, `created_at[..16]`. */
	function inboxLines(entries: InboxEntry[], numbered: boolean): string[] {
		return entries.map((e, i) => {
			const when = e.createdAt.slice(0, 16);
			const mark = e.verified ? "✓ " : "";
			if (!numbered) return `  [${e.status}] ${mark}${redact(e.text)}  (${e.source})`;
			return `  ${i + 1}. [${e.id.slice(0, 12)}] ${mark}${redact(e.text)}  (${e.source}, ${when})`;
		});
	}

	function claimPrompt(e: InboxEntry): string {
		const verified = e.verified ? `\n(An independent checker reviewed and kept this finding${e.verifiedReason ? `: ${e.verifiedReason}` : ""}.)` : "";
		return `A recurring loop (${e.source}, running in ${e.cwd}) reported this finding — investigate and address it:\n${e.text}${verified}`;
	}

	/* ------------------------------------------------------------------ /goal */

	/**
	 * pie's stop-condition hook. The goal lives in the session (append-only `goal_state` entries,
	 * so `--resume` finds it); after every settled turn an evaluator with no tools judges the
	 * condition against a bounded transcript and either stops, sends the agent back to work, or
	 * pauses. See src/goal.ts for the state machine and pie's prompts.
	 */
	let goal: GoalState | undefined;
	let goalMessages: unknown[] = [];
	let goalEvaluating = false;
	/** Set while the evaluator runs, so an abort or `/goal pause` can cut it short. */
	let goalAbort: AbortController | undefined;
	/** How the last turn ended: an aborted or failed turn says nothing about the goal. */
	let lastTurnStopReason: string | undefined;

	function persistGoal(ctx: ExtensionContext | undefined, next: GoalState): void {
		goal = next.status === "cleared" ? undefined : next;
		pi.appendEntry(GOAL_ENTRY, next);
		refreshBadge();
		if (ctx?.hasUI) ctx.ui.setStatus(GOAL_STATUS_KEY, next.status === "cleared" ? undefined : `goal: ${next.status}`);
	}

	async function evaluateGoal(ctx: ExtensionContext): Promise<void> {
		const started = goal;
		if (!started || started.status !== "pursuing" || goalEvaluating) return;
		// A turn that the user interrupted, or that the provider failed, is not evidence about the
		// goal — and re-prompting after an abort would make Esc unable to stop a goal at all. pie
		// returns before its turn-end hook on any run error (agent_harness.rs:1776).
		if (lastTurnStopReason === "aborted" || lastTurnStopReason === "error") return;
		goalEvaluating = true;
		const ctrl = new AbortController();
		goalAbort = ctrl;
		try {
			// The whole conversation on the active branch, compaction-aware — not just the messages of
			// the run that happened to end. `agent_end.messages` is only that run's, so evidence from
			// an earlier turn would be invisible and a satisfied goal would never be recognised.
			// Redacted like every other channel that leaves this process: the transcript is now the
			// whole branch, and it is both sent to the evaluator and kept as a sub-agent transcript.
			const transcript = redact(transcriptFromMessages(goalTranscript(ctx)));
			// No tools, the session's own model: the evaluator only reads what already happened.
			const result = await runner({
				cwd: session.cwd,
				prompt: evaluatorPrompt(started.condition, transcript),
				model: session.model,
				thinking: "off",
				tools: [],
				timeoutMs: GOAL_EVALUATOR_TIMEOUT_MS,
				signal: ctrl.signal,
				sessionDir: scheduler.store.sessionDirFor("goal"),
				hop: hop + 1,
				parentSessionId: session.sessionId,
				parentCwd: session.cwd,
				kind: "checker",
			});
			// The user can pause, clear or replace the goal while the evaluator runs; a decision about
			// the goal they had must not be written over the one they have now.
			if (!goal || goal.status !== "pursuing" || goal.condition !== started.condition) return;
			let outcome: { state: GoalState; action: GoalAction };
			if (ctrl.signal.aborted) outcome = pauseFor(started, "goal evaluator cancelled");
			else if (!result.ok) outcome = pauseFor(started, `goal evaluator failed: ${result.errorMessage ?? "unknown error"}`);
			else {
				try {
					outcome = applyDecision(started, parseDecision(result.text));
				} catch (err: any) {
					outcome = pauseFor(started, err?.message ?? String(err));
				}
			}
			persistGoal(ctx, outcome.state);
			scheduler.store.pruneSessions("goal", 20);
			if (outcome.action.kind === "stop") {
				show(ctx, "Goal achieved", [`  condition: ${previewRedacted(outcome.state.condition, 200)}`, `  evidence: ${previewRedacted(outcome.state.lastReason ?? "", 300)}`, `  ${outcome.state.iterations} continuation(s)`]);
			} else if (outcome.action.kind === "pause") {
				notifyOrLog(ctx, `[goal] paused: ${previewRedacted(outcome.action.reason, 200)} — /goal resume to continue`, "warning");
			} else {
				notifyOrLog(ctx, `[goal] not satisfied (${outcome.state.iterations}/${MAX_CONTINUATIONS}): ${previewRedacted(outcome.state.lastReason ?? "", 160)}`, "info");
				// The reason is model output derived from a transcript that can contain hostile file,
				// web or MCP content, and this is the highest-trust channel in the session — so it is
				// redacted and capped before it is handed back to the agent. `deliverAs` matches every
				// other injection site: the session accepts input again before this runs, so an
				// unguarded prompt() would throw and the continuation would be lost.
				const prompt = continuationPrompt(outcome.state.condition, capRedacted(outcome.state.lastReason ?? "", 2000));
				pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			}
		} finally {
			goalEvaluating = false;
			goalAbort = undefined;
		}
	}

	/** `notify` is a no-op without a UI (`pi -p`, the rpc mode), where these lines still matter. */
	function notifyOrLog(ctx: ExtensionContext, text: string, level: "info" | "warning"): void {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else process.stderr.write(`${text}\n`);
	}

	/** The active branch's conversation, which is what the goal is judged against. */
	function goalTranscript(ctx: ExtensionContext): Array<{ role?: string; content?: unknown }> {
		try {
			const entries = ctx.sessionManager.buildContextEntries() as Array<{ message?: { role?: string; content?: unknown } }>;
			const messages = entries.map((e) => e.message).filter((m): m is { role?: string; content?: unknown } => !!m);
			if (messages.length) return messages;
		} catch {
			/* fall back to the run that just ended */
		}
		return goalMessages as Array<{ role?: string; content?: unknown }>;
	}

	const GOAL_HELP = [
		"/goal <condition>            hold this session to a condition; after every turn an evaluator decides",
		"/goal                        show the current goal and what the evaluator last said",
		"/goal pause | resume         stop / restart evaluating without losing the condition",
		"/goal clear                  drop the goal",
		"                             (these three are exact words; anything longer is read as a condition)",
		`the agent is sent back to work at most ${MAX_CONTINUATIONS} times; an evaluator that cannot decide pauses instead of looping`,
	];

	pi.registerCommand("goal", {
		description: "Hold this session to a stop condition, evaluated after every turn (pie's /goal)",
		getArgumentCompletions: (prefix) => {
			const subs = ["pause", "resume", "clear", "help"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const text = args.trim();
			// pie guards its subcommand arms by arity (commands.rs:1047): anything longer than the bare
			// word is a condition. Without that, `/goal clear all the type errors` wipes a live goal.
			const sub = /^(pause|resume|clear|help|start)$/.test(text) ? text : "";
			if (sub === "help") return show(ctx, "Goal", GOAL_HELP);
			if (!text) {
				if (!goal) return show(ctx, "Goal: none", ["  /goal <condition> — e.g. /goal the test suite passes and the changes are committed"]);
				return show(ctx, `Goal: ${goal.status}`, [`  condition: ${previewRedacted(goal.condition, 200)}`, `  ${goal.iterations}/${MAX_CONTINUATIONS} continuations`, ...(goal.lastReason ? [`  evaluator: ${previewRedacted(goal.lastReason, 300)}`] : []), `  updated ${formatLocal(Date.parse(goal.updatedAt))}`]);
			}
			if (sub === "start") return ctx.ui.notify("usage: /goal start <prompt> — set a goal with /goal <condition>, then send the prompt to begin", "warning");
			if (sub === "pause" || sub === "resume" || sub === "clear") {
				if (!goal) return ctx.ui.notify("no active goal; set one with /goal <condition>", "warning");
				// An evaluation in flight was decided about the goal as it was; stop it here.
				goalAbort?.abort();
				if (sub === "clear") {
					persistGoal(ctx, { ...goal, status: "cleared", updatedAt: new Date().toISOString() });
					return ctx.ui.notify("goal cleared", "info");
				}
				if (sub === "resume" && goal.status === "achieved") return ctx.ui.notify("this goal was achieved; set a new one with /goal <condition>", "warning");
				// Resuming after the budget ran out starts the allowance again, as pie's does.
				const next: GoalState = sub === "pause" ? { ...goal, status: "paused", updatedAt: new Date().toISOString() } : { ...goal, status: "pursuing", iterations: goal.status === "budget_limited" ? 0 : goal.iterations, updatedAt: new Date().toISOString() };
				persistGoal(ctx, next);
				return ctx.ui.notify(`goal ${sub === "pause" ? "paused" : "resumed"}`, "info");
			}
			goalAbort?.abort(); // the old goal's evaluation is about a condition the user just replaced
			persistGoal(ctx, newGoal(text));
			ctx.ui.notify(`goal set: ${previewRedacted(text, 160)} — send a prompt to begin; evaluated after every turn, up to ${MAX_CONTINUATIONS} continuations`, "info");
		},
	});

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

	const TRIGGERS_USAGE = "[status|rules|sources|enable <id>|disable <id>|remove <id>|remove --all|set <id> --model|--thinking|--timeout …|running|audit [N]|abort <trace_id>|abort --all]";

	function ruleLines(rules: ReturnType<TriggerStore["load"]>, numbered: boolean): string[] {
		return rules.map((r, i) => {
			const state = r.enabled ? "enabled" : "disabled";
			const fire = r.fireOnce ? "fire_once" : "repeat";
			const out = r.promoteToChat ? "promote_to_chat" : "audit_only";
			const fired = r.firedAt ? `, fired_at=${r.firedAt}` : "";
			const head = numbered ? `${String(i + 1).padStart(2)}. ` : "  - ";
			const other = r.createdBy?.sessionId && r.createdBy.sessionId !== session.sessionId ? `  (session ${r.createdBy.sessionId.slice(0, 8)})` : "";
			// Same as jobLines: the runtime skips a rule stamped with another machine's hostname.
			const elsewhere = r.host && r.host !== os.hostname() ? ` [other host: ${r.host}]` : "";
			return `${head}${r.id} [${state}, ${fire}, ${out}${fired}]${elsewhere} when ${previewRedacted(r.condition, 80)} -> ${previewRedacted(r.action, 80)}${!sameProject(r.cwd, session.cwd) ? `  (${homeRel(r.cwd)})` : ""}${other}`;
		});
	}

	pi.registerCommand("triggers", {
		description: "Show trigger sources, rules, running actions, and recent audit — /triggers " + TRIGGERS_USAGE,
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "rules", "sources", "enable", "disable", "remove", "set", "running", "audit", "abort", "help"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const { sub, rest } = splitCommand(args);
			const store = triggers.store;
			const pickRule = (ref: string) => {
				const all = store.load();
				const rule = /^\d+$/.test(ref.trim()) ? resolveRuleRef(all.filter((r) => sameProject(r.cwd, session.cwd)), ref) : resolveRuleRef(all, ref);
				if (!rule) ctx.ui.notify(ref ? `no dynamic trigger rule with id '${ref}'` : `usage: /triggers ${sub} <id>${sub === "remove" || sub === "rm" || sub === "delete" ? "|--all" : ""}`, "warning");
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
							`  local dynamic checker: ${started ? `this process for ${homeRel(session.cwd)}${scheduler.isLeader ? " (and, as timer owner, for projects with no pi open)" : ` (timer owned by pid ${leader?.pid ?? "?"})`}` : "not running here"}, polls every ${triggers.pollIntervalSecs}s while enabled rules exist (checks run in a pi open in the rule's project)`,
							`  last check: ${triggers.lastPoll ? `${formatLocal(Date.parse(triggers.lastPoll.at))} in ${homeRel(triggers.lastPoll.cwd)} — ${triggers.lastPoll.outcome}` : "none yet"}`,
							`  push trigger sources: ${mcpConfigs.length} configured MCP server(s) feed server-pushed events into the same trigger runtime (deduplicated machine-wide, hop ${hop})${mcpConfigError ? ` (config error: ${mcpConfigError})` : ""}`,
							`  sources: ${mcpSources.length + 2} total, ${mcpSources.filter((s) => s.status.state === "connected").length + (started ? 2 : 0)} connected, ${mcpSources.filter((s) => s.status.requiresAttention).length} require attention`,
							`  running: ${triggers.runningList().length} · deduped: ${triggers.dedupedCount} · cycle_suppressed: ${triggers.cycleSuppressedCount} · storage: ${homeRel(store.rulesFile)}`,
							...(store.lastPersistenceError ? [`  ! ${store.lastPersistenceError}`] : []),
							`  audit: ${homeRel(store.auditFile)} (/triggers audit [N])`,
						]);
						return;
					}
					case "rules": {
						const all = store.load();
						const here = all.filter((r) => sameProject(r.cwd, session.cwd));
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
						// pie registers MCP hooks first, then the cron hook, then the dynamic checker.
						const lines: string[] = [];
						const localState = started ? (scheduler.isLeader ? "connected" : "standby") : "disabled";
						mcpSources.forEach((s, i) => {
							const st = s.status;
							lines.push(`  - source #${i + 1}: ${st.state}${st.reason ? ` (${previewRedacted(st.reason, 80)})` : ""} queued=${st.queuedCount} dropped=${st.droppedCount} deduped=${st.dedupedCount} last_event=${st.lastEventAt ?? "never"}${st.requiresAttention ? `  ! ${st.requiresAttention}` : ""}`);
							lines.push(`      subscriptions: ${st.subscriptionLabels.join(", ")}${s.config.injectAndRun ? " [inject_and_run]" : s.config.injectSummary ? " [inject_summary]" : ""} (${s.config.kind}, ${s.config.source}) · tools: ${(mcpToolNames.get(s.config.name) ?? []).length ? (mcpToolNames.get(s.config.name) ?? []).join(", ") : "none"}`);
							if (st.lastError) lines.push(`      last error: ${previewRedacted(st.lastError, 160)}`);
							if (st.lastStderr) lines.push(`      stderr: ${previewRedacted(st.lastStderr, 160)}`);
						});
						const jobs = scheduler.store.load();
						const lastFired = jobs.map((j) => j.lastFiredAt).filter((t): t is string => !!t).sort().at(-1);
						lines.push(`  - source #${mcpSources.length + 1}: ${localState} queued=${scheduler.runningCount} dropped=0 deduped=0 last_event=${lastFired ?? "never"}`);
						lines.push(`      subscriptions: ${jobs.length ? `local crontab: ${jobs.length} job(s), ${jobs.filter((j) => j.enabled).length} enabled` : "local crontab: 0 jobs"}`);
						lines.push(`  - source #${mcpSources.length + 2}: ${localState} queued=${triggers.runningList().filter((r) => r.sourceLabel === "local:dynamic").length} dropped=0 deduped=${triggers.dedupedCount} last_event=${triggers.lastPoll?.at ?? "never"}`);
						lines.push("      subscriptions: dynamic trigger periodic check");
						if (mcpSources.length) lines.push("  (pushes are deduplicated machine-wide; results go to this chat only for this project's rules, otherwise to /inbox)");
						if (mcpConfigError) lines.push(`  ! ${mcpConfigError}`);
						show(ctx, `Trigger sources (${2 + mcpSources.length}):`, lines);
						return;
					}
					case "enable":
					case "resume":
					case "disable":
					case "pause": {
						const rule = pickRule(rest);
						if (!rule) return;
						const enable = sub === "enable" || sub === "resume";
						const updated = (await store.setEnabled(rule.id, enable)) ?? rule;
						show(ctx, `${enable ? "enabled" : "disabled"} trigger ${updated.id}`, [
							`  condition: ${previewRedacted(updated.condition, 120)}`,
							`  action: ${previewRedacted(updated.action, 120)}`,
							...(updated.enabled && updated.fireOnce ? ["  fire_once: true (will disable again after the next successful match)"] : []),
						]);
						return;
					}
					case "remove":
					case "rm":
					case "delete": {
						// `--all` means "all of this project's", like pie's per-session registry; wiping every
						// project on the machine needs saying so.
						if (rest.trim() === "--all" || rest.trim() === "--all-projects") {
							const everywhere = rest.trim() === "--all-projects";
							const n = await store.clear(everywhere ? undefined : session.cwd, sameProject);
							ctx.ui.notify(`removed ${n} dynamic trigger rule(s)${everywhere ? " (every project on this machine)" : ` in ${homeRel(session.cwd)}`}`, "info");
							return;
						}
						const rule = pickRule(rest);
						if (!rule) return;
						await store.remove(rule.id);
						show(ctx, `removed trigger ${rule.id}`, [`  condition: ${previewRedacted(rule.condition, 120)}`, `  action: ${previewRedacted(rule.action, 120)}`]);
						return;
					}
					case "set": {
						const change = parseSetArgs(rest);
						if (change.name !== undefined) {
							ctx.ui.notify("rules have no name; /triggers set takes --model, --thinking, --timeout and --host", "warning");
							return;
						}
						const rule = pickRule(change.ref);
						if (!rule) return;
						const updated = await store.update(rule.id, (r) => {
							if (change.model !== undefined) r.model = change.model ?? undefined;
							if (change.thinking !== undefined) r.thinking = change.thinking ?? undefined;
							if (change.timeoutMs !== undefined) r.timeoutMs = change.timeoutMs ?? undefined;
							if (change.host !== undefined) r.host = change.host === "here" ? os.hostname() : undefined;
						});
						if (!updated) return;
						show(ctx, `updated trigger ${updated.id}`, [
							`  model: ${updated.model ?? "(the running session's current model)"}`,
							`  thinking: ${updated.thinking ?? "(the running session's current level)"}`,
							`  timeout: ${updated.timeoutMs ? `${Math.round(updated.timeoutMs / 1000)}s` : `default (${Math.round(triggers.runTimeoutMs / 1000)}s)`}`,
						]);
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
						const all = /\s--all\b|^--all\b/.test(rest);
						const limit = Number.parseInt(rest.replace("--all", ""), 10) || 10;
						// This project's rows by default (rows without a cwd predate 0.1.3 and are shown too).
						const rows = store.listAudit(limit, all ? undefined : (r) => !r.cwd || sameProject(r.cwd, session.cwd));
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
			ctx.ui.notify(ARCHIVE_WARNING, "warning"); // pie prints it before the attempt, success or not
			try {
				// pie exports the session's own sidecars. Ours are machine-global, so the session that
				// created a job or rule is what scopes the archive; jobs from before `createdBy`
				// existed fall back to the project.
				const sessionId = ctx.sessionManager.getSessionId();
				const mine = (owner: { sessionId?: string } | undefined, cwd: string) => (owner?.sessionId ? owner.sessionId === sessionId : sameProject(cwd, session.cwd));
				const jobs = scheduler.store.load().filter((j) => sameProject(j.cwd, session.cwd) && mine(j.createdBy, j.cwd));
				const rules = triggers.store.load().filter((r) => sameProject(r.cwd, session.cwd) && mine(r.createdBy, r.cwd));
				const states: Record<string, string> = {};
				for (const j of jobs) {
					const st = j.stateful ? scheduler.store.readState(j.id) : undefined;
					if (st) states[j.id] = st;
				}
				const summary = exportSession({ sessionFile, cwd: session.cwd, jobs, rules, states, excludeTriggers, outputPath, piVersion: PI_VERSION, piLoopsVersion: PI_LOOPS_VERSION });
				show(ctx, `exported session archive: ${homeRel(summary.outputPath)}`, [
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
			ctx.ui.notify(ARCHIVE_WARNING, "warning");
			try {
				const store = scheduler.store;
				const imp = importSession({
					archivePath,
					sessionDir: ctx.sessionManager.getSessionDir(),
					targetCwd,
					activate,
					existingJobs: store.load(),
					existingRules: triggers.store.load(),
					existingJobIds: new Set(store.load().map((j) => j.id)),
					existingRuleIds: new Set(triggers.store.load().map((r) => r.id)),
				});
				try {
					if (imp.jobs.length) await store.mutate((jobs) => ({ jobs: [...jobs, ...imp.jobs], result: undefined }));
					for (const [id, text] of Object.entries(imp.states)) store.writeState(id, text);
					if (imp.rules.length) await triggers.store.mutate((rules) => rules.push(...imp.rules));
				} catch (err) {
					// Roll back, best effort and in this order: a half-imported archive must leave neither
					// an orphan session nor a partial store, and the original error is what gets reported.
					const ids = new Set(imp.jobs.map((j) => j.id));
					const attempt = (fn: () => void) => {
						try {
							fn();
						} catch {
							/* best effort */
						}
					};
					attempt(() => fs.rmSync(imp.sessionPath, { force: true }));
					await store.mutate((jobs) => ({ jobs: jobs.filter((j) => !ids.has(j.id)), result: undefined })).catch(() => {});
					for (const id of ids) attempt(() => fs.rmSync(store.statePath(id), { force: true }));
					throw err;
				}
				for (const job of imp.jobs) cronControlAudit("add", "slash", undefined, job);
				refreshBadge();
				const skipped = (imp.skippedJobs ?? 0) + (imp.skippedRules ?? 0);
				show(ctx, imp.transcriptImported === false ? "imported automation from a pie archive" : `imported session: ${imp.sessionId.slice(0, 16)}`, [
					...(imp.transcriptImported === false ? [] : [`path: ${homeRel(imp.sessionPath)}`]),
					`entries=${imp.entryCount} triggers=${imp.rules.length} cron=${imp.jobs.length} loop_state=${Object.keys(imp.states).length} automation=${imp.automationEnabled ? "enabled" : "disabled"}${skipped ? ` skipped=${skipped} (already imported)` : ""}`,
					...(imp.notes ?? []).map((n: string) => `note: ${n}`),
					...(imp.transcriptImported === false ? [] : [`resume with: pi --session ${imp.sessionPath}`]),
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
	 * pie classifies trigger creation/removal and trigger/cron enable as `PermissionClassification::Prompt`:
	 * the user confirms before the tool runs. pi has no built-in permission popups, so the tool
	 * asks through ctx.ui.confirm itself. Sub-agents are denied fail-closed exactly like pie's
	 * (no prompt channel); without a UI the call is refused rather than silently allowed.
	 */
	/**
	 * The same project, whichever path this pi was opened through: a worktree, a symlink or a
	 * subdirectory of the project root all belong to the rule or job that names the root.
	 */
	const sameProject = (a: string, b: string): boolean => withinProject(b, a) || withinProject(a, b);

	/** The tools' view of this extension (see tools.ts); sub-sessions and the headless host get their own. */
	const toolHost: ToolHost = {
		scheduler,
		triggers,
		session: () => session,
		createJob: (input, scope) => createLoopJob(toolHost, input, scope),
		cronControlAudit,
		confirmTool,
		refreshBadge,
	};
	/** The same host, bound to one sub-agent run: its project and its model, not this chat's. */
	function toolHostFor(req: Pick<SubagentRequest, "cwd" | "model" | "thinking">): ToolHost {
		const scoped: ToolHost = {
			...toolHost,
			session: () => ({ ...session, cwd: req.cwd, model: req.model ?? session.model, thinking: req.thinking ?? session.thinking }),
			createJob: (input, s) => createLoopJob(scoped, input, s),
		};
		return scoped;
	}
	async function confirmTool(ctx: ExtensionContext, req: ControlPlaneRequest, atHop: number): Promise<string | undefined> {
		const denied = controlPlanePreflight({ hop: atHop, hasUI: ctx.hasUI }, req.label);
		if (denied) return denied;
		// pie's approval card: Action / Tool / Reason / Args hash / Preview, then a feed line per decision.
		const argsHash = createHash("sha256").update(JSON.stringify(req.args ?? null)).digest("hex").slice(0, 12);
		ctx.ui.notify(`approval required: ${req.label}`, "info");
		const ok = await ctx.ui.confirm("Control-plane approval required", [`Action: ${req.label}`, `Tool: ${req.tool}`, `Reason: ${req.reason}`, `Args hash: ${argsHash}`, `Preview: ${previewRedacted(req.preview, 200)}`].join("\n"));
		ctx.ui.notify(ok ? `approved control-plane action: ${req.label}` : `denied control-plane action: ${req.label} (denied by user)`, "info");
		return ok ? undefined : `user declined: ${req.label}`;
	}
	for (const def of automationTools({ hop, actor: "tool" }, toolHost)) pi.registerTool(def);

	/* -------------------------------------------------------- lifecycle */

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		session = snapshot(ctx);
		config = loadConfig(dir);
		// pie keeps the goal in the session, so `--resume` picks up where it left off.
		goal = latestGoal(ctx.sessionManager.getEntries() as any);
		if (goal && ctx.hasUI) ctx.ui.setStatus(GOAL_STATUS_KEY, `goal: ${goal.status}`);
		const flagRaw = pi.getFlag("trigger-poll-secs");
		const flagSecs = Number(flagRaw);
		if (flagRaw !== undefined && flagRaw !== "" && !(Number.isFinite(flagSecs) && flagSecs >= 1)) config.errors.push(`triggers: ignoring invalid --trigger-poll-secs ${JSON.stringify(flagRaw)}: must be a whole number of seconds ≥ 1`);
		triggers.pollIntervalSecs = Number.isFinite(flagSecs) && flagSecs >= 1 ? Math.floor(flagSecs) : config.triggerPollIntervalSecs;
		triggers.runTimeoutMs = config.triggerRunTimeoutMs;
		// pie logs hook failures through tracing; without a UI they go to stderr instead of vanishing.
		const warnHook = (m: string) => (ctx.hasUI ? ctx.ui.notify(`[hooks] ${m}`, "warning") : process.stderr.write(`[pi-loops hooks] ${m}\n`));
		hookRunner = new HookRunner({ loopsDir: dir, projectCwd: ctx.cwd, allowProjectHooks: config.allowProjectHooks, getSession: () => session, warn: warnHook });
		hookRunner.load();
		for (const e of [...config.errors, ...hookRunner.diagnostics]) if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${e}`, "warning");
		loadMcpConfig(ctx.isProjectTrusted());
		for (const d of mcpDiagnostics) if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${d}`, "warning");
		await startMcpSources(); // tools for every process; pushes are consumed by interactive processes only
		// tui and rpc processes stay alive and host the timer; `PI_LOOPS_HOST=1` lets a `pi -p`
		// run (a long headless prompt) host it too, as pie does in non-TTY mode.
		const hostMode = ctx.mode === "tui" || ctx.mode === "rpc" || process.env.PI_LOOPS_HOST === "1";
		if (!hostMode) return;
		// Take the clock back from the headless host, if one kept it while nothing was open; a record
		// with no process behind it means the host died (it removes its record on a clean exit).
		const dead = crashedHost(dir);
		if (dead && ctx.hasUI) ctx.ui.notify(`[cron] the background host (pid ${dead.pid}, started ${formatLocal(Date.parse(dead.startedAt))}) died; see ${homeRel(path.join(dir, HOST_LOG))}`, "warning");
		const hostPid = stopHost(dir);
		if (hostPid && ctx.hasUI) ctx.ui.notify(`[cron] took the clock back from the background host (pid ${hostPid})`, "info");
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
	pi.on("agent_end", async (event, ctx) => {
		lastCtx = ctx;
		goalMessages = event.messages ?? [];
		const last: any = (event.messages ?? []).at(-1);
		lastTurnStopReason = typeof last?.stopReason === "string" ? last.stopReason : undefined;
		if (lastTurnStopReason === "aborted") goalAbort?.abort();
		await fireHook({ event: "agent_end" }, ctx);
		refreshBadge();
	});
	// pie evaluates its goal in `on_turn_end`; pi's equivalent is `agent_settled` — the point where
	// no automatic retry, compaction or queued continuation will run, so a decision here is final.
	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		try {
			await evaluateGoal(ctx);
		} catch (err: any) {
			if (ctx.hasUI) ctx.ui.notify(`[goal] ${err?.message ?? err}`, "warning");
		}
	});

	/** Whether this quitting pi should hand the clock to a background host. May throw on a damaged store. */
	function handOffDecision(here: string, wasStarted: boolean): ReturnType<typeof shouldHandOff> | undefined {
		if (!wasStarted) return undefined;
		const enabledRules = triggers.store.load().filter((r) => r.enabled && (!r.host || r.host === here)).length;
		return shouldHandOff({
			auto: handOffOnQuit ?? config.hostAuto,
			presence: scheduler.presenceList(),
			selfPid: process.pid,
			selfInstance: scheduler.self.instance,
			hostName: here,
			enabledLoops: scheduler.store.load().filter((j) => j.enabled && j.stateful && (!j.host || j.host === here)).length,
			enabledRules,
			pushServers: hostPushWork(loadMcpConfigFiles({ dir, projectTrusted: false }).servers, enabledRules),
			hostAlive: !!liveHost(dir),
		});
	}

	pi.on("session_shutdown", async (event, ctx) => {
		// The last interactive pi to quit hands the clock to a headless host (host.ts) so loops,
		// trigger checks and MCP pushes keep running; the next pi to open takes it back.
		//
		// `/new`, `/resume`, `/reload` and `/fork` replace the session inside the same process, and pi
		// rebuilds the extension with it — so this scheduler must stop, or two would run at once.
		// A run aborted by the swap gives its slot back (see `launch`), and the replacement session
		// re-fires it on its first tick instead of losing it until the next due time.
		const wasStarted = started;
		if (started) {
			started = false;
			await triggers.stop();
			await scheduler.stop();
		}
		// Decided after stop(): our own presence entry is gone. Two pis quitting together may both
		// hand off; the extra host exits on its first tick — better than neither handing off.
		if (event.reason !== "quit") {
			await hookRunner?.drain(3000);
			return; // the replacement session_start starts everything again
		}
		config = loadConfig(dir); // `[host] auto` may have been edited while this pi was open
		const here = os.hostname();
		// A damaged store must not abort the rest of shutdown: the hooks, the MCP pool and the MCP
		// servers below all still have to be torn down, or their child processes outlive pi.
		let handOff: ReturnType<typeof shouldHandOff> | undefined;
		try {
			handOff = handOffDecision(here, wasStarted);
		} catch (err: any) {
			process.stderr.write(`[pi-loops] could not decide on a background host: ${err?.message ?? err}\n`);
		}
		if (handOff?.handOff) {
			try {
				const pid = spawnHost({ dir, packageDir: PACKAGE_DIR, piPackage: piPackageDir(), model: session.model, thinking: session.thinking });
				const note = `[cron] handed the clock to a background host (pid ${pid}; ${handOff.reason}); /cron host stop ends it`;
				if (ctx.hasUI) ctx.ui.notify(note, "info");
				else process.stderr.write(`${note}\n`);
			} catch (err: any) {
				process.stderr.write(`[pi-loops] could not start the background host: ${err?.message ?? err}\n`);
			}
		}
		await hookRunner?.drain(3000);
		await mcpPool.stopAll();
		await stopMcpSources();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		if (ctx.mode === "tui") ctx.ui.setWidget(PANEL_KEY, undefined);
	});
}
