/**
 * The one place that answers "may another sub-agent start now".
 *
 * A loop run, a trigger check and the /goal evaluator are the same thing to this process: an
 * in-process pi session with its own model calls and its own bill. `[cron] max_concurrent_runs`
 * reads as "at most this many sub-agents at once" — that is how anyone sizes it, for memory, for
 * rate limits, for their own money — but the scheduler and the trigger runtime each counted only
 * their own kind against it, so 3 permitted three runs *plus* three checks *plus* an evaluator.
 * One counter, taken from and released by both pipelines, is what makes the number true.
 *
 * Per process on purpose. This bounds the sessions *this* pi opens; two pi windows are two
 * processes with two pools, as they are two of everything else here. Nothing coordinates across
 * processes and nothing should: a file lock in the admission path would put a disk round-trip
 * inside every tick to bound a resource (this process's memory and sockets) that is not shared.
 *
 * What a refusal *means* is deliberately not decided here. The scheduler leaves the tick owed and
 * retries; the trigger runtime queues a push and drops a periodic check. Admission is one question
 * with one answer; what to do with a "no" belongs to the pipeline that asked.
 */

export interface SubagentSlot {
	/** Idempotent: the release sites are `finally` blocks, and more than one can cover a path. */
	release(): void;
}

export class SubagentSlots {
	private inUse = 0;
	private readonly getLimit: () => number;

	constructor(limit: number | (() => number)) {
		this.getLimit = typeof limit === "function" ? limit : () => limit;
	}

	/** Read live, so a config reload takes effect at the next admission and not at the next restart. */
	get limit(): number {
		return this.getLimit();
	}

	/** What `/triggers running` reports against `limit`, across both pipelines. */
	get inUseCount(): number {
		return this.inUse;
	}

	/** Never negative: `occupy` can push the count past the limit. */
	get free(): number {
		return Math.max(0, this.limit - this.inUse);
	}

	/** A slot for work that may be refused; `undefined` when the limit is already reached. */
	acquire(): SubagentSlot | undefined {
		if (this.inUse >= this.limit) return undefined;
		return this.take();
	}

	/**
	 * A slot for work that is never refused: `/cron run` and the /goal evaluator, which the user
	 * asked for directly and which would break silently — a goal that stops being evaluated looks
	 * like a goal that was never set — if a busy machine could say no. It still counts, so the
	 * number stays honest; this is how `/triggers running` comes to say "4 of 3 slots in use".
	 */
	occupy(): SubagentSlot {
		return this.take();
	}

	private take(): SubagentSlot {
		this.inUse++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.inUse--;
			},
		};
	}
}
