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
import { procStart } from "./lease.ts";
import { realpathish } from "./paths.ts";

/* ------------------------------------------------------------------ pi, in rpc mode */

export interface PageChildOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	version: string;
	log: (line: string) => void;
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	/** pi could not be started at all: no `exit` follows. */
	onError: (err: Error) => void;
	/** Every event pi prints that is not the answer to a command, before it is folded and broadcast. */
	onNote?: (msg: any) => void;
	ring: () => Promise<unknown>;
}

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
/**
 * How old the command list may be when a chat message is routed on it. `/reload` in the page changes
 * what is loaded, so the list is asked for again after every slash command as well; the age is the
 * floor under that, for a change this process did not see happen.
 */
export const COMMANDS_TTL_MS = 30_000;

const SESSION_HEAD = 64 * 1024;

/** The header, a name if one was set early, and the first thing a person said. */
export function readHead(file: string) {
	let text;
	let readBytes = 0;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(SESSION_HEAD);
			// `SESSION_HEAD` is a byte window, so the decision to cut is the byte count read, not the
			// decoded string's length: a multi-byte character makes those differ.
			readBytes = fs.readSync(fd, buf, 0, SESSION_HEAD, 0);
			text = buf.toString("utf8", 0, readBytes);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	const lines = text.split("\n");
	let header;
	try {
		header = JSON.parse(lines[0] ?? "");
	} catch {
		return undefined;
	}
	if (header?.type !== "session" || typeof header.id !== "string") return undefined;
	const cut = readBytes >= SESSION_HEAD;
	let name;
	let first;
	let messages = 0;
	// The last line of a partial read is half a line. A file that fitted has no such line, and
	// dropping one there loses a message from a count that could have been exact.
	for (const line of lines.slice(1, cut ? -1 : undefined)) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		// Written by whatever set it — a person, a model, an extension — so it is bounded here the
		// way the first message is, rather than carrying 64KB into the picker.
		if (entry?.type === "session_info" && typeof entry.name === "string") name = entry.name.slice(0, 200);
		if (entry?.type !== "message") continue;
		messages++;
		if (first || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const said = typeof content === "string" ? content : (content ?? []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ");
		// A mention is expanded before it is sent, so the first user message can be a whole file.
		if (said.trim()) first = said.trim().slice(0, 200);
	}
	return { id: header.id, startedAt: header.timestamp, name, first, messages, truncated: cut };
}

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
	readonly pid: number | undefined;
	readonly procStart: string | undefined;
	readonly cwd: string;
	readonly log: (line: string) => void;
	readonly startedAt = Date.now();
	lastClientAt = Date.now();
	/** Set on `agent_start`, cleared on `agent_end`. */
	busy = false;
	alive = true;
	private readonly opts: PageChildOptions;

	stderrTail = "";
	/** Characters the keep cut has already thrown away, so the send cut can count everything dropped. */
	stderrDropped = 0;

	private nextId = 1;
	private readonly pending = new Map<string, (msg: any) => void>();

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

	constructor(pi: ChildProcessByStdio<Writable, Readable, Readable>, opts: PageChildOptions) {
		this.pi = pi;
		this.opts = opts;
		this.pid = pi.pid;
		this.procStart = pi.pid === undefined ? undefined : procStart(pi.pid);
		this.cwd = opts.cwd;
		this.sessionCwd = opts.cwd;
		this.log = opts.log;

		pi.on("error", (err) => {
			this.log(`could not start pi: ${err.message}`);
			this.opts.onError(err);
		});
		pi.on("exit", (code, signal) => {
			this.alive = false;
			// The page has to be told *why*. pi's own reasons for refusing to start — a duplicate extension,
			// a provider that will not authenticate — are on its stderr, and a browser tab that just says
			// "pi exited" sends you to the terminal to find out what a terminal already knew.
			this.broadcast({ type: "pi_exit", code, signal, stderr: this.recentStderr() });
			this.opts.onExit(code, signal);
		});

		pi.stderr.on("data", (d) => {
			process.stderr.write(d);
			// Characters, not code units: a cut on the code-unit half of an astral character leaves a lone
			// surrogate in the tail, which `textContent` draws as a replacement glyph.
			const all = Array.from(this.stderrTail + d.toString("utf8"));
			this.stderrDropped += Math.max(0, all.length - STDERR_KEEP);
			this.stderrTail = all.slice(-STDERR_KEEP).join("");
		});

		pi.stdin.on("error", (err: any) => {
			this.alive = false;
			this.log(`pi-loops web: pi's input closed: ${err?.message ?? err}`);
		});

		// Strict JSONL: split on \n only. Node's readline also splits on U+2028/U+2029, which are legal
		// inside JSON strings — the rpc protocol calls this out, and one tool result containing either
		// would desync the stream for the rest of the session.
		let buf = "";
		pi.stdout.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl).replace(/\r$/, "");
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue; // never desync the whole session over one unparseable line
				}
				if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
					this.pending.get(msg.id)?.(msg);
					this.pending.delete(msg.id);
					continue; // a command's own answer belongs to its caller, not to the feed
				}
				this.opts.onNote?.(msg);
				this.observe(msg);
				this.broadcast(msg);
			}
		});
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

	/** Send one RPC command and wait for the response that carries its id. */
	rpc(command: object, timeoutMs = 60_000): Promise<any> {
		if (!this.alive) return Promise.resolve({ success: false, error: "pi is not running" });
		const id = `web-${this.nextId++}`;
		if (!this.writeToPi(`${JSON.stringify({ ...command, id })}\n`)) return Promise.resolve({ success: false, error: "pi is not running" });
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				// A command that never answers must not hold a browser request open for ever.
				if (this.pending.delete(id)) resolve({ success: false, error: `timed out after ${timeoutMs}ms` });
			}, timeoutMs);
			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
		});
	}

	/** Fold the events that carry state a late-joining browser still needs. */
	observe(ev: any) {
		if (ev.type === "agent_start") this.busy = true;
		if (ev.type === "agent_end") this.busy = false;
		if (ev.type === "queue_update") this.live.queue = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
		// pi refused a `sendUserMessage` (compaction in progress, no credentials). The holder finds the
		// row it handed over and never saw start once the grace has passed; ring it then, so the row
		// comes back to the composer without waiting for the tick.
		if (ev.type === "extension_error" && ev.event === "send_user_message") setTimeout(() => void this.opts.ring().catch((err: any) => this.log(`pi-loops web: ring: ${err?.message ?? err}`)), PERSON_SEND_GRACE_MS + 500).unref();
		if (ev.type === "extension_ui_request") {
			if (isDialog(ev)) {
				// pi answers a dialog with a timeout itself when it elapses and tells nobody; past that an
				// answer goes nowhere, so the dialog is not offered again, and one replayed carries what is left.
				const timed = typeof ev.timeout === "number" && ev.timeout > 0;
				const held = timed ? { ...ev, expiresAt: Date.now() + ev.timeout } : ev;
				this.live.pendingAsks.set(ev.id, held);
				if (timed) setTimeout(() => this.live.pendingAsks.get(ev.id) === held && this.live.pendingAsks.delete(ev.id), ev.timeout).unref();
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
		const entries = await this.rpc({ type: "get_entries" }, 20_000);
		if (entries?.success) {
			for (const e of entries.data?.entries ?? []) {
				if (e?.type === "custom" && e.customType === "pi_loops_snapshot") this.live.runtime = e.data;
				if (e?.type === "custom" && e.customType === "goal_state") this.live.goal = e.data;
			}
		}
		if (this.catalog.commandList.some((c) => c.name === "cron")) await this.rpc({ type: "prompt", message: "/cron snapshot" }, 20_000);
	}

	async snapshot(extra: SnapshotExtra) {
		const state = await this.rpc({ type: "get_state" }, 15_000);
		const s = state?.success ? state.data : {};
		const cwd = s.cwd || this.cwd;
		this.sessionCwd = cwd;
		if (typeof s.sessionId === "string") this.sessionId = s.sessionId;
		if (typeof s.sessionFile === "string" && s.sessionFile && s.sessionFile !== this.sessionFile) {
			const switched = this.sessionFile !== undefined && realpathish(s.sessionFile) !== realpathish(this.sessionFile);
			this.sessionFile = s.sessionFile;
			if (switched) {
				this.startedOver(s.sessionFile);
				Promise.all([this.refreshCatalog(), this.primeRuntime()]).catch((err) => this.log(`pi-loops web: after a session switch: ${err?.message ?? err}`));
			}
		}
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
			const head = readHead(entry.file);
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
	async swapSession(file: string | undefined, { restoreModel = false } = {}) {
		if (!this.alive) return { success: false, error: "pi is not running" };
		if (!file) return { success: false, error: "this session has no file on disk (pi was started with --no-session)" };
		const before = await this.rpc({ type: "get_state" }, 15_000);
		if (!before?.success) return { success: false, error: before?.error ?? "pi did not answer" };
		if (before.data?.isStreaming || before.data?.isCompacting) return { success: false, error: "a turn is running — stop it first" };
		const current = before.data?.sessionFile;
		if (current && realpathish(file) === realpathish(current)) return { success: false, error: "this is the session you are already in" };
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
		const r = await this.rpc({ type: "get_entries" }, 30_000);
		this.entriesCache = { at: Date.now(), value: r };
		return r;
	}
}

/**
 * pi, in a process group of its own.
 *
 * pi in rpc mode installs handlers for SIGTERM and SIGHUP, and on either of those it shuts the
 * session down properly — which is where pi-loops gives this conversation's lease back at once,
 * stops its MCP servers and drains its hooks. It installs none for SIGINT. A terminal's Ctrl-C goes
 * to the whole foreground process group, so a pi sharing this one died of that SIGINT before `leave`
 * below could ask it to quit, and none of that happened. `detached` puts pi outside the group the
 * terminal signals, so the only signal it gets is the SIGTERM we send it.
 *
 * POSIX only: on Windows `detached` means a new console window rather than a new process group,
 * which is a visible regression for no gain — Ctrl-C there arrives as a console control event,
 * not as a group signal — so that platform keeps the arrangement it had.
 *
 * Nothing else changes: the stdio pipes are what this process talks to pi through, and they are
 * unaffected by which group it is in. If this process dies without running `leave` — SIGKILL, a
 * crash — pi's stdin closes with it, and pi treats that end-of-input as a quit.
 */
export function spawnPageChild(opts: PageChildOptions): PageChild {
	const pi = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
	return new PageChild(pi, opts);
}
