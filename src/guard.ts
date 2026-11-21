/**
 * The guard of an unattended turn (design 2.3 and 3.1). A dangerous call is never run unattended: a
 * person is asked, and the call is blocked while the turn goes on. The question is a finding (Q1),
 * and a yes comes back as an answer row whose run admits that one call (`Grant`). A window's
 * scheduled turn files the same finding, in its conversation's lane (src/window-guard.ts, 6.4).
 *
 * `judgeCall` is the whole decision, pure, for both. `guardCall` applies it on plain values, so a
 * test drives it with no SDK, and a window's handler calls it too. `subagentGuardExtension` hangs it
 * on every sub-session. `GuardSeats` finds a run's place in the guard by its session manager: the guard is one
 * handler per loaded extension set, shared by every run of a directory.
 */
import { createSyntheticSourceInfo, type Extension } from "@earendil-works/pi-coding-agent";
import { type AskOrigin, type Call, ASK_COMMAND_MAX_CHARS, ASKS_OPEN_PER_LANE, ASKS_PER_TURN, type Grant, NO_HOLDS_MS, type ResolvedCap, callKey, inputHash, questionFinding, questionOpen } from "./ask.ts";
import { dangerousCommandReason, pathToolReason } from "./danger.ts";
import type { Inbox, InboxEntry as Finding } from "./inbox.ts";
import { cardText } from "./redact.ts";
import type { LaneId } from "./lane.ts";
import { PI_BUILTIN_TOOL_NAMES } from "./mcp.ts";
import { stamp } from "./schedule.ts";
import { defaultLoopsDir } from "./store.ts";

/** One call as the `tool_call` event gives it. */
export interface ToolCallFacts {
	toolName: string;
	toolCallId: string;
	/** Set for a call made inside another tool's call. Its id is in no transcript, so it is never asked about. */
	parentToolCallId?: string;
	input?: unknown;
	/** The run's cwd (`ctx.cwd`), which a relative path of the call is resolved against. */
	cwd?: string;
}

/** What `judgeCall` is given for the lane the turn runs in (design 3.1, without `repo`). */
export interface GuardTurn {
	/**
	 * What a window's scheduled row declared. `tools` names the whole set; `builtinTools` caps only
	 * pi's built-ins. pi-loops' own tools pass either. Absent: nothing is undeclared (a background run
	 * is given only the tools its cap declares, so its turn declares none).
	 */
	declared?: { readonly tools?: readonly string[]; readonly builtinTools?: readonly string[] };
	/** The turn writes a session file that a later row can open, and it has a lane. */
	resumable: boolean;
	/** The lane the turn runs in; absent for a turn with no seat (a checker). The two maps are this lane's. */
	lane?: LaneId;
	/** The one call this turn admits, until it is used. */
	granted?: Grant;
	/** `callKey` to ask id, from this lane's open questions (`questionOpen`): `new`, or with a yes that waits to run or runs. */
	open: ReadonlyMap<string, string>;
	/** A no that holds: `callKey` to the date of the no, from this lane's questions dismissed less than `NO_HOLDS_MS` ago. */
	refused: ReadonlyMap<string, string>;
	/** Questions this turn has opened. */
	asked: number;
}

/**
 * The seven reasons nobody is asked (design 3.1). A nested call is refused with `no-transcript`.
 * `not-shown` is a call with no command (a `read` or a `write` into the loops directory): the card
 * shows a command as written, and it cannot show a path and a whole content, so a yes would be blind.
 */
export type WhyNot =
	| { why: "no"; date: string }
	| { why: "turn-cap" }
	| { why: "lane-cap" }
	| { why: "too-long" }
	| { why: "not-as-written" }
	| { why: "not-shown" }
	| { why: "no-transcript" };

/** What a question asks a person about. One kind today; M5b.5 adds a proposal, and every handler's `switch` must take it. */
export type Question = { kind: "call"; call: Call };

/** The default arm of a `switch` over `Question["kind"]`, given the kind: a kind no case takes is a compile error there. */
export function unhandledAsk(kind: never): never {
	throw new Error(`a question of kind ${String(kind)} has no handler`);
}

export type CallVerdict =
	/**
	 * The policy passes the call. `grantUsed` when the call is also `turn.granted`: the policy changed
	 * (`[danger] allow`) between the question and the answer, the call runs, and the grant is spent,
	 * so C3 does not say `it ended without running the command` of a command that ran.
	 */
	| { kind: "allow"; grantUsed?: true }
	/** This call is the one a person said yes to. The caller marks the grant used before it lets the call through. */
	| { kind: "granted"; ask: string }
	/** Ask a person, block the call, the turn goes on. */
	| { kind: "question"; ask: Question }
	/** The same call already waits for a person. No second finding. */
	| { kind: "asked"; ask: string }
	| { kind: "refuse"; reason: string; whyNot: WhyNot };

/** The shell command a call carries, for the tools that run one. */
function commandOf(call: Pick<ToolCallFacts, "toolName" | "input">): string | undefined {
	if (call.toolName !== "bash" && call.toolName !== "powershell") return undefined;
	const command = (call.input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" ? command : undefined;
}

/** What the policy is given besides the call: `[danger] allow`, and the loops directory of this process. Without `loopsDir`, its rules are off. */
export interface GuardPolicy {
	allowCommands: readonly string[];
	loopsDir?: string;
}

/**
 * The pi-loops tools a declared tool list lets through undeclared, as the background does (they are
 * every run's `customTools`): the ones that only read (src/tools.ts), and the ones that carry their
 * own gate. A job made in a capped turn is capped to that turn's tools (src/pi-loops.ts `toolHost`,
 * as src/host-runtime.ts scopes a run's), so `cron_create` widens nothing; the rest ask through
 * `confirmTool` exactly where the background's preflight refuses, and the guard asking as well made
 * two questions of one call.
 */
export const READ_ONLY_AUTOMATION_TOOLS: readonly string[] = ["cron_list", "list_triggers"];
/** The pi-loops tools whose gate is their own (`confirmTool`, or the cap on what they create): the guard adds no question. */
export const SELF_GATED_AUTOMATION_TOOLS: readonly string[] = ["cron_create", "cron_remove", "set_cron_job_state", "new_trigger", "remove_trigger", "set_trigger_state"];
const AUTOMATION_TOOLS: readonly string[] = [...READ_ONLY_AUTOMATION_TOOLS, ...SELF_GATED_AUTOMATION_TOOLS];

/**
 * Why the policy needs a person for a call, or undefined when it may run, in this order: a path
 * tool into the loops directory (`pathToolReason`, its relative path against `cwd`); a tool outside
 * `declared`; a shell command `dangerousCommandReason` refuses.
 */
function policyNeed(call: Pick<ToolCallFacts, "toolName" | "input">, cwd: string | undefined, declared: GuardTurn["declared"], cfg: GuardPolicy): string | undefined {
	const own = cfg.loopsDir === undefined ? undefined : pathToolReason(call, cwd, cfg.loopsDir);
	if (own !== undefined) return own;
	const tool = call.toolName;
	if (declared?.tools) {
		if (!declared.tools.includes(tool) && !AUTOMATION_TOOLS.includes(tool)) return `${tool} is not among the tools the job declared (${declared.tools.join(", ") || "none"})`;
	} else if (declared?.builtinTools && PI_BUILTIN_TOOL_NAMES.includes(tool) && !declared.builtinTools.includes(tool)) {
		return `${tool} is not among the built-in tools the job declared (${declared.builtinTools.join(", ") || "none"})`;
	}
	const command = commandOf(call);
	return command === undefined ? undefined : dangerousCommandReason(command, undefined, cfg.allowCommands, cfg.loopsDir);
}

/**
 * Pure. The one decision of a background run and of a window's scheduled turn. The order is 2.3's,
 * with a nested call (`parentToolCallId`) refused before the grant:
 *   1. the policy passes the call (`policyNeed`: the loops directory, `turn.declared`, a dangerous
 *      command): allow, with `grantUsed` when the call is `turn.granted` and not nested;
 *      then a nested call: refuse, `no-transcript`, with no grant used and no question filed;
 *   2. the call is `turn.granted` (its tool, and `inputHash` of its input): granted;
 *   3. `turn.refused` has its key: refuse, `a person said no to this on <date>`;
 *   4. `turn.open` has its key: asked;
 *   5. it can be asked (`whyNotAsked`: `turn.resumable`, a command, at most `ASK_COMMAND_MAX_CHARS`,
 *      unchanged by `cardText`, and the caps): question;
 *   6. else refuse, with why nobody was asked.
 */
export function judgeCall(call: ToolCallFacts, turn: GuardTurn, cfg: GuardPolicy): CallVerdict {
	const command = commandOf(call);
	const reason = policyNeed(call, call.cwd, turn.declared, cfg);
	const hash = inputHash(call.input);
	const nested = call.parentToolCallId !== undefined;
	const granted = !nested && turn.granted !== undefined && turn.granted.call.tool === call.toolName && turn.granted.call.input_sha256 === hash;
	if (reason === undefined) return granted ? { kind: "allow", grantUsed: true } : { kind: "allow" };
	if (nested) return { kind: "refuse", reason, whyNot: { why: "no-transcript" } };
	if (granted) return { kind: "granted", ask: turn.granted!.ask };
	const key = callKey(call.toolName, hash);
	const date = turn.refused.get(key);
	if (date !== undefined) return { kind: "refuse", reason, whyNot: { why: "no", date } };
	const open = turn.open.get(key);
	if (open !== undefined) return { kind: "asked", ask: open };
	const whyNot = whyNotAsked(command, turn);
	if (whyNot) return { kind: "refuse", reason, whyNot };
	return { kind: "question", ask: { kind: "call", call: { tool: call.toolName, tool_call_id: call.toolCallId, command, input_sha256: hash, reason } } };
}

/** Step 5 of `judgeCall`, as the reason it fails, or undefined when the call can be asked about. */
function whyNotAsked(command: string | undefined, turn: GuardTurn): WhyNot | undefined {
	if (!turn.resumable || turn.lane === undefined) return { why: "no-transcript" };
	if (command === undefined) return { why: "not-shown" };
	if ([...command].length > ASK_COMMAND_MAX_CHARS) return { why: "too-long" };
	// The card collapses a newline, a tab or a run of spaces: a yes would run what the person did not read.
	if (cardText(command) !== command) return { why: "not-as-written" };
	if (turn.asked >= ASKS_PER_TURN) return { why: "turn-cap" };
	if (turn.open.size >= ASKS_OPEN_PER_LANE) return { why: "lane-cap" };
	return undefined;
}

/** `<why not>` of design 3.1. */
function whyNotWords(whyNot: WhyNot): string {
	switch (whyNot.why) {
		case "no":
			return `a person said no to this on ${whyNot.date}`;
		case "turn-cap":
			return `this turn already has ${ASKS_PER_TURN} questions waiting for a person`;
		case "lane-cap":
			return `${ASKS_OPEN_PER_LANE} questions from here already wait for a person`;
		case "too-long":
			return `the command is too long to show a person whole (${ASK_COMMAND_MAX_CHARS} characters at most): put it in a script in the project`;
		case "not-as-written":
			return "the command cannot be shown as written";
		case "not-shown":
			return "a person cannot see on the card what this call would read or write, so a yes would be blind";
		case "no-transcript":
			return "this session keeps no transcript an answer could resume";
	}
}

/** What the model is told when a person is asked (design 3.1). */
function askedMessage(reason: string): string {
	return `asked a person: ${reason}. pi-loops did not run this and put the question in front of them. Do not wait for the answer and do not try another way to do the same thing. Finish what does not need it.`;
}

/** What the model is told when nobody is asked (design 3.1). `whyNot` is the words of a `WhyNot`, or why the question could not be filed. */
function refusedMessage(reason: string, whyNot: string): string {
	return `refused by pi-loops: ${reason}. Nobody was asked: ${whyNot}. Finish what does not need it, and report what you would need a person for.`;
}

/**
 * What a turn that can file no question is told: the words of the guard before questions. A nested
 * call (plan.md, M5a), and a run with no seat (a checker, and every run until a caller passes a seat),
 * keep what a person and the model saw before.
 */
function unattendedMessage(reason: string): string {
	return `refused by pi-loops: ${reason}. This run is unattended, so commands that can destroy data or the machine are not allowed; do the safe part and report what you would need a human for.`;
}

/**
 * What a run gives the runner for its guard. Passed as a value in `SubagentRequest.guard`. A
 * request without it has no seat: its dangerous calls are refused and nobody is asked (a checker).
 */
export interface GuardSeed {
	readonly lane: LaneId;
	readonly origin: AskOrigin;
	/** The cap of this turn: the runner runs it as this says, and `recordedCap` of it goes onto each question it opens. */
	readonly cap: ResolvedCap;
	/** The run of an answer row to a question: the one call it admits. */
	readonly grant?: Grant;
}

/** What the guard knows when the run ends. `grant_used` is present only for a run that had a grant. */
export interface GuardReport {
	grant_used?: boolean;
	/** The ids of the questions this run opened. */
	asked: string[];
}

/** One run's place in the guard: its seed, its session, and the two things that change during the run. */
export interface GuardSeat {
	readonly seed: GuardSeed;
	/** pi's session id of the run, from its own `SessionManager`: what a question records to find its transcript again. */
	readonly sessionId: string;
	/** The run's transcript, for a person to open from the finding. No answer reads it by this path. */
	readonly sessionFile: string;
	/** `seed.lane` and `seed.cap`, beside the session: what `questionFinding` copies onto an ask. */
	readonly lane: LaneId;
	readonly cap: ResolvedCap;
	asked: string[];
	grantUsed: boolean;
}

/**
 * The seats of the runs that are going in this process, by the run's own `SessionManager`. The
 * runner makes that object for one request and seats it; the handler finds its run by
 * `ctx.sessionManager`, which is the same object. A path is no key: another session (a held turn,
 * or the same file through a symlink) can name the same file, and it has no seat. One object per
 * process, made where the runner is made and passed to it and to the extension.
 */
export class GuardSeats {
	private readonly seats = new WeakMap<object, GuardSeat>();

	/** A run takes its seat once its session exists, before its prompt. One seat per session: a second `enter` for one that has a seat throws. */
	enter(session: { getSessionId(): string }, sessionFile: string, seed: GuardSeed): { seat: GuardSeat; leave(): GuardReport } {
		if (this.seats.has(session)) throw new Error(`a run already has the guard's seat for ${sessionFile}`);
		const seat: GuardSeat = { seed, sessionId: session.getSessionId(), sessionFile, lane: seed.lane, cap: seed.cap, asked: [], grantUsed: false };
		this.seats.set(session, seat);
		return {
			seat,
			leave: () => {
				if (this.seats.get(session) === seat) this.seats.delete(session);
				return { ...(seed.grant ? { grant_used: seat.grantUsed } : {}), asked: [...seat.asked] };
			},
		};
	}

	of(session: object | undefined): GuardSeat | undefined {
		return session === undefined ? undefined : this.seats.get(session);
	}
}

/**
 * The view of one lane's questions that `judgeCall` reads. Pure. A question with a yes that waits to
 * run or runs is open: a later run of the lane that makes the same call is told it is asked, and no
 * second question is filed beside the yes. `declared` is a window's scheduled row's (`GuardTurn`).
 */
export function guardTurn(seat: GuardSeat | undefined, findings: readonly Finding[], now: number, declared?: GuardTurn["declared"]): GuardTurn {
	const open = new Map<string, string>();
	const refused = new Map<string, string>();
	for (const f of seat ? findings : []) {
		if (!f.ask || f.ask.lane !== seat!.lane) continue;
		const key = callKey(f.ask.call.tool, f.ask.call.input_sha256);
		// The run a yes started answers that question: once its grant is used, the same call again is a
		// new question for the person, not one they are already asked.
		if (f.id === seat!.seed.grant?.finding) continue;
		if (questionOpen(f)) open.set(key, f.ask.id);
		else if (f.status === "dismissed" && f.dismissed_at !== undefined && now - Date.parse(f.dismissed_at) < NO_HOLDS_MS) refused.set(key, f.dismissed_at.slice(0, 10));
	}
	return {
		...(declared ? { declared } : {}),
		resumable: seat !== undefined,
		...(seat ? { lane: seat.lane } : {}),
		...(seat?.seed.grant && !seat.grantUsed ? { granted: seat.seed.grant } : {}),
		open,
		refused,
		asked: seat?.asked.length ?? 0,
	};
}

export interface GuardDeps {
	inbox: Pick<Inbox, "list" | "fileOnce">;
	allowCommands(): readonly string[];
	/** The loops directory of this process; `defaultLoopsDir()` when absent. */
	loopsDir?: string;
	now(): number;
	log?(message: string): void;
}

export type Blocked = { block: true; reason: string };

/**
 * What a window's scheduled turn gives `guardCall` beside its seat: the tools its row declared, and
 * its own refusal of a call no card could show (src/window-guard.ts `refusal`, `blind`).
 */
export interface WindowCall {
	declared?: GuardTurn["declared"];
	notShown(reason: string): Blocked;
}

/**
 * The whole `tool_call` handler, on plain values. The policy and the grant are judged first on a
 * turn with no findings, since neither reads them, so a call the policy passes reads no inbox. It
 * never sets `terminate`: the run goes on with what does not need the command. Anything that throws
 * blocks the call. A background run gives no `window`.
 */
export async function guardCall(call: ToolCallFacts, seat: GuardSeat | undefined, deps: GuardDeps, window?: WindowCall): Promise<Blocked | undefined> {
	const block = (reason: string, message: string): Blocked => {
		deps.log?.(`blocked a ${call.toolName} call: ${reason}`);
		return { block: true, reason: message };
	};
	let verdict: CallVerdict;
	try {
		const cfg: GuardPolicy = { allowCommands: deps.allowCommands(), loopsDir: deps.loopsDir ?? defaultLoopsDir() };
		verdict = judgeCall(call, guardTurn(seat, [], deps.now(), window?.declared), cfg);
		if (verdict.kind !== "allow" && verdict.kind !== "granted") verdict = judgeCall(call, guardTurn(seat, seat ? deps.inbox.list() : [], deps.now(), window?.declared), cfg);
	} catch (err: any) {
		return block("the guard could not decide", refusedMessage("the guard could not decide", `the guard failed (${err?.message ?? err})`));
	}
	switch (verdict.kind) {
		case "allow":
			if (verdict.grantUsed && seat) seat.grantUsed = true;
			return undefined;
		case "granted":
			// Set before the call goes through: a second call with the same input finds no grant and is asked about.
			if (seat) seat.grantUsed = true;
			return undefined;
		case "question": {
			const ask = verdict.ask;
			switch (ask.kind) {
				case "call": {
					const reason = ask.call.reason;
					try {
						const { id, entry } = questionFinding(ask.call, seat!, seat!.seed.origin, stamp(deps.now()));
						await deps.inbox.fileOnce(entry, id);
						seat!.asked.push(entry.ask!.id);
					} catch (err: any) {
						return block(reason, refusedMessage(reason, `the question could not be filed (${err?.message ?? err})`));
					}
					return block(reason, askedMessage(reason));
				}
				default:
					return unhandledAsk(ask.kind);
			}
		}
		case "asked": {
			const reason = askedReason(call, deps, window?.declared);
			return block(reason, askedMessage(reason));
		}
		case "refuse":
			if (window && verdict.whyNot.why === "not-shown") return window.notShown(verdict.reason);
			return block(verdict.reason, verdict.whyNot.why === "no-transcript" ? unattendedMessage(verdict.reason) : refusedMessage(verdict.reason, whyNotWords(verdict.whyNot)));
	}
}

/** The policy's reason for a call that `judgeCall` found already asked about. */
function askedReason(call: ToolCallFacts, deps: GuardDeps, declared: GuardTurn["declared"]): string {
	return policyNeed(call, call.cwd, declared, { allowCommands: deps.allowCommands(), loopsDir: deps.loopsDir ?? defaultLoopsDir() }) ?? call.toolName;
}

export const GUARD_PATH = "<pi-loops sub-agent guard>";

/**
 * The tool-call gate every sub-session runs under: `guardCall`, applied to each call a loop run,
 * checker or trigger action makes. pi-loops' own extension is deliberately not loaded in a
 * sub-session (nothing may nest), so there is no extension there to hang a `tool_call` handler on.
 * The gate is injected as a hidden synthetic extension instead. One extension serves every run of a
 * loaded set: it finds the run by the run's own session manager. `block` + `reason` is pi's
 * documented way to refuse a call and tell the model why (ToolCallEventResult).
 */
export function subagentGuardExtension(seats: GuardSeats, deps: GuardDeps): Extension {
	const handler = async (...args: unknown[]) => {
		const event = args[0] as { toolName: string; toolCallId: string; parentToolCallId?: string; input?: unknown };
		const ctx = args[1] as { sessionManager?: object; cwd?: string } | undefined;
		return guardCall({ toolName: event.toolName, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId, input: event.input, ...(ctx?.cwd ? { cwd: ctx.cwd } : {}) }, seats.of(ctx?.sessionManager), deps);
	};
	return {
		path: GUARD_PATH,
		resolvedPath: GUARD_PATH,
		hidden: true,
		sourceInfo: createSyntheticSourceInfo(GUARD_PATH, { source: "pi-loops" }),
		handlers: new Map([["tool_call", [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	} as unknown as Extension;
}
