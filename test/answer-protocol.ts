/**
 * The answer protocol's tables that only the tests read (`.docs/redesign-0243/answer-protocol.md`):
 * the durable writes of each transition in order, with the lock held at each (`PROTOCOL`), and the
 * news filed with each state (`BESIDE`). test/ask.test.ts and test/convert-v2.test.ts log the
 * writes of each transition and compare the log with `PROTOCOL`.
 */
import type { AnswerState, Beside, OpenState } from "../src/ask.ts";

/**
 * The news that is filed with each state, in the same rewrite. The type gives every final state
 * but `done` a companion.
 */
export const BESIDE = {
	pending: undefined,
	started: undefined,
	done: undefined,
	unfinished: "outcome",
	not_run: "not-run",
} as const satisfies { [S in AnswerState]: S extends OpenState | "done" ? undefined : Beside };

/**
 * One durable write. `finding`: one rewrite of `inbox.jsonl`. `row+`, `row.run`, `row~`, `row-`: a
 * row appended, claimed, patched, removed. `inbox+lane`: a lane write made while `inbox.lock` is held.
 */
export interface ProtocolWrite {
	/** The protocol's id of this write. */
	readonly id: string;
	readonly write: "finding" | "row+" | "row.run" | "row~" | "row-" | "record" | "run_end" | "audit" | "jobs";
	readonly lock: "inbox" | "inbox+lane" | "lane" | "runs" | "jobs" | "none";
	/** The condition of a write that is not always made. */
	readonly when?: string;
}

export const PROTOCOL = {
	Q1: [{ id: "Q1", write: "finding", lock: "inbox" }],
	Y1: [{ id: "Y1a", write: "finding", lock: "inbox" }, { id: "Y1b", write: "row+", lock: "lane" }],
	Y2: [{ id: "Y2", write: "finding", lock: "inbox" }],
	YC: [{ id: "YC", write: "finding", lock: "inbox" }],
	N1: [{ id: "N1a", write: "finding", lock: "inbox" }, { id: "N1b", write: "row+", lock: "lane", when: "the ask's lane is a conversation" }],
	E1: [{ id: "E1", write: "row-", lock: "inbox+lane" }, { id: "E1.audit", write: "audit", lock: "none" }],
	E2: [{ id: "E2", write: "finding", lock: "inbox" }, { id: "E2.row", write: "row-", lock: "inbox+lane" }, { id: "E2.audit", write: "audit", lock: "none" }],
	E3: [{ id: "E3", write: "finding", lock: "inbox" }, { id: "E3.row", write: "row-", lock: "inbox+lane" }, { id: "E3.audit", write: "audit", lock: "none" }],
	GONE: [{ id: "GONE", write: "finding", lock: "inbox" }, { id: "GONE.row", write: "row-", lock: "inbox+lane" }, { id: "GONE.audit", write: "audit", lock: "none" }],
	E4: [{ id: "E4a", write: "row.run", lock: "inbox+lane" }, { id: "E4b", write: "finding", lock: "inbox" }],
	W1: [],
	F1: [{ id: "F1", write: "row~", lock: "inbox+lane" }],
	"F1-dead": [{ id: "F1", write: "finding", lock: "inbox" }, { id: "F1.row", write: "row-", lock: "inbox+lane" }, { id: "F1.audit", write: "audit", lock: "none" }],
	F2: [{ id: "C1", write: "record", lock: "runs" }, { id: "C2", write: "run_end", lock: "none" }, { id: "C3", write: "finding", lock: "inbox" }, { id: "C4", write: "row-", lock: "lane" }],
	F3: [{ id: "C2", write: "run_end", lock: "none", when: "the answer has a claim" }, { id: "C4", write: "row-", lock: "lane" }],
	C: [{ id: "C1", write: "record", lock: "runs" }, { id: "C2", write: "run_end", lock: "none" }, { id: "C3", write: "finding", lock: "inbox" }, { id: "C4", write: "row-", lock: "lane" }],
	/** The row leaves first, so a finding that is open again never has the row of the answer it had. */
	V: [{ id: "V2", write: "row-", lock: "inbox+lane" }, { id: "V1", write: "finding", lock: "inbox" }, { id: "V2.audit", write: "audit", lock: "none" }],
	H1: [{ id: "H1", write: "row+", lock: "inbox+lane" }],
	"removed-job": [{ id: "removed-job", write: "jobs", lock: "jobs" }],
	/** The conversion of an `inbox:` row that 0.24.2 handed over (section 14 of the sketch). */
	K1: [{ id: "K1", write: "row-", lock: "inbox+lane" }, { id: "K1.audit", write: "audit", lock: "none" }],
	/**
	 * The conversion of an `inbox:` row that 0.24.2 had not handed over: its finding reopened as V1
	 * reopens one, then the row. The order is V's reversed on purpose: the row is what finds the finding
	 * at the next start, so a stop between the two leaves an inert row beside a finding open again, which
	 * the next start removes; the other order would leave the finding claimed with nothing to find it.
	 */
	K2: [{ id: "K2", write: "finding", lock: "inbox+lane" }, { id: "K2.row", write: "row-", lock: "inbox+lane" }, { id: "K2.audit", write: "audit", lock: "none" }],
} as const satisfies Record<string, readonly ProtocolWrite[]>;
