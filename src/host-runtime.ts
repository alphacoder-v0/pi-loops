/**
 * What the always-on host runs (see host.ts for the process shell): the same LoopScheduler and
 * TriggerRuntime as the extension, wired for a process that has no chat. It runs every loop and
 * checks every rule; a promotion goes to the conversation that created the rule, through the
 * mailbox of the window holding it, or to the inbox marked for it when it is closed. Control-plane
 * operations by sub-agents are audited into `triggers-audit.jsonl`. Injected so it can be unit-tested.
 */
import * as fs from "node:fs";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { LoopsConfig } from "./config.ts";
import { HookRunner, runEndEvent, runStartEvent } from "./hooks.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { redact } from "./redact.ts";
import { keepNotice, type Notice } from "./host-control-channel.ts";
import type { RunnerResult, SubagentRequest, SubagentRunner } from "./runner.ts";
import { type LeaseHolder, LeaseStore, closedConversation, liveHolderPid, procStart } from "./lease.ts";
import { Mailbox, conversationHas, routePromotion } from "./mailbox.ts";
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
	projectMcpTools?: (cwd: string, taken: Set<string>) => Promise<ToolDefinition<any, any>[]>;
	/** Whether pi has a saved trust decision for exactly this directory (src/trust.ts). Default: no. */
	isProjectTrusted?: (cwd: string) => boolean;
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
	start(): void;
	stop(): Promise<void>;
}

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
	const mailbox = new Mailbox(dir);
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
	/** A plain job the host may fire: a conversation pi-loops knows the file of, that nobody holds. */
	const canHold = (sessionId: string | undefined): boolean => closedConversation(leases, sessionId, legacyOpen);

	/**
	 * Promotions queued for a conversation whose window closed before it drained them: appended now,
	 * while the host holds it, each one once (the `[Trigger <id>]` already in the file is the check).
	 */
	function drainInto(held: HeldSession): void {
		const sm = SessionManager.open(held.sessionFile);
		mailbox.drain(held.sessionId, {
			holds: () => leases.holds(held.sessionId, me(), held.epoch),
			alreadyDelivered: (id) => conversationHas(sm.getEntries(), id),
			deliver: (d) => {
				sm.appendCustomMessageEntry("pi-loops:trigger", d.text, true);
				// Written into a closed conversation, so no screen showed it: the audit row is what the
				// "since you last looked" line and the status page count (src/seen.ts).
				triggers.store.appendAudit({ cwd: d.cwd, type: "trigger_promotion", traceId: d.id, state: "appended", details: { session_id: held.sessionId } });
			},
		});
	}

	/** One plain job's turn in a closed conversation (src/scheduler.ts launchHeld). */
	async function heldTurn(job: LoopJob, prompt: string, runId: string, held: HeldSession, signal: AbortSignal): Promise<{ preempted: boolean; result: RunnerResult }> {
		const stillHolds = () => leases.holds(held.sessionId, me(), held.epoch);
		try {
			drainInto(held);
		} catch (err: any) {
			log(`mailbox for session ${held.sessionId.slice(0, 8)}: ${err?.message ?? err}`);
		}
		log(`cron ${job.name ?? job.id}: turn ${runId.slice(0, 12)} in session ${held.sessionId.slice(0, 8)}`);
		const result = await deps.runner({ cwd: held.cwd ?? job.cwd, prompt, model: job.model, thinking: job.thinking, tools: job.tools, timeoutMs: job.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, signal, hop: 1, kind: "held", jobId: job.id, runId, sessionFile: held.sessionFile, stillHolds });
		// Taken back only if the turn did not complete: a window that arrives as the answer is saved has
		// nothing to run again, and rolling the slot back would answer the same prompt twice.
		const preempted = !result.ok && !stillHolds();
		log(`cron ${job.name ?? job.id}: ${preempted ? "a window took the session back; its turn stopped" : result.ok ? "turn done" : `turn FAILED (${redact(result.errorMessage ?? "")})`}`);
		return { preempted, result };
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
			onInject: () => undefined,
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
				await deliverToClosed();
				await triggers.tick(now);
			},
			log: (msg, level, job) => {
				log(redact(msg));
				if (level !== "info") notice(msg, job?.cwd);
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
	 * A rule's result goes to the conversation that created it (src/mailbox.ts routePromotion): queued
	 * for the window holding it, or appended while the host holds the closed conversation for that one
	 * write. A closed conversation the host cannot take this instant (written moments ago, busy) gets it
	 * queued instead, delivered on a later tick; the inbox, marked for it, only when the conversation
	 * cannot be held at all.
	 */
	const promote = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }, forSession?: string): Promise<"mailbox" | "chat" | "inbox"> => {
		const route = routePromotion(forSession, { holds: false, isHost: true }, { holderOf: (id) => liveHolderPid(leases, id), closed: canHold });
		if (route.to === "inbox") return toInbox(content, trigger, route.sessionId);
		const queue = (sessionId: string) => {
			mailbox.enqueue(sessionId, { id: trigger.traceId, text: content, cwd: trigger.cwd ?? "", createdAt: stamp() });
			return "mailbox" as const;
		};
		if (route.to !== "append") return queue((route as { sessionId: string }).sessionId);
		queue(route.sessionId);
		return deliverQueued(route.sessionId, trigger.traceId) ? "chat" : "mailbox";
	};

	/**
	 * Take a closed conversation for one write and append what is queued for it. True when `traceId`
	 * (if given) is now in the conversation. The host's tick calls it for every closed conversation with
	 * a queue, so a result queued while the file was busy, or for a window that quit before reading it,
	 * still arrives.
	 */
	function deliverQueued(sessionId: string, traceId?: string): boolean {
		const held = heldLeases.acquireForWork?.(sessionId, traceId ?? "mailbox", "promotion");
		if (!held) return false;
		try {
			drainInto(held);
			if (traceId === undefined) return true;
			const delivered = conversationHas(SessionManager.open(held.sessionFile).getEntries(), traceId);
			if (delivered) log(`trigger ${traceId.slice(0, 8)}: appended to session ${sessionId.slice(0, 8)}`);
			return delivered;
		} catch (err: any) {
			log(`mailbox for session ${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
			return false;
		} finally {
			heldLeases.releaseWork?.(sessionId, held.epoch);
		}
	}

	/**
	 * Every closed conversation with something queued: delivered by the host, not left waiting for a
	 * resume. A conversation whose file is gone can never take it, so its queue goes to the inbox,
	 * marked for it, instead of waiting there for ever. One conversation's failure (a lock that timed
	 * out) does not keep the others, or the rule checks after this, from their tick.
	 */
	async function deliverToClosed(): Promise<void> {
		for (const sessionId of mailbox.sessions()) {
			try {
				if (canHold(sessionId)) {
					deliverQueued(sessionId);
					continue;
				}
				if (liveHolderPid(leases, sessionId) !== undefined || legacyOpen(sessionId)) continue; // its holder drains it
				const file = leases.read(sessionId)?.sessionFile;
				if (file && fs.existsSync(file)) continue; // there, only busy or recently written: a later tick
				for (const d of mailbox.takeAll(sessionId)) await toInbox(d.text, { sourceLabel: "Dynamic", traceId: d.id, cwd: d.cwd }, sessionId);
				log(`queued results for session ${sessionId.slice(0, 8)} went to the inbox: its conversation is gone`);
			} catch (err: any) {
				log(`mailbox for session ${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
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
	const toolHostFor = (req: Pick<SubagentRequest, "cwd" | "model" | "thinking">): ToolHost => {
		const host: ToolHost = {
			scheduler,
			triggers,
			session: () => ({ ...deps.session(), cwd: req.cwd, model: req.model ?? deps.session().model, thinking: req.thinking ?? deps.session().thinking }),
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
		customTools: async (req) => {
			const shared = deps.mcpTools();
			const automation = automationTools({ hop: req.hop, actor: "sub-agent", parentSessionId: req.parentSessionId, parentCwd: req.parentCwd }, toolHostFor(req));
			const taken = new Set([...PI_BUILTIN_TOOL_NAMES, ...shared.map((t) => t.name), ...automation.map((t) => t.name)]);
			const project = req.cwd ? ((await deps.projectMcpTools?.(req.cwd, taken)) ?? []) : [];
			return [...shared, ...project, ...automation];
		},
		start: () => scheduler.start(),
		stop: async () => {
			await triggers.stop();
			await scheduler.stop();
			// The runs are over; their hooks may still be in flight. Same bounded wait as the
			// interactive path, so a "the run failed" webhook survives the host being told to quit.
			await Promise.all([...runHooks.values()].map((h) => h.drain(3000)));
		},
	};
}
