/**
 * What the always-on host runs (see host.ts for the process shell): the same LoopScheduler and
 * TriggerRuntime as the extension, wired for a process that has no chat. It runs every loop and
 * checks every rule; a promotion goes to the conversation that created the rule, through the
 * mailbox of the window holding it, or to the inbox marked for it when it is closed. Control-plane
 * operations by sub-agents are audited into `triggers-audit.jsonl`. Injected so it can be unit-tested.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { LoopsConfig } from "./config.ts";
import { HookRunner, runEndEvent, runStartEvent } from "./hooks.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { redact } from "./redact.ts";
import type { SubagentRequest, SubagentRunner } from "./runner.ts";
import { LeaseStore, liveHolderPid } from "./lease.ts";
import { Mailbox } from "./mailbox.ts";
import { LoopScheduler, type SessionSnapshot } from "./scheduler.ts";
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
	start(): void;
	stop(): Promise<void>;
}

export function createHostRuntime(deps: HostRuntimeDeps): HostRuntime {
	const { dir, log } = deps;
	let triggers: TriggerRuntime;
	const leases = new LeaseStore(dir);
	const mailbox = new Mailbox(dir);

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
		// Loops only: a plain job's result is a message in its conversation, and the window holding
		// that conversation fires it.
		owns: (job) => job.stateful,
		sessionExists: deps.sessionExists,
		hooks: {
			onInject: () => undefined,
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
				await triggers.tick(now);
			},
			log: (msg) => log(redact(msg)),
		},
	});

	const toInbox = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }, forSession?: string) => {
		await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: content.replace(/^\[Trigger [^\]]+\]\s*/, ""), run_id: trigger.traceId, job_id: trigger.sourceLabel, cwd: trigger.cwd ?? "", session_id: forSession });
		return "inbox" as const;
	};
	/** A rule's result goes to the conversation that created it: queued for the window holding it, else the inbox marked for it. */
	const promote = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }, forSession?: string) => {
		if (!forSession || liveHolderPid(leases, forSession) === undefined) return toInbox(content, trigger, forSession);
		mailbox.enqueue(forSession, { id: trigger.traceId, kind: "message", text: content, cwd: trigger.cwd ?? "", ruleIds: [], createdAt: stamp() });
		return "mailbox" as const;
	};
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
