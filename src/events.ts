/**
 * events.jsonl: what arrived from outside, stored as received before anything reads it.
 *
 * One JSON line per event, appended under `events.lock`. `raw` is the text as given: nothing here
 * parses or changes it, so a step that read it wrong can read it again. Past `maxBytes` the file is
 * renamed to `events.1.jsonl` (one generation, an older one replaced) and a new file starts with the
 * events a queued row still reads (`keep`), copied as they were; no file is ever rewritten in place.
 * Each event gets a number under the lock, one more than the last one given (`events.seq` holds
 * it; a failed append or a crash skips one):
 * the order of the events stored here, which neither a rotation's copy nor a wall clock changes.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLockSync, writeFileAtomic } from "./lock.ts";
import { stamp } from "./schedule.ts";

export const EVENTS_ROTATE_BYTES = 2_000_000;

export type EventSource = `mcp:${string}` | `gate:${string}`;
export type ReceiverKind = "background" | "window";

export interface RawEvent {
	id: string;
	received_at: string;
	/** Its place among the events stored here: larger than the number of any event stored before it. 0 for an event an earlier build stored without one. */
	seq: number;
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
	private readonly counter: string;
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
		this.counter = path.join(dir, "events.seq");
		this.maxBytes = opts.maxBytes ?? EVENTS_ROTATE_BYTES;
	}

	append(source: EventSource, raw: string, receipt: Pick<RawEvent, "project" | "delivery"> = {}): RawEvent {
		return withFileLockSync(this.lock, () => {
			// The number is written before the event: a crash between the two skips a number, and never gives one twice.
			const seq = this.lastSeq() + 1;
			writeFileAtomic(this.counter, `${seq}\n`);
			const event: RawEvent = {
				id: `evt-${randomBytes(16).toString("hex")}`,
				received_at: stamp(),
				seq,
				source,
				receiver: { pid: process.pid, kind: this.kind },
				...(receipt.project !== undefined ? { project: receipt.project } : {}),
				...(receipt.delivery !== undefined ? { delivery: receipt.delivery } : {}),
				raw,
			};
			const line = `${JSON.stringify(event)}\n`;
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
			return event;
		});
	}

	/** The last number given (0 when none was): `events.seq`, or, when that file is lost or unreadable, the largest in the log. */
	lastSeq(): number {
		let text: string | undefined;
		try {
			text = fs.readFileSync(this.counter, "utf8");
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err;
		}
		const last = Number(text?.trim());
		if (text !== undefined && Number.isSafeInteger(last) && last >= 0) return last;
		return this.all().reduce((max, e) => Math.max(max, e.seq), 0);
	}

	/** The events numbered after `seq`, received at or after `ms`, in the order they were stored. */
	after(seq: number, ms: number): RawEvent[] {
		return this.all().filter((e) => e.seq > seq && Date.parse(e.received_at) >= ms).sort((a, b) => a.seq - b.seq);
	}

	/** Events received at or after `ms`, oldest first, from both generations. */
	since(ms: number): RawEvent[] {
		return this.all().filter((e) => Date.parse(e.received_at) >= ms);
	}

	get(id: string): RawEvent | undefined {
		return this.all().find((e) => e.id === id);
	}

	/** Both generations, each id once where it was first appended: a rotation carries a copy of an event a queued row names. */
	private all(): RawEvent[] {
		const seen = new Set<string>();
		return [...readEvents(this.older), ...readEvents(this.file)].filter((e) => !seen.has(e.id) && seen.add(e.id));
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
			if (typeof event?.id === "string" && typeof event.raw === "string") out.push(Number.isSafeInteger(event.seq) && event.seq >= 0 ? event : { ...event, seq: 0 });
		} catch {
			// A torn line: a crash cut an append short. The events around it are whole.
		}
	}
	return out;
}
