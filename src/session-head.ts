/**
 * What a session listing needs from a session file without reading the whole file: the header,
 * the name someone gave it, the first thing the person or pi-loops said, and how many messages there are.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DynamicTriggerRule } from "./triggers.ts";
import type { LoopJob } from "./store.ts";
import { TURN_TYPE } from "./mark.ts";

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
	try {
		const fd = fs.openSync(file, "r");
		try {
			return headOf(fd, bytes);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/** The header window `laneTranscript` reads: the first line of a session file is short. */
const LANE_HEAD_BYTES = 16 * 1024;
const NO_FOLLOW_NO_WAIT = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * The transcripts of one lane's own directory, by the session id each header names. Only an entry
 * that `lstat` gives as a regular file is opened, without following a link and without waiting, and
 * only for its header: a symlink, a FIFO or a directory is never opened. An id that two files name
 * maps to undefined: it proves neither. `dir` is the lane's directory as pi-loops derives it from the
 * lane, never a path from a finding.
 */
export function laneTranscripts(dir: string): Map<string, string | undefined> {
	const out = new Map<string, string | undefined>();
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return out; // no directory: no transcript
	}
	for (const name of names) {
		const file = path.join(dir, name);
		let id: string | undefined;
		try {
			const st = fs.lstatSync(file);
			if (!st.isFile()) continue;
			const fd = fs.openSync(file, NO_FOLLOW_NO_WAIT);
			try {
				// The entry changed between lstat and open: not the file lstat saw.
				const opened = fs.fstatSync(fd);
				if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev) continue;
				id = headOf(fd, LANE_HEAD_BYTES)?.id;
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			continue; // gone or unreadable since the listing: no transcript of this lane
		}
		if (id === undefined) continue;
		out.set(id, out.has(id) ? undefined : file);
	}
	return out;
}

/** The one transcript in `dir` whose header names `sessionId`; undefined when none or more than one does. */
export function laneTranscript(dir: string, sessionId: string): string | undefined {
	return laneTranscripts(dir).get(sessionId);
}

function headOf(fd: number, bytes: number): SessionHead | undefined {
	const buf = Buffer.alloc(bytes);
	// `bytes` is a byte window, so the decision to cut is the byte count read, not the
	// decoded string's length: a multi-byte character makes those differ.
	const readBytes = fs.readSync(fd, buf, 0, bytes, 0);
	const text = buf.toString("utf8", 0, readBytes);
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
		const userMessage = entry?.type === "message" && entry.message?.role === "user";
		const turnMessage = entry?.type === "custom_message" && entry.customType === TURN_TYPE;
		if (entry?.type === "message" || turnMessage) messages++;
		if (first || (!userMessage && !turnMessage)) continue;
		const content = userMessage ? entry.message.content : entry.content;
		const said = typeof content === "string" ? content : (content ?? []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ");
		// pi-loops' own prompts start with their row's `[Trigger <id>] `: a conversation a claim began is titled by the claim's words.
		if (said.trim()) first = said.trim().replace(/^\[Trigger [^\]]+\]\s*/, "").slice(0, 200);
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

/** What tells a conversation apart from another started the same minute: its name, else the first thing said. */
export function sessionTitle(file: string): string | undefined {
	const head = readSessionHead(file);
	const title = head?.name ?? head?.first;
	return title ? previewText(title, 40) : undefined;
}

/**
 * A conversation's short form on every surface: its id's first 13 characters (`01a1c183-7467`).
 * The 12 hex digits hold a uuidv7's whole millisecond stamp, so two collide only when they start in
 * the same millisecond; the first 8 collided about every 65 s. A prefix, so `--session` takes it.
 */
export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 13);
}

/** A conversation in a listing: its short form, and its title when one is known. */
export function conversationLabel(sessionId: string, title?: string): string {
	return title ? `${shortSessionId(sessionId)} "${title}"` : shortSessionId(sessionId);
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
