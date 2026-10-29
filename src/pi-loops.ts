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
import { ProjectTrustStore, SessionManager, VERSION as PI_VERSION, getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ARCHIVE_EXT, type ActivateMode, applyImport, automationOf, defaultExportPath, exportSession, importSession, offerToEnable, parseActivateMode } from "./archive.ts";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseAddArgs, parseSetArgs, splitCommand, tokenize } from "./args.ts";
import { envFlag, loadConfig } from "./config.ts";
import { GOAL_ENTRY, type GoalAction, type GoalState, MAX_CONTINUATIONS, abortedTurn, applyDecision, branchMovedSince, continuationPrompt, evaluatorPrompt, latestGoal, newGoal, parseDecision, pauseFor, transcriptFromMessages } from "./goal.ts";
import { sameProject } from "./paths.ts";
import { olderPiOnSession } from "./presence.ts";
import { isExactlyTrusted, sessionTrustCovers } from "./trust.ts";
import { HookRunner, type HookEventData, messageKind, messageSummary, resultSummary, runEndEvent, runStartEvent, truncateSummary } from "./hooks.ts";
import { failingSummary } from "./job-health.ts";
import { loopSignal, signalSummary } from "./job-signal.ts";
import { LoopsLog, pruneLogs } from "./log.ts";
import { type InboxEntry, belongsToProject, inProject, resolveInboxRef } from "./inbox.ts";
import { McpPool } from "./mcp-pool.ts";
import { McpSource, PI_BUILTIN_TOOL_NAMES, type McpServerConfig, type McpToolDef, droppedNotificationMessage, loadMcpConfigFiles, mapNotification, mcpToolDefinitions, mcpTokenFromEnv } from "./mcp.ts";
import { capRedacted, previewRedacted, redact } from "./redact.ts";
import { shouldEmitSnapshot, snapshotFingerprint } from "./snapshot.ts";
import { type ShareMessage, renderShare, shareSummary } from "./share.ts";
import { hostUnitHere, installHostUnit, installLauncherWithConfirm, installedByPi, installedHostUnit, launcherSource, launcherState, launcherTarget, refreshLauncher, reloadHostUnit, startHostUnit } from "./cli.ts";
import { refreshUnit, unitState } from "./host-unit.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { computeDue, computeNext, formatLocal, formatSchedule, localOffset, parseSchedule, stamp } from "./schedule.ts";
import { applyJobEdit } from "./job-edit.ts";
import { jobLines as cronJobLines } from "./job-lines.ts";
import { runsHere } from "./job-owner.ts";
import { type AcquireOutcome, LeaseBinding, LeaseStore, closedConversation, procStart } from "./lease.ts";
import { Mailbox, type Delivery, conversationHas, routePromotion } from "./mailbox.ts";
import { AUTONOMY_LEVELS, type AutonomyLevel, INSTALL_ROOT, RECIPE_TIERS, type Recipe, type UpdateResult, addLineFor, ensureExcluded, installDirFor, installFiles, installedRecipes, isRecipeName, listRecipes, MAX_SETUP_SHOWN, TRACKER_FILE, loadRecipe, neverSection, packagedRecipesDir, parseAddWords, planInstall, playbookFiles, preflightChecks, purgeInstall, readRecord, renderPreflight, requireRecipeName, resolveRecipeRef, runPreflight, updateFiles } from "./recipe.ts";
import { LoopScheduler, type SessionSnapshot } from "./scheduler.ts";
import { MAX_PROMPT_BYTES, type LoopJob, type RunRecord, defaultLoopsDir, newId, resolveJobRef, sessionExists } from "./store.ts";
import { parentRuntimeFlags, type SubagentRequest } from "./runner.ts";
import { createInProcessRunner } from "./sdk-runner.ts";
import { SubagentSlots } from "./slots.ts";
import { askHost, renderHostSnapshot } from "./host-control-channel.ts";
import { HOST_LOG, decideEviction, ensureHost, evictHost, heartbeatFresh, hostPushWork, hostServiceAlive, piPackageDir, readHostService, readSpawnLog, type HostServiceRecord } from "./host-control.ts";
import { summarizeSessionFile } from "./transcript.ts";
import { TriggerRuntime, type TriggerOutcome } from "./trigger-runtime.ts";
import { auditArgs, auditCronFinish, auditCronStart, TriggerStore, buildPeriodicCheckTrigger, controlPlanePreflight, resolveRuleRef } from "./triggers.ts";
import { type ControlPlaneRequest, type CreateJobInput, type JobScope, type ToolHost, automationTools, checkJobName, createLoopJob, resolveJobRefScoped } from "./tools.ts";
import { clearUiPref, panelEnabled, readUiPrefs, writeUiPref } from "./ui-prefs.ts";
import { markSeen, readSeen, sinceYouLooked, sinceYouLookedLine } from "./seen.ts";
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
	const dir = defaultLoopsDir(getAgentDir());
	/** Everything this process diagnoses, kept after the window is gone. */
	const log = new LoopsLog(dir, `pi-${process.pid}.log`);
	/** This package's directory: a sub-session must not load a second copy of this extension. */
	const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

	let session: SessionSnapshot = { cwd: process.cwd() };
	let lastCtx: ExtensionContext | undefined;
	/**
	 * This instance's claim on its conversation (src/lease.ts). Its plain jobs fire and its mailbox
	 * drains only while it holds the lease; a second window on the same conversation is a viewer.
	 * The scheduler's presence entry carries the same instance id.
	 */
	const instance = newId("pi");
	const ownStart = procStart(process.pid);
	let leaseMode: "tui" | "rpc" | "print" | "json" | "unbound" = "unbound";
	const binding = new LeaseBinding(new LeaseStore(dir), instance, () => ({ kind: "terminal", pid: process.pid, procStart: ownStart, mode: leaseMode, pushServers: [] }));
	/** What happened for this conversation since `/inbox` was last listed in it (src/seen.ts). */
	function sinceYouLookedHere(sessionId: string) {
		return sinceYouLooked(scheduler.store.allRuns(), scheduler.inbox.list(), sessionId, readSeen(dir).seen[sessionId], { cwd: session.cwd, inProject: sameProject, appended: triggers.store.listAudit(500, (r) => r.state === "appended") });
	}
	/** Listing `/inbox` clears the count, unless some of what it counted is in projects this listing left out. */
	function markSeenIfShown(everywhere: boolean): void {
		if (!session.sessionId) return;
		if (!everywhere && sinceYouLookedHere(session.sessionId).elsewhere) return;
		markSeen(dir, session.sessionId, stamp());
	}
	/** Closed, and the host may take it (src/lease.ts closedConversation); a 0.22 window counts as open. */
	function closedHere(sessionId: string | undefined): boolean {
		return closedConversation(binding.store, sessionId, (id) => scheduler.presenceList().some((e) => e.sessionId === id && !e.leases && e.kind !== "host"));
	}
	const mailbox = new Mailbox(dir);
	let mailboxWatch: fs.FSWatcher | undefined;
	/** The holder pid this window last told the person about, so the viewer line is said once per change. */
	let viewerNoticeFor: number | undefined;
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
	/** Whether those two are connected: they run in the always-on host, so they are live while it is. */
	const localSourcesConnected = (): boolean => !!liveHostRecord();
	/** The host this loops directory has, when its process is really there. */
	const liveHostRecord = (): HostServiceRecord | undefined => {
		const rec = readHostService(dir);
		return rec && hostServiceAlive(rec) ? rec : undefined;
	};

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
		instance,
		leases: {
			heldEpoch: (id) => binding.heldEpoch(id),
			holderOf: (id) => binding.holderOf(id),
			holderKind: (id) => binding.holderKindOf(id),
			hostRuns: (id) => !!liveHostRecord() && closedHere(id),
		},
		// A window fires only the plain jobs of the conversation it holds; every loop runs in the host.
		owns: (job, view) => !job.stateful && runsHere(job, view),
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
				fireRunHook(runStartEvent(job, runId));
			},
			onCatchUp: (job, dueAt) => {
				if (lastCtx?.hasUI && sameProject(job.cwd, session.cwd)) lastCtx.ui.notify(`cron ${job.name ?? job.id}: catching up the run missed at ${formatLocal(dueAt)}`, "info");
			},
			onJobRetired: (job) => cronControlAudit("remove", "scheduler", job, undefined),
			onRunFinished: ({ job, record, findings, result }) => {
				auditCronFinish(triggers.store, job, record, result.stopReason === "aborted");
				refreshBadge();
				fireRunHook(runEndEvent(job, record));
				if (!lastCtx?.hasUI) return;
				// Another project's findings and prompt previews do not belong in this transcript; the
				// audit sink below and the inbox already carry them to where they do.
				if (sameProject(job.cwd, session.cwd)) showRunCard(lastCtx, job, record, findings);
			},
			onInboxChanged: () => refreshBadge(),
			// Dynamic triggers piggyback on the same 30s tick (leader only). MCP pushes are consumed
			// by every interactive process and deduplicated machine-wide (see startMcpSources).
			onTick: () => {
				leaseTick();
				showFinishedRuns();
				// A change inside the snapshot's minimum gap is held back, not lost: the next tick writes it.
				emitSnapshot();
				if (binding.here().holds) hostTick(true).catch((err: any) => log.info(`host: ${err?.message ?? err}`));
			},
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
		hooks: {
			onPromote: async (content, trigger, forSession) => {
				// A rule's result belongs in the conversation that created it: here, in the window that
				// holds that conversation (through its mailbox), or the inbox marked for it when it is closed.
				const route = routePromotion(forSession, binding.here(), { holderOf: (id) => binding.holderOf(id), closed: closedHere });
				if (route.to === "mailbox") {
					mailbox.enqueue(route.sessionId, { id: trigger.traceId, text: content, cwd: trigger.cwd ?? session.cwd, createdAt: stamp(Date.now()) });
					return "mailbox";
				}
				if (route.to === "inbox") {
					await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: content.replace(/^\[Trigger [^\]]+\]\s*/, ""), run_id: trigger.traceId, job_id: trigger.sourceLabel, cwd: trigger.cwd ?? session.cwd, session_id: route.sessionId });
					refreshBadge();
					return "inbox";
				}
				// Promotion = the result becomes visible to future turns (inserting a `[Trigger …]` user
				// message into the parent session). Only into a chat that belongs to the rule's project;
				// a different project's chat gets nothing — the finding goes to the inbox instead.
				if (!forSession && trigger.cwd && !sameProject(trigger.cwd, session.cwd)) {
					await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: content.replace(/^\[Trigger [^\]]+\]\s*/, ""), run_id: trigger.traceId, job_id: trigger.sourceLabel, cwd: trigger.cwd });
					refreshBadge();
					return "inbox";
				}
				promoteIntoChat(content);
				return "chat";
			},
			onInjectAndRun: async (prompt, trigger) => {
				if (trigger.cwd && !sameProject(trigger.cwd, session.cwd)) {
					await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: prompt.replace(/^\[Trigger [^\]]+\]\s*/, ""), run_id: trigger.traceId, job_id: trigger.sourceLabel, cwd: trigger.cwd });
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
					// Rules are evaluated by the host alone, on its own connection to the server.
					if (delivery === "sub_agent") return;
					// The window holding this conversation injects it; a second window on it would put it there twice.
					if (binding.viewerOf !== undefined) return;
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

	/** Idle → inserted without a model call; streaming → follow-up queue, which runs a turn once the current one ends so the agent sees it without waiting for the next prompt. */
	function promoteIntoChat(content: string): void {
		if (lastCtx?.isIdle() ?? true) pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: false });
		else pi.sendMessage({ customType: "pi-loops:trigger", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

	function deliverFromMailbox(d: Delivery): void {
		promoteIntoChat(d.text);
	}

	/** What another process decided for this conversation. Only the holder drains, and an id already in the conversation is not delivered again. */
	/** Deliveries this process has handed pi and pi has not written yet (see Mailbox.drain). */
	const handedOver = new Set<string>();
	function drainMailbox(): void {
		const sessionId = binding.here().sessionId;
		const ctx = lastCtx;
		if (!sessionId || !ctx) return;
		// A one-shot `pi -p` / json run holds its conversation but is not where a result should land:
		// it would be swallowed into a turn that is about to exit. The host delivers it after.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		mailbox.drain(sessionId, { holds: () => binding.here().holds, alreadyDelivered: (id) => conversationHas(ctx.sessionManager.getEntries(), id), deliver: deliverFromMailbox, handedOver });
	}

	function noteBinding(outcome: AcquireOutcome): void {
		if (outcome.outcome === "acquired" && outcome.tookFromPid) log.info(`took session ${outcome.lease.sessionId.slice(0, 8)} from dead pid ${outcome.tookFromPid}`);
		if (outcome.outcome === "acquired") noteUnseenEntries(outcome.lease.sessionFile, !!outcome.tookFromHost?.runId);
		const holder = outcome.outcome === "viewer" ? outcome.holderPid : undefined;
		if (holder === viewerNoticeFor) return;
		viewerNoticeFor = holder;
		if (holder !== undefined && lastCtx?.hasUI) lastCtx.ui.notify(`[cron] this conversation is also open in pid ${holder}; its scheduled messages and rule results arrive there, not in this window`, "info");
	}

	/**
	 * pi read the conversation before this window held it, so anything the host wrote in between — a
	 * turn it was in the middle of, a rule result it appended, a turn that ended as this window was
	 * opening, or a host that crashed mid-turn — is on disk and not on this screen. Whenever the two
	 * differ, say so; the host's entries stay reachable, as a branch, from /tree.
	 */
	function noteUnseenEntries(file: string | undefined, interruptedHost: boolean): void {
		const ctx = lastCtx;
		if (!ctx?.hasUI || !file || !fs.existsSync(file)) return;
		try {
			// `getEntries().length`, not `getEntryCount()`: the latter is newer than the pi floor.
			if (SessionManager.open(file).getEntries().length <= ctx.sessionManager.getEntries().length) return;
		} catch (err: any) {
			log.info(`could not compare the session with what is on disk: ${err?.message ?? err}`);
			return;
		}
		ctx.ui.notify(interruptedHost ? "[cron] the host was answering a scheduled job in this conversation when you opened it; it stopped. /resume this session to see its last lines" : "[cron] the host wrote to this conversation while it was opening; /resume this session to see the latest entries", "info");
	}

	/**
	 * Take this conversation's lease, or become its viewer. Called from session_start and from the
	 * first callbacks that carry a context, for a runtime that never sends session_start.
	 */
	function bindSession(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId || binding.here().sessionId === sessionId) return;
		leaseMode = ctx.mode === "tui" || ctx.mode === "rpc" || ctx.mode === "print" || ctx.mode === "json" ? ctx.mode : "unbound";
		try {
			noteBinding(binding.bind(sessionId, { sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd }));
			watchMailbox();
		} catch (err: any) {
			log.info(`lease: ${err?.message ?? err}`);
		}
	}

	/** A promotion queued for this conversation lands without waiting for the tick; the tick drains as well, because fs.watch can miss events. */
	function watchMailbox(): void {
		if (mailboxWatch) return;
		const sessionId = binding.here().sessionId;
		if (!sessionId) return;
		const deliveries = path.join(dir, "deliveries");
		fs.mkdirSync(deliveries, { recursive: true });
		mailboxWatch = fs.watch(deliveries, (_event, name) => {
			if (name !== `${sessionId}.jsonl`) return;
			try {
				drainMailbox();
			} catch (err: any) {
				log.info(`mailbox: ${err?.message ?? err}`);
			}
		});
		mailboxWatch.on("error", (err) => log.info(`mailbox watch: ${err?.message ?? err}`));
	}

	/** Every scheduler tick: keep the lease (a viewer retries), list the injecting servers on it, and drain the mailbox. */
	function leaseTick(): void {
		try {
			const outcome = binding.refresh();
			if (outcome) noteBinding(outcome);
			binding.setPushServers(mcpSources.filter((src) => (src.config.injectSummary || src.config.injectAndRun) && src.status.state === "connected").map((src) => src.config.name));
			drainMailbox();
		} catch (err: any) {
			log.info(`lease: ${err?.message ?? err}`);
		}
	}

	/** Why the host is not running when it should be, as the badge and `/cron host` say it; undefined while it runs or has nothing to run. */
	/**
	 * Why the loops are not running in a host right now, when they are not: it could not start, it kept
	 * crashing and is paused, or it runs but its control socket does not answer. One value per state, so
	 * a warning is said once per state change and not once per wording of the same failure.
	 */
	let hostState: { kind: "start-failed" | "crash-paused" | "channel-broken"; detail: string } | undefined;
	const HOST_STATE_BADGE = { "start-failed": "loops paused: the host could not start", "crash-paused": "loops paused: the host keeps crashing", "channel-broken": "the host is not answering" } as const;
	/** The one-line reason, where a line has room for it. */
	const hostProblemText = (): string | undefined => (hostState ? `${HOST_STATE_BADGE[hostState.kind]} — ${hostState.detail}` : undefined);
	let hostChannelBroken: string | undefined;
	/** This window's count of failed probes of the host's socket (src/host-control.ts decideEviction). */
	let hostProbeFailures = 0;
	let hostTickRunning = false;
	/** The host pid the badge, panel and snapshot last showed: one that came, went or changed is redrawn. */
	let shownHostPid: number | undefined;

	/** What there is for the host to run, as `ensureHost` counts it. */
	function automationCounts(): { loops: number; rules: number; pushServers: number; closedSessionJobs: number; closedMailboxes: number } {
		const rules = triggers.store.load().filter((r) => r.enabled).length;
		const jobs = scheduler.store.load().filter((j) => j.enabled);
		return {
			loops: jobs.filter((j) => j.stateful).length,
			rules,
			pushServers: hostPushWork(loadMcpConfigFiles({ dir, projectTrusted: false }).servers, rules),
			closedSessionJobs: jobs.filter((j) => !j.stateful && closedHere(j.sessionId)).length,
			closedMailboxes: mailbox.sessions().filter((id) => closedHere(id)).length,
		};
	}

	/**
	 * Keep the host there: probe it (only a tick's probe counts toward evicting a wedged one, so a
	 * host that is still starting when a window opens is never killed for it), then start it, or ask
	 * an older one to make way, when there is automation to run. Returns what ensure decided.
	 */
	async function hostTick(fromTick: boolean, asked = false): Promise<Awaited<ReturnType<typeof ensureHost>> | undefined> {
		if (hostTickRunning) return undefined;
		hostTickRunning = true;
		try {
			const rec = liveHostRecord();
			if (rec) {
				const answer = await askHost(dir, { op: "status" });
				const verdict = decideEviction({ failures: hostProbeFailures, probeOk: !!answer?.ok, fromTick, pidMatches: hostServiceAlive(rec), heartbeatFresh: heartbeatFresh(rec, Date.now()) });
				hostProbeFailures = verdict.failures;
				if (answer?.ok) hostChannelBroken = undefined;
				if (verdict.channelBroken && !hostChannelBroken) {
					hostChannelBroken = `pid ${rec.pid} is running (its heartbeat is fresh) but its control socket does not answer; see ${homeRel(path.join(dir, HOST_LOG))}`;
					log.write("warn", `the host (pid ${rec.pid}) does not answer on its socket but is still ticking; leaving it running`);
				}
				if (verdict.evict) {
					log.write("warn", `the host (pid ${rec.pid}) stopped answering for three ticks; replacing it`);
					await evictHost(dir, rec.pid);
				}
			}
			// With a login unit installed the host is started through it, so systemd or launchd own the process.
			const unit = installedHostUnit(dir, piPackageDir());
			const out = await ensureHost({ dir, packageDir: PACKAGE_DIR, piPackage: piPackageDir(), startUnit: unit ? () => startHostUnit(unit) : undefined, automation: automationCounts(), auto: config.hostAuto, stopped: readUiPrefs(dir).host === "stopped", asked, myVersion: PI_LOOPS_VERSION, myPiVersion: PI_VERSION });
			const before = hostProblemText();
			// The spawn log's reason in both branches: the attempt's own error and the backoff's are the
			// same failure, and wording it twice warned twice.
			const startError = () => readSpawnLog(dir).lastError ?? out.error ?? `the host did not start; see ${homeRel(path.join(dir, HOST_LOG))}`;
			if (out.action.kind === "spawn") {
				hostState = out.up ? undefined : { kind: "start-failed", detail: startError() };
				if (out.up) log.info(`started the host (pid ${out.pid})`);
			} else if (out.action.kind === "upgrade") log.info("asked the host to make way for this pi-loops version");
			else if (out.action.reason === "running" || out.action.reason === "nothing to run" || out.action.reason.startsWith("a newer pi-loops")) hostState = undefined;
			else if (out.action.reason.startsWith("backing off")) hostState = { kind: "start-failed", detail: startError() };
			else if (out.action.reason.startsWith("paused:")) hostState = { kind: "crash-paused", detail: out.action.reason.slice("paused: ".length) };
			if (hostChannelBroken && liveHostRecord()) hostState = { kind: "channel-broken", detail: hostChannelBroken };
			const now = hostProblemText();
			if (now && now !== before && lastCtx?.hasUI) lastCtx.ui.notify(`[cron] ${now}`, "warning");
			// Whoever started or stopped it: another window, `pi-loops host stop`, a crash.
			const livePid = liveHostRecord()?.pid;
			if (now !== before || livePid !== shownHostPid) {
				shownHostPid = livePid;
				refreshBadge();
			}
			return out;
		} finally {
			hostTickRunning = false;
		}
	}

	/**
	 * Loops run in the host, so their cards come from the run log: on each tick, a card for every loop
	 * of this project that finished since the last look. UI only, as the card always was; nothing is
	 * written into the conversation.
	 */
	let runsShownAfter = stamp();
	function showFinishedRuns(): void {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return;
		const fresh = scheduler.store.listRuns(undefined, 20).filter((r) => r.stateful && r.finishedAt > runsShownAfter);
		if (!fresh.length) return;
		runsShownAfter = fresh.reduce((latest, r) => (r.finishedAt > latest ? r.finishedAt : latest), runsShownAfter);
		const jobs = new Map(scheduler.store.load().map((j) => [j.id, j]));
		const inbox = scheduler.inbox.list();
		for (const record of fresh.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))) {
			const job = jobs.get(record.jobId);
			if (!job || !sameProject(job.cwd, session.cwd)) continue;
			showRunCard(ctx, job, record, inbox.filter((e) => e.run_id === record.runId).map((e) => e.text));
		}
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
				host: (() => {
					const rec = liveHostRecord();
					return rec ? { running: true, pid: rec.pid } : { running: false };
				})(),
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
		const decisions = scheduler.inbox.decisionCount();
		if (n > 0) parts.push(`Inbox: ${n} new${decisions ? ` (${decisions} decision${decisions === 1 ? "" : "s"})` : ""}`);
		// Machine-wide like the inbox count and the running list above it: one process owns the
		// machine's clock, and a loop failing in another checkout is still this machine's automation
		// going quiet.
		const failing = failingSummary(scheduler.store.load());
		if (failing) parts.push(failing);
		const running = [...scheduler.runningLabels(), ...triggers.runningList().map((r) => (r.sourceLabel === "local:dynamic" ? "trigger-check" : r.sourceLabel))];
		if (running.length) parts.push(`running: ${running.join(", ")}`);
		const attention = mcpSources.filter((s) => s.status.state === "disconnected" || s.status.state === "auth_failed").length;
		if (attention) parts.push(`mcp: ${attention} source${attention === 1 ? "" : "s"} down`);
		if (hostState) parts.push(HOST_STATE_BADGE[hostState.kind]);
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
		// Read once for the whole listing: the run log and the inbox are each one file, and a
		// project with a dozen loops would otherwise parse them a dozen times per `/cron`. The shape
		// of the lines is src/job-lines.ts, where a test can see a marker go.
		const runs = jobs.some((j) => j.stateful) ? scheduler.store.allRuns() : [];
		const inbox = jobs.some((j) => j.stateful) ? scheduler.inbox.list() : [];
		return cronJobLines(jobs, { runs, inbox, view: scheduler.ownerView(), now: Date.now(), home: process.env.HOME ?? "", cwdExists: (cwd) => fs.existsSync(cwd) });
	}

	/* --------------------------------------------------------- creation */

	const createJob = (input: CreateJobInput, scope?: JobScope) => createLoopJob(toolHost, input, scope);

	/**
	 * The `cron_control_plane` audit: every add / enable / disable / remove, from a slash
	 * command or a tool, leaves a custom entry in the session (never in LLM context).
	 */
	function cronControlAudit(op: "add" | "enable" | "disable" | "remove", actor: "slash" | "tool" | "sub-agent" | "scheduler", before?: LoopJob, after?: LoopJob): string {
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
		"/session-import <path> [--activate-triggers=off|ask|on] [--cwd <dir>] [--resume]   restore it here (automation stays off unless activated)",
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
				const job = /^\d+$/.test(ref.trim()) ? resolveJobRef(all.filter((j) => sameProject(j.cwd, session.cwd)), ref, { ordinals: true }) : resolveJobRef(all, ref);
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
						// A loop runs in the host; a plain job only in the window holding its conversation.
						let ran: true | string;
						if (job.stateful) {
							if (!liveHostRecord()) await hostTick(false);
							const answer = await askHost(dir, { op: "run", jobId: job.id });
							ran = answer?.ok ? (answer.ran ?? true) : `did not start: the host is not running${hostState ? ` (${hostProblemText()})` : ""}; loops do not run in this window`;
						} else ran = await scheduler.runNow(job.id);
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
									if (enable) {
										x.lastError = undefined;
										x.interruptions = undefined;
									}
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
							if (enable) {
								j.lastError = undefined;
								j.interruptions = undefined;
							}
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
						// `pick` resolves a name machine-wide, which is right for `/cron run ci` and wrong
						// here: a removal cannot be undone, and a name this project does not have would
						// reach into a checkout nobody was looking at and delete its job with a message
						// that never says so. `resolveJobRefScoped` is the rule `cron_remove` already
						// follows — a name resolves in this project, another project's job needs its
						// exact id — so the two faces of the same deletion agree.
						const ref = rest.replace(/(^|\s)--purge(\s|$)/, " ").trim();
						const all = jobs();
						const job = /^\d+$/.test(ref) ? resolveJobRef(all.filter((j) => sameProject(j.cwd, session.cwd)), ref, { ordinals: true }) : resolveJobRefScoped(all, ref, session.cwd);
						if (!job) {
							ctx.ui.notify(ref ? `no cron job with id '${ref}' in ${homeRel(session.cwd)} (another project's job needs its exact id)` : "usage: /cron remove <id> [--purge]", "warning");
							return;
						}
						const { aborted } = await scheduler.removeJob(job.id, { purge });
						cronControlAudit("remove", "slash", job, undefined);
						const kept = job.stateful && !purge ? `; its loop state is kept (${homeRel(scheduler.store.statePath(job.id))}) — /cron gc --purge clears orphaned state` : purge && job.stateful ? " and its loop state" : "";
						// An exact id may still name another project's job. Say which, so a removal that
						// reached outside this checkout is never a line that looks like any other.
						const elsewhere = sameProject(job.cwd, session.cwd) ? "" : ` in ${homeRel(job.cwd)}`;
						ctx.ui.notify(`removed cron job ${job.id}${job.name ? ` "${job.name}"` : ""}${elsewhere}${kept}${aborted > 0 ? "; aborted its running run" : ""}`, "info");
						return;
					}
					case "host": {
						// One always-on host per loops directory runs every loop; windows never yield to it or take it back.
						const action = rest.trim();
						if (action === "stop") {
							writeUiPref(dir, "host", "stopped");
							const live = liveHostRecord();
							if (live) await askHost(dir, { op: "stop" });
							ctx.ui.notify(live ? `stopped the host (pid ${live.pid}); loops and checks are paused until /cron host start` : "the host is not running; it will not be started until /cron host start", "info");
							refreshBadge();
							return;
						}
						if (action === "start") {
							clearUiPref(dir, "host");
							const out = await hostTick(false, true);
							const live = liveHostRecord();
							ctx.ui.notify(live ? `the host is running (pid ${live.pid})` : `the host is not running: ${out?.error ?? (out?.action.kind === "none" ? out.action.reason : "it did not start")}`, live ? "info" : "warning");
							refreshBadge();
							return;
						}
						const live = liveHostRecord();
						const answer = live ? await askHost(dir, { op: "status" }) : undefined;
						const hostSnapshot = answer?.ok ? answer.snapshot : undefined;
						const stopped = readUiPrefs(dir).host === "stopped";
						show(ctx, "Host", [
							live
								? `  running: pid ${live.pid}, pi-loops ${live.version}, since ${formatLocal(Date.parse(live.startedAt))}${hostSnapshot ? "" : " — not answering on its socket"}`
								: `  not running${stopped ? " (stopped: /cron host start)" : hostState ? ` — ${hostProblemText()}` : " (it starts when there is a loop, a rule or a push server to run)"}`,
							...(hostSnapshot ? renderHostSnapshot(hostSnapshot) : []),
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
						// The price beside what it bought: a loop's findings in the same window, and what a
						// person did with them. `$0.410  28 run(s)  pr-watch  —  6 findings · 6 dismissed` is
						// a line that answers itself.
						const runsInLog = scheduler.store.allRuns();
						const inboxAll = scheduler.inbox.list();
						const worthOf = (id: string) => signalSummary(loopSignal(id, runsInLog, inboxAll, since));
						show(ctx, `Automation cost ${label}: $${spend.total.toFixed(3)} over ${spend.runs} run(s)`, [
							...(spend.rotated > 0 ? [`  including $${spend.rotated.toFixed(3)} from runs the log has already rotated away`] : []),
							...(budget.cap > 0 ? [`  today's budget: $${budget.spent.toFixed(2)} of $${budget.cap.toFixed(2)}${budget.over ? " — dispatching is paused" : ""}`] : ["  no budget cap set ([limits] daily_budget_usd)"]),
							...byJob.slice(0, 12).map(([id, e]) => {
								const worth = worthOf(id);
								return `  $${e.cost.toFixed(3)}  ${e.runs} run(s)  ${e.name ?? id}${worth ? `  —  ${worth}` : ""}`;
							}),
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
							...(orphans.length && !purge ? [`  ${orphans.length} job(s) that are gone left loop state or transcripts behind (${Math.round(orphans.reduce((n, o) => n + o.bytes, 0) / 1024)} KB) — /cron gc --purge deletes them`] : []),
							...(all ? [] : ["  --all also collects other projects' dead jobs"]),
							...(purge && orphans.length ? [`  deleted the loop state and transcripts of ${orphans.length} job(s) that are gone`] : []),
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
						const live = liveHostRecord();
						const here = binding.here();
						show(ctx, `Cron scheduler (pi-loops ${PI_LOOPS_VERSION} on pi ${PI_VERSION})`, [
							`this window: pid ${process.pid}, ${schedulerStarted ? "firing the plain jobs of its conversation" : "not scheduling (non-interactive)"}${here.sessionId ? ` · conversation ${here.sessionId.slice(0, 8)} ${here.holds ? "held here" : binding.viewerOf !== undefined ? `held by pid ${binding.viewerOf}` : "not held"}` : ""}`,
							`host: ${live ? `pid ${live.pid}, pi-loops ${live.version}, since ${formatLocal(Date.parse(live.startedAt))} (runs every loop and check)` : `not running${hostState ? ` — ${hostProblemText()}` : ""}`}`,
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

	const INBOX_USAGE = "[list|all|claim <n>|dismiss <n> [reason]|open <n>|clear|help] [--all]";

	const INBOX_HELP = [
		"/inbox                list new findings of this project    /inbox --all   every project on this machine",
		"/inbox all [--all]    include claimed/dismissed history",
		"/inbox claim <n|id>   mark claimed and hand it to the agent as a real turn",
		"/inbox dismiss <n|id> [reason]   mark dismissed; a reason is shown to the loop's next run",
		"/inbox clear [--all]  dismiss the ones listed",
		"/inbox open <n|id>    start a new conversation from the run that filed it",
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
			const when = formatLocal(Date.parse(e.created_at));
			// ⚑ is a checkpoint — a decision the finding asks of a person; ✓ is the checker's mark.
			const mark = `${e.kind === "checkpoint" ? "⚑ " : ""}${e.verified ? "✓ " : ""}`;
			// The project comes first of the three: with loops running in several checkouts it is what
			// decides whether a finding is this morning's problem, and claiming runs it in that cwd.
			const why = e.dismiss_reason ? ` — dismissed: ${redact(e.dismiss_reason)}` : "";
			if (!numbered) return `  [${e.status}] ${mark}${redact(e.text)}${why}  (${projectOf(e.cwd)}, ${e.source})`;
			return `  ${i + 1}. [${e.id.slice(0, 12)}] ${mark}${redact(e.text)}  (${projectOf(e.cwd)}, ${e.source}, ${when})`;
		});
	}

	function claimPrompt(e: InboxEntry): string {
		const verified = e.verified ? `\n(An independent checker reviewed and kept this finding${e.verified_reason ? `: ${e.verified_reason}` : ""}.)` : "";
		// A checkpoint is a decision the loop prepared and left to a person; the claim is that
		// person's yes, so the turn carries the decision out rather than re-investigating it.
		const checkpoint = e.kind === "checkpoint" ? "\nThis finding is a checkpoint: claiming it is the person's approval of the decision it recommends — carry that decision out, and stop where the finding says a person acts." : "";
		return `A recurring loop (${e.source}, running in ${e.cwd}) reported this finding — investigate and address it:\n${e.text}${verified}${checkpoint}`;
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
			const subs = ["list", "all", "claim", "dismiss", "open", "clear", "help", "--all"];
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
							markSeenIfShown(everywhere);
							return;
						}
						const lines = inboxLines(entries, true);
						const elsewhere = all.length - entries.length;
						if (elsewhere) lines.push(`+ ${elsewhere} finding${elsewhere === 1 ? "" : "s"} in other projects — /inbox --all`);
						lines.push("claim with /inbox claim <n>, dismiss with /inbox dismiss <n>");
						const decisions = entries.filter((e) => e.kind === "checkpoint").length;
						show(ctx, `Inbox (${where}, ${entries.length} new${decisions ? `, ${decisions} need${decisions === 1 ? "s" : ""} a decision` : ""}, times ${localOffset(Date.now())}):`, lines);
						markSeenIfShown(everywhere);
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
					case "dismiss":
					case "open": {
						// `/inbox dismiss 3 that file is generated`: the first word names the finding, the rest is
						// why, and the reason goes to the loop that reported it, in its next run's prompt. A
						// claim takes the whole argument as the ref, as it always has. For a dismiss, `--all`
						// only counts before the reason starts (`dismiss --all 3 …`, `dismiss 3 --all …`): a
						// reason that mentions `--all` in passing must not re-number the list the person is
						// looking at and dismiss another project's finding.
						let target = ref;
						let reason = "";
						let machineWide = everywhere;
						if (sub === "dismiss") {
							const words = rest.split(/\s+/).filter(Boolean);
							machineWide = words[0] === "--all";
							if (machineWide) words.shift();
							target = words.shift() ?? "";
							if (words[0] === "--all") {
								machineWide = true;
								words.shift();
							}
							reason = words.join(" ");
						}
						// Numbers are the numbers on screen — this project's list, as `/cron` does it; an id
						// or a prefix still resolves machine-wide, so a finding can be claimed from anywhere.
						const all = scheduler.inbox.listNew();
						const entries = /^\d+$/.test(target) && !machineWide ? inProject(all, session.cwd, sameProject) : all;
						const entry = resolveInboxRef(entries, target, { ordinals: true });
						if (!entry) {
							const n = Number(target);
							ctx.ui.notify(!target ? "usage: /inbox claim <n or inb-id> | /inbox dismiss <n or inb-id> [reason] | /inbox open <n or inb-id>" : Number.isInteger(n) ? `no inbox entry #${n} in ${where} (have ${entries.length}; /inbox --all lists every project)` : `no new inbox entry matching '${target}'`, "warning");
							return;
						}
						if (sub === "open") {
							const transcript = entry.transcript ?? scheduler.store.allRuns().find((record) => record.runId === entry.run_id)?.sessionFile;
							if (!transcript || !fs.existsSync(transcript)) {
								ctx.ui.notify(`transcript for inbox entry ${target} is gone (pruned, or the run kept none)`, "warning");
								return;
							}
							// Into this window's session directory: with `--session-dir`, pi's default one is not where `/resume` looks.
							const forkedFile = SessionManager.forkFrom(transcript, ctx.cwd, ctx.sessionManager.getSessionDir()).getSessionFile();
							if (forkedFile) await ctx.switchSession(forkedFile);
							return;
						}
						await scheduler.inbox.setStatus(entry.id, sub === "claim" ? "claimed" : "dismissed", sub === "claim" ? session.sessionId : undefined, reason || undefined);
						refreshBadge();
						if (sub === "dismiss") {
							const loop = scheduler.store.load().find((j) => j.id === entry.job_id);
							// A trigger's finding carries its source label where a loop's carries a job id; a
							// trigger has no notes and no next run to tell.
							const gone = entry.job_id?.startsWith("cron-") ? "the loop that reported it is gone, so nobody is told" : "a trigger reported it, and a trigger keeps no notes, so nobody is told";
							const told = reason ? ` — ${loop ? `${loop.name ?? loop.id} is told why on its next run` : gone}` : "";
							ctx.ui.notify(`dismissed: ${previewRedacted(entry.text, 80)}${told}`, "info");
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
				const rule = /^\d+$/.test(ref.trim()) ? resolveRuleRef(all.filter((r) => sameProject(r.cwd, session.cwd)), ref, { ordinals: true }) : resolveRuleRef(all, ref);
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
						const hostRec = liveHostRecord();
						show(ctx, "Trigger status:", [
							`  dynamic rules: ${rules.length} total, ${enabled} enabled, ${rules.length - enabled} disabled (${fireOnce} fire_once, ${rules.length - fireOnce} repeat, ${promote} promote_to_chat)`,
							`  dynamic checker: ${hostRec ? `the host (pid ${hostRec.pid})` : "the host, which is not running"}, polls every ${triggers.pollIntervalSecs}s while enabled rules exist; a result goes to the conversation that created the rule`,
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
						const args = auditArgs(rest);
						if ("usage" in args) {
							ctx.ui.notify(args.usage, "warning");
							return;
						}
						// This project's rows by default (rows without a cwd predate 0.1.3 and are shown too).
						const rows = store.listAudit(args.limit, args.all ? undefined : (r) => !r.cwd || sameProject(r.cwd, session.cwd));
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
		"/recipe show <name|path>   what one would install: playbooks, jobs, levels, what the runs may never do, setup script",
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

	/**
	 * What the playbooks forbid, as `/recipe show` and the install confirmation print it: one
	 * block per playbook that has a `## Never` section. It is the safety envelope of an unattended
	 * run, and the one part of a playbook worth reading before saying yes to the install.
	 */
	/**
	 * What the project has and lacks for this recipe's runs, checked now rather than found out by
	 * the first run at three in the morning. Reported, never enforced: the install goes through
	 * whatever the lines say, because a missing `gh` login is fixed in a minute and a job that is
	 * not there is not.
	 */
	async function preflightLines(recipe: Recipe, project: string, level: AutonomyLevel): Promise<string[]> {
		let tracker: string | undefined;
		try {
			tracker = fs.readFileSync(path.join(project, TRACKER_FILE), "utf8");
		} catch {
			tracker = undefined;
		}
		return renderPreflight(await runPreflight(preflightChecks(recipe.manifest, level, tracker), project));
	}

	function neverLines(recipe: Recipe): string[] {
		const out: string[] = [];
		for (const file of playbookFiles(recipe.manifest)) {
			if (!file.endsWith(".md")) continue;
			let text: string;
			try {
				text = fs.readFileSync(path.join(recipe.dir, file), "utf8");
			} catch {
				continue;
			}
			const never = neverSection(text);
			if (!never.length) continue;
			out.push(`  never (${file}):`, ...never.map((l) => `    ${l}`));
		}
		return out;
	}


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
		const preflight = await preflightLines(recipe, project, level);
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
			...(neverLines(recipe).length ? ["", "What the playbooks forbid a run to do, at every level:", ...neverLines(recipe)] : []),
			"",
			"Jobs:",
			...plan.addLines.map((l) => `  /cron add ${l}`),
			...(m.budgetHintUsd ? ["", `Budget hint: about $${m.budgetHintUsd}/day — cap it with [limits] daily_budget_usd in config.toml`] : []),
			...(preflight.length ? ["", "Before the first run (checked now; nothing here blocks the install):", ...preflight] : []),
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
						const line = (r: Recipe) => {
							const rec = installed.get(r.manifest.name);
							const n = jobs.filter((j) => j.recipe === r.manifest.name).length;
							return `  ${r.manifest.name.padEnd(17)} ${(rec ? `installed: ${rec.level}, ${n} job(s)` : "—").padEnd(28)} ${r.manifest.summary}`;
						};
						// Starters first: they read and file findings, and are the ones to install before
						// anything that writes to a tracker or opens a pull request.
						const lines: string[] = [];
						for (const tier of RECIPE_TIERS) {
							const group = packaged.filter((r) => r.manifest.tier === tier);
							if (!group.length) continue;
							lines.push(tier === "starter" ? "  starter — reads, and files findings; install one of these first:" : "  advanced — writes to a worktree, a tracker or a pull request; read the playbooks first:");
							lines.push(...group.map(line));
						}
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
						const topLevel = m.levels[m.levels.length - 1];
						const showPreflight = await preflightLines(recipe, project, topLevel);
						const lines = [
							`  ${m.summary}`,
							`  tier: ${m.tier}${m.tier === "starter" ? " (reads, and files findings)" : " (writes to a worktree, a tracker or a pull request)"}`,
							...(m.usefulWhen.length ? ["  useful when:", ...m.usefulWhen.map((u) => `    ${u}`)] : []),
							`  levels: ${m.levels.map((l) => `${l} (${LEVEL_TEXT[l]})`).join("; ")}`,
							`  tracker: ${m.needsTracker ? `needs ${TRACKER_FILE} — ${fs.existsSync(path.join(project, TRACKER_FILE)) ? "present" : "missing here; /recipe add writes it with you"}` : "not needed"}`,
							`  files → ${rel}/: ${playbookFiles(m).join(", ")}`,
							...(m.setup ? [`  setup script: ${m.setup} (shown before it runs, once per project)`] : []),
							...(m.budgetHintUsd ? [`  budget hint: about $${m.budgetHintUsd}/day at the default schedules — [limits] daily_budget_usd in config.toml`] : []),
							"  jobs:",
							...m.jobs.map((j) => `    /cron add ${addLineFor(j, rel)}`),
							...neverLines(recipe),
							...(showPreflight.length ? [`  before the first run (at ${topLevel}, checked now):`, ...showPreflight] : []),
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
							purge ? `and delete what the install wrote in ${homeRel(dir)}/ (${record ? `${record.files.length} file(s) as installed — an edited one is kept — their untouched copies, the record` : "no record: only the directory if it is empty"}) and the loops' notes` : `the files in ${homeRel(dir)}/ and the loops' notes are kept (--purge deletes both)`,
						].join("\n"));
						if (!ok) {
							ctx.ui.notify("not removed", "info");
							return;
						}
						let aborted = 0;
						let keptNote = "";
						for (const job of jobs) {
							const r = await scheduler.removeJob(job.id, { purge });
							aborted += r.aborted;
							cronControlAudit("remove", "slash", job, undefined);
						}
						if (purge) {
							if (record) {
								const { kept } = purgeInstall(dir, record, listRecipes().find((r) => r.manifest.name === name)?.manifest.setup);
								if (kept.length > 0) keptNote = `; kept ${kept.length} edited file(s): ${kept.join(", ")}`;
							} else {
								try {
									fs.rmdirSync(dir);
								} catch {
									// not empty or not there: nothing of ours to take
								}
							}
						}
						refreshBadge();
						ctx.ui.notify(
							`removed recipe ${name}: ${jobs.length} job(s)${purge ? ", its files and notes" : `; files kept in ${homeRel(dir)}/`}${aborted > 0 ? `; aborted ${aborted} running run(s)` : ""}${keptNote}`,
							"info",
						);
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
				const { jobs, rules } = automationOf(scheduler.store.load(), triggers.store.load(), session.cwd, sessionId);
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
			let mode: ActivateMode = "ask";
			let resume = false;
			let targetCwd = session.cwd;
			const positional: string[] = [];
			try {
				for (let i = 0; i < parts.length; i++) {
					const arg = parts[i];
					if (arg === "--resume") resume = true;
					// Both forms, as the command line takes them.
					else if (arg.startsWith("--activate-triggers=")) mode = parseActivateMode(arg.slice("--activate-triggers=".length));
					else if (arg === "--activate-triggers") mode = parseActivateMode(parts[++i]);
					else if (arg === "--cwd") targetCwd = path.resolve(session.cwd, parts[++i] ?? ".");
					else positional.push(arg);
				}
			} catch (err: any) {
				ctx.ui.notify(err?.message ?? String(err), "warning");
				return;
			}
			if (positional.length !== 1) {
				ctx.ui.notify("usage: /session-import <path> [--activate-triggers=off|ask|on] [--cwd <dir>] [--resume]", "warning");
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
					activate: mode === "on",
					existingJobs: store.load(),
					existingRules: triggers.store.load(),
					existingJobIds: new Set(store.load().map((j) => j.id)),
					existingRuleIds: new Set(triggers.store.load().map((r) => r.id)),
				});
				await applyImport(imp, store, triggers.store);
				for (const job of imp.jobs) cronControlAudit("add", "slash", undefined, job);
				refreshBadge();
				const skipped = (imp.skippedJobs ?? 0) + (imp.skippedRules ?? 0);
				show(ctx, `imported session: ${imp.sessionId.slice(0, 16)}`, [
					`path: ${homeRel(imp.sessionPath)}`,
					`entries=${imp.entryCount} triggers=${imp.rules.length} cron=${imp.jobs.length} loop_state=${Object.keys(imp.states).length} automation=${imp.automationEnabled ? "enabled" : "disabled"}${skipped ? ` skipped=${skipped} (already imported)` : ""}`,
					...(imp.notes ?? []).map((n: string) => `note: ${n}`),
					`resume with: pi --session ${imp.sessionPath}`,
				]);
				// Offer to switch originally-enabled automation back on. Nothing is asked with no UI to
				// ask in, and `off` means nothing is asked at all.
				const enabled = await offerToEnable(imp, store, triggers.store, mode === "ask" && ctx.hasUI ? (question, detail) => ctx.ui.confirm(question, detail) : undefined, (before, after) => cronControlAudit("enable", "slash", before, after));
				if (enabled.jobs || enabled.rules) {
					refreshBadge();
					ctx.ui.notify(`enabled ${enabled.jobs} cron job(s) and ${enabled.rules} trigger rule(s)`, "info");
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
		// A runtime that never sends session_start still gets its host this way (cron_create, new_trigger).
		ensureHost: () => void hostTick(false).catch((err: any) => log.info(`host: ${err?.message ?? err}`)),
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

	/**
	 * The `pi-loops` command, kept on the PATH of whoever asked for it there.
	 *
	 * `pi install` puts this package under pi's directory and nothing on the PATH, so until 0.22.1
	 * the first thing a new user had to do was type a bare `node …/cli-entry.mjs install-launcher`
	 * out of the README — the one step that only existed because the command could not yet run
	 * itself. pi loads this extension at every session start, and at that moment it knows both where
	 * it runs and where a launcher would go, so the step belongs here.
	 *
	 * This is the extension's only write outside the loops directory (AGENTS.md). Its limit is one
	 * file, `pi-loops` in a directory already on the PATH, and only where a launcher of ours already
	 * is or after a yes. A file with no marker of ours is somebody's own wrapper and is left alone;
	 * one naming another copy of this package that is still on disk is that copy's to keep current,
	 * so an install and a checkout both being opened never trade the file back and forth; a no is
	 * remembered in `ui.json`, so it is asked once rather than in every window; and a checkout is
	 * never asked for a launcher that is not there at all — nobody ran `pi install`, so nothing is
	 * missing from their PATH — though one written from a checkout is still kept working.
	 */
	async function keepLauncher(ctx: ExtensionContext): Promise<void> {
		const { entryDir, node, agentDir } = launcherSource();
		const target = launcherTarget(undefined);
		// Nothing on the PATH to write into. `/pi-loops install-launcher`, run by hand, is where that
		// is explained; a session start saying it unprompted would be a warning about nothing.
		if (!target) return;
		const { state } = launcherState(entryDir, node, agentDir, target);
		if (state === "stale") {
			const done = refreshLauncher(entryDir, node, agentDir, target);
			if (!done) return;
			log.info(`launcher: ${done.message}`);
			// No question: they asked for a launcher once, and keeping that one working is what they
			// asked for. The line is so that a file changing under them is never a silent change.
			if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${done.message}`, done.ok ? "info" : "warning");
			return;
		}
		if (state !== "absent") return; // ours and current, another copy's, or somebody else's entirely
		if (!ctx.hasUI || readUiPrefs(dir).launcher === "declined" || !installedByPi()) return;
		const lines: string[] = [];
		const code = await installLauncherWithConfirm([], (title, body) => ctx.ui.confirm(title, body), (l) => lines.push(l));
		if (code === undefined) {
			writeUiPref(dir, "launcher", "declined");
			ctx.ui.notify("[pi-loops] not installed — `/pi-loops install-launcher` writes one whenever you want it", "info");
			return;
		}
		ctx.ui.notify(`[pi-loops] ${lines.map((l) => l.trim()).join(" · ")}`, code === 0 ? "info" : "warning");
	}

	/**
	 * The login unit, kept current and offered once — the launcher's rules (`keepLauncher`), for the
	 * second file pi-loops writes outside its loops directory. Only the default loops directory gets
	 * one, only a machine with systemd or launchd is asked, and only once there is something for the
	 * host to run after a reboot. A no is remembered in `ui.json`; `pi-loops host install` writes the
	 * unit whenever someone wants it.
	 */
	async function keepHostUnit(ctx: ExtensionContext): Promise<void> {
		if (process.env.PI_LOOPS_HOST?.toLowerCase() === "off") return;
		const here = hostUnitHere(dir, piPackageDir());
		if ("refused" in here) return;
		const { state } = unitState(here.kind, here.file, here.spec);
		if (state === "stale") {
			const done = refreshUnit(here.kind, here.file, here.spec);
			if (!done) return;
			let message = done.message;
			let ok = done.ok;
			if (ok) {
				try {
					reloadHostUnit(here);
				} catch (err: any) {
					ok = false;
					message = `${message}, but ${here.kind} did not reload it: ${err?.message ?? err}`;
				}
			}
			log.info(`host unit: ${message}`);
			if (ctx.hasUI) ctx.ui.notify(`[pi-loops] ${message}`, ok ? "info" : "warning");
			return;
		}
		if (state !== "absent") return; // ours and current, another copy's, or somebody else's entirely
		if (!ctx.hasUI || readUiPrefs(dir).hostUnit === "declined") return;
		const work = automationCounts();
		if (!work.loops && !work.rules && !work.pushServers) return;
		const ok = await ctx.ui.confirm(
			"Start the pi-loops host when you log in?",
			[
				"Loops would then run after a reboot before you open pi.",
				`This writes ${here.file}.`,
				"Provider keys exported in your shell do not reach it; keys saved with pi's /login do.",
			].join("\n"),
		);
		if (!ok) {
			writeUiPref(dir, "hostUnit", "declined");
			ctx.ui.notify("[pi-loops] not installed — `pi-loops host install` writes it whenever you want it", "info");
			return;
		}
		const lines: string[] = [];
		const code = installHostUnit(dir, (l) => lines.push(l), piPackageDir());
		ctx.ui.notify(`[pi-loops] ${lines.map((l) => l.trim()).join(" · ")}`, code === 0 ? "info" : "warning");
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (startHandled) return; // the same start, delivered a second time by a second rebind
		startHandled = true;
		session = sessionSnapshot(ctx);
		bindSession(ctx);
		// A 0.22.x pi on the same conversation has no lease and fires its plain jobs regardless.
		const older = olderPiOnSession(scheduler.presenceList(), session.sessionId, scheduler.self);
		if (older && ctx.hasUI) ctx.ui.notify(`[cron] this conversation is also open in an older pi-loops (pid ${older.pid}); both windows may run its plain jobs — close or restart that window`, "warning");
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
		// Not awaited: the question below is a dialog, and the clock must not wait behind someone who
		// has walked away from it.
		// One question at a time: the login unit is asked about after the launcher's answer.
		void keepLauncher(ctx)
			.catch((err: any) => log.info(`launcher: ${err?.message ?? err}`))
			.then(() => keepHostUnit(ctx))
			.catch((err: any) => log.info(`host unit: ${err?.message ?? err}`));
		// tui and rpc processes stay alive and host the timer; `PI_LOOPS_HOST=1` lets a `pi -p`
		// run (a long headless prompt) host it too.
		const hostMode = ctx.mode === "tui" || ctx.mode === "rpc" || envFlag("LOOPS_HOST");
		if (!hostMode) return;
		// The host runs the loops; this window only makes sure there is one. Not awaited: a start can
		// take seconds, and the session must not wait behind it. A probe here never counts toward
		// evicting a host that is still starting.
		hostTick(false).catch((err: any) => log.info(`host: ${err?.message ?? err}`));
		runsShownAfter = stamp();
		scheduler.start();
		schedulerStarted = true;
		refreshBadge();
		pruneLogs(dir);
		// What was loaded is printed on every start; without a line here a session
		// can begin with loops and rules the user has entirely forgotten about.
		// "Active here" means it: a plain job of another session is asleep, not active.
		const myJobs = scheduler.store.load().filter((j) => sameProject(j.cwd, session.cwd) && j.enabled && runsHere(j, scheduler.ownerView()));
		const myRules = triggers.store.load().filter((r) => sameProject(r.cwd, session.cwd) && r.enabled);
		// What is scheduled says nothing about what is working: a loop that has failed every night
		// since Tuesday is still counted as active, and this line is the only one a user reads.
		const failing = failingSummary(myJobs);
		log.info(`session start: ${myJobs.length} enabled loop(s), ${myRules.length} enabled rule(s)${failing ? `, ${failing}` : ""} in ${session.cwd}`);
		if (session.sessionId) {
			const line = sinceYouLookedLine(sinceYouLookedHere(session.sessionId));
			if (line && ctx.hasUI) ctx.ui.notify(line, "info");
		}
		if (ctx.hasUI && (myJobs.length || myRules.length)) {
			const next = myJobs
				.map((j) => computeNext({ schedule: j.schedule, createdAt: Date.parse(j.createdAt), lastFiredAt: j.lastFiredAt ? Date.parse(j.lastFiredAt) : undefined }, Date.now()))
				.filter((n): n is number => n !== undefined)
				.sort((a, b) => a - b)[0];
			ctx.ui.notify(`[cron] ${myJobs.length} loop(s) and ${myRules.length} rule(s) active here${next ? ` · next ${formatLocal(next)}` : ""}${failing ? ` · ${failing} — /cron runs` : ""}`, "info");
		}
	});

	// hooks.toml events, mapped from pi's lifecycle events.
	pi.on("agent_start", async (_e, ctx) => {
		bindSession(ctx);
		await fireHook({ event: "agent_start" }, ctx);
	});
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
		if (lastTurnStopReason === "aborted") {
			goalAbort?.abort();
			// Esc pauses the goal, not only this turn's judgement: the person said stop, and a goal
			// that went on pursuing would send them back to work on their next message.
			const stopped = goal && abortedTurn(goal);
			if (stopped) {
				persistGoal(ctx, stopped.state);
				notifyOrLog(ctx, `[goal] paused: ${stopped.action.kind === "pause" ? stopped.action.reason : ""}`, "warning");
			}
		}
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

	pi.on("session_shutdown", async (event, ctx) => {
		// The host keeps running whatever this window does: nothing is handed off.
		//
		// `/new`, `/resume`, `/reload` and `/fork` replace the session inside the same process, and pi
		// rebuilds the extension with it — so this scheduler must stop, or two would run at once.
		// A run aborted by the swap gives its slot back (see `launch`), and the replacement session
		// re-fires it on its first tick instead of losing it until the next due time.
		startHandled = false;
		if (schedulerStarted) {
			schedulerStarted = false;
			await triggers.stop();
			await scheduler.stop();
		}
		// The conversation is free for the next window (or, after /new, the next session here) at once.
		mailboxWatch?.close();
		mailboxWatch = undefined;
		try {
			binding.release();
		} catch (err: any) {
			log.info(`lease release: ${err?.message ?? err}`);
		}
		if (event.reason !== "quit") {
			await hookRunner?.drain(3000);
			return; // the replacement session_start starts everything again
		}
		await hookRunner?.drain(3000);
		await mcpPool.stopAll();
		await stopMcpSources();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		if (ctx.mode === "tui") ctx.ui.setWidget(PANEL_KEY, undefined);
	});
}
