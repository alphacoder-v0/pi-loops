/**
 * Argument parsing for `/cron add` (pie's surface plus a few flags):
 *
 *   /cron add [--stateful] [--name <n>] [--cwd <dir>] [--model <m>] [--thinking <lvl>]
 *             [--tools a,b] [--timeout <dur>] [--no-catchup] [--verify] [--checker-model <m>] <schedule> <prompt…>
 *
 * <schedule> is one quoted token ("0 9 * * *"), five bare cron tokens, an @alias,
 * or `every <dur>` / `in <dur>` / `at <ISO>`. Everything after it is the prompt,
 * taken verbatim from the original string (so quotes inside the prompt survive).
 */
import { normalizeScheduleAlias, parseDuration, parseSchedule, type Schedule } from "./schedule.ts";

export interface Token {
	value: string;
	quoted: boolean;
	end: number;
}

export function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i])) i++;
		if (i >= input.length) break;
		const quote = input[i] === '"' || input[i] === "'" ? input[i] : undefined;
		if (quote) {
			let j = i + 1;
			let value = "";
			while (j < input.length && input[j] !== quote) {
				if (input[j] === "\\" && j + 1 < input.length) j++;
				value += input[j++];
			}
			tokens.push({ value, quoted: true, end: Math.min(j + 1, input.length) });
			i = j + 1;
		} else {
			let j = i;
			while (j < input.length && !/\s/.test(input[j])) j++;
			tokens.push({ value: input.slice(i, j), quoted: false, end: j });
			i = j;
		}
	}
	return tokens;
}

export interface AddArgs {
	schedule: Schedule;
	scheduleText: string;
	prompt: string;
	/** pie: --stateful turns the job into a loop (sub-agent + notes + inbox); default is inject-and-run. */
	stateful: boolean;
	name?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	timeoutMs?: number;
	/** undefined = default for the job kind (stateful: on, inject: off). */
	catchUp?: boolean;
	verify: boolean;
	checkerModel?: string;
}

const VALUE_FLAGS = new Set(["--name", "--cwd", "--model", "--thinking", "--tools", "--timeout", "--checker-model"]);

/** pie's usage line for `/cron add`. */
export const CRON_ADD_USAGE = 'usage: /cron add [--stateful] "<minute hour dom month dow>" <prompt>';

export function parseAddArgs(input: string, now: number = Date.now()): AddArgs {
	const tokens = tokenize(input);
	let idx = 0;
	const out: Partial<AddArgs> & { stateful: boolean; catchUp?: boolean; verify: boolean } = { stateful: false, verify: false };
	while (idx < tokens.length && tokens[idx].value.startsWith("--") && !tokens[idx].quoted) {
		const flag = tokens[idx].value;
		if (flag === "--inject") out.stateful = false;
		else if (flag === "--no-catchup") out.catchUp = false;
		else if (flag === "--catchup") out.catchUp = true;
		else if (flag === "--verify") {
			out.verify = true;
			out.stateful = true; // a checker only makes sense for loop findings
		}
		else if (flag === "--stateful" || flag === "--loop") out.stateful = true;
		else if (VALUE_FLAGS.has(flag)) {
			const val = tokens[idx + 1]?.value;
			if (val === undefined) throw new Error(`${flag} needs a value`);
			idx++;
			if (flag === "--name") out.name = val;
			else if (flag === "--cwd") out.cwd = val;
			else if (flag === "--model") out.model = val;
			else if (flag === "--thinking") out.thinking = val;
			else if (flag === "--tools") out.tools = val.split(",").map((s) => s.trim()).filter(Boolean);
			else if (flag === "--timeout") out.timeoutMs = parseDuration(val);
			else if (flag === "--checker-model") out.checkerModel = val;
		} else throw new Error(`unknown flag ${flag}`);
		idx++;
	}
	if (idx >= tokens.length) throw new Error(`missing schedule; ${CRON_ADD_USAGE}`);

	let scheduleTokens: Token[];
	const head = tokens[idx];
	const lower = head.value.toLowerCase();
	const singleAlias = normalizeScheduleAlias(head.value) !== undefined && !["every"].includes(lower);
	if (head.quoted || lower.startsWith("@") || singleAlias) scheduleTokens = [head];
	else if (lower === "every" || lower === "in" || lower === "at") scheduleTokens = tokens.slice(idx, idx + 2);
	else scheduleTokens = tokens.slice(idx, idx + 5);
	if (scheduleTokens.length < (head.quoted || lower.startsWith("@") || singleAlias ? 1 : lower === "every" || lower === "in" || lower === "at" ? 2 : 5)) {
		throw new Error(`incomplete schedule (quote cron expressions: "0 9 * * *"); ${CRON_ADD_USAGE}`);
	}
	const scheduleText = scheduleTokens.map((t) => t.value).join(" ");
	const schedule = parseSchedule(scheduleText, now);
	const promptStart = scheduleTokens[scheduleTokens.length - 1].end;
	const prompt = input.slice(promptStart).trim();
	if (!prompt) throw new Error(`missing prompt after the schedule; ${CRON_ADD_USAGE}`);
	return { ...out, schedule, scheduleText, prompt } as AddArgs;
}

/** Split "<subcommand> <rest>" */
export function splitCommand(input: string): { sub: string; rest: string } {
	const trimmed = input.trim();
	const m = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
	if (!m) return { sub: "", rest: "" };
	return { sub: m[1].toLowerCase(), rest: m[2] };
}

export interface SetArgs {
	ref: string;
	/** `null` = clear the pin (use the running session's value from now on). */
	model?: string | null;
	thinking?: string | null;
	timeoutMs?: number | null;
	name?: string | null;
	/** `"here"` = this machine; `null` = any machine. */
	host?: string | null;
}

/**
 * `/cron set <id> …` and `/triggers set <id> …`: change what a job or rule runs with after it was
 * created (pie re-reads the parent session's model every run; here a pin is explicit and editable).
 * `--model -` (or `current`) removes the pin.
 */
export function parseSetArgs(input: string): SetArgs {
	const usage = "usage: /cron|/triggers set <id> [--model <provider/id>|-] [--thinking <level>|-] [--timeout <dur>|-] [--name <n>|-] [--host here|-]";
	const tokens = tokenize(input);
	const out: SetArgs = { ref: "" };
	let touched = 0;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i].value;
		if (!t.startsWith("--")) {
			if (out.ref) throw new Error(usage);
			out.ref = t;
			continue;
		}
		const val = tokens[++i]?.value;
		if (val === undefined) throw new Error(`${t} needs a value (or - to clear)`);
		const clear = val === "-" || val.toLowerCase() === "current";
		touched++;
		if (t === "--model") out.model = clear ? null : val;
		else if (t === "--thinking") out.thinking = clear ? null : val;
		else if (t === "--timeout") out.timeoutMs = clear ? null : parseDuration(val);
		else if (t === "--name") out.name = clear ? null : val;
		// `--host here` re-homes a job stamped with a machine that no longer exists (a renamed box,
		// a rebuilt container, or one half of a synced $HOME); `-` unpins it for any machine.
		else if (t === "--host") {
			if (!clear && val !== "here") throw new Error("--host takes `here` (this machine) or `-` (any machine)");
			out.host = clear ? null : "here";
		} else throw new Error(`unknown flag ${t}`);
	}
	if (!out.ref) throw new Error(usage);
	if (!touched) throw new Error(`nothing to change; ${usage}`);
	return out;
}
