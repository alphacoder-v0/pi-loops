/**
 * What the always-on host runs (see host.ts for the process shell): the same LoopScheduler and
 * TriggerRuntime as the extension, wired for a process that has no chat. It runs every loop and
 * checks every rule; a promotion is a request addressed to the conversation that created the rule
 * (src/requests.ts): its holder delivers it, and this process does when it is closed. Control-plane
 * operations by sub-agents are audited into `triggers-audit.jsonl`. Injected so it can be unit-tested.
 */
import * as fs from "node:fs";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { LoopsConfig } from "./config.ts";
import { HookRunner, runEndEvent, runStartEvent } from "./hooks.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { redact } from "./redact.ts";
import { keepNotice, parseRingNote, type Notice } from "./host-control-channel.ts";
import type { RunnerResult, SubagentRequest, SubagentRunner } from "./runner.ts";
import { type LeaseHolder, LeaseStore, closedConversation, liveHolderPid, procStart, sameHolder } from "./lease.ts";
import { type EngineSinks, type Executor, type ExecutorView, bury, changesSomething, conversationHas, decideDrain, drain, modeOf, promotionTarget, ruleResultRow, sessionFileEntries } from "./engine.ts";
import { RequestStore } from "./requests.ts";
import { PI_LOOPS_VERSION } from "./version.ts";
import type { PresenceEntry } from "./presence.ts";
import { DEFAULT_RUN_TIMEOUT_MS, type HeldSession, LoopScheduler, type PlainJobLeases, type SessionSnapshot } from "./scheduler.ts";
import { stamp } from "./schedule.ts";
import { SubagentSlots } from "./slots.ts";
import { type LoopJob, newId } from "./store.ts";
import { type ToolHost, automationTools, createLoopJob } from "./tools.ts";
import { TriggerRuntime } from "./trigger-runtime.ts";
import { auditCronFinish, auditCronStart, TriggerStore, controlPlanePreflight } from "./triggers.ts";

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
	/** Every tick, before the rules are checked (the legacy fence lives here). */
	onTick?: (now: number) => void;
}

export interface HostRuntime {
	scheduler: LoopScheduler;
	triggers: TriggerRuntime;
	/** The tools a sub-session started by this host gets (its cwd and model, not the host's). */
	customTools: (req: SubagentRequest) => Promise<ToolDefinition<any, any>[]>;
	/** Say a warning to the windows of `cwd`'s project (or every window, without one); see `notices`. */
	notice(text: string, cwd?: string): void;
	/** The latest warnings, for the snapshot a window fetches on each tick. */
	notices(): Notice[];
	/** The doorbell: deliver what is queued for a closed conversation now, not on the next tick. Returns at once. */
	ring(sessionId: string): void;
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
	const leases = new LeaseStore(dir);
	const requests = new RequestStore(dir);
	/** The host as a lease holder: it holds a closed conversation for one piece of work, then lets go. */
	const ownStart = procStart(process.pid);
	const me = (busy?: LeaseHolder["busy"]): LeaseHolder => ({ kind: "host", pid: process.pid, instance: "host", procStart: ownStart, acquiredAt: stamp(), pushServers: [], ...(busy ? { busy } : {}) });
	const fileMtime = (file: string | undefined): number | undefined => {
		if (!file) return undefined;
		try {
			return fs.statSync(file).mtimeMs;
		} catch {
			return undefined; // gone: nothing for the quiet guard to remember
		}
	};
	/** Open in a pi-loops 0.22 window, which fires its plain jobs without a lease: never the host's to hold. */
	let legacyOpen = (_sessionId: string): boolean => false;
	const heldLeases: PlainJobLeases = {
		heldEpoch: (sessionId) => (leases.holds(sessionId, me()) ? leases.read(sessionId)?.epoch : undefined),
		holderOf: (sessionId) => liveHolderPid(leases, sessionId),
		acquireForWork: (sessionId, runId, jobId) => {
			if (legacyOpen(sessionId)) return undefined;
			const got = leases.acquireForHost(sessionId, me({ runId, jobId, since: stamp() }));
			if (!("lease" in got) || !got.lease.sessionFile) return undefined;
			return { sessionId, epoch: got.lease.epoch, sessionFile: got.lease.sessionFile, cwd: got.lease.cwd };
		},
		// With the epoch it took, and the mtime it left: see LeaseStore.release.
		releaseWork: (sessionId, epoch) => void leases.release(sessionId, me(), { epoch, fileMtimeMs: fileMtime(leases.read(sessionId)?.sessionFile) }),
	};
	/** A conversation a live window holds (whose file pi may not have written yet), or whose file is still there. */
	const knownConversation = (sessionId: string): boolean => {
		if (liveHolderPid(leases, sessionId) !== undefined) return true;
		const file = leases.read(sessionId)?.sessionFile;
		return !!file && fs.existsSync(file);
	};
	/** A plain job the host may fire: a conversation pi-loops knows the file of, that nobody holds. */
	const canHold = (sessionId: string | undefined): boolean => closedConversation(leases, sessionId, legacyOpen);

	/** The engine's sinks here: the jobs the rows name, the inbox for dead letters, the audit. */
	const sinks = (): EngineSinks => ({ jobs: { exists: (id) => scheduler.store.load().some((j) => j.id === id), goalActive: () => false }, inbox: scheduler.inbox, audit: triggers.store });

	/**
	 * The held turns this process is in, by session: the run (the lease's `busy.runId`), when it
	 * started, and whether the runner has the file (`writing`). A stop may name the run from the turn's
	 * own first drain on; nothing is appended beside the runner once it writes.
	 */
	const turnOpen = new Map<string, { requestId: string; startedAt: string; writing: boolean }>();
	/**
	 * The engine's executor while this process holds a closed conversation: an `append` row is written
	 * into the file at once, each one once (the `[Trigger <id>]` already in the file is the check).
	 * No attended row runs here; a turn row is not admitted yet either (held turns move onto rows in a
	 * later stage), so it waits for a window instead of failing here. While a turn of this process runs
	 * in the conversation its runner is writing the file, so nothing is appended beside it: only a stop
	 * or a cancel acts, and the inputs wait.
	 */
	const heldView = (sessionId: string): ExecutorView => {
		const open = turnOpen.get(sessionId);
		const writing = open?.writing ?? false;
		return { kind: "held", admits: (row) => !writing && row.mode !== "attended" && row.wake !== "turn" && modeOf(row.kind, row.source, row.wake) === row.mode, idle: !writing, running: open && { requestId: open.requestId, startedAt: open.startedAt }, inFlight: new Set(), connected: () => true, producerAlive: () => true, mine: () => false };
	};
	function heldExecutor(held: HeldSession): Executor {
		const sm = SessionManager.open(held.sessionFile);
		return {
			holds: (sessionId) => leases.holds(sessionId, me(), held.epoch),
			entries: () => ({ has: (id) => conversationHas(sm.getEntries(), id) }),
			view: () => heldView(held.sessionId),
			append: (row) => {
				sm.appendCustomMessageEntry("pi-loops:trigger", row.payload?.text ?? "", true);
				// Written into a closed conversation, so no screen showed it: the audit row is what the
				// "since you last looked" line and the status page count (src/seen.ts).
				triggers.store.appendAudit({ cwd: row.payload?.cwd ?? "", type: "trigger_promotion", traceId: row.id, state: "appended", details: { session_id: held.sessionId } });
				// And said in the project's open windows: the person is likely in another conversation of
				// it now, where a rule's result used to land (0.22), and would not know to look there.
				// Once an hour per conversation (keepNotice keeps one of each text an hour).
				notice(`a rule's result was added to conversation ${held.sessionId.slice(0, 8)}, which is closed: pi --session ${held.sessionFile} shows it`, row.payload?.cwd);
			},
			turn: () => {
				throw new Error("the background process does not run turn requests yet");
			},
			// As `/cron abort` does: the run's AbortController, through the scheduler.
			abort: () => {
				const run = turnOpen.get(held.sessionId);
				if (run) scheduler.abortRun(run.requestId);
			},
			// Never asked: nothing is in flight here (the view's set is empty), a row is in the file or not.
			abortWhenStarted: () => undefined,
		};
	}

	/** Requests queued for a conversation this process holds: delivered now, while it holds it. */
	async function drainInto(held: HeldSession): Promise<void> {
		await drain(held.sessionId, requests, heldExecutor(held), Date.now(), sinks());
	}

	/** One plain job's turn in a closed conversation (src/scheduler.ts launchHeld). */
	async function heldTurn(job: LoopJob, prompt: string, runId: string, held: HeldSession, signal: AbortSignal): Promise<{ preempted: boolean; result: RunnerResult; landed: boolean }> {
		const stillHolds = () => leases.holds(held.sessionId, me(), held.epoch);
		// The run exists from here: a stop that arrives during this first drain names it.
		const open = { requestId: runId, startedAt: scheduler.runningRuns().find((r) => r.runId === runId)?.startedAt ?? stamp() };
		turnOpen.set(held.sessionId, { ...open, writing: false });
		log(`cron ${job.name ?? job.id}: turn ${runId.slice(0, 12)} in session ${held.sessionId.slice(0, 8)}`);
		let result: RunnerResult;
		try {
			try {
				await drainInto(held);
			} catch (err: any) {
				log(`requests for session ${held.sessionId.slice(0, 8)}: ${err?.message ?? err}`);
			}
			if (signal.aborted) {
				// Stopped before it began: nothing to run, and no model call to start for a turn already over.
				log(`cron ${job.name ?? job.id}: turn ${runId.slice(0, 12)} stopped before it began`);
				return { preempted: false, result: { ok: false, exitCode: 1, timedOut: false, text: "", errorMessage: "aborted", stopReason: "aborted", usage: { input: 0, output: 0, cost: 0, turns: 0 } }, landed: false };
			}
			// As the conversation's owner: pi's own trust for its directory, read now, and the job's declared tools.
			// Without the conversation's own directory (an older lease), the job's cwd could be one a model
			// chose: no owner trust then.
			const cwd = held.cwd ?? job.cwd;
			turnOpen.set(held.sessionId, { ...open, writing: true });
			result = await deps.runner({ cwd, prompt, model: job.model, thinking: job.thinking, tools: job.tools, builtinTools: job.builtinTools, trusted: held.cwd ? !!deps.ownerTrusts?.(held.cwd) : false, timeoutMs: job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, signal, hop: 1, kind: "held", jobId: job.id, runId, sessionFile: held.sessionFile, stillHolds });
		} finally {
			turnOpen.delete(held.sessionId);
		}
		// Taken back only if the turn did not complete: a window that arrives as the answer is saved has
		// nothing to run again, and rolling the slot back would answer the same prompt twice.
		const preempted = !result.ok && !stillHolds();
		log(`cron ${job.name ?? job.id}: ${preempted ? "a window took the session back; its turn stopped" : result.ok ? "turn done" : `turn FAILED (${redact(result.errorMessage ?? "")})`}`);
		// Read from the file, not from the result: a turn cut off after pi wrote the prompt has landed
		// it, and the row it came from is done either way.
		let landed = result.ok;
		try {
			landed = conversationHas(SessionManager.open(held.sessionFile).getEntries(), runId);
		} catch (err: any) {
			log(`cron ${job.name ?? job.id}: could not read session ${held.sessionId.slice(0, 8)} after its turn: ${err?.message ?? err}`);
		}
		return { preempted, result, landed };
	}

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
		sessionExists: deps.sessionExists,
		hooks: {
			onHeldTurn: heldTurn,
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
				log(`loop ${job.name ?? job.id}: ${record.ok ? "ok" : `FAILED (${redact(record.error ?? "")})`} · ${record.findings} finding(s)${record.usage?.cost ? ` · $${record.usage.cost.toFixed(3)}` : ""}`);
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
				deps.onTick?.(now);
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

	legacyOpen = (sessionId) => scheduler.presenceList().some((e: PresenceEntry) => e.sessionId === sessionId && !e.leases && e.kind !== "host");

	const toInbox = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }, forSession?: string) => {
		await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: content.replace(/^\[Trigger [^\]]+\]\s*/, ""), run_id: trigger.traceId, job_id: trigger.sourceLabel, cwd: trigger.cwd ?? "", session_id: forSession });
		return "inbox" as const;
	};
	/**
	 * A rule's result is a request addressed to the conversation that created it: appended as a row,
	 * which the window holding the conversation delivers, or this process while it holds the closed
	 * conversation for that one write. A closed conversation this process cannot take this instant
	 * (written moments ago, busy) keeps the row for a later tick. Only a rule with no creating
	 * conversation goes to the inbox: there is no conversation to address.
	 */
	const promote = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }, forSession?: string): Promise<"queued" | "chat" | "inbox"> => {
		const route = promotionTarget(forSession, { inProject: false, isHost: true }, { legacyOpen, known: knownConversation });
		if (route.to === "inbox") return toInbox(content, trigger, route.sessionId);
		requests.append(ruleResultRow(route.sessionId, content, trigger, { pid: process.pid, instance: "host", procStart: ownStart, version: PI_LOOPS_VERSION }));
		if (!canHold(route.sessionId)) return "queued";
		return (await deliverQueued(route.sessionId, trigger.traceId)) ? "chat" : "queued";
	};

	/**
	 * Take a closed conversation for one write and deliver what is queued for it. True when `traceId`
	 * (if given) is now in the conversation. The tick calls it for every closed conversation with a
	 * queue, so a result queued while the file was busy, or for a window that quit before reading it,
	 * still arrives.
	 */
	async function deliverQueued(sessionId: string, traceId?: string): Promise<boolean> {
		const held = heldLeases.acquireForWork?.(sessionId, traceId ?? "requests", "promotion");
		if (!held) return false;
		try {
			await drainInto(held);
			if (traceId === undefined) return true;
			const delivered = conversationHas(SessionManager.open(held.sessionFile).getEntries(), traceId);
			if (delivered) log(`trigger ${traceId.slice(0, 8)}: appended to session ${sessionId.slice(0, 8)}`);
			return delivered;
		} catch (err: any) {
			log(`requests for session ${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
			// Giving the lease back below rings this process again; with the same failure waiting
			// (an inbox it cannot write), that ring would fail the same way, for ever.
			quietUntilTick.add(sessionId);
			return false;
		} finally {
			heldLeases.releaseWork?.(sessionId, held.epoch);
		}
	}

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
				log(`gave back session ${lease.sessionId.slice(0, 8)}, held for run ${busy.runId} that is no longer running`);
			} catch (err: any) {
				log(`lease ${lease.sessionId.slice(0, 8)}: ${err?.message ?? err}`);
			}
		}
	}

	/**
	 * What is queued for one conversation nobody has open: delivered by this process, not left waiting
	 * for a resume. A conversation whose file is gone can never take it, so its rows become dead
	 * letters in the inbox, marked for it, instead of waiting there for ever.
	 *
	 * Writes nothing when the drain would change nothing. Taking the lease is itself a write, and this
	 * process hears its own writes as rings (`watch` below): a delivery that took the lease only to
	 * find every row waiting would ring itself into the next one, for ever.
	 */
	async function deliverSession(sessionId: string): Promise<void> {
		const rows = requests.list(sessionId);
		if (!rows.length) return;
		// A turn of this process's own is running there: the conversation is held already, for that
		// turn, so a stop or cancel is applied through that lease, with the epoch it took, and nothing
		// is taken a second time. The executor admits no input while the runner has the file.
		const lease = leases.read(sessionId);
		if (turnOpen.has(sessionId) && lease?.holder && sameHolder(lease.holder, me()) && lease.sessionFile) {
			await drainInto({ sessionId, epoch: lease.epoch, sessionFile: lease.sessionFile, cwd: lease.cwd });
			return;
		}
		if (!canHold(sessionId)) {
			if (liveHolderPid(leases, sessionId) !== undefined || legacyOpen(sessionId)) return; // its holder drains it
			const file = leases.read(sessionId)?.sessionFile;
			if (file && fs.existsSync(file)) return; // there, only busy or recently written: a later tick
			const buried = await bury(sessionId, requests, sinks(), "its conversation is gone");
			if (buried.length) log(`${buried.length} queued request(s) for session ${sessionId.slice(0, 8)} went to the inbox: its conversation is gone`);
			return;
		}
		// The same decision the drain makes, read without the lease (a read needs none).
		const file = leases.read(sessionId)?.sessionFile;
		if (!file) return;
		const entries = sessionFileEntries(file);
		if (!changesSomething(decideDrain(rows, { has: (id) => conversationHas(entries, id) }, sinks().jobs, heldView(sessionId), Date.now()))) return;
		await deliverQueued(sessionId);
	}

	/**
	 * Every closed conversation with something queued, on the tick: the floor under the doorbell, so a
	 * ring that was lost costs at most one tick. One conversation's failure (a lock that timed out)
	 * does not keep the others, or the rule checks after this, from their tick.
	 */
	async function deliverToClosed(): Promise<void> {
		quietUntilTick.clear();
		rungSinceTick.clear();
		for (const sessionId of requests.sessions()) {
			try {
				await deliverSession(sessionId);
			} catch (err: any) {
				log(`requests for session ${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
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
			log(`doorbell for session ${sessionId.slice(0, 8)}: rang ${RINGS_PER_TICK} times since the last tick; left to the tick`);
			return;
		}
		if (delivering.has(sessionId)) {
			ringAgain.add(sessionId);
			return;
		}
		delivering.add(sessionId);
		deliverSession(sessionId)
			.catch((err: any) => log(`requests for session ${sessionId.slice(0, 8)}: ${err?.message ?? err}`))
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
		budget: () => scheduler.budgetState(),
		hooks: {
			onPromote: promote,
			// A push that injects and runs reaches the host only when no window has its server (host.ts): the inbox.
			onInjectAndRun: (prompt, trigger) => toInbox(prompt, trigger),
			onFinished: (o) => log(`trigger ${o.trigger.traceId.slice(0, 8)} ${o.delivery} ${o.ok ? "ok" : `FAILED (${redact(o.error ?? "")})`}${o.matchedRules.length ? ` matched ${o.matchedRules.length}` : ""}`),
			log: (msg) => log(redact(msg)),
		},
	});

	/** The tools' host for one sub-session: that run's cwd and model, not the process defaults. */
	const toolHostFor = (req: Pick<SubagentRequest, "cwd" | "model" | "thinking" | "builtinTools" | "tools">): ToolHost => {
		const host: ToolHost = {
			scheduler,
			triggers,
			// A job a run makes gets no more built-in tools than that run (createLoopJob trims to them), and no trust of its own.
			session: () => ({ ...deps.session(), cwd: req.cwd, model: req.model ?? deps.session().model, thinking: req.thinking ?? deps.session().thinking, builtinTools: req.builtinTools ?? req.tools?.filter((t) => PI_BUILTIN_TOOL_NAMES.includes(t)) ?? deps.session().builtinTools, trusted: false }),
			createJob: (input, scope) => createLoopJob(host, input, scope),
			// The cron_control_plane audit has no session to live in here; /triggers audit shows it instead.
			cronControlAudit: (op, actor, before, after) => {
				const job = after ?? before;
				const id = newId("audit");
				triggers.store.appendAudit({ cwd: req.cwd, type: "cron_control_plane", traceId: id, state: op, sourceLabel: actor, eventLabel: job?.id, summary: job ? `${job.name ?? job.id}: ${job.prompt}` : undefined, details: { before_enabled: before?.enabled, after_enabled: after?.enabled } });
				log(`cron control plane: ${op} by ${actor} ${job?.id ?? ""}`);
				return id;
			},
			// Nobody can approve here: Prompt-class operations are denied fail-closed.
			confirmTool: async (_ctx, request, atHop) => controlPlanePreflight({ hop: Math.max(1, atHop), hasUI: false }, request.label),
			refreshBadge: () => undefined,
		};
		return host;
	};

	return {
		scheduler,
		triggers,
		notice,
		notices: () => [...kept],
		ring,
		customTools: async (req) => {
			const shared = deps.mcpTools();
			const automation = automationTools({ hop: req.hop, actor: "sub-agent", parentSessionId: req.parentSessionId, parentCwd: req.parentCwd }, toolHostFor(req));
			const taken = new Set([...PI_BUILTIN_TOOL_NAMES, ...shared.map((t) => t.name), ...automation.map((t) => t.name)]);
			const project = req.cwd ? ((await deps.projectMcpTools?.(req.cwd, taken, req.trusted)) ?? []) : [];
			return [...shared, ...project, ...automation];
		},
		start: () => {
			scheduler.start();
			watch();
		},
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
