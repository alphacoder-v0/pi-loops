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
	catchUp: boolean;
	verify: boolean;
	checkerModel?: string;
}

const VALUE_FLAGS = new Set(["--name", "--cwd", "--model", "--thinking", "--tools", "--timeout", "--checker-model"]);

export function parseAddArgs(input: string, now: number = Date.now()): AddArgs {
	const tokens = tokenize(input);
	let idx = 0;
	const out: Partial<AddArgs> & { stateful: boolean; catchUp: boolean; verify: boolean } = { stateful: false, catchUp: true, verify: false };
	while (idx < tokens.length && tokens[idx].value.startsWith("--") && !tokens[idx].quoted) {
		const flag = tokens[idx].value;
		if (flag === "--inject") out.stateful = false;
		else if (flag === "--no-catchup") out.catchUp = false;
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
	if (idx >= tokens.length) throw new Error("missing schedule");

	let scheduleTokens: Token[];
	const head = tokens[idx];
	const lower = head.value.toLowerCase();
	const singleAlias = normalizeScheduleAlias(head.value) !== undefined && !["every"].includes(lower);
	if (head.quoted || lower.startsWith("@") || singleAlias) scheduleTokens = [head];
	else if (lower === "every" || lower === "in" || lower === "at") scheduleTokens = tokens.slice(idx, idx + 2);
	else scheduleTokens = tokens.slice(idx, idx + 5);
	if (scheduleTokens.length < (head.quoted || lower.startsWith("@") || singleAlias ? 1 : lower === "every" || lower === "in" || lower === "at" ? 2 : 5)) {
		throw new Error("incomplete schedule (quote cron expressions: \"0 9 * * *\")");
	}
	const scheduleText = scheduleTokens.map((t) => t.value).join(" ");
	const schedule = parseSchedule(scheduleText, now);
	const promptStart = scheduleTokens[scheduleTokens.length - 1].end;
	const prompt = input.slice(promptStart).trim();
	if (!prompt) throw new Error("missing prompt after the schedule");
	return { ...out, schedule, scheduleText, prompt } as AddArgs;
}

/** Split "<subcommand> <rest>" */
export function splitCommand(input: string): { sub: string; rest: string } {
	const trimmed = input.trim();
	const m = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
	if (!m) return { sub: "", rest: "" };
	return { sub: m[1].toLowerCase(), rest: m[2] };
}
