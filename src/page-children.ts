/**
 * One `pi --mode rpc` child behind the browser page: the process, what it last said, and the feed
 * of its events to the attached browsers.
 *
 * pi in rpc mode is pi with no terminal UI: commands in on stdin as JSON lines, events out on stdout
 * the same way. The browser speaks that protocol through src/page-server.ts, which asks a
 * `PageChild` for everything that belongs to the conversation running in it.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { PERSON_SEND_GRACE_MS } from "./engine.ts";
import { entriesReadable as fileEntriesReadable } from "./held-read.ts";
import { DELIVERY_JOB_ID, holderAlive, type ProcessProbe, procStart, type SessionLease, sessionFileName, systemProbe } from "./lease.ts";
import { withFileLockSync, writeFileAtomic } from "./lock.ts";
import { realpathish } from "./paths.ts";
import { stamp } from "./schedule.ts";
import { readSessionHead, shortSessionId } from "./session-head.ts";

/**
 * Run one of the page's callbacks so that nothing it throws, or rejects with, leaves it.
 *
 * The page runs inside the process that runs every loop. An exception that escapes an HTTP handler,
 * a child's stdout listener or a timer ends that process, and three of those in five minutes pause
 * the loops for half an hour (src/host-control.ts CRASH_BUDGET). A page bug is logged here instead.
 */
export function guard<A extends unknown[]>(log: (line: string) => void, name: string, fn: (...args: A) => unknown): (...args: A) => void {
	const report = (err: any) => log(`pi-loops page: ${name}: ${err?.stack ?? err?.message ?? err}`);
	return (...args: A) => {
		try {
			const out = fn(...args);
			if (out instanceof Promise) out.catch(report);
		} catch (err) {
			report(err);
		}
	};
}

/* ------------------------------------------------------------------ pi, in rpc mode */

export interface PageChildOptions {
	cwd: string;
	/** The pi arguments it was started with, after `--mode rpc` and `--session`. */
	piArgs: string[];
	version: string;
	log: (line: string) => void;
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	/** Every event pi prints that is not the answer to a command, before it is folded and broadcast. */
	onNote?: (msg: any) => void;
	ring: () => Promise<unknown>;
	/** The longest line read from pi, `PI_LINE_MAX` unless a test sets a smaller one. */
	lineMax?: number;
}

/**
 * The longest line the page reads from pi's stdout, in UTF-16 code units: 64 MiB of ASCII. A longer
 * one (an answer with every entry of a very large conversation) is dropped as it arrives rather than
 * held and parsed in the process every page and loop shares.
 */
export const PI_LINE_MAX = 64 * 1024 * 1024;

/** A line over the cap: its start, where pi's answer says which command it answers. */
export interface OverlongLine {
	overlong: true;
	head: string;
}

/**
 * Cut pi's stdout into lines. Strict JSONL: split on \n only, since Node's readline also splits on
 * U+2028/U+2029, which are legal inside JSON strings. Only each new chunk is scanned for a newline,
 * so a long line costs its length once, not once per chunk. A line over `max` (the \r of a CRLF line
 * not counted) is reported once, as soon as it passes the cap, and the rest of it is dropped up to
 * its newline.
 */
export function jsonlLines(max = PI_LINE_MAX): (chunk: string) => (string | OverlongLine)[] {
	let buf = "";
	let dropping = false;
	return (chunk) => {
		const out: (string | OverlongLine)[] = [];
		let from = 0;
		for (let nl = chunk.indexOf("\n"); nl !== -1; from = nl + 1, nl = chunk.indexOf("\n", from)) {
			const line = buf + chunk.slice(from, nl);
			buf = "";
			if (dropping) dropping = false;
			else if (line.length - (line.endsWith("\r") ? 1 : 0) > max) out.push({ overlong: true, head: line.slice(0, 512) });
			else out.push(line.replace(/\r$/, ""));
		}
		if (dropping) return out;
		buf += chunk.slice(from);
		// A \r waiting for its newline is not counted either.
		if (buf.length - (buf.endsWith("\r") ? 1 : 0) > max) {
			out.push({ overlong: true, head: buf.slice(0, 512) });
			buf = "";
			dropping = true;
		}
		return out;
	};
}

/** The id of the command an overlong line answers, read from its start: pi writes `id` and `type` first. */
const ANSWER_HEAD = /^\{\s*"(?:id"\s*:\s*"([^"]{1,128})"\s*,\s*"type"\s*:\s*"response"|type"\s*:\s*"response"\s*,\s*"id"\s*:\s*"([^"]{1,128})")/;

/**
 * pi's stderr, forwarded to ours and kept — bounded — so the page can show the last of it when pi
 * dies. Bounded because a chatty provider error can be very long and nobody reads past the end.
 */
const STDERR_KEEP = 8000;
/** What actually leaves this process: the tail, which is the part that says why pi stopped. */
const STDERR_SEND = 4000;
/**
 * The shapes a credential takes in a line of output.
 *
 * `src/redact.ts` is this project's list; this is the subset that matters for a stderr tail — a
 * provider that refused to authenticate prints the key it was given, and an MCP server started by
 * pi prints the Authorization header it was handed — kept here so what the tests pin about the cut
 * and the mask stays in one file. Anything not matched here is bounded rather than masked, which is
 * why the tail is short.
 */
const SECRET_SHAPES = [
	/sk-[A-Za-z0-9_-]{20,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bgh[ousp]_[A-Za-z0-9]{30,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/Bearer\s+[A-Za-z0-9._-]{16,}/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * The last of pi's stderr, capped and redacted, because this is broadcast to every attached browser.
 *
 * It used to go out as it arrived. A provider that refuses to authenticate is one of the commonest
 * reasons pi exits at all, and what it prints is the key it was refused with — so the one event
 * whose whole purpose is to explain a failure was the one event that could carry a credential.
 */
/**
 * Redact every credential shape a line of output could carry.
 *
 * A job's prompt and last error, and a rule's condition and action, now leave this process in
 * `/state` in full rather than cut short — and full is what makes a prompt with an API key in it,
 * or an error a provider printed, reach every attached browser unless it is masked first. The same
 * patterns that guard the stderr tail have to guard these, which is why this is one function and
 * not two copies of the list.
 */
export function maskSecrets(text: any) {
	// A field the store does not have stays absent: /state said undefined before and still does.
	if (text === undefined || text === null) return text;
	let out = String(text);
	for (const re of SECRET_SHAPES) {
		re.lastIndex = 0;
		out = out.replace(re, "[REDACTED]");
	}
	return out;
}

/* ------------------------------------------------------------------ what the server keeps */

/** A request pi waits on for an answer, as opposed to a notice or a status line. */
export const isDialog = (ev: any) => ev?.type === "extension_ui_request" && (ev.method === "confirm" || ev.method === "select" || ev.method === "input" || ev.method === "editor");

/**
 * How many unanswered dialogs are kept, for the same reason the backlog is bounded.
 *
 * A dialog nobody answers is offered again to every browser that attaches, every eight seconds, for
 * as long as this process lives — so an abandoned one is not merely memory, it is a question that
 * will not stop being asked. Past this the oldest goes, which is the one least likely to still have
 * an extension waiting behind it.
 */
const MAX_PENDING_ASKS = 50;

/* ------------------------------------------------------------------ the snapshot */

export const NO_PI_LOOPS = "pi-loops is not loaded in this session";

/** The mark a page child keeps once the variable is gone: pi runs the extension factory again, in the same process, on every session replacement. */
const PAGE_CHILD_MARK = Symbol.for("pi-loops.page-child");
/**
 * Whether this process is a page child (started by `ChildPool` with `PI_LOOPS_PAGE_CHILD=1`). The
 * variable is read once and taken out of the environment, so a tool process this pi runs (a `bash`
 * call, a nested `pi -p`) does not inherit it and take itself for a page child; a mark on the
 * process keeps the answer for the factory's next run (a new session, a resume, `/reload`), which
 * would otherwise lose the desk and the lease's `page` mark.
 */
export function claimPageChild(env: NodeJS.ProcessEnv = process.env, proc: object = process): boolean {
	const marks = proc as { [PAGE_CHILD_MARK]?: true };
	const pageChild = env.PI_LOOPS_PAGE_CHILD === "1" || marks[PAGE_CHILD_MARK] === true;
	if (pageChild) {
		marks[PAGE_CHILD_MARK] = true;
		delete env.PI_LOOPS_PAGE_CHILD;
	}
	return pageChild;
}
/**
 * How old the command list may be when a chat message is routed on it. `/reload` in the page changes
 * what is loaded, so the list is asked for again after every slash command as well; the age is the
 * floor under that, for a change this process did not see happen.
 */
export const COMMANDS_TTL_MS = 30_000;



/**
 * The model a session was last using, as pi would read it back.
 *
 * pi's own rule, walked from the leaf upwards: the newest `model_change` on this branch, or failing
 * that the model the newest assistant message on it was answered by. Upwards rather than through the
 * flat list because `get_entries` hands back the whole tree, abandoned branches included, and the
 * model in an abandoned branch is not the model of this conversation.
 */
function lastModelOf(entries: any[], leafId: any) {
	const byId = new Map((entries ?? []).filter((e) => e?.id).map((e) => [e.id, e]));
	for (let e = byId.get(leafId); e; e = e.parentId ? byId.get(e.parentId) : undefined) {
		if (e.type === "model_change" && e.provider && e.modelId) return { provider: e.provider, modelId: e.modelId };
		const m = e.type === "message" ? e.message : undefined;
		if (m?.role === "assistant" && m.provider && m.model) return { provider: m.provider, modelId: m.model };
	}
	return undefined;
}

/** What the snapshot asks of the server: the request rows and the automation panel, which live there. */
export interface SnapshotExtra {
	requests: (sessionId: any, idle: boolean) => unknown[];
	automation: (cwd: string, sessionId: any) => unknown;
}

export class PageChild {
	/** The producer identity of this child's rows: one per spawn. */
	readonly instance = randomUUID();
	readonly pi: ChildProcessByStdio<Writable, Readable, Readable>;
	readonly pid: number;
	readonly procStart: string | undefined;
	readonly cwd: string;
	readonly piArgs: string[];
	readonly log: (line: string) => void;
	readonly startedAt = Date.now();
	lastClientAt = Date.now();
	/** What keeps pi busy now (`RPC_TURN_EVENTS`): a run, a compaction, or both. */
	private readonly turn = new Set<"run" | "compaction">();
	/** pi is running a turn or compacting: never idle, whatever its clients. */
	get busy(): boolean {
		return this.turn.size > 0;
	}
	alive = true;
	private readonly opts: PageChildOptions;

	stderrTail = "";
	/** Characters the keep cut has already thrown away, so the send cut can count everything dropped. */
	stderrDropped = 0;

	private nextId = 1;
	private readonly pending = new Map<string, (msg: any) => void>();
	/** The tool calls running now, from `tool_execution_start` to `tool_execution_end`. */
	private readonly toolCalls = new Set<string>();
	/**
	 * The dialogs asked while a tool ran: pi has answered every one of them by the run's `agent_end`.
	 * A dialog a slash command opens during the run (`/session-share`) is not one; it waits for its answer.
	 */
	private readonly toolAsks = new Set<string>();

	entriesCache: { at: number; value: any } = { at: 0, value: undefined };

	live = {
		/** What pi itself holds queued (a slash command or template typed while busy): shown beside the rows, cleared with them. */
		queue: { steering: [] as any[], followUp: [] as any[] },
		goal: undefined as any,
		lastPoll: undefined as any,
		runtime: undefined as any,
		lastError: undefined as any,
		pendingAsks: new Map<string, any>(), // dialogs asked while no browser was attached
	};

	catalog = {
		modelCatalog: [] as any[],
		thinkingLevels: [] as any[],
		commandList: [] as { name: string; description?: string; source?: string }[],
		/**
		 * Whether the pi behind this page has pi-loops in it, as its command list says; undefined until the
		 * list has been asked for, which is after the address is announced, so a request can arrive first.
		 * Unknown is not absent: only a known `false` hides the queue or refuses its routes (`/prompt` asks
		 * before it decides). Without the extension nobody drains `requests/`, and `/pi-loops ring` reaches
		 * the model as the person's text: chat goes over rpc `prompt` then, as it did before 0.24.
		 */
		piLoopsLoaded: undefined as boolean | undefined,
		commandsAt: 0,
	};

	/**
	 * The session's directory, as pi reports it. `@mention` expansion and path completion are anchored
	 * here and nowhere else: the browser is told this value and echoes it back on every request, and a
	 * root that the caller supplies is not a boundary at all — `isUnder(f, "/")` is true of every file
	 * on the disk. Reaching those routes already needs the token, which /rpc turns into the whole
	 * session, so this is an invariant kept rather than a hole closed.
	 */
	sessionCwd: string;

	/**
	 * Which file the session is being written to, as of the last `get_state`.
	 *
	 * Everything about starting or resuming a session is anchored to this one value rather than to
	 * anything the browser supplies: its directory is where a new session goes and the only place
	 * `/sessions` will list, and switching to it is the one destination that is refused (pi treats
	 * a switch to the file it is already writing as a brand-new session pointed at that file, which
	 * is two sessions with one file between them).
	 */
	sessionFile: string | undefined;
	/** Whether `sessionFile` has been seen on disk: once it has, its going away is a move, not a file pi has yet to write. */
	private fileSeen = false;
	/** pi's session id, from the last `get_state`: the file a row is addressed to. */
	sessionId: string | undefined;

	/* ------------------------------------------------------------------ http */

	clients = new Set<http.ServerResponse>();
	backlog: any[] = [];

	/**
	 * Every event carries a number, and the history hand-off says which number it was current at. The
	 * browser replays the transcript, then ignores anything from the backlog it already has — exactly,
	 * instead of the "drop message_end for the first 300ms" guess this replaces. That guess dropped
	 * live events whenever the backlog held a turn that was still running: the tool results and the
	 * end-of-message that turns a streamed reply into rendered Markdown both went with it, so you got
	 * a page of raw asterisks and tools stuck on "running".
	 */
	eventSeq = 0;
	/**
	 * Which run of this process the numbers belong to. Without it, a browser holding number 40 from the
	 * process that just exited quietly ignores the first forty events of the one that replaced it —
	 * every number is "already seen". A restart is not a gap, it is a different sequence entirely.
	 */
	epoch = randomBytes(6).toString("hex");

	/** Built once pi has spawned: a child that never started has no pid and no listeners to give. */
	constructor(pi: ChildProcessByStdio<Writable, Readable, Readable>, opts: PageChildOptions) {
		if (pi.pid === undefined) throw new Error("pi has not started");
		this.pi = pi;
		this.opts = opts;
		this.pid = pi.pid;
		this.procStart = procStart(pi.pid);
		this.cwd = opts.cwd;
		this.piArgs = opts.piArgs;
		this.sessionCwd = opts.cwd;
		this.log = opts.log;
		const on = (name: string, fn: (...args: any[]) => unknown) => guard(this.log, name, fn);

		pi.on(
			"error",
			on("pi error", (err: Error) => this.log(`pi-loops page: pi ${this.pid}: ${err.message}`)),
		);
		pi.on(
			"exit",
			on("pi exit", (code: number | null, signal: NodeJS.Signals | null) => {
				this.alive = false;
				// Nothing will answer now. A command still waiting would hold a browser request open
				// until its own timeout, up to fifteen minutes for a slash command.
				for (const answer of this.pending.values()) answer({ success: false, error: "pi is not running" });
				this.pending.clear();
				// The page has to be told *why*. pi's own reasons for refusing to start — a duplicate extension,
				// a provider that will not authenticate — are on its stderr, and a browser tab that just says
				// "pi exited" sends you to the terminal to find out what a terminal already knew.
				this.broadcast({ type: "pi_exit", code, signal, stderr: this.recentStderr() });
				this.opts.onExit(code, signal);
			}),
		);

		pi.stderr.on(
			"data",
			on("pi stderr", (d: Buffer) => {
				// This process's stderr is host.log now, not a terminal: a provider that refused to
				// authenticate prints the key it was given, so the line is masked before it lands on disk.
				process.stderr.write(maskSecrets(d.toString("utf8")));
				// Characters, not code units: a cut on the code-unit half of an astral character leaves a lone
				// surrogate in the tail, which `textContent` draws as a replacement glyph.
				const all = Array.from(this.stderrTail + d.toString("utf8"));
				this.stderrDropped += Math.max(0, all.length - STDERR_KEEP);
				this.stderrTail = all.slice(-STDERR_KEEP).join("");
			}),
		);

		pi.stdin.on(
			"error",
			on("pi stdin", (err: any) => {
				this.alive = false;
				this.log(`pi-loops web: pi's input closed: ${err?.message ?? err}`);
			}),
		);

		// Strict JSONL (jsonlLines): one tool result containing U+2028 would otherwise desync the stream
		// for the rest of the session. Decoded as a stream, so a character whose bytes arrive in two
		// chunks is one character and not two replacement glyphs.
		pi.stdout.setEncoding("utf8");
		const lineMax = opts.lineMax ?? PI_LINE_MAX;
		const lines = jsonlLines(lineMax);
		pi.stdout.on(
			"data",
			on("pi stdout", (chunk: string) => {
				for (const line of lines(chunk)) {
					if (typeof line !== "string") {
						this.overlong(line.head, lineMax);
						continue;
					}
					if (!line.trim()) continue;
					let msg;
					try {
						msg = JSON.parse(line);
					} catch {
						continue; // never desync the whole session over one unparseable line
					}
					if (!msg || typeof msg !== "object") continue; // a bare value is not an event
					if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
						this.pending.get(msg.id)?.(msg);
						this.pending.delete(msg.id);
						continue; // a command's own answer belongs to its caller, not to the feed
					}
					this.opts.onNote?.(msg);
					this.observe(msg);
					this.broadcast(msg);
				}
			}),
		);
	}

	recentStderr() {
		// Redact the whole kept tail, then cut by characters. `slice` counted UTF-16 code units, so the
		// served tail could begin on the low half of an astral character — a replacement glyph where the
		// error should start — and the page's own cap at 4000 could never fire: it was always handed 4000
		// code units or fewer, and code points are never more numerous than code units, so nothing ever
		// told the person anything was dropped. The count has to be put here rather than in the page,
		// because `capped` keeps the first n characters and a tail keeps the last.
		const kept = Array.from(maskSecrets(this.stderrTail.trim()) as string);
		if (!this.stderrDropped && kept.length <= STDERR_SEND) return kept.join("");
		const room = STDERR_SEND - 40; // the marker line below is shorter than this
		const shown = kept.slice(-room);
		return `… (${this.stderrDropped + kept.length - shown.length} chars dropped)\n${shown.join("")}`;
	}

	/**
	 * Write one line to pi. Its stdin is a pipe to another process: it can be gone before the `exit`
	 * event that sets `alive`, and an EPIPE arrives as an unhandled `error` event on the socket,
	 * which ends this process too. A browser front end whose pi died should say so, not die with it.
	 */
	writeToPi(line: string) {
		if (!this.alive) return false;
		try {
			this.pi.stdin.write(line);
			return true;
		} catch (err: any) {
			this.log(`pi-loops web: could not write to pi: ${err?.message ?? err}`);
			return false;
		}
	}

	/** A line from pi over the cap was dropped: the command it answered gets a reason instead of waiting out its timeout. */
	private overlong(head: string, max: number) {
		const m = ANSWER_HEAD.exec(head);
		const id = m?.[1] ?? m?.[2];
		const why = `pi answered with a line over ${Math.round(max / (1024 * 1024))} MiB, longer than the page reads`;
		this.log(`pi-loops web: ${why}${id ? ` (${id})` : ""}; dropped`);
		const answer = id ? this.pending.get(id) : undefined;
		if (!answer || !id) return;
		this.pending.delete(id);
		answer({ success: false, error: why });
	}

	/** Whether this process asks pi for the entries of the conversation it is in (held-read.ts `entriesReadable`). */
	entriesReadable(): boolean {
		if (!this.fileSeen && this.sessionFile && fs.existsSync(this.sessionFile)) this.fileSeen = true;
		return fileEntriesReadable(this.sessionFile, this.fileSeen);
	}

	/** Send one RPC command and wait for the response that carries its id. */
	rpc(command: object, timeoutMs = 60_000): Promise<any> {
		if (!this.alive) return Promise.resolve({ success: false, error: "pi is not running" });
		const id = `web-${this.nextId++}`;
		if (!this.writeToPi(`${JSON.stringify({ ...command, id })}\n`)) return Promise.resolve({ success: false, error: "pi is not running" });
		return new Promise((resolve) => {
			const timer = setTimeout(
				guard(this.log, "rpc timeout", () => {
					// A command that never answers must not hold a browser request open for ever.
					if (this.pending.delete(id)) resolve({ success: false, error: `timed out after ${timeoutMs}ms` });
				}),
				timeoutMs,
			);
			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
		});
	}

	/** Fold the events that carry state a late-joining browser still needs. */
	observe(ev: any) {
		const turn = (RPC_TURN_EVENTS as Record<string, readonly ["run" | "compaction", boolean]>)[ev.type];
		if (turn) {
			if (turn[1]) this.turn.add(turn[0]);
			else this.turn.delete(turn[0]);
		}
		if (ev.type === "tool_execution_start") this.toolCalls.add(String(ev.toolCallId));
		if (ev.type === "tool_execution_end") this.toolCalls.delete(String(ev.toolCallId));
		if (ev.type === "agent_end") {
			// A tool's timed dialog ends with the tool: an abort or a timeout resolves it inside pi, which
			// tells nobody. Offered again, it would be a card whose answer goes nowhere. A slash command's
			// dialog has no timeout and waits past the run, even when it opened while a tool ran.
			for (const id of this.toolAsks) this.live.pendingAsks.delete(id);
			this.toolAsks.clear();
			this.toolCalls.clear();
		}
		if (ev.type === "queue_update") this.live.queue = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
		// pi refused a `sendUserMessage` (compaction in progress, no credentials). The holder finds the
		// row it handed over and never saw start once the grace has passed; ring it then, so the row
		// comes back to the composer without waiting for the tick.
		if (ev.type === "extension_error" && ev.event === "send_user_message") setTimeout(guard(this.log, "ring after a refused send", () => this.opts.ring()), PERSON_SEND_GRACE_MS + 500).unref();
		if (ev.type === "extension_ui_request") {
			if (isDialog(ev)) {
				// pi answers a dialog with a timeout itself when it elapses and tells nobody; past that an
				// answer goes nowhere, so the dialog is not offered again, and one replayed carries what is left.
				const timed = typeof ev.timeout === "number" && ev.timeout > 0;
				const held = timed ? { ...ev, expiresAt: Date.now() + ev.timeout } : ev;
				this.live.pendingAsks.set(ev.id, held);
				if (this.toolCalls.size && timed) this.toolAsks.add(ev.id);
				if (timed) setTimeout(guard(this.log, "dialog timeout", () => this.live.pendingAsks.get(ev.id) === held && this.live.pendingAsks.delete(ev.id)), ev.timeout).unref();
				while (this.live.pendingAsks.size > MAX_PENDING_ASKS) this.live.pendingAsks.delete(this.live.pendingAsks.keys().next().value as string);
			}
		}
		if (ev.type === "entry_appended") {
			this.entriesCache = { at: 0, value: undefined }; // the session moved; search and undo must re-read
			const entry = ev.entry;
			if (entry?.type !== "custom") return;
			// pi-loops writes its own state into the session as custom entries, so the panel can read it
			// structurally instead of parsing the text it prints for a person.
			if (entry.customType === "goal_state") this.live.goal = entry.data;
			if (entry.customType === "trigger_result") this.live.lastPoll = { ...entry.data, at: entry.timestamp };
			// Which MCP servers actually connected, what they exposed, whether pi-loops runs: state that
			// lives in the pi process and is in no file this side could open.
			if (entry.customType === "pi_loops_snapshot") this.live.runtime = entry.data;
		}
	}

	/** pi's command list, and from it whether pi-loops is loaded. */
	async refreshCommands() {
		const commands = await this.rpc({ type: "get_commands" }, 10_000);
		if (commands?.success) {
			this.catalog.commandList = (commands.data?.commands ?? []).map((c: any) => ({ name: c.name, description: c.description, source: c.source }));
			this.catalog.piLoopsLoaded = this.catalog.commandList.some((c) => c.name === "pi-loops");
			this.catalog.commandsAt = Date.now();
		}
	}

	async refreshCatalog() {
		const [models, levels] = await Promise.all([
			this.rpc({ type: "get_available_models" }, 10_000),
			// Which thinking levels mean anything for the model in use: the map pi carries has nulls in
			// it, and offering a level a model does not have is offering nothing.
			this.rpc({ type: "get_available_thinking_levels" }, 10_000),
			this.refreshCommands(),
		]);
		if (levels?.success) this.catalog.thinkingLevels = levels.data?.levels ?? [];
		// pi says a great deal more about a model than its name, and the page can use most of it: which
		// of them take images, how big a context is, what a token costs. Keeping only the id meant the
		// picker was 33 identical-looking lines and the attach button was a guess.
		if (models?.success) {
			this.catalog.modelCatalog = (models.data?.models ?? []).map((m: any) => ({
				id: m.id,
				provider: m.provider,
				name: m.name,
				images: Array.isArray(m.input) ? m.input.includes("image") : undefined,
				reasoning: !!m.reasoning,
				contextWindow: m.contextWindow,
				cost: m.cost ? { input: m.cost.input, output: m.cost.output } : undefined,
			}));
		}
	}

	/**
	 * A session that has been running has its snapshot somewhere back in the transcript, and pi-loops
	 * only writes a new one when something changes — so read the last one, then ask for a fresh one.
	 */
	async primeRuntime() {
		// Started for a conversation, pi names its file in its first get_state answer.
		if (this.sessionFile === undefined) await this.identify();
		const entries = this.entriesReadable() ? await this.rpc({ type: "get_entries" }, 20_000) : undefined;
		if (entries?.success) {
			for (const e of entries.data?.entries ?? []) {
				if (e?.type === "custom" && e.customType === "pi_loops_snapshot") this.live.runtime = e.data;
				if (e?.type === "custom" && e.customType === "goal_state") this.live.goal = e.data;
			}
		}
		if (this.catalog.commandList.some((c) => c.name === "cron")) await this.rpc({ type: "prompt", message: "/cron snapshot" }, 20_000);
	}

	/**
	 * Which conversation pi is in, asked once it has started: the pool keys a child by it, and a child
	 * started for a new conversation has no id until pi has made one.
	 */
	async identify() {
		const state = await this.rpc({ type: "get_state" }, 15_000);
		if (state?.success) this.adopt(state.data ?? {});
	}

	/** What a `get_state` says about where pi is: the directory, the session id, the file. */
	private adopt(s: any) {
		const cwd = s.cwd || this.cwd;
		this.sessionCwd = cwd;
		if (typeof s.sessionId === "string") this.sessionId = s.sessionId;
		if (typeof s.sessionFile === "string" && s.sessionFile && s.sessionFile !== this.sessionFile) {
			const switched = this.sessionFile !== undefined && realpathish(s.sessionFile) !== realpathish(this.sessionFile);
			this.sessionFile = s.sessionFile;
			this.fileSeen = false;
			if (switched) {
				this.startedOver(s.sessionFile);
				Promise.all([this.refreshCatalog(), this.primeRuntime()]).catch((err) => this.log(`pi-loops web: after a session switch: ${err?.message ?? err}`));
			}
		}
		return cwd;
	}

	async snapshot(extra: SnapshotExtra) {
		const state = await this.rpc({ type: "get_state" }, 15_000);
		const s = state?.success ? state.data : {};
		const cwd = this.adopt(s);
		return {
			ok: !!state?.success,
			sessionId: s.sessionId,
			sessionName: s.sessionName,
			sessionFile: s.sessionFile,
			cwd,
			model: s.model ? { id: s.model.id, provider: s.model.provider, label: `${s.model.provider}/${s.model.id}` } : undefined,
			modelCatalog: this.catalog.modelCatalog,
			thinkingLevels: this.catalog.thinkingLevels,
			// The page polls this. Comparing these two against what it has received is how it notices
			// that it is no longer being told anything — a dropped stream, a suspended tab, or a server
			// that has been restarted under it.
			seq: this.eventSeq,
			epoch: this.epoch,
			// What is serving this, so a page can tell whether it is the page this server would send.
			version: this.opts.version,
			thinkingLevel: s.thinkingLevel,
			busy: !!s.isStreaming,
			compacting: !!s.isCompacting,
			messageCount: s.messageCount ?? 0,
			requests: extra.requests(s.sessionId, !s.isStreaming && !s.isCompacting),
			queue: this.live.queue,
			goal: this.live.goal,
			lastPoll: this.live.lastPoll,
			runtime: this.live.runtime,
			pendingAsks: [...this.live.pendingAsks.values()].map(({ expiresAt, ...ask }) => (expiresAt === undefined ? ask : { ...ask, timeout: Math.max(1, expiresAt - Date.now()) })),
			automation: extra.automation(cwd, s.sessionId),
			piAlive: this.alive,
		};
	}

	/* ------------------------------------------------------------------ starting over */

	/**
	 * Starting a session and going back to one, without leaving the page.
	 *
	 * Both are `switch_session`, which pi answers by replacing the session inside the process it
	 * already has: same model, same MCP connections, same extensions — pi rebuilds them against the
	 * new session and pi-loops has handled that path since it was written (`session_shutdown` with a
	 * reason that is not "quit", then `session_start`, which is how `/new` and `/resume` behave in the
	 * terminal). The clock is not handed to the headless host and no scheduled run is lost: one that
	 * the swap aborts gives its slot back and re-fires on the next tick.
	 *
	 * A path that does not exist yet is how a *new* session is asked for. Nothing is written until the
	 * first message, so the new-session button costs an empty file only if you use it.
	 */

	/** The directory pi keeps this project's sessions in: where the current one is, and nowhere else. */
	sessionsDir() {
		return this.sessionFile ? path.dirname(this.sessionFile) : undefined;
	}

	/**
	 * What is in that directory, newest first.
	 *
	 * Only the head of each file is read. A session is a transcript — some are megabytes — and this
	 * list is drawn every time the dialog opens; what it needs is the header, plus enough of the start
	 * to say which conversation this was. pi's own picker prefers a name over the first message when
	 * one is set, and so does this, with the caveat that a name set late in a long session is past the
	 * part that gets read and shows as the first message instead.
	 */
	listSessionsHere(limit = 40) {
		const dir = this.sessionsDir();
		if (!dir) return [];
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch {
			return []; // nothing saved for this project yet
		}
		const out = [];
		// Sorting by age means looking at all of them, and this runs on the request thread: a directory
		// that has grown past anything anyone would page through is cut off rather than stalling it.
		for (const name of names.slice(0, 2000)) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(dir, name);
			let stat;
			try {
				stat = fs.statSync(file);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			out.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
		}
		out.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const sessions = [];
		// What the filesystem resolves to, not what the name says: a link in this directory pointing at
		// the open session is otherwise a way to be offered the one destination that is refused.
		const open = this.sessionFile ? realpathish(this.sessionFile) : undefined;
		for (const entry of out.slice(0, limit)) {
			const head = readSessionHead(entry.file);
			if (!head) continue; // not a session file, or not a readable one
			sessions.push({ ...entry, ...head, current: realpathish(entry.file) === open });
		}
		return sessions;
	}

	/**
	 * Where a new session goes: pi's own naming, in pi's own directory.
	 *
	 * The uuid in the name is this side's, and the id pi puts in the header is pi's — they will not be
	 * the same string, because pi mints its id when it takes the path and nothing can know it sooner.
	 * pi does not mind: `--session <id>`, `-c` and its picker all match on the header, checked against
	 * a session file deliberately named after a different uuid.
	 *
	 * pi-loops did mind, in one place, and it cost every inject-and-run job made in a session started
	 * here: `sessionExists` decided by the file name, so ten minutes later the scheduler parked those
	 * jobs as belonging to a session that did not exist, and `/cron gc` deletes what it parks. That
	 * function reads the header now. Anything else that identifies a session by its file name is
	 * wrong about a session this function named.
	 */
	newSessionPath() {
		const dir = this.sessionsDir();
		if (!dir) return undefined;
		return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
	}

	/**
	 * Put a resumed session back on the model it was having its conversation with.
	 *
	 * `--model` on the launch command line — which the launcher also supplies from `ui.json`'s remembered
	 * choice — is not a one-off: pi re-resolves it every time the session inside the process is replaced,
	 * so resuming an earlier session in this window landed it on the model *this process* started with.
	 * A fresh `pi --resume` restores the session's own model instead, and a window should not mean
	 * something different from a terminal.
	 *
	 * Best effort by nature: a model this session used and this machine has no credentials for any more
	 * is refused by pi, and the session stays on the one it has — which is what the panel then says.
	 */
	async restoreModelOf(file: string) {
		if (!fileEntriesReadable(file)) return; // too big to parse here: it stays on the model it has
		const r = await this.rpc({ type: "get_entries" }, 20_000);
		if (!r?.success) return;
		const want = lastModelOf(r.data?.entries ?? [], r.data?.leafId);
		if (!want) return; // a session nobody ever answered in: nothing to go back to
		const state = await this.rpc({ type: "get_state" }, 15_000);
		const now = state?.success ? state.data?.model : undefined;
		if (now && now.provider === want.provider && now.id === want.modelId) return; // already there
		const answer = await this.rpc({ type: "set_model", provider: want.provider, modelId: want.modelId }, 20_000);
		// Whoever asked for the swap refreshes the catalog right after this, which is where the new
		// model's thinking levels come from; there is nothing to do here on success.
		if (answer?.success) return;
		// Not a failure of the resume: the conversation is back, on a different model. The terminal is
		// where that belongs — the page reads the model it is actually on from /state.
		this.log(`pi-loops web: ${path.basename(file)} was last on ${want.provider}/${want.modelId}, which this session could not go back to: ${answer?.error ?? "pi did not answer"}`);
	}

	/**
	 * Swap the session under the page.
	 *
	 * Refused while a turn is running: the swap aborts it, and losing a reply you are waiting for is
	 * not something to discover afterwards. The page asks first, which is where the question belongs;
	 * this is the check that means it cannot be skipped by a stale tab.
	 */
	async swapSession(file: string | undefined, { restoreModel = false, reopen = false } = {}) {
		if (!this.alive) return { success: false, error: "pi is not running" };
		if (!file && !reopen) return { success: false, error: "this session has no file on disk (pi was started with --no-session)" };
		const before = await this.rpc({ type: "get_state" }, 15_000);
		if (!before?.success) return { success: false, error: before?.error ?? "pi did not answer" };
		if (before.data?.isStreaming || before.data?.isCompacting) return { success: false, error: "a turn is running — stop it first" };
		const current = before.data?.sessionFile;
		// `reopen`: the session pi is in, read again from disk, where another window wrote after pi read it.
		if (reopen) file = current;
		if (!file) return { success: false, error: "this session has no file on disk (pi was started with --no-session)" };
		if (!reopen && current && realpathish(file) === realpathish(current)) return { success: false, error: "this is the session you are already in" };
		const answer = await this.rpc({ type: "switch_session", sessionPath: file }, 60_000);
		if (!answer?.success) return answer ?? { success: false, error: "pi did not answer" };
		if (answer.data?.cancelled) return { success: true, data: { cancelled: true } };

		this.startedOver(file);
		// Only a resume: a new session is meant to start on whatever this process starts sessions on.
		if (restoreModel) await this.restoreModelOf(file);
		// The rebuilt extensions register their commands again, and pi-loops writes a snapshot for the
		// panel only when something changes — so ask for both rather than showing the old session's.
		await this.refreshCatalog();
		await this.primeRuntime();
		return answer;
	}

	/**
	 * Forget what belonged to the session pi was in. A swap the page asked for comes here, and so does
	 * one an extension made inside pi (`/inbox open`, `/session-import --resume`), which `snapshot`
	 * notices when the file pi reports is not the one this side last knew.
	 */
	startedOver(file: string) {
		// A different session is a different sequence of events: the numbers the page was counting mean
		// nothing against the ones that start now, and the epoch is how it is told that.
		this.epoch = randomBytes(6).toString("hex");
		this.backlog.length = 0;
		this.entriesCache = { at: 0, value: undefined };
		this.live.queue = { steering: [], followUp: [] };
		this.live.goal = undefined;
		this.live.lastPoll = undefined;
		this.live.runtime = undefined;
		this.live.lastError = undefined;
		// Dialogs belong to the session that asked them. The extension that was waiting for an answer
		// went down with the swap, and answering now would be answering nobody.
		this.live.pendingAsks.clear();
		this.sessionFile = file;
		this.fileSeen = false;
	}

	broadcast(event: any) {
		if (event && typeof event === "object") {
			event.seq = ++this.eventSeq;
			event.epoch = this.epoch;
		}
		this.backlog.push(event);
		if (this.backlog.length > 800) this.backlog.shift();
		const data = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of this.clients) {
			try {
				res.write(data);
			} catch {
				this.clients.delete(res);
			}
		}
	}

	/** The whole session, for search and undo. Typing in the search box must not re-read it per key. */
	async cachedEntries() {
		if (Date.now() - this.entriesCache.at < 3_000 && this.entriesCache.value) return this.entriesCache.value;
		if (!this.entriesReadable()) return { success: false, error: "this conversation is too big to read here, or its file has moved" };
		const r = await this.rpc({ type: "get_entries" }, 30_000);
		this.entriesCache = { at: Date.now(), value: r };
		return r;
	}
}

/* ------------------------------------------------------------------ the pool: one child per open conversation */

/** `pages/<session>.json`: one per running child, so a later pi-loops can stop what an earlier one left. */
export interface PageRecord {
	v: 1;
	sessionId: string;
	cwd: string;
	pid: number;
	procStart?: string;
	startedAt: string;
	/** Written at most once a minute. */
	lastClientAt: string;
	/** The pi-loops process that started the child. */
	server: { pid: number; procStart?: string };
	/** The pi arguments the child was started with. */
	piArgs: string[];
}

/** A record as read back from disk; undefined for anything torn or foreign. */
export function parsePageRecord(text: string): PageRecord | undefined {
	let v: any;
	try {
		v = JSON.parse(text);
	} catch {
		return undefined; // torn, or not ours
	}
	const pid = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
	if (!v || typeof v !== "object" || v.v !== 1 || typeof v.sessionId !== "string" || typeof v.cwd !== "string" || !pid(v.pid)) return undefined;
	if (typeof v.startedAt !== "string" || typeof v.lastClientAt !== "string" || !v.server || !pid(v.server.pid)) return undefined;
	// Read for the orphan it names, so a record without them is still one to stop.
	return { ...v, piArgs: stringList(v.piArgs) ?? [] } as PageRecord;
}

/** `v` when it is a list of strings, else undefined. */
function stringList(v: unknown): string[] | undefined {
	return Array.isArray(v) && v.every((a) => typeof a === "string") ? v : undefined;
}

/** What the decisions below need to know about a child, and nothing else. */
export type ChildView = { sessionId: string; clients: number; busy: boolean; pendingAsks: number; unsentPersonRows: number; lastClientAt: number };

export const PAGE_IDLE_MS = 15 * 60_000;
export const PAGE_CAP = 6;
export const PAGE_STREAMS_PER_CHILD = 16;
export const PAGE_STREAMS_TOTAL = 32;
/** Exits of one conversation's pi that stop the page from starting it again on its own. */
export const PAGE_CRASH_BUDGET = { count: 3, windowMs: 5 * 60_000 };

/** `PAGE_IDLE_MS`, or `PI_LOOPS_PAGE_IDLE_MS` when that is a positive number of milliseconds. */
export function pageIdleMs(env: NodeJS.ProcessEnv): number {
	const told = Number(env.PI_LOOPS_PAGE_IDLE_MS);
	return Number.isFinite(told) && told > 0 ? told : PAGE_IDLE_MS;
}

/**
 * Nobody would notice this child stop: no browser attached, no turn running, no dialog waiting and
 * no message of the person's that it still has to ring for. The last one matters because the row's
 * producer is this child: stopped, the row would wait for the next page to offer it.
 */
const idle = (c: ChildView) => c.clients === 0 && !c.busy && c.pendingAsks === 0 && c.unsentPersonRows === 0;

/**
 * Which children to stop: every idle one nobody has looked at for `idleMs`, and, when `opening` names
 * a conversation the pool does not have and the pool is at `cap`, the least recently used idle ones
 * to make room. `full` when there is no room to make.
 */
export function decideChildStops(children: readonly ChildView[], now: number, opts: { idleMs: number; cap: number; opening?: string }): { stop: string[]; full?: true } {
	const stop = children.filter((c) => idle(c) && now - c.lastClientAt > opts.idleMs).map((c) => c.sessionId);
	if (opts.opening === undefined || children.some((c) => c.sessionId === opts.opening)) return { stop };
	const left = children.filter((c) => !stop.includes(c.sessionId));
	const over = left.length - opts.cap + 1;
	if (over <= 0) return { stop };
	const spare = left.filter(idle).sort((a, b) => a.lastClientAt - b.lastClientAt);
	stop.push(...spare.slice(0, over).map((c) => c.sessionId));
	return spare.length >= over ? { stop } : { stop, full: true };
}

/**
 * What to do with a record found on start, judging pids by the rule a lease holder is judged by.
 * `ours`: this process wrote it, or another pi-loops that is still running does, which stops its own
 * children (two `pi-loops --web` share one loops directory). `gone`: its pid is not that child any
 * more. Otherwise the child of a pi-loops that is gone is still running, with nobody on its stdio:
 * stop it. It is never adopted, since its pipes died with the process that held them.
 */
export function decideOrphan(rec: PageRecord, self: { pid: number; procStart?: string }, probe: ProcessProbe): "ours" | "gone" | "wait-then-stop" {
	const alive = (pid: number, start: string | undefined) => holderAlive({ kind: "terminal", pid, instance: "", procStart: start, acquiredAt: rec.startedAt, pushServers: [] }, probe);
	if (rec.server.pid === self.pid && (rec.server.procStart === undefined || self.procStart === undefined || rec.server.procStart === self.procStart)) return "ours";
	if (rec.server.pid !== self.pid && alive(rec.server.pid, rec.server.procStart)) return "ours";
	return alive(rec.pid, rec.procStart) ? "wait-then-stop" : "gone";
}

/**
 * What opening a conversation does: use the child it has; wait while pi-loops runs a turn in it, since
 * starting pi there would take the conversation from that turn; refuse after `PAGE_CRASH_BUDGET`
 * exits, which a person restarts by hand; otherwise start one.
 *
 * A turn is pi-loops's `heldTurn`, or, before that is known, a live pi-loops holder whose lease says
 * `busy`: it takes the lease first and starts the turn after it has claimed the job.
 */
export function decideOpen(
	i: { child?: ChildView; heldTurn?: { runId: string; label: string }; lease?: Partial<Pick<SessionLease, "holder">>; fileMissing?: boolean; crashes: readonly number[]; now: number },
	probe: ProcessProbe = systemProbe,
): { kind: "reuse" } | { kind: "start" } | { kind: "wait-background"; runId: string; label: string } | { kind: "wait-terminal"; pid: number } | { kind: "crash-looping" } {
	if (i.child) return { kind: "reuse" };
	if (i.heldTurn) return { kind: "wait-background", runId: i.heldTurn.runId, label: i.heldTurn.label };
	const holder = i.lease?.holder;
	if (holder?.kind === "host" && holder.busy && holderAlive(holder, probe)) return { kind: "wait-background", runId: holder.busy.runId, label: holder.busy.jobId === DELIVERY_JOB_ID ? DELIVERY_LABEL : holder.busy.runId.slice(0, 12) };
	// A terminal's new conversation, before its first answer: there is no file for a page pi to open,
	// and one started anyway would be another conversation under this one's address.
	if (i.fileMissing && holder?.kind === "terminal" && holder.page !== true && holderAlive(holder, probe)) return { kind: "wait-terminal", pid: holder.pid };
	if (i.crashes.filter((at) => i.now - at < PAGE_CRASH_BUDGET.windowMs).length >= PAGE_CRASH_BUDGET.count) return { kind: "crash-looping" };
	return { kind: "start" };
}

/**
 * How to run pi as a child: `PI_BIN` when it is set, else this Node with pi's own `bin.pi`. Never a
 * `pi` found on PATH: a LaunchAgent's PATH is `/usr/bin:/bin`. `piPackage` is src/pi-resolver.mjs's.
 */
export function piCommand(env: NodeJS.ProcessEnv, piPackage: () => string): { command: string; args: string[] } {
	if (env.PI_BIN) return { command: env.PI_BIN, args: [] };
	const dir = piPackage();
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
	if (typeof bin !== "string") throw new Error(`${dir}/package.json names no bin.pi`);
	return { command: process.execPath, args: [path.join(dir, bin)] };
}

export interface ChildPoolOptions {
	/** The loops directory: `pages/` and `pages.lock` live in it. */
	dir: string;
	command: () => { command: string; args: string[] };
	/** The environment every child starts with. */
	env: NodeJS.ProcessEnv;
	version: string;
	log: (line: string) => void;
	ring: (child: PageChild) => Promise<unknown>;
	onNote?: (child: PageChild, msg: any) => void;
	/** After the pool has dropped the child and its record. */
	onExit?: (child: PageChild, code: number | null, signal: NodeJS.Signals | null) => void;
	/** The person rows this child has written and not handed over: a child with any is not idle. */
	unsent?: (child: PageChild) => number;
	probe?: ProcessProbe;
	now?: () => number;
}

export interface OpenHow {
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
	piArgs: string[];
}

/**
 * pi's rpc events that start or end what keeps a child busy. A run lasts until `agent_settled`, not
 * `agent_end`: pi retries, compacts and continues after `agent_end`. A compaction can come with no
 * run at all (`/compact`). The lease follows the same rule from inside pi (src/lease.ts TURN_EVENTS).
 */
export const RPC_TURN_EVENTS = {
	agent_start: ["run", true],
	agent_settled: ["run", false],
	compaction_start: ["compaction", true],
	compaction_end: ["compaction", false],
} as const;

/** What the waiting page calls pi-loops delivering what is queued for a conversation: no run, so nothing to stop. */
export const DELIVERY_LABEL = "a message delivery";

/** A key no conversation has: what a conversation without an id yet asks the cap for. */
const NO_ID_YET = "\u0000new";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One `pi --mode rpc` per open conversation, keyed by its session id: `new-<pid>` until pi has said
 * which session it is in. Each running child has a record in `pages/`, written under `pages.lock`.
 */
export class ChildPool {
	readonly idleMs: number;
	private readonly opts: ChildPoolOptions;
	private readonly probe: ProcessProbe;
	private readonly now: () => number;
	private readonly self: { pid: number; procStart?: string };
	private readonly children = new Map<string, PageChild>();
	private readonly starting = new Map<string, Promise<PageChild>>();
	/**
	 * Conversations whose pi now says it is in another: the id a page asked for, and the one pi chose.
	 * A conversation pi never wrote a file for has nothing to resume, so pi starts a new one for it,
	 * and every later request for the old id has to reach that pi rather than start another.
	 */
	private readonly moved = new Map<string, string>();
	/** A pi started for a conversation with no file yet, and that conversation's id: only its first move is a `moved` one. */
	private readonly startedFresh = new WeakMap<PageChild, string>();
	/** Orphans of an earlier pi-loops still being stopped, by session: opening one waits for it. */
	private readonly reaping = new Map<string, Promise<void>>();
	/** Exits nobody asked for, by session, and what pi said last: the crash budget and its page. */
	private readonly exits = new Map<string, { at: number[]; stderr: string }>();
	/** Children this pool asked to stop: their exit is not a crash. */
	private readonly asked = new WeakSet<PageChild>();
	/** When each child's record last had its `lastClientAt` written. */
	private readonly written = new WeakMap<PageChild, number>();
	/** Each child's first `get_state`, settled once pi has said which conversation it is in, or could not. */
	private readonly naming = new WeakMap<PageChild, Promise<void>>();
	private readonly reaped: Promise<void>;

	constructor(opts: ChildPoolOptions) {
		this.opts = opts;
		this.probe = opts.probe ?? systemProbe;
		this.now = opts.now ?? Date.now;
		this.idleMs = pageIdleMs(opts.env);
		this.self = { pid: process.pid, procStart: procStart(process.pid) };
		this.reaped = this.reap();
	}

	private recordFile(key: string) {
		return path.join(this.opts.dir, "pages", `${sessionFileName(key)}.json`);
	}

	private underLock<T>(fn: () => T): T {
		return withFileLockSync(path.join(this.opts.dir, "pages.lock"), fn);
	}

	private writeRecord(key: string, child: PageChild) {
		const rec: PageRecord = { v: 1, sessionId: key, cwd: child.cwd, pid: child.pid, procStart: child.procStart, startedAt: stamp(child.startedAt), lastClientAt: stamp(child.lastClientAt), server: this.self, piArgs: child.piArgs };
		this.underLock(() => writeFileAtomic(this.recordFile(key), `${JSON.stringify(rec, null, 2)}\n`, 0o600));
		this.written.set(child, this.now());
	}

	private argsFile(sessionId: string) {
		return path.join(this.opts.dir, "pages", "args", `${sessionFileName(sessionId)}.json`);
	}

	/**
	 * The pi arguments of the launch that opened a conversation, kept in `pages/args/<session>.json`
	 * after its child and its record are gone: a child the page starts again after an idle stop, a
	 * restart or a wait gets them. Written by a start and by `page-open`, never from HTTP.
	 */
	recordArgs(sessionId: string, piArgs: string[]) {
		writeFileAtomic(this.argsFile(sessionId), `${JSON.stringify(piArgs)}\n`, 0o600);
	}

	/** The arguments `recordArgs` kept for a conversation; none for one it never saw. */
	argsOf(sessionId: string): string[] {
		let text;
		try {
			text = fs.readFileSync(this.argsFile(sessionId), "utf8");
		} catch {
			return []; // never opened with any, or opened before this was kept
		}
		try {
			return stringList(JSON.parse(text)) ?? [];
		} catch {
			return []; // torn: pi's own defaults, as for a conversation never opened here
		}
	}

	/** Only the record of `pid`: a child started since under the same key has written its own. */
	private removeRecord(key: string, pid: number) {
		this.underLock(() => {
			const file = this.recordFile(key);
			let text;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch {
				return; // already gone
			}
			const rec = parsePageRecord(text);
			if (!rec || rec.pid === pid) fs.rmSync(file, { force: true });
		});
	}

	/** The child for a conversation, started if there is none; a start already under way is shared. */
	async open(how: OpenHow): Promise<PageChild> {
		if (how.sessionId !== undefined) {
			const id = sessionFileName(how.sessionId);
			// The conversation has its own file now: it opens as itself, not as the one pi started for it.
			if (how.sessionFile !== undefined && fs.existsSync(how.sessionFile)) this.moved.delete(id);
			const have = this.get(id);
			if (have) return have;
			const pending = this.starting.get(id);
			if (pending) return pending;
			const started = this.start(how);
			this.starting.set(id, started);
			started.then(
				() => this.starting.delete(id),
				() => this.starting.delete(id),
			);
			return started;
		}
		return this.start(how);
	}

	private async start(how: OpenHow): Promise<PageChild> {
		const orphan = how.sessionId === undefined ? undefined : this.reaping.get(how.sessionId);
		if (orphan) await orphan;
		const room = decideChildStops(this.views(), this.now(), { idleMs: this.idleMs, cap: PAGE_CAP, opening: how.sessionId ?? NO_ID_YET });
		await Promise.all(room.stop.map((id) => this.stop(id, "to make room")));
		if (room.full) throw new Error(`${PAGE_CAP} conversations are open in the page and none of them is idle; close one to open another`);

		const { command, args } = this.opts.command();
		// pi writes a conversation's file with its first answer, so a lease can name one that is not
		// there. `--session` on that path starts another conversation in it; without it, pi starts a
		// new one in the project, in a file of its own, and the pool follows it there (`moved`).
		const resumable = how.sessionFile !== undefined && fs.existsSync(how.sessionFile);
		if (how.sessionFile && !resumable) this.opts.log(`pi-loops page: ${how.sessionId ? shortSessionId(how.sessionId) : "a conversation"} has no file yet (${how.sessionFile}); pi starts a new conversation in ${how.cwd}`);
		const argv = [...args, "--mode", "rpc", ...(resumable ? ["--session", how.sessionFile as string] : []), ...how.piArgs];
		// A process group of its own (POSIX): a terminal's Ctrl-C goes to the whole foreground group,
		// and pi in rpc mode has no SIGINT handler, so it died before anyone could ask it to quit. pi
		// handles SIGTERM as `/quit`, which is the only signal this side sends it. Windows keeps the
		// arrangement it had: `detached` there is a new console window, not a new group.
		const pi = spawn(command, argv, { cwd: how.cwd, env: { ...this.opts.env, PI_LOOPS_PAGE_CHILD: "1" }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
		const child = await new Promise<PageChild>((resolve, reject) => {
			const failed = (err: Error) => {
				const line = `could not start pi: ${err.message}; set PI_BIN to pi's path, or PATH in the LaunchAgent that starts pi-loops`;
				this.opts.log(line);
				reject(new Error(line));
			};
			pi.once("error", failed);
			pi.once("spawn", () => {
				pi.off("error", failed);
				try {
					resolve(this.adopt(pi, how));
				} catch (err) {
					reject(err);
				}
			});
		});
		if (how.sessionId !== undefined && !resumable) this.startedFresh.set(child, sessionFileName(how.sessionId));
		this.naming.set(
			child,
			child
				.identify()
				.then(() => void this.follow(child))
				.catch((err: any) => this.opts.log(`pi-loops page: asking pi ${child.pid} which session it is in: ${err?.message ?? err}`)),
		);
		// What the page offers from the first load: the models, the thinking levels, the commands it
		// routes a slash on, and the snapshot pi-loops last wrote into this conversation.
		child
			.refreshCatalog()
			.then(() => child.primeRuntime())
			.catch((err: any) => this.opts.log(`pi-loops page: asking pi ${child.pid} what it offers: ${err?.message ?? err}`));
		return child;
	}

	/** A spawned pi, as a child of this pool: keyed, recorded, and dropped again when it exits. */
	private adopt(pi: ChildProcessByStdio<Writable, Readable, Readable>, how: OpenHow): PageChild {
		const child: PageChild = new PageChild(pi, {
			cwd: how.cwd,
			piArgs: how.piArgs,
			version: this.opts.version,
			log: this.opts.log,
			ring: () => this.opts.ring(child),
			onNote: this.opts.onNote ? (msg) => this.opts.onNote?.(child, msg) : undefined,
			onExit: (code, signal) => this.exited(child, code, signal),
		});
		const key = how.sessionId ?? `new-${child.pid}`;
		this.children.set(key, child);
		this.writeRecord(key, child);
		if (how.sessionId !== undefined) this.recordArgs(key, how.piArgs);
		return child;
	}

	private exited(child: PageChild, code: number | null, signal: NodeJS.Signals | null) {
		const key = this.keyOf(child);
		if (key !== undefined) {
			this.children.delete(key);
			this.removeRecord(key, child.pid);
			// The pi a conversation moved to is gone: the next open of it starts as it would have.
			for (const [from, to] of this.moved) if (to === key) this.moved.delete(from);
			if (!this.asked.has(child)) {
				const was = this.exits.get(key);
				this.exits.set(key, { at: [...(was?.at ?? []), this.now()].slice(-PAGE_CRASH_BUDGET.count * 2), stderr: child.recentStderr() });
			}
		}
		this.opts.onExit?.(child, code, signal);
	}

	/** The key a conversation's child is under: its own id, or the one its pi moved to (`moved`) while that pi runs. */
	private keyFor(sessionId: string): string {
		if (this.children.has(sessionId)) return sessionId;
		const to = this.moved.get(sessionId);
		return to !== undefined && this.children.has(to) ? to : sessionId;
	}

	get(sessionId: string): PageChild | undefined {
		return this.children.get(this.keyFor(sessionId));
	}

	has(sessionId: string): boolean {
		return this.children.has(this.keyFor(sessionId)) || this.starting.has(sessionId);
	}

	/** Forget where a conversation's pi moved to: it has a file of its own now (`moved`). */
	forgetMove(sessionId: string): void {
		this.moved.delete(sessionId);
	}

	list(): PageChild[] {
		return [...this.children.values()];
	}

	/**
	 * The key a child has once pi has answered its first `get_state` (at most 15 s): the session id, or
	 * `new-<pid>` still when pi named none; undefined when it exited first.
	 */
	async named(child: PageChild): Promise<string | undefined> {
		await this.naming.get(child);
		return this.keyOf(child);
	}

	/** The key the pool has this child under; undefined once it has exited. */
	keyOf(child: PageChild): string | undefined {
		for (const [key, c] of this.children) if (c === child) return key;
		return undefined;
	}

	/** A browser asked for this conversation: it is in use. On disk at most once a minute. */
	touch(sessionId: string) {
		const key = this.keyFor(sessionId);
		const child = this.children.get(key);
		if (!child) return;
		const now = this.now();
		child.lastClientAt = now;
		if (now - (this.written.get(child) ?? 0) >= 60_000) this.writeRecord(key, child);
	}

	/** Move a child to the conversation pi now says it is in. Refused when another child has that one. */
	rekey(from: string, to: string): boolean {
		const child = this.children.get(from);
		if (!child || from === to) return false;
		try {
			sessionFileName(to);
		} catch {
			this.opts.log(`pi-loops page: pi ${child.pid} says it is in session ${JSON.stringify(to)}, which is not a usable id; it stays at ${from}`);
			return false;
		}
		const other = this.children.get(to);
		if (other && other !== child) {
			this.opts.log(`pi-loops page: pi ${child.pid} moved to ${to}, which pi ${other.pid} already has open; it stays at ${from}`);
			return false;
		}
		this.children.delete(from);
		this.children.set(to, child);
		// Asked for a conversation that had no file, pi started a new one: keep the way to it. Any other
		// move (a /resume, a new session) leaves the old conversation to be opened as itself.
		if (this.startedFresh.get(child) === from) this.moved.set(from, to);
		this.startedFresh.delete(child);
		this.writeRecord(to, child);
		this.recordArgs(to, child.piArgs);
		this.removeRecord(from, child.pid);
		return true;
	}

	/**
	 * Re-key a child whose pi has said it is in a conversation other than its key — the first answer of
	 * a new one, or a switch pi made — and tell its pages where they are now. True when it moved.
	 */
	follow(child: PageChild): boolean {
		const from = this.keyOf(child);
		const to = child.sessionId;
		if (from === undefined || to === undefined || from === to || !this.rekey(from, to)) return false;
		child.broadcast({ type: "page_moved", sessionId: to });
		return true;
	}

	views(): ChildView[] {
		return [...this.children].map(([sessionId, c]) => ({
			sessionId,
			clients: c.clients.size,
			busy: c.busy,
			pendingAsks: c.live.pendingAsks.size,
			unsentPersonRows: this.opts.unsent?.(c) ?? 0,
			lastClientAt: c.lastClientAt,
		}));
	}

	/** Stop every child `decideChildStops` calls idle for too long; the sessions stopped. */
	async sweep(now = this.now()): Promise<string[]> {
		const { stop } = decideChildStops(this.views(), now, { idleMs: this.idleMs, cap: PAGE_CAP });
		await Promise.all(stop.map((id) => this.stop(id, "idle")));
		return stop;
	}

	/** SIGTERM, which pi handles as `/quit`; SIGKILL after 15 seconds. Its exit drops the record. */
	async stop(sessionId: string, why: string): Promise<void> {
		const child = this.children.get(this.keyFor(sessionId));
		if (!child) return;
		this.opts.log(`pi-loops page: stopping pi ${child.pid} of ${sessionId} (${why})`);
		await this.terminate(child, 15_000);
	}

	/** Every child at once, for shutdown: 8 seconds, then SIGKILL. */
	async stopAll(): Promise<void> {
		await Promise.all(this.list().map((child) => this.terminate(child, 8_000)));
	}

	private terminate(child: PageChild, graceMs: number): Promise<void> {
		this.asked.add(child);
		if (child.pi.exitCode !== null || child.pi.signalCode !== null) return Promise.resolve();
		return new Promise((resolve) => {
			const kill = setTimeout(
				guard(this.opts.log, "stop", () => {
					this.opts.log(`pi-loops page: pi ${child.pid} did not quit in ${graceMs / 1000}s; killing it`);
					child.pi.kill("SIGKILL");
				}),
				graceMs,
			);
			child.pi.once("exit", () => {
				clearTimeout(kill);
				resolve();
			});
			child.pi.kill("SIGTERM");
		});
	}

	/** Exit times nobody asked for, oldest first: what `decideOpen` counts. */
	crashes(sessionId: string): number[] {
		return [...(this.exits.get(sessionId)?.at ?? [])];
	}

	/** pi's last words before its last unasked exit, redacted and cut. */
	lastWords(sessionId: string): string {
		return this.exits.get(sessionId)?.stderr ?? "";
	}

	/** Start again: a person asked for it, so the count starts over. */
	clearCrashes(sessionId: string) {
		this.exits.delete(sessionId);
	}

	/** The reap that construction started; settled when every orphan found then is stopped. */
	reapOrphans(): Promise<void> {
		return this.reaped;
	}

	/**
	 * Records an earlier pi-loops left: its children are stopped, never adopted. A record whose pid is no
	 * longer that process is deleted; a live one gets SIGTERM, then SIGKILL after 15 seconds, each only
	 * while pid and start time still say it is that child.
	 */
	private reap(): Promise<void> {
		const dir = path.join(this.opts.dir, "pages");
		let names: string[];
		try {
			names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
		} catch {
			return Promise.resolve(); // no pages/ yet: nothing was ever left
		}
		const each = names.map((name) => {
			const file = path.join(dir, name);
			let rec: PageRecord | undefined;
			try {
				rec = parsePageRecord(fs.readFileSync(file, "utf8"));
			} catch {
				return Promise.resolve(); // removed while this looked
			}
			if (!rec) {
				this.opts.log(`pi-loops page: ${name} is not a page record; removed`);
				fs.rmSync(file, { force: true });
				return Promise.resolve();
			}
			const found = rec;
			const verdict = decideOrphan(found, this.self, this.probe);
			if (verdict === "ours") return Promise.resolve();
			const stopped = verdict === "gone" ? Promise.resolve() : this.stopOrphan(found);
			const done = stopped.then(() => {
				this.reaping.delete(found.sessionId);
				this.underLock(() => {
					const now = (() => {
						try {
							return parsePageRecord(fs.readFileSync(file, "utf8"));
						} catch {
							return undefined; // already gone
						}
					})();
					if (now?.pid === found.pid) fs.rmSync(file, { force: true });
				});
			});
			this.reaping.set(found.sessionId, done);
			return done;
		});
		return Promise.all(each).then(
			() => undefined,
			(err: any) => this.opts.log(`pi-loops page: stopping what an earlier pi-loops left: ${err?.message ?? err}`),
		);
	}

	private async stopOrphan(rec: PageRecord) {
		const still = () => decideOrphan(rec, this.self, this.probe) === "wait-then-stop";
		const signal = (sig: NodeJS.Signals) => {
			try {
				process.kill(rec.pid, sig);
			} catch (err: any) {
				if (err?.code !== "ESRCH") this.opts.log(`pi-loops page: ${sig} to pi ${rec.pid}: ${err?.message ?? err}`);
			}
		};
		this.opts.log(`pi-loops page: stopping pi ${rec.pid} of ${rec.sessionId}, left running by an earlier pi-loops`);
		signal("SIGTERM");
		for (const deadline = Date.now() + 15_000; still() && Date.now() < deadline; ) await sleep(100);
		if (still()) signal("SIGKILL");
	}
}
