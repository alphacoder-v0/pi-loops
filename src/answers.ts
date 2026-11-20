/**
 * The writers of every transition of an answer (`.docs/redesign-0243/answer-protocol.md`). The one
 * module that holds `inbox.lock` and a lane's lock together, in that order. It decides nothing: the
 * pure deciders of src/ask.ts do, and this module makes their writes in the order `PROTOCOL` lists.
 * It starts no run and takes no slot: the executor that calls `meet` does, so a window can use it
 * with an executor of its own.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Ask,
	type Answerer,
	type CallCheck,
	type FinalState,
	type Grant,
	type LaneFact,
	type RunRecordM5a,
	type StepRefusal,
	type TranscriptFacts,
	WHY,
	answerRowId,
	answerStep,
	besideId,
	blockedCall,
	canonicalJson,
	closeOutcome,
	decideSay,
	isAnswerRow,
	laneFact,
	laneOf,
	meetAnswerRow,
	noRow,
	repairRows,
} from "./ask.ts";
import { type Inbox, type InboxEntry as Finding, UNDER_INBOX_LOCK } from "./inbox.ts";
import { type ConversationId, type Lane, type LaneId, parseLane } from "./lane.ts";
import type { LockOptions } from "./lock.ts";
import type { ClaimedRow, RequestStore, Row, UnclaimedRow } from "./requests.ts";
import type { Resume } from "./runner.ts";
import { stamp } from "./schedule.ts";
import { laneTranscript } from "./session-head.ts";
import type { JobStore } from "./store.ts";
import type { TriggerStore } from "./triggers.ts";

/** The audit states of an answer row's exits (design 2.1). `converted` is the conversion's. */
export type AnswerExit = "stale" | "job-removed" | "refused" | "dead" | "cancelled" | "converted";

export interface AnswersDeps {
	inbox: Pick<Inbox, "file" | "section" | "list">;
	requests: Pick<RequestStore, "appendIfAbsent" | "claim" | "remove" | "update" | "removeIf" | "list">;
	/** `jobs.json`, read before `inbox.lock`; the run log for C1. */
	jobs: Pick<JobStore, "load" | "appendRunOnce" | "listRuns" | "sessionDirFor">;
	audit: Pick<TriggerStore, "appendAudit">;
	/** A conversation's session file, from its lease; undefined when there is none. */
	sessionFile(id: ConversationId): string | undefined;
	/** The entries of a session file, or undefined when the file is gone. */
	entries(file: string): readonly unknown[] | undefined;
	/** Where a check lane's transcripts are: `checkSessionDir` of src/trigger-runtime.ts, from the resolved path of `cwd`. */
	checkSessionDir(cwd: string): string;
	/** `checkLane` of src/trigger-runtime.ts, given as a function so that this module does not import that module. */
	checkLaneOf(cwd: string): LaneId | undefined;
	/**
	 * C2: `run_end` for `record`, on `lane`, a loop's lane. It makes a hook runner for the loop the lane
	 * names when the run's own is gone (F2 after a restart), and fires nothing for a record of another job.
	 */
	runEnd(record: RunRecordM5a, lane: LaneId): void;
	/** This process, as the `created_by` of a row it appends. */
	self(): Row["created_by"];
	now(): number;
	log(message: string): void;
}

/** What `meet` asks the executor that calls it. */
export interface AnswerExecutor {
	/**
	 * Why E4 waits in this lane now, asked before the locks, for the finding as read then: the loop's
	 * job is disabled (a parked loop among them), the directory missing, the budget, no free slot,
	 * another run of the lane, the transcript held by a live pi, a window or the page holds the
	 * conversation. `transcript` is pi's session id of the transcript the run would resume, when
	 * `laneTranscript` found it in the lane's own directory. undefined: E4 may start.
	 */
	blocked(lane: Lane, finding: Finding | undefined, transcript?: string): string | undefined;
	/** Whether the process of the claim is there and still runs the row. A claim of this process whose run left the list is not live. */
	live(row: ClaimedRow): boolean;
	/** E4a, inside both locks: a slot, then the claim with `lock`. undefined: no slot, or the row left. The run is in the list from here. */
	claim(row: UnclaimedRow, finding: Finding, lock: LockOptions, now: number): ClaimedRow | undefined;
	/** E4b threw: the run leaves the list and gives its slot back. The claim stays on the row, and the next `meet` finds it not live (F1). */
	release(runId: string): void;
}

/** What a run of an answer row starts from. Only `meet` makes one, after E4b is written. */
export interface AnswerStart {
	readonly row: ClaimedRow;
	/** The finding as E4b wrote it: `started`, with this claim. */
	readonly finding: Finding;
	readonly grant?: Grant;
	/**
	 * The transcript to open: the one in the lane's own directory whose header names the ask's
	 * `session_id`, or for another finding its `transcript_id` (`laneTranscript`). Absent: a new
	 * session with the finding's text (never for a question: E3 refuses one with no transcript).
	 */
	readonly resume?: Resume;
	/** The `jobId` of this run's record: the loop's id, the check lane's id, or for a conversation the finding's `job_id` or the empty string. */
	readonly jobId: string;
}

export type SayOutcome =
	| { said: "Y1"; finding: Finding; lane: LaneId; queued: boolean }
	| { said: "Y2"; finding: Finding; why: string }
	| { said: "YC"; finding: Finding }
	| { said: "N1"; finding: Finding; told: boolean }
	| { said: "nothing"; refusal: StepRefusal };

export type MeetOutcome =
	| { met: "E1" | "E2" | "E3" | "GONE" | "F1-dead"; exit: AnswerExit }
	| { met: "hold"; why: string }
	| { met: "E4"; start: AnswerStart }
	| { met: "W1" }
	| { met: "F1"; attempts: number }
	| { met: "F2" | "F3"; state: FinalState | "none" }
	| { met: "nothing" };

/** What a person's surface does with an answer: a yes, a no, a clear, a cancel. A window, the page and the CLI each make one (`personAnswers`). */
export interface PersonAnswers {
	/** A person's yes or no (Y1, Y2, YC, N1). The row of Y1 and N1 is appended after `inbox.lock`; an append that throws is `queued: false` or `told: false`, and H1 appends the row of a yes at the next tick. */
	say(id: string, word: "yes" | "no", from: Answerer, opts?: { reason?: string }): Promise<SayOutcome>;
	/** `/inbox clear`: N1 for every `new` finding `match` takes, in one section and one rewrite; then the `no-` rows. Returns the findings dismissed. */
	clear(match: ((finding: Finding) => boolean) | undefined, from: Answerer): Promise<Finding[]>;
	/** A person cancels a queued yes (V1, V2). `ref` is the finding's id or its `ans-` row's id. */
	cancel(ref: string): Promise<{ cancelled: Finding; again: string } | { refusal: StepRefusal }>;
}

/** What `personAnswers` reads and writes: no transcript, no hook and no check lane, since a surface starts no run. */
export interface PersonAnswersDeps {
	inbox: Pick<Inbox, "section" | "list">;
	requests: Pick<RequestStore, "appendIfAbsent" | "remove">;
	jobs: Pick<JobStore, "load">;
	audit: Pick<TriggerStore, "appendAudit">;
	sessionFile(id: ConversationId): string | undefined;
	self(): Row["created_by"];
	now(): number;
	log(message: string): void;
}

export interface Answers extends PersonAnswers {
	/** The executor meets one `ans-` row: section E, W1, F1 to F3, the deleted conversation. */
	meet(lane: Lane, rowId: string, executor: AnswerExecutor, now: number): Promise<MeetOutcome>;
	/** The closing of a run of an answer row (C1 to C4): by the process that ran it, with `ended`, and by `meet` for F2. Each write is safe to repeat. */
	close(row: ClaimedRow, now: number, ended?: RunRecordM5a): Promise<{ state: FinalState | "none"; record: RunRecordM5a }>;
	/** H1, at every tick of a process that executes lanes. Returns the ids of the rows appended. */
	repair(executes: (lane: Lane) => boolean, now: number): Promise<string[]>;
}

/** Whether a user message of `entries` carries `[Trigger <rowId>] `: the prompt of an answer's run was written. */
function holdsPrompt(entries: readonly unknown[], rowId: string): boolean {
	const head = `[Trigger ${rowId}] `;
	return entries.some((entry) => {
		const message = (entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null)?.message;
		if ((entry as { type?: unknown } | null)?.type !== "message" || !message || message.role !== "user") return false;
		const content = message.content;
		if (typeof content === "string") return content.includes(head);
		return Array.isArray(content) && content.some((part) => typeof (part as { text?: unknown })?.text === "string" && (part as { text: string }).text.includes(head));
	});
}

const finalStates: ReadonlySet<string> = new Set<FinalState>(["done", "unfinished", "not_run", "cancelled"]);
const finalOf = (finding: Finding | undefined): FinalState | "none" => {
	const state = finding?.answer?.state;
	return state !== undefined && finalStates.has(state) ? (state as FinalState) : "none";
};

/** No lane can be read for a row whose finding is missing: `meetAnswerRow` gives E1 before it reads this. */
const NO_LANE: LaneFact = { there: false, why: WHY.nowhere };

/** A conversation's lane is there while its session file is. */
function sessionFileThereOf(deps: Pick<PersonAnswersDeps, "sessionFile">): (id: ConversationId) => boolean {
	return (id) => {
		const file = deps.sessionFile(id);
		return file !== undefined && fs.existsSync(file);
	};
}

/** The audit line of an answer row's exit: after the locks, as the engine writes a row's. */
function auditExit(deps: Pick<PersonAnswersDeps, "audit">, rowId: string, lane: LaneId, finding: string, exit: AnswerExit, cwd: string, why?: string): void {
	deps.audit.appendAudit({ cwd, type: "request", traceId: rowId, state: exit, sourceLabel: "answer", eventLabel: lane, details: { session_id: lane, kind: "input", finding, ...(why ? { reason: why } : {}) } });
}

/** A row appended after `inbox.lock`: one that throws is logged, and H1 appends a yes's row at the next tick. */
function appendAfterLock(deps: Pick<PersonAnswersDeps, "requests" | "log">, row: UnclaimedRow): boolean {
	try {
		deps.requests.appendIfAbsent(row);
		return true;
	} catch (err: unknown) {
		deps.log(`answers: the row ${row.id} could not be appended to ${row.lane}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/** A person's yes, no, clear and cancel over a directory's stores. `createAnswers` has these too. */
export function personAnswers(deps: PersonAnswersDeps): PersonAnswers {
	const { inbox, requests, jobs } = deps;
	const sessionFileThere = sessionFileThereOf(deps);
	return {
		async say(id, word, from, opts = {}) {
			const all = jobs.load();
			const seen = inbox.list().find((f) => f.id === id);
			if (!seen) return { said: "nothing", refusal: { refused: "missing" } };
			const lane = laneFact(seen, all, sessionFileThere);
			const at = stamp(deps.now());
			const done = await inbox.section((tx) => {
				const said = decideSay(tx.find(id), word, from, lane, { at, self: deps.self(), ...(opts.reason === undefined ? {} : { reason: opts.reason }) });
				return { said, finding: said.step === "none" ? undefined : tx.write(said.write) };
			});
			const { said } = done;
			if (said.step === "none" || !done.finding) return { said: "nothing", refusal: said.step === "none" ? said.refusal : { refused: "missing" } };
			switch (said.step) {
				case "Y1":
					return { said: "Y1", finding: done.finding, lane: said.row.lane, queued: appendAfterLock(deps, said.row) };
				case "Y2":
					return { said: "Y2", finding: done.finding, why: said.why };
				case "YC":
					return { said: "YC", finding: done.finding };
				case "N1":
					return { said: "N1", finding: done.finding, told: said.row ? appendAfterLock(deps, said.row) : false };
			}
		},

		async clear(match, from) {
			const at = stamp(deps.now());
			const dismissed = await inbox.section((tx) => {
				const writes = tx.list().flatMap((finding) => {
					if (finding.status !== "new" || (match && !match(finding))) return [];
					const step = answerStep("N1", finding, { to: "none", by: from.by }, { at, lane: undefined });
					return "refused" in step ? [] : [step];
				});
				if (!writes.length) return [];
				tx.write(writes[0], ...writes.slice(1));
				return writes.flatMap((w) => tx.find(w.id) ?? []);
			});
			for (const finding of dismissed) {
				const row = noRow(finding, at, deps.self());
				if (row) appendAfterLock(deps, row);
			}
			return dismissed;
		},

		async cancel(ref) {
			const all = jobs.load();
			const seen = inbox.list().find((f) => f.id === ref || answerRowId(f.id) === ref);
			if (!seen) return { refusal: { refused: "missing" } };
			const id = seen.id;
			const lane = laneOf(seen, all);
			const at = stamp(deps.now());
			const out = await inbox.section((tx) => {
				const step = answerStep("V1", tx.find(id), { to: "cancelled" }, { at, lane });
				if ("refused" in step) return { refusal: step };
				const cancelled = tx.write(step);
				// V2, still under inbox.lock: the row of the yes leaves its lane.
				const rowLane = cancelled.lane ?? lane;
				if (rowLane !== undefined && parseLane(rowLane)) requests.remove(rowLane, [answerRowId(id)], UNDER_INBOX_LOCK);
				return { cancelled, rowLane };
			});
			if (out.refusal) return { refusal: out.refusal };
			if (out.rowLane !== undefined) auditExit(deps, answerRowId(id), out.rowLane, id, "cancelled", out.cancelled.cwd);
			return { cancelled: out.cancelled, again: besideId(id, "again") };
		},
	};
}

export function createAnswers(deps: AnswersDeps): Answers {
	const { inbox, requests, jobs } = deps;
	const person = personAnswers(deps);
	const sessionFileThere = sessionFileThereOf(deps);

	/**
	 * The transcript of `lane` whose header names `sessionId`, in the lane's own directory as pi-loops
	 * derives it from the lane: a loop's sessions, the check sessions of the project the lane is, the
	 * directory of the conversation's own file for its own id. Never a path from the inbox.
	 */
	const laneOwns = (lane: Lane, sessionId: string, finding: Finding): string | undefined => {
		if (lane.kind === "conversation") {
			const own = sessionId === lane.id ? deps.sessionFile(lane.id) : undefined;
			return own === undefined ? undefined : laneTranscript(path.dirname(own), sessionId);
		}
		if (lane.kind === "check" && deps.checkLaneOf(finding.cwd) !== lane.id) return undefined;
		return laneTranscript(lane.kind === "loop" ? jobs.sessionDirFor(lane.id.slice(1)) : deps.checkSessionDir(finding.cwd), sessionId);
	};

	/** The session id of the transcript an answer to `finding` resumes: the ask's, or the run's that filed it. */
	const transcriptIdOf = (finding: Finding): string | undefined => (finding.ask ? finding.ask.session_id : finding.transcript_id);

	/** E3's check, and what C3 reads: the ask's transcript, found by `laneOwns` and read once, outside every lock. */
	const transcriptFacts = (lane: Lane, finding: Finding & { ask: Ask }, rowId: string): TranscriptFacts => {
		const id = finding.ask.session_id;
		// A question an older version wrote names a path, not a session: nothing proves its call now.
		if (id === undefined) return { check: "no-call", prompt: false };
		if (lane.kind === "conversation" && id !== lane.id) return { check: "outside", prompt: false };
		const file = laneOwns(lane, id, finding);
		const entries = file === undefined ? undefined : deps.entries(file);
		if (!entries) return { check: "file-gone", prompt: false };
		return { check: blockedCall(entries, finding.ask.call), prompt: holdsPrompt(entries, rowId) };
	};

	const jobIdOf = (lane: Lane, finding: Finding | undefined): string => (lane.kind === "loop" ? lane.id.slice(1) : lane.kind === "check" ? lane.id : (finding?.job_id ?? ""));

	const close: Answers["close"] = async (row, now, ended) => {
		const lane = parseLane(row.lane);
		const findingId = row.payload?.finding ?? "";
		const seen = inbox.list().find((f) => f.id === findingId);
		const claimedAt = Date.parse(row.run.started_at);

		// C1: the record this claim's run wrote, else the one in hand, else one that says the process died.
		let found: RunRecordM5a | undefined;
		const interrupted: RunRecordM5a = {
			runId: row.run.id,
			jobId: lane ? jobIdOf(lane, seen) : "",
			stateful: lane?.kind === "loop",
			cwd: seen?.cwd ?? row.payload?.cwd ?? "",
			pid: row.run.pid,
			startedAt: row.run.started_at,
			finishedAt: stamp(now),
			ok: false,
			error: WHY.died,
			findings: 0,
			droppedFindings: 0,
			stateUpdated: false,
			interrupted: true,
			row: row.id,
			cause: "answer",
		};
		const fresh: RunRecordM5a = ended ? { ...ended, cause: "answer" } : interrupted;
		let record: RunRecordM5a;
		try {
			const written = jobs.appendRunOnce((records) => {
				found = records.find((r) => r.runId === row.run.id && Date.parse(r.startedAt) >= claimedAt);
				return found ? undefined : fresh;
			});
			record = found ?? written ?? fresh;
		} catch (err: unknown) {
			if (!ended) throw err;
			deps.log(`answers: the record of ${row.run.id} could not be written: ${err instanceof Error ? err.message : String(err)}`);
			record = fresh;
		}

		// C2: a loop's run fires hooks.
		if (lane?.kind === "loop") deps.runEnd(record, lane.id);

		// C3: the transcript is read before the lock; the step is decided on the finding under it.
		const transcript = lane && seen?.ask ? transcriptFacts(lane, seen as Finding & { ask: Ask }, row.id) : undefined;
		const state = await inbox.section((tx): FinalState | "none" => {
			const finding = tx.find(findingId);
			if (!finding) return "none";
			const step = answerStep("C3", finding, closeOutcome(finding, record, transcript), { at: stamp(now), lane: row.lane });
			if ("refused" in step) return finalOf(finding);
			return finalOf(tx.write(step));
		});

		// C4: the row leaves last, and only with this claim on it.
		requests.removeIf(row.lane, row.id, (r) => r.run?.id === row.run.id);
		return { state, record };
	};

	return {
		...person,

		async meet(lane, rowId, executor, now) {
			// Before the locks: jobs.json, the finding as it is now, the transcript, and what blocks the lane.
			const all = jobs.load();
			const before = requests.list(lane.id).find((r) => r.id === rowId);
			if (!before || !isAnswerRow(before)) return { met: "nothing" };
			const findingId = before.payload?.finding ?? "";
			const seen = inbox.list().find((f) => f.id === findingId);
			const fact = seen ? laneFact(seen, all, sessionFileThere) : NO_LANE;
			const ownProject = lane.kind !== "check" || (seen !== undefined && deps.checkLaneOf(seen.cwd) === lane.id);
			const proof = seen?.ask ? { ask: seen.ask.id, check: transcriptFacts(lane, seen as Finding & { ask: Ask }, rowId).check as CallCheck } : undefined;
			const resumeId = seen ? transcriptIdOf(seen) : undefined;
			const resumeFile = seen && resumeId !== undefined ? laneOwns(lane, resumeId, seen) : undefined;
			const resume: Resume | undefined = resumeFile === undefined || resumeId === undefined ? undefined : { file: resumeFile, sessionId: resumeId };
			const blocked = executor.blocked(lane, seen, resume?.sessionId);
			const at = stamp(now);

			type Inside =
				| { out: MeetOutcome; row?: Row; why?: string; cwd?: string }
				| { close: ClaimedRow }
				| { finish: ClaimedRow; runEnd: boolean; state: FinalState | "none" };
			const inner = await inbox.section((tx): Inside => {
				const row = requests.list(lane.id).find((r) => r.id === rowId);
				if (!row || !isAnswerRow(row) || row.payload?.finding !== findingId) return { out: { met: "nothing" } };
				const finding = tx.find(findingId);
				const live = row.run ? executor.live(row) : false;
				const met = meetAnswerRow(row, finding, { lane: fact, ownProject, ...(proof ? { proof } : {}), live, ...(blocked === undefined ? {} : { blocked }), at, inbox: tx.list() });
				const cwd = finding?.cwd ?? row.payload?.cwd ?? "";
				switch (met.case) {
					case "E1": {
						const read = canonicalJson(row);
						const taken = requests.removeIf(lane.id, row.id, (r) => canonicalJson(r) === read, UNDER_INBOX_LOCK);
						if (taken.outcome !== "removed") return { out: { met: "nothing" } };
						return { out: { met: "E1", exit: "stale" }, row, why: met.why, cwd };
					}
					case "E2":
					case "E3":
					case "GONE":
					case "F1-dead": {
						tx.write(met.write);
						requests.remove(lane.id, [row.id], UNDER_INBOX_LOCK);
						const exit: AnswerExit = met.case === "E2" ? "job-removed" : met.case === "E3" ? "refused" : met.case === "F1-dead" ? "dead" : "stale";
						return { out: { met: met.case, exit }, row, why: met.case === "GONE" ? WHY.conversationDeleted : undefined, cwd };
					}
					case "hold":
						return { out: { met: "hold", why: met.why }, row };
					case "E4": {
						// meetAnswerRow gives E4 only for a row with no claim and a finding it read.
						const unclaimed = row as UnclaimedRow;
						const claimed = executor.claim(unclaimed, finding!, UNDER_INBOX_LOCK, now);
						if (!claimed) return { out: { met: "hold", why: "no free slot" }, row };
						try {
							const step = answerStep("E4", finding, { to: "started", run: claimed.run }, { at, lane: lane.id });
							if ("refused" in step) throw new Error(`E4b refused for ${findingId}: ${step.refused}`);
							const written = tx.write(step);
							const start: AnswerStart = { row: claimed, finding: { ...written }, ...(met.grant ? { grant: met.grant } : {}), ...(resume ? { resume } : {}), jobId: jobIdOf(lane, written) };
							return { out: { met: "E4", start } };
						} catch (err) {
							executor.release(claimed.run.id);
							throw err;
						}
					}
					case "W1":
						return { out: { met: "W1" } };
					case "F1":
						requests.update(lane.id, row.id, { run: undefined, attempts: met.attempts, not_before: stamp(now + met.waitMs) }, UNDER_INBOX_LOCK);
						return { out: { met: "F1", attempts: met.attempts } };
					case "F2":
						return { close: row as ClaimedRow };
					case "F3":
						return { finish: row as ClaimedRow, runEnd: met.runEnd, state: finalOf(finding) };
				}
			});

			if ("close" in inner) {
				const { state } = await close(inner.close, now);
				return { met: "F2", state };
			}
			if ("finish" in inner) {
				const claim = inner.finish.run;
				if (inner.runEnd && lane.kind === "loop") {
					const record = jobs.listRuns(undefined, Number.MAX_SAFE_INTEGER).find((r) => r.runId === claim.id);
					if (record) deps.runEnd(record, lane.id);
				}
				requests.removeIf(lane.id, rowId, (r) => r.run?.id === claim.id);
				return { met: "F3", state: inner.state };
			}
			const { out, row } = inner;
			if ((out.met === "E1" || out.met === "E2" || out.met === "E3" || out.met === "GONE" || out.met === "F1-dead") && row) auditExit(deps, row.id, lane.id, findingId, out.exit, inner.cwd ?? "", inner.why);
			if (out.met === "hold" && row && row.waiting !== out.why) {
				try {
					requests.update(lane.id, row.id, { waiting: out.why });
				} catch (err: unknown) {
					deps.log(`answers: why ${row.id} waits could not be written: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return out;
		},

		close,

		repair: (() => {
			// The ids of the findings whose answer is open, and the inbox file's mark when they were read.
			let open = new Set<string>();
			let mark: string | undefined;
			return async (executes: (lane: Lane) => boolean, now: number): Promise<string[]> => {
				let seenMark: string;
				try {
					const st = fs.statSync(inbox.file);
					seenMark = `${st.size}:${st.mtimeMs}`;
				} catch {
					seenMark = "none"; // no inbox yet: nothing is open
				}
				if (seenMark === mark && open.size === 0) return [];
				const at = stamp(now);
				const appended = await inbox.section((tx) => {
					const findings = tx.list();
					const openNow = findings.filter((f) => f.answer?.state === "pending" || f.answer?.state === "started");
					open = new Set(openNow.map((f) => f.id));
					const lanes = new Map<LaneId, readonly Row[]>();
					for (const f of openNow) {
						const parsed = f.lane === undefined ? undefined : parseLane(f.lane);
						if (parsed && !lanes.has(parsed.id) && executes(parsed)) lanes.set(parsed.id, requests.list(parsed.id));
					}
					if (!lanes.size) return [];
					return repairRows(openNow, lanes, { at, self: deps.self() }).flatMap((row) => (requests.appendIfAbsent(row, {}, UNDER_INBOX_LOCK) ? [row.id] : []));
				});
				mark = seenMark;
				return appended;
			};
		})(),
	};
}
