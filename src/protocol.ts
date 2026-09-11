/**
 * The loop output protocol — plain text, provider-agnostic, matching
 * docs/loops.md: the sub-agent ends its reply with <loop-state>…</loop-state>
 * and zero or more <inbox>…</inbox> tags. Extraction never fails a run.
 */

export const LOOP_STATE_MAX_CHARS = 2000;
export const INBOX_TEXT_MAX_CHARS = 500;
export const INBOX_TAGS_PER_RUN = 16;
export const FIRST_RUN_MARKER = "(first run)";

export function capChars(text: string, max: number): string {
	const chars = Array.from(text.trim());
	if (chars.length <= max) return chars.join("");
	return `${chars.slice(0, max).join("")}…`;
}

export function composeLoopPrompt(action: string, previousState: string | undefined, meta?: { name?: string; runAt?: string }): string {
	const state = previousState && previousState.trim() ? capChars(previousState, LOOP_STATE_MAX_CHARS) : FIRST_RUN_MARKER;
	const header = meta?.name ? `You are running the recurring loop "${meta.name}"` : "You are running a recurring loop";
	/**
	 * The run time, and how to write one.
	 *
	 * The notes this prompt asks for hold watermarks — "everything up to here has been seen" — and
	 * a watermark is a time the model writes in whatever shape it likes. That was survivable while
	 * a loop belonged to one machine. It does not: a job with no `host` runs on any machine sharing
	 * the `$HOME` (scheduler.ts, and `/cron set <ref> --host -` asks for exactly that), so run N can
	 * write "checked up to 20:00" in Shanghai and run N+1 read it in New York.
	 *
	 * The stamp carries its offset; this asks for the same of anything the model writes back. It
	 * goes in this line rather than in the protocol block below, which is quoted verbatim.
	 */
	const when = meta?.runAt ? ` (current run started ${meta.runAt}; write any time in your notes with its offset, as that one has)` : "";
	return [
		`${header}${when}. This is a background run: nobody is watching, and your final reply is parsed by a program.`,
		"",
		"[loop-state] (your notes from the previous run of this recurring job)",
		state,
		"[/loop-state]",
		"",
		action.trim(),
		"",
		"Output protocol (mandatory):",
		`- End your reply with <loop-state>notes for the next run</loop-state> — it REPLACES the saved state; keep it under ${LOOP_STATE_MAX_CHARS} characters and make it the information your next run needs (baselines, ids already seen, watermarks).`,
		"- For each finding a human should act on, emit <inbox>one concise line</inbox>. No findings → no inbox tags; do not invent work.",
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
		"Output protocol (mandatory):",
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
	const all = extractTagAll(text, "inbox", 1000);
	const findings = all.slice(0, INBOX_TAGS_PER_RUN).map((f) => capChars(f.replace(/\s+/g, " "), INBOX_TEXT_MAX_CHARS));
	return {
		state: stateRaw === undefined ? undefined : capChars(stateRaw, LOOP_STATE_MAX_CHARS),
		findings,
		droppedFindings: Math.max(0, all.length - INBOX_TAGS_PER_RUN),
	};
}
