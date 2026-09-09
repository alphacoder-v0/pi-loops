/**
 * What the headless host runs (see host.ts for the process shell): the same LoopScheduler and
 * TriggerRuntime as the extension, wired for a process that has no chat — promotions go to the
 * inbox, control-plane operations by sub-agents are audited into `triggers-audit.jsonl`, and the
 * process leaves as soon as an interactive pi owns the clock. Injected so it can be unit-tested.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { LoopsConfig } from "./config.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { redact } from "./redact.ts";
import type { SubagentRequest, SubagentRunner } from "./runner.ts";
import { LoopScheduler, type SessionSnapshot } from "./scheduler.ts";
import { newId } from "./store.ts";
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
	const scheduler = new LoopScheduler({
		dir,
		kind: "host",
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
			},
			onCatchUp: (job) => log(`loop ${job.name ?? job.id}: catching up a missed tick`),
			onRunFinished: ({ job, record, result }) => {
				auditCronFinish(triggers.store, job, record, result.stopReason === "aborted");
				log(`loop ${job.name ?? job.id}: ${record.ok ? "ok" : `FAILED (${redact(record.error ?? "")})`} · ${record.findings} finding(s)${record.usage?.cost ? ` · $${record.usage.cost.toFixed(3)}` : ""}`);
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
		maxConcurrent: deps.config().maxConcurrentRuns,
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
		},
	};
}
