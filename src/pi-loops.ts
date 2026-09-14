/**
 * pi-loops — stateful cron jobs, dynamic triggers and a triage inbox, as a plain pi extension.
 *
 * Nothing in pi is patched: timers start in session_start and stop in session_shutdown. A loop run
 * is an in-process `AgentSession` through pi's SDK (`src/sdk-runner.ts`) — never a child process —
 * so it shares this session's MCP clients, extensions and model. A loop's state is Markdown on
 * disk, findings go to a global JSONL inbox, and `/inbox claim` turns a finding into a real user
 * turn via `pi.sendUserMessage()`.
 *
 * Commands, tools and their arguments are documented in `docs/` (loops.md, triggers.md, goal.md,
 * configuration.md); this file is where they are registered.
 * Storage:   ~/.pi/agent/loops/{jobs.json,state/<id>.md,inbox.jsonl,runs.jsonl,triggers.json}
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore, VERSION as PI_VERSION, getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ARCHIVE_EXT, defaultExportPath, exportSession, importSession } from "./archive.ts";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseAddArgs, parseSetArgs, splitCommand, tokenize } from "./args.ts";
import { envFlag, loadConfig } from "./config.ts";
import { GOAL_ENTRY, type GoalAction, type GoalState, MAX_CONTINUATIONS, applyDecision, branchMovedSince, continuationPrompt, evaluatorPrompt, latestGoal, newGoal, parseDecision, pauseFor, transcriptFromMessages } from "./goal.ts";
import { withinProject } from "./presence.ts";
import { isExactlyTrusted, sessionTrustCovers } from "./trust.ts";
import { HookRunner, type HookEventData, messageKind, messageSummary, resultSummary, truncateSummary } from "./hooks.ts";
import { failingSummary } from "./job-health.ts";
import { LoopsLog, pruneLogs } from "./log.ts";
import { type InboxEntry, belongsToProject, inProject, resolveInboxRef } from "./inbox.ts";
import { McpPool } from "./mcp-pool.ts";
import { McpSource, PI_BUILTIN_TOOL_NAMES, type McpServerConfig, type McpToolDef, droppedNotificationMessage, loadMcpConfigFiles, mapNotification, mcpToolDefinitions, mcpTokenFromEnv } from "./mcp.ts";
import { capRedacted, previewRedacted, redact } from "./redact.ts";
import { shouldEmitSnapshot, snapshotFingerprint } from "./snapshot.ts";
import { type ShareMessage, renderShare, shareSummary } from "./share.ts";
import { installLauncherWithConfirm } from "./cli.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { computeDue, computeNext, formatLocal, formatSchedule, localOffset, parseSchedule, stamp } from "./schedule.ts";
import { applyJobEdit } from "./job-edit.ts";
import { AUTONOMY_LEVELS, type AutonomyLevel, INSTALL_ROOT, type Recipe, type UpdateResult, addLineFor, ensureExcluded, installDirFor, installFiles, installedRecipes, isRecipeName, listRecipes, MAX_SETUP_SHOWN, TRACKER_FILE, loadRecipe, packagedRecipesDir, parseAddWords, planInstall, playbookFiles, purgeInstall, readRecord, requireRecipeName, resolveRecipeRef, updateFiles } from "./recipe.ts";
import { LoopScheduler, type SessionSnapshot } from "./scheduler.ts";
import { MAX_PROMPT_BYTES, type LoopJob, type RunRecord, defaultLoopsDir, newId, resolveJobRef, sessionExists } from "./store.ts";
import { parentRuntimeFlags, type SubagentRequest } from "./runner.ts";
import { createInProcessRunner } from "./sdk-runner.ts";
import { SubagentSlots } from "./slots.ts";
import { askHost, renderHostSnapshot } from "./host-control-channel.ts";
import { waitForHost, HOST_LOG, crashedHost, hostPushWork, liveHost, piPackageDir, shouldHandOff, spawnHost, stopHost } from "./host-control.ts";
import { summarizeSessionFile } from "./transcript.ts";
import { TriggerRuntime, type TriggerOutcome } from "./trigger-runtime.ts";
import { auditCronFinish, auditCronStart, TriggerStore, buildPeriodicCheckTrigger, controlPlanePreflight, resolveRuleRef } from "./triggers.ts";
import { type ControlPlaneRequest, type CreateJobInput, type JobScope, type ToolHost, automationTools, checkJobName, createLoopJob } from "./tools.ts";
import { panelEnabled, readUiPrefs, writeUiPref } from "./ui-prefs.ts";
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
	/** Trigger hop, for cycle suppression: the interactive pi is 0; the sub-agents it runs are 1. */
	const hop = 0;
	/** `/cron host start|stop`: this pi's override of `[host] auto` for the hand-off when it quits. */
	let handOffOnQuit: boolean | undefined;
	/**
	 * The hand-off rule, in one place: this pi's `/cron host start|stop` if it said anything, else
	 * `[host] auto`. Three sites read it — the card, the scheduler line and the shutdown decision —
	 * and each used to spell it out again, one of them leaning on `??` binding tighter than `?:`.
	 */
	const handsOffOnQuit = (): boolean => handOffOnQuit ?? config.hostAuto;
	const dir = defaultLoopsDir(getAgentDir());
	/** Everything this process diagnoses, kept after the window is gone. */
	const log = new LoopsLog(dir, `pi-${process.pid}.log`);
	/** This package's directory: a sub-session must not load a second copy of this extension. */
	const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

	let session: SessionSnapshot = { cwd: process.cwd() };
	let lastCtx: ExtensionContext | undefined;
	let schedulerStarted = false;
	/**
	 * Whether this extension instance has already had its `session_start`.
	 *
	 * pi replaces a session in rpc mode by building a new runtime and rebinding the extensions to it —
	 * and it rebinds twice: `AgentSessionRuntimeHost.finishSessionReplacement` calls the rebind
	 * callback rpc mode registered, and rpc mode's own `switch_session` / `fork` / `clone` handler
	 * calls it again. `AgentSession.bindExtensions` re-emits the session's start event on each bind, so
	 * every clear and resume in the browser front end delivered `session_start` twice, three
	 * milliseconds apart: two `session start:` lines in the log, and — the part that matters — two MCP
	 * source starts, two hook loads, two attempts to take the clock back from the headless host. A
	 * start is a start until its shutdown, which pi does emit exactly once per session, so that is
	 * what this counts.
	 */
	let startHandled = false;
	/** The two trigger sources this process *is*: the local crontab, and the dynamic-rule checker. */
	const LOCAL_SOURCES = 2;
	/**
	 * Whether those two are connected. They are this process's own scheduler, so they are live only
	 * while it is scheduling *and* owns the clock; on a non-leader the enumeration below has always
	 * called them `standby`, and the count above it used to call them connected in the same breath.
	 */
	const localSourcesConnected = (): boolean => schedulerStarted && scheduler.isLeader;

	/** This session as the schedulers see it: the project, the model and the thinking level of the chat. */
	const sessionSnapshot = (ctx: ExtensionContext): SessionSnapshot => ({
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinking: ctx.thinkingLevel,
		trusted: ctx.isProjectTrusted(),
	});
	/**
	 * Sub-agents run inside this process through pi's SDK: the same
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
		// through it, so a sub-agent inherits the parent's stream function.
		getParentModelRuntime: () => lastCtx?.modelRegistry as any,
		// The tools act in the run's own project and model — a loop for project B that schedules a
		// follow-up must not pin it to whichever project this pi happens to be open in.
		customTools: async (req: SubagentRequest) => {
			const shared = allMcpToolDefs();
			const automation = automationTools({ hop: req.hop, actor: "sub-agent", parentSessionId: req.parentSessionId, parentCwd: req.parentCwd }, toolHostFor(req));
			// A run in another project gets that project's own MCP servers too — this process only
			// loaded its own project's, and a loop belongs to its project, not to this window.
			const taken = new Set([...PI_BUILTIN_TOOL_NAMES, ...pi.getAllTools().map((t) => t.name), ...shared.map((t) => t.name), ...automation.map((t) => t.name)]);
			// `sameProject`, not a string comparison: `--cwd ./sub`, a worktree or a symlinked path in
			// the project this pi has open is this project, and treating it as foreign warns about an
			// ignored MCP config and connects a second copy of servers this process already runs.
			const project = req.cwd && !sameProject(req.cwd, session.cwd) ? await mcpPool.toolsFor(req.cwd, taken) : [];
			return [...shared, ...project, ...automation];
		},
		// The project this session is open in — itself and what is inside it, never an ancestor
		// (`sessionTrustCovers`) — or one the user trusted before (pi's saved decisions), and there
		// exactly: a job's cwd can be model-chosen, and pi's inherited trust would make every
		// directory under a trusted repo (node_modules, a submodule, an extracted tarball) able to
		// load its own extensions and MCP servers in an unattended run. See src/trust.ts.
		isTrusted: (cwd) => (!!session.trusted && sessionTrustCovers(session.cwd, cwd)) || isExactlyTrusted(getAgentDir(), cwd),
		ownDir: PACKAGE_DIR,
		allowCommands: () => config.allowCommands,
		// The daily cap, read while a run is in flight and not only before it is dispatched. Lazy: the
		// scheduler is built with this runner, and asking it anything before then would be a cycle.
		budget: () => scheduler.budgetState(),
		log: (msg) => {
			log.warn(`sub-agent: ${msg}`);
			if (lastCtx?.hasUI) lastCtx.ui.notify(`[sub-agent] ${msg}`, "warning");
		},
	});

	/**
	 * `[cron] max_concurrent_runs` counts sub-agents, not loop runs: the scheduler, the trigger
	 * runtime and the /goal evaluator all start in-process pi sessions in *this* process, on the same
	 * model and the same bill, so they share one counter (src/slots.ts). Counting per pipeline meant
	 * a setting of 3 permitted three runs plus three checks plus an evaluator.
	 */
	const subagentSlots = new SubagentSlots(() => config.maxConcurrentRuns);

	const scheduler: LoopScheduler = new LoopScheduler({
		dir,
		hop,
		slots: subagentSlots,
		getSession: () => session,
		getSettings: () => ({ maxConcurrentRuns: config.maxConcurrentRuns, catchUp: config.cronCatchUp, dailyBudgetUsd: config.dailyBudgetUsd }),
		runner,
		kind: "interactive",
		// A plain job whose session is gone is parked, /cron gc removes it.
		sessionExists: (id) => sessionExists(path.join(getAgentDir(), "sessions"), id),
		hooks: {
			onInject: (_job, prompt, runId) => {
				if (!lastCtx) return;
				const idle = lastCtx.isIdle();
				pi.sendUserMessage(prompt, idle ? undefined : { deliverAs: "followUp" });
				triggeredTurnLine(runId, idle);
			},
			onRunStart: (job, runId) => {
				auditCronStart(triggers.store, job, runId);
				refreshBadge();
				// The same two events the headless host fires. Whether a run happens here or there is
				// an accident of who held the clock, and a hook rule should not be able to tell.
				fireRunHook({ event: "run_start", run_job: job.name ?? job.id, run_id: runId, message_summary: truncateSummary(`${job.name ?? job.id}: ${job.prompt}`) });
			},
			onCatchUp: (job, dueAt) => {
				if (lastCtx?.hasUI && sameProject(job.cwd, session.cwd)) lastCtx.ui.notify(`cron ${job.name ?? job.id}: catching up the run missed at ${formatLocal(dueAt)}`, "info");
			},
			onRunFinished: ({ job, record, findings, result }) => {
				auditCronFinish(triggers.store, job, record, result.stopReason === "aborted");
				refreshBadge();
				fireRunHook({
					event: "run_end",
					run_job: job.name ?? job.id,
					run_id: record.runId,
					run_ok: record.ok,
					run_findings: record.findings,
					run_error: record.error ? redact(record.error) : null,
					run_cost_usd: record.usage?.cost ?? null,
					message_summary: truncateSummary(record.ok ? `${job.name ?? job.id}: ok · ${record.findings} finding(s)` : `${job.name ?? job.id}: failed: ${record.error ?? "unknown error"}`),
				});
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
			// These carry "job disabled", "state write failed", "cannot read jobs"; the scheduler says
			// which of its lines are routine instead of leaving it to be guessed from the wording.
			log: (msg, level) => diagnostic(msg, level),
			onSchedulerError: (msg) => diagnostic(msg),
			onBudgetExceeded: (spent, cap) => diagnostic(`today's automation has cost $${spent.toFixed(2)} of the $${cap.toFixed(2)} budget; dispatching is paused until tomorrow or a higher [limits] daily_budget_usd`),
		},
	});

	/* ---------------------------------------------------------- triggers */

	let config = loadConfig(dir);
	const triggers: TriggerRuntime = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: scheduler.store,
		getSession: () => session,
		pollIntervalSecs: config.triggerPollIntervalSecs,
		runTimeoutMs: config.triggerRunTimeoutMs,
		runner,
		dedupFile: path.join(dir, "dedup.json"),
		// Checks and actions cost the same money and the same process as loop runs, so they draw on the
		// same counter rather than on a second one of their own.
		slots: subagentSlots,
		budget: () => scheduler.budgetState(),
		hop,
		// A project's checks run in a pi open in that project, so a result lands in the conversation it belongs to.
		self: scheduler.self,
		presence: () => scheduler.presenceList(),
		isLeader: () => scheduler.isLeader,
		hooks: {
			onPromote: async (content, trigger) => {
				// Promotion = the result becomes visible to future turns (inserting a `[Trigger …]` user
				// message into the parent session). Only into a chat that belongs to the rule's project;
				// a different project's chat gets nothing — the finding goes to the inbox instead.
				if (trigger.cwd && !sameProject(trigger.cwd, session.cwd)) {
					await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: content.replace(/^\[Trigger [^\]]+\]\s*/, ""), runId: trigger.traceId, jobId: trigger.sourceLabel, cwd: trigger.cwd });
					refreshBadge();
					return "inbox";
				}
				// Idle → inserted without a model call; streaming → follow-up queue, which runs a turn
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
			// Trigger diagnostics carry failures, dedup and deferral decisions: the log always, and a
			// notification for the ones a user would otherwise never learn about.
			log: (msg) => {
				log.info(`triggers: ${msg}`);
				if (lastCtx?.hasUI) lastCtx.ui.notify(`[triggers] ${msg}`, /failed|disabled|not run/.test(msg) ? "warning" : "info");
			},
		},
	});
	// Trigger audit is kept as session custom entries (trigger / trigger_result / trigger_promotion),
	// so it resumes with the session and travels in archives, on top of the machine-wide JSONL.
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
	const mcpPool = new McpPool({
		isTrusted: (cwd) => isExactlyTrusted(getAgentDir(), cwd),
		resolveToken: resolveMcpToken,
		log: (msg) => {
			log.warn(`mcp pool: ${msg}`);
			if (lastCtx?.hasUI) lastCtx.ui.notify(`[mcp] ${msg}`, "warning");
		},
	});
	let mcpConfigs: McpServerConfig[] = [];
	let mcpConfigError: string | undefined;
	const mcpDiagnostics: string[] = [];

	/** user `mcp.toml` + project `.pi/mcp.toml` (same name → project wins). Project config needs project trust. */
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

	/** MCP tool names registered with pi, per server. */
	const mcpToolNames = new Map<string, string[]>();
	/** The registered tool definitions per server — handed to every sub-session as customTools. */
	const mcpToolDefs = new Map<string, ToolDefinition<any, any>[]>();
	function allMcpToolDefs(): ToolDefinition<any, any>[] {
		return [...mcpToolDefs.values()].flat();
	}

	/**
	 * After the handshake, `tools/list` and register every server tool with
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

	/** Trigger output as a bounded card in the transcript, never an LLM message. */
	function showTriggerCard(ctx: ExtensionContext, outcome: TriggerOutcome): void {
		const quiet = outcome.ok && outcome.delivery === "sub_agent" && outcome.matchedRules.length === 0;
		if (quiet) return; // quiet checks stay in /triggers status + audit, not in the panel
		const secs = Math.round(outcome.durationMs / 1000);
		const cost = outcome.cost ? ` · $${outcome.cost.toFixed(3)}` : "";
		const title = outcome.ok
			? `trigger ${outcome.trigger.sourceLabel} · ${outcome.trigger.eventLabel} · ${secs}s${cost}${outcome.matchedRules.length ? ` · matched ${outcome.matchedRules.length}` : ""}${outcome.promoted ? " · promoted to chat" : ""}`
			: `trigger ${outcome.trigger.sourceLabel} FAILED · ${secs}s`;
		const lines: string[] = [];
		if (!outcome.ok) lines.push(`! ${outcome.error ?? "unknown error"}`);
		for (const r of outcome.matchedRules) lines.push(`• ${r.id.slice(0, 12)} when ${previewRedacted(r.condition, 60)} -> ${previewRedacted(r.action, 60)}${r.fireOnce ? " (fired once, now disabled)" : ""}`);
		if (outcome.summary) lines.push(...previewRedacted(outcome.summary, 600).split("\n").slice(0, 8));
		lines.push(`trace ${outcome.trigger.traceId.slice(0, 8)} · /triggers audit`);
		if (ctx.mode === "tui") show(ctx, title, lines);
		else ctx.ui.notify([title, ...lines].join("\n"), outcome.ok ? "info" : "warning");
	}

	/* ------------------------------------------------------ lifecycle hooks */

	let hookRunner: HookRunner | undefined;

	async function fireHook(data: HookEventData, ctx?: ExtensionContext): Promise<void> {
		// Sub-agents are in-process sessions without this extension; only the interactive session fires hooks.
		if (!hookRunner?.hasHooksFor(data.event)) return;
		// Hooks are awaited inline, so a hook always completes before the agent moves on
		// (and nothing is lost at exit). `[hooks] mode = "async"` restores the queued-off-turn behavior.
		if (config.hooksMode === "async") void hookRunner.fire(data, ctx?.signal).catch((err: any) => log.warn(`hooks: ${err?.message ?? err}`));
		else await hookRunner.fire(data, ctx?.signal);
	}

	/**
	 * A run's hooks, from the scheduler's callbacks. Never awaited even in `sync` mode: those
	 * callbacks are on the tick's path, and a webhook that hangs must not hold up the clock — the
	 * run it is announcing has already started or already finished. `sync` is about ordering within
	 * a conversation turn, and a run is not one.
	 */
	function fireRunHook(data: HookEventData): void {
		if (!hookRunner?.hasHooksFor(data.event)) return;
		void hookRunner.fire(data).catch((err: any) => log.warn(`hooks: ${err?.message ?? err}`));
	}

	/* ------------------------------------------------------------ panel */

	const PANEL_KEY = "pi-loops-panel";
	const PANEL_RULE_LIMIT = 5; // more than five rules is a list, not a panel
	let panelOn = panelEnabled(readUiPrefs(dir));

	function setPanelEnabled(on: boolean): void {
		panelOn = on;
		// `ui.json` also holds what the browser front end remembered, and this used to write the whole
		// file: a panel toggle sent the next session back to pi's default model. src/ui-prefs.ts is
		// where that merge lives now, for every writer this side of the front end.
		writeUiPref(dir, "panel", on);
		refreshPanel();
	}

	/**
	 * The panel (Triggers / Polling / Inbox / Cron / sources), rendered as a widget
	 * above the editor. Hidden when there is nothing to show.
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
		if (!panelOn || !schedulerStarted) {
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
				// Polling: checked_at · outcome, source / event, trace, summary.
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

	/**
	 * The system line when an inject-and-run turn starts (or is queued behind the current one). The id
	 * is a rule's trace for a trigger and a run id for a cron inject, which has no trace; the line
	 * calls it a trace either way, because that is the word people have learned to look for.
	 */
	function triggeredTurnLine(runId: string, idle: boolean): void {
		if (!lastCtx?.hasUI) return;
		lastCtx.ui.notify(idle ? `running triggered turn (trace ${runId.slice(0, 8)})` : `queued triggered turn (trace ${runId.slice(0, 8)}) after the current one`, "info");
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

	/**
	 * The same state the TUI panel draws, written into the session as a `pi_loops_snapshot` entry so
	 * a front end that is not a terminal can read it. Everything here lives in this process — which
	 * MCP servers actually connected, what they exposed, which tools are active, whether this pi
	 * owns the clock — and none of it is in the store files a reader could open instead.
	 */
	function snapshotData(): Record<string, unknown> {
		const rules = triggers.store.load().filter((r) => sameProject(r.cwd, session.cwd));
		const jobs = scheduler.store.load().filter((j) => sameProject(j.cwd, session.cwd));
		const poll = triggers.lastPoll;
		return {
			version: PI_LOOPS_VERSION,
			cwd: session.cwd,
			host: os.hostname(),
			scheduler: {
				running: schedulerStarted,
				leader: schedulerStarted && scheduler.isLeader,
				runs: scheduler.runningCount,
				checks: triggers.runningList().filter((r) => r.sourceLabel === "local:dynamic").length,
				deduped: triggers.dedupedCount,
			},
			counts: { jobs: jobs.length, jobsEnabled: jobs.filter((j) => j.enabled).length, rules: rules.length, rulesEnabled: rules.filter((r) => r.enabled).length, inboxNew: scheduler.inbox.newCount() },
			mcp: mcpSources.map((src) => ({
				name: src.config.name,
				state: src.status.state,
				kind: src.config.kind,
				tools: mcpToolNames.get(src.config.name) ?? [],
				injects: !!(src.config.injectAndRun || src.config.injectSummary),
				queued: src.status.queuedCount,
				dropped: src.status.droppedCount,
				attention: src.status.requiresAttention ? previewRedacted(src.status.requiresAttention, 120) : undefined,
				lastError: src.status.lastError ? previewRedacted(src.status.lastError, 160) : undefined,
			})),
			// A parse error can quote the offending line of mcp.toml, and this entry is written to the
			// session file — so it goes through the same redaction as everything else that is shown.
			mcpConfigError: mcpConfigError ? previewRedacted(mcpConfigError, 240) : undefined,
			hooks: { count: hookRunner?.hooks.length ?? 0, events: [...new Set((hookRunner?.hooks ?? []).map((h) => h.event))] },
			tools: lastCtx ? pi.getActiveTools() : [],
			poll: poll ? { at: poll.at, outcome: poll.outcome, sourceLabel: poll.sourceLabel, eventLabel: poll.eventLabel, traceId: poll.traceId, summary: previewRedacted(poll.summary, 200) } : undefined,
			at: stamp(),
		};
	}

	let lastSnapshotFingerprint: string | undefined;
	let lastSnapshotAt = 0;

	/** Write the snapshot when `src/snapshot.ts` says this change deserves a permanent entry. */
	function emitSnapshot(force = false): void {
		if (!lastCtx) return;
		try {
			const data = snapshotData();
			const fingerprint = snapshotFingerprint(data);
			const now = Date.now();
			if (!shouldEmitSnapshot({ fingerprint: lastSnapshotFingerprint, at: lastSnapshotAt }, fingerprint, now, force)) return;
			lastSnapshotFingerprint = fingerprint;
			lastSnapshotAt = now;
			pi.appendEntry("pi_loops_snapshot", data);
		} catch (err: any) {
			// Reached from the tick, which runs as `void this.tick()`; pi installs no
			// unhandledRejection handler, so a throw here would take the session down.
			log.warn(`snapshot failed: ${err?.message ?? err}`);
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
		emitSnapshot();
		if (!lastCtx?.hasUI) return;
		const parts: string[] = [];
		const n = scheduler.inbox.newCount();
		if (n > 0) parts.push(`Inbox: ${n} new`);
		// Machine-wide like the inbox count and the running list above it: the clock is one per host,
		// and a loop failing in another checkout is still this machine's automation going quiet.
		const failing = failingSummary(scheduler.store.load());
		if (failing) parts.push(failing);
		const running = [...scheduler.runningLabels(), ...triggers.runningList().map((r) => (r.sourceLabel === "local:dynamic" ? "trigger-check" : r.sourceLabel))];
		if (running.length) parts.push(`running: ${running.join(", ")}`);
		const attention = mcpSources.filter((s) => s.status.state === "disconnected" || s.status.state === "auth_failed").length;
		if (attention) parts.push(`mcp: ${attention} source${attention === 1 ? "" : "s"} down`);
		if (schedulerStarted && !scheduler.isLeader) parts.push("loops standby");
		lastCtx.ui.setStatus(STATUS_KEY, parts.length ? parts.join(" · ") : undefined);
	}

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
			const checker = record.checker;
			if (!checker.ok) lines.push(`checker FAILED (${checker.error}); findings entered unverified`);
			else lines.push(`checker kept ${checker.kept}, dropped ${checker.dropped.length}${checker.unreviewed ? `, ${checker.unreviewed} unreviewed` : ""}${checker.cost ? ` · $${checker.cost.toFixed(3)}` : ""} — /cron trace ${label} 1 checker`);
			for (const drop of checker.dropped) lines.push(`  ✗ ${previewRedacted(drop.text, 100)} — ${previewRedacted(drop.reason, 100)}`);
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
			const dormant = !job.stateful && job.sessionId !== session.sessionId ? `[dormant: session ${(job.sessionId ?? "?").slice(0, 8)} not open here]` : undefined;
			const orphan = job.stateful && !fs.existsSync(job.cwd) ? "[orphan: cwd missing]" : undefined;
			const marks = [job.stateful ? "[stateful]" : undefined, job.verify ? "[verify]" : undefined, dormant, orphan, job.running ? `running ${job.running.runId}` : undefined, job.catchUp ? undefined : "[no-catchup]"]
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
	 * The `cron_control_plane` audit: every add / enable / disable / remove, from a slash
	 * command or a tool, leaves a custom entry in the session (never in LLM context).
	 */
	function cronControlAudit(op: "add" | "enable" | "disable" | "remove", actor: "slash" | "tool" | "sub-agent", before?: LoopJob, after?: LoopJob): string {
		const job = after ?? before;
		const next = after?.enabled ? computeNext({ schedule: after.schedule, createdAt: Date.parse(after.createdAt), lastFiredAt: after.lastFiredAt ? Date.parse(after.lastFiredAt) : undefined }, Date.now()) : undefined;
		// pi.appendEntry returns no id; mint one so tool results can point at the entry.
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
			next_run: next ? stamp(next) : undefined,
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
		"/cron set <n|id|name> [--model <p/id>|-] [--thinking <lvl>|-] [--timeout <dur>|-] [--name <n>|-]   change what a job runs with (- = use the session's current)",
		'    also [--prompt "<text>"] [--schedule "<expr>"]: reword a loop or move it to another hour in place — the job keeps its id, and a stateful loop keeps its notes',
		"/cron state <n|id|name>        the loop's notes (state spine)",
		"/cron runs [n|id|name]         recent runs          /cron trace [n|id|name] [k] [checker]   k-th latest run's transcript (maker, or its checker)",
		"/cron scheduler                who owns the timer     /cron panel on|off   side panel above the editor",
		"/cron snapshot                 what only this process knows — connected MCP servers and their tools, who owns the clock — written into the session, for a front end that is not a terminal",
		"/cron gc                       remove plain jobs whose session was deleted (they are parked as disabled first)",
		"/cron cost [today|7d|all]      what automation has cost, by job, and today's budget if one is set",
		"/cron clear <n|id|name>        clear a stuck `running` marker left by a process that is gone",
		"/cron remove <ref> [--purge]   remove a job; its loop state is kept unless --purge",
		"/cron disable --all            pause every job in this project (--all-projects for the machine); /cron enable --all resumes",
		"/cron host [start|stop]        the headless host that keeps the clock after the last pi quits; start = hand off on quit even with [host] auto = false",
		"/inbox                         triage findings from stateful jobs (/inbox help)",
		`/session-export [path] [--exclude-triggers]      transcript + this project's cron jobs, trigger rules and loop state as one ${ARCHIVE_EXT} archive`,
		"/session-import <path> [--activate-triggers=on|off] [--cwd <dir>] [--resume]   restore it here (automation stays off unless activated)",
	];

	const cronCompletions = (prefix: string) => {
		const subs = ["add", "list", "all", "enable", "disable", "remove", "set", "clear", "cost", "gc", "host", "run", "state", "runs", "trace", "scheduler", "panel", "snapshot", "help"];
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
			// Every subcommand, by name only: with five more of them the argument spellings no longer fit
			// on a line a notification can show, and `/cron help` has them all. A name left out of here
			// is a subcommand nobody finds, which is the worse of the two.
			const CRON_USAGE = "[list|all|add|set|run|enable|disable|remove|state|runs|trace|cost|clear|gc|host|scheduler|panel|snapshot|help] — /cron help for the arguments";
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
							show(ctx, `Cron jobs (this machine, ${all.length}, times ${localOffset(Date.now())}):`, jobLines(all));
							return;
						}
						const here = all.filter((j) => sameProject(j.cwd, session.cwd));
						const elsewhere = all.length - here.length;
						const lines = here.length ? jobLines(here) : ["(none in this project)"];
						if (elsewhere) lines.push(`+ ${elsewhere} job${elsewhere === 1 ? "" : "s"} in other projects — /cron all`);
						show(ctx, `Cron jobs (${homeRel(session.cwd)}, ${here.length}, times ${localOffset(Date.now())}):`, lines);
						return;
					}
					case "help":
						show(ctx, "/cron", CRON_HELP);
						return;
					case "panel": {
						const on = rest.trim() === "on" ? true : rest.trim() === "off" ? false : !panelOn;
						setPanelEnabled(on);
						ctx.ui.notify(`panel ${on ? "on" : "off"} (Triggers / Inbox / Cron / MCP widget above the editor)`, "info");
						return;
					}
					case "snapshot": {
						// The panel's contents as a `pi_loops_snapshot` session entry: which MCP servers
						// connected, what they exposed, the active tools, who owns the clock. A front end
						// that is not a terminal (src/web.mjs) reads that instead of the widget.
						emitSnapshot(true);
						ctx.ui.notify("wrote a pi_loops_snapshot entry to the session", "info");
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
						if (job.stateful && !schedulerStarted) {
							ctx.ui.notify("the scheduler is not running in this session (non-interactive mode)", "warning");
							return;
						}
						const ran = await scheduler.runNow(job.id);
						// A refusal comes back as the reason, phrased to follow the job's name — the shape
						// this line has always had ("nightly is already running").
						ctx.ui.notify(ran === true ? `running ${job.name ?? job.id} in the background…` : `${job.name ?? job.id} ${ran}`, ran === true ? "info" : "warning");
						return;
					}
					case "enable":
					case "resume":
					case "disable":
					case "pause": {
						const enable = sub === "enable" || sub === "resume";
						// Quitting pi is the *on* switch here (the host takes over), so "stop everything"
						// has to be one command rather than one per job.
						const scope = rest.trim();
						if (scope === "--all" || scope === "--all-projects") {
							const everywhere = scope === "--all-projects";
							const targets = scheduler.store.load().filter((j) => (everywhere || sameProject(j.cwd, session.cwd)) && j.enabled !== enable);
							for (const j of targets) {
								const after = await scheduler.store.update(j.id, (x) => {
									x.enabled = enable;
									if (enable) x.lastError = undefined;
								});
								cronControlAudit(enable ? "enable" : "disable", "slash", j, after ?? j);
							}
							refreshBadge();
							ctx.ui.notify(`${enable ? "enabled" : "disabled"} ${targets.length} job(s)${everywhere ? " on this machine" : " in this project"}`, "info");
							return;
						}
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
						// `--purge` also deletes the loop's notes and transcripts. Without it they are kept:
						// remove-and-re-add is how a schedule or prompt gets changed, and that must not
						// throw away months of accumulated state.
						const purge = /(^|\s)--purge(\s|$)/.test(rest);
						const job = pick(rest.replace(/(^|\s)--purge(\s|$)/, " ").trim());
						if (!job) return;
						await scheduler.store.remove(job.id, { purge });
						cronControlAudit("remove", "slash", job, undefined);
						const kept = job.stateful && !purge ? `; its loop state is kept (${homeRel(scheduler.store.statePath(job.id))}) — /cron gc --purge clears orphaned state` : purge && job.stateful ? " and its loop state" : "";
						ctx.ui.notify(`removed cron job ${job.id}${job.name ? ` "${job.name}"` : ""}${kept}`, "info");
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
						const hostSnapshot = answer?.ok ? answer.snapshot : undefined;
						show(ctx, "Background host", [
							live ? `  running: pid ${live.pid} since ${formatLocal(Date.parse(live.startedAt))} — unexpected while a pi is open; it exits on its next tick` : "  not running (it runs only while no pi is open)",
							...(hostSnapshot ? renderHostSnapshot(hostSnapshot) : []),
							`  hand-off on quit: ${handsOffOnQuit() ? "on" : "off"}${handOffOnQuit === undefined ? ` ([host] auto = ${config.hostAuto}; /cron host start|stop overrides it for this pi)` : handOffOnQuit ? " (/cron host start)" : " (/cron host stop)"}`,
							`  log: ${homeRel(path.join(dir, HOST_LOG))}`,
							"  /cron host start | stop",
						]);
						return;
					}
					case "clear": {
						// A marker left by a process that was killed, whose pid another process now has,
						// parks a loop forever: `clearStaleRunning` sees a live pid and leaves it alone.
						const job = pick(rest);
						if (!job) return;
						if (!job.running) {
							ctx.ui.notify(`${job.name ?? job.id} is not marked running`, "info");
							return;
						}
						const marker = job.running;
						const ok = await ctx.ui.confirm("Clear the running marker?", `${job.name ?? job.id} is marked as running since ${formatLocal(Date.parse(marker.startedAt))} by pid ${marker.pid}${marker.host && marker.host !== os.hostname() ? ` on ${marker.host}` : ""}.\n\nClear it only if that run is really gone — if it is still going, its result will still be written.`);
						if (!ok) return;
						const updated = await scheduler.store.update(job.id, (j) => {
							j.running = undefined;
							j.lastError = `running marker cleared by hand (was ${marker.runId.slice(0, 12)}, pid ${marker.pid})`;
						});
						refreshBadge();
						ctx.ui.notify(updated ? `cleared the running marker on ${updated.name ?? updated.id}; it can fire again` : "job vanished", "info");
						return;
					}
					case "cost": {
						// The run log already holds every number; nothing added them up before, so a
						// headless host could run for a week before anyone saw the bill.
						const window = rest.trim() || "today";
						const now = Date.now();
						const since = (() => {
							if (window === "all") return 0;
							if (/^\d+d$/.test(window)) return now - Number(window.slice(0, -1)) * 86_400_000;
							const midnight = new Date(now);
							midnight.setHours(0, 0, 0, 0);
							return midnight.getTime();
						})();
						if (window !== "today" && window !== "all" && !/^\d+d$/.test(window)) {
							ctx.ui.notify("usage: /cron cost [today|7d|all]", "warning");
							return;
						}
						const spend = scheduler.store.spend(since);
						const byJob = [...spend.byJob.entries()].sort((a, b) => b[1].cost - a[1].cost);
						const budget = scheduler.budgetState();
						const label = window === "all" ? "since the run log was last rotated" : window === "today" ? "today" : `the last ${window}`;
						show(ctx, `Automation cost ${label}: $${spend.total.toFixed(3)} over ${spend.runs} run(s)`, [
							...(spend.rotated > 0 ? [`  including $${spend.rotated.toFixed(3)} from runs the log has already rotated away`] : []),
							...(budget.cap > 0 ? [`  today's budget: $${budget.spent.toFixed(2)} of $${budget.cap.toFixed(2)}${budget.over ? " — dispatching is paused" : ""}`] : ["  no budget cap set ([limits] daily_budget_usd)"]),
							...byJob.slice(0, 12).map(([id, e]) => `  $${e.cost.toFixed(3)}  ${e.runs} run(s)  ${e.name ?? id}`),
							...(byJob.length > 12 ? [`  (+${byJob.length - 12} more)`] : []),
							...(spend.runs ? [] : ["  nothing has run in this window"]),
						]);
						return;
					}
					case "gc": {
						// The store is machine-wide, so an unscoped gc here would delete another
						// project's jobs — and with --purge their loop state — from a session that
						// never listed them. Every other listing is project-scoped; so is this.
						const all = /(^|\s)--all(\s|$)/.test(rest);
						const removed = await scheduler.gc((j) => all || sameProject(j.cwd, session.cwd));
						for (const job of removed) cronControlAudit("remove", "slash", job, undefined);
						const orphans = scheduler.store.orphanStates();
						const purge = /(^|\s)--purge(\s|$)/.test(rest);
						if (purge && orphans.length) for (const o of orphans) scheduler.store.purgeState(o.id);
						show(ctx, `removed ${removed.length} job(s) whose session no longer exists${all ? " (every project)" : " in this project"}`, [
							...removed.map((j) => `  - ${j.id}${j.name ? ` "${j.name}"` : ""}  (session ${(j.sessionId ?? "?").slice(0, 8)})`),
							...(orphans.length && !purge ? [`  ${orphans.length} loop state file(s) belong to jobs that are gone (${Math.round(orphans.reduce((n, o) => n + o.bytes, 0) / 1024)} KB) — /cron gc --purge deletes them`] : []),
							...(all ? [] : ["  --all also collects other projects' dead jobs"]),
							...(purge && orphans.length ? [`  deleted ${orphans.length} orphaned loop state file(s)`] : []),
						]);
						refreshBadge();
						return;
					}
					case "set": {
						// A pin here is explicit and editable.
						// --prompt and --schedule edit the job in place: its id, and therefore the loop's
						// notes at state/<id>.md, survive a rewording that used to cost a remove-and-re-add.
						const change = parseSetArgs(rest, { job: true });
						const job = pick(change.ref);
						if (!job) return;
						// What this edit means — which stamp to anchor, whether the job is now due at once,
						// whether the new expression will ever match — is decided in src/job-edit.ts, where
						// it can be tested. Anything it refuses throws before the store is touched.
						const applied = applyJobEdit(job, change, {
							now: Date.now(),
							maxPromptBytes: MAX_PROMPT_BYTES,
							checkName: checkJobName,
							others: scheduler.store.load().filter((j) => j.id !== job.id),
						});
						// The patch carries only the edited fields: `update` re-reads under a lock, and a tick
						// that started a run in between has already set `running` on the copy it hands back.
						const updated = await scheduler.store.update(job.id, (j) => Object.assign(j, applied.patch));
						if (!updated) return;
						for (const line of applied.changed) log.info(`cron ${updated.id}: ${line}`);
						// A typo in a cron expression is invisible until it fails to fire, so the next run is
						// part of the confirmation.
						const nextRun =
							applied.nextRun.kind === "disabled"
								? `— (disabled; /cron enable ${updated.name ?? updated.id})`
								: applied.nextRun.kind === "due"
									? "due now (the next tick will fire it)"
									: applied.nextRun.kind === "at"
										? formatLocal(applied.nextRun.at)
										: "—";
						show(ctx, `updated cron job ${updated.id}${updated.name ? ` "${updated.name}"` : ""}`, [
							`  action: ${previewRedacted(updated.prompt, 120)}`,
							`  schedule: ${formatSchedule(updated.schedule)}`,
							`  next run: ${nextRun}`,
							`  model: ${updated.model ?? "(the running session's current model)"}`,
							`  thinking: ${updated.thinking ?? "(the running session's current level)"}`,
							`  timeout: ${updated.timeoutMs ? `${Math.round(updated.timeoutMs / 1000)}s` : "default"}`,
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
							const checker = run.checker;
							const lines = [`checker ${checker.ok ? "ok" : `FAILED: ${checker.error}`} · kept ${checker.kept} · dropped ${checker.dropped.length} · unreviewed ${checker.unreviewed} · ${Math.round(checker.durationMs / 1000)}s${checker.cost ? ` $${checker.cost.toFixed(3)}` : ""}${checker.model ? ` · ${checker.model}` : ""}`];
							for (const drop of checker.dropped) lines.push(`  dropped: ${drop.text} — ${drop.reason}`);
							if (checker.sessionFile) lines.push("", ...summarizeSessionFile(checker.sessionFile, { maxLines: 60 }).map((line) => line.text), "", `full transcript: pi --session ${checker.sessionFile}`);
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
							`this process: pid ${me}, ${schedulerStarted ? (scheduler.isLeader ? "owns the timer" : "standby") : "not scheduling (non-interactive)"}, ${scheduler.runningCount} run(s) in flight${scheduler.runningCount ? ` (${scheduler.runningLabels().join(", ")})` : ""}`,
							`timer owner: ${leader ? `pid ${leader.pid}@${leader.host}${(leader as any).kind === "host" ? " (background host)" : ""}, heartbeat ${formatLocal(Date.parse(leader.heartbeatAt))}` : "none"}`,
							`background host: ${liveHost(dir) ? `pid ${liveHost(dir)!.pid} (exits on its next tick: a pi is open)` : "not running (runs only while no pi is open)"} · hand-off on quit: ${handsOffOnQuit() ? "on" : "off"}`,
							`store: ${homeRel(dir)}`,
							`log: ${homeRel(log.file)}`,
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
		description: 'Scheduled jobs: /cron add [--stateful] "<schedule>" <prompt> — /cron help',
		getArgumentCompletions: cronCompletions,
		handler: cronHandler,
	});
	pi.registerCommand("crontab", { description: "Alias of /cron", getArgumentCompletions: cronCompletions, handler: cronHandler });
	pi.registerCommand("loop", { description: "Alias of /cron", getArgumentCompletions: cronCompletions, handler: cronHandler });

	const INBOX_USAGE = "[list|all|claim <n>|dismiss <n>|clear|help] [--all]";

	const INBOX_HELP = [
		"/inbox                list new findings of this project    /inbox --all   every project on this machine",
		"/inbox all [--all]    include claimed/dismissed history",
		"/inbox claim <n|id>   mark claimed and hand it to the agent as a real turn",
		"/inbox dismiss <n|id> mark dismissed        /inbox clear [--all]   dismiss the ones listed",
	];

	/** The project a finding came from, as `/cron` shows a job's: the directory name is enough to tell them apart. */
	const projectOf = (cwd: string) => (cwd ? path.basename(cwd) || homeRel(cwd) : "—");

	/** List lines: the full (≤500-char) finding, id prefix, project, source, when it arrived. */
	function inboxLines(entries: InboxEntry[], numbered: boolean): string[] {
		return entries.map((e, i) => {
			// Stored as an instant (ISO, UTC) and shown in this machine's timezone, like every other
			// time pi-loops puts on a screen. It used to be the stored string with the `Z` sliced
			// off — a UTC time wearing the shape of a local one, eight hours from the `next` on the
			// `/cron` line above it, with nothing on either to say which was which.
			const when = formatLocal(Date.parse(e.createdAt));
			const mark = e.verified ? "✓ " : "";
			// The project comes first of the three: with loops running in several checkouts it is what
			// decides whether a finding is this morning's problem, and claiming runs it in that cwd.
			if (!numbered) return `  [${e.status}] ${mark}${redact(e.text)}  (${projectOf(e.cwd)}, ${e.source})`;
			return `  ${i + 1}. [${e.id.slice(0, 12)}] ${mark}${redact(e.text)}  (${projectOf(e.cwd)}, ${e.source}, ${when})`;
		});
	}

	function claimPrompt(e: InboxEntry): string {
		const verified = e.verified ? `\n(An independent checker reviewed and kept this finding${e.verifiedReason ? `: ${e.verifiedReason}` : ""}.)` : "";
		return `A recurring loop (${e.source}, running in ${e.cwd}) reported this finding — investigate and address it:\n${e.text}${verified}`;
	}

	/* ------------------------------------------------------------------ /goal */

	/**
	 * A stop condition the session is held to. The goal lives in the session (append-only `goal_state` entries,
	 * so `--resume` finds it); after every settled turn an evaluator with no tools judges the
	 * condition against a bounded transcript and either stops, sends the agent back to work, or
	 * pauses. See src/goal.ts for the state machine and the prompts.
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
		const pursued = goal;
		if (!pursued || pursued.status !== "pursuing" || goalEvaluating) return;
		// A turn that the user interrupted, or that the provider failed, is not evidence about the
		// goal — and re-prompting after an abort would leave Esc unable to stop a goal at all.
		if (lastTurnStopReason === "aborted" || lastTurnStopReason === "error") return;
		goalEvaluating = true;
		const evaluatorStartedAt = Date.now();
		// Where the session is now. The continuation the evaluator may ask for is a prompt about
		// *this* point; if the user has taken the turn by the time it comes back, it must not be
		// delivered as a follow-up on theirs (see branchMovedSince).
		const evaluatedAt = ctx.sessionManager.getLeafId();
		const ctrl = new AbortController();
		goalAbort = ctrl;
		// The evaluator is a sub-agent like any other and bills like one, so it counts against
		// `[cron] max_concurrent_runs` — but it is never refused a slot. It is this session's own turn
		// loop, one at a time, and a busy machine quietly declining to evaluate would look exactly like
		// a goal that was never set. It can therefore push the count past the limit; see slots.ts.
		// Taken here, immediately before the try that releases it, so nothing in between can leak it.
		const slot = subagentSlots.occupy();
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
				prompt: evaluatorPrompt(pursued.condition, transcript),
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
			if (!goal || goal.status !== "pursuing" || goal.condition !== pursued.condition) return;
			let outcome: { state: GoalState; action: GoalAction };
			if (ctrl.signal.aborted) outcome = pauseFor(pursued, "goal evaluator cancelled");
			else if (!result.ok) outcome = pauseFor(pursued, `goal evaluator failed: ${result.errorMessage ?? "unknown error"}`);
			else {
				try {
					outcome = applyDecision(pursued, parseDecision(result.text));
				} catch (err: any) {
					outcome = pauseFor(pursued, err?.message ?? String(err));
				}
			}
			// A continuation belongs to the point the evaluation started from. If the session has moved
			// on since — an unrelated prompt, a rewind — it is held rather than delivered on top of
			// somebody else's turn; the turn now running settles into another evaluation, which judges
			// the session as it then is. A continuation that was never sent does not cost budget either.
			const held = outcome.action.kind === "continue" && branchMovedSince(ctx.sessionManager.getBranch(), evaluatedAt);
			persistGoal(ctx, held ? { ...outcome.state, iterations: pursued.iterations } : outcome.state);
			// The evaluator is a model call like any other: it belongs in the run log, or `/cron cost`
			// would under-report every session that has a goal set.
			scheduler.store.appendRun({
				runId: newId("run"),
				jobId: "goal",
				jobName: "goal evaluator",
				stateful: false,
				cwd: session.cwd,
				pid: process.pid,
				startedAt: stamp(evaluatorStartedAt),
				finishedAt: stamp(),
				ok: result.ok,
				error: result.ok ? undefined : result.errorMessage,
				findings: 0,
				droppedFindings: 0,
				stateUpdated: false,
				model: result.model,
				usage: result.usage,
				summary: previewRedacted(outcome.state.lastReason ?? "", 200),
				sessionFile: result.sessionFile,
			});
			scheduler.store.pruneSessions("goal", 20);
			if (outcome.action.kind === "stop") {
				show(ctx, "Goal achieved", [`  condition: ${previewRedacted(outcome.state.condition, 200)}`, `  evidence: ${previewRedacted(outcome.state.lastReason ?? "", 300)}`, `  ${outcome.state.iterations} continuation(s)`]);
			} else if (outcome.action.kind === "pause") {
				notifyOrLog(ctx, `[goal] paused: ${previewRedacted(outcome.action.reason, 200)} — /goal resume to continue`, "warning");
			} else if (held) {
				log.info(`goal: continuation held, the session moved on while the evaluator ran (${previewRedacted(outcome.state.lastReason ?? "", 160)})`);
				notifyOrLog(ctx, "[goal] not satisfied, but you sent something meanwhile — the continuation is held and re-evaluated when this turn settles", "info");
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
			slot.release();
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
		description: "Hold this session to a stop condition, evaluated after every turn",
		getArgumentCompletions: (prefix) => {
			const subs = ["pause", "resume", "clear", "help"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const text = args.trim();
			// The subcommand arms are guarded by arity: anything longer than the bare
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
					persistGoal(ctx, { ...goal, status: "cleared", updatedAt: stamp() });
					return ctx.ui.notify("goal cleared", "info");
				}
				if (sub === "resume" && goal.status === "achieved") return ctx.ui.notify("this goal was achieved; set a new one with /goal <condition>", "warning");
				// Resuming after the budget ran out starts the allowance again.
				const next: GoalState = sub === "pause" ? { ...goal, status: "paused", updatedAt: stamp() } : { ...goal, status: "pursuing", iterations: goal.status === "budget_limited" ? 0 : goal.iterations, updatedAt: stamp() };
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
			const subs = ["list", "all", "claim", "dismiss", "clear", "help", "--all"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const { sub, rest } = splitCommand(args);
			// The inbox is machine-wide because loops are; triage is per project, like /cron and
			// /triggers, with the same `--all` escape. It may sit anywhere in the line (`/inbox --all`,
			// `/inbox all --all`, `/inbox clear --all`), so it is read off the whole argument string.
			const everywhere = /(^|\s)--all(\s|$)/.test(args);
			const ref = rest.replace(/(^|\s)--all(\s|$)/, " ").trim();
			const scoped = (entries: InboxEntry[]) => (everywhere ? entries : inProject(entries, session.cwd, sameProject));
			const where = everywhere ? "this machine" : homeRel(session.cwd);
			try {
				switch (sub) {
					case "":
					case "--all":
					case "list": {
						const all = scheduler.inbox.listNew();
						const entries = scoped(all);
						if (!entries.length) {
							show(ctx, all.length ? `inbox: nothing new in ${homeRel(session.cwd)} — ${all.length} finding(s) elsewhere (/inbox --all)` : "inbox: empty — stateful loops (/cron add --stateful) report findings here", []);
							return;
						}
						const lines = inboxLines(entries, true);
						const elsewhere = all.length - entries.length;
						if (elsewhere) lines.push(`+ ${elsewhere} finding${elsewhere === 1 ? "" : "s"} in other projects — /inbox --all`);
						lines.push("claim with /inbox claim <n>, dismiss with /inbox dismiss <n>");
						show(ctx, `Inbox (${where}, ${entries.length} new, times ${localOffset(Date.now())}):`, lines);
						return;
					}
					case "all": {
						const entries = scoped(scheduler.inbox.list());
						show(ctx, `Inbox history (${where}, ${entries.length} total):`, entries.length ? inboxLines(entries, false) : ["(empty)"]);
						return;
					}
					case "help":
						show(ctx, "inbox", INBOX_HELP);
						return;
					case "claim":
					case "dismiss": {
						// Numbers are the numbers on screen — this project's list, as `/cron` does it; an id
						// or a prefix still resolves machine-wide, so a finding can be claimed from anywhere.
						const entries = /^\d+$/.test(ref) ? scoped(scheduler.inbox.listNew()) : scheduler.inbox.listNew();
						const entry = resolveInboxRef(entries, ref);
						if (!entry) {
							const n = Number(ref);
							ctx.ui.notify(!ref ? "usage: /inbox claim|dismiss <n or inb-id>" : Number.isInteger(n) ? `no inbox entry #${n} in ${where} (have ${entries.length}; /inbox --all lists every project)` : `no new inbox entry matching '${ref}'`, "warning");
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
						// What was listed is what is dismissed: with loops in several checkouts, a clear that
						// also wiped four other projects' unread findings would be unrecoverable.
						const n = await scheduler.inbox.dismissAllNew(everywhere ? undefined : (e) => belongsToProject(e, session.cwd, sameProject));
						refreshBadge();
						ctx.ui.notify(`dismissed ${n} inbox entr${n === 1 ? "y" : "ies"} in ${where}`, "info");
						return;
					}
					default:
						ctx.ui.notify(`unknown /inbox subcommand: ${sub}; usage: /inbox ${INBOX_USAGE}`, "warning");
				}
			} catch (err: any) {
				ctx.ui.notify(`inbox: ${err?.message ?? err}`, "error");
			}
		},
	});

	/* ---------------------------------------------------------- /triggers */

	// The menu names every subcommand; the arguments live in TRIGGERS_HELP below, which `/triggers
	// help` prints. This line used to *be* that help, so what it left out (`hooks`, `panel`)
	// was left out of the product.
	const TRIGGERS_USAGE = "[status|rules|sources|hooks|enable|disable|remove|set|run|running|audit|abort|panel|help] — /triggers help for the arguments";

	const TRIGGERS_HELP = [
		"/triggers                      rule counts, who owns the checker, its last check, push sources",
		"/triggers rules [--all]        this project's dynamic rules        (--all: every project on this machine)",
		"/triggers sources              MCP push sources, the local crontab, the dynamic checker — and what each has seen (/triggers hooks is the same view)",
		"/triggers enable <n|id>        /triggers disable <n|id>            also --all (this project) | --all-projects (the machine)",
		"/triggers remove <n|id>        also remove --all | remove --all-projects; /new-trigger creates one",
		"/triggers set <n|id> [--model <p/id>|-] [--thinking <lvl>|-] [--timeout <dur>|-]   what the action runs with (- = the session's current)",
		"/triggers run <n|id>           check one rule now — dedup, audit, sub-agent and promotion as on a poll",
		"/triggers running              actions in flight (dynamic checks and cron runs), and the sub-agent slots in use",
		"/triggers audit [N] [--all]    recent decisions, with each run's transcript path (default 10)",
		"/triggers abort <trace_id>     stop one running action             /triggers abort --all   stop every one",
		"/triggers panel on|off         side panel above the editor (Triggers / Inbox / Cron / MCP)",
		"create one: /new-trigger when ~/build.done exists, run cargo test and show me the result",
		"config: ~/.pi/agent/loops/config.toml [triggers] poll_interval_secs, mcp.toml for push sources, hooks.toml for lifecycle hooks",
	];

	function ruleLines(rules: ReturnType<TriggerStore["load"]>, numbered: boolean): string[] {
		return rules.map((r, i) => {
			const state = r.enabled ? "enabled" : "disabled";
			const fire = r.fireOnce ? "fire_once" : "repeat";
			const out = r.promoteToChat ? "promote_to_chat" : "audit_only";
			const fired = r.firedAt ? `, fired_at=${r.firedAt}` : "";
			const head = numbered ? `${String(i + 1).padStart(2)}. ` : "  - ";
			const other = r.createdBy?.sessionId && r.createdBy.sessionId !== session.sessionId ? `  (session ${r.createdBy.sessionId.slice(0, 8)})` : "";
				return `${head}${r.id} [${state}, ${fire}, ${out}${fired}] when ${previewRedacted(r.condition, 80)} -> ${previewRedacted(r.action, 80)}${!sameProject(r.cwd, session.cwd) ? `  (${homeRel(r.cwd)})` : ""}${other}`;
		});
	}

	pi.registerCommand("triggers", {
		description: "Show trigger sources, rules, running actions, and recent audit — /triggers help",
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "rules", "sources", "hooks", "enable", "disable", "remove", "set", "run", "running", "audit", "abort", "panel", "help"];
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
							`  local dynamic checker: ${schedulerStarted ? `this process for ${homeRel(session.cwd)}${scheduler.isLeader ? " (and, as timer owner, for projects with no pi open)" : ` (timer owned by pid ${leader?.pid ?? "?"})`}` : "not running here"}, polls every ${triggers.pollIntervalSecs}s while enabled rules exist (checks run in a pi open in the rule's project)`,
							`  last check: ${triggers.lastPoll ? `${formatLocal(Date.parse(triggers.lastPoll.at))} in ${homeRel(triggers.lastPoll.cwd)} — ${triggers.lastPoll.outcome}` : "none yet"}`,
							`  push trigger sources: ${mcpConfigs.length} configured MCP server(s) feed server-pushed events into the same trigger runtime (deduplicated machine-wide, hop ${hop})${mcpConfigError ? ` (config error: ${mcpConfigError})` : ""}`,
							`  sources: ${mcpSources.length + LOCAL_SOURCES} total, ${mcpSources.filter((s) => s.status.state === "connected").length + (localSourcesConnected() ? LOCAL_SOURCES : 0)} connected, ${mcpSources.filter((s) => s.status.requiresAttention).length} require attention`,
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
						// MCP hooks are registered first, then the cron hook, then the dynamic checker.
						const lines: string[] = [];
						const localState = localSourcesConnected() ? "connected" : schedulerStarted ? "standby" : "disabled";
						mcpSources.forEach((source, index) => {
							const status = source.status;
							lines.push(`  - source #${index + 1}: ${status.state}${status.reason ? ` (${previewRedacted(status.reason, 80)})` : ""} queued=${status.queuedCount} dropped=${status.droppedCount} deduped=${status.dedupedCount} last_event=${status.lastEventAt ?? "never"}${status.requiresAttention ? `  ! ${status.requiresAttention}` : ""}`);
							lines.push(`      subscriptions: ${status.subscriptionLabels.join(", ")}${source.config.injectAndRun ? " [inject_and_run]" : source.config.injectSummary ? " [inject_summary]" : ""} (${source.config.kind}, ${source.config.source}) · tools: ${(mcpToolNames.get(source.config.name) ?? []).length ? (mcpToolNames.get(source.config.name) ?? []).join(", ") : "none"}`);
							if (status.lastError) lines.push(`      last error: ${previewRedacted(status.lastError, 160)}`);
							if (status.lastStderr) lines.push(`      stderr: ${previewRedacted(status.lastStderr, 160)}`);
						});
						const jobs = scheduler.store.load();
						// By instant, not by string. Sorting the stamps themselves was right only while every
						// one of them ended in `Z`; they carry an offset now, and two spellings of the same
						// moment do not sort the way the moments do.
						const lastFired = jobs
							.map((j) => j.lastFiredAt)
							.filter((t): t is string => !!t)
							.sort((a, b) => Date.parse(a) - Date.parse(b))
							.at(-1);
						lines.push(`  - source #${mcpSources.length + 1}: ${localState} queued=${scheduler.runningCount} dropped=0 deduped=0 last_event=${lastFired ?? "never"}`);
						lines.push(`      subscriptions: ${jobs.length ? `local crontab: ${jobs.length} job(s), ${jobs.filter((j) => j.enabled).length} enabled` : "local crontab: 0 jobs"}`);
						lines.push(`  - source #${mcpSources.length + LOCAL_SOURCES}: ${localState} queued=${triggers.runningList().filter((r) => r.sourceLabel === "local:dynamic").length} dropped=0 deduped=${triggers.dedupedCount} last_event=${triggers.lastPoll?.at ?? "never"}`);
						lines.push("      subscriptions: dynamic trigger periodic check");
						if (mcpSources.length) lines.push("  (pushes are deduplicated machine-wide; results go to this chat only for this project's rules, otherwise to /inbox)");
						if (mcpConfigError) lines.push(`  ! ${mcpConfigError}`);
						show(ctx, `Trigger sources (${LOCAL_SOURCES + mcpSources.length}):`, lines);
						return;
					}
					case "enable":
					case "resume":
					case "disable":
					case "pause": {
						const enable = sub === "enable" || sub === "resume";
						const scope = rest.trim();
						if (scope === "--all" || scope === "--all-projects") {
							const everywhere = scope === "--all-projects";
							const targets = store.load().filter((r) => (everywhere || sameProject(r.cwd, session.cwd)) && r.enabled !== enable);
							for (const r of targets) await store.setEnabled(r.id, enable);
							refreshBadge();
							ctx.ui.notify(`${enable ? "enabled" : "disabled"} ${targets.length} rule(s)${everywhere ? " on this machine" : " in this project"}`, "info");
							return;
						}
						const rule = pickRule(rest);
						if (!rule) return;
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
						// `--all` means "all of this project's", scoped to the project, not the machine; wiping every
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
							ctx.ui.notify("rules have no name; /triggers set takes --model, --thinking and --timeout", "warning");
							return;
						}
						const rule = pickRule(change.ref);
						if (!rule) return;
						const updated = await store.update(rule.id, (r) => {
							if (change.model !== undefined) r.model = change.model ?? undefined;
							if (change.thinking !== undefined) r.thinking = change.thinking ?? undefined;
							if (change.timeoutMs !== undefined) r.timeoutMs = change.timeoutMs ?? undefined;
						});
						if (!updated) return;
						show(ctx, `updated trigger ${updated.id}`, [
							`  model: ${updated.model ?? "(the running session's current model)"}`,
							`  thinking: ${updated.thinking ?? "(the running session's current level)"}`,
							`  timeout: ${updated.timeoutMs ? `${Math.round(updated.timeoutMs / 1000)}s` : `default (${Math.round(triggers.runTimeoutMs / 1000)}s)`}`,
						]);
						return;
					}
					case "run": {
						// "Run now" on a rule. `handle` is the same path the periodic check takes,
						// so dedup, audit, the sub-agent and promotion all behave as they do on a poll —
						// what is skipped is only the poll ledger, which is the point of running it now.
						const rule = pickRule(rest);
						if (!rule) return;
						if (!schedulerStarted) {
							ctx.ui.notify("the trigger runtime is not running in this session", "warning");
							return;
						}
						if (!rule.enabled) {
							ctx.ui.notify(`trigger ${rule.id} is disabled — /triggers enable ${rule.id} first`, "warning");
							return;
						}
						// An id resolves against the machine-wide store, and this is the one rule command
						// that *runs* something: a sub-agent, in that rule's project, with that project's
						// tools. Enabling or renaming another project's rule from here is one thing;
						// starting work there from a session that never listed it is another.
						if (!sameProject(rule.cwd, session.cwd)) {
							ctx.ui.notify(`trigger ${rule.id} belongs to ${rule.cwd} — run it from a pi open in that project`, "warning");
							return;
						}
						const trigger = buildPeriodicCheckTrigger(rule.cwd, 1, new Date(), `${process.pid}-run-now`);
						// Never awaited: a check runs a sub-agent and can take minutes. `handle` is
						// documented not to reject, and the catch is there because pi installs no
						// unhandledRejection handler.
						void triggers.handle(trigger, "sub_agent", [rule]).catch((err: any) => log.warn(`run-now failed: ${err?.message ?? err}`));
						show(ctx, `checking trigger ${rule.id} now (trace ${trigger.traceId.slice(0, 8)})`, [
							`  condition: ${previewRedacted(rule.condition, 120)}`,
							"  the result appears here when the check finishes — /triggers running shows it meanwhile",
						]);
						return;
					}
					case "running": {
						const now = Date.now();
						const running = [
							...triggers.runningList().map((r) => ({ traceId: r.traceId, sourceLabel: r.sourceLabel, eventLabel: r.eventLabel, startedAt: r.startedAt, promptPreview: r.promptPreview, sessionFile: undefined as string | undefined })),
							...scheduler.runningRuns().map((r) => ({ traceId: r.runId, sourceLabel: "Cron", eventLabel: r.jobId, startedAt: r.startedAt, promptPreview: r.promptPreview, sessionFile: r.sessionFile })),
						];
						show(
							ctx,
							// The slot count is the whole machine's, not this list's: a run started by another
							// project's job holds one too, and "why is nothing starting" is answered by the
							// number, not by the rows.
							`${running.length ? `Running triggers (${running.length}):` : "(no running triggers)"}  ${triggers.slots.inUseCount} of ${triggers.slots.limit} sub-agent slot(s) in use`,
							running.flatMap((r) => {
								const secs = Math.max(0, Math.round((now - Date.parse(r.startedAt)) / 1000));
								const elapsed = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
								return [
									`  - ${r.traceId}  ${r.sourceLabel} / ${r.eventLabel}  running ${elapsed} (since ${formatLocal(Date.parse(r.startedAt))})`,
									`      prompt: ${previewRedacted(r.promptPreview, 120)}`,
									// The transcript is already on disk: "is it stuck or is it working" is
									// answerable now rather than only after the run ends.
									...(r.sessionFile ? [`      watch: pi --session ${r.sessionFile}`] : []),
								];
							}),
						);
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
								const details = r.details as any;
								if (details?.evaluator_decision?.outcome) lines.push(`      decision: ${details.evaluator_decision.outcome}${details.evaluator_decision.permission ? `, permission: ${details.evaluator_decision.permission}` : ""}`);
								if (details?.previous_trace_id) lines.push(`      previous_trace_id: ${String(details.previous_trace_id).slice(0, 8)}`);
								if (Array.isArray(details?.matched_rule_ids) && details.matched_rule_ids.length) lines.push(`      matched: ${details.matched_rule_ids.join(", ")}`);
								if (details?.session_file) lines.push(`      transcript: pi --session ${details.session_file}`);
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
						const on = rest.trim() === "on" ? true : rest.trim() === "off" ? false : !panelOn;
						setPanelEnabled(on);
						ctx.ui.notify(`panel ${on ? "on" : "off"}`, "info");
						return;
					}
					case "help":
						show(ctx, "/triggers", TRIGGERS_HELP);
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

	pi.registerCommand("pi-loops", {
		description: "About this extension, and `install-launcher` to put the `pi-loops` command on your PATH",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (sub === "install-launcher") {
				// The command line's own `install-launcher` cannot be reached until it has run once —
				// `pi install` does not put the package on your PATH. You are already inside pi with
				// this extension loaded, so here is where that circle can be broken.
				const lines: string[] = [];
				const words = tokenize(splitCommand(args).rest).map((t) => t.value);
				const code = await installLauncherWithConfirm(words, (title, body) => ctx.ui.confirm(title, body), (l) => lines.push(l));
				if (code === undefined) {
					ctx.ui.notify("not installed", "info");
					return;
				}
				show(ctx, code === 0 ? "installed the pi-loops launcher" : "could not install the launcher", lines.map((l) => `  ${l.trim()}`));
				return;
			}
			show(ctx, `pi-loops ${PI_LOOPS_VERSION}`, [
				`  loops directory: ${homeRel(dir)}`,
				`  package: ${homeRel(PACKAGE_DIR)}`,
				"",
				"  /pi-loops install-launcher [--dir <dir>]   put the `pi-loops` command on your PATH",
				"  /cron · /triggers · /inbox · /goal   the automation itself",
			]);
		},
	});

	/* ------------------------------------------------------------------ /recipe */

	// `add <ref>` rather than `add <name|path>`: the menu is read back by a test that splits on `|`.
	const RECIPE_USAGE = "[list|show <ref>|add <ref> [--level <l>]|update <name>|remove <name> [--purge]|help]";

	const RECIPE_HELP = [
		"/recipe                    the packaged recipes, and which of them are installed here",
		"/recipe show <name|path>   what one would install: playbooks, jobs, levels, setup script",
		"/recipe add <name|path>    install it in this project: copies the playbooks to .agents/skills/<name>/,",
		"                           runs the setup script after showing it, creates the jobs. --level report|propose|act skips the question",
		"/recipe update <name>      merge the packaged playbooks into the installed copies; your edits are kept",
		"/recipe remove <name>      remove its jobs; --purge also deletes the installed files and the loops' notes",
		"/recipe help               this text",
		"",
		"A recipe is a directory with a recipe.toml (docs/recipes.md). The copies live in .agents/skills/<name>/,",
		"kept out of the repository through .git/info/exclude, and a run reads them fresh every time.",
	];

	const LEVEL_TEXT: Record<AutonomyLevel, string> = {
		report: "read, and file findings; nothing written outside the inbox",
		propose: "also write to the tracker and open draft pull requests; never a terminal state",
		act: "also promote, close and merge — the terminal states",
	};


	/** The prompt that hands the tracker description to the session; the text lives beside the recipes. */
	function trackerSetupPrompt(recipe: Recipe, project: string): string {
		const text = fs.readFileSync(path.join(packagedRecipesDir(), "_tracker-setup.md"), "utf8");
		// Function replacements: a path with `$&` in it must land as typed.
		return text.replace(/\{recipe\}/g, () => recipe.manifest.name).replace(/\{project\}/g, () => project).replace(/\{templates\}/g, () => path.join(packagedRecipesDir(), "_tracker"));
	}

	/** Paths, not contents: the files are on disk and the model has tools; a prompt is not a place to keep a file. */
	function mergeConflictPrompt(name: string, dir: string, conflicts: UpdateResult["conflicts"]): string {
		const blocks = conflicts.map((c) => [`### ${c.file}`, `- installed copy (yours, unchanged by the update): ${path.join(dir, c.file)}`, `- untouched copy from install time (the merge base): ${c.basePath}`, `- newly packaged version: ${c.packagedPath}`, `- git's three-way merge with conflict markers: ${c.mergePath}`].join("\n")).join("\n\n");
		return [
			`\`/recipe update ${name}\` merged the newly packaged playbooks into the installed copies in ${dir}. The files below have edits on both sides that overlap, so the installed copies were NOT changed.`,
			"",
			"Work through them with me: read the merge file, say what changed on each side, propose the resolved text; when I agree, write the resolved file over the installed copy (no conflict markers may remain — a loop reads that file and follows it), copy the packaged version over the untouched copy (that is what the next update merges against), and delete the merge file.",
			"",
			blocks,
		].join("\n");
	}

	function runSetupScript(script: string, cwd: string): Promise<{ code: number; output: string }> {
		return new Promise((resolve) => {
			execFile("sh", [script], { cwd, timeout: 120_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
				const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : err ? 1 : 0;
				resolve({ code, output: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() });
			});
		});
	}

	/**
	 * `/recipe add`, as a function, because it runs twice when a tracker description has to be
	 * written first: once from the command, and once more on its own when the file the agent was
	 * asked for is there — a person should not have to type the command a second time.
	 */
	let pendingRecipeAdd: { words: string[]; project: string } | undefined;
	async function recipeAdd(ctx: ExtensionContext, words: string[], resumed = false): Promise<void> {
		const project = session.cwd;
		const { ref, level: levelFlag } = parseAddWords(words);
		if (!ref) {
			ctx.ui.notify(`usage: /recipe add <name|path> [--level ${AUTONOMY_LEVELS.join("|")}]`, "warning");
			return;
		}
		const resolved = resolveRecipeRef(ref, { cwd: project });
		const recipe = loadRecipe(resolved.dir);
		const m = recipe.manifest;
		// The one step a template cannot do: describe this project's tracker. Handed to the
		// session the way /inbox claim hands over a finding; the wizard resumes when the file exists.
		if (m.needsTracker && !fs.existsSync(path.join(project, TRACKER_FILE))) {
			if (resumed) {
				ctx.ui.notify(`${m.name} still has no ${TRACKER_FILE} to read; /recipe add ${ref} when it exists`, "warning");
				return;
			}
			pendingRecipeAdd = { words, project };
			pi.sendUserMessage(trackerSetupPrompt(recipe, project), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			ctx.ui.notify(`${m.name} reads ${TRACKER_FILE}, and this project has none yet — the agent will write it with you now, and the install continues here as soon as it exists`, "info");
			return;
		}
		let level: AutonomyLevel | undefined;
		if (levelFlag) {
			if (!m.levels.includes(levelFlag as AutonomyLevel)) throw new Error(`${m.name} supports ${m.levels.join(", ")}, not "${levelFlag}"`);
			level = levelFlag as AutonomyLevel;
		} else if (m.levels.length === 1) level = m.levels[0];
		else {
			const choice = await ctx.ui.select(`Autonomy level for ${m.name} (the lowest is the default)`, m.levels.map((l) => `${l} — ${LEVEL_TEXT[l]}`));
			level = choice?.split(" ")[0] as AutonomyLevel | undefined;
		}
		if (!level) {
			ctx.ui.notify("not installed", "info");
			return;
		}
		const existing = scheduler.store.load();
		const clash = m.jobs.map((j) => existing.find((e) => e.name === j.name)).filter((e): e is LoopJob => !!e);
		if (clash.length) {
			show(ctx, `not installed: ${clash.length} job name(s) already in use`, [
				...clash.map((e) => `  "${e.name}" — ${e.recipe ? `from recipe ${e.recipe}` : "created with /cron add"}, in ${homeRel(e.cwd)}`),
				"",
				`  ${clash.some((e) => e.recipe === m.name) ? `/recipe remove ${m.name}` : `/cron remove <name>`} first, then /recipe add ${ref} again`,
			]);
			return;
		}
		const plan = planInstall(recipe, project, level);
		let overwrite = false;
		if (plan.changed.length) {
			overwrite = await ctx.ui.confirm(`Overwrite ${plan.changed.length} edited file(s)?`, [...plan.changed.map((f) => `  ${f}`), "", "These differ from what would be written. Yes replaces them with the packaged version; No keeps your copies (the record is still written, and /recipe update merges later)."].join("\n"));
		}
		const setupText = m.setup ? fs.readFileSync(path.join(recipe.dir, m.setup), "utf8") : undefined;
		// The confirmation is the only gate before `sh <script>` runs with this session's
		// environment. So the script is shown whole and as written — redaction here would
		// hide exactly the `password=$(…)` a reader needs to see — or not run at all.
		if (setupText !== undefined && setupText.length > MAX_SETUP_SHOWN) {
			show(ctx, `not installed: ${m.setup} is ${setupText.length} characters, more than a confirmation can show`, [`  read ${path.join(recipe.dir, m.setup ?? "")} yourself, run it by hand in ${homeRel(project)}, then install a copy of the recipe without \`setup\` in its recipe.toml`]);
			return;
		}
		const fromPath = !isRecipeName(resolved.source);
		// A dialog clips what does not fit the terminal, so the script goes into the transcript
		// first — whole, scrollable, unredacted — and the dialog points at it.
		if (setupText !== undefined) show(ctx, `setup script ${m.setup} of recipe ${m.name} — runs once in ${homeRel(project)} with this session's environment, if you say yes below`, setupText.split("\n").map((l) => `  ${l}`));
		const body = [
			...(fromPath ? [`NOT shipped with pi-loops: ${homeRel(recipe.dir)}. Its playbooks will be followed by unattended runs, with this session's tools and credentials — read them before saying yes:`, ...plan.files.map((f) => `  ${path.join(recipe.dir, f)}`), ""] : []),
			`Files → ${homeRel(plan.targetDir)}/ (listed in .git/info/exclude, so nothing enters the repository):`,
			...plan.files.map((f) => `  ${f}${plan.changed.includes(f) ? (overwrite ? "  (overwritten)" : "  (kept as edited)") : ""}`),
			...(setupText !== undefined ? ["", `Setup script ${m.setup} (${setupText.split("\n").length} lines, printed above and at ${path.join(recipe.dir, m.setup ?? "")}) runs once with this session's environment.`] : []),
			"",
			"Jobs:",
			...plan.addLines.map((l) => `  /cron add ${l}`),
			...(m.budgetHintUsd ? ["", `Budget hint: about $${m.budgetHintUsd}/day — cap it with [limits] daily_budget_usd in config.toml`] : []),
		];
		const ok = await ctx.ui.confirm(`Install recipe ${m.name} at level "${level}"?`, body.join("\n"));
		if (!ok) {
			ctx.ui.notify("not installed", "info");
			return;
		}
		const lines: string[] = [];
		const record = installFiles(recipe, project, level, { overwrite, source: resolved.source });
		lines.push(`  ${record.files.length} file(s) → ${homeRel(plan.targetDir)}/`);
		const excluded = ensureExcluded(project, path.join(INSTALL_ROOT, m.name));
		// The tracker description names an account and a workflow; it is the project's to keep, not
		// the repository's to publish — so it stays out of history the same way the playbooks do.
		const trackerExcluded = m.needsTracker ? ensureExcluded(project, TRACKER_FILE, "file") : undefined;
		lines.push(excluded === "no-git" ? "  not a git repository: nothing to exclude" : `  .git/info/exclude: ${excluded === "added" ? "added" : "already listed"}${trackerExcluded ? `, ${TRACKER_FILE} ${trackerExcluded === "added" ? "added" : "already listed"}` : ""}`);
		if (m.setup) {
			const r = await runSetupScript(path.join(plan.targetDir, m.setup), project);
			const out = capRedacted(r.output, 2000).split("\n").map((l) => `    ${l}`);
			if (r.code !== 0) {
				show(ctx, `setup script ${m.setup} failed (exit ${r.code}); no jobs were created`, [...lines, `  ${m.setup}:`, ...out, "", `  the files are in place — fix what it needs and run /recipe add ${ref} again`]);
				return;
			}
			lines.push(`  ${m.setup}: ok`, ...out);
		}
		for (const line of plan.addLines) {
			const parsed = parseAddArgs(line);
			const job = await createJob({ schedule: parsed.schedule, prompt: parsed.prompt, stateful: parsed.stateful, name: parsed.name, model: parsed.model, thinking: parsed.thinking, tools: parsed.tools, timeoutMs: parsed.timeoutMs, catchUp: parsed.catchUp, verify: parsed.verify, checkerModel: parsed.checkerModel, recipe: m.name });
			cronControlAudit("add", "slash", undefined, job);
			const next = computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt) }, Date.now());
			lines.push(`  job ${job.name}: ${formatSchedule(job.schedule)}${next ? ` (next run ${formatLocal(next)})` : ""}`);
		}
		lines.push("", `  edit the playbooks in ${path.join(INSTALL_ROOT, m.name)}/ — a run reads them fresh every time; /cron run <job> tries one now`);
		show(ctx, `installed recipe ${m.name} (${level})`, lines);
		refreshBadge();
		return;
	
	}

	pi.registerCommand("recipe", {
		description: "Install a packaged way of running this project on loops — /recipe help",
		getArgumentCompletions: (prefix) => {
			const subs = ["list", "show", "add", "update", "remove", "help"];
			const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			lastCtx = ctx;
			const { sub, rest } = splitCommand(args);
			const words = tokenize(rest).map((t) => t.value);
			const project = session.cwd;
			try {
				switch (sub) {
					case "":
					case "list":
					case "ls": {
						const packaged = listRecipes();
						const installed = new Map(installedRecipes(project).map((r) => [r.recipe, r]));
						const jobs = scheduler.store.load().filter((j) => j.recipe && sameProject(j.cwd, project));
						const lines = packaged.map((r) => {
							const rec = installed.get(r.manifest.name);
							const n = jobs.filter((j) => j.recipe === r.manifest.name).length;
							return `  ${r.manifest.name.padEnd(17)} ${(rec ? `installed: ${rec.level}, ${n} job(s)` : "—").padEnd(28)} ${r.manifest.summary}`;
						});
						for (const rec of installed.values()) {
							if (packaged.some((r) => r.manifest.name === rec.recipe)) continue;
							lines.push(`  ${rec.recipe.padEnd(17)} installed from ${homeRel(rec.source)} (${rec.level})`);
						}
						show(ctx, `Recipes (${homeRel(project)})`, [...(lines.length ? lines : ["  none packaged, none installed"]), "", "  /recipe show <name> · /recipe add <name> · /recipe help"]);
						return;
					}
					case "show": {
						const ref = words[0];
						if (!ref) {
							ctx.ui.notify("usage: /recipe show <name|path>", "warning");
							return;
						}
						const recipe = loadRecipe(resolveRecipeRef(ref, { cwd: project }).dir);
						const m = recipe.manifest;
						const rel = path.join(INSTALL_ROOT, m.name);
						const record = readRecord(installDirFor(project, m.name));
						const lines = [
							`  ${m.summary}`,
							`  levels: ${m.levels.map((l) => `${l} (${LEVEL_TEXT[l]})`).join("; ")}`,
							`  tracker: ${m.needsTracker ? `needs ${TRACKER_FILE} — ${fs.existsSync(path.join(project, TRACKER_FILE)) ? "present" : "missing here; /recipe add writes it with you"}` : "not needed"}`,
							`  files → ${rel}/: ${playbookFiles(m).join(", ")}`,
							...(m.setup ? [`  setup script: ${m.setup} (shown before it runs, once per project)`] : []),
							...(m.budgetHintUsd ? [`  budget hint: about $${m.budgetHintUsd}/day at the default schedules — [limits] daily_budget_usd in config.toml`] : []),
							"  jobs:",
							...m.jobs.map((j) => `    /cron add ${addLineFor(j, rel)}`),
							...(record ? [`  installed here: ${record.level}, ${record.installedAt}, pi-loops ${record.version}`] : []),
						];
						show(ctx, `recipe ${m.name} (${homeRel(recipe.dir)})`, lines);
						return;
					}
					case "add": {
						pendingRecipeAdd = undefined;
						await recipeAdd(ctx, words);
						return;
					}
					case "update": {
						const name = words[0];
						if (!name) {
							ctx.ui.notify("usage: /recipe update <name>", "warning");
							return;
						}
						requireRecipeName(name);
						const dir = installDirFor(project, name);
						const record = readRecord(dir);
						if (!record) {
							ctx.ui.notify(`no recipe "${name}" is installed in ${homeRel(project)} (/recipe list)`, "warning");
							return;
						}
						const recipe = loadRecipe(path.isAbsolute(record.source) ? record.source : resolveRecipeRef(record.source, { cwd: project }).dir);
						const result = updateFiles(recipe, project, record.level);
						const lines = [
							...(result.updated.length ? [`  updated: ${result.updated.join(", ")}`] : []),
							...(result.unchanged.length ? [`  unchanged: ${result.unchanged.join(", ")}`] : []),
							...(result.noBase.length ? [`  left alone (no .orig to merge against): ${result.noBase.join(", ")}`] : []),
							...(result.conflicts.length ? [`  conflicts, not written: ${result.conflicts.map((c) => c.file).join(", ")} — handed to the agent to resolve with you`] : []),
						];
						show(ctx, `recipe ${name}: merged pi-loops ${PI_LOOPS_VERSION} playbooks into ${homeRel(dir)}/`, lines);
						if (result.conflicts.length) pi.sendUserMessage(mergeConflictPrompt(name, dir, result.conflicts), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
						return;
					}
					case "remove":
					case "rm": {
						pendingRecipeAdd = undefined;
						const purge = words.includes("--purge");
						const name = words.find((w) => !w.startsWith("--"));
						if (!name) {
							ctx.ui.notify("usage: /recipe remove <name> [--purge]", "warning");
							return;
						}
						requireRecipeName(name);
						const dir = installDirFor(project, name);
						const jobs = scheduler.store.load().filter((j) => j.recipe === name && sameProject(j.cwd, project));
						const record = readRecord(dir);
						if (!jobs.length && !record) {
							ctx.ui.notify(`no recipe "${name}" is installed in ${homeRel(project)} (/recipe list)`, "warning");
							return;
						}
						const ok = await ctx.ui.confirm(`Remove recipe ${name}?`, [
							jobs.length ? `${jobs.length} job(s): ${jobs.map((j) => j.name ?? j.id).join(", ")}` : "no jobs of its own here",
							purge ? `and delete what the install wrote in ${homeRel(dir)}/ (${record ? `${record.files.length} file(s), their untouched copies, the record` : "no record: only the directory if it is empty"}) and the loops' notes` : `the files in ${homeRel(dir)}/ and the loops' notes are kept (--purge deletes both)`,
						].join("\n"));
						if (!ok) {
							ctx.ui.notify("not removed", "info");
							return;
						}
						for (const job of jobs) {
							await scheduler.store.remove(job.id, { purge });
							cronControlAudit("remove", "slash", job, undefined);
						}
						if (purge) {
							if (record) purgeInstall(dir, record, listRecipes().find((r) => r.manifest.name === name)?.manifest.setup);
							else {
								try {
									fs.rmdirSync(dir);
								} catch {
									// not empty or not there: nothing of ours to take
								}
							}
						}
						refreshBadge();
						ctx.ui.notify(`removed recipe ${name}: ${jobs.length} job(s)${purge ? ", its files and notes" : `; files kept in ${homeRel(dir)}/`}`, "info");
						return;
					}
					case "help":
						show(ctx, "/recipe", RECIPE_HELP.map((l) => `  ${l}`));
						return;
					default:
						ctx.ui.notify(`unknown /recipe command: ${sub}. usage: /recipe ${RECIPE_USAGE}`, "warning");
				}
			} catch (e) {
				ctx.ui.notify(`/recipe ${sub}: ${(e as Error).message}`, "error");
			}
		},
	});

	// Not `share`: pi has a built-in `/share` of its own, and an extension command with a built-in's
	// name is dropped from autocomplete and shadowed at the prompt. The name follows the two
	// commands next to it (`/session-export`, `/session-import`), which are about the same object.
	pi.registerCommand("session-share", {
		description: "Upload this session's transcript as a private GitHub gist via `gh`, redacted and shown to you first",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = args.split(/\s+/).filter(Boolean);
			const isPublic = parts.includes("--public");
			const unknown = parts.filter((p) => p !== "--public");
			if (unknown.length) {
				ctx.ui.notify("usage: /session-share [--public]", "warning");
				return;
			}
			let messages: ShareMessage[];
			try {
				messages = (ctx.sessionManager.buildContextEntries() as Array<{ message?: ShareMessage }>).map((e) => e.message).filter((m): m is ShareMessage => !!m);
			} catch (err: any) {
				ctx.ui.notify(`share: cannot read this session: ${err?.message ?? err}`, "error");
				return;
			}
			if (!messages.length) {
				ctx.ui.notify("nothing to share yet — this session has no messages", "warning");
				return;
			}
			const rendered = renderShare(messages, { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, sessionId: ctx.sessionManager.getSessionId?.() ?? undefined });

			// The file lands locally first, so "what did I just publish" is answerable afterwards and
			// answerable *before*: the confirmation names a file that is already there to read.
			// Resolved, because `PI_LOOPS_DIR` is whatever the environment says and `gh` would read a
			// path that begins with `-` as a flag rather than as the file to upload.
			const outDir = path.resolve(dir, "shares");
			const outFile = path.join(outDir, `session-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
			try {
				fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
				// The loops directory is not necessarily 0700 (only the host tightens it), so `shares`
				// may already exist as someone else's directory or as a symlink into one — and mkdir's
				// mode does not apply to a directory that is already there.
				fs.chmodSync(outDir, 0o700);
				const st = fs.lstatSync(outDir);
				if (!st.isDirectory() || st.uid !== (process.getuid?.() ?? st.uid)) throw new Error("shares/ is not a directory this user owns");
				// "wx": create, never follow or truncate something that is already at that path.
				fs.writeFileSync(outFile, rendered.markdown, { mode: 0o600, flag: "wx" });
			} catch (err: any) {
				ctx.ui.notify(`share: could not write ${outFile}: ${err?.message ?? err}`, "error");
				return;
			}
			show(ctx, `Ready to upload ${path.basename(outFile)}`, [...shareSummary(rendered, { public: isPublic }), `  local copy: ${outFile}`]);

			const ok = await ctx.ui.confirm(isPublic ? "Upload this transcript PUBLICLY?" : "Upload this transcript to a gist?", [...shareSummary(rendered, { public: isPublic }), "", `Read it first: ${outFile}`, "", "gh gist create runs as you, with your GitHub account."].join("\n"));
			if (!ok) {
				ctx.ui.notify(`not uploaded — the rendered transcript is at ${outFile}`, "info");
				return;
			}

			// Shelling out to `gh` is what keeps this honest: the credential is already there and
			// pi-loops never has to hold one.
			// `--` so the filename is a filename even if a future path could look like a flag.
			const gh = await pi.exec("gh", ["gist", "create", ...(isPublic ? ["--public"] : []), "--desc", `pi session ${ctx.sessionManager.getSessionId?.() ?? ""}`.trim(), "--", outFile]).catch((err: any) => ({ code: -1, stdout: "", stderr: err?.message ?? String(err) }) as any);
			const stdout = String(gh.stdout ?? "").trim();
			const stderr = previewRedacted(String(gh.stderr ?? "").trim(), 300);
			if (gh.code !== 0) {
				const missing = /ENOENT|not found/i.test(stderr);
				ctx.ui.notify(missing ? "share needs the GitHub CLI: install `gh` and run `gh auth login`" : `gh gist create failed (${gh.code}): ${stderr}`, "error");
				return;
			}
			const url = stdout.split(/\s+/).find((t) => t.startsWith("https://")) ?? stdout;
			show(ctx, `shared: ${url}`, [isPublic ? "  public gist" : "  secret gist — unlisted, but anyone with the link can read it", `  local copy: ${outFile}`, "  delete it with: gh gist delete <id>"]);
		},
	});

	pi.registerCommand("session-export", {
		description: `Export this session + its cron jobs, trigger rules and loop state to a ${ARCHIVE_EXT} archive`,
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
			ctx.ui.notify(ARCHIVE_WARNING, "warning"); // Printed before the attempt, success or not
			try {
				// The store is machine-global, so the session that
				// created a job or rule is what scopes the archive; jobs from before `createdBy`
				// existed fall back to the project.
				const mine = (owner: { sessionId?: string } | undefined, cwd: string) => (owner?.sessionId ? owner.sessionId === sessionId : sameProject(cwd, session.cwd));
				const jobs = scheduler.store.load().filter((j) => sameProject(j.cwd, session.cwd) && mine(j.createdBy, j.cwd));
				const rules = triggers.store.load().filter((r) => sameProject(r.cwd, session.cwd) && mine(r.createdBy, r.cwd));
				const states: Record<string, string> = {};
				for (const job of jobs) {
					const loopState = job.stateful ? scheduler.store.readState(job.id) : undefined;
					if (loopState) states[job.id] = loopState;
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
		description: `Import a ${ARCHIVE_EXT} archive: new session file here, cron jobs / trigger rules / loop state restored`,
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = args.split(/\s+/).filter(Boolean);
			let activate = false;
			let resume = false;
			let targetCwd = session.cwd;
			const positional: string[] = [];
			for (let i = 0; i < parts.length; i++) {
				const arg = parts[i];
				if (arg === "--resume") resume = true;
				else if (arg.startsWith("--activate-triggers=")) {
					const value = arg.slice("--activate-triggers=".length);
					if (value === "on") activate = true;
					else if (value === "off") activate = false;
					else {
						ctx.ui.notify(`--activate-triggers=${value} is not supported (use on|off)`, "warning");
						return;
					}
				} else if (arg === "--cwd") targetCwd = path.resolve(session.cwd, parts[++i] ?? ".");
				else positional.push(arg);
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
				show(ctx, `imported session: ${imp.sessionId.slice(0, 16)}`, [
					`path: ${homeRel(imp.sessionPath)}`,
					`entries=${imp.entryCount} triggers=${imp.rules.length} cron=${imp.jobs.length} loop_state=${Object.keys(imp.states).length} automation=${imp.automationEnabled ? "enabled" : "disabled"}${skipped ? ` skipped=${skipped} (already imported)` : ""}`,
					...(imp.notes ?? []).map((n: string) => `note: ${n}`),
					`resume with: pi --session ${imp.sessionPath}`,
				]);
				// Offer to switch originally-enabled automation back on.
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
	 * The same project, whichever path this pi was opened through: a worktree, a symlink or a
	 * subdirectory of the project root all belong to the rule or job that names the root.
	 */
	const sameProject = (a: string, b: string): boolean => withinProject(b, a) || withinProject(a, b);

	/**
	 * Where a diagnostic goes: the log file always, and the chat as a warning — pi's `showStatus`
	 * replaces the previous status line in place, so several info-level notices in one tick collapse
	 * to the last one. These are the lines that say a job was disabled or a write failed.
	 */
	function diagnostic(message: string, level?: "info" | "warning"): void {
		// A caller that does not say otherwise is reporting something wrong: a disabled job, a failed
		// write, a paused budget — the lines pi's in-place status replacement used to swallow. The
		// routine ones (the scheduler taking the timer over) say `"info"` themselves, which they used
		// to be told by a regex over their own wording here.
		const at = level ?? "warning";
		log.write(at === "warning" ? "warn" : "info", message);
		if (lastCtx?.hasUI) lastCtx.ui.notify(`[cron] ${message}`, at);
		else if (at === "warning") process.stderr.write(`[pi-loops] ${message}\n`);
	}

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
	/**
	 * Trigger creation/removal and trigger/cron enable need a person's yes: pi has no permission
	 * popups, so the tool asks through `ctx.ui.confirm` itself. A sub-agent has no UI, so
	 * `controlPlanePreflight` denies fail-closed (`ToolCallEventResult`).
	 */
	async function confirmTool(ctx: ExtensionContext, req: ControlPlaneRequest, atHop: number): Promise<string | undefined> {
		const denied = controlPlanePreflight({ hop: atHop, hasUI: ctx.hasUI }, req.label);
		if (denied) return denied;
		// The approval card: Action / Tool / Reason / Args hash / Preview, then a feed line per decision.
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
		if (startHandled) return; // the same start, delivered a second time by a second rebind
		startHandled = true;
		session = sessionSnapshot(ctx);
		config = loadConfig(dir);
		// The goal lives in the session, so `--resume` picks up where it left off.
		goal = latestGoal(ctx.sessionManager.getEntries() as any);
		if (goal && ctx.hasUI) ctx.ui.setStatus(GOAL_STATUS_KEY, `goal: ${goal.status}`);
		const flagRaw = pi.getFlag("trigger-poll-secs");
		const flagSecs = Number(flagRaw);
		if (flagRaw !== undefined && flagRaw !== "" && !(Number.isFinite(flagSecs) && flagSecs >= 1)) config.errors.push(`triggers: ignoring invalid --trigger-poll-secs ${JSON.stringify(flagRaw)}: must be a whole number of seconds ≥ 1`);
		triggers.pollIntervalSecs = Number.isFinite(flagSecs) && flagSecs >= 1 ? Math.floor(flagSecs) : config.triggerPollIntervalSecs;
		triggers.runTimeoutMs = config.triggerRunTimeoutMs;
		// Without a UI, hook failures go to stderr instead of vanishing.
		const warnHook = (message: string) => (ctx.hasUI ? ctx.ui.notify(`[hooks] ${message}`, "warning") : process.stderr.write(`[pi-loops hooks] ${message}\n`));
		hookRunner = new HookRunner({ loopsDir: dir, projectCwd: ctx.cwd, allowProjectHooks: config.allowProjectHooks, getSession: () => session, warn: warnHook, log: (msg) => log.info(msg) });
		hookRunner.load();
		for (const e of [...config.errors, ...hookRunner.diagnostics]) if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${e}`, "warning");
		loadMcpConfig(ctx.isProjectTrusted());
		for (const d of mcpDiagnostics) if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${d}`, "warning");
		await startMcpSources(); // tools for every process; pushes are consumed by interactive processes only
		// tui and rpc processes stay alive and host the timer; `PI_LOOPS_HOST=1` lets a `pi -p`
		// run (a long headless prompt) host it too.
		const hostMode = ctx.mode === "tui" || ctx.mode === "rpc" || envFlag("LOOPS_HOST");
		if (!hostMode) return;
		// Take the clock back from the headless host, if one kept it while nothing was open; a record
		// with no process behind it means the host died (it removes its record on a clean exit).
		const dead = crashedHost(dir);
		if (dead && ctx.hasUI) ctx.ui.notify(`[cron] the background host (pid ${dead.pid}, started ${formatLocal(Date.parse(dead.startedAt))}) died; see ${homeRel(path.join(dir, HOST_LOG))}`, "warning");
		const hostPid = stopHost(dir);
		if (hostPid && ctx.hasUI) ctx.ui.notify(`[cron] took the clock back from the background host (pid ${hostPid})`, "info");
		scheduler.start();
		schedulerStarted = true;
		refreshBadge();
		pruneLogs(dir);
		// What was loaded is printed on every start; without a line here a session
		// can begin with loops and rules the user has entirely forgotten about.
		const myJobs = scheduler.store.load().filter((j) => sameProject(j.cwd, session.cwd) && j.enabled);
		const myRules = triggers.store.load().filter((r) => sameProject(r.cwd, session.cwd) && r.enabled);
		// What is scheduled says nothing about what is working: a loop that has failed every night
		// since Tuesday is still counted as active, and this line is the only one a user reads.
		const failing = failingSummary(myJobs);
		log.info(`session start: ${myJobs.length} enabled loop(s), ${myRules.length} enabled rule(s)${failing ? `, ${failing}` : ""} in ${session.cwd}`);
		if (ctx.hasUI && (myJobs.length || myRules.length)) {
			const next = myJobs
				.map((j) => computeNext({ schedule: j.schedule, createdAt: Date.parse(j.createdAt), lastFiredAt: j.lastFiredAt ? Date.parse(j.lastFiredAt) : undefined }, Date.now()))
				.filter((n): n is number => n !== undefined)
				.sort((a, b) => a - b)[0];
			ctx.ui.notify(`[cron] ${myJobs.length} loop(s) and ${myRules.length} rule(s) active here${next ? ` · next ${formatLocal(next)}` : ""}${failing ? ` · ${failing} — /cron runs` : ""}`, "info");
		}
	});

	// hooks.toml events, mapped from pi's lifecycle events.
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
	// A compaction that failed or was cancelled is the same news to a watcher, and the more urgent
	// half of it: a session that cannot compact is a session about to fail on context length. It
	// carries no summary and no token count — nothing was written — only the flag saying so.
	pi.on("session_compact_failed", async (e, ctx) => fireHook({ event: "compaction", compaction_trigger: e.reason === "manual" ? "manual" : "auto", compaction_failed: true }, ctx));

	pi.on("model_select", async (_event, ctx) => {
		session = sessionSnapshot(ctx);
	});
	pi.on("thinking_level_select", async (_event, ctx) => {
		session = sessionSnapshot(ctx);
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
	// The goal is evaluated at the end of a turn; pi's hook for that is `agent_settled` — the point where
	// no automatic retry, compaction or queued continuation will run, so a decision here is final.
	pi.on("agent_settled", async (_event, ctx) => {
		// The tracker description `/recipe add` was waiting for: written during this turn, so the
		// wizard picks up where it stopped — in the same project, with the same words.
		if (pendingRecipeAdd && sameProject(pendingRecipeAdd.project, session.cwd) && fs.existsSync(path.join(pendingRecipeAdd.project, TRACKER_FILE))) {
			const { words } = pendingRecipeAdd;
			pendingRecipeAdd = undefined;
			try {
				await recipeAdd(ctx, words, true);
			} catch (e) {
				ctx.ui.notify(`/recipe add: ${(e as Error).message}`, "error");
			}
		}
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
		const enabledRules = triggers.store.load().filter((r) => r.enabled).length;
		return shouldHandOff({
			auto: handsOffOnQuit(),
			presence: scheduler.presenceList(),
			selfPid: process.pid,
			selfInstance: scheduler.self.instance,
			hostName: here,
			enabledLoops: scheduler.store.load().filter((j) => j.enabled && j.stateful).length,
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
		startHandled = false;
		const wasStarted = schedulerStarted;
		if (schedulerStarted) {
			schedulerStarted = false;
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
				// Only claim the hand-off once the host has recorded itself: one that dies during
				// module resolution would otherwise be announced as a success, with automation off.
				const up = await waitForHost(dir, pid);
				const note = up
					? `[cron] handed the clock to a background host (pid ${pid}; ${handOff.reason}); /cron host stop ends it`
					: `[cron] the background host (pid ${pid}) did not start; automation is not running — see ${homeRel(path.join(dir, HOST_LOG))}`;
				log.write(up ? "info" : "error", note.replace("[cron] ", ""));
				if (ctx.hasUI) ctx.ui.notify(note, up ? "info" : "warning");
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
