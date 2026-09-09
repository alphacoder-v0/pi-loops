/**
 * Schedule specs for loops.
 *
 *   cron   : 5-field crontab ("0 9 * * *", "*\/30 * * * 1-5", "@daily"), local time
 *   every  : fixed interval ("every 30m", "every 1h30m")
 *   once   : one-shot ("in 10m", "at 2026-09-08T18:00")
 *
 * All computations are in local time, like pie and crontab.
 */

export type Schedule =
	| { kind: "cron"; expr: string }
	| { kind: "every"; ms: number }
	| { kind: "once"; at: number };

const ALIASES: Record<string, string> = {
	"@hourly": "0 * * * *",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@weekly": "0 0 * * 0",
	"@monthly": "0 0 1 * *",
	"@yearly": "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "1h30m" → ms. Throws on malformed input. */
export function parseDuration(input: string): number {
	const text = input.trim().toLowerCase();
	if (!text) throw new Error("empty duration");
	const parts = text.match(/\d+(?:\.\d+)?(?:ms|s|m|h|d|w)/g);
	if (!parts || parts.join("") !== text) {
		throw new Error(`invalid duration "${input}" (use e.g. 30s, 10m, 1h30m, 2d)`);
	}
	let total = 0;
	for (const part of parts) {
		const m = DURATION_RE.exec(part);
		if (!m) throw new Error(`invalid duration "${input}"`);
		total += Number(m[1]) * UNIT_MS[m[2]];
	}
	if (total <= 0) throw new Error("duration must be positive");
	return Math.round(total);
}

export function formatDuration(ms: number): string {
	if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

/** pie's `normalize_schedule` aliases (daily/weekly land on 09:00 local, Monday for weekly). */
export function normalizeScheduleAlias(input: string): string | undefined {
	const trimmed = input.trim();
	const lower = trimmed.toLowerCase();
	if (["hourly", "every hour", "once an hour"].includes(lower)) return "0 * * * *";
	if (["daily", "every day", "once a day"].includes(lower)) return "0 9 * * *";
	if (["weekly", "every week", "once a week"].includes(lower)) return "0 9 * * 1";
	if (trimmed.includes("每小时") || trimmed.includes("每個小時")) return "0 * * * *";
	if (trimmed.includes("每天") || trimmed.includes("每日")) return "0 9 * * *";
	if (trimmed.includes("每周") || trimmed.includes("每週")) return "0 9 * * 1";
	return undefined;
}

/** Parse a schedule spec. Throws with a human-readable message. */
/** A `Schedule` that came from disk or an archive really is one; anything else is refused. */
export function isValidSchedule(s: unknown): s is Schedule {
	const v = s as any;
	if (!v || typeof v !== "object") return false;
	if (v.kind === "cron") return typeof v.expr === "string" && isValidCronExpr(v.expr);
	if (v.kind === "every") return Number.isFinite(v.ms) && v.ms >= 60_000;
	if (v.kind === "once") return Number.isFinite(v.at);
	return false;
}

function isValidCronExpr(expr: string): boolean {
	try {
		parseCron(expr);
		return true;
	} catch {
		return false;
	}
}

export function parseSchedule(spec: string, now: number = Date.now()): Schedule {
	const text = spec.trim();
	if (!text) throw new Error("empty schedule");
	const lower = text.toLowerCase();
	if (ALIASES[lower]) return { kind: "cron", expr: ALIASES[lower] };
	const alias = normalizeScheduleAlias(text);
	if (alias) return { kind: "cron", expr: alias };

	const tokens = text.split(/\s+/);
	if (tokens.length === 2) {
		const [head, rest] = [tokens[0].toLowerCase(), tokens[1]];
		if (head === "every") return { kind: "every", ms: parseDuration(rest) };
		if (head === "in") return { kind: "once", at: now + parseDuration(rest) };
		if (head === "at") {
			const at = Date.parse(rest);
			if (Number.isNaN(at)) throw new Error(`invalid timestamp "${rest}" (use ISO 8601, e.g. 2026-09-08T18:00)`);
			return { kind: "once", at };
		}
	}
	if (tokens.length === 5) {
		parseCron(text); // validate
		return { kind: "cron", expr: tokens.join(" ") };
	}
	throw new Error(
		`invalid schedule "${spec}": provide a 5-field cron expression, a supported alias such as hourly / every hour / daily / 每小时, "every 30m", "in 10m" or "at <ISO time>"`,
	);
}

export function formatSchedule(s: Schedule): string {
	switch (s.kind) {
		case "cron":
			return s.expr;
		case "every":
			return `every ${formatDuration(s.ms)}`;
		case "once":
			return `once ${formatLocal(s.at)}`;
	}
}

export function formatLocal(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------------------------------------------------------- cron */

export interface CronFields {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	dows: Set<number>;
	/** true when the day-of-month field is "*" (crontab OR semantics for dom/dow) */
	anyDay: boolean;
	anyDow: boolean;
}

export function parseCron(expr: string): CronFields {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error("cron schedule must have 5 fields: minute hour day-of-month month day-of-week");
	const [min, hour, dom, mon, dow] = parts;
	return {
		minutes: parseField(min, 0, 59, null),
		hours: parseField(hour, 0, 23, null),
		days: parseField(dom, 1, 31, null),
		months: parseField(mon, 1, 12, MONTH_NAMES),
		dows: normalizeDow(parseField(dow, 0, 7, DOW_NAMES)),
		anyDay: dom === "*",
		anyDow: dow === "*",
	};
}

function normalizeDow(set: Set<number>): Set<number> {
	if (set.has(7)) {
		set.delete(7);
		set.add(0);
	}
	return set;
}

function parseField(field: string, min: number, max: number, names: string[] | null): Set<number> {
	const out = new Set<number>();
	for (const item of field.split(",")) {
		if (!item) throw new Error(`invalid cron field \`${field}\`: empty list item`);
		let [rangePart, stepPart] = item.split("/");
		if (stepPart !== undefined && !/^\d+$/.test(stepPart)) throw new Error(`invalid cron field \`${field}\`: bad step`);
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (step < 1) throw new Error(`invalid cron field \`${field}\`: step must be at least 1`);
		let lo: number;
		let hi: number;
		if (rangePart === "*") {
			lo = min;
			hi = max;
		} else if (rangePart.includes("-")) {
			const [a, b] = rangePart.split("-");
			lo = parseNumber(a, field, min, max, names);
			hi = parseNumber(b, field, min, max, names);
			if (lo > hi) throw new Error(`invalid cron field \`${field}\`: range start exceeds end`);
		} else {
			lo = parseNumber(rangePart, field, min, max, names);
			hi = stepPart === undefined ? lo : max;
		}
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	if (out.size === 0) throw new Error(`invalid cron field \`${field}\`: no values`);
	return out;
}

function parseNumber(raw: string, field: string, min: number, max: number, names: string[] | null): number {
	let n: number;
	if (/^\d+$/.test(raw)) n = Number(raw);
	else if (names) {
		const idx = names.indexOf(raw.toLowerCase().slice(0, 3));
		if (idx < 0) throw new Error(`invalid cron field \`${field}\`: unknown name "${raw}"`);
		n = names === MONTH_NAMES ? idx + 1 : idx;
	} else throw new Error(`invalid cron field \`${field}\`: invalid value "${raw}"`);
	if (n < min || n > max) throw new Error(`invalid cron field \`${field}\`: value ${n} out of range ${min}-${max}`);
	return n;
}

export function cronMatches(f: CronFields, d: Date): boolean {
	if (!f.minutes.has(d.getMinutes())) return false;
	if (!f.hours.has(d.getHours())) return false;
	if (!f.months.has(d.getMonth() + 1)) return false;
	const dayOk = f.days.has(d.getDate());
	const dowOk = f.dows.has(d.getDay());
	// Vixie cron: when both dom and dow are restricted, either matching is enough.
	if (!f.anyDay && !f.anyDow) return dayOk || dowOk;
	return dayOk && dowOk;
}

const MINUTE = 60_000;
const MAX_LOOKAHEAD_MS = 366 * 5 * 86_400_000;
const MAX_LOOKBACK_MS = 400 * 86_400_000;

function floorMinute(ts: number): number {
	const d = new Date(ts);
	d.setSeconds(0, 0);
	return d.getTime();
}

/** First cron match strictly after `after` (minute resolution). */
export function cronNextAfter(f: CronFields, after: number): number | undefined {
	let t = floorMinute(after) + MINUTE;
	const limit = after + MAX_LOOKAHEAD_MS;
	while (t <= limit) {
		if (cronMatches(f, new Date(t))) return t;
		t += MINUTE;
	}
	return undefined;
}

/** Latest cron match at or before `now` and strictly after `since`. */
export function cronLatestBetween(f: CronFields, since: number, now: number): number | undefined {
	let t = floorMinute(now);
	const floor = Math.max(since, now - MAX_LOOKBACK_MS);
	while (t > floor) {
		if (cronMatches(f, new Date(t))) return t;
		t -= MINUTE;
	}
	return undefined;
}

/* ------------------------------------------------------------ due logic */

export interface DueInput {
	schedule: Schedule;
	createdAt: number;
	lastDueAt?: number;
	lastFiredAt?: number;
}

/**
 * The single due time this job owes as of `now`, or undefined.
 * Missed ticks collapse into one (the latest), so a daily job that was offline
 * for a week comes back owing exactly one run.
 */
export function computeDue(input: DueInput, now: number): number | undefined {
	const { schedule } = input;
	switch (schedule.kind) {
		case "cron": {
			const since = input.lastDueAt ?? input.createdAt;
			return cronLatestBetween(parseCron(schedule.expr), since, now);
		}
		case "every": {
			const base = input.lastFiredAt ?? input.createdAt;
			if (now - base < schedule.ms) return undefined;
			const k = Math.floor((now - base) / schedule.ms);
			return base + k * schedule.ms;
		}
		case "once": {
			// A one-shot owes exactly one slot, and the slot is spent as soon as the scheduler acted
			// on it — fired, or declined because catch-up was off. Rolling both stamps back (a crashed
			// run, or the single retry a failed one-shot gets) makes it owed again.
			if (input.lastFiredAt !== undefined || input.lastDueAt !== undefined) return undefined;
			return schedule.at <= now ? schedule.at : undefined;
		}
	}
}

/** Next planned run after `now`, for display. */
export function computeNext(input: DueInput, now: number): number | undefined {
	const { schedule } = input;
	switch (schedule.kind) {
		case "cron":
			return cronNextAfter(parseCron(schedule.expr), now);
		case "every": {
			const base = input.lastFiredAt ?? input.createdAt;
			let t = base + schedule.ms;
			while (t <= now) t += schedule.ms;
			return t;
		}
		case "once":
			return input.lastFiredAt === undefined && schedule.at > now ? schedule.at : undefined;
	}
}
