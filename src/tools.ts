/**
 * The model-facing automation tools:
 * SetCronJobState and NewTrigger / ListTriggers / RemoveTrigger / SetTriggerState — as pi tool
 * definitions. One factory serves the interactive session (hop 0, registered with pi), every
 * in-process sub-session (hop 1, passed as customTools) and the headless host (hop 1, no UI).
 */
import { QUIET_MARK_AFTER, SIGNAL_WINDOW_MS, loopSignal } from "./job-signal.ts";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type TSchema } from "typebox";
import { previewRedacted } from "./redact.ts";
import { computeNext, formatLocal, formatSchedule, parseSchedule, stamp } from "./schedule.ts";
import type { LoopScheduler, SessionSnapshot } from "./scheduler.ts";
import { MAX_PROMPT_BYTES, type LoopJob, newId, owningSessionId, resolveJobRef } from "./store.ts";
import { asleepNote, ownerSession, runsIn } from "./job-owner.ts";
import type { TriggerRuntime } from "./trigger-runtime.ts";
import { withinProject } from "./presence.ts";
import { type TriggerStore, looksLikeFixedScheduleRequest, parseTriggerRule, resolveRuleRef, type DynamicTriggerRule } from "./triggers.ts";

export interface ControlPlaneRequest {
	/** What is being approved, value-free. */
	label: string;
	tool: string;
	/** Names the fields involved, never their values: a reason that quotes an argument leaks it into the audit. */
	reason: string;
	/** Redacted, bounded preview of the payload — the one place values are shown. */
	preview: string;
	args?: unknown;
}

/** What the tools need from whoever hosts them (the extension, a sub-session, the headless host). */
export interface ToolHost {
	scheduler: LoopScheduler;
	triggers: TriggerRuntime;
	session(): SessionSnapshot;
	createJob(input: CreateJobInput, scope?: JobScope): Promise<LoopJob>;
	/** The cron_control_plane audit; returns the entry id. */
	cronControlAudit(op: "add" | "enable" | "disable" | "remove", actor: "slash" | "tool" | "sub-agent", before?: LoopJob, after?: LoopJob): string;
	/** The confirmation gate; resolves to a denial text or undefined (allowed). */
	confirmTool(ctx: ExtensionContext, req: ControlPlaneRequest, atHop: number): Promise<string | undefined>;
	refreshBadge(): void;
}

export interface CreateJobInput {
	schedule: LoopJob["schedule"];
	prompt: string;
	stateful: boolean;
	name?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	timeoutMs?: number;
	/** Default: stateful jobs catch up a missed tick, inject jobs do not. */
	catchUp?: boolean;
	verify?: boolean;
	checkerModel?: string;
	/** Set by `/recipe add`: which recipe this job belongs to. */
	recipe?: string;
}

export interface JobScope {
	parentSessionId?: string;
	parentCwd?: string;
}

/**
 * A job's directory is always explicit: with no project of our own, `path.resolve` would silently
 * mean $HOME. A relative `cwd` is resolved against the session's project when there is one; with no
 * session project there is nothing to resolve against, so it has to be absolute — the headless
 * host's process cwd *is* $HOME, and resolving a sub-agent's `cwd: "code/piz"` against it pinned
 * the job to a real, unrelated project without saying so.
 */
function resolveJobCwd(sessionCwd: string, cwd: string | undefined): string {
	if (!sessionCwd && !cwd) throw new Error("no project directory for this job: pass cwd");
	if (!sessionCwd && !path.isAbsolute(cwd!)) throw new Error(`this job needs an absolute directory: there is no project to resolve "${cwd}" against`);
	return cwd ? path.resolve(sessionCwd || process.cwd(), cwd) : path.resolve(sessionCwd);
}

/** A worktree, a symlinked path or a subdirectory is the same project, as the runtime treats it. */
function sameProject(a: string, b: string): boolean {
	return withinProject(b, a) || withinProject(a, b);
}

/** A rule by ref, preferring this project's; another project's needs its exact id. */
export function resolveRuleRefScoped(rules: DynamicTriggerRule[], ref: string, cwd: string): DynamicTriggerRule | undefined {
	// Ordinals are what the user sees in `/triggers rules`; a model's list may be a different one,
	// so the tools take an id, a unique prefix or a name — never a position.
	if (/^\d+$/.test(ref.trim())) return undefined;
	const mine = resolveRuleRef(
		rules.filter((r) => withinProject(cwd, r.cwd) || withinProject(r.cwd, cwd)),
		ref,
	);
	if (mine) return mine;
	const trimmed = ref.trim();
	return rules.find((r) => r.id === trimmed);
}

/** A job by ref, preferring this project's; another project's needs its exact id. */
export function resolveJobRefScoped(jobs: LoopJob[], ref: string, cwd: string): LoopJob | undefined {
	if (/^\d+$/.test(ref.trim())) return undefined;
	const mine = resolveJobRef(
		jobs.filter((j) => sameProject(j.cwd, cwd)),
		ref,
	);
	if (mine) return mine;
	const trimmed = ref.trim();
	return jobs.find((j) => j.id === trimmed);
}

/**
 * The rule for a job's name, in one place because both `/cron add` and `/cron set --name` have to
 * apply it. A name is how a job is referred to (`/cron run ci`), so two jobs sharing one make every
 * reference ambiguous, and the resolution silently picks whichever the lookup reaches first.
 * `existing` excludes the job being renamed, so keeping a job's own name is not a collision.
 */
export function checkJobName(name: string | undefined, existing: LoopJob[]): void {
	if (!name) return;
	if (!/^[\w.-]{1,40}$/.test(name)) throw new Error("name must be 1-40 chars of letters, digits, . _ -");
	if (existing.some((j) => j.name === name)) throw new Error(`a cron job named "${name}" already exists`);
}

/** `/cron add` and `cron_create`: validate, fill the defaults, record who created it and where. */
export async function createLoopJob(host: Pick<ToolHost, "scheduler" | "session">, input: CreateJobInput, scope?: JobScope): Promise<LoopJob> {
	if (!input.prompt.trim()) throw new Error("cron action cannot be empty");
	if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error(`cron action exceeds ${MAX_PROMPT_BYTES} bytes`);
	// An expression can parse and still never match ("0 0 30 2 *"): the job would go quiet with
	// nothing to see, and every scan for its next run walks the whole lookahead window. `/cron set`
	// has refused this since it existed (job-edit.ts); creation did not. Only cron expressions are
	// asked: a `once` schedule whose time has passed has no next run because it is due now.
	if (input.schedule.kind === "cron" && computeNext({ schedule: input.schedule, createdAt: Date.now() }, Date.now()) === undefined) {
		throw new Error(`${formatSchedule(input.schedule)} has no next run`);
	}
	const existing = host.scheduler.store.load();
	checkJobName(input.name, existing);
	if (!input.stateful && !host.session().sessionId) throw new Error("a non-stateful cron job needs a persistent chat session to inject into (not --no-session, not the background host); use stateful=true");
	const job: LoopJob = {
		id: newId("cron"),
		name: input.name,
		schedule: input.schedule,
		stateful: input.stateful,
		prompt: input.prompt,
		cwd: resolveJobCwd(host.session().cwd, input.cwd),
		// Captured now: the run happens in whichever pi owns the timer, and that one may be on another model.
		model: input.model ?? host.session().model,
		thinking: input.thinking ?? host.session().thinking,
		tools: input.tools,
		enabled: true,
		verify: input.stateful && input.verify ? true : undefined,
		checkerModel: input.stateful && input.verify ? input.checkerModel : undefined,
		catchUp: input.catchUp ?? input.stateful,
		timeoutMs: input.timeoutMs,
		recipe: input.recipe,
		createdAt: stamp(),
		// A sub-agent schedules on behalf of the session that runs it.
		createdBy: { sessionId: scope?.parentSessionId ?? host.session().sessionId, cwd: scope?.parentCwd ?? host.session().cwd },
		sessionId: owningSessionId(input.stateful, host.session().sessionId, scope?.parentSessionId),
		runCount: 0,
		skippedOverlap: 0,
	};
	await host.scheduler.store.add(job);
	return job;
}


const deny = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: { id: undefined as string | undefined } });

/** Trigger rules, rendered for a tool result. */
function renderTriggerRulesForTool(rules: ReturnType<TriggerStore["load"]>, host: Pick<ToolHost, "session">): string {
	if (!rules.length) return "dynamic trigger rules: none";
	return [`dynamic trigger rules: ${rules.length}`, ...rules.map((r) => `- ${r.id} [${r.enabled ? "enabled" : "disabled"}, ${r.fireOnce ? "fire_once" : "repeat"}, ${r.promoteToChat ? "promote_to_chat" : "audit_only"}] created_at=${r.createdAt} condition: ${previewRedacted(r.condition, 200)} action: ${previewRedacted(r.action, 200)}${r.cwd !== host.session().cwd ? ` cwd: ${r.cwd}` : ""}`)].join("\n");
}

/**
 * When the job next runs *here*, or undefined: disabled, or a plain job of a session this process
 * does not hold. The list is filtered the way dispatch filters — a next run for a job nothing here
 * will dispatch is a time nothing intends to keep, and a model reads it as a promise.
 */
function nextRunForTool(job: LoopJob, now: number, sessionId: string | undefined): number | undefined {
	if (!job.enabled || !runsIn(job, sessionId)) return undefined;
	return computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt), lastFiredAt: job.lastFiredAt ? Date.parse(job.lastFiredAt) : undefined }, now);
}

/** Cron jobs, rendered for a tool result. */
function renderCronJobsForTool(jobs: LoopJob[], host: Pick<ToolHost, "session" | "scheduler">): string {
	if (!jobs.length) return "cron jobs: none";
	const now = Date.now();
	const lines = [`cron jobs: ${jobs.length}`];
	// Read once for the listing, as `/cron` does; only loops have a signal to report.
	const runs = jobs.some((j) => j.stateful) ? host.scheduler.store.allRuns() : [];
	const inbox = jobs.some((j) => j.stateful) ? host.scheduler.inbox.list() : [];
	for (const job of jobs) {
		lines.push(`- ${job.id}${job.name ? ` "${job.name}"` : ""} [${job.enabled ? "enabled" : "disabled"}${job.stateful ? ", stateful" : ""}${job.verify ? ", verify" : ""}] schedule: ${formatSchedule(job.schedule)} action: ${previewRedacted(job.prompt, 120)}${job.cwd !== host.session().cwd ? ` cwd: ${job.cwd}` : ""}`);
		const asleep = asleepNote(job, host.session().sessionId);
		if (asleep) lines.push(`  ${asleep} (no next run here)`);
		const next = nextRunForTool(job, now, host.session().sessionId);
		if (next) lines.push(`  next_run: ${stamp(next)}`);
		if (job.running) lines.push(`  running_run_id: ${job.running.runId}`);
		if (job.lastError) lines.push(`  last_error: ${previewRedacted(job.lastError, 120)}`);
		if (job.skippedOverlap) lines.push(`  skipped_overlap_count: ${job.skippedOverlap}`);
		if (job.stateful) {
			// The same two facts `/cron` shows, so the model can say "this loop's findings are all
			// dismissed" or "it has found nothing in 12 runs" when the user asks about their automation.
			const s = loopSignal(job.id, runs, inbox, now - SIGNAL_WINDOW_MS);
			if (s.findings) lines.push(`  signal_30d: findings=${s.findings} claimed=${s.claimed} dismissed=${s.dismissed}`);
			if (s.quiet >= QUIET_MARK_AFTER) lines.push(`  quiet_streak: ${s.quiet} (consecutive runs with no finding)`);
		}
	}
	return lines.join("\n");
}

export interface ToolScope {
	hop: number;
	actor: "tool" | "sub-agent";
	parentSessionId?: string;
	parentCwd?: string;
}
/**
 * The cron/trigger tools are registered in sub-agents too (Prompt-class ones are denied there)
 * and bounds cycles with a hop count. The same definitions serve the interactive session
 * (hop 0, registered with pi) and every in-process sub-session (hop 1, passed as customTools).
 */
export function automationTools(scope: ToolScope, host: ToolHost): ToolDefinition<any, any>[] {
	const defs: ToolDefinition<any, any>[] = [];
	// Generic so each definition keeps its inferred parameter type, exactly as pi.registerTool does.
	const register = <T extends TSchema, D>(d: ToolDefinition<T, D>): void => void defs.push(d as ToolDefinition<any, any>);
	register({
		name: "new_trigger",
		label: "Create trigger",
		description:
			"Create an event/condition-based dynamic trigger rule. Use this for future events such as a browser tab, file, MCP notification, webhook, or other condition becoming true. Do not use this for fixed time, recurring, scheduled, hourly, daily, weekly, cron, crontab, 定时任务, 每小时, or similar time-based jobs; use cron_create instead.",
		parameters: Type.Object(
			{
				condition: Type.String({ description: "The natural-language condition that should be evaluated against future trigger events." }),
				action: Type.String({ description: "The action to perform when the condition matches. This may be a shell command or a natural-language instruction." }),
				spec: Type.Optional(Type.String({ description: "Fallback complete trigger rule text when condition and action cannot be supplied separately." })),
				fire_once: Type.Optional(Type.Boolean({ description: "Whether to disable the rule after the first successful match. Defaults to true unless the user explicitly asks for a repeating trigger." })),
				promote_to_chat: Type.Optional(Type.Boolean({ description: "Whether successful trigger output should be inserted into the parent chat context so future turns can see it. Defaults to false unless the user explicitly asks for that behavior." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if ([params.condition, params.action, params.spec].some((t) => t && looksLikeFixedScheduleRequest(t))) return deny("fixed scheduled jobs must use cron_create, not new_trigger");
			let condition = params.condition?.trim() ?? "";
			let action = params.action?.trim() ?? "";
			const fromSpec = !condition || !action;
			if (fromSpec) {
				if (!params.spec) return deny("missing required args: provide condition and action");
				try {
					({ condition, action } = parseTriggerRule(params.spec));
				} catch (err: any) {
					return deny(err?.message ?? String(err));
				}
			}
			const reason = fromSpec ? "create dynamic trigger from `spec` field" : "create dynamic trigger from `condition` + `action` fields";
			const denied = await host.confirmTool(ctx, { label: "create dynamic trigger", tool: "new_trigger", reason, preview: `when ${previewRedacted(condition, 80)} -> ${previewRedacted(action, 80)}`, args: params }, scope.hop);
			if (denied) return deny(denied);
			const rule = await host.triggers.store.add({ condition, action, fireOnce: params.fire_once ?? true, promoteToChat: params.promote_to_chat ?? false, cwd: host.session().cwd, sessionId: host.session().sessionId, model: host.session().model, thinking: host.session().thinking });
			host.refreshBadge();
			return {
				content: [{ type: "text", text: `created dynamic trigger ${rule.id}\ncondition: ${rule.condition}\naction: ${rule.action}\nfire_once: ${rule.fireOnce}\npromote_to_chat: ${rule.promoteToChat}\n(checked every ${host.triggers.pollIntervalSecs}s by a background sub-agent)` }],
				details: { id: rule.id as string | undefined, condition: rule.condition, action: rule.action, enabled: rule.enabled, fire_once: rule.fireOnce, fired_at: rule.firedAt, promote_to_chat: rule.promoteToChat },
			};
		},
	});
	register({
		name: "list_triggers",
		label: "List triggers",
		description: "List dynamic trigger rules of the current project. Use this when the user asks to view, list, show, inspect, or find trigger ids. Set all_projects only when the user asks about other projects.",
		parameters: Type.Object({
			all_projects: Type.Optional(Type.Boolean({ description: "Include rules of every project on this machine (default false)." })),
		}),
		async execute(_id, params) {
			// The store is machine-wide, so containment is this filter's job: a model sees its own
			// project's rules unless a human asked for all of them.
			const cwd = host.session().cwd;
			const all = host.triggers.store.load();
			// A sub-agent never gets the machine-wide view: nobody is there to have asked for it.
			const rules = params.all_projects && scope.hop === 0 ? all : all.filter((r) => sameProject(r.cwd, cwd));
			return { content: [{ type: "text", text: renderTriggerRulesForTool(rules, host) }], details: { count: rules.length, scope: params.all_projects && scope.hop === 0 ? "machine" : cwd, rules, storage_path: host.triggers.store.rulesFile } };
		},
	});
	register({
		name: "remove_trigger",
		label: "Remove trigger",
		description: "Delete dynamic trigger rules. Use this when the user asks to delete, remove, or clear an existing dynamic trigger.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "The exact dynamic trigger rule id to remove." })),
			all: Type.Optional(Type.Boolean({ description: "Set true only when the user explicitly asks to remove all dynamic trigger rules." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: { removed_count: 0 } });
			if (params.all) {
				// Scoped to this run's project: a machine-wide wipe is not something a model can ask for.
				const cwd = host.session().cwd;
				const denied = await host.confirmTool(ctx, { label: "remove ALL dynamic triggers", tool: "remove_trigger", reason: "remove every dynamic trigger rule of this project (`all` flag)", preview: `${host.triggers.store.load().filter((r) => sameProject(r.cwd, cwd)).length} rule(s)`, args: params }, scope.hop);
				if (denied) return err(denied);
				const n = await host.triggers.store.clear(cwd, sameProject);
				return { content: [{ type: "text", text: `removed ${n} dynamic trigger rule(s)` }], details: { removed_count: n } };
			}
			if (!params.id) return err("missing required arg: id");
			const rule = resolveRuleRefScoped(host.triggers.store.load(), params.id, host.session().cwd);
			if (!rule) return err(`no dynamic trigger rule with id '${params.id}'`);
			const denied = await host.confirmTool(ctx, { label: `remove dynamic trigger ${rule.id}`, tool: "remove_trigger", reason: "remove a dynamic trigger rule by `id`", preview: `when ${previewRedacted(rule.condition, 120)}`, args: params }, scope.hop);
			if (denied) return err(denied);
			await host.triggers.store.remove(rule.id);
			return { content: [{ type: "text", text: `removed dynamic trigger ${rule.id}\ncondition: ${rule.condition}\naction: ${rule.action}` }], details: { removed_count: 1 } };
		},
	});
	register({
		name: "set_trigger_state",
		label: "Enable/disable trigger",
		description: "Enable or disable an existing dynamic trigger rule without deleting it. Use this when the user asks to pause, disable, enable, or resume a trigger.",
		parameters: Type.Object({
			id: Type.String({ description: "The exact dynamic trigger rule id to update." }),
			enabled: Type.Boolean({ description: "Set false to pause or disable the trigger; set true to enable or resume it." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const ruleCwd = host.session().cwd;
			const rule = resolveRuleRefScoped(host.triggers.store.load(), params.id, ruleCwd);
			if (!rule) return deny(`no dynamic trigger rule with id '${params.id}'`);
			// Re-enabling is gated; pausing another project's rule is just as much a surprise, so it
			// is gated too (a sub-agent is refused outright, having nobody to ask).
			if (params.enabled || rule.cwd !== ruleCwd) {
				const denied = await host.confirmTool(ctx, { label: `${params.enabled ? "re-enable" : "disable"} dynamic trigger ${rule.id}`, tool: "set_trigger_state", reason: params.enabled ? "re-enable a dynamic trigger rule (`enabled` = true); it will fire again" : "disable a dynamic trigger rule of another project", preview: `when ${previewRedacted(rule.condition, 120)}`, args: params }, scope.hop);
				if (denied) return deny(denied);
			}
			const updated = (await host.triggers.store.setEnabled(rule.id, params.enabled)) ?? rule;
			return {
				content: [{ type: "text", text: `updated dynamic trigger ${updated.id}\nstate: ${updated.enabled ? "enabled" : "disabled"}\ncondition: ${updated.condition}\naction: ${updated.action}` }],
				details: { id: updated.id as string | undefined, condition: updated.condition, action: updated.action, enabled: updated.enabled, fire_once: updated.fireOnce, fired_at: updated.firedAt, promote_to_chat: updated.promoteToChat },
			};
		},
	});

	register({
		name: "cron_create",
		label: "Create cron job",
		description:
			"Create a scheduled job. Use when the user asks for a fixed time, recurring, scheduled, hourly, daily, weekly, crontab, 定时任务, 每小时, 每天, or similar time-based job. Jobs persist across pi restarts. A plain job runs its prompt in this chat when due. Set stateful=true for loop mode: a fresh sub-agent runs it, keeps persistent notes across runs (injected each time), and routes findings to the user's /inbox instead of the chat — use that for recurring watch/triage jobs like \"check for new issues and report only what changed\".",
		parameters: Type.Object({
			schedule: Type.String({
				description: 'Local-time schedule: 5-field cron ("0 9 * * *", "*/30 * * * 1-5"), "@daily", "every 30m", "in 10m", or "at 2026-09-08T18:00".',
			}),
			action: Type.String({ description: "Natural-language instruction to run when the schedule is due. For stateful jobs, write it for a fresh agent whose only memory is its own notes." }),
			stateful: Type.Optional(Type.Boolean({ description: "Loop mode: sub-agent + notes between runs + findings to /inbox (default false)." })),
			verify: Type.Optional(Type.Boolean({ description: "Maker/checker: a second adversarial sub-agent verifies each finding before it enters the inbox (stateful jobs only, default false). Use when the user asks for verified, double-checked, or high-precision findings." })),
			name: Type.Optional(Type.String({ description: "Short unique label (letters, digits, . _ -)." })),
			cwd: Type.Optional(Type.String({ description: "Directory a stateful job's sub-agent runs in. Default: current project." })),
			catch_up: Type.Optional(Type.Boolean({ description: "Run once for a tick that was missed: a loop when a pi next takes the clock, a plain job when the session that created it is next opened (default: true for stateful jobs, false for plain jobs)." })),
		}),
		async execute(_id, params) {
			const schedule = parseSchedule(params.schedule);
			const job = await host.createJob(
				{
					schedule,
					prompt: params.action,
					stateful: params.stateful ?? params.verify ?? false, // verify implies a loop: a checker only reviews loop findings (`args.ts` does the same for `--verify`)
					verify: params.verify ?? false,
					name: params.name,
					cwd: params.cwd,
					catchUp: params.catch_up,
				},
				scope,
			);
			const auditEntryId = host.cronControlAudit("add", scope.actor, undefined, job);
			host.refreshBadge();
			const next = computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt) }, Date.now());
			const where = job.stateful ? `Findings will appear in /inbox${job.verify ? " after an independent checker reviews them" : ""}.` : "Its result will appear in this chat.";
			// Three lines — what was created, when it runs, what it will do — then where its output goes.
			return {
				content: [{ type: "text", text: `created cron job ${job.id}${job.name ? ` "${job.name}"` : ""}\nschedule: ${formatSchedule(job.schedule)}\naction: ${previewRedacted(job.prompt, 120)}\n${job.stateful ? "[stateful] " : ""}next run ${next ? stamp(next) : "—"}. ${where}` }],
				details: { id: job.id, name: job.name, schedule: formatSchedule(job.schedule), action: job.prompt, enabled: job.enabled, stateful: job.stateful, verify: job.verify ?? false, scope: job.stateful ? "machine" : "session", owner_session: ownerSession(job), next_run: next ? stamp(next) : undefined, audit_entry_id: auditEntryId },
			};
		},
	});

	register({
		name: "cron_list",
		label: "List cron jobs",
		description: "List the current project's scheduled jobs with schedule, next run, [stateful] marker and last error. Also reports how many unread inbox findings exist. Set all_projects only when the user asks about other projects.",
		parameters: Type.Object({
			all_projects: Type.Optional(Type.Boolean({ description: "Include jobs of every project on this machine (default false)." })),
		}),
		async execute(_id, params) {
			const listCwd = host.session().cwd;
			const everywhere = params.all_projects === true && scope.hop === 0;
			const jobs = everywhere ? host.scheduler.store.load() : host.scheduler.store.load().filter((j) => sameProject(j.cwd, listCwd));
			const text = `${renderCronJobsForTool(jobs, host)}\ninbox: ${host.scheduler.inbox.newCount()} new finding(s)`;
			const nowMs = Date.now();
			const nextRun = (j: LoopJob) => nextRunForTool(j, nowMs, host.session().sessionId);
			return { content: [{ type: "text", text }], details: { count: jobs.length, scope: everywhere ? "machine" : listCwd, storage_path: host.scheduler.store.jobsFile, jobs: jobs.map((j) => ({ id: j.id, name: j.name, schedule: formatSchedule(j.schedule), action_preview: previewRedacted(j.prompt, 120), enabled: j.enabled, stateful: j.stateful, verify: j.verify ?? false, cwd: j.cwd, running_run_id: j.running?.runId, last_due_at: j.lastDueAt, last_fired_at: j.lastFiredAt, last_completed_at: j.lastCompletedAt, last_error: j.lastError ? previewRedacted(j.lastError, 120) : undefined, skipped_overlap_count: j.skippedOverlap, next_run: (() => { const n = nextRun(j); return n ? stamp(n) : undefined; })(), owner_session: ownerSession(j), asleep: !runsIn(j, host.session().sessionId) || undefined, created_at: j.createdAt })) } };
		},
	});

	register({
		name: "cron_remove",
		label: "Remove cron job",
		description:
			"Preview or confirm removal of a scheduled job by id or name. Use confirm=false first when the user asks to delete, remove, or clear a scheduled job, cron job, crontab entry, or 定时任务. Call confirm=true only after the user explicitly confirms removal. Removal deletes the job itself; a loop's saved notes and run transcripts are kept on disk, and `/cron gc --purge` is what clears them.",
		parameters: Type.Object({
			ref: Type.String({ description: "Job id (for example cron-abc123), unique id prefix, or name." }),
			confirm: Type.Optional(Type.Boolean({ description: "false to preview the removal; true only after explicit user confirmation." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const job = resolveJobRefScoped(host.scheduler.store.load(), params.ref, host.session().cwd);
			if (!job) return { content: [{ type: "text", text: `no cron job with id '${params.ref}'` }], isError: true, details: { id: undefined as string | undefined, removed_count: 0, confirmation_required: false, audit_entry_id: undefined as string | undefined } };
			const label = `${job.id}${job.name ? ` "${job.name}"` : ""}`;
			if (!params.confirm) {
				return {
					content: [{ type: "text", text: `remove cron job ${label} requires confirmation\nschedule: ${formatSchedule(job.schedule)}\naction: ${previewRedacted(job.prompt, 120)}\ncall cron_remove again with confirm=true only after the user confirms` }],
					details: { id: job.id as string | undefined, removed_count: 0, confirmation_required: true, audit_entry_id: undefined as string | undefined },
				};
			}
			// The only control-plane tool that used to skip this gate, so a sub-agent (hop > 0) could
			// delete any project's job unapproved — and what that costs is the automation itself: the
			// loop stops running and its id is gone from jobs.json. Its notes and transcripts stay
			// behind (under an id nothing schedules any more; `/cron gc --purge` clears those), which
			// is why the gate is about what stops, not about data destroyed. The preview above stays
			// free: it is what the user is shown before deciding.
			const denied = await host.confirmTool(ctx, { label: `remove cron job ${label}`, tool: "cron_remove", reason: "remove a scheduled job", preview: `${formatSchedule(job.schedule)} · ${previewRedacted(job.prompt, 120)}`, args: params }, scope.hop);
			if (denied) return { content: [{ type: "text", text: denied }], isError: true, details: { id: undefined as string | undefined, removed_count: 0, confirmation_required: false, audit_entry_id: undefined as string | undefined } };
			await host.scheduler.store.remove(job.id);
			const auditEntryId = host.cronControlAudit("remove", scope.actor, job, undefined);
			// The slash command says where a loop's notes went; a tool-driven removal has to say it too,
			// or the person who asked the agent to delete a job is the only one left guessing. The prose
			// carries the fact and `details` carries the path, which is the division this tool already
			// uses elsewhere (`cron_list` reports `storage_path` the same way).
			const kept = job.stateful ? "\nits loop state and run transcripts are kept; /cron gc --purge clears them" : "";
			const statePath = job.stateful ? host.scheduler.store.statePath(job.id) : undefined;
			return { content: [{ type: "text", text: `removed cron job ${label}\nschedule: ${formatSchedule(job.schedule)}\naction: ${previewRedacted(job.prompt, 120)}${kept}` }], details: { id: job.id as string | undefined, removed_count: 1, confirmation_required: false, audit_entry_id: auditEntryId, state_path: statePath } };
		},
	});

	register({
		name: "set_cron_job_state",
		label: "Enable/disable cron job",
		description: "Disable (pause) or enable (resume) a scheduled job by id or name. Enabling asks the user to confirm first.",
		parameters: Type.Object({
			ref: Type.String({ description: "Job id (for example cron-abc123), unique id prefix, or name." }),
			enabled: Type.Boolean({ description: "true to enable/resume the cron job; false to disable/pause it." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const jobCwd = host.session().cwd;
			const job = resolveJobRefScoped(host.scheduler.store.load(), params.ref, jobCwd);
			if (!job) return deny(`no cron job with id '${params.ref}'`);
			if (params.enabled || job.cwd !== jobCwd) {
				const denied = await host.confirmTool(ctx, { label: `${params.enabled ? "enable" : "disable"} cron job ${job.name ?? job.id}`, tool: "set_cron_job_state", reason: params.enabled ? "enable a cron job from a model-facing tool (`enabled` = true)" : "disable a cron job of another project", preview: `${formatSchedule(job.schedule)}: ${previewRedacted(job.prompt, 120)}`, args: params }, scope.hop);
				if (denied) return deny(`${denied}; use /cron enable <id>`);
			}
			const updated = (await host.scheduler.store.update(job.id, (j) => {
				j.enabled = params.enabled;
				if (params.enabled) j.lastError = undefined;
			})) ?? job;
			const auditEntryId = host.cronControlAudit(params.enabled ? "enable" : "disable", scope.actor, job, updated);
			return {
				content: [{ type: "text", text: `updated cron job ${updated.id}\nstate: ${updated.enabled ? "enabled" : "disabled"}\nschedule: ${formatSchedule(updated.schedule)}\naction: ${previewRedacted(updated.prompt, 120)}` }],
				details: { id: updated.id as string | undefined, schedule: formatSchedule(updated.schedule), enabled: updated.enabled, stateful: updated.stateful, audit_entry_id: auditEntryId },
			};
		},
	});
	return defs;
}
