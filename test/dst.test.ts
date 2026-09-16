import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNext, cronMatches, cronNextAfter, parseCron } from "../src/schedule.ts";

/**
 * The daylight-saving table in `docs/loops.md` says "Measured, not assumed", and nothing that runs
 * measured it: no test in this directory set a time zone, and CI's runners are UTC, where there is
 * no transition for the code to get wrong. Deleting the second floor in `nextMidnight` left the
 * whole suite green while a `30 0 7 * *` job in America/Santiago moved a month.
 *
 * The zone is the process's, set before any `Date` is built here. `node --test` gives each file its
 * own process, so the two zones in this file cannot reach the tests beside it.
 */
const ZONE = "America/New_York";
process.env.TZ = ZONE;

/** A wall-clock stamp: what a person reads off a calendar, not an instant. Built in the current zone. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

/** Run `fn` in `zone`, and put the process back where the rest of the file expects it. */
function inZone(zone: string, fn: () => void) {
	process.env.TZ = zone;
	try {
		fn();
	} finally {
		process.env.TZ = ZONE;
	}
}

test("a skipped hour is a job that does not run, and the next day it does", () => {
	// docs/loops.md: "Spring forward — `0 2 * * *` on 8 March: 02:00 does not exist that day, so the
	// job does not run. It runs again the next day." Vixie cron runs the missed one once anyway;
	// pi-loops matches the wall clock, and there is no wall clock reading of 02:00 that day.
	const job = parseCron("0 2 * * *");
	for (let t = local(2026, 3, 8); t < local(2026, 3, 9); t += 60_000) {
		assert.equal(cronMatches(job, new Date(t)), false, `no 02:00 on 8 March: ${new Date(t).toString()}`);
	}
	assert.equal(cronNextAfter(job, local(2026, 3, 7, 12)), local(2026, 3, 9, 2), "so the next run is the day after");
});

test("a repeated hour is a job that runs twice", () => {
	// The other row: "Fall back — `0 1 * * *` on 1 November: 01:00 happens twice, so the job runs
	// twice." Two runs an hour apart, and the second one is standard time.
	const job = parseCron("0 1 * * *");
	const first = local(2026, 11, 1, 1);
	assert.equal(new Date(first).getTimezoneOffset(), 240, "the first 01:00 is still daylight time");
	const second = cronNextAfter(job, first);
	assert.equal(second, first + 3_600_000, "the next match is the same wall clock, an hour later");
	assert.equal(new Date(second as number).getTimezoneOffset(), 300, "and it is standard time");
});

test("a zone whose clocks jump at midnight does not lose the day after it", () => {
	// America/Santiago moves to summer time at 00:00 on 6 September 2026, so that midnight never
	// happens and floor-to-local-midnight lands on 01:00 instead. That floor builds the start of the
	// next day, so carrying the 01:00 into it skips the first hour — and the run in it. This is the
	// assertion the second floor in `nextMidnight` exists for: without it, the next run is October's.
	inZone("America/Santiago", () => {
		const next = cronNextAfter(parseCron("30 0 7 * *"), local(2026, 9, 1, 12));
		assert.equal(next, local(2026, 9, 7, 0, 30), `the first 7th after 1 September, not the second: ${new Date(next as number).toString()}`);
	});
});

test("every 24h is immune, because it counts elapsed time", () => {
	// docs/loops.md: "If a job must run exactly once a day whatever the clock does, `every 24h` is
	// immune — it counts elapsed time and never consults a calendar." Both transition days are
	// checked, because a day is 23 hours long in one of them and 25 in the other.
	inZone("America/Santiago", () => {
		const schedule = { kind: "every", ms: 86_400_000 } as const;
		for (const from of [local(2026, 4, 4, 12), local(2026, 9, 5, 12)]) {
			const at = computeNext({ schedule, createdAt: from, lastFiredAt: from }, from);
			assert.equal(at, from + 86_400_000, `exactly 24 hours from ${new Date(from).toString()}`);
		}
	});
});
