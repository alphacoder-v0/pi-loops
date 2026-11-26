/**
 * What the always-on host runs (see host.ts for the process shell): the ticker's riders, the loop
 * lanes and the check lanes, wired for a process that has no chat. It runs every loop and
 * checks every rule; a promotion is a request addressed to the conversation that created the rule
 * (src/requests.ts): its holder delivers it, and this process does when it is closed. Control-plane
 * operations by sub-agents are audited into `triggers-audit.jsonl`. Injected so it can be unit-tested.
 */
import * as fs from "node:fs";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { LoopsConfig } from "./config.ts";
import { HookRunner, runEndEvent, runStartEvent } from "./hooks.ts";
import { type McpNotification, PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { redact } from "./redact.ts";
import { keepNotice, parseRingNote, type Notice } from "./host-control-channel.ts";
import type { SubagentRequest, SubagentRunner } from "./runner.ts";
import { type LeaseHolder, LeaseStore, closedConversation, liveHolderPid, procStart, sameHolder } from "./lease.ts";
import { type EngineSinks, laneClaimLive, promotionTarget, promotionView, ruleResultRow, proofOf, sessionFileEntries } from "./engine.ts";
import type { ClaimedRow, Row } from "./requests.ts";
import { type AnswerLanes, createAnswerLanes } from "./answer-lanes.ts";
import { type Answers, conversationFile, createAnswers } from "./answers.ts";
import { ConversationIndex } from "./conversation-rows.ts";
import { type LaneId, checkLane, parseLane } from "./lane.ts";
import { PI_LOOPS_VERSION } from "./version.ts";
import { upgradeHeld } from "./upgrade-hold.ts";
import { type BackgroundExecutor, createBackgroundExecutor } from "./background-executor.ts";
import { RunList } from "./run-list.ts";
import type { OwnerView, SessionSnapshot } from "./job-owner.ts";
import { DEFAULT_RUN_TIMEOUT_MS } from "./loop-run.ts";
import { stamp } from "./schedule.ts";
import { budgetState, jobCounts, runHistory } from "./job-status.ts";
import { createCheckTick } from "./check-tick.ts";
import { SubagentSlots } from "./slots.ts";
import { type LoopJob, type RunRecord, newId } from "./store.ts";
import { RUNTIME_RIDERS, type Rider, type Riders, type TickFacts } from "./ticker.ts";
import { openStores, type Stores } from "./stores.ts";
import { createLoopLanes, createCheckLanes, abortRemovedJobs, type CheckLanes, type LoopLanes } from "./background-executor.ts";
import { gateSources, runClockTick, type TickScope } from "./clock.ts";
import { type GatePolicy, lookCommand } from "./gate.ts";
import { FAILING_AFTER, failurePause } from "./backoff.ts";
import { computeDue } from "./schedule.ts";
import { type ToolHost, automationTools, controlTarget, createLoopJob } from "./tools.ts";
import type { GuardSeats } from "./guard.ts";
import { checkCap, checkSessionDir, promotionToInbox } from "./check-run.ts";
import { withinProject } from "./paths.ts";
import { auditCronFinish, auditCronStart, controlPlanePreflight } from "./triggers.ts";
import { shortSessionId } from "./session-head.ts";
import { DEAD_SESSION_MARKER } from "./convert-v2.ts";
import { EventLog, type RawEvent } from "./events.ts";
import { type DeriveDeps, type InjectDeps, PUSH_WINDOW_MS, type PushDelivery, derivePush, eventsInRows, injectPush, pushTrigger, rawPush } from "./push.ts";

export interface HostRuntimeDeps {
	dir: string;
	/** The stores to use; omitted, this process opens them (a test, or a process with no earlier read). */
	stores?: Stores;
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
	/** pi's sessions directory, where a conversation's file is looked for when no lease names it (`conversationFile`). Absent: only the directories of the files leases name. */
	sessionsRoot?: string;
	/** Is this conversation open in the browser page? Then its pi writes the file, and this process never holds it. */
	pageHolds?: (sessionId: string) => boolean;
	/**
	 * The seats the runner's guard seats its runs in (src/sdk-runner.ts). A held turn's control-plane
	 * call passes `confirmTool` only from a seat in a conversation's lane, where the guard judged it.
	 * Absent: no held turn has a seat, and every such call is refused.
	 */
	guardSeats?: Pick<GuardSeats, "of">;
}

export interface HostRuntime {
	stores: ReturnType<typeof openStores>;
	runs: RunList;
	loops: LoopLanes;
	/** The answer protocol: a person's yes or no, and what this process runs of it. */
	answers: Answers;
	answerLanes: AnswerLanes;
	budget(): ReturnType<typeof budgetState>;
	slotCount(): { inUse: number; limit: number };
	/** Wait up to `ms` for the plain jobs, loops and answers this process started to close. */
	drain(ms: number): Promise<void>;
	riders: Riders<(typeof RUNTIME_RIDERS)[number]>;
	tick(): Promise<void>;
	/** One push as it arrives: stored raw first, then its rows or its delivery. False when it maps to no trigger. */
	receivePush(server: string, delivery: PushDelivery, n: McpNotification, cwd?: string, inject?: boolean): boolean;
	/** At start: the rows of the last five minutes' pushes that a crash kept from being written (after `clock.json`'s cursor). Returns how many lanes got one. */
	rederivePushes(subAgent: (server: string) => boolean): number;
	/** The tools a sub-session started by this host gets (its cwd and model, not the host's). */
	customTools: (req: SubagentRequest) => Promise<ToolDefinition<any, any>[]>;
	/** What a control-plane call would change, for the runner's guard (`GuardDeps.controlTarget`, src/tools.ts `controlTarget`). */
	controlTarget(tool: string, input: unknown, cwd: string | undefined): string | undefined;
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
	const failingSaid = new Map<string, string>();
	const notice = (text: string, cwd?: string) => {
		noticeSeq = keepNotice(kept, noticeSeq, text, cwd, Date.now());
	};
	const stores = deps.stores ?? openStores(dir, log);
	// Audit writes are best-effort — a failed write never fails a trigger; say so once per distinct error.
	let persistenceSaid: string | undefined;
	stores.rules.onPersistenceError ??= (message) => {
		if (message === persistenceSaid) return;
		persistenceSaid = message;
		log(redact(message));
	};
	const leases = new LeaseStore(dir);
	const requests = stores.requests;
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
	/** The runs that are going in this process: the loops' runs and the held turns, one list. */
	const runs = new RunList();
	/** What this process does to the queue of a closed conversation (src/background-executor.ts). Made below, once the stores are there. */
	let background: BackgroundExecutor;
	/** A plain job the host may fire: a conversation pi-loops knows the file of, that nobody holds and the page does not have open. */
	const canHold = (sessionId: string | undefined): boolean => !(sessionId !== undefined && deps.pageHolds?.(sessionId)) && closedConversation(leases, sessionId);
	/** What this process's tools see: every loop runs here, and a plain job whose conversation is closed. */
	const ownerView: OwnerView = { holdsOwn: false, hostRuns: (sessionId) => canHold(sessionId) };

	/** The engine's sinks here: the jobs the rows name, the inbox for dead letters, the audit. */
	const sinks = (): EngineSinks => ({ jobs: { exists: (id) => stores.jobs.load().some((j) => j.id === id), enabled: (id) => stores.jobs.load().find((j) => j.id === id)?.enabled ?? false, goalActive: () => false, paused: () => upgradeHeld(dir) }, inbox: stores.inbox, audit: stores.rules, ledger: stores.jobs, counts: (id) => jobCounts(stores.history().get(id), stores.clock.read().jobs[id]?.cleared), self: createdBy });

	/* ------------------------------------------------------ lifecycle hooks */

	/**
	 * hooks.toml, fired around the runs the host starts: `run_start` and `run_end` (docs/hooks.md).
	 * One runner per run — the host has no project of its own, so each run brings the project the
	 * rules and the payload are about.
	 */
	const runHooks = new Map<string, HookRunner>();

	function hookRunnerFor(job: LoopJob, runId: string, opts: { projectHooks: boolean } = { projectHooks: true }): HookRunner | undefined {
		// A model can pick a job's cwd (`cron_create` takes one) and nobody is here to answer a trust
		// prompt, so a project's own hooks.toml needs pi's saved trust for that exact directory —
		// the same bar the host puts in front of a project's MCP servers. A job that is gone has no
		// project to trust: only the user's own hooks.
		const trusted = opts.projectHooks && !!deps.isProjectTrusted?.(job.cwd);
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
				log(`hooks: ignoring ${runner.hooks.length - kept.length} project hook rule(s) in ${job.cwd}: ${opts.projectHooks ? "pi has not trusted that directory" : "the job is gone"}`);
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

	const toInbox = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }, forSession?: string) => {
		// The check decided this result's finding already (`runCheck`'s inbox); a push with no rule did not.
		await promotionToInbox(stores.inbox, stores.rules, content, trigger, { cwd: trigger.cwd ?? "", sessionId: forSession });
		return "inbox" as const;
	};

	background = createBackgroundExecutor({
		dir,
		requests,
		leases,
		jobs: stores.jobs,
		runsOf: (id) => stores.clock.read().jobs[id]?.runs ?? 0,
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
			stores.rules.appendAudit({ cwd: row.payload?.cwd ?? "", type: "trigger_promotion", traceId: row.id, state: "appended", details: { session_id: into.sessionId } });
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
		// A closed conversation's answers: met where its queue is delivered, before a conversation that is gone is buried.
		answers: (sessionId) => answerLanes.drain(parseLane(sessionId)!, Date.now()),
		log,
	});
	/** `run_start` of a loop's run, a scheduled one or an answer's: its audit line, its log line, its hooks. */
	const loopStarted = (job: LoopJob, row: ClaimedRow): void => {
		// The latest slot the row owes, as main named the slot it fired: a slot counted onto a waiting row is the one that runs.
		auditCronStart(stores.rules, job, row.run.id, row.collapsed_slot ?? row.payload?.slot);
		log(`loop ${job.name ?? job.id}: run ${row.run.id.slice(0, 12)} started`);
		const hooks = hookRunnerFor(job, row.run.id);
		if (hooks) void hooks.fire(runStartEvent(job, row.run.id)).catch((err: any) => log(`hooks: ${redact(err?.message ?? String(err))}`));
	};
	/** `run_end` of a loop's run, a scheduled one or an answer's (C2). */
	const loopFinished = (record: RunRecord): void => {
		auditCronFinish(stores.rules, { id: record.jobId, cwd: record.cwd }, record, !!record.aborted);
		log(`loop ${record.jobName ?? record.jobId}: ${record.ok ? "ok" : record.stoppedBy === "person" ? `stopped by you (from ${record.stoppedFrom === "page" ? "the page" : "a terminal"})` : `FAILED (${redact(record.error ?? "")})`} · ${record.findings} finding(s)${record.usage?.cost ? ` · $${record.usage.cost.toFixed(3)}` : ""}`);
		const hooks = runHooks.get(record.runId);
		if (hooks) void hooks.fire(runEndEvent({ id: record.jobId, name: record.jobName, cwd: record.cwd } as LoopJob, record)).then(() => runHooks.delete(record.runId), () => runHooks.delete(record.runId));
		if (!record.ok) {
			const job = stores.book().jobs.find((candidate) => candidate.id === record.jobId);
			if (job && !job.stateful && (stores.history().get(job.id)?.streak ?? 0) >= FAILING_AFTER) notice(`${job.name ?? job.id} has failed ${stores.history().get(job.id)?.streak} times in a row; backing off (last: ${record.error ?? "unknown"})`, job.cwd);
		}
	};
	/**
	 * C2 of an answer's closing in a loop lane: `run_end`. A run closed by the process that ran it has
	 * the hook runner its `run_start` made; one closed after a restart (F2) has none, so it is made here
	 * for the loop the lane names, from hooks.toml as the loop's other runs read it. A record whose
	 * `jobId` is not that loop's fires nothing: the run log is read, and a record in it names any job.
	 */
	const answerRunEnd = (record: RunRecord, lane: LaneId): void => {
		const parsed = parseLane(lane);
		const jobId = parsed?.kind === "loop" ? parsed.id.slice(1) : undefined;
		if (jobId === undefined || record.jobId !== jobId) {
			log(`answer ${record.runId.slice(0, 12)}: run_end not fired, the record names ${record.jobId} and the lane is ${lane}`);
			return;
		}
		if (runHooks.has(record.runId)) return loopFinished(record);
		// A record written for a process that died names no job's name: the loop's own, as its hooks know it.
		const job = stores.book().jobs.find((candidate) => candidate.id === jobId);
		const named = record.jobName === undefined && job?.name !== undefined ? { ...record, jobName: job.name } : record;
		// A removed job's record names a cwd nobody vouches for now: its run_end loads no project hooks.
		hookRunnerFor(job ?? ({ id: jobId, name: record.jobName, cwd: record.cwd } as LoopJob), record.runId, { projectHooks: job !== undefined });
		loopFinished(named);
	};
	const loopLog = (message: string, level?: "info" | "warning", job?: Pick<LoopJob, "cwd">): void => { log(redact(message)); if (level !== "info") notice(message, job?.cwd); };
	/** What arrived from outside, stored before anything reads it: a loop's or a rule's gate reading. */
	const events = new EventLog(dir, "background", { keep: () => eventsInRows(stores.requests) });
	/** A gate's command is judged as an unattended run's is: this loops directory, and the allowlist the guard reads. */
	const gatePolicy = (): GatePolicy => ({ loopsDir: dir, allowCommands: deps.config().allowCommands });
	// One for the process: a look whose time could not be written is held here for its minute.
	const loopGates = gateSources({ look: (command, cwd) => lookCommand(command, { cwd, policy: gatePolicy() }), store: (source, raw) => events.append(source, raw).id, write: (job, last) => stores.clock.noteLook(job, last) });
	const loops: LoopLanes = createLoopLanes({
		stores,
		events,
		runs,
		runner: deps.runner,
		session: deps.session,
		hop: 0,
		holder: () => ({ pid: process.pid, procStart: ownStart }),
		engine: sinks,
		slots,
		budgetCap: () => deps.config().dailyBudgetUsd,
		cwdExists: fs.existsSync,
		sinks: {
			started: loopStarted,
			finished: loopFinished,
			filed: () => undefined,
			retired: (job, reason) => {
				stores.rules.appendAudit({ cwd: job.cwd, type: "cron_control_plane", traceId: newId("audit"), state: "remove", sourceLabel: "clock", eventLabel: job.id, summary: `${job.name ?? job.id}: ${reason}` });
			},
			log: loopLog,
		},
	});
	/** A project's check lane: its pushes (and, in M8.3b, its periodic checks), each one run with `runCheck`. */
	const checks: CheckLanes = createCheckLanes({
		requests: stores.requests,
		runs,
		slots,
		allRuns: () => stores.jobs.allRuns(),
		events,
		rules: stores.rules,
		budget: () => budgetState(stores.jobs, deps.config().dailyBudgetUsd, Date.now()),
		check: () => ({
			runner: deps.runner,
			rules: stores.rules,
			jobs: stores.jobs,
			inbox: stores.inbox,
			clock: stores.clock,
			promote: (content, trigger, forSession) => promote(content, trigger, forSession),
			session: deps.session(),
			hop: 0,
			runTimeoutMs: deps.config().triggerRunTimeoutMs,
			log: (message) => log(redact(message)),
			now: Date.now,
		}),
		engine: sinks,
		holder: () => ({ pid: process.pid, procStart: ownStart }),
		log: (message) => log(redact(message)),
	});
	/** Each project's periodic check, as a row of its check lane (src/check-tick.ts): what `rule-checks` runs at each tick. */
	const checkTick = createCheckTick({
		rules: stores.rules,
		requests: stores.requests,
		clock: stores.clock,
		events,
		gatePolicy,
		pollIntervalSecs: () => deps.config().triggerPollIntervalSecs,
		history: () => runHistory(stores.jobs.allRuns()),
		createdBy: () => createdBy(),
		log: (message) => log(redact(message)),
	});
	/** What a push becomes here (src/push.ts): its rows, or its delivery into a chat. */
	const pushDeps: DeriveDeps = { requests: stores.requests, events, rules: stores.rules, runs: () => stores.jobs.allRuns(), createdBy: () => createdBy() };
	/**
	 * A stored push's rows are written: the clock says so before anything else can run (design 3.4).
	 * A write that fails is logged; the next start derives that push once more, or, when no cursor was
	 * ever written, none.
	 */
	const derived = (seq: number): void => {
		try { stores.clock.derivePushed(seq); }
		catch (error) { log(`push #${seq} derived, but clock.json could not say so: ${error instanceof Error ? error.message : String(error)}`); }
	};
	const injectDeps: InjectDeps = {
		events,
		audit: stores.rules,
		budget: () => budgetState(stores.jobs, deps.config().dailyBudgetUsd, Date.now()),
		promote: (content, trigger) => promote(content, trigger),
		// A push that injects and runs reaches pi-loops in the background only when no window has its server (host.ts): the inbox.
		injectAndRun: (prompt, trigger) => toInbox(prompt, trigger),
		log: (message) => log(redact(message)),
		now: Date.now,
	};
	/** A check lane's transcripts: where its checks keep them (`checkSessionDir`, the one source). */
	const checkDir = (cwd: string): string => checkSessionDir(stores.jobs, cwd);
	/** The answer protocol over this directory's stores (src/answers.ts). */
	const answers: Answers = createAnswers({
		inbox: stores.inbox,
		requests,
		jobs: stores.jobs,
		audit: stores.rules,
		sessionFile: conversationFile(leases, new ConversationIndex(deps.sessionsRoot, undefined, () => leases.list().flatMap((l) => (l.sessionFile ? [l.sessionFile] : [])))),
		entries: (file) => (fs.existsSync(file) ? sessionFileEntries(file) : undefined),
		checkSessionDir: checkDir,
		checkLaneOf: checkLane,
		runEnd: answerRunEnd,
		self: createdBy,
		now: Date.now,
		log,
	});
	/**
	 * A transcript a live pi other than this process has open: a window or the page holds the
	 * conversation of its session id. The lease this process took for an answer's turn there is not
	 * such a pi. No file is read.
	 */
	const transcriptHeld = (id: string): boolean => {
		if (parseLane(id)?.kind !== "conversation") return false;
		if (deps.pageHolds?.(id)) return true;
		const holder = liveHolderPid(leases, id) === undefined ? undefined : leases.read(id)?.holder;
		return !!holder && !sameHolder(holder, me());
	};
	const answerLanes: AnswerLanes = createAnswerLanes({
		answers,
		stores,
		runs,
		runner: deps.runner,
		slots,
		session: deps.session,
		hop: 0,
		holder: () => ({ pid: process.pid, procStart: ownStart }),
		budgetCap: () => deps.config().dailyBudgetUsd,
		cwdExists: fs.existsSync,
		transcriptHeld,
		checkSessionDir: checkDir,
		// The cap of a check's answer is the check's own, from the same function (`checkCap`).
		checkCap: (cwd) => checkCap(cwd, stores.rules.load().filter((r) => r.enabled && !r.proposed && withinProject(r.cwd, cwd)), deps.config().triggerRunTimeoutMs),
		conversations: background.conversations,
		started: loopStarted,
		log: loopLog,
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
		const running = new Set(runs.all().map((run) => run.runId));
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
	/** A row written into a check lane (a window's `/triggers run`, a push): run now, one drain of a lane at a time, as its own writes ring again. */
	const checkDraining = new Set<LaneId>();
	function drainCheckLane(lane: LaneId): void {
		if (checkDraining.has(lane)) return;
		checkDraining.add(lane);
		checks.drain(lane, Date.now())
			.catch((error) => log(`check lane ${lane}: ${error instanceof Error ? error.message : String(error)}`))
			.finally(() => checkDraining.delete(lane))
			.catch((error) => log(`check lane ${lane}: ${error instanceof Error ? error.message : String(error)}`));
	}
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
					const lane = kind === "request" ? parseLane(file.slice(0, -ext.length)) : undefined;
					if (lane?.kind === "check") return drainCheckLane(lane.id);
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

	/** Whether `session` has a seat of the runner's guard in a conversation's lane. */
	const conversationSeat = (session: object | undefined): boolean => {
		const seat = deps.guardSeats?.of(session);
		return seat !== undefined && parseLane(seat.lane)?.kind === "conversation";
	};

	/** The tools' host for one sub-session: that run's cwd and model, not the process defaults. */
	const toolHostFor = (req: Pick<SubagentRequest, "cwd" | "model" | "thinking" | "builtinTools" | "tools" | "kind" | "parentSessionId">): ToolHost => {
		const held = req.kind === "held";
		const host: ToolHost = {
			stores,
			runs,
			rules: stores.rules,
			pollSecs: () => deps.config().triggerPollIntervalSecs,
			owner: () => ownerView,
			// A job a run makes gets no more built-in tools than that run (createLoopJob trims to them), and no trust of its own.
			// A held turn's session is the conversation it runs in; a loop's run has none.
			session: () => ({ ...deps.session(), sessionId: req.parentSessionId, cwd: req.cwd, model: req.model ?? deps.session().model, thinking: req.thinking ?? deps.session().thinking, builtinTools: req.builtinTools ?? req.tools?.filter((t) => PI_BUILTIN_TOOL_NAMES.includes(t)) ?? deps.session().builtinTools, trusted: false }),
			createJob: (input, scope) => createLoopJob(host, input, scope),
			// The cron_control_plane audit has no session to live in here; /triggers audit shows it instead.
			cronControlAudit: (op, actor, before, after) => {
				const job = after ?? before;
				const id = newId("audit");
				stores.rules.appendAudit({ cwd: req.cwd, type: "cron_control_plane", traceId: id, state: op, sourceLabel: actor, eventLabel: job?.id, summary: job ? `${job.name ?? job.id}: ${job.prompt}` : undefined, details: { before_enabled: before?.enabled, after_enabled: after?.enabled } });
				log(`cron control plane: ${op} by ${actor} ${job?.id ?? ""}`);
				return id;
			},
			// A held turn at hop 0 is the conversation's own unattended turn: from a seat in the
			// conversation's lane, the guard asked a person in /inbox before the call could run (design 4,
			// item 26), so a call that reaches here carries their yes. With no such seat nobody was asked.
			// Every other prompt-class operation is denied fail-closed, a held turn's in words that say
			// where the person was not, not "sub-agent".
			confirmTool: async (ctx, request, atHop) => (held && atHop === 0 && conversationSeat(ctx?.sessionManager) ? undefined : controlPlanePreflight({ hop: held ? 0 : Math.max(1, atHop), hasUI: false, held }, request.label)),
			refreshBadge: () => undefined,
			// A held turn is one pi-loops started, with nobody to see a card: `cron_create` creates at once and `new_trigger` proposes (design 2.5).
			scheduledTurn: () => held,
		};
		return host;
	};

	const plainRuns = new Set<Promise<void>>();
	function firePlain(now: number): void {
		const book = stores.book();
		const budget = budgetState(stores.jobs, deps.config().dailyBudgetUsd, now);
		for (const job of book.jobs) {
			if (job.stateful || !job.sessionId || !canHold(job.sessionId) || !job.enabled) continue;
			let due: number | undefined;
			try { due = computeDue({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), due: book.clock.jobs[job.id]?.slot ? Date.parse(book.clock.jobs[job.id].slot!) : undefined, fired: book.clock.jobs[job.id]?.fired ? Date.parse(book.clock.jobs[job.id].fired!) : undefined }, now); }
			catch (error) { log(`cron ${job.name ?? job.id}: ${error instanceof Error ? error.message : String(error)}`); continue; }
			if (due === undefined && !background.owes(job, now)) continue;
			if (due !== undefined && budget.over) continue;
			const history = stores.history().get(job.id);
			const streak = history?.streak ?? 0;
			const failedAt = history?.failed?.at;
			if (streak >= FAILING_AFTER && failedAt && now - Date.parse(failedAt) < failurePause(streak)) continue;
			const permit = slots.acquire();
			if (!permit) continue;
			const dueAt = due === undefined ? undefined : stamp(due);
			const task = background.fire(job as LoopJob, dueAt, permit, async () => {
				if (dueAt === undefined) return "fired";
				const heldEpoch = leases.read(job.sessionId!)?.epoch;
				if (heldEpoch === undefined || !leases.holds(job.sessionId!, me(), heldEpoch)) return "lost";
				const scope: TickScope = { kind: "background", self: createdBy(), startedAt: tickerFacts.startedAt, tickMs: tickerFacts.tickMs, catchUp: deps.config().cronCatchUp, budgetOver: false, mine: (candidate) => candidate.id === job.id ? { kind: "plain", epoch: heldEpoch } : undefined };
				const sources = { book: () => stores.book(), history: () => stores.history(), requests: stores.requests, clock: stores.clock, proof: (lane: string) => { const file = leases.read(lane)?.sessionFile; return proofOf(lane, () => file ? sessionFileEntries(file) : [], () => stores.jobs.allRuns()); }, cwdExists: fs.existsSync, heldEpoch: (sessionId: string) => leases.holds(sessionId, me(), heldEpoch) ? leases.read(sessionId)?.epoch : undefined };
				await runClockTick(scope, sources, { jobs: { remove: (id) => stores.jobs.remove(id), disable: (id, disabled) => stores.jobs.disable(id, disabled) }, log: (message) => log(message) }, now);
				return stores.book().clock.jobs[job.id]?.slot === dueAt ? "fired" : "lost";
			}, now);
			const tracked = task.finally(() => { permit.release(); plainRuns.delete(tracked); }).catch((error) => log(`cron ${job.name ?? job.id}: ${error instanceof Error ? error.message : String(error)}`));
			plainRuns.add(tracked);
		}
	}
	let lastDeadSessionScan = 0;
	let tickerFacts: TickFacts = { startedAt: Date.now(), tickMs: 30_000 };
	// While the upgrade's pause holds (src/upgrade-hold.ts), nothing automated starts: no clock pass (a
	// gate's command included), rule check, answer, lane run or delivery into a closed conversation.
	const unlessPaused = (rider: Rider): Rider => (now, facts) => (upgradeHeld(dir) ? undefined : rider(now, facts));
	const riders: Riders<(typeof RUNTIME_RIDERS)[number]> = {
		"stray-leases": (now) => releaseStrayLeases(now),
		"closed-conversations": unlessPaused(() => deliverToClosed()),
		"rule-checks": unlessPaused((now) => checkTick.tick(now)),
		"removed-jobs": () => { abortRemovedJobs(runs, (id) => stores.jobs.load().some((job) => job.id === id), log); },
		"dead-sessions": async (now) => {
			if (!deps.sessionExists || now - lastDeadSessionScan < 10 * 60_000) return;
			lastDeadSessionScan = now;
			for (const job of stores.jobs.load()) {
				if (!job.enabled || job.stateful || !job.sessionId || deps.sessionExists(job.sessionId)) continue;
				const why = `disabled: session ${shortSessionId(job.sessionId)} ${DEAD_SESSION_MARKER}`;
				await stores.jobs.disable(job.id, { code: "session-gone", why, at: stamp(now) });
				log(`cron ${job.name ?? job.id}: disabled, its session ${shortSessionId(job.sessionId)} no longer exists`);
			}
		},
		clock: async (now, facts) => {
			tickerFacts = facts;
			if (upgradeHeld(dir)) return;
			const sources = {
				book: () => stores.book(), history: () => stores.history(), requests: stores.requests, clock: stores.clock,
				proof: (lane: string) => {
					const file = lane.startsWith("@") ? undefined : leases.read(lane)?.sessionFile;
					return proofOf(lane, () => file ? sessionFileEntries(file) : [], () => stores.jobs.allRuns());
				},
				cwdExists: fs.existsSync,
				heldEpoch: (sessionId: string) => leases.holds(sessionId, me()) ? leases.read(sessionId)?.epoch : undefined,
				// One liveness with the loop lanes and the answer lanes: an `ans-` claim of this process holds nothing once its run left the list.
				claimLive: (row: ClaimedRow) => laneClaimLive(row, { pid: process.pid, procStart: ownStart }, (runId) => runs.get(runId) !== undefined),
				// A loop's gate (design 3.3): looked at in the loop's directory, its opening reading stored first.
				gate: loopGates,
			};
			const scope: TickScope = { kind: "background", self: createdBy(), startedAt: facts.startedAt, tickMs: facts.tickMs, catchUp: deps.config().cronCatchUp, budgetOver: budgetState(stores.jobs, deps.config().dailyBudgetUsd, now).over, mine: (job) => job.stateful ? { kind: "loop" } : undefined };
			await runClockTick(scope, sources, { jobs: { remove: (id) => stores.jobs.remove(id), disable: (id, disabled) => stores.jobs.disable(id, disabled) }, caughtUp: (job) => log(`loop ${job.name ?? job.id}: catching up a missed tick`), log: (message, level, job) => { log(redact(message)); if (level !== "info") notice(message, job?.cwd); } }, now);
			firePlain(now);
		},
		// Before the loop lanes: an answer E4 starts here holds its lane, so a slot due beside it is skipped as an overlap in this tick.
		answers: unlessPaused((now) => answerLanes.tick(now)),
		"check-lanes": unlessPaused((now) => checks.drainAll(now)),
		"loop-lanes": unlessPaused((now) => loops.drainAll(now)),
		notices: (now, facts) => {
			const budget = budgetState(stores.jobs, deps.config().dailyBudgetUsd, now);
			const day = stamp(now).slice(0, 10);
			if (budget.over && budgetSaid !== day) {
				budgetSaid = day;
				const message = `today's automation has cost $${budget.spent.toFixed(2)} of the $${budget.cap.toFixed(2)} budget; dispatching is paused until tomorrow or a higher [limits] daily_budget_usd`;
				log(message); notice(message);
			}
			for (const job of stores.book().jobs) {
				if (!job.stateful) continue;
				const history = stores.history().get(job.id);
				const failed = history?.failed;
				if (!failed || Date.parse(failed.at) <= facts.startedAt || failingSaid.get(job.id) === failed.at || history.streak < FAILING_AFTER) continue;
				failingSaid.set(job.id, failed.at);
				const message = `${job.name ?? job.id} has failed ${history.streak} times in a row; backing off (last: ${failed.error})`;
				log(redact(message)); notice(message, job.cwd);
			}
		},
	};
	return {
		stores,
		runs,
		loops,
		answers,
		answerLanes,
		budget: () => budgetState(stores.jobs, deps.config().dailyBudgetUsd, Date.now()),
		slotCount: () => ({ inUse: slots.inUseCount, limit: slots.limit }),
		drain: async (ms) => {
			const deadline = Date.now() + ms;
			while (plainRuns.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...plainRuns]), new Promise((resolve) => setTimeout(resolve, 25))]);
			await loops.settle(Math.max(0, deadline - Date.now()));
			await checks.settle(Math.max(0, deadline - Date.now()));
			await answerLanes.settle(Math.max(0, deadline - Date.now()));
		},
		riders,
		tick: async () => {
			const now = Date.now();
			const facts = { startedAt: tickerFacts.startedAt, tickMs: tickerFacts.tickMs };
			for (const name of RUNTIME_RIDERS) {
				try { await riders[name](now, facts); }
				catch (error) { log(`tick: ${name} failed: ${error instanceof Error ? error.message : String(error)}`); }
			}
		},
		/**
		 * One push as it arrives (design 3.4, raw first): appended to `events.jsonl` before anything maps
		 * it, then a row in each project's check lane (`sub_agent`), or put in a chat (`inject_*`, unless
		 * a window that has the server does it: `inject` false). `cwd` is a project's own server's project.
		 * Returns false when the push maps to no trigger (a custom one with no dedup key): it stays in the log.
		 */
		receivePush: (server: string, delivery: PushDelivery, n: McpNotification, cwd?: string, inject = true): boolean => {
			let event: RawEvent;
			try { event = events.append(`mcp:${server}`, rawPush(n), { ...(cwd ? { project: cwd } : {}), delivery }); }
			catch (error) {
				log(`push from ${server} not acted on: it could not be stored first (${error instanceof Error ? error.message : String(error)})`);
				return true;
			}
			const stored = pushTrigger(event);
			if (!stored) return false;
			const trigger = cwd ? { ...stored, cwd } : stored;
			if (delivery === "sub_agent") {
				const lanes = derivePush(pushDeps, event, trigger, Date.now());
				derived(event.seq);
				for (const lane of lanes) {
					checks.drain(lane, Date.now()).catch((error) => log(`check lane ${lane}: ${error instanceof Error ? error.message : String(error)}`));
				}
				return true;
			}
			if (!inject) return true;
			injectPush(injectDeps, event, trigger, delivery)
				.then((outcome) => { if (outcome) log(`trigger ${trigger.traceId.slice(0, 8)} ${delivery} ok`); })
				.catch((error) => log(`trigger ${trigger.traceId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
			return true;
		},
		/**
		 * At start: the pushes of the last five minutes after the last one whose rows were written
		 * (`clock.json` `pushes`), so a crash kept their rows from being written: those its server checked
		 * (the event says so; `subAgent` answers for an event stored before it did), each in the project the
		 * event names, or in every project with rules. A push whose rows were written is never derived
		 * again, whatever became of them.
		 */
		rederivePushes: (subAgent: (server: string) => boolean): number => {
			let queued = 0;
			const now = Date.now();
			const cursor = stores.clock.pushesDerived();
			const last = events.lastSeq();
			// No cursor: the first start of this version, or a clock.json that was lost. A cursor past the
			// last number: events.seq and the log were removed, and numbers start again. What is stored was
			// derived by a process before it, or never will be: a push is lost before it runs twice.
			if (cursor === undefined || cursor > last) {
				derived(last);
				return 0;
			}
			// By the number each event got when it was stored: neither a rotation's copy nor a wall clock changes it.
			for (const event of events.after(cursor, now - PUSH_WINDOW_MS)) {
				if (event.receiver.kind !== "background" || !event.source.startsWith("mcp:")) continue;
				// What its server said when it arrived; an event stored before that was kept is a user-level server's, looked up by name.
				if (event.delivery !== undefined ? event.delivery !== "sub_agent" : event.project !== undefined || !subAgent(event.source.slice("mcp:".length))) continue;
				const trigger = pushTrigger(event);
				if (!trigger) continue;
				queued += derivePush(pushDeps, event, trigger, now, true).length;
				derived(event.seq);
			}
			return queued;
		},
		notice,
		notices: () => [...kept],
		ring,
		heldTurn: (sessionId) => {
			const turn = runs.turnIn(sessionId);
			return turn && { runId: turn.runId, label: turn.label };
		},
		controlTarget: (tool, input, cwd) => controlTarget({ stores, rules: stores.rules }, tool, input, cwd ?? ""),
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
			await answerLanes.stop(5_000);
			await loops.stop(5_000);
			await checks.stop(5_000);
			for (const run of runs.all()) run.ctrl.abort();
			await Promise.race([Promise.allSettled([...plainRuns]), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
			// A held turn that claimed its row while the loops stopped is in the list only now: stopped too.
			for (const run of runs.all()) run.ctrl.abort();
			// The runs are over; their hooks may still be in flight. Same bounded wait as the
			// interactive path, so a "the run failed" webhook survives the host being told to quit.
			await Promise.all([...runHooks.values()].map((h) => h.drain(3000)));
		},
	};
}
