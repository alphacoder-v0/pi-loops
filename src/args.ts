/**
 * Argument parsing for `/cron add`:
 *
 *   /cron add [--stateful|--loop] [--inject] [--name <n>] [--cwd <dir>] [--model <m>] [--thinking <lvl>]
 *             [--tools a,b] [--timeout <dur>] [--catchup|--no-catchup] [--verify] [--checker-model <m>]
 *             <schedule> <prompt…>
 *
 * `--loop` is `--stateful` said the way the docs say it; `--inject` is the default (a plain job)
 * said out loud, which is what a person reaches for when they are undoing a `--stateful` they typed.
 *
 * <schedule> is one quoted token ("0 9 * * *"), five bare cron tokens, an @alias,
 * or `every <dur>` / `in <dur>` / `at <ISO>`. Everything after it is the prompt,
 * taken verbatim from the original string (so quotes inside the prompt survive).
 */
import { normalizeScheduleAlias, parseDuration, parseSchedule, type Schedule } from "./schedule.ts";
import { requireThinkingLevel } from "./thinking.ts";

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
	/** --stateful turns the job into a loop (sub-agent + notes + inbox); default is inject-and-run. */
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

/**
 * The usage line for `/cron add`, printed by the errors below — one line, because it arrives as a
 * notification and a line that wraps is read by nobody. Every flag the parser accepts is written
 * down in the block at the top of this file and in `/cron help`; two are on this line, and they are
 * the two that decide *what kind of job this is*: `--stateful` (a loop with notes and an /inbox,
 * instead of a prompt injected into this chat) and `--verify` (a checker reviews its findings), and
 * they are also the two `/cron set` cannot change afterwards. Everything else — `--name --cwd
 * --model --thinking --tools --timeout --catchup|--no-catchup --checker-model` — tunes a job whose
 * shape is already decided, and `--loop` / `--inject` are `--stateful` and its absence said out
 * loud, so listing them here would be four spellings of one choice. `test/args.test.ts` holds that
 * split to the parser.
 */
export const CRON_ADD_USAGE = 'usage: /cron add [--stateful] [--verify] "<minute hour dom month dow>" <prompt>; more flags: /cron help';

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
			else if (flag === "--thinking") out.thinking = requireThinkingLevel(val);
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
	/** Jobs only: the new prompt, verbatim. A loop's notes live under its id, so rewording it here keeps them. */
	prompt?: string;
	/** Jobs only: already parsed, so a typo is rejected before it can be stored. */
	schedule?: Schedule;
}

export interface SetOptions {
	/** `/cron set` only: a job has a prompt and a schedule, a trigger rule has neither. */
	job?: boolean;
}

/**
 * `/cron set <id> …` and `/triggers set <id> …`: change what a job or rule runs with after it was
 * created (re-reading the parent session's model every run is the alternative; here a pin is explicit and editable).
 * `--model -` (or `current`) removes the pin.
 */
export function parseSetArgs(input: string, opts: SetOptions = {}): SetArgs {
	const usage = `usage: /cron|/triggers set <id> [--model <provider/id>|-] [--thinking <level>|-] [--timeout <dur>|-] [--name <n>|-] [--host here|-]${opts.job ? ' [--prompt "<text>"] [--schedule "<expr>"]' : ""}`;
	const tokens = tokenize(input);
	const out: SetArgs = { ref: "" };
	let touched = 0;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i].value;
		if (!t.startsWith("--")) {
			// A prompt or a schedule with spaces has to be one quoted token; unquoted, its second word
			// arrives here looking like a second job ref, and the bare usage line does not explain that.
			if (out.ref && (out.prompt !== undefined || out.schedule !== undefined)) throw new Error(`quote a value that contains spaces: --prompt "check the CI and report only what changed"`);
			if (out.ref) throw new Error(usage);
			out.ref = t;
			continue;
		}
		const arg = tokens[++i];
		const val = arg?.value;
		if (val === undefined) throw new Error(`${t} needs a value (or - to clear)`);
		const clear = val === "-" || val.toLowerCase() === "current";
		touched++;
		if (t === "--model") out.model = clear ? null : val;
		else if (t === "--thinking") out.thinking = clear ? null : requireThinkingLevel(val);
		else if (t === "--timeout") out.timeoutMs = clear ? null : parseDuration(val);
		else if (t === "--name") out.name = clear ? null : val;
		// `--host here` re-homes a job stamped with a machine that no longer exists (a renamed box,
		// a rebuilt container, or one half of a synced $HOME); `-` unpins it for any machine.
		else if (t === "--host") {
			if (!clear && val !== "here") throw new Error("--host takes `here` (this machine) or `-` (any machine)");
			out.host = clear ? null : "here";
		}
		// Rewording a loop or moving it to another hour used to mean remove-and-re-add, which mints a
		// new id — and the notes a stateful loop has been accumulating live at `state/<id>.md`.
		else if (opts.job && (t === "--prompt" || t === "--schedule")) {
			// `-` clears a *pin*, and there is nothing to fall back to here: a job always has a prompt
			// and a schedule. Refusing beats erasing the prompt of a working loop; a quoted "-" is still
			// available to anyone who really means that text.
			if (clear && !arg.quoted) throw new Error(`${t} cannot be cleared: every job has one (quote the value to pass it literally)`);
			if (t === "--prompt") {
				if (!val.trim()) throw new Error("--prompt cannot be empty");
				out.prompt = val;
			} else {
				const schedule = parseSchedule(val);
				// A one-shot is spent the moment the job has any fired/due stamp, and the scheduler
				// deletes a `once` job after it runs — with the notes this edit exists to preserve.
				if (schedule.kind === "once") throw new Error("--schedule takes a recurring schedule (5-field cron, an alias, or `every <dur>`); `/cron run <id>` fires this job once");
				out.schedule = schedule;
			}
		} else throw new Error(`unknown flag ${t}`);
	}
	if (!out.ref) throw new Error(usage);
	if (!touched) throw new Error(`nothing to change; ${usage}`);
	return out;
}
