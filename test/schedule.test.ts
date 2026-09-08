import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDue, computeNext, cronLatestBetween, cronMatches, cronNextAfter, parseCron, parseDuration, parseSchedule } from "../src/schedule.ts";

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
	assert.throws(() => parseSchedule("61 9 * * *"), /out of range/);
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
	assert.equal(computeNext({ schedule: every, createdAt }, createdAt + 31 * 60_000), createdAt + 60 * 60_000);
});

test("pie schedule aliases: hourly/daily/weekly, english phrases, chinese", () => {
	assert.deepEqual(parseSchedule("hourly"), { kind: "cron", expr: "0 * * * *" });
	assert.deepEqual(parseSchedule("every hour"), { kind: "cron", expr: "0 * * * *" });
	assert.deepEqual(parseSchedule("once a day"), { kind: "cron", expr: "0 9 * * *" });
	assert.deepEqual(parseSchedule("Weekly"), { kind: "cron", expr: "0 9 * * 1" });
	assert.deepEqual(parseSchedule("每天"), { kind: "cron", expr: "0 9 * * *" });
	assert.deepEqual(parseSchedule("每小时检查"), { kind: "cron", expr: "0 * * * *" });
	assert.deepEqual(parseSchedule("每周"), { kind: "cron", expr: "0 9 * * 1" });
	assert.throws(() => parseSchedule("sometimes"), /supported alias/);
});
