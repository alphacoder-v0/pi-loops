/**
 * A watch from one sentence, as a plan: what `cron_create` and `new_trigger` return in a conversation
 * the page opened instead of creating anything, what the card shows, where a pending plan waits
 * (the desk, one per page child, in memory), and the one place the card's two choices become the
 * stores' fields (`settleWatch`). Pure, beside tools.ts, the job-edit.ts pattern: the extension
 * reads arguments, hands the desk and its writers in, and prints.
 */
import { createHash, randomBytes } from "node:crypto";
import { dangerousCommandReason } from "./danger.ts";
import { previewRedacted, redact } from "./redact.ts";
import { computeNext, formatDuration, formatLocal, formatSchedule, stamp } from "./schedule.ts";
import type { LoopJob } from "./store.ts";
import type { CreateJobInput } from "./tools.ts";
import type { DynamicTriggerRule, TriggerStore } from "./triggers.ts";

export type WatchWhere = "chat" | "inbox";
/** What the person cannot change on the card. `stateful` and `verify` follow the Result chip at apply time, so nothing holds the same choice twice. */
export type JobDraft = Omit<CreateJobInput, "stateful" | "recipe" | "id">;
export interface RuleDraft {
	condition: string;
	action: string;
	cwd: string;
	sessionId?: string;
	model?: string;
	thinking?: string;
}
export type WatchPlan =
	| { kind: "schedule"; job: JobDraft; where: WatchWhere }
	| { kind: "rule"; rule: RuleDraft; where: WatchWhere; once: boolean };

/** What the card shows, computed once here: the page parses no schedule. */
export interface WatchCard {
	kind: WatchPlan["kind"];
	/** "every day at 09:00" for a schedule; the condition for a rule. */
	when: string;
	/** A schedule's next run, in local time. */
	next?: string;
	/** A rule: how often the background looks (`[triggers] poll_interval_secs`). */
	looksEverySecs?: number;
	/** The action, whole, redacted: the card is the consent, so it shows all of what would run. */
	does: string;
	/** A loop that asks for a checker: each finding is reviewed before it enters the inbox. */
	verify?: boolean;
	/** Why the unattended policy would refuse the action's command, when it would. */
	danger?: string;
	/** The terminal line that would do the same, whole and redacted. */
	command: string;
}
export interface WatchProposal {
	id: string;
	sessionId: string;
	createdAt: string;
	expiresAt: string;
	plan: WatchPlan;
	card: WatchCard;
}
export interface WatchDecision {
	planId: string;
	verdict: "set" | "cancel";
	where: WatchWhere;
	once: boolean;
}
export type WatchOutcome =
	| { kind: "created"; planId: string; id: string; plan: WatchPlan }
	| { kind: "cancelled"; planId: string }
	/** Re-validation at apply time failed: a name taken since, a session gone. */
	| { kind: "failed"; planId: string; error: string }
	/** Expired, never here, another conversation's, or this process restarted since. */
	| { kind: "gone"; planId: string };

/** The plan's id as the tool mints it, and as the page's route checks it. */
export const PLAN_ID = /^wp-[0-9a-f]{16}$/;
export const PLAN_TTL_MS = 30 * 60_000;
export const PLANS_PER_SESSION = 3;

/**
 * The created job's or rule's id, derived from the plan's: a second click on a plan whose create
 * landed but whose note did not finds what the first made, and makes nothing twice.
 */
export function derivedId(kind: WatchPlan["kind"], planId: string): string {
	return `${kind === "rule" ? "dyn" : "cron"}-${createHash("sha256").update(planId).digest("hex").slice(0, 32)}`;
}

/**
 * The pending plans of one page child. A plan is taken once (`take` removes it before any write),
 * expires after `ttlMs`, and at most `perSession` wait per conversation (the oldest drops). The
 * same plan proposed twice is one card: a model that calls twice gets the id it already has.
 */
export interface WatchDesk {
	propose(plan: WatchPlan, card: WatchCard, sessionId: string, now?: number): WatchProposal;
	take(planId: string, sessionId: string, now?: number): { proposal: WatchProposal } | { settled: WatchOutcome } | { gone: true };
	settle(outcome: WatchOutcome): void;
	/** A pending plan, read without taking it. */
	peek(planId: string): WatchProposal | undefined;
}

export function createWatchDesk(opts: { ttlMs?: number; perSession?: number } = {}): WatchDesk {
	const ttl = opts.ttlMs ?? PLAN_TTL_MS;
	const perSession = opts.perSession ?? PLANS_PER_SESSION;
	const pending = new Map<string, WatchProposal>();
	const settled = new Map<string, { outcome: WatchOutcome; expiresAt: number }>();
	const sweep = (now: number) => {
		for (const [id, p] of pending) if (Date.parse(p.expiresAt) <= now) pending.delete(id);
		for (const [id, s] of settled) if (s.expiresAt <= now) settled.delete(id);
	};
	const same = (a: WatchPlan, b: WatchPlan) => JSON.stringify(a) === JSON.stringify(b);
	return {
		propose(plan, card, sessionId, now = Date.now()) {
			sweep(now);
			for (const p of pending.values()) if (p.sessionId === sessionId && same(p.plan, plan)) return p;
			const mine = [...pending.values()].filter((p) => p.sessionId === sessionId);
			for (const p of mine.slice(0, Math.max(0, mine.length + 1 - perSession))) pending.delete(p.id);
			const proposal: WatchProposal = { id: `wp-${randomBytes(8).toString("hex")}`, sessionId, createdAt: stamp(now), expiresAt: stamp(now + ttl), plan, card };
			pending.set(proposal.id, proposal);
			return proposal;
		},
		take(planId, sessionId, now = Date.now()) {
			sweep(now);
			const done = settled.get(planId);
			if (done) return { settled: done.outcome };
			const proposal = pending.get(planId);
			if (!proposal || proposal.sessionId !== sessionId) return { gone: true };
			pending.delete(planId);
			// Kept for the plan's own lifetime: a second click (another tab) gets the first answer.
			settled.set(planId, { outcome: { kind: "gone", planId }, expiresAt: Date.parse(proposal.expiresAt) });
			return { proposal };
		},
		settle(outcome) {
			const slot = settled.get(outcome.planId);
			settled.set(outcome.planId, { outcome, expiresAt: slot?.expiresAt ?? Date.now() + ttl });
		},
		peek: (planId) => pending.get(planId),
	};
}

/** A schedule in words, for the card's first row; an expression with no short reading is shown as it is. */
export function scheduleWords(schedule: LoopJob["schedule"]): string {
	if (schedule.kind !== "cron") return formatSchedule(schedule);
	const f = schedule.expr.trim().split(/\s+/);
	if (f.length !== 5) return schedule.expr;
	const [minute, hour, dom, month, dow] = f;
	const plain = (v: string) => /^\d{1,2}$/.test(v);
	const hhmm = () => `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
	if (plain(minute) && plain(hour) && dom === "*" && month === "*") {
		if (dow === "*") return `every day at ${hhmm()}`;
		if (dow === "1-5" || dow === "mon-fri") return `weekdays at ${hhmm()}`;
		if (dow === "1" || dow === "mon") return `every Monday at ${hhmm()}`;
	}
	const step = /^\*\/(\d+)$/.exec(minute);
	if (step && hour === "*" && dom === "*" && month === "*" && dow === "*") return `every ${step[1]} minutes`;
	if (minute === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "every hour";
	return schedule.expr;
}

const BACKTICK = String.fromCharCode(96);
const CODE_SPAN = new RegExp(`${BACKTICK}([^${BACKTICK}]+)${BACKTICK}`, "g");

/** The unattended policy's reason over the action and each `code span` in it, when there is one. */
export function actionDanger(action: string, home?: string): string | undefined {
	const candidates = [action, ...[...action.matchAll(CODE_SPAN)].map((m) => m[1])];
	for (const c of candidates) {
		const reason = dangerousCommandReason(c, home);
		if (reason) return reason;
	}
	return undefined;
}

/** The terminal line that would do the same, whole and redacted: one line, since that is how it would be typed. */
const oneLine = (text: string) => redact(text).replace(/\s+/g, " ").trim();

/** What the card says, from the plan: the schedule in words and its next run, or the condition and how often the background looks. */
export function planCard(plan: WatchPlan, ctx: { now: number; pollSecs: number; home?: string }): WatchCard {
	if (plan.kind === "schedule") {
		const next = computeNext({ schedule: plan.job.schedule, createdAt: ctx.now }, ctx.now);
		const spec = plan.job.schedule.kind === "cron" ? plan.job.schedule.expr : plan.job.schedule.kind === "every" ? `every ${formatDuration(plan.job.schedule.ms)}` : `at ${stamp(plan.job.schedule.at).slice(0, 16)}`;
		return {
			kind: "schedule",
			when: scheduleWords(plan.job.schedule),
			next: next === undefined ? undefined : formatLocal(next),
			does: redact(plan.job.prompt),
			verify: plan.job.verify || undefined,
			danger: actionDanger(plan.job.prompt, ctx.home),
			command: oneLine(`/cron add${plan.where === "inbox" ? " --stateful" : ""}${plan.job.name ? ` --name ${plan.job.name}` : ""} "${spec}" ${plan.job.prompt}`),
		};
	}
	return {
		kind: "rule",
		when: redact(plan.rule.condition),
		looksEverySecs: ctx.pollSecs,
		does: redact(plan.rule.action),
		danger: actionDanger(plan.rule.action, ctx.home),
		command: oneLine(`/new-trigger when ${plan.rule.condition}, ${plan.rule.action}`),
	};
}

/**
 * The writer. Takes the plan (once), maps the card's two choices onto the stores' fields in this one
 * place, creates through the same path the tools use, and records the outcome on the desk:
 *
 * - schedule: `stateful = where === "inbox"`; `verify` is kept only for a loop;
 * - rule: `promoteToChat = where === "chat"`, `fireOnce = once`.
 *
 * Cancel writes nothing. An id already in the store (a click whose create landed before a crash)
 * is reported as created without a second write. A plan already answered (a second tab, a replayed
 * request) gets `undefined`: the first answer's note is in the conversation, and nothing is written
 * or said twice.
 */
export async function settleWatch(
	desk: WatchDesk,
	d: WatchDecision,
	sessionId: string,
	deps: {
		createJob(input: CreateJobInput): Promise<LoopJob>;
		addRule(input: Parameters<TriggerStore["add"]>[0]): Promise<DynamicTriggerRule>;
		audit(job: LoopJob): void;
		jobs(): LoopJob[];
		rules(): DynamicTriggerRule[];
	},
): Promise<WatchOutcome | undefined> {
	const taken = desk.take(d.planId, sessionId);
	if ("gone" in taken) return { kind: "gone", planId: d.planId };
	if ("settled" in taken) return undefined;
	const { plan } = taken.proposal;
	let outcome: WatchOutcome;
	try {
		if (d.verdict === "cancel") outcome = { kind: "cancelled", planId: d.planId };
		else if (plan.kind === "schedule") {
			const id = derivedId("schedule", d.planId);
			const stateful = d.where === "inbox";
			const had = deps.jobs().find((j) => j.id === id);
			const job = had ?? (await deps.createJob({ ...plan.job, id, stateful, verify: stateful ? plan.job.verify : undefined }));
			if (!had) deps.audit(job);
			outcome = { kind: "created", planId: d.planId, id: job.id, plan: { ...plan, where: d.where } };
		} else {
			const id = derivedId("rule", d.planId);
			const had = deps.rules().find((r) => r.id === id);
			const rule = had ?? (await deps.addRule({ ...plan.rule, id, promoteToChat: d.where === "chat", fireOnce: d.once }));
			outcome = { kind: "created", planId: d.planId, id: rule.id, plan: { ...plan, where: d.where, once: d.once } };
		}
	} catch (err: any) {
		outcome = { kind: "failed", planId: d.planId, error: err?.message ?? String(err) };
	}
	desk.settle(outcome);
	return outcome;
}

/** The one-line note the conversation keeps: what the model reads on its next turn, and what the page turns the card into. */
export function outcomeLine(o: WatchOutcome): string {
	switch (o.kind) {
		case "created": {
			const where = o.plan.where === "chat" ? "shows in this conversation" : o.plan.kind === "schedule" ? "reports to the inbox" : "kept out of this conversation";
			const repeats = o.plan.kind === "rule" ? (o.plan.once ? "once" : "every time") : undefined;
			return `watch plan ${o.planId} set up as ${o.id} (${[where, repeats].filter(Boolean).join(" · ")})`;
		}
		case "cancelled":
			return `watch plan ${o.planId} not set up: cancelled`;
		case "failed":
			return `watch plan ${o.planId} not set up: ${o.error}`;
		case "gone":
			return `watch plan ${o.planId} is gone: read the sentence again`;
	}
}

/**
 * The page's body for `POST /c/<sid>/watch`, read at the edge: exactly these four fields, an id of
 * the shape the desk mints, two enums and a boolean. Anything else is refused, so the line pi's
 * stdin gets is built from tokens this function produced, never from the body.
 */
export function watchDecisionFrom(body: unknown): WatchDecision | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const b = body as Record<string, unknown>;
	const keys = Object.keys(b).sort();
	if (keys.join(",") !== "once,planId,verdict,where") return undefined;
	if (typeof b.planId !== "string" || !PLAN_ID.test(b.planId)) return undefined;
	if (b.verdict !== "set" && b.verdict !== "cancel") return undefined;
	if (b.where !== "chat" && b.where !== "inbox") return undefined;
	if (typeof b.once !== "boolean") return undefined;
	return { planId: b.planId, verdict: b.verdict, where: b.where, once: b.once };
}

/** `/pi-loops watch <id> set|cancel chat|inbox once|every`, as the page's route writes it; undefined when any word is off. */
export function parseWatchDecision(words: readonly string[]): WatchDecision | undefined {
	if (words.length !== 4) return undefined;
	const [planId, verdict, where, repeats] = words;
	if (!PLAN_ID.test(planId ?? "")) return undefined;
	if (verdict !== "set" && verdict !== "cancel") return undefined;
	if (where !== "chat" && where !== "inbox") return undefined;
	if (repeats !== "once" && repeats !== "every") return undefined;
	return { planId, verdict, where, once: repeats === "once" };
}

/** The same line, built from a decision: the route and the handler agree by construction. */
export function watchCommand(d: WatchDecision): string {
	return `/pi-loops watch ${d.planId} ${d.verdict} ${d.where} ${d.once ? "once" : "every"}`;
}
