/**
 * What a session listing needs from a session file without reading the whole file: the header,
 * the name someone gave it, the first thing the person said, and how many messages there are.
 *
 * `src/web.mjs` carries its own copy of this (it is one file with no imports, on purpose); a
 * change here is a change there.
 */
import * as fs from "node:fs";
import type { DynamicTriggerRule } from "./triggers.ts";
import type { LoopJob } from "./store.ts";

export interface SessionHead {
	id: string;
	cwd: string;
	/** The header's timestamp, as written. */
	startedAt?: string;
	/** `/name`, when someone set one. */
	name?: string;
	/** The first user message, as typed, bounded. */
	first?: string;
	messages: number;
	/** The file was longer than the window read; `messages` is a floor. */
	truncated: boolean;
}

const HEAD_BYTES = 64 * 1024;

export function readSessionHead(file: string, bytes: number = HEAD_BYTES): SessionHead | undefined {
	let text: string;
	let readBytes = 0;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(bytes);
			// `bytes` is a byte window, so the decision to cut is the byte count read, not the
			// decoded string's length: a multi-byte character makes those differ.
			readBytes = fs.readSync(fd, buf, 0, bytes, 0);
			text = buf.toString("utf8", 0, readBytes);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	const lines = text.split("\n");
	let header: { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown };
	try {
		header = JSON.parse(lines[0] ?? "");
	} catch {
		return undefined;
	}
	if (header?.type !== "session" || typeof header.id !== "string") return undefined;
	const truncated = readBytes >= bytes;
	let name: string | undefined;
	let first: string | undefined;
	let messages = 0;
	// The last line of a partial read is half a line; a file that fitted has no such line.
	for (const line of lines.slice(1, truncated ? -1 : undefined)) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type === "session_info" && typeof entry.name === "string") name = entry.name.slice(0, 200);
		if (entry?.type !== "message") continue;
		messages++;
		if (first || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const said = typeof content === "string" ? content : (content ?? []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ");
		if (said.trim()) first = said.trim().slice(0, 200);
	}
	return { id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "", startedAt: typeof header.timestamp === "string" ? header.timestamp : undefined, name, first, messages, truncated };
}

/**
 * One line of preview: newlines become spaces, and it is cut at `max` *characters* — not bytes,
 * so a CJK character or an emoji at the edge is kept whole — with an ellipsis when something was cut.
 */
export function previewText(text: string, max = 80): string {
	const flat = text.replace(/\s*\n\s*/g, " ").trim();
	const chars = [...flat];
	return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

/**
 * The automation badge of a session listing: the plain jobs bound to this session (`sessionId`)
 * and the jobs and rules it created. `2 cron, 1 trigger`; `automation off` when everything
 * it has is disabled; nothing when it has nothing.
 */
export function automationBadge(sessionId: string, jobs: LoopJob[], rules: DynamicTriggerRule[]): string | undefined {
	const mine = jobs.filter((j) => j.sessionId === sessionId || j.createdBy?.sessionId === sessionId);
	const rulesMine = rules.filter((r) => r.createdBy?.sessionId === sessionId);
	if (!mine.length && !rulesMine.length) return undefined;
	const parts: string[] = [];
	const cron = mine.filter((j) => j.enabled).length;
	const trig = rulesMine.filter((r) => r.enabled).length;
	if (cron) parts.push(`${cron} cron`);
	if (trig) parts.push(`${trig} trigger`);
	return parts.length ? parts.join(", ") : "automation off";
}
