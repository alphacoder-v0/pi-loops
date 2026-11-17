/**
 * What the always-on host runs (see host.ts for the process shell): the same LoopScheduler and
 * TriggerRuntime as the extension, wired for a process that has no chat. It runs every loop and
 * checks every rule; a promotion is a request addressed to the conversation that created the rule
 * (src/requests.ts): its holder delivers it, and this process does when it is closed. Control-plane
 * operations by sub-agents are audited into `triggers-audit.jsonl`. Injected so it can be unit-tested.
 */
import * as fs from "node:fs";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { LoopsConfig } from "./config.ts";
import { HookRunner, runEndEvent, runStartEvent } from "./hooks.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { redact } from "./redact.ts";
import { keepNotice, parseRingNote, type Notice } from "./host-control-channel.ts";
import type { SubagentRequest, SubagentRunner } from "./runner.ts";
import { type LeaseHolder, LeaseStore, closedConversation, liveHolderPid, procStart, sameHolder } from "./lease.ts";
import { type EngineSinks, promotionTarget, promotionView, ruleResultRow } from "./engine.ts";
import { RequestStore, type Row } from "./requests.ts";
import { PI_LOOPS_VERSION } from "./version.ts";
import { type BackgroundExecutor, createBackgroundExecutor } from "./background-executor.ts";
import { RunList } from "./run-list.ts";
import { DEFAULT_RUN_TIMEOUT_MS, LoopScheduler, type PlainJobLeases, type SessionSnapshot } from "./scheduler.ts";
import { stamp } from "./schedule.ts";
import { budgetState } from "./job-status.ts";
import { SubagentSlots } from "./slots.ts";
import { type LoopJob, newId } from "./store.ts";
import { RUNTIME_RIDERS, type Riders } from "./ticker.ts";
import { type ToolHost, automationTools, createLoopJob } from "./tools.ts";
import { TriggerRuntime, promotionToInbox } from "./trigger-runtime.ts";
import { auditCronFinish, auditCronStart, TriggerStore, controlPlanePreflight } from "./triggers.ts";
import { shortSessionId } from "./session-head.ts";

export interface HostRuntimeDeps {
	dir: string;
	config: () => LoopsConfig;
	/** The host's own defaults: no cwd, the settings' model and thinking level. */
	session: () => SessionSnapshot;
	runner: SubagentRunner;
	/** MCP tool definitions of the host's own (user-level) servers, for every sub-session. */
	mcpTools: () => ToolDefinition<any, any>[];
	/** That project's own MCP servers, connected on demand: the host has no project of its own. */
	projectMcpTools?: (cwd: string, taken: Set<string>, trusted?: boolean) => Promise<ToolDefinition<any, any>[]>;
	/** Whether pi has a saved trust decision for exactly this directory (src/trust.ts). Default: no. */
	isProjectTrusted?: (cwd: string) => boolean;
	/** pi's own saved decision for a conversation's directory or a parent: what a held turn there may load. */
	ownerTrusts?: (cwd: string) => boolean;
	log: (message: string) => void;
	/** Does pi still have this session? Plain jobs of deleted sessions are parked by the host's sweep. */
	sessionExists?: (sessionId: string) => boolean;
	/** Is this conversation open in the browser page? Then its pi writes the file, and this process never holds it. */
	pageHolds?: (sessionId: string) => boolean;
}

export interface HostRuntime {
	scheduler: LoopScheduler;
	riders: Riders<(typeof RUNTIME_RIDERS)[number]>;
	tick(): Promise<void>;
	triggers: TriggerRuntime;
	/** The tools a sub-session started by this host gets (its cwd and model, not the host's). */
	customTools: (req: SubagentRequest) => Promise<ToolDefinition<any, any>[]>;
	/** Say a warning to the windows of `cwd`'s project (or every window, without one); see `notices`. */
	notice(text: string, cwd?: string): void;
	/** The latest warnings, for the snapshot a window fetches on each tick. */
	notices(): Notice[];
	/** The doorbell: deliver what is queued for a closed conversation now, not on the next tick. Returns at once. */
	ring(sessionId: string): void;
	/** The turn this process is running in the conversation, if any: the browser page waits for it. */
	heldTurn(sessionId: string): { runId: string; label: string } | undefined;
	start(): void;
	stop(): Promise<void>;
}

/** Rings one session may answer between two ticks; a burst of rows is delivered by one ring, so this is far above any real one. */
const RINGS_PER_TICK = 60;

export function createHostRuntime(deps: HostRuntimeDeps): HostRuntime {
	const { dir, log } = deps;
	const kept: Notice[] = [];
	let noticeSeq = 0;
	let budgetSaid: string | undefined;
	const notice = (text: string, cwd?: string) => {
		noticeSeq = keepNotice(kept, noticeSeq, text, cwd, Date.now());
	};
	let triggers: TriggerRuntime;
	let runtimeRidersRan = false;
	const leases = new LeaseStore(dir);
	const requests = new RequestStore(dir);
	/** The host as a lease holder: it holds a closed conversation for one piece of work, then lets go. */
	const ownStart = procStart(process.pid);
	/** This process, as the rows it writes name it. */
	const createdBy = (): Row["created_by"] => ({ pid: process.pid, instance: "host", procStart: ownStart, version: PI_LOOPS_VERSION });
	const me = (busy?: LeaseHolder["busy"]): LeaseHolder => ({ kind: "host", pid: process.pid, instance: "host", procStart: ownStart, acquiredAt: stamp(), pushServers: [], ...(busy ? { busy } : {}) });
	const fileMtime = (file: string | undefined): number | undefined => {
		if (!file) return undefined;
		try {
			return fs.statSync(file).mtimeMs;
		} catch {
			return undefined; // gone: nothing for the quiet guard to remember
		}
	};
	const heldLeases: PlainJobLeases = {
		heldEpoch: (sessionId) => (leases.holds(sessionId, me()) ? leases.read(sessionId)?.epoch : undefined),
		sessionFile: (sessionId) => leases.read(sessionId)?.sessionFile,
		holderOf: (sessionId) => liveHolderPid(leases, sessionId),
	};
	/** The runs that are going in this process: the loops' runs and the held turns, one list. */
	const runs = new RunList();
	/** What this process does to the queue of a closed conversation (src/background-executor.ts). Made below, once the scheduler's stores are there. */
	let background: BackgroundExecutor;
	/** A plain job the host may fire: a conversation pi-loops knows the file of, that nobody holds and the page does not have open. */
	const canHold = (sessionId: string | undefined): boolean => !(sessionId !== undefined && deps.pageHolds?.(sessionId)) && closedConversation(leases, sessionId);

	/** The engine's sinks here: the jobs the rows name, the inbox for dead letters, the audit. */
	const sinks = (): EngineSinks => ({ jobs: { exists: (id) => scheduler.store.load().some((j) => j.id === id), enabled: (id) => scheduler.store.load().find((j) => j.id === id)?.enabled ?? false, goalActive: () => false }, inbox: scheduler.inbox, audit: triggers.store, ledger: scheduler.store, self: createdBy });

	/* ------------------------------------------------------ lifecycle hooks */

	/**
	 * hooks.toml, fired around the runs the host starts: `run_start` and `run_end` (docs/hooks.md).
	 * One runner per run — the host has no project of its own, so each run brings the project the
	 * rules and the payload are about.
	 */
	const runHooks = new Map<string, HookRunner>();

	function hookRunnerFor(job: LoopJob, runId: string): HookRunner | undefined {
		// A model can pick a job's cwd (`cron_create` takes one) and nobody is here to answer a trust
		// prompt, so a project's own hooks.toml needs pi's saved trust for that exact directory —
		// the same bar the host puts in front of a project's MCP servers.
		const trusted = !!deps.isProjectTrusted?.(job.cwd);
		const runner = new HookRunner({
			loopsDir: dir,
			projectCwd: job.cwd,
			allowProjectHooks: trusted && deps.config().allowProjectHooks,
			// The run is this "session": its id is what pairs an `agent_start` with its `agent_end`.
			getSession: () => ({ sessionId: runId, cwd: job.cwd, model: job.model ?? deps.session().model, thinking: job.thinking ?? deps.session().thinking }),
			warn: (msg) => log(`hooks: ${msg}`),
			// The host log is where "what did my automation do last night" is answered, so a hook that
			// prints something has somewhere to print it here too.
			log: (msg) => log(msg),
		});
		runner.load();
		// `allow_project_hooks` in the user's own hooks.toml (or PI_ALLOW_PROJECT_HOOKS) opts every
		// project in at once. That is a decision about projects the user opens, not about a directory
		// this process was merely pointed at, so an untrusted one loses its rules again here.
		if (!trusted) {
			const kept = runner.hooks.filter((h) => h.source === "user");
			if (kept.length !== runner.hooks.length) {
				log(`hooks: ignoring ${runner.hooks.length - kept.length} project hook rule(s) in ${job.cwd}: pi has not trusted that directory`);
				runner.hooks.length = 0;
				runner.hooks.push(...kept);
			}
		}
		for (const d of runner.diagnostics) log(`hooks: ${d}`);
		if (!runner.hooks.length) return undefined;
		runHooks.set(runId, runner);
		return runner;
	}

	/**
	 * One counter for every sub-agent this process starts — loop runs and trigger checks alike — so
	 * `[cron] max_concurrent_runs` bounds what the host actually runs (src/slots.ts). No /goal here:
	 * the host has no conversation to hold to a condition.
	 */
	const slots = new SubagentSlots(() => deps.config().maxConcurrentRuns);

	const scheduler = new LoopScheduler({
		dir,
		kind: "host",
		slots,
		getSession: deps.session,
		getSettings: () => ({ maxConcurrentRuns: deps.config().maxConcurrentRuns, catchUp: deps.config().cronCatchUp, dailyBudgetUsd: deps.config().dailyBudgetUsd }),
		runner: deps.runner,
		// Every loop, and the plain jobs of closed conversations: a plain job's result is a message in
		// its conversation, so the host fires one only where no window holds it.
		owns: (job) => job.stateful || canHold(job.sessionId),
		leases: heldLeases,
		runs,
		background: { fire: (...args) => background.fire(...args), owes: (...args) => background.owes(...args) },
		sessionExists: deps.sessionExists,
		hooks: {
			onRunStart: (job, runId) => {
				// The same rows the interactive extension writes: without them `/triggers audit` is
				// blank for every hour the host had the clock.
				auditCronStart(triggers.store, job, runId);
				log(`loop ${job.name ?? job.id}: run ${runId.slice(0, 12)} started`);
				// Never awaited: a webhook that hangs must not hold up the run it is announcing (the
				// scheduler calls this synchronously). `.catch` because a rejection nobody owns takes
				// the host down — hooks warn per rule, so there is nothing else to do with one.
				const hooks = hookRunnerFor(job, runId);
				if (hooks) void hooks.fire(runStartEvent(job, runId)).catch((err: any) => log(`hooks: ${redact(err?.message ?? String(err))}`));
			},
			onCatchUp: (job) => log(`loop ${job.name ?? job.id}: catching up a missed tick`),
			onRunFinished: ({ job, record, result }) => {
				auditCronFinish(triggers.store, job, record, result.stopReason === "aborted");
				log(`loop ${job.name ?? job.id}: ${record.ok ? "ok" : record.stoppedBy === "person" ? `stopped by you (from ${record.stoppedFrom === "page" ? "the page" : "a terminal"})` : `FAILED (${redact(record.error ?? "")})`} · ${record.findings} finding(s)${record.usage?.cost ? ` · $${record.usage.cost.toFixed(3)}` : ""}`);
				const hooks = runHooks.get(record.runId);
				if (!hooks) return;
				// `$PI_RUN_OK` alone answers "did last night's loop fail" — the thing the host exists to
				// be able to tell someone.
				// Its own hooks are the last thing a run does; the runner is dropped once they have run
				// (until then `stop()` still has to drain it).
				const forget = () => void runHooks.delete(record.runId);
				void hooks.fire(runEndEvent(job, record)).then(forget, forget);
			},
			onTick: async (now) => {
				if (runtimeRidersRan) { runtimeRidersRan = false; return; }
				releaseStrayLeases(now);
				await deliverToClosed();
				await triggers.tick(now);
			},
			log: (msg, level, job) => {
				log(redact(msg));
				if (level !== "info") notice(msg, job?.cwd);
			},
			// A loop failing night after night: said in its project's windows, as it was when loops ran in one.
			onSchedulerError: (msg, job) => {
				log(redact(msg));
				notice(msg, job?.cwd);
			},
			onBudgetExceeded: (spent, cap) => {
				// Each due job reports it; a person needs it once a day.
				const day = stamp().slice(0, 10);
				if (budgetSaid === day) return;
				budgetSaid = day;
				const message = `today's automation has cost $${spent.toFixed(2)} of the $${cap.toFixed(2)} budget; dispatching is paused until tomorrow or a higher [limits] daily_budget_usd`;
				log(message);
				notice(message);
			},
		},
	});

	const toInbox = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }, forSession?: string) => {
		// The check decided this result's finding already (TriggerRuntime's inbox); a push with no rule did not.
		await promotionToInbox(scheduler.inbox, triggers.store, content, trigger, { cwd: trigger.cwd ?? "", sessionId: forSession });
		return "inbox" as const;
	};

	background = createBackgroundExecutor({
		dir,
		requests,
		leases,
		jobs: scheduler.store,
		runs,
		runner: deps.runner,
		sinks,
		holder: me,
		pageHolds: deps.pageHolds,
		ownerTrusts: deps.ownerTrusts,
		turnTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
		appended: (row, into) => {
			// Written into a closed conversation, so no screen showed it: the audit row says so. The
			// "since you last looked" line counts the rule's finding in the inbox (src/seen.ts).
			triggers.store.appendAudit({ cwd: row.payload?.cwd ?? "", type: "trigger_promotion", traceId: row.id, state: "appended", details: { session_id: into.sessionId } });
			// And said in the project's open windows: the person is likely in another conversation of
			// it now, where a rule's result used to land (0.22), and would not know to look there.
			// Once an hour per conversation (keepNotice keeps one of each text an hour).
			notice(`a rule's result was added to conversation ${shortSessionId(into.sessionId)}, which is closed: pi --session ${into.sessionFile} shows it`, row.payload?.cwd);
		},
		deliveryFailed: (sessionId) => void quietUntilTick.add(sessionId),
		// A plain job failing night after night: said in its project's windows, as a loop's is.
		failing: (message, job) => {
			log(redact(message));
			notice(message, job.cwd);
		},
		log,
	});
	/**
	 * A rule's result is a request addressed to a conversation (src/engine.ts promotionTarget): the one
	 * that created the rule while a window holds it, else one a window holds in the rule's project,
	 * else the closed creating conversation, which this process appends to while it holds it for that
	 * one write. A closed conversation this process cannot take this instant (written moments ago,
	 * busy) keeps the row for a later tick. The inbox is for a result no conversation can take.
	 */
	const promote = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }, forSession?: string): Promise<"queued" | "chat" | "inbox"> => {
		const route = promotionTarget(forSession, promotionView(leases, trigger.cwd));
		if (route.to === "inbox") return toInbox(content, trigger, route.sessionId);
		requests.append(ruleResultRow(route.sessionId, content, trigger, createdBy()));
		if (!canHold(route.sessionId)) return "queued";
		return (await background.deliverQueued(route.sessionId, trigger.traceId)) ? "chat" : "queued";
	};

	/**
	 * A conversation this process still holds for a turn that is no longer running: the release at
	 * the turn's end failed (a lock timeout, a full disk), and nothing ran or was delivered there again
	 * until a restart. Given back here, a minute after the turn began, which no turn's setup takes.
	 */
	function releaseStrayLeases(now: number): void {
		const running = new Set(scheduler.runningRuns().map((r) => r.runId));
		for (const lease of leases.list()) {
			const busy = lease.holder?.busy;
			if (!lease.holder || !busy || !sameHolder(lease.holder, me()) || running.has(busy.runId) || now - Date.parse(busy.since) < 60_000) continue;
			try {
				leases.release(lease.sessionId, me(), { epoch: lease.epoch, fileMtimeMs: fileMtime(lease.sessionFile) });
				log(`gave back session ${shortSessionId(lease.sessionId)}, held for run ${busy.runId} that is no longer running`);
			} catch (err: any) {
				log(`lease ${shortSessionId(lease.sessionId)}: ${err?.message ?? err}`);
			}
		}
	}

	/**
	 * Every closed conversation with something queued, on the tick: the floor under the doorbell, so a
	 * ring that was lost costs at most one tick. One conversation's failure (a lock that timed out)
	 * does not keep the others, or the rule checks after this, from their tick.
	 */
	async function deliverToClosed(): Promise<void> {
		quietUntilTick.clear();
		rungSinceTick.clear();
		// Image files whose row is gone (a crash between the two writes): one process sweeps them, here.
		try {
			const swept = requests.sweepImages();
			if (swept.length) log(`removed ${swept.length} image file(s) no request names any more`);
		} catch (err: any) {
			log(`requests: ${err?.message ?? err}`);
		}
		for (const sessionId of requests.sessions()) {
			try {
				await background.deliverSession(sessionId);
			} catch (err: any) {
				log(`requests for session ${shortSessionId(sessionId)}: ${err?.message ?? err}`);
			}
		}
	}

	/* ------------------------------------------------------------ the doorbell */

	/**
	 * Rings arrive in bursts (every append, every lease write is one), so a session has at most one
	 * delivery running and one more to run after it: a ring during a delivery is kept as that one
	 * rerun, which sees whatever the running one read too early to see. Nothing waits on a timer.
	 */
	const delivering = new Set<string>();
	const ringAgain = new Set<string>();
	/**
	 * The bell is never the only way a row arrives, so it may stop ringing: after a delivery that
	 * failed, and past a number of rings no real burst reaches between two ticks. Either way the
	 * session is the tick's until then. This bounds a loop of self-rings that a check above missed;
	 * the timers it would starve include the tick's own.
	 */
	const quietUntilTick = new Set<string>();
	const rungSinceTick = new Map<string, number>();
	function ring(sessionId: string): void {
		if (quietUntilTick.has(sessionId)) return;
		const rung = (rungSinceTick.get(sessionId) ?? 0) + 1;
		rungSinceTick.set(sessionId, rung);
		if (rung > RINGS_PER_TICK) {
			quietUntilTick.add(sessionId);
			log(`doorbell for session ${shortSessionId(sessionId)}: rang ${RINGS_PER_TICK} times since the last tick; left to the tick`);
			return;
		}
		if (delivering.has(sessionId)) {
			ringAgain.add(sessionId);
			return;
		}
		delivering.add(sessionId);
		background
			.deliverSession(sessionId)
			.catch((err: any) => log(`requests for session ${shortSessionId(sessionId)}: ${err?.message ?? err}`))
			.then(() => {
				delivering.delete(sessionId);
				if (ringAgain.delete(sessionId)) ring(sessionId);
			})
			.catch((err: any) => log(`doorbell: ${err?.message ?? err}`));
	}

	/**
	 * The file name is the whole message: `<session>.jsonl` in `requests/` is a row written for it,
	 * `<session>.json` in `leases/` a conversation given back, or taken. Either rings the session.
	 * fs.watch can miss events and is best-effort by design; the tick still delivers, so a watcher
	 * that fails to start, or fails later, is logged and not restarted.
	 */
	const watchers: fs.FSWatcher[] = [];
	function watch(): void {
		if (watchers.length) return;
		const stores: Array<{ sub: "requests" | "leases"; ext: string; kind: "request" | "lease" }> = [
			{ sub: "requests", ext: ".jsonl", kind: "request" },
			{ sub: "leases", ext: ".json", kind: "lease" },
		];
		for (const { sub, ext, kind } of stores) {
			const where = path.join(dir, sub);
			try {
				fs.mkdirSync(where, { recursive: true });
				const watcher = fs.watch(where, (_event, name) => {
					const file = String(name ?? "");
					if (!file.endsWith(ext)) return;
					const note = parseRingNote(`${kind}:${file.slice(0, -ext.length)}`);
					if (note) ring(note.sessionId);
				});
				watcher.on("error", (err) => log(`${sub} watch: ${err?.message ?? err}`));
				watchers.push(watcher);
			} catch (err: any) {
				log(`${sub} watch: ${err?.message ?? err}`);
			}
		}
	}

	triggers = new TriggerRuntime({
		store: new TriggerStore(dir),
		jobStore: scheduler.store,
		getSession: deps.session,
		pollIntervalSecs: deps.config().triggerPollIntervalSecs,
		runTimeoutMs: deps.config().triggerRunTimeoutMs,
		runner: deps.runner,
		dedupFile: path.join(dir, "dedup.json"),
		slots,
		budget: () => budgetState(scheduler.store, deps.config().dailyBudgetUsd, Date.now()),
		inbox: scheduler.inbox,
		hooks: {
			onPromote: promote,
			// A push that injects and runs reaches the host only when no window has its server (host.ts): the inbox.
			onInjectAndRun: (prompt, trigger) => toInbox(prompt, trigger),
			onFinished: (o) => log(`trigger ${o.trigger.traceId.slice(0, 8)} ${o.delivery} ${o.ok ? "ok" : `FAILED (${redact(o.error ?? "")})`}${o.matchedRules.length ? ` matched ${o.matchedRules.length}` : ""}`),
			log: (msg) => log(redact(msg)),
		},
	});

	/** The tools' host for one sub-session: that run's cwd and model, not the process defaults. */
	const toolHostFor = (req: Pick<SubagentRequest, "cwd" | "model" | "thinking" | "builtinTools" | "tools" | "kind" | "parentSessionId">): ToolHost => {
		const held = req.kind === "held";
		const host: ToolHost = {
			scheduler,
			triggers,
			// A job a run makes gets no more built-in tools than that run (createLoopJob trims to them), and no trust of its own.
			// A held turn's session is the conversation it runs in; a loop's run has none.
			session: () => ({ ...deps.session(), sessionId: req.parentSessionId, cwd: req.cwd, model: req.model ?? deps.session().model, thinking: req.thinking ?? deps.session().thinking, builtinTools: req.builtinTools ?? req.tools?.filter((t) => PI_BUILTIN_TOOL_NAMES.includes(t)) ?? deps.session().builtinTools, trusted: false }),
			createJob: (input, scope) => createLoopJob(host, input, scope),
			// The cron_control_plane audit has no session to live in here; /triggers audit shows it instead.
			cronControlAudit: (op, actor, before, after) => {
				const job = after ?? before;
				const id = newId("audit");
				triggers.store.appendAudit({ cwd: req.cwd, type: "cron_control_plane", traceId: id, state: op, sourceLabel: actor, eventLabel: job?.id, summary: job ? `${job.name ?? job.id}: ${job.prompt}` : undefined, details: { before_enabled: before?.enabled, after_enabled: after?.enabled } });
				log(`cron control plane: ${op} by ${actor} ${job?.id ?? ""}`);
				return id;
			},
			// Nobody can approve here: Prompt-class operations are denied fail-closed. A held turn is the
			// conversation's own, so its refusal says where the person was not, not "sub-agent".
			confirmTool: async (_ctx, request, atHop) => controlPlanePreflight({ hop: held ? 0 : Math.max(1, atHop), hasUI: false, held }, request.label),
			refreshBadge: () => undefined,
		};
		return host;
	};

	const riders: Riders<(typeof RUNTIME_RIDERS)[number]> = {
		"stray-leases": (now) => releaseStrayLeases(now),
		"closed-conversations": () => deliverToClosed(),
		"rule-checks": async (now) => { await triggers.tick(now); runtimeRidersRan = true; },
	};
	return {
		scheduler,
		riders,
		tick: () => { runtimeRidersRan = true; return scheduler.tick(); },
		triggers,
		notice,
		notices: () => [...kept],
		ring,
		heldTurn: (sessionId) => {
			const turn = runs.turnIn(sessionId);
			return turn && { runId: turn.runId, label: turn.label };
		},
		customTools: async (req) => {
			const shared = deps.mcpTools();
			// A held turn is the conversation's own turn, as in a window (hop 0, actor "tool"): the
			// tools list and bind as they would there. A loop's run is a sub-agent's.
			const automation = automationTools(req.kind === "held" ? { hop: 0, actor: "tool", parentSessionId: req.parentSessionId, parentCwd: req.parentCwd } : { hop: req.hop, actor: "sub-agent", parentSessionId: req.parentSessionId, parentCwd: req.parentCwd }, toolHostFor(req));
			const taken = new Set([...PI_BUILTIN_TOOL_NAMES, ...shared.map((t) => t.name), ...automation.map((t) => t.name)]);
			const project = req.cwd ? ((await deps.projectMcpTools?.(req.cwd, taken, req.trusted)) ?? []) : [];
			return [...shared, ...project, ...automation];
		},
		start: () => { watch(); },
		stop: async () => {
			for (const w of watchers.splice(0)) w.close();
			await triggers.stop();
			await scheduler.stop();
			// The runs are over; their hooks may still be in flight. Same bounded wait as the
			// interactive path, so a "the run failed" webhook survives the host being told to quit.
			await Promise.all([...runHooks.values()].map((h) => h.drain(3000)));
		},
	};
}
