/**
 * The runs that are going in this process: a loop's run, and a held turn in a closed conversation.
 * One list per process, with one owner. Whoever asks what runs here (the status, a stop, the sweep
 * of leases nobody uses, the page) reads this list, and a claim on a row is written only through it.
 */
import type { ConversationId } from "./lane.ts";
import type { LockOptions } from "./lock.ts";
import type { ClaimedRow, Listed, RequestStore, UnclaimedRow } from "./requests.ts";
import { stamp } from "./schedule.ts";

/** The reason of an abort that a person asked for (the page's Stop, `pi-loops abort`, `/triggers abort`). */
export const STOPPED_BY_PERSON = "stopped by a person";

/** One run that is going in this process. */
export interface Running {
	readonly runId: string;
	readonly jobId: string;
	/** What `pi-loops status` calls it: the job's name, else its id. */
	readonly label: string;
	readonly startedAt: string;
	readonly promptPreview: string;
	sessionFile?: string;
	readonly ctrl: AbortController;
	stoppedFrom?: "page" | "cli";
	/** A held turn only: the closed conversation it writes, the lease it runs under, and what the page's waiting line calls it. */
	readonly turn?: { readonly sessionId: ConversationId; readonly epoch: number; readonly sessionFile: string; readonly cwd?: string; readonly label: string };
}

/** The list. A caller gets it as a parameter; nothing reaches it through module state. */
export class RunList {
	#runs = new Map<string, Running>();

	/** Add a run under its id, replacing any run already there. */
	add(run: Running): void {
		this.#runs.set(run.runId, run);
	}

	/**
	 * Claim `row` for a run of this process, in one synchronous step: the run goes in the list, then
	 * the claim is written under the lane's lock. So no claim is on disk without its run in the list,
	 * and a stop cannot fall between the two. The run id is the row's id, and the run's `startedAt`
	 * and the claim's `started_at` are one stamp of `now`: a record written for this run is found by
	 * them. Returns the claimed row, or undefined when the row is gone, another run has it, or its run
	 * is in the list already; the run is then not in the list. When the write throws, the run is
	 * taken out and the error goes on: no claim was written. This is the one caller of
	 * `RequestStore.claim`. `lock` bounds the wait for the lane's lock, for a caller that holds `inbox.lock`.
	 */
	claim(requests: Pick<RequestStore, "claim">, row: UnclaimedRow, by: { readonly pid: number; readonly procStart: string | undefined }, run: Omit<Running, "runId" | "startedAt">, now: number, lock?: LockOptions): ClaimedRow | undefined {
		if (this.#runs.has(row.id)) return undefined;
		const startedAt = stamp(now);
		this.#runs.set(row.id, { ...run, runId: row.id, startedAt });
		const claim = { id: row.id, pid: by.pid, started_at: startedAt, ...(by.procStart === undefined ? {} : { procStart: by.procStart }) } as Listed;
		let claimed = false;
		try {
			claimed = requests.claim(row.lane, row.id, claim, lock);
		} finally {
			if (!claimed) this.#runs.delete(row.id);
		}
		return claimed ? { ...row, kind: "input", run: claim } : undefined;
	}

	/** Take a run out of the list and say whether it was there. */
	remove(runId: string): boolean {
		return this.#runs.delete(runId);
	}

	/** Get a run by id, or return undefined when it is absent. */
	get(runId: string): Running | undefined {
		return this.#runs.get(runId);
	}

	/** Return a copy of the runs in their insertion order. */
	all(): readonly Running[] {
		return [...this.#runs.values()];
	}

	/** The held turn in a conversation, as the page and a stop that names the current turn read it: its run, what to call it, and when it started. */
	turnIn(sessionId: string): { runId: string; label: string; startedAt: string } | undefined {
		const run = this.all().find((candidate) => candidate.turn?.sessionId === sessionId);
		return run?.turn ? { runId: run.runId, label: run.turn.label, startedAt: run.startedAt } : undefined;
	}

	/** A person stops a run: where the stop came from is kept (the first word stands), and the run is aborted with `STOPPED_BY_PERSON`. False when the run is not in the list. */
	stop(runId: string, from: "page" | "cli" = "cli"): boolean {
		const run = this.#runs.get(runId);
		if (!run) return false;
		run.stoppedFrom ??= from;
		run.ctrl.abort(STOPPED_BY_PERSON);
		return true;
	}

	/** Where the stop on its way to `runId` comes from, for a stop that arrives through a request row. */
	noteStopFrom(runId: string, from: "page" | "cli"): void {
		const run = this.#runs.get(runId);
		if (run) run.stoppedFrom ??= from;
	}
}
