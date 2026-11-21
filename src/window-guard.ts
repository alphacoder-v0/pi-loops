/**
 * The cap on a scheduled turn in an open window (design 6.3 and 6.4, owner decision O1). A plain
 * job's prompt runs under the job's declared tools and the dangerous-command policy wherever it runs,
 * as `guardCall` of src/guard.ts decides and applies it. A call that needs a person files the question
 * a background run files (Q1): a finding whose lane is the conversation, answered in `/inbox` or on
 * the page. The call is blocked and the turn goes on. `windowGuard` is the `tool_call` handler, built
 * here so a test can drive it without the extension. `askRefusingFirst` is the dialog a control-plane
 * tool still asks through in a scheduled turn (src/pi-loops.ts `confirmTool`).
 */
import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { heldCap } from "./background-executor.ts";
import type { JobClock } from "./clock.ts";
import { plainRunId } from "./engine.ts";
import { type GuardDeps, type GuardPolicy, type GuardSeat, type GuardSeed, GuardSeats, guardCall } from "./guard.ts";
import type { Inbox } from "./inbox.ts";
import { parseLane } from "./lane.ts";
import { DEFAULT_RUN_TIMEOUT_MS } from "./loop-run.ts";
import type { Row } from "./requests.ts";
import { type LoopJob, defaultLoopsDir } from "./store.ts";
import { type CurrentTurn, type RowCap, unattendedTurn } from "./window-executor.ts";

/** How long the person has to answer a control-plane tool's question in a scheduled turn before it refuses. */
export const WINDOW_GUARD_CONFIRM_MS = 60_000;

/**
 * The two answers to a scheduled turn's dialog, the refusing one first: pi's selector starts on the
 * first option and Enter picks it, so a reflexive Enter refuses. pi's confirm starts on Yes.
 */
export const GUARD_CHOICES = { refuse: "No, refuse it", allow: "Yes, run it once" } as const;

/** Pure. Only the allowing answer allows: no answer (the timeout), Escape and anything else refuse. */
export function allows(choice: string | undefined): boolean {
	return choice === GUARD_CHOICES.allow;
}

/** What the question came to: the allowing answer, the person's refusal, or no answer (the timeout, Escape, no UI). */
export type GuardAnswer = "yes" | "no" | "none";
/** How close to its timeout a false confirm counts as the timeout: timers fire slightly early. */
const TIMEOUT_SLACK_MS = 50;

/**
 * The question, put so that the reflexive answer refuses. In a terminal pi draws a confirm with the
 * cursor on Yes, so it is a select with the refusal first. The browser draws a select's title as one
 * heading line, and its confirm already puts cancel first, so there it stays a confirm. No answer
 * within `timeout` is a refusal either way; the model is told which it was, so a person's No is not
 * reported as nobody being there. pi's confirm resolves false for both, so over rpc the clock tells
 * them apart.
 */
export async function askRefusingFirst(ctx: Pick<ExtensionContext, "ui" | "mode">, title: string, body: string, timeout: number): Promise<GuardAnswer> {
	if (ctx.mode === "rpc") {
		const asked = Date.now();
		if (await ctx.ui.confirm(title, body, { timeout })) return "yes";
		// Timers fire a millisecond or so early against Date.now(); a No in the last instants of the
		// countdown cannot be told from the countdown anyway.
		return Date.now() - asked >= timeout - Math.min(TIMEOUT_SLACK_MS, timeout / 10) ? "none" : "no";
	}
	const choice = await ctx.ui.select(`${title}\n${body}`, [GUARD_CHOICES.refuse, GUARD_CHOICES.allow], { timeout });
	return allows(choice) ? "yes" : choice === GUARD_CHOICES.refuse ? "no" : "none";
}

export interface GuardConfig extends GuardPolicy {
	/** `[engine] window_guard`; false is 0.23's uncapped window. */
	windowGuard: boolean;
}

/**
 * What the model is told when the window refuses a call itself: the sub-agent guard's wording, with
 * why. `nobody`: the guard could not decide; `blind`: a call nobody was asked about, since a person
 * could not see it on a card.
 */
export function refusal(reason: string, by: "nobody" | "blind" = "nobody"): string {
	const who = by === "blind" ? "Nobody was asked, since a person could not see what this call would read or write" : "This scheduled turn ran with nobody answering";
	return `refused by pi-loops: ${reason}. ${who}; commands that can destroy data or the machine, and tools the job did not declare, are not allowed; do the safe part and report what you would need a human for.`;
}

/** The plain job a scheduled turn runs, as its question names it. */
export type TurnJob = Pick<LoopJob, "id" | "name" | "cwd" | "timeoutMs">;

/**
 * Pure. The plain job whose row `rowId` is: by the row's source while the row is in the file; once a
 * drain took the delivered row out, by its id, which is `plainRunId` of the job and the slot the clock
 * last spent or fired for it (src/clock.ts).
 */
export function turnJob(rowId: string, jobs: readonly LoopJob[], rows: readonly Pick<Row, "id" | "source">[], clock: Readonly<Record<string, JobClock>>): LoopJob | undefined {
	const source = rows.find((row) => row.id === rowId)?.source;
	const named = source?.match(/^cron(?:-run)?:(.+)$/)?.[1];
	if (source !== undefined) return named === undefined ? undefined : jobs.find((job) => job.id === named);
	return jobs.find((job) => !job.stateful && [clock[job.id]?.slot, clock[job.id]?.fired].some((at) => at !== undefined && plainRunId(job.id, at) === rowId));
}

/**
 * Pure. The seed of a scheduled turn's seat: its lane is the conversation, its origin the job as a
 * turn in a closed conversation names it (src/background-executor.ts `runTurn`), and its cap the
 * row's declared tools under the job's time limit (`heldCap`, which an answer is narrowed to). With
 * no job found the question names none.
 */
export function windowSeed(cap: RowCap, sessionId: string, cwd: string, job: TurnJob | undefined): GuardSeed {
	const name = job ? (job.name ?? job.id) : undefined;
	const tools = { tools: cap.tools ? [...cap.tools] : undefined, builtinTools: cap.builtinTools ? [...cap.builtinTools] : undefined, timeoutMs: job?.timeoutMs };
	return {
		lane: sessionId,
		origin: { source: `cron:${name ?? cap.id}`, run_id: cap.id, cwd, ...(job ? { job_id: job.id } : {}), session_id: sessionId, who: name ?? "a scheduled prompt" },
		cap: heldCap(tools, cwd, DEFAULT_RUN_TIMEOUT_MS),
	};
}

/** What the handler reads of pi's context: the conversation's session and the turn's directory. */
export type WindowContext = { cwd?: string; sessionManager?: { getSessionId(): string; getSessionFile(): string | undefined } };

export interface WindowGuardDeps {
	current(): CurrentTurn | undefined;
	config(): GuardConfig;
	log(line: string): void;
	/** Where a question is filed and read back, as a background run's guard has it. */
	inbox: Pick<Inbox, "list" | "fileOnce">;
	now(): number;
	/** The plain job whose row `rowId` is, in conversation `sessionId` (`turnJob`). */
	jobOf(rowId: string, sessionId: string): TurnJob | undefined;
}

/**
 * The `tool_call` handler: a scheduled turn's call is judged and applied by `guardCall`, as a
 * background run's is, in a seat of this window's own `GuardSeats`: keyed by the window's
 * `ctx.sessionManager`, so a question's ask id and session are the conversation's. A turn takes its
 * seat at its first judged call and leaves it when another turn's first call comes. With no session
 * file there is no transcript an answer could resume, so there is no seat, and a call that needs a
 * person is refused. A call no card could show is refused in the window's own words (`blind`).
 *
 * This is a boundary that fails closed: anything in here that throws refuses a scheduled turn's
 * call. The person's own turn goes on as if the guard were not there, and so does a turn with no row
 * in force (nothing of ours is running: between settle cycles), the one unknown that is allowed.
 * Whose turn it is comes first, and a failure to learn even that refuses.
 */
export function windowGuard(deps: WindowGuardDeps): (event: { toolName: string; toolCallId?: string; input?: unknown }, ctx: WindowContext | undefined) => Promise<ToolCallEventResult | undefined> {
	const seats = new GuardSeats();
	let held: { session: object; row: string; seat?: GuardSeat; leave?: () => void } | undefined;
	const seatOf = (cap: RowCap, ctx: WindowContext | undefined): GuardSeat | undefined => {
		const session = ctx?.sessionManager;
		if (held && held.session === session && held.row === cap.id) return held.seat;
		held?.leave?.();
		held = undefined;
		if (!session) return undefined;
		const sessionId = session.getSessionId();
		const file = session.getSessionFile();
		if (file === undefined || parseLane(sessionId)?.kind !== "conversation") {
			held = { session, row: cap.id };
			return undefined;
		}
		const job = deps.jobOf(cap.id, sessionId);
		const entered = seats.enter(session, file, windowSeed(cap, sessionId, ctx?.cwd ?? job?.cwd ?? process.cwd(), job));
		held = { session, row: cap.id, seat: entered.seat, leave: () => void entered.leave() };
		return entered.seat;
	};
	return async (event, ctx) => {
		let current: CurrentTurn | undefined;
		try {
			current = deps.current();
		} catch (err: any) {
			deps.log(`window guard failed on ${event.toolName}: ${err?.message ?? err}`);
			return { block: true, reason: refusal("the guard could not decide") };
		}
		try {
			const cfg = deps.config();
			if (!cfg.windowGuard || !unattendedTurn(current)) return undefined;
			const trace = current.id.slice(0, 8);
			const call = { toolName: event.toolName, toolCallId: event.toolCallId ?? "", input: event.input, ...(ctx?.cwd ? { cwd: ctx.cwd } : {}) };
			const guard: GuardDeps = { inbox: deps.inbox, allowCommands: () => cfg.allowCommands, loopsDir: cfg.loopsDir ?? defaultLoopsDir(), now: deps.now, log: (line) => deps.log(`${line} in scheduled turn ${trace}`) };
			const declared = { ...(current.tools ? { tools: current.tools } : {}), ...(current.builtinTools ? { builtinTools: current.builtinTools } : {}) };
			const notShown = (reason: string) => {
				deps.log(`refused ${event.toolName} in scheduled turn ${trace}: ${reason} (nobody asked: it cannot be shown)`);
				return { block: true as const, reason: refusal(reason, "blind") };
			};
			return await guardCall(call, seatOf(current, ctx), guard, { declared, notShown });
		} catch (err: any) {
			deps.log(`window guard failed on ${event.toolName}: ${err?.message ?? err}`);
			return unattendedTurn(current) ? { block: true, reason: refusal("the guard could not decide") } : undefined;
		}
	};
}
