/**
 * What the headless host runs (see host.ts for the process shell): the same LoopScheduler and
 * TriggerRuntime as the extension, wired for a process that has no chat — promotions go to the
 * inbox, control-plane operations by sub-agents are audited into `triggers-audit.jsonl`, and the
 * process leaves as soon as an interactive pi owns the clock. Injected so it can be unit-tested.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { LoopsConfig } from "./config.ts";
import { HookRunner, truncateSummary } from "./hooks.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { redact } from "./redact.ts";
import type { SubagentRequest, SubagentRunner } from "./runner.ts";
import { LoopScheduler, type SessionSnapshot } from "./scheduler.ts";
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
	/** Called when an interactive pi owns the clock: the host has nothing left to do. */
	exit: (code: number) => void | Promise<void>;
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
	let exiting = false;

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
			warn: (m) => log(`hooks: ${m}`),
			// The host log is where "what did my automation do last night" is answered, so a hook that
			// prints something has somewhere to print it here too.
			log: (m) => log(m),
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
		// No dead-session parking here: that is a decision the interactive leader can show the user.
		hooks: {
			// Plain (inject) jobs belong to a chat; the host has none, so they stay dormant here.
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
				if (hooks) void hooks.fire({ event: "run_start", run_job: job.name ?? job.id, run_id: runId, message_summary: truncateSummary(`${job.name ?? job.id}: ${job.prompt}`) }).catch((err: any) => log(`hooks: ${redact(err?.message ?? String(err))}`));
			},
			onCatchUp: (job) => log(`loop ${job.name ?? job.id}: catching up a missed tick`),
			onRunFinished: ({ job, record, result }) => {
				auditCronFinish(triggers.store, job, record, result.stopReason === "aborted");
				log(`loop ${job.name ?? job.id}: ${record.ok ? "ok" : `FAILED (${redact(record.error ?? "")})`} · ${record.findings} finding(s)${record.usage?.cost ? ` · $${record.usage.cost.toFixed(3)}` : ""}`);
				const hooks = runHooks.get(record.runId);
				if (!hooks) return;
				// `$PI_RUN_OK` alone answers "did last night's loop fail" — the thing the host exists to
				// be able to tell someone.
				const label = job.name ?? job.id;
				const summary = record.ok ? `${label}: ok · ${record.findings} finding(s)` : `${label}: failed: ${record.error ?? "unknown error"}`;
				// Its own hooks are the last thing a run does; the runner is dropped once they have run
				// (until then `stop()` still has to drain it).
				const forget = () => void runHooks.delete(record.runId);
				void hooks
					.fire({ event: "run_end", run_job: label, run_id: record.runId, run_ok: record.ok, run_findings: record.findings, run_error: record.error ? redact(record.error) : null, run_cost_usd: record.usage?.cost ?? null, message_summary: truncateSummary(summary) })
					.then(forget, forget);
			},
			onTick: async (now, leader) => {
				if (!leader) {
					if (exiting) return;
					exiting = true;
					log("an interactive pi owns the clock; exiting");
					await deps.exit(0);
					return;
				}
				await triggers.tick(now, leader);
			},
			log: (m) => log(redact(m)),
		},
	});

	const toInbox = async (content: string, trigger: { sourceLabel: string; traceId: string; cwd?: string }) => {
		await scheduler.inbox.append({ source: `trigger:${trigger.sourceLabel}`, text: content.replace(/^\[Trigger [^\]]+\]\s*/, ""), runId: trigger.traceId, jobId: trigger.sourceLabel, cwd: trigger.cwd ?? "" });
		return "inbox" as const;
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
		self: scheduler.self,
		presence: () => scheduler.presenceList(),
		isLeader: () => scheduler.isLeader,
		hooks: {
			// No chat here: everything a rule would have promoted lands in the inbox.
			onPromote: toInbox,
			onInjectAndRun: toInbox,
			onFinished: (o) => log(`trigger ${o.trigger.traceId.slice(0, 8)} ${o.delivery} ${o.ok ? "ok" : `FAILED (${redact(o.error ?? "")})`}${o.matchedRules.length ? ` matched ${o.matchedRules.length}` : ""}`),
			log: (m) => log(redact(m)),
		},
	});

	/** The tools' host for one sub-session: that run's cwd and model, not the process defaults. */
	const toolHostFor = (req: Pick<SubagentRequest, "cwd" | "model" | "thinking">): ToolHost => {
		const host: ToolHost = {
			scheduler,
			triggers,
			session: () => ({ ...deps.session(), cwd: req.cwd, model: req.model ?? deps.session().model, thinking: req.thinking ?? deps.session().thinking }),
			createJob: (input, scope) => createLoopJob(host, input, scope),
			// pie's cron_control_plane audit has no session to live in here; /triggers audit shows it instead.
			cronControlAudit: (op, actor, before, after) => {
				const job = after ?? before;
				const id = newId("audit");
				triggers.store.appendAudit({ cwd: req.cwd, type: "cron_control_plane", traceId: id, state: op, sourceLabel: actor, eventLabel: job?.id, summary: job ? `${job.name ?? job.id}: ${job.prompt}` : undefined, details: { before_enabled: before?.enabled, after_enabled: after?.enabled } });
				log(`cron control plane: ${op} by ${actor} ${job?.id ?? ""}`);
				return id;
			},
			// Nobody can approve here: Prompt-class operations are denied fail-closed, like pie's sub-agents.
			confirmTool: async (_ctx, req2, atHop) => controlPlanePreflight({ hop: Math.max(1, atHop), hasUI: false }, req2.label),
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
