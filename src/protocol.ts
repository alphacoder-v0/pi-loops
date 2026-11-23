/**
 * The loop output protocol — plain text, provider-agnostic, matching
 * docs/loops.md: the sub-agent ends its reply with <loop-state>…</loop-state>
 * and zero or more <inbox>…</inbox> tags. Extraction never fails a run.
 */
import * as path from "node:path";
import { formatDuration } from "./schedule.ts";
import { gateShown } from "./gate.ts";

export const LOOP_STATE_MAX_CHARS = 2000;
export const INBOX_TEXT_MAX_CHARS = 500;
export const INBOX_TAGS_PER_RUN = 16;
/**
 * How many `<inbox>` tags are read out of one reply at all. Past this the dropped-finding count
 * stops being exact, which is the right trade: a reply carrying a thousand findings is a runaway,
 * not a report, and scanning it to the end only puts a number on how far it ran away.
 */
const MAX_INBOX_TAGS_SCANNED = 1000;
export const FIRST_RUN_MARKER = "(first run)";
/**
 * The two lines that bracket the job's own text in a composed prompt. They are part of the protocol,
 * so they are named here and read here (`jobTextOf`): the transcript view used to carry its own
 * copies of both literals, and a prompt reworded on one side silently stopped being parsed on the other.
 */
export const LOOP_STATE_CLOSE = "[/loop-state]";
export const OUTPUT_PROTOCOL_HEADING = "Output protocol (mandatory):";
/** The block after the notes that lists the files of the loop's notes directory (src/notes.ts `notesFileLines`). */
export const NOTES_FILES_OPEN = "[notes-files]";
export const NOTES_FILES_CLOSE = "[/notes-files]";
/** The block after `[notes-files]` that lists what the loop already reported and what a person did with it (src/notes.ts `reportedFor`). */
export const REPORTED_OPEN = "[reported]";
export const REPORTED_CLOSE = "[/reported]";
/** The block after `[reported]` that lists the loop's questions that wait for a person (`askedLines`). */
export const ASKED_OPEN = "[asked]";
export const ASKED_CLOSE = "[/asked]";
/** The block before the notes that says why a run that is not a plain slot started: the notes of the loop's follow-ups (`Row.payload.woken`). */
export const WOKEN_OPEN = "[woken]";
export const WOKEN_CLOSE = "[/woken]";
/** The block after `[asked]` that shows what the loop's gate read this time (design 3.2), from the event the row names. */
export const GATE_OPEN = "[gate]";
export const GATE_CLOSE = "[/gate]";
/** The protocol's line about `wake_me`, the tool every loop run has (src/tools.ts `wakeMeTool`). */
export const WAKE_ME_LINE = "- To be woken before your next scheduled run, or to skip scheduled runs until a time, call wake_me.";
/**
 * The blocks between the notes and the job text, in their order. The last pair is the block a 0.24.2
 * prompt carried there: a transcript that version wrote still shows its job text alone.
 */
const DATA_BLOCKS: ReadonlyArray<readonly [string, string]> = [
	[NOTES_FILES_OPEN, NOTES_FILES_CLOSE],
	[REPORTED_OPEN, REPORTED_CLOSE],
	[ASKED_OPEN, ASKED_CLOSE],
	["[dismissed]", "[/dismissed]"],
	[WOKEN_OPEN, WOKEN_CLOSE],
	[GATE_OPEN, GATE_CLOSE],
];

/**
 * A checkpoint is a finding that asks a person to decide, and docs/recipes.md fixes its shape:
 * `<the decision> · waits: <what waits on it> · if not: <what happens if nobody acts>`. The
 * middle dot before `waits:` is the mark — the word alone is prose ("the deploy waits: on DNS"),
 * and a loop that wants its finding read as a decision writes the shape the playbooks write.
 * Everything else is news: a merged pull request, a red check, a digest line. Every finding is one
 * of the two, so the answer is always a kind.
 */
export type FindingKind = "checkpoint" | "news";
export function findingKind(text: string): FindingKind {
	return /(^|\s)·\s*waits:/i.test(text) ? "checkpoint" : "news";
}

export function capChars(text: string, max: number): string {
	const chars = Array.from(text.trim());
	if (chars.length <= max) return chars.join("");
	return `${chars.slice(0, max).join("")}…`;
}

/**
 * A data block of the prompt: the lines are data (a finding's words, a file name, a command), so a
 * line that says the close of any block is spaced (`[/ reported]`): written as it is, it would end
 * the block early and put the rest of the line where the run reads its task. No line, no block.
 */
function dataBlock(open: string, close: string, note: string, lines: readonly string[] | undefined): string[] {
	if (!lines?.length) return [];
	const closes = new RegExp(String.raw`\[\/(\s*)(${DATA_BLOCKS.map(([, c]) => c.slice(2, -1)).join("|")})\]`, "gi");
	return [`${open} (${note})`, ...lines.map((line) => line.replace(closes, (_, _space, tag: string) => `[/ ${tag.toLowerCase()}]`)), close, ""];
}

export interface LoopPromptMeta {
	name?: string;
	runAt?: string;
	timeoutMs?: number;
	/** `<loops dir>/state/<id>/`, the loop's notes directory. */
	notesDir?: string;
	/** `notesFileLines` of that directory. */
	notesFiles?: readonly string[];
	/** `reportedFor` of the loop. */
	reported?: readonly string[];
	/** `askedLines` of the loop's lane. */
	asked?: readonly string[];
	/** The row's `woken`: one note per follow-up that started this run. */
	woken?: readonly string[];
	/** `gateLines` of the reading the row names (`payload.events`): what the loop's gate read this time. */
	gate?: readonly string[];
}

/** What a gate read, as the event stores it (src/gate.ts `lookCommand`). */
export interface GateReadingText {
	command: string;
	exit?: number | null;
	stdout?: string;
	why?: string;
	refused?: string;
}

/**
 * The `[gate]` block's lines: the command, its exit code and its output as it was read (at most
 * 4000 characters, the gate's cap), or why the look failed, which is why the gate did not hold the run.
 */
export function gateLines(r: GateReadingText): string[] {
	const command = `command: ${gateShown(r.command)}`;
	const failed = r.refused !== undefined ? `refused: ${r.refused}` : r.why;
	if (failed !== undefined) return [command, `the gate failed (${failed}), so it did not hold this run; look for yourself what changed`];
	const out = r.stdout ?? "";
	return [command, `exit code: ${r.exit ?? "none"}`, out.trim() ? "output:" : "output: (none)", ...(out.trim() ? out.replace(/\n$/, "").split("\n") : [])];
}

export function composeLoopPrompt(action: string, previousState: string | undefined, meta?: LoopPromptMeta): string {
	// Capped once, at the write (src/notes.ts `notesWrite`): what is on disk is what the run reads.
	const state = previousState && previousState.trim() ? previousState.trim() : FIRST_RUN_MARKER;
	/**
	 * The loop authors one text, the notes, and it replaces that text whole each run. Everything else
	 * here is built by pi-loops from a ledger with a fixed window, and forgets on its own; the files
	 * are listed, not loaded.
	 */
	const dir = meta?.notesDir ? `${meta.notesDir.replace(/[\\/]+$/, "")}${path.sep}` : undefined;
	const files = dataBlock(NOTES_FILES_OPEN, NOTES_FILES_CLOSE, `longer notes you keep as files in ${dir ?? "your notes directory"}; read one when you need it`, meta?.notesFiles);
	const reported = dataBlock(REPORTED_OPEN, REPORTED_CLOSE, "what this loop already told a person, and what they did with it; do not report these again unless what they describe has changed", meta?.reported);
	const asked = dataBlock(ASKED_OPEN, ASKED_CLOSE, "questions of yours that wait for a person; do not ask them again", meta?.asked);
	const woken = dataBlock(WOKEN_OPEN, WOKEN_CLOSE, "why this run started", meta?.woken?.map((note) => `you asked to be woken: ${note}`));
	const gate = dataBlock(GATE_OPEN, GATE_CLOSE, "what this loop's gate reads now, which your last run that ended well did not see", meta?.gate);
	const header = meta?.name ? `You are running the recurring loop "${meta.name}"` : "You are running a recurring loop";
	/**
	 * The run time, and how to write one.
	 *
	 * The notes this prompt asks for hold watermarks — "everything up to here has been seen" — and
	 * a watermark is a time the model writes in whatever shape it likes. A machine's clock is not a
	 * constant either: `TZ` gets set, a laptop travels, a container is rebuilt in UTC — so run N can
	 * write "checked up to 20:00" in Shanghai and run N+1 read it in New York.
	 *
	 * The stamp carries its offset; this asks for the same of anything the model writes back. It
	 * goes in this line rather than in the protocol block below, which is quoted verbatim.
	 */
	const when = meta?.runAt ? ` (current run started ${meta.runAt}; write any time in your notes with its offset, as that one has)` : "";
	const limit = meta?.timeoutMs ? ` The run is stopped after ${formatDuration(meta.timeoutMs)} and counted as a failure, so finish inside that time.` : "";
	return [
		`${header}${when}. This is a background run: nobody is watching, and your final reply is parsed by a program.${limit}`,
		"",
		...woken,
		"[loop-state] (your notes from the previous run of this recurring job)",
		state,
		LOOP_STATE_CLOSE,
		"",
		...files,
		...reported,
		...asked,
		...gate,
		action.trim(),
		"",
		OUTPUT_PROTOCOL_HEADING,
		`- End your reply with <loop-state>notes for the next run</loop-state>: it REPLACES the saved notes; keep it under ${LOOP_STATE_MAX_CHARS} characters and make it what your next run needs and cannot look up again (baselines, watermarks, decisions). What you reported is listed for you under [reported]: do not keep ids of reported things here.${dir ? ` Put anything longer in a file under ${dir} and name the file in your notes.` : ""}`,
		`- For each finding a human should act on, emit <inbox>one concise line</inbox>, at most ${INBOX_TAGS_PER_RUN} per run and ${INBOX_TEXT_MAX_CHARS} characters each. No findings → no inbox tags; do not invent work.`,
		"- When a finding needs a person to decide, write it as <inbox><the decision> · waits: <what waits on it> · if not: <what happens if nobody acts></inbox>.",
		WAKE_ME_LINE,
		"- Keep everything after the last tool call short so the tags are not truncated.",
	].join("\n");
}

/** Last `<tag>…</tag>` block, trimmed. Unclosed tags are ignored. */
export function extractTagBlock(text: string, tag: string): string | undefined {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const start = text.lastIndexOf(open);
	if (start < 0) return undefined;
	const rest = text.slice(start + open.length);
	const end = rest.indexOf(close);
	if (end < 0) return undefined;
	return rest.slice(0, end).trim();
}

/** Every `<tag>…</tag>` block in order, capped at `max`. Empty bodies are skipped. */
export function extractTagAll(text: string, tag: string, max: number): string[] {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const out: string[] = [];
	let rest = text;
	while (out.length < max) {
		const start = rest.indexOf(open);
		if (start < 0) break;
		const after = rest.slice(start + open.length);
		const end = after.indexOf(close);
		if (end < 0) break;
		const body = after.slice(0, end).trim();
		if (body) out.push(body);
		rest = after.slice(end + close.length);
	}
	return out;
}

/** Remove protocol blocks for display. */
export function stripProtocolTags(text: string): string {
	let out = text;
	for (const tag of ["loop-state", "inbox"]) {
		const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
		out = out.replace(re, "");
	}
	return out
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l, i, arr) => !(l.trim() === "" && (i === 0 || arr[i - 1].trim() === "")))
		.join("\n")
		.trim();
}

/**
 * The job's own text out of a composed loop prompt: what sits between the state block and the
 * protocol block (`composeLoopPrompt`). A prompt this does not recognise is returned whole, which is
 * what a display wants — a prompt from somewhere else is still the best thing to show.
 */
export function jobTextOf(prompt: string): string {
	let rest = prompt.split(LOOP_STATE_CLOSE).pop()?.split(OUTPUT_PROTOCOL_HEADING)[0] ?? prompt;
	// The data blocks sit between the notes and the job text: pi-loops' words, not the job's.
	for (const [open, close] of DATA_BLOCKS) if (rest.trimStart().startsWith(open)) rest = rest.split(close).slice(1).join(close);
	return rest;
}

/* ---------------------------------------------------------- maker/checker */

export const CHECKER_MARKER = "You are the checker for a recurring loop";

/**
 * A second sub-agent adversarially
 * reviews the maker's findings before they reach the inbox. Plain-text protocol again:
 * one <verdict n="i">keep|drop</verdict> per finding, reason inside the tag body after
 * the verdict word; a <rewrite n="i">…</rewrite> may replace the finding's text.
 */
export function composeCheckerPrompt(action: string, makerState: string | undefined, findings: string[], meta?: { name?: string }): string {
	const list = findings.map((f, i) => `${i + 1}. ${f}`).join("\n");
	return [
		`${CHECKER_MARKER}${meta?.name ? ` "${meta.name}"` : ""}. A separate agent (the maker) just ran this loop and reported the findings below. Your job is adversarial: assume each finding may be wrong, stale, duplicated, trivial, or unsupported, and verify it independently with the tools available (read files, run commands, query APIs) before you decide. Do not trust the maker's notes as evidence.`,
		"",
		"[loop-goal]",
		action.trim(),
		"[/loop-goal]",
		"",
		"[maker-notes]",
		makerState?.trim() || FIRST_RUN_MARKER,
		"[/maker-notes]",
		"",
		"[findings]",
		list,
		"[/findings]",
		"",
		OUTPUT_PROTOCOL_HEADING,
		'- For EVERY numbered finding emit exactly one <verdict n="i">keep — reason</verdict> or <verdict n="i">drop — reason</verdict>. keep = a human should still act on it; drop = false, stale, duplicate, not actionable, or not worth attention.',
		'- If a kept finding is imprecise, add <rewrite n="i">one corrected line</rewrite> to replace its text.',
		"- Do not invent new findings. Do not emit <inbox> or <loop-state> tags.",
		"- Keep everything after the last tool call short so the tags are not truncated.",
	].join("\n");
}

export interface CheckerVerdict {
	n: number;
	verdict: "keep" | "drop";
	reason: string;
	rewrite?: string;
}

/** Verdicts by finding number (1-based). Findings without a verdict are absent from the map. */
export function parseCheckerOutput(text: string): Map<number, CheckerVerdict> {
	const out = new Map<number, CheckerVerdict>();
	for (const m of text.matchAll(/<verdict\s+n="?(\d+)"?\s*>([\s\S]*?)<\/verdict>/g)) {
		const n = Number(m[1]);
		const body = m[2].trim();
		const word = /^(keep|drop)\b/i.exec(body);
		if (!n || !word) continue;
		const reason = body
			.slice(word[0].length)
			.replace(/^[\s—:\-–]+/, "")
			.replace(/\s+/g, " ")
			.trim();
		out.set(n, { n, verdict: word[1].toLowerCase() as "keep" | "drop", reason });
	}
	for (const m of text.matchAll(/<rewrite\s+n="?(\d+)"?\s*>([\s\S]*?)<\/rewrite>/g)) {
		const v = out.get(Number(m[1]));
		const body = m[2].replace(/\s+/g, " ").trim();
		if (v && v.verdict === "keep" && body) v.rewrite = capChars(body, INBOX_TEXT_MAX_CHARS);
	}
	return out;
}

export interface ParsedRunOutput {
	state?: string;
	findings: string[];
	droppedFindings: number;
}

export function parseRunOutput(text: string): ParsedRunOutput {
	const stateRaw = extractTagBlock(text, "loop-state");
	const all = extractTagAll(text, "inbox", MAX_INBOX_TAGS_SCANNED);
	const findings = all.slice(0, INBOX_TAGS_PER_RUN).map((f) => capChars(f.replace(/\s+/g, " "), INBOX_TEXT_MAX_CHARS));
	return {
		// Not capped here: `notesWrite` cuts it at the write and says so.
		state: stateRaw,
		findings,
		droppedFindings: Math.max(0, all.length - INBOX_TAGS_PER_RUN),
	};
}
