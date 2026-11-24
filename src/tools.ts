/**
 * The model-facing automation tools:
 * SetCronJobState and NewTrigger / ListTriggers / RemoveTrigger / SetTriggerState — as pi tool
 * definitions. One factory serves the interactive session (hop 0, registered with pi), every
 * in-process sub-session (hop 1, passed as customTools) and the headless host (hop 1, no UI).
 * Hop 1 does not get `new_trigger`, `remove_trigger` or `cron_remove`: nobody can approve any of them there.
 */
import { QUIET_MARK_AFTER, SIGNAL_WINDOW_MS, loopSignal } from "./job-signal.ts";
import { formatWait, queuedPrompt, type QueuedPrompt, runningRun } from "./engine.ts";
import { type ListedJob, listedJob, listedJobs } from "./job-status.ts";
import { gateFields, statusField, statusWord, wakeFields } from "./job-lines.ts";
import { gateCommandWhy, gateShown } from "./gate.ts";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type TSchema } from "typebox";
import { plainLine, previewRedacted } from "./redact.ts";
import { computeNext, formatLocal, formatSchedule, nextRunAt, parseSchedule, stamp } from "./schedule.ts";
import type { SessionSnapshot } from "./job-owner.ts";
import { removeJob } from "./stores.ts";
import type { Stores } from "./stores.ts";
import type { RunList } from "./run-list.ts";
import { DISABLED_BY_PERSON, MAX_PROMPT_BYTES, type JobStore, type LoopJob, type RunRecord, newId, owningSessionId, resolveJobRef } from "./store.ts";
import type { RequestStore, Row } from "./requests.ts";
import type { Inbox } from "./inbox.ts";
import { jobNameFrom } from "./job-name.ts";
import { asleepNote, ownerSession, runsSomewhere, whereRuns, type OwnerView } from "./job-owner.ts";
import { inProject } from "./inbox.ts";
import { plural } from "./plural.ts";
import { sameProject, withinProject } from "./paths.ts";
import { type TriggerStore, auditRule, cleanCondition, controlPlanePreflight, looksLikeFixedScheduleRequest, parseTriggerRule, resolveRuleRef, type DynamicTriggerRule } from "./triggers.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { capWords } from "./guard.ts";
import { WATCH_ASK_HEAD } from "./watch-plan.ts";
import { type ClockStore, WAKE_NOTE_MAX, WAKE_RUNS_PER_DAY, decideWake, wakeSetText } from "./clock.ts";

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
	stores: Stores;
	runs?: RunList;
	rules: TriggerStore;
	/** How often the rules are checked, in seconds (`[triggers] poll_interval_secs`). */
	pollSecs(): number;
	session(): SessionSnapshot;
	owner(): OwnerView;
	createJob(input: CreateJobInput, scope?: JobScope): Promise<LoopJob>;
	/** The cron_control_plane audit; returns the entry id. */
	cronControlAudit(op: "add" | "enable" | "disable" | "remove", actor: "slash" | "tool" | "sub-agent", before?: LoopJob, after?: LoopJob): string;
	/** The confirmation gate; resolves to a denial text or undefined (allowed). */
	confirmTool(ctx: ExtensionContext, req: ControlPlaneRequest, atHop: number): Promise<string | undefined>;
	refreshBadge(): void;
	/** Make sure the host is up now that there is a loop or a rule for it. Absent in the host itself. */
	ensureHost?(): void;
	/**
	 * A turn pi-loops started for a scheduled job or a delivery, in an open window or held in a closed
	 * conversation: nobody may be there, so `cron_create` creates at once and refuses a gate, and
	 * `new_trigger` proposes (design 2.5). Absent where no such turn runs.
	 */
	scheduledTurn?(): boolean;
}

/**
 * Whose turn a window's control-plane call is in. A scheduled turn is `seated` when the window's
 * guard has a seat for it (src/window-executor.ts `windowGuard`): the guard judged the call there.
 */
export type ConfirmTurn = { kind: "person" } | { kind: "scheduled"; seated: boolean };

/**
 * The window's `confirmTool`: the person's yes to a control-plane call at hop 0 (design 4, item 26).
 * In a scheduled turn with a guard seat, the guard asked a person in /inbox before the call could
 * run (src/guard.ts `CONTROL_PLANE_TOOLS`), so a call that reaches here carries their yes and nothing
 * more is asked. With no seat nobody was asked, and the call is refused in the words of a scheduled
 * turn nobody answered. In the person's own turn it is pi's confirm: the person is at the keyboard.
 * Before all of these, `controlPlanePreflight` refuses at hop 1 and, in the person's turn, with no
 * UI. undefined: approved; else what the tool tells the model.
 */
export async function confirmControlPlane(ctx: Pick<ExtensionContext, "hasUI" | "ui">, req: ControlPlaneRequest, atHop: number, turn: ConfirmTurn): Promise<string | undefined> {
	const denied = controlPlanePreflight({ hop: atHop, hasUI: ctx.hasUI || turn.kind === "scheduled" }, req.label);
	if (denied) return denied;
	if (turn.kind === "scheduled") return turn.seated ? undefined : `nobody answered in time: ${req.label}`;
	// The approval card: Action / Tool / Reason / Args hash / Preview, then a feed line per decision.
	const argsHash = createHash("sha256").update(JSON.stringify(req.args ?? null)).digest("hex").slice(0, 12);
	ctx.ui.notify(`approval required: ${req.label}`, "info");
	const card = [`Action: ${req.label}`, `Tool: ${req.tool}`, `Reason: ${req.reason}`, `Args hash: ${argsHash}`, `Preview: ${previewRedacted(req.preview, 200)}`].join("\n");
	const yes = await ctx.ui.confirm("Control-plane approval required", card);
	ctx.ui.notify(yes ? `approved control-plane action: ${req.label}` : `denied control-plane action: ${req.label} (denied by user)`, "info");
	return yes ? undefined : `user declined: ${req.label}`;
}

/** How many rule ids a `remove_trigger` target names before it names the rest by their digest. */
const TARGET_IDS_SHOWN = 5;

/**
 * Pure over the stores. What a control-plane call would change now, resolved as the tool resolves
 * it in the project of `cwd`, as one line: a job's id, name and schedule; a rule's id; for
 * `remove_trigger` with `all`, the count and the sorted ids (past `TARGET_IDS_SHOWN`, a digest of
 * them all). The guard folds it into the call's identity (src/guard.ts `ToolCallFacts.target`), so
 * a yes runs only on the target the person saw. undefined for any other tool.
 */
export function controlTarget(host: Pick<ToolHost, "stores" | "rules">, tool: string, input: unknown, cwd: string): string | undefined {
	const params = (input ?? {}) as { ref?: unknown; id?: unknown; all?: unknown };
	if (tool === "cron_remove" || tool === "set_cron_job_state") {
		const job = typeof params.ref === "string" ? resolveJobRefScoped(jobsOf(host).load(), params.ref, cwd) : undefined;
		if (!job) return "no job matches";
		// The target is part of what a yes binds to, and the window and pi-loops in the background may
		// run in different time zones. The job's id says which job it is; a one-shot's time, which reads
		// differently in each zone, is left out.
		const when = job.schedule.kind === "once" ? "once" : formatSchedule(job.schedule);
		return `job ${job.id} "${job.name ?? job.id}" ${when}`;
	}
	if (tool === "remove_trigger" && params.all === true) {
		const ids = host.rules.load().filter((r) => sameProject(r.cwd, cwd)).map((r) => r.id).sort();
		if (ids.length <= TARGET_IDS_SHOWN) return `${plural(ids.length, "rule")}${ids.length ? `: ${ids.join(", ")}` : ""}`;
		const digest = createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 12);
		return `${plural(ids.length, "rule")}: ${ids.slice(0, TARGET_IDS_SHOWN).join(", ")}, … (all ids sha256 ${digest})`;
	}
	if (tool === "remove_trigger" || tool === "set_trigger_state") {
		const rule = typeof params.id === "string" ? resolveRuleRefScoped(host.rules.load(), params.id, cwd) : undefined;
		return rule ? `rule ${rule.id}` : "no rule matches";
	}
	return undefined;
}

type ToolStoresHost = Pick<ToolHost, "stores">;
const jobsOf = (host: ToolStoresHost): JobStore => host.stores.jobs;
const requestsOf = (host: ToolStoresHost): RequestStore => host.stores.requests;
const inboxOf = (host: ToolStoresHost): Inbox => host.stores.inbox;
const ownerOf = (host: Pick<ToolHost, "owner">) => host.owner();

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
	/** A watch the person has not said yes to (design 2.5): written with `enabled: false`. */
	proposed?: { at: string; session: string };
	/** A loop's gate (design 3.3): a person's `--gate`, a recipe's key, or a proposal's, which the person sees on the card. */
	gate?: { kind: "command"; command: string };
}

export interface JobScope {
	parentSessionId?: string;
	parentCwd?: string;
	/** The loop belongs to its project, not a conversation: one made where no saved conversation is (recipe.ts installScope). */
	projectOwned?: true;
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

/** A rule by ref, preferring this project's; another project's needs its exact id. */
export function resolveRuleRefScoped(rules: DynamicTriggerRule[], ref: string, cwd: string): DynamicTriggerRule | undefined {
	// Ordinals are what the user sees in `/triggers rules`; a model's list may be a different one,
	// so the tools take an id, a unique prefix or a name — never a position. That is the resolver's
	// default: no caller here printed a numbered list, so none of them asks for one.
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
	if (!/^[\p{L}\p{N}._-]{1,40}$/u.test(name)) throw new Error("name must be 1-40 chars of letters, digits, . _ -");
	if (existing.some((j) => j.name === name)) throw new Error(`a cron job named "${name}" already exists`);
}

/** `/cron add` and `cron_create`: validate, fill the defaults, record who created it and where. */
/** The tools a job was asked for and does not have: built-ins the chat making it lacks. */
export function toolsDropped(asked: readonly string[] | undefined, kept: readonly string[] | undefined): string[] {
	return (asked ?? []).filter((t) => !(kept ?? []).includes(t));
}

/**
 * Everything a job is refused for, with nothing written: the checks `createLoopJob` runs before it
 * builds the job, in one place so a person is never asked about a job their yes cannot make.
 * Returns the directory the job would run in.
 */
export function checkJobInput(input: Pick<CreateJobInput, "schedule" | "prompt" | "stateful" | "name" | "cwd">, existing: LoopJob[], session: Pick<SessionSnapshot, "sessionId" | "cwd">): string {
	if (!input.prompt.trim()) throw new Error("cron action cannot be empty");
	if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error(`cron action exceeds ${MAX_PROMPT_BYTES} bytes`);
	// An expression can parse and still never match ("0 0 30 2 *"): the job would go quiet with
	// nothing to see, and every scan for its next run walks the whole lookahead window. `/cron set`
	// has refused this since it existed (job-edit.ts); creation did not. Only cron expressions are
	// asked: a `once` schedule whose time has passed has no next run because it is due now.
	if (input.schedule.kind === "cron" && computeNext({ schedule: input.schedule, createdAt: Date.now() }, Date.now()) === undefined) {
		throw new Error(`${formatSchedule(input.schedule)} has no next run`);
	}
	checkJobName(input.name, existing);
	if (!input.stateful && !session.sessionId) throw new Error("a non-stateful cron job needs a persistent chat session to inject into (not --no-session, not a background process); use stateful=true");
	return resolveJobCwd(session.cwd, input.cwd);
}

export async function createLoopJob(host: ToolStoresHost & Pick<ToolHost, "session" | "ensureHost">, input: CreateJobInput, scope?: JobScope): Promise<LoopJob> {
	const existing = jobsOf(host as ToolHost).load();
	const cwd = checkJobInput(input, existing, host.session());
	const gateWhy = input.gate ? (input.stateful ? gateCommandWhy(input.gate.command, { loopsDir: host.stores.dir }) : "a gate is for a loop: a plain job's turn is not gated") : undefined;
	if (gateWhy) throw new Error(gateWhy);
	const job: LoopJob = {
		id: newId("cron"),
		name: input.name ?? jobNameFrom(input.prompt, existing),
		schedule: input.schedule,
		stateful: input.stateful,
		prompt: input.prompt,
		cwd,
		// Captured now for a loop: it runs in the background, which may be on another model. A plain
		// job runs in its conversation, on whatever model that conversation is on when it fires.
		model: input.model ?? (input.stateful ? host.session().model : undefined),
		thinking: input.thinking ?? (input.stateful ? host.session().thinking : undefined),
		// Named tools may not add a built-in tool the chat (or the run) making it does not have. Trimmed,
		// as 0.22 did, and said by the caller (`toolsDropped`): refusing would fail a recipe's install.
		tools: input.tools && host.session().builtinTools ? input.tools.filter((t) => !PI_BUILTIN_TOOL_NAMES.includes(t) || host.session().builtinTools!.includes(t)) : input.tools,
		// The loop's declared tools: those of the chat it is made in, unless it names its own.
		builtinTools: input.tools ? undefined : host.session().builtinTools,
		enabled: !input.proposed,
		verify: input.stateful && input.verify ? true : undefined,
		checkerModel: input.stateful && input.verify ? input.checkerModel : undefined,
		catchUp: input.catchUp ?? input.stateful,
		timeoutMs: input.timeoutMs,
		recipe: input.recipe,
		createdAt: stamp(),
		// A sub-agent schedules on behalf of the session that runs it.
		...(scope?.projectOwned ? { owner: "project" as const } : { createdBy: { sessionId: scope?.parentSessionId ?? host.session().sessionId, cwd: scope?.parentCwd ?? host.session().cwd } }),
		sessionId: owningSessionId(input.stateful, host.session().sessionId, scope?.parentSessionId),
		...(input.proposed ? { proposed: input.proposed } : {}),
		...(input.stateful && input.gate ? { gate: { kind: "command" as const, command: input.gate.command } } : {}),
	};
	await jobsOf(host).add(job);
	if (job.stateful) host.ensureHost?.();
	return job;
}


const deny = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true, details: { id: undefined as string | undefined } });

/** `cron_create` says it at hop 0, where a person's message can arrive: the page's Watch box sends `Watch for: <sentence>` as a chat message, and only the question the create tools ask may answer it. Said once: both tools are in the same list. */
const WATCH_SENTENCE = " A message that starts with `Watch for:` comes from the page's Watch box: answer it with one of these two tools (new_trigger or cron_create); if it names no time and nothing to wait for, call neither, do nothing, and say it reads like something to do now. Never do the action of a `Watch for:` message yourself.";

/**
 * Whose turn calls a create tool (design 2.5): the person's own at hop 0 with a UI; the person's own
 * in a pi with no UI (`pi -p`), where nobody could answer a proposal; a scheduled or held turn, which
 * pi-loops started and nobody may be watching; or a sub-agent's run at hop 1.
 */
type CreateTurn = "person" | "no-ui" | "unattended" | "sub-agent";
function turnOf(scope: ToolScope, host: ToolHost, ctx: Pick<ExtensionContext, "hasUI"> | undefined): CreateTurn {
	if (scope.hop > 0) return "sub-agent";
	if (host.scheduledTurn?.()) return "unattended";
	return ctx?.hasUI ? "person" : "no-ui";
}

/** Where a create tool makes a job at once, a gate is refused whole: only a person sets one (design 3.3). */
export const GATE_NEEDS_PERSON = "a gate needs a person: set it with /cron set <name> --gate";

/** The same for a rule, which `/cron set` cannot reach: a rule's gate is set only from a proposal the person answers. */
export const RULE_GATE_NEEDS_PERSON = "a gate needs a person: new_trigger with a gate proposes the rule, and the person sets it up";

const GATE_DESCRIPTION = "Optional: one shell command looked at before each run, at most once a minute, in the watch's directory (5 s, its first 4000 characters of output). While it prints what the last run saw, no model is called. Only when the watch is proposed to a person, who sees the command on the card; refused anywhere the tool creates at once. Use a cheap, read-only command whose output changes exactly when there is something new (gh pr list --json number,updatedAt).";

/** A gate a create tool was given, or why it cannot be one: the whole check, against this loops directory, before the card shows it. */
function gateOf(command: string, loopsDir: string): { kind: "command"; command: string } | string {
	const why = gateCommandWhy(command, { loopsDir });
	return why ?? { kind: "command", command };
}

/** A proposal waits in a conversation for its answer, and its receipt lands there: one pi has not saved has no lane for either. */
const NO_CONVERSATION = "a watch is proposed in a saved conversation, and this one is not saved (--no-session): /cron add or /new-trigger in a saved one sets it up";

/** What the model reads for a proposal (design 6.3): nothing runs, and a message here will say what the person chose. */
function proposedText(what: string): string {
	return `proposed ${what}: the person sees a card ("${WATCH_ASK_HEAD}"). Nothing runs until they say yes. Do not wait for the answer, do not do the action now, and do not call this tool again for it. A message here tells you what they chose.`;
}

/** What `set_cron_job_state` and `set_trigger_state` say of a proposal: only the person's answer sets it up. */
function proposedRefusal(label: string, ask: string): string {
	return `${label} is proposed and waits for the person's yes: only their answer sets it up (${ask} asks again)`;
}

/**
 * What a create result adds while nothing runs in the background, so the model does not tell the person
 * that a paused job will run. The same reason `cron_list` shows, and both ways to end it.
 */
function pausedLine(reason: string | undefined): string {
	return reason ? `\nPAUSED: ${reason}. Nothing runs in the background until pi-loops starts again: /pi-loops start in pi, or pi-loops start in a shell.` : "";
}

/** Trigger rules, rendered for a tool result. */
function renderTriggerRulesForTool(rules: ReturnType<TriggerStore["load"]>, host: Pick<ToolHost, "session">): string {
	if (!rules.length) return "dynamic trigger rules: none";
	return [`dynamic trigger rules: ${rules.length}`, ...rules.map((r) => `- ${r.id} [${r.proposed ? "proposed" : r.enabled ? "enabled" : "disabled"}, ${r.fireOnce ? "fire_once" : "repeat"}, ${r.promoteToChat ? "promote_to_chat" : "audit_only"}] created_at=${r.createdAt} condition: ${previewRedacted(r.condition, 200)} action: ${previewRedacted(r.action, 200)}${r.cwd !== host.session().cwd ? ` cwd: ${r.cwd}` : ""}`)].join("\n");
}

/**
 * When the job next runs, or undefined: disabled, or a plain job that is asleep or paused. A next
 * run for a job nothing will dispatch is a time nothing intends to keep, and a model reads it as a
 * promise; one held by another window is shown, with the pid it runs in.
 */
function nextRunForTool(job: ListedJob, now: number, view: OwnerView): number | undefined {
	if (!job.enabled || !runsSomewhere(job, view)) return undefined;
	// The one next-run function /cron, the page and wake_me read, so cron_list agrees with them.
	return nextRunAt({ schedule: job.schedule, createdAt: job.createdAt, fired: job.status.fired, quietUntil: job.status.quiet?.until }, now);
}

/** A plain job's prompt waiting in its conversation's queue (src/engine.ts `queuedPrompt`); a loop has no queue. */
function queuedForTool(job: ListedJob, host: Pick<ToolHost, "stores">, now: number): QueuedPrompt | undefined {
	return !job.stateful && job.sessionId ? queuedPrompt(job, requestsOf(host).list(job.sessionId), now) : undefined;
}

/** The run a job is in, for a tool result: a loop's marker, or the claim on a plain job's row. */
function runningRunForTool(job: ListedJob, host: Pick<ToolHost, "stores">): string | undefined {
	return runningRun(job, !job.stateful && job.sessionId ? requestsOf(host).list(job.sessionId) : []);
}

/** Cron jobs, rendered for a tool result. */
function renderCronJobsForTool(jobs: readonly ListedJob[], host: Pick<ToolHost, "session" | "stores" | "owner">): string {
	if (!jobs.length) return "cron jobs: none";
	const now = Date.now();
	const lines = [`cron jobs: ${jobs.length}`];
	// Read once for the listing, as `/cron` does; only loops have a signal to report.
	const runs = jobs.some((j) => j.stateful) ? jobsOf(host).allRuns() : [];
	const inbox = jobs.some((j) => j.stateful) ? inboxOf(host).list() : [];
	for (const job of jobs) {
		lines.push(`- ${job.id}${job.name ? ` "${job.name}"` : ""} [${job.proposed ? "proposed" : job.enabled ? "enabled" : "disabled"}${job.stateful ? ", stateful" : ""}${job.verify ? ", verify" : ""}] schedule: ${formatSchedule(job.schedule)} action: ${previewRedacted(job.prompt, 120)}${job.cwd !== host.session().cwd ? ` cwd: ${job.cwd}` : ""}`);
		const view = ownerOf(host);
		const asleep = asleepNote(job, view);
		const kind = whereRuns(job, view).kind;
		if (asleep) lines.push(`  ${asleep}${kind === "asleep" ? " (no next run here)" : kind === "paused" ? " (no next run until pi-loops starts again)" : kind === "aside" ? "" : " (runs there, not here)"}`);
		const next = nextRunForTool(job, now, view);
		if (next) lines.push(`  next_run: ${stamp(next)}`);
		const run = runningRunForTool(job, host);
		if (run) lines.push(`  running_run_id: ${run}`);
		const queued = queuedForTool(job, host, now);
		if (queued) lines.push(`  queued: ${formatWait(now - Date.parse(queued.since))} (since ${queued.since})${queued.reason ? ` — ${queued.reason}` : ""}`);
		// The fact `/cron` says under the job, as a field (design 6.8): last_error, note or queued.
		const word = statusWord(job, now, next);
		if (word) lines.push(`  ${statusField(word, now)}`);
		if (job.status.streak) lines.push(`  consecutive_failures: ${job.status.streak}`);
		if (job.status.collapsed) lines.push(`  skipped_overlap_count: ${job.status.collapsed}`);
		for (const field of wakeFields(job, now)) lines.push(`  ${field}`);
		for (const field of gateFields(job)) lines.push(`  ${field}`);
		if (job.stateful) {
			// The same two facts `/cron` shows, so the model can say "this loop's findings are all
			// dismissed" or "it has found nothing in 12 runs" when the user asks about their automation.
			const s = loopSignal(job.id, runs, inbox, now - SIGNAL_WINDOW_MS);
			if (s.findings) lines.push(`  signal_30d: findings=${s.findings} claimed=${s.claimed} dismissed=${s.dismissed}`);
			if (s.quiet >= QUIET_MARK_AFTER) lines.push(`  quiet_streak: ${s.quiet} (consecutive runs with no finding)`);
		}
	}
	// Each line through `plainLine` as its last step, as `/cron` does: a field added later is cleaned too.
	return lines.map(plainLine).join("\n");
}

/** A rule made at once, as `new_trigger` made one before proposals: the person's own turn with no UI, after `confirmTool`. */
async function addRule(host: ToolHost, input: Parameters<TriggerStore["add"]>[0]) {
	const rule = await host.rules.add(input);
	host.refreshBadge();
	host.ensureHost?.();
	return {
		content: [{ type: "text" as const, text: `created dynamic trigger ${rule.id}\ncondition: ${rule.condition}\naction: ${rule.action}\nfire_once: ${rule.fireOnce}\npromote_to_chat: ${rule.promoteToChat}\n(checked every ${host.pollSecs()}s by a sub-agent in the background)${pausedLine(ownerOf(host).hostPaused)}` }],
		details: { id: rule.id as string | undefined, condition: rule.condition, action: rule.action, enabled: rule.enabled, fire_once: rule.fireOnce, fired_at: rule.firedAt, promote_to_chat: rule.promoteToChat },
	};
}

/** P1 for a rule (design 2.5): the proposal, one write under the store's lock, then the audit line `add`. `new_trigger` creates nothing else. */
async function proposeRule(host: ToolHost, scope: ToolScope, input: Parameters<TriggerStore["add"]>[0]) {
	const rule = await host.rules.add(input);
	auditRule(host.rules, "add", scope.actor, rule);
	host.refreshBadge();
	return {
		content: [{ type: "text" as const, text: proposedText(`dynamic trigger ${rule.id}`) }],
		details: { id: rule.id as string | undefined, condition: rule.condition, action: rule.action, enabled: rule.enabled, proposed: true, fire_once: rule.fireOnce, fired_at: rule.firedAt, promote_to_chat: rule.promoteToChat },
	};
}

/** The job, made: the one write both ways to `cron_create` end in, and the text the model reads on every surface. */
async function createCron(host: ToolHost, scope: ToolScope, input: CreateJobInput) {
	const job = await host.createJob(input, scope);
	const auditEntryId = host.cronControlAudit("add", scope.actor, undefined, job);
	host.refreshBadge();
	const next = computeNext({ schedule: job.schedule, createdAt: Date.parse(job.createdAt) }, Date.now());
	// The model tells the person, so it has to know the costs a person would otherwise hear in /cron add.
	const tools = job.tools ? `the tools ${job.tools.join(", ")}` : job.builtinTools ? `this chat's built-in tools (${job.builtinTools.join(", ") || "none"})` : "pi's default tools";
	const where = job.stateful
		? `Findings will appear in /inbox${job.verify ? " after an independent checker reviews them" : ""}. It runs in the background with ${tools}, not this window's -e extensions or flags.`
		: `Its result will appear in this chat. While this chat is closed it still runs, in the background, and each run is a model turn. Its turns run with ${tools} under the dangerous-command guard. ${capWords(job).model} In the background they also run without this window's -e extensions or flags.`;
	const runsAt = whereRuns(job, ownerOf(host));
	// Three lines — what was created, when it runs, what it will do — then where its output goes.
	return {
		content: [{ type: "text" as const, text: `created cron job ${job.id}${job.name ? ` "${job.name}"` : ""}\nschedule: ${formatSchedule(job.schedule)}\naction: ${previewRedacted(job.prompt, 120)}\n${job.stateful ? "[stateful] " : ""}next run ${next ? stamp(next) : "—"}. ${where}${pausedLine(runsAt.kind === "paused" ? runsAt.reason : undefined)}` }],
		details: { id: job.id as string | undefined, name: job.name, schedule: formatSchedule(job.schedule), action: job.prompt, enabled: job.enabled, stateful: job.stateful, verify: job.verify ?? false, scope: job.stateful ? "machine" : "session", owner_session: ownerSession(job), next_run: next ? stamp(next) : undefined, audit_entry_id: auditEntryId },
	};
}

export interface ToolScope {
	hop: number;
	actor: "tool" | "sub-agent";
	parentSessionId?: string;
	parentCwd?: string;
}
// Every call of these is a prompt-class operation, denied at hop > 0 (controlPlanePreflight): a
// tool that can only fail is one an agent tries first.
const HOP0_ONLY = new Set(["new_trigger", "remove_trigger", "cron_remove"]);

/**
 * The cron/trigger tools are registered in sub-agents too (Prompt-class ones are denied there)
 * and bounds cycles with a hop count. The same definitions serve the interactive session
 * (hop 0, registered with pi) and every in-process sub-session (hop 1, passed as customTools).
 */

export function automationTools(scope: ToolScope, host: ToolHost): ToolDefinition<any, any>[] {
	const defs: ToolDefinition<any, any>[] = [];
	// Only where a person's message can arrive: a sub-agent is told nothing about it.
	const watchSentence = scope.hop === 0 ? WATCH_SENTENCE : "";
	// Generic so each definition keeps its inferred parameter type, exactly as pi.registerTool does.
	const register = <T extends TSchema, D>(d: ToolDefinition<T, D>): void => void defs.push(d as ToolDefinition<any, any>);
	register({
		name: "new_trigger",
		label: "Create trigger",
		description:
			"Create an event/condition-based dynamic trigger rule. Use this for future events such as a browser tab, file, MCP notification, webhook, or other condition becoming true. Do not use this for fixed time, recurring, scheduled, hourly, daily, weekly, cron, crontab, 定时任务, 每小时, or similar time-based jobs; use cron_create instead.",
		parameters: Type.Object(
			{
				condition: Type.String({ description: "The natural-language condition that should be evaluated against future trigger events. For 'when <path> exists', keep the person's words: '<path> exists', with nothing added (no aside in parentheses) — a condition like that is checked with a local stat, no model call, while the path is absent." }),
				action: Type.String({ description: "The action to perform when the condition matches. This may be a shell command or a natural-language instruction." }),
				spec: Type.Optional(Type.String({ description: "The whole rule as one sentence, only when condition and action cannot be given apart." })),
				fire_once: Type.Optional(Type.Boolean({ description: "Whether to disable the rule after the first successful match. Defaults to true unless the user explicitly asks for a repeating trigger." })),
				promote_to_chat: Type.Optional(Type.Boolean({ description: "Whether a match's result goes into this conversation (true) or the inbox (false). With a person present the question starts at this conversation whatever this says; with nobody to ask, the default is false." })),
				gate: Type.Optional(Type.String({ description: GATE_DESCRIPTION })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let condition = cleanCondition(params.condition ?? "");
			let action = params.action?.trim() ?? "";
			const fromSpec = !condition || !action;
			if (fromSpec) {
				if (!params.spec) return deny("missing required args: provide condition and action");
				// On the raw spec, so a schedule it cannot split ("every day at 9:00 remind me") gets the cron pointer, not the split error.
				if (looksLikeFixedScheduleRequest(params.spec)) return deny("fixed scheduled jobs must use cron_create, not new_trigger");
				try {
					({ condition, action } = parseTriggerRule(params.spec));
				} catch (err: any) {
					return deny(err?.message ?? String(err));
				}
			}
			// The condition alone is where a schedule request lives: an action that names a routine ("post the daily report") is never one.
			if (!fromSpec && looksLikeFixedScheduleRequest(params.condition ?? "")) return deny("fixed scheduled jobs must use cron_create, not new_trigger");
			const s = host.session();
			const turn = turnOf(scope, host, ctx);
			const gate = params.gate === undefined ? undefined : gateOf(params.gate, host.stores.dir);
			if (typeof gate === "string") return deny(gate);
			// A gate needs a person (design 3.3): only a proposal, which they see on the card, carries one.
			if (gate && turn === "no-ui") return deny(RULE_GATE_NEEDS_PERSON);
			if (turn === "no-ui") {
				// Nobody could answer a proposal here: the rule is asked for as before proposals, with
				// `confirmTool`, which a pi with no UI refuses.
				const reason = fromSpec ? "create dynamic trigger from `spec` field" : "create dynamic trigger from `condition` + `action` fields";
				const denied = await host.confirmTool(ctx, { label: "create dynamic trigger", tool: "new_trigger", reason, preview: `when ${previewRedacted(condition, 80)} -> ${previewRedacted(action, 80)}`, args: params }, scope.hop);
				if (denied) return deny(denied);
				return addRule(host, { condition, action, cwd: s.cwd, sessionId: s.sessionId, model: s.model, thinking: s.thinking, fireOnce: params.fire_once ?? true, promoteToChat: params.promote_to_chat ?? false });
			}
			if (!s.sessionId) return deny(NO_CONVERSATION);
			// A proposal: in the person's own turn and in a scheduled or held one alike, a rule runs only
			// after the person says yes. Its defaults are the question's first option: in the person's own
			// turn Result starts at this conversation whatever `promote_to_chat` said (its documented
			// default is not a choice anyone made); Repeats follows `fire_once`.
			const promoteToChat = turn === "person" ? true : (params.promote_to_chat ?? false);
			return proposeRule(host, scope, { condition, action, cwd: s.cwd, sessionId: s.sessionId, model: s.model, thinking: s.thinking, fireOnce: params.fire_once ?? true, promoteToChat, proposed: { at: stamp(), session: s.sessionId }, ...(gate ? { gate } : {}) });
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
			const all = host.rules.load();
			// A sub-agent never gets the machine-wide view: nobody is there to have asked for it.
			const rules = params.all_projects && scope.hop === 0 ? all : all.filter((r) => sameProject(r.cwd, cwd));
			return { content: [{ type: "text", text: renderTriggerRulesForTool(rules, host) }], details: { count: rules.length, scope: params.all_projects && scope.hop === 0 ? "machine" : cwd, rules, storage_path: host.rules.rulesFile } };
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
				const denied = await host.confirmTool(ctx, { label: "remove ALL dynamic triggers", tool: "remove_trigger", reason: "remove every dynamic trigger rule of this project (`all` flag)", preview: `${host.rules.load().filter((r) => sameProject(r.cwd, cwd)).length} rule(s)`, args: params }, scope.hop);
				if (denied) return err(denied);
				const n = await host.rules.clear(cwd, sameProject);
				return { content: [{ type: "text", text: `removed ${n} dynamic trigger rule(s)` }], details: { removed_count: n } };
			}
			if (!params.id) return err("missing required arg: id");
			const rule = resolveRuleRefScoped(host.rules.load(), params.id, host.session().cwd);
			if (!rule) return err(`no dynamic trigger rule with id '${params.id}'; list_triggers shows the ids`);
			const denied = await host.confirmTool(ctx, { label: `remove dynamic trigger ${rule.id}`, tool: "remove_trigger", reason: "remove a dynamic trigger rule by `id`", preview: `when ${previewRedacted(rule.condition, 120)}`, args: params }, scope.hop);
			if (denied) return err(denied);
			await host.rules.remove(rule.id);
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
			const rule = resolveRuleRefScoped(host.rules.load(), params.id, ruleCwd);
			if (!rule) return deny(`no dynamic trigger rule with id '${params.id}'; list_triggers shows the ids`);
			if (rule.proposed) return deny(proposedRefusal(`dynamic trigger ${rule.id}`, `/triggers enable ${rule.id}`));
			// Re-enabling is gated; pausing another project's rule is just as much a surprise, so it
			// is gated too (a sub-agent is refused outright, having nobody to ask).
			if (params.enabled || rule.cwd !== ruleCwd) {
				const denied = await host.confirmTool(ctx, { label: `${params.enabled ? "re-enable" : "disable"} dynamic trigger ${rule.id}`, tool: "set_trigger_state", reason: params.enabled ? "re-enable a dynamic trigger rule (`enabled` = true); it will fire again" : "disable a dynamic trigger rule of another project", preview: `when ${previewRedacted(rule.condition, 120)}`, args: params }, scope.hop);
				if (denied) return deny(denied);
			}
			const updated = (await host.rules.setEnabled(rule.id, params.enabled)) ?? rule;
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
			"Create a scheduled job. Use when the user asks for a fixed time, recurring, scheduled, hourly, daily, weekly, crontab, 定时任务, 每小时, 每天, or similar time-based job. Jobs persist across pi restarts. A plain job runs its prompt in this chat when due. Set stateful=true for loop mode: a fresh sub-agent runs it, keeps persistent notes across runs (injected each time), and routes findings to the user's /inbox instead of the chat — use that for recurring watch/triage jobs like \"check for new issues and report only what changed\"." + watchSentence,
		parameters: Type.Object({
			schedule: Type.String({
				description: 'Local-time schedule: 5-field cron ("0 9 * * *", "*/30 * * * 1-5"), "hourly", "daily" (09:00), "weekly" (Monday 09:00), "@daily" (midnight), "every 30m", "in 10m", or "at 2026-09-08T18:00".',
			}),
			action: Type.String({ description: "Natural-language instruction to run when the schedule is due. For stateful jobs, write it for a fresh agent whose only memory is its own notes." }),
			stateful: Type.Optional(Type.Boolean({ description: "Loop mode: sub-agent + notes between runs + findings to the inbox. With a person present the question starts at the inbox unless this is false; with nobody to ask, the default is false." })),
			verify: Type.Optional(Type.Boolean({ description: "Maker/checker: a second adversarial sub-agent verifies each finding before it enters the inbox (stateful jobs only, default false). Use when the user asks for verified, double-checked, or high-precision findings." })),
			name: Type.Optional(Type.String({ description: "Short unique label (letters, digits, . _ -)." })),
			cwd: Type.Optional(Type.String({ description: "Directory a stateful job's sub-agent runs in. Default: current project." })),
			catch_up: Type.Optional(Type.Boolean({ description: "Run once for a missed tick (default: true for stateful jobs, false for plain jobs)." })),
			gate: Type.Optional(Type.String({ description: GATE_DESCRIPTION })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let schedule: LoopJob["schedule"];
			try {
				schedule = parseSchedule(params.schedule);
			} catch (err: any) {
				return deny(err?.message ?? String(err));
			}
			const turn = turnOf(scope, host, ctx);
			// A gate needs a person (design 3.3): accepted only in the person's own turn, where the call
			// writes a proposal and the card shows the command. Anywhere the tool creates at once the call
			// is refused whole, and nothing is created.
			if (params.gate !== undefined && turn !== "person") return deny(GATE_NEEDS_PERSON);
			const gate = params.gate === undefined ? undefined : gateOf(params.gate, host.stores.dir);
			if (typeof gate === "string") return deny(gate);
			if (turn === "person") {
				// P1 (design 2.5): a proposal, which nothing runs until the person says yes. A schedule's
				// Result starts at the inbox (a loop) unless the model said plainly that it belongs in this
				// chat. Checked now as a create would be, so the person is never asked about a job their yes
				// cannot make.
				const s = host.session();
				if (!s.sessionId) return deny(NO_CONVERSATION);
				// A gate is a loop's: a gated watch starts at the inbox, and its card offers no plain job.
				const where = params.stateful === false && !params.verify && !gate ? "chat" : "inbox";
				const draft = { schedule, prompt: params.action, verify: params.verify ?? false, name: params.name, catchUp: params.catch_up, ...(gate ? { gate } : {}) };
				let cwd: string;
				try {
					cwd = checkJobInput({ ...draft, stateful: where === "inbox", cwd: params.cwd }, jobsOf(host).load(), s);
				} catch (err: any) {
					return deny(err?.message ?? String(err));
				}
				// The question is the consent, and it does not show a directory: a job it sets up runs in
				// this project, so a `cwd` elsewhere (a prompt-injected one, say) is refused here.
				if (!withinProject(s.cwd, cwd)) return deny(`a watch you are asked about runs in this project (${s.cwd}): cwd ${cwd} is outside it; /cron add --cwd sets one up elsewhere`);
				// The model and thinking are captured now whatever the first option: the answer may make it a loop, which runs in the background.
				const job = await host.createJob({ ...draft, cwd, stateful: where === "inbox", model: s.model, thinking: s.thinking, proposed: { at: stamp(), session: s.sessionId } }, scope);
				const auditEntryId = host.cronControlAudit("add", scope.actor, undefined, job);
				host.refreshBadge();
				return {
					content: [{ type: "text" as const, text: proposedText(`cron job ${job.id}${job.name ? ` "${job.name}"` : ""}`) }],
					details: { id: job.id as string | undefined, name: job.name, schedule: formatSchedule(job.schedule), action: job.prompt, enabled: false, proposed: true, stateful: job.stateful, verify: job.verify ?? false, audit_entry_id: auditEntryId },
				};
			}
			// verify implies a loop: a checker only reviews loop findings (`args.ts` does the same for `--verify`)
			return createCron(host, scope, { schedule, prompt: params.action, stateful: params.stateful ?? params.verify ?? false, verify: params.verify ?? false, name: params.name, cwd: params.cwd, catchUp: params.catch_up });
		},
	});

	register({
		name: "cron_list",
		label: "List cron jobs",
		description: "List the current project's scheduled jobs with schedule, next run, [stateful] marker and last error. A plain job whose prompt is waiting in its conversation's queue reports `queued` (since when, and the wait reason when the queue says one). Also reports how many unread inbox findings exist. Set all_projects only when the user asks about other projects.",
		parameters: Type.Object({
			all_projects: Type.Optional(Type.Boolean({ description: "Include jobs of every project on this machine (default false)." })),
		}),
		async execute(_id, params) {
			const listCwd = host.session().cwd;
			const everywhere = params.all_projects === true && scope.hop === 0;
			const all = listedJobs(host.stores);
			const jobs = everywhere ? all : all.filter((j) => sameProject(j.cwd, listCwd));
			const newFindings = everywhere ? inboxOf(host).newCount() : inProject(inboxOf(host).listNew(), listCwd, sameProject).length;
			const text = `${renderCronJobsForTool(jobs, host)}\ninbox: ${plural(newFindings, "new finding")}`;
			const nowMs = Date.now();
			const view = ownerOf(host);
			const nextRun = (j: ListedJob) => nextRunForTool(j, nowMs, view);
			const heldBy = (j: ListedJob) => { const where = whereRuns(j, view); return where.kind === "terminal" ? where.pid : undefined; };
			return { content: [{ type: "text", text }], details: { count: jobs.length, scope: everywhere ? "machine" : listCwd, storage_path: jobsOf(host).jobsFile, jobs: jobs.map((j) => ({ id: j.id, name: j.name, schedule: formatSchedule(j.schedule), action_preview: previewRedacted(j.prompt, 120), enabled: j.enabled, proposed: j.proposed ? true : undefined, stateful: j.stateful, verify: j.verify ?? false, cwd: j.cwd, running_run_id: runningRunForTool(j, host), last_due_at: j.status.due, last_fired_at: j.status.fired, last_completed_at: j.status.completed, last_error: j.status.error ? previewRedacted(j.status.error, 120) : undefined, consecutive_failures: j.status.streak || undefined, skipped_overlap_count: j.status.collapsed, next_wake: j.status.wake, quiet_until: j.status.quiet && Date.parse(j.status.quiet.until) > nowMs ? j.status.quiet : undefined, gate: j.status.gate && { ...j.status.gate, command: gateShown(j.status.gate.command), ...(j.status.gate.failing !== undefined ? { failing: gateShown(j.status.gate.failing) } : {}) }, next_run: (() => { const n = nextRun(j); return n ? stamp(n) : undefined; })(), owner_session: ownerSession(j), asleep: whereRuns(j, view).kind === "asleep" || undefined, held_by_pid: heldBy(j), queued: queuedForTool(j, host, nowMs), created_at: j.createdAt })) } };
		},
	});

	register({
		name: "cron_remove",
		label: "Remove cron job",
		description:
			"Remove a scheduled job by id or name. Use when the user asks to delete, remove, or clear a scheduled job, cron job, crontab entry, or 定时任务; the user is asked to confirm in the same call. Removal deletes the job itself; a loop's saved notes and run transcripts are kept on disk, and `/cron gc --purge` is what clears them.",
		parameters: Type.Object({
			ref: Type.String({ description: "Job id (for example cron-abc123), unique id prefix, or name." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const job = resolveJobRefScoped(jobsOf(host).load(), params.ref, host.session().cwd);
			if (!job) return { content: [{ type: "text", text: `no cron job matching '${params.ref}' in this project; cron_list shows the ids and names` }], isError: true, details: { id: undefined as string | undefined, removed_count: 0, audit_entry_id: undefined as string | undefined } };
			const label = job.name ? `"${job.name}"` : job.id;
			// The only control-plane tool that used to skip this gate, so a sub-agent (hop > 0) could
			// delete any project's job unapproved — and what that costs is the automation itself: the
			// loop stops running and its id is gone from jobs.json. Its notes and transcripts stay
			// behind (under an id nothing schedules any more; `/cron gc --purge` clears those), which
			// is why the gate is about what stops, not about data destroyed. The dialog shows the
			// schedule and the action: one question, where a preview call used to make it two.
			const denied = await host.confirmTool(ctx, { label: `remove cron job ${label}`, tool: "cron_remove", reason: "remove a scheduled job", preview: `${formatSchedule(job.schedule)} · ${previewRedacted(job.prompt, 120)}`, args: params }, scope.hop);
			if (denied) return { content: [{ type: "text", text: denied }], isError: true, details: { id: undefined as string | undefined, removed_count: 0, audit_entry_id: undefined as string | undefined } };
			const { aborted } = await removeJob(host.stores, host.runs, job.id);
			const auditEntryId = host.cronControlAudit("remove", scope.actor, job, undefined);
			// The slash command says where a loop's notes went; a tool-driven removal has to say it too,
			// or the person who asked the agent to delete a job is the only one left guessing. The prose
			// carries the fact and `details` carries the path, which is the division this tool already
			// uses elsewhere (`cron_list` reports `storage_path` the same way).
			const kept = job.stateful ? "\nits loop state and run transcripts are kept; /cron gc --purge clears them" : "";
			const abortedNote = aborted > 0 ? "\naborted its running run" : "";
			const statePath = job.stateful ? jobsOf(host).statePath(job.id) : undefined;
			return { content: [{ type: "text", text: `removed cron job ${label}\nschedule: ${formatSchedule(job.schedule)}\naction: ${previewRedacted(job.prompt, 120)}${kept}${abortedNote}` }], details: { id: job.id as string | undefined, removed_count: 1, audit_entry_id: auditEntryId, state_path: statePath } };
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
			const job = resolveJobRefScoped(jobsOf(host).load(), params.ref, jobCwd);
			if (!job) return deny(`no cron job matching '${params.ref}' in this project; cron_list shows the ids and names`);
			if (job.proposed) return deny(proposedRefusal(`cron job "${job.name ?? job.id}"`, `/cron enable ${job.name ?? job.id}`));
			if (params.enabled || job.cwd !== jobCwd) {
				const denied = await host.confirmTool(ctx, { label: `${params.enabled ? "enable" : "disable"} cron job ${job.name ?? job.id}`, tool: "set_cron_job_state", reason: params.enabled ? "enable a cron job from a model-facing tool (`enabled` = true)" : "disable a cron job of another project", preview: `${formatSchedule(job.schedule)}: ${previewRedacted(job.prompt, 120)}`, args: params }, scope.hop);
				if (denied) return deny(denied);
			}
			const at = stamp();
			const updated = (params.enabled ? await jobsOf(host).enable(job.id) : await jobsOf(host).disable(job.id, { code: "person", why: DISABLED_BY_PERSON, at })) ?? job;
			if (params.enabled) host.stores.clock.clear(job.id, at);
			const auditEntryId = host.cronControlAudit(params.enabled ? "enable" : "disable", scope.actor, job, updated);
			return {
				content: [{ type: "text", text: `updated cron job ${updated.id}\nstate: ${updated.enabled ? "enabled" : "disabled"}\nschedule: ${formatSchedule(updated.schedule)}\naction: ${previewRedacted(updated.prompt, 120)}` }],
				details: { id: updated.id as string | undefined, schedule: formatSchedule(updated.schedule), enabled: updated.enabled, stateful: updated.stateful, audit_entry_id: auditEntryId },
			};
		},
	});
	return scope.hop === 0 ? defs : defs.filter((d) => !HOP0_ONLY.has(d.name));
}

/** What `wake_me` reads and writes: the job whose run calls it, and nothing else. */
export interface WakeMeHost {
	/** The job whose run this is, from the runner's request: never from the model's input. */
	readonly jobId: string;
	readonly runId: string;
	job(): LoopJob | undefined;
	readonly clock: Pick<ClockStore, "read" | "setFollowup">;
	/** The run log, for the follow-ups of the last 24 hours. */
	runs(): readonly RunRecord[];
	/** The loop's lane (`requests/<lane>.jsonl`): the row this run claimed fires the schedule, as `/cron` reads it. */
	rows(): readonly Row[];
	now?(): number;
}

/**
 * `wake_me` (design 3.3): a loop sets one follow-up for itself. Offered in a loop's run only, whatever
 * the job's `--tools` say (src/sdk-runner.ts adds it); it writes `clock.json` and only for its job.
 */
export function wakeMeTool(host: WakeMeHost): ToolDefinition<any, any> {
	const definition: ToolDefinition<TSchema, { set: boolean; at?: string; quiet?: boolean }> = {
		name: "wake_me",
		label: "Wake this loop",
		description: `Run this loop once more at a time you choose, with a note of what to look at then. when: "in 20m", or "at 2026-11-16T09:00+08:00" (an ISO time with its offset); at least 60 seconds and at most 7 days ahead. note: at most ${WAKE_NOTE_MAX} characters; the run it starts reads it under [woken]. quiet: also skip this loop's scheduled runs before that time ("nothing before Monday"). One wake per loop: a second call replaces everything the first set. At most ${WAKE_RUNS_PER_DAY} runs in 24 hours start from wakes. A wake starts a new session: put what it needs in the note and your notes.`,
		parameters: Type.Object({
			when: Type.String({ description: '"in <duration>" (in 20m, in 2h) or "at <ISO time with its offset>"' }),
			note: Type.String({ description: `What to look at then, at most ${WAKE_NOTE_MAX} characters.` }),
			quiet: Type.Optional(Type.Boolean({ description: "Also skip this loop's scheduled runs before that time." })),
		}),
		async execute(_id, params) {
			const now = host.now?.() ?? Date.now();
			const job = host.job();
			if (!job || !job.stateful) return { content: [{ type: "text", text: "not set: this loop is no longer in the store." }], isError: true, details: { set: false } };
			const p = params as { when: string; note: string; quiet?: boolean };
			const stored = host.clock.read().jobs[job.id];
			// The run in flight fires the schedule when it starts, as `/cron` reads it (src/job-status.ts
			// `listedJob`): the next scheduled run counts from it, not from the last run that ended.
			const fired = listedJob(job, stored, host.rows(), undefined, (row) => row.run.id === host.runId).status.fired;
			const clock = stored ? { ...stored, fired } : fired === undefined ? undefined : { runs: 0, fired };
			const answer = decideWake({ when: String(p.when ?? ""), note: String(p.note ?? ""), quiet: p.quiet === true }, { job, clock, runs: host.runs(), now });
			if ("refused" in answer) return { content: [{ type: "text", text: answer.refused }], isError: true, details: { set: false } };
			const replaced = host.clock.setFollowup(job.id, { at: answer.at, note: answer.note, set_by: host.runId }, answer.quiet, now);
			return { content: [{ type: "text", text: wakeSetText(job, clock, answer, replaced, now) }], details: { set: true, at: answer.at, quiet: answer.quiet } };
		},
	};
	return definition as ToolDefinition<any, any>;
}
