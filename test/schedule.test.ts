import { test } from "node:test";
import assert from "node:assert/strict";
import { clampFuture, computeDue, computeNext, cronLatestBetween, cronMatches, cronNextAfter, localOffset, parseCron, parseDuration, parseSchedule, stamp } from "../src/schedule.ts";

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

test("parseDuration", () => {
	assert.equal(parseDuration("30m"), 30 * 60_000);
	assert.equal(parseDuration("1h30m"), 90 * 60_000);
	assert.equal(parseDuration("45s"), 45_000);
	assert.equal(parseDuration("2d"), 2 * 86_400_000);
	assert.throws(() => parseDuration("abc"));
	assert.throws(() => parseDuration("10"));
	assert.throws(() => parseDuration("0m"));
});

test("parseSchedule forms", () => {
	assert.deepEqual(parseSchedule("0 9 * * *"), { kind: "cron", expr: "0 9 * * *" });
	assert.deepEqual(parseSchedule("@daily"), { kind: "cron", expr: "0 0 * * *" });
	assert.deepEqual(parseSchedule("every 30m"), { kind: "every", ms: 1_800_000 });
	const now = local(2026, 9, 8, 10, 0);
	assert.deepEqual(parseSchedule("in 10m", now), { kind: "once", at: now + 600_000 });
	assert.equal(parseSchedule("at 2026-09-08T18:00").kind, "once");
	assert.throws(() => parseSchedule("0 9 * *"), /invalid schedule/);
	assert.throws(() => parseSchedule("61 9 * * *"), /invalid cron field `61`: value 61 out of range 0-59/);
	assert.throws(() => parseCron("1 2 3 4"), /cron schedule must have 5 fields: minute hour day-of-month month day-of-week/);
	assert.throws(() => parseSchedule("*/0 * * * *"), /invalid cron field `\*\/0`: step must be at least 1/);
	assert.throws(() => parseSchedule("at yesterday"), /invalid timestamp/);
});

test("cron parsing: steps, ranges, lists, names, sunday alias", () => {
	const f = parseCron("*/15 9-17 1,15 jan-mar mon-fri");
	assert.deepEqual([...f.minutes], [0, 15, 30, 45]);
	assert.deepEqual([...f.hours], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
	assert.deepEqual([...f.days], [1, 15]);
	assert.deepEqual([...f.months], [1, 2, 3]);
	assert.deepEqual([...f.dows], [1, 2, 3, 4, 5]);
	assert.ok(parseCron("0 0 * * 7").dows.has(0));
	assert.throws(() => parseCron("0 0 * * 8"));
	assert.throws(() => parseCron("a b c d e"));
});

test("cron dom/dow OR semantics like vixie cron", () => {
	const both = parseCron("0 0 1 * mon");
	// 2026-09-01 is a Tuesday, matches by dom
	assert.ok(cronMatches(both, new Date(2026, 8, 1, 0, 0)));
	// 2026-09-07 is a Monday, matches by dow
	assert.ok(cronMatches(both, new Date(2026, 8, 7, 0, 0)));
	assert.ok(!cronMatches(both, new Date(2026, 8, 2, 0, 0)));
	const domOnly = parseCron("0 0 1 * *");
	assert.ok(!cronMatches(domOnly, new Date(2026, 8, 7, 0, 0)));
});

test("cronNextAfter does not return the current minute; cronLatestBetween honors since", () => {
	const f = parseCron("0 9 * * *");
	const at9 = local(2026, 9, 8, 9, 0, 30);
	assert.equal(cronNextAfter(f, at9), local(2026, 9, 9, 9, 0));
	assert.equal(cronLatestBetween(f, local(2026, 9, 7, 12, 0), local(2026, 9, 8, 9, 5)), local(2026, 9, 8, 9, 0));
	// created after 09:00 today → nothing owed yet
	assert.equal(cronLatestBetween(f, at9, local(2026, 9, 8, 9, 5)), undefined);
});

test("computeDue collapses missed cron ticks into one", () => {
	const schedule = parseSchedule("0 9 * * *");
	const createdAt = local(2026, 9, 1, 8, 0);
	// offline for a week: owes exactly the latest 09:00
	const now = local(2026, 9, 8, 12, 0);
	assert.equal(computeDue({ schedule, createdAt }, now), local(2026, 9, 8, 9, 0));
	// after recording lastDueAt, nothing more is owed
	assert.equal(computeDue({ schedule, createdAt, lastDueAt: local(2026, 9, 8, 9, 0) }, now), undefined);
	// next day
	assert.equal(computeDue({ schedule, createdAt, lastDueAt: local(2026, 9, 8, 9, 0) }, local(2026, 9, 9, 9, 0, 20)), local(2026, 9, 9, 9, 0));
});

test("computeDue for every/once", () => {
	const every = parseSchedule("every 30m");
	const createdAt = local(2026, 9, 8, 10, 0);
	assert.equal(computeDue({ schedule: every, createdAt }, createdAt + 29 * 60_000), undefined);
	assert.equal(computeDue({ schedule: every, createdAt }, createdAt + 31 * 60_000), createdAt + 30 * 60_000);
	// offline for 5h → one due (latest multiple)
	assert.equal(computeDue({ schedule: every, createdAt }, createdAt + 5 * 3_600_000 + 1), createdAt + 10 * 1_800_000);
	assert.equal(computeDue({ schedule: every, createdAt, lastFiredAt: createdAt + 5 * 3_600_000 }, createdAt + 5 * 3_600_000 + 1), undefined);
	const once = parseSchedule("in 10m", createdAt);
	assert.equal(computeDue({ schedule: once, createdAt }, createdAt + 9 * 60_000), undefined);
	assert.equal(computeDue({ schedule: once, createdAt }, createdAt + 11 * 60_000), createdAt + 10 * 60_000);
	assert.equal(computeDue({ schedule: once, createdAt, lastFiredAt: createdAt + 11 * 60_000 }, createdAt + 20 * 60_000), undefined);
	// A one-shot the scheduler acted on but did not fire (catch-up declined) has spent its slot too;
	// rolling both stamps back is how a crashed or failed run gets it back.
	assert.equal(computeDue({ schedule: once, createdAt, lastDueAt: createdAt + 10 * 60_000 }, createdAt + 20 * 60_000), undefined);
	assert.equal(computeDue({ schedule: once, createdAt }, createdAt + 20 * 60_000), createdAt + 10 * 60_000);
	assert.equal(computeNext({ schedule: every, createdAt }, createdAt + 31 * 60_000), createdAt + 60 * 60_000);
});

test("schedule aliases: hourly/daily/weekly, english phrases, chinese", () => {
	assert.deepEqual(parseSchedule("hourly"), { kind: "cron", expr: "0 * * * *" });
	assert.deepEqual(parseSchedule("every hour"), { kind: "cron", expr: "0 * * * *" });
	assert.deepEqual(parseSchedule("once a day"), { kind: "cron", expr: "0 9 * * *" });
	assert.deepEqual(parseSchedule("Weekly"), { kind: "cron", expr: "0 9 * * 1" });
	assert.deepEqual(parseSchedule("每天"), { kind: "cron", expr: "0 9 * * *" });
	assert.deepEqual(parseSchedule("每小时检查"), { kind: "cron", expr: "0 * * * *" });
	assert.deepEqual(parseSchedule("每周"), { kind: "cron", expr: "0 9 * * 1" });
	assert.throws(() => parseSchedule("sometimes"), /supported alias/);
});

test("a stamp from the future does not wedge the clock forever", () => {
	const now = Date.now();
	const future = now + 30 * 86_400_000; // a wrong clock, later corrected by NTP
	// cron: `since > now` used to make cronLatestBetween return undefined for 30 days.
	const daily = { kind: "cron", expr: "0 9 * * *" } as const;
	assert.notEqual(computeDue({ schedule: daily, createdAt: now - 86_400_000, lastDueAt: future }, now), undefined, "a daily job still fires");
	// every: `now - base < ms` was true for the whole window.
	assert.notEqual(computeDue({ schedule: { kind: "every", ms: 60_000 }, createdAt: now - 120_000, lastFiredAt: future }, now), undefined);
	// A createdAt in the future is discarded too: the job is treated as created now, so it waits one
	// interval rather than being stuck for 30 days.
	assert.notEqual(computeDue({ schedule: { kind: "every", ms: 60_000 }, createdAt: future }, now), undefined, "due once, then it runs from its own real stamps");

	assert.equal(clampFuture(future, now), undefined, "a future stamp is not evidence about the past");
	assert.equal(clampFuture(now - 1000, now), now - 1000, "the past is left alone");
	assert.equal(clampFuture(now + 5_000, now), now + 5_000, "a little clock skew is tolerated");
	assert.equal(clampFuture(undefined, now), undefined);
	assert.equal(clampFuture(Number.NaN, now), undefined);

	// A one-shot is the exception: dropping its future stamps would make it owe its single slot all
	// over again, and `run this at 3pm` is not a thing to run twice. runCount says it already went.
	const once = { kind: "once", at: now - 600_000 } as const;
	assert.equal(computeDue({ schedule: once, createdAt: now - 900_000, lastFiredAt: future }, now), undefined, "already ran, whatever the clock says");
	assert.equal(computeDue({ schedule: once, createdAt: now - 900_000, lastDueAt: future }, now), undefined, "a slot the scheduler declined is spent too");
	// The retry a failed one-shot gets clears both stamps on purpose, and must still come due.
	assert.notEqual(computeDue({ schedule: once, createdAt: now - 900_000 }, now), undefined, "the deliberate retry is not blocked");
});

test("a stamp is this machine's time, carrying the offset that makes it an instant", () => {
	// Everything pi-loops writes goes through this: cron expressions are matched against this
	// machine's clock, and a file whose timestamps are eight hours from the screen describing them
	// is a file nobody can read against what they just did.
	const at = Date.UTC(2026, 8, 11, 12, 37, 59, 405);
	const s = stamp(at);
	assert.equal(Date.parse(s), at, "the instant survives the spelling");
	assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, "and says which clock it came off");
	assert.equal(s.slice(0, 19), new Date(at).toLocaleString("sv-SE").replace(" ", "T"), "the wall clock is the local one");

	// What was written before this convention — and by pi — still reads back the same.
	assert.equal(Date.parse("2026-09-11T12:37:59.405Z"), at, "a UTC stamp is still an instant");
	const mixed = ["2026-09-11T12:37:59.405Z", stamp(at + 1000)].sort((a, b) => Date.parse(a) - Date.parse(b));
	assert.equal(Date.parse(mixed[0]), at, "and the two spellings order by moment, not by text");
});
