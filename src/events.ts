/**
 * events.jsonl: what arrived from outside, stored as received before anything reads it.
 *
 * One JSON line per event, appended under `events.lock`. `raw` is the text as given: nothing here
 * parses or changes it, so a step that read it wrong can read it again. Past `maxBytes` the file is
 * renamed to `events.1.jsonl` (one generation, an older one replaced) and a new file starts with the
 * events a queued row still reads (`keep`), copied as they were; no file is ever rewritten in place.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLockSync } from "./lock.ts";
import { stamp } from "./schedule.ts";

export const EVENTS_ROTATE_BYTES = 2_000_000;

export type EventSource = `mcp:${string}` | `gate:${string}`;
export type ReceiverKind = "background" | "window";

export interface RawEvent {
	id: string;
	received_at: string;
	source: EventSource;
	receiver: { pid: number; kind: ReceiverKind };
	/** A push from a project's own server: that project. Absent for a user-level server's push and a gate's reading. */
	project?: string;
	/** What the receiving server's config said to do with a push, when it arrived. */
	delivery?: "sub_agent" | "inject_summary" | "inject_and_run";
	raw: string;
}

export class EventLog {
	private readonly file: string;
	private readonly older: string;
	private readonly lock: string;
	private readonly maxBytes: number;
	private readonly kind: ReceiverKind;
	private readonly keep: () => ReadonlySet<string>;

	/** `keep`: the ids of the events a queued row still names; a rotation carries them into the new file. */
	constructor(dir: string, kind: ReceiverKind, opts: { maxBytes?: number; keep?: () => ReadonlySet<string> } = {}) {
		this.kind = kind;
		this.keep = opts.keep ?? (() => new Set());
		this.file = path.join(dir, "events.jsonl");
		this.older = path.join(dir, "events.1.jsonl");
		this.lock = path.join(dir, "events.lock");
		this.maxBytes = opts.maxBytes ?? EVENTS_ROTATE_BYTES;
	}

	append(source: EventSource, raw: string, receipt: Pick<RawEvent, "project" | "delivery"> = {}): RawEvent {
		const event: RawEvent = {
			id: `evt-${randomBytes(16).toString("hex")}`,
			received_at: stamp(),
			source,
			receiver: { pid: process.pid, kind: this.kind },
			...(receipt.project !== undefined ? { project: receipt.project } : {}),
			...(receipt.delivery !== undefined ? { delivery: receipt.delivery } : {}),
			raw,
		};
		const line = `${JSON.stringify(event)}\n`;
		withFileLockSync(this.lock, () => {
			let size = 0;
			try {
				size = fs.statSync(this.file).size;
			} catch (err: any) {
				if (err?.code !== "ENOENT") throw err;
			}
			if (size > 0 && size + Buffer.byteLength(line, "utf8") > this.maxBytes) {
				// The events a waiting row still names go on in the new file: a row whose event is gone
				// can only leave dead, and a flood of pushes must not cost the ones already queued.
				const kept = this.keep();
				const carried = kept.size ? readEvents(this.file).filter((e) => kept.has(e.id)) : [];
				fs.renameSync(this.file, this.older);
				size = 0;
				if (carried.length) {
					const text = carried.map((e) => `${JSON.stringify(e)}\n`).join("");
					fs.appendFileSync(this.file, text, "utf8");
					size = Buffer.byteLength(text, "utf8");
				}
			}
			// A crash during an append leaves a line with no newline. Start on a new line, so the torn
			// one stays one line that readers skip instead of swallowing this event.
			fs.appendFileSync(this.file, size > 0 && !endsWithNewline(this.file, size) ? `\n${line}` : line, "utf8");
		});
		return event;
	}

	/** Events received at or after `ms`, oldest first, from both generations. */
	since(ms: number): RawEvent[] {
		return this.all().filter((e) => Date.parse(e.received_at) >= ms);
	}

	get(id: string): RawEvent | undefined {
		return this.all().find((e) => e.id === id);
	}

	private all(): RawEvent[] {
		return [...readEvents(this.older), ...readEvents(this.file)];
	}
}

function endsWithNewline(file: string, size: number): boolean {
	const fd = fs.openSync(file, "r");
	try {
		const last = Buffer.alloc(1);
		fs.readSync(fd, last, 0, 1, size - 1);
		return last[0] === 0x0a;
	} finally {
		fs.closeSync(fd);
	}
}

function readEvents(file: string): RawEvent[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err: any) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
	const out: RawEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const event = JSON.parse(line);
			if (typeof event?.id === "string" && typeof event.raw === "string") out.push(event);
		} catch {
			// A torn line: a crash cut an append short. The events around it are whole.
		}
	}
	return out;
}
