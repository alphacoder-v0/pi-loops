/**
 * The HTTP server in front of the browser page: the token, the Host and cross-site checks, pairing,
 * and every route. What belongs to the conversation itself (pi's process, its events, its catalog,
 * its session file) is the `PageChild` of src/page-children.ts that `child()` returns.
 *
 * The automation panel reads pi-loops' own files (jobs.json, triggers.json, inbox.jsonl) rather
 * than scraping command output: they are on this machine, they are JSON, and text meant for a
 * human is a bad wire format.
 */
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ConversationIndex, holderOf, NeedsYouCounts, plainText, projectArgs, type RowReaders } from "./conversation-rows.ts";
import { cancelRow, personRow, queueOrder, requestFingerprint } from "./engine.ts";
import { COPY_KEY_MS, type HostSnapshot, type PageOpened, type PageOpenRequest, requestLines } from "./host-control-channel.ts";
import { DELIVERY_JOB_ID, holderAlive, holderDelivers, type LeaseHolder, LeaseStore, type SessionLease, sessionFileName } from "./lease.ts";
import { conversationLabel } from "./session-head.ts";
import { pidAlive } from "./lock.ts";
import {
	type ChildPool,
	type ChildView,
	COMMANDS_TTL_MS,
	DELIVERY_LABEL,
	decideOpen,
	guard,
	isDialog,
	maskSecrets,
	NO_PI_LOOPS,
	PAGE_CRASH_BUDGET,
	PAGE_STREAMS_PER_CHILD,
	PAGE_STREAMS_TOTAL,
	type PageChild,
	readHead,
} from "./page-children.ts";
import { removeOpenFile, sweepOpenFiles, writeOpenFile } from "./open-file.ts";
import { DEVICE_COOKIE, DEVICE_STORAGE_KEY, DeviceStore, KEY_KINDS, type KeyKind, UrlKeys } from "./page-devices.ts";
import { realpathish } from "./paths.ts";
import { RequestStore } from "./requests.ts";
import type { SinceYouLooked } from "./seen.ts";
import { TriggerStore } from "./triggers.ts";
import { writeUiPref } from "./ui-prefs.ts";
import { DOOR, ICON, PAGE } from "./web.mjs";
import { producerAlive } from "./window-executor.ts";

export interface PageServerOptions {
	dir: string;
	bind: { host: string; port: number };
	allowHosts: string[];
	token: string;
	version: string;
	pool: ChildPool;
	/** How a session id from HTTP is checked, and how its pi is started: the lease store's `read`. */
	sessions: { known: (sessionId: string) => Partial<Pick<SessionLease, "sessionFile" | "cwd" | "holder">> | undefined };
	/** The turn pi-loops is running in this conversation, if any: opening it waits for that turn. */
	heldTurn?: (sessionId: string) => { runId: string; label: string } | undefined;
	/** Stop it, on the waiting page. */
	abortRun?: (runId: string) => boolean;
	/**
	 * pi's sessions directory, which the conversation list reads (src/conversation-rows.ts). Without it
	 * the list reads only the directories of the session files leases name, so a server built in a
	 * test never reads the person's own.
	 */
	sessionsRoot?: string;
	/** The conversation `GET /` opens. */
	lastPage?: () => string | undefined;
	rememberPage?: (sessionId: string) => void;
	/** What pi-loops in the background is doing: the Background view. Without it there is none. */
	background?: () => HostStatus;
	log: (line: string) => void;
	onListenError: (err: NodeJS.ErrnoException) => void;
}

export interface PageServer {
	url(): string;
	port(): number;
	newPairCode(): string;
	/** A one-shot key, good for one load within a minute (or `ttlMs`), that opens this conversation's page. */
	openKeyFor(sessionId: string, ttlMs?: number): string;
	/**
	 * The same key, kept in a file only this user can read that sends a browser to the keyed page:
	 * what `pi-loops` opens, so the key is in no command line. The file goes with the key.
	 */
	openFileFor(sessionId: string): { openKey: string; openFile: string };
	/** Event streams open across every child. */
	clients(): number;
	close(): void;
}

/**
 * The token is kept in a file rather than made fresh each launch, so the address stays the same
 * one every time: bookmark http://127.0.0.1:4173/ and it works tomorrow. It is a boring secret —
 * 0600 in the loops directory, next to the jobs it lets you run — and it exists because anything
 * that reaches /rpc gets the whole session, including any *website* you happen to have open (a
 * page cannot read this server's answers, but without a check it could still tell your agent what
 * to do). You will not have to type it: a browser is remembered after its first visit.
 */
export function webToken(dir: string, fail: (message: string) => never): string {
	const file = path.join(dir, "web-token");
	try {
		// lstat, not stat: a symlink here is not a token file, it is someone else choosing where
		// this process reads and writes. LOOPS_DIR can be pointed anywhere with --loops-dir.
		const st = fs.lstatSync(file);
		if (!st.isFile()) throw new Error(`${file} is not a regular file`);
		if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${file} belongs to another user`);
		// The mode is only applied when the file is created, so a backup restored at 0644 would
		// otherwise stay that way for ever, readable by every account on the machine.
		if (st.mode & 0o077) fs.chmodSync(file, 0o600);
		const found = fs.readFileSync(file, "utf8").trim();
		if (/^[A-Za-z0-9_-]{8,}$/.test(found)) return found;
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			// Anything other than "not there yet" is a thing to say out loud rather than paper over
			// by writing a new token: it means the path is not what this expects it to be.
			fail(`pi-loops web: ${err?.message ?? err}`);
		}
	}
	const made = randomBytes(16).toString("hex");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, `${made}\n`, { mode: 0o600, flag: "w" });
	fs.chmodSync(file, 0o600);
	return made;
}

/* ------------------------------------------------------------------ pi-loops, read from disk */

export function readJson(file: string, fallback: any) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

/**
 * Is `child` inside `ancestor`? A `startsWith` on the resolved path is not this test: with ancestor
 * `/home/u/proj`, `/home/u/proj-secrets/.env` passes it. Symlinks are resolved first — `realpathish`
 * resolves as much of each path as exists, so a file that is not there yet still answers — which
 * means a link planted in the project cannot point out of it either.
 */
function isUnder(child: string, ancestor: string) {
	const realRoot = realpathish(ancestor);
	const realPath = realpathish(child);
	const rel = path.relative(realRoot, realPath);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A root so broad that containment would mean "everything": never treated as one project. */
function tooBroad(dir: string) {
	return dir === "/" || dir === os.homedir() || path.dirname(dir) === dir;
}

/** Containment, but with the project rule on top of it: `$HOME` contains everything and is nobody's. */
function isUnderProject(child: string, project: string) {
	if (!child || !project) return false;
	const realRoot = realpathish(project);
	const realPath = realpathish(child);
	if (realRoot === realPath) return true;
	if (tooBroad(realRoot)) return false;
	const rel = path.relative(realRoot, realPath);
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * pi-loops' own rule, answered the same way the extension answers it: a job belongs to this project
 * if its cwd is the session's, or under it, or the session's is under the job's.
 *
 * It was a string prefix here and `withinProject` there (src/presence.ts), and the two disagreed in
 * both directions: a project reached through a symlink — a worktree, a home on another volume, a
 * `~/code` that points at a mounted disk — was the same project to `/cron` and a different one to
 * this panel, so the job was listed in the terminal and missing from the page. And a job whose cwd
 * is `$HOME` was shown here under every project, while the terminal counts it as its own.
 *
 * A panel that disagrees with the command is worse than either: what it costs to be wrong is
 * somebody concluding their job is gone.
 */
function sameProject(jobCwd: string, sessionCwd: string) {
	if (!jobCwd || !sessionCwd) return false;
	return isUnderProject(jobCwd, sessionCwd) || isUnderProject(sessionCwd, jobCwd);
}

function formatSchedule(s: any) {
	if (!s || typeof s !== "object") return "?";
	if (s.kind === "cron") return s.expr;
	if (s.kind === "once") return `once at ${new Date(s.at).toLocaleString()}`;
	if (s.kind === "every") {
		const m = Math.round(s.ms / 60_000);
		if (m < 60) return `every ${m}m`;
		return m % 60 === 0 ? `every ${m / 60}h` : `every ${Math.floor(m / 60)}h${m % 60}m`;
	}
	return "?";
}

/** An ISO time, but only if it is still ahead of us. */
function futureOnly(iso: any) {
	const at = Date.parse(iso ?? "");
	return Number.isFinite(at) && at > Date.now() ? iso : undefined;
}

/* ------------------------------------------------------------------ what a prompt needs first */

/**
 * The commands the page runs itself, rather than sending to the model as text.
 *
 * These are the ones you reach for between turns rather than during them — the context is full, or
 * the job is finished and the next one should not inherit it. Typing the command is the way that
 * habit is expressed, so they are completed like any other command and answered by the page; the
 * buttons in the header are the same three actions for anyone who did not grow the habit.
 */
const PAGE_COMMANDS = [
	{ name: "clear", description: "start a new session — this one stays on disk, /resume brings it back" },
	{ name: "new", description: "start a new session — this one stays on disk, /resume brings it back" },
	{ name: "resume", description: "go back to an earlier session in this project" },
	{ name: "sessions", description: "list this project's sessions: id, when, what was first said" },
	{ name: "session", description: "export [path] | import <path> — the .pisession archive commands" },
	{ name: "compact", description: "compact the context; anything after it steers the summary" },
];

/** Commands this front end answers some other way, so typing one is not sent to the model as text. */
const UI_COMMANDS: Record<string, string> = {
	model: "use the model picker in the header",
	thinking: "use the thinking picker in the header",
	abort: "use the stop button",
	cost: "shown in the header, next to the buttons",
	find: "use the find button",
	history: "press ↑ in the composer",
	undo: "use the undo button",
	save: "use the save button",
	export: "use the save button",
	"session-share": "use the share button",
	quit: "close the tab; pi keeps running until you stop this process",
	login: "log in once from a terminal (`pi`), then restart this front end — oauth has no rpc command",
};

/**
 * pi's *built-in* slash commands do not exist in rpc mode — `get_commands` returns only extension
 * commands and skills, and anything else is delivered to the model as literal text. Sending
 * `/help` and getting a paragraph of prose back is worse than being told it is not here.
 */
function commandRefusal(text: string, child: PageChild) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	// Lowercased, as the page lowercases it before deciding which commands it runs itself. Without
	// this a stale tab sending `/CLEAR` was told it is not a command at all, rather than told to
	// reload — the one thing that would have fixed it.
	const name = trimmed.slice(1).split(/\s/)[0].toLowerCase();
	if (!name) return undefined;
	if (child.catalog.commandList.some((c) => c.name.toLowerCase() === name)) return undefined;
	// A page old enough not to know these sends them here. Say which half is out of date, rather
	// than "not a command" about something this server does implement.
	if (PAGE_COMMANDS.some((c) => c.name === name)) {
		return { success: false, error: `/${name} is run by the page — reload this tab to get the version that does it` };
	}
	const hint = UI_COMMANDS[name];
	return {
		success: false,
		error: hint ? `/${name} — ${hint}` : `/${name} is not a command in this session (pi's terminal commands are not available over rpc)`,
	};
}

/**
 * Expand `@path` the way the terminal does before submitting. In rpc mode nothing expands it —
 * verified: the mention arrives at the model as the literal five characters — so the front end
 * that offers the completion has to be the one that honours it.
 */
function expandMentions(text: string, cwd: string) {
	const seen = new Set();
	const blocks = [];
	for (const m of text.matchAll(/(^|\s)@([^\s]+)/g)) {
		const rel = m[2].replace(/[.,;:)\]]+$/, "");
		if (seen.has(rel)) continue;
		seen.add(rel);
		const file = path.resolve(cwd, rel);
		// A mention must not read outside the project, and a huge file is a mistake, not a mention.
		if (!isUnder(file, cwd)) continue;
		let stat;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		if (!stat.isFile() || stat.size > 256 * 1024) continue;
		let content;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (content.includes("\u0000")) continue; // binary: the path alone is more use than bytes
		blocks.push(`\n\n<file path="${rel}">\n${content}\n</file>`);
	}
	return text + blocks.join("");
}

/* ------------------------------------------------------------------ requests: what is queued for this session */

/**
 * A person row is signed by the child it is rung to, not by this process: a row is sent only while
 * its producer lives (docs/design.md decision 23), and this process outlives every child. Signed by
 * the child, a row whose pi died unsent is offered by the next page instead of run by it.
 */
const createdBy = (child: PageChild, version: string) => ({ pid: child.pid, instance: child.instance, procStart: child.procStart, version });
const mine = (row: any, child: PageChild) => row.created_by.pid === child.pid && row.created_by.instance === child.instance;

/** The person rows `child` signed that no holder has taken yet: while there are any, it is not idle. */
export function unsentPersonRows(requests: RequestStore, child: PageChild): number {
	if (!child.sessionId) return 0;
	try {
		return requests.list(child.sessionId).filter((row) => row.kind === "input" && row.source === "person" && row.handed_at === undefined && mine(row, child)).length;
	} catch {
		return 0; // an id the store refuses has no rows
	}
}
/** A row id as the page sends one back: the page's UUID, or a pi-loops id. Checked before it reaches a file. */
const ROW_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TEXT_PREVIEW = 200;

/**
 * The doorbell: `/pi-loops ring` typed into the pi behind this page, which drains the session's
 * requests at once. With a row's id and fingerprint, the extension first records that row as this
 * page's, which is how a chat message runs as the person's own turn and not capped: this stdin is a
 * channel no model tool can write to. pi answers once the command has run.
 */
export function ring(child: PageChild, id?: string, fingerprint?: string): Promise<any> {
	// With no extension to answer it, the bell would be a prompt for the model.
	if (child.catalog.piLoopsLoaded === false) return Promise.resolve({ success: false, error: NO_PI_LOOPS });
	const message = id === undefined ? "/pi-loops ring" : `/pi-loops ring ${id} ${fingerprint}`;
	return child.rpc({ type: "prompt", message }, 15_000).then((r) => {
		if (!r?.success) child.log(`pi-loops web: ring: ${r?.error ?? "no answer"}`);
		return r;
	});
}

/** The source of a row as the queue names it: "you", "cron nightly", "rule 3f2a…". */
function labelOf(row: any, jobNames: Map<any, any>) {
	const [kind, ...rest] = row.source.split(":");
	const arg = rest.join(":");
	if (row.source === "person") return "you";
	if (kind === "cron" || kind === "cron-run") return `cron ${jobNames.get(arg) ?? arg}`;
	if (kind === "rule" || kind === "inbox") return `${kind} ${arg.slice(0, 8)}`;
	if (kind === "push" || kind === "recipe") return `${kind} ${arg}`;
	return row.source;
}

/**
 * How long a message of this page may wait untaken, with pi idle, before the page says so and offers
 * to send it over rpc instead. Past the ten-second grace a refused hand-over is judged by, plus the
 * follow-up ring's half second, so a send pi refused comes back as "not sent" first and never as
 * both; short of the thirty-second tick a viewer retries its lease on, so a dead chat is not looked
 * at for half a minute.
 */
const UNTAKEN_MS = 15_000;

/** How often a page's pi that stands aside tries to read its conversation again (`catchUp`). */
const CATCH_UP_EVERY_MS = 30_000;

/**
 * What the queue row of a message of this page says once it has waited `UNTAKEN_MS` with this page's
 * pi idle and nobody has handed it over; undefined otherwise. `line` is the whole label, `button`
 * the offer to send it over rpc instead, when there is one: none when this page's own pi stands
 * aside, since anything written then branches the conversation off an old entry, and /resume is the
 * way out. A holder that delivers may be in a turn this page cannot see, so it is not called "not
 * answering"; answering here forks the conversation under it, which the button says, so a terminal
 * suspended with Ctrl-Z still leaves a way out, chosen knowingly.
 */
function untaken(row: any, holder: any, now: number, idle: boolean, child: PageChild) {
	if (row.source !== "person" || !mine(row, child) || row.handed_at !== undefined || !idle) return undefined;
	if (now - Date.parse(row.created_at) < UNTAKEN_MS) return undefined;
	const pid = holder?.pid ?? child.pid;
	const notTaken = (why: string) => `not taken by pi ${pid} (${why})`;
	const sendHere = "send it here instead";
	if (!holder) return { pid, line: notTaken("nobody holds this conversation"), button: sendHere };
	if (holder.mine && holder.aside) return { pid, line: notTaken("this page's pi shows an older copy of this conversation and reads it again once it is idle") };
	if (holder.aside) return { pid, line: notTaken("shows an older copy of this conversation"), button: sendHere };
	if (!holder.delivers) return { pid, line: notTaken("a non-interactive pi"), button: sendHere };
	if (holder.mine) return { pid, line: notTaken("this page's pi did not take it"), button: sendHere };
	return { pid, line: `pi ${pid} holds this conversation and has not taken it yet (it may be busy)`, button: `answer here instead (a branch pi ${pid} will not see)` };
}

/* ------------------------------------------------------------------ http */

/** What `checkRequest` judges, read off one request by `requestFacts`. */
export interface RequestFacts {
	method: string;
	path: string;
	host?: string;
	origin?: string;
	secFetchSite?: string;
	secFetchMode?: string;
	secFetchDest?: string;
	/** The socket's peer address, for the tailnet rule. */
	remote?: string;
	queryToken?: string;
	headerToken?: string;
	/** The value of the `pi_web_device` cookie, not the whole Cookie header. It is never a credential here. */
	device?: string;
	/** Whether the browser still sends 0.22.8's `pi_web_token` cookie, which holds the live token. */
	legacyCookie?: boolean;
}

export interface CheckOptions {
	token: string;
	/** Names you put in front of this yourself: a reverse proxy, a hostname on your own network. */
	allowHosts: readonly string[];
	/** Bound to loopback, so a bare IP in Host is not a name anyone was meant to use. */
	loopback: boolean;
}

export type Verdict = { ok: true; via: "query" | "header" } | { status: 401 | 403; why: string };

/** A Host that is an address rather than a name: nothing to re-resolve, so nothing to rebind. */
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\])$/;
/**
 * Where the connection actually came from, for the tailnet case. `tailscale serve` proxies to
 * loopback, so a genuine one arrives on a local socket; a direct connection to the tailnet address
 * arrives from 100.64/10, which is the range Tailscale hands out. A `.ts.net` Host from anywhere
 * else is a name pointed at this machine by someone, which is the thing the check is for.
 */
function fromTailnet(remote: string | undefined) {
	const from = String(remote ?? "").replace(/^::ffff:/, "");
	if (from === "127.0.0.1" || from === "::1") return true;
	const octets = from.split(".").map(Number);
	return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * Whether this request may be answered at all, judged by the name it arrived under.
 *
 * Without a Host check, a page on any site could point a hostname of its own at 127.0.0.1 and talk
 * to this server from the browser; the token is what actually stops that, and this is the second
 * lock. It is *not* "only this machine": loopback always passes, and so do a bare address on the
 * network this was deliberately bound to, a `.ts.net` name arriving from a tailnet, and every name
 * given to `--allow-host` — which is a promise the person who started this made about what sits in
 * front of it, not a resolution anything here could check.
 */
function hostAllowed(req: RequestFacts, opts: CheckOptions) {
	const host = String(req.host ?? "").replace(/:\d+$/, "");
	if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return true;
	// Bound to the network on purpose: the phone reaches this by IP, so a bare IP address has to be
	// allowed. An address cannot be rebound — there is no name to re-resolve — which is the whole
	// reason the rule is shaped this way.
	if (!opts.loopback && IP_LITERAL.test(host)) return true;
	// Tailscale's MagicDNS names. `tailscale serve` is the good way to reach this from a phone: it
	// terminates TLS on the tailnet and proxies to loopback here, so the request arrives looking
	// local but carrying the tailnet name as its Host. That zone belongs to Tailscale and its names
	// resolve to tailnet devices, so it is not a name an attacker can point at this machine.
	if (host.endsWith(".ts.net") && fromTailnet(req.remote)) return true;
	return opts.allowHosts.some((h) => h.trim() !== "" && h.trim().toLowerCase() === host.toLowerCase());
}

/** The host an Origin names, or undefined for one that is not a URL. */
function originHost(origin: string) {
	try {
		return new URL(origin).host;
	} catch {
		return undefined; // an Origin that is not a URL is not one this server put there
	}
}

/**
 * The browser says who started the request, and it is not something a page can lie about. Absent
 * from curl and from older browsers, so its absence cannot be treated as a failure.
 */
function crossSite(req: RequestFacts) {
	// Asked before Origin. The waiting page sends `referrer-policy: no-referrer`, so Chrome sends its
	// Stop it post with Origin "null"; the same request says same-origin here. A sandboxed preview is
	// an opaque origin, which a browser never calls same-origin, so this does not let it back in.
	if (req.secFetchSite === "same-origin") return false;
	// "same-site" is not the same as "same origin": a cookie's SameSite is scoped to the site, and a
	// site ignores the port — http://localhost:5173, which is any Vite dev server on this machine,
	// is the same site as this one and its pages are handed our cookies. Those are the pages most
	// likely to exist and to be attacked, so same-site is a no, not a yes.
	if (req.secFetchSite === "cross-site" || req.secFetchSite === "same-site") return true;
	// A browser that does not send that header still sends Origin on anything that could do harm.
	// "null" is what an opaque origin sends — a sandboxed document, which is exactly what the file
	// previews are served as. Treating it as same-site would let one of them back in on a browser
	// that sends no Sec-Fetch-Site.
	if (req.origin === "null") return true;
	if (req.origin === undefined) return false;
	return originHost(req.origin) !== req.host;
}

/** The Host and cross-site locks alone: what the door, the manifest and the icon answer to. */
/**
 * Whether a request is the browser opening this address as its page: a link followed or an address
 * typed, not a frame, a fetch or an image. The launch file is a `file:` page, which a browser calls
 * another site, so its hand-off arrives as a cross-site navigation. Only the open key may come in
 * that way: it is 16 random bytes that no other site can know, and a frame on another site is
 * `iframe`, not `document`. The six-digit code is guessable and stays behind the cross-site lock.
 */
export function topLevelNavigation(req: RequestFacts): boolean {
	return req.method === "GET" && req.secFetchMode === "navigate" && req.secFetchDest === "document";
}

function placeRefused(req: RequestFacts, opts: CheckOptions): { status: 403; why: string } | undefined {
	if (!hostAllowed(req, opts)) return { status: 403, why: "forbidden host" };
	if (crossSite(req)) return { status: 403, why: "cross-site request refused" };
	return undefined;
}

/**
 * Constant-time compare, so a token cannot be found a byte at a time. Lengths are compared as bytes:
 * `timingSafeEqual` throws on buffers of different byte lengths, and a token of the right number of
 * characters with one non-ASCII character in it reached that throw before any check passed.
 */
function sameToken(given: string | undefined, token: string) {
	if (given === undefined) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a request may reach a route, and if not, the status and the reason.
 *
 * Host and cross-site first, then the token: none at all is 401, a wrong one 403. It arrives in the
 * `x-pi-web-token` header, which no other site can set without a preflight this server never
 * answers, or on a GET in `?token=`. A POST never takes it from its URL, where a proxy log or a
 * Referer would keep it. No cookie is a credential: a cookie goes to every port on this host.
 */
export function checkRequest(req: RequestFacts, opts: CheckOptions): Verdict {
	const refused = placeRefused(req, opts);
	if (refused) return refused;
	if (req.method === "POST" && req.queryToken !== undefined) return { status: 403, why: "token in the query string is refused on POST" };
	if (req.queryToken === undefined && req.headerToken === undefined) return { status: 401, why: "no token" };
	const via = sameToken(req.queryToken, opts.token) ? "query" : sameToken(req.headerToken, opts.token) ? "header" : undefined;
	if (!via) return { status: 403, why: "bad token" };
	return { ok: true, via };
}

/** The cookie 0.22.8 kept the token in, and the header that makes a browser forget it (it was host-only, `Path=/`). */
const LEGACY_TOKEN_COOKIE = "pi_web_token";
const LEGACY_TOKEN_CLEAR = `${LEGACY_TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;

/**
 * The one place a request's headers are read for `checkRequest`. The device cookie is the one a
 * browser was given on its first visit (src/page-devices.ts); `SameSite=Strict` keeps a browser from
 * attaching it to anything another site initiated, and it opens nothing by itself in any case.
 */
function requestFacts(req: http.IncomingMessage, url: URL): RequestFacts {
	const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
	let device: string | undefined;
	let legacyCookie = false;
	for (const part of String(req.headers.cookie ?? "").split(";")) {
		const cut = part.indexOf("=");
		const name = cut > 0 ? part.slice(0, cut).trim() : "";
		if (name === DEVICE_COOKIE && device === undefined) device = part.slice(cut + 1).trim();
		if (name === LEGACY_TOKEN_COOKIE) legacyCookie = true;
	}
	return {
		method: req.method ?? "GET",
		path: url.pathname,
		host: one(req.headers.host),
		origin: one(req.headers.origin),
		secFetchSite: one(req.headers["sec-fetch-site"]),
		secFetchMode: one(req.headers["sec-fetch-mode"]),
		secFetchDest: one(req.headers["sec-fetch-dest"]),
		remote: req.socket?.remoteAddress,
		queryToken: url.searchParams.get("token") ?? undefined,
		headerToken: one(req.headers["x-pi-web-token"]),
		device,
		legacyCookie,
	};
}

const PAIR_MAX_TRIES = 20;
/** Long enough to find your phone and point it at the screen; not long enough to forget about. */
const PAIR_TTL_MS = 10 * 60 * 1000;

async function body(req: http.IncomingMessage): Promise<any> {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		// Images arrive here as base64, so the cap is generous — but it is a cap.
		if (size > 32 * 1024 * 1024) throw new Error("request too large");
		chunks.push(c);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const json = (res: http.ServerResponse, data: unknown, code = 200) => {
	// Some of these carry a session, a transcript, or a live pairing code; none are worth caching.
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(data));
};

/** Slash commands at the start of the line, and `@`-paths anywhere. */
function complete(text: any, cwd: string, child: PageChild) {
	const trimmed = text ?? "";
	if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
		const q = trimmed.slice(1).toLowerCase();
		// The page's own first, and only once: an extension is free to register a command of one of
		// these names, but the page intercepts the line before it is sent, so that is the one that
		// would run and offering both would be offering a choice that does not exist.
		return [...PAGE_COMMANDS, ...child.catalog.commandList.filter((c) => !PAGE_COMMANDS.some((p) => p.name === c.name))]
			.filter((c) => c.name.toLowerCase().startsWith(q))
			.slice(0, 20)
			.map((c) => ({ value: `/${c.name}`, hint: c.description ?? "" }));
	}
	const at = trimmed.lastIndexOf("@");
	if (at === -1) return [];
	const partial = trimmed.slice(at + 1);
	if (/\s/.test(partial)) return [];
	const dir = path.resolve(cwd, partial.endsWith("/") ? partial : path.dirname(partial));
	// Completion must not become a file browser for the whole disk.
	if (!isUnder(dir, cwd)) return [];
	const leaf = partial.endsWith("/") ? "" : path.basename(partial);
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => !e.name.startsWith(".") && e.name.toLowerCase().startsWith(leaf.toLowerCase()))
		.slice(0, 20)
		.map((e) => {
			const rel = path.relative(cwd, path.join(dir, e.name));
			return { value: `@${rel}${e.isDirectory() ? "/" : ""}`, hint: e.isDirectory() ? "dir" : "file", replaceFrom: at };
		});
}

/**
 * Commands with a route of their own, which `/rpc` therefore refuses.
 *
 * `/rpc` passes a body straight to pi, which is what makes it useful — anything in the protocol this
 * front end has not grown a button for is reachable. It also made every guard on every route
 * optional: `{"type":"switch_session"}` posted here skipped the mid-turn refusal, the same-session
 * check, the "one of this project's sessions" allowlist, and the epoch, backlog and pending-dialog
 * reset a swap owes the attached browsers. A route that exists is the route that runs.
 */
const OWN_ROUTES = new Set(["switch_session", "extension_ui_response", "prompt", "steer", "follow_up", "compact", "fork", "abort", "cycle_model", "cycle_thinking_level"]);

/**
 * And the two commands no route here should offer at all. Both replace the session the attached
 * browsers are watching: no new `EPOCH` is minted, the backlog and pending dialogs of the old
 * session are never cleared, the model catalog is never refreshed, and every page goes on rendering
 * a session that is no longer the one pi is in — with no way to notice. Opening a fresh session is
 * `/switch_session`-shaped work, and that route already exists.
 */
const NO_ROUTE_AT_ALL = new Set(["new_session", "clone"]);

/** A session id that is safe to use as a file name: the rule `sessionFileName` applies in src/lease.ts. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The always-on host, if one is running: `host-service.json` and a live pid, which is how
 * `pi-loops status` answers the same question (`hostServiceAlive` in `src/host-control.ts`).
 *
 * That one also checks the process's start time and command line, to catch a recycled pid. Not
 * repeated: this is a line of news printed once on the way out.
 */
export function liveHostPid(dir: string) {
	const rec = readJson(path.join(dir, "host-service.json"), undefined);
	if (!rec || rec.v !== 1 || !pidAlive(rec.pid)) return undefined;
	return rec.pid;
}

/**
 * The addresses another device on your networks could actually use.
 *
 * `internal` in Node means loopback and nothing else, so the raw list also contains every virtual
 * bridge this machine happens to run — docker0, libvirt, VirtualBox. Those are addresses that
 * belong to something else on the phone's network, and sending a live pairing code to one hands a
 * secret to a stranger. Named ones are dropped; the rest are ordered by how likely they are to be
 * the one that works, tailnet first.
 *
 * Each comes back as the whole address to open and the interface it belongs to — `{ url, via }`,
 * the shape the page and the pairing dialog both already used, under the names they used. Handing
 * back a bare address and an interface name left two call sites assembling the same URL and calling
 * the same field two different things.
 */
const VIRTUAL = /^(docker|virbr|br-|veth|vmnet|vboxnet|lxcbr|podman|cni|flannel|kube)/i;

export function lanAddresses(port: number) {
	const out = [];
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		if (VIRTUAL.test(name)) continue;
		for (const ni of list ?? []) {
			if (ni.family !== "IPv4" || ni.internal) continue;
			const [a, b] = ni.address.split(".").map(Number);
			// 100.64/10 is the range Tailscale hands out: if there is one, it is the answer.
			const rank = a === 100 && b >= 64 && b <= 127 ? 0 : a === 192 && b === 168 ? 1 : a === 10 ? 2 : 3;
			out.push({ url: `http://${ni.address}:${port}/`, via: name, rank });
		}
	}
	return out.sort((x, y) => x.rank - y.rank).map(({ url, via }) => ({ url, via }));
}

/**
 * Where a preview may read from.
 *
 * The session's own directory first — that is where the work is. But an agent asked to make
 * something for a person puts it where a person keeps things, which is usually the home directory,
 * and refusing to show you your own `~/Downloads/report.html` because the session started in
 * `~/code` is a rule serving nobody. The home directory is therefore also a root, minus every dot
 * segment and minus the directory holding the token. Nothing here is a capability the session did
 * not already have: it can read those files, and print them.
 */
function previewRoot(file: string, child: PageChild) {
	if (isUnder(file, child.sessionCwd)) return child.sessionCwd;
	const home = os.homedir();
	// A container with HOME=/ would make the whole disk a preview root, which is not a home
	// directory in any sense this rule means.
	if (home && home !== "/" && isUnder(file, home)) return home;
	return undefined;
}

/** What is worth *looking* at, as opposed to reading: the list that applies outside the project. */
const VISUAL_TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".pdf", ".html", ".htm"]);

/** What a preview will serve, and nothing else: an extension not on this list is not previewed. */
const PREVIEW_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".csv": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
};
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
/** Eight, because a preview is a tab you have open right now, and nobody has more of those than that. */
const PREVIEW_KEEP = 8;
/** Half an hour: long enough that a tab left open over lunch still reloads, short enough to forget. */
const PREVIEW_TTL_MS = 30 * 60_000;

/* ------------------------------------------------------------------ the Background view */

export type SessionHolderView =
	| { kind: "terminal"; pid: number; mode?: string; since: string; pushServers: string[] }
	| { kind: "page"; pid: number; since: string }
	| { kind: "host"; busy?: string; since: string }
	| { kind: "nobody" }
	| { kind: "legacy-pi"; pid: number };

export interface SessionRow {
	sessionId: string;
	/** The conversation's name or first message, when its file says. */
	title?: string;
	cwd?: string;
	file?: string;
	holder: SessionHolderView;
	plainJobs: number;
	rules: number;
	mailbox: number;
	sinceYouLooked: SinceYouLooked;
}

export interface HostStatus {
	snapshot: HostSnapshot;
	managed: "spawned" | "foreground";
	sessions: SessionRow[];
}

export interface SessionRowsInput {
	leases: readonly SessionLease[];
	plainJobSessions: readonly string[];
	ruleSessions: readonly string[];
	mailbox: ReadonlyMap<string, number>;
	legacy: ReadonlyArray<{ sessionId: string; pid: number }>;
	alive: (holder: LeaseHolder) => boolean;
	since: (sessionId: string) => SinceYouLooked;
	/** A session file's title (src/session-head.ts sessionTitle). */
	title: (sessionFile: string) => string | undefined;
	/** A job's name, when it has one. */
	jobName: (jobId: string) => string | undefined;
}

/** Combines ownership and automation counts so an idle conversation remains visible. */
export function sessionRows(input: SessionRowsInput): SessionRow[] {
	const leases = new Map(input.leases.map((lease) => [lease.sessionId, lease]));
	const legacy = new Map(input.legacy.map((entry) => [entry.sessionId, entry.pid]));
	const ids = new Set([...leases.keys(), ...input.plainJobSessions, ...input.ruleSessions, ...input.mailbox.keys(), ...legacy.keys()]);
	const counts = (sessions: readonly string[]) => {
		const out = new Map<string, number>();
		for (const id of sessions) out.set(id, (out.get(id) ?? 0) + 1);
		return out;
	};
	const jobs = counts(input.plainJobSessions);
	const rules = counts(input.ruleSessions);
	const rank = { terminal: 0, page: 1, host: 2, "legacy-pi": 3, nobody: 4 };
	return [...ids].map((sessionId): SessionRow => {
		const lease = leases.get(sessionId);
		const holder = lease?.holder;
		let view: SessionHolderView;
		if (holder && input.alive(holder)) {
			if (holder.kind === "terminal" && holder.page === true) view = { kind: "page", pid: holder.pid, since: holder.acquiredAt };
			else if (holder.kind === "terminal") view = { kind: "terminal", pid: holder.pid, ...(holder.mode ? { mode: holder.mode } : {}), since: holder.acquiredAt, pushServers: holder.pushServers };
			// Named the way the page's waiting line names it: a job's id is 32 characters no person typed.
			else view = { kind: "host", ...(holder.busy ? { busy: (holder.busy.jobId && input.jobName(holder.busy.jobId)) || holder.busy.runId.slice(0, 12) } : {}), since: holder.acquiredAt };
		} else if (legacy.has(sessionId)) view = { kind: "legacy-pi", pid: legacy.get(sessionId)! };
		else view = { kind: "nobody" };
		const title = lease?.sessionFile !== undefined ? input.title(lease.sessionFile) : undefined;
		return {
			sessionId,
			...(title !== undefined ? { title } : {}),
			...(lease?.cwd !== undefined ? { cwd: lease.cwd } : {}),
			...(lease?.sessionFile !== undefined ? { file: lease.sessionFile } : {}),
			holder: view,
			plainJobs: jobs.get(sessionId) ?? 0,
			rules: rules.get(sessionId) ?? 0,
			mailbox: input.mailbox.get(sessionId) ?? 0,
			sinceYouLooked: input.since(sessionId),
		};
	}).sort((a, b) => rank[a.holder.kind] - rank[b.holder.kind] || a.sessionId.localeCompare(b.sessionId));
}

/**
 * The page's token block (src/web.mjs, between its markers), comments left out: the Background view
 * is drawn in the same palette, both schemes, rather than in a second one of its own.
 */
const TOKENS = (() => {
	const from = PAGE.indexOf("/* tokens: */");
	const to = PAGE.indexOf("/* :tokens */");
	return from >= 0 && to > from ? PAGE.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, "") : "";
})();

/** The page's own before-first-paint rule (src/web.mjs): the theme chosen there, `localStorage.theme`. */
const THEME_SCRIPT = `try { var t = localStorage.getItem("theme"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch (e) {}\n`;

function escapeHtml(value: unknown): string {
	return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function heldBy(holder: SessionHolderView): string {
	switch (holder.kind) {
		case "terminal": return `terminal pid ${holder.pid}${holder.mode ? ` (${holder.mode})` : ""}`;
		case "page": return `the page, pid ${holder.pid}`;
		case "host": return `pi-loops${holder.busy ? ` — running ${holder.busy}` : ""}`;
		case "legacy-pi": return `pi-loops 0.22 window, pid ${holder.pid}`;
		case "nobody": return "nobody";
	}
}

/** Renders a static page; escaping each displayed status value keeps session and model text inert. */
export function renderHostPage(s: HostStatus): string {
	const e = escapeHtml;
	const snap = s.snapshot;
	// A title and a path are what someone typed or named: drawn as text, as the page's list draws them.
	const rows = s.sessions.map((row) => `<tr><td>${e(plainText(conversationLabel(row.sessionId, row.title)))}</td><td>${e(plainText(row.cwd ?? "—"))}</td><td>${e(plainText(heldBy(row.holder)))}</td><td>${e(row.plainJobs)}</td><td>${e(row.rules)}</td><td>${e(row.mailbox)}</td><td>${e(row.sinceYouLooked.runs === 0 && row.sinceYouLooked.failed === 0 && row.sinceYouLooked.findings === 0 ? "—" : `${row.sinceYouLooked.runs} runs, ${row.sinceYouLooked.failed} failed, ${row.sinceYouLooked.findings} findings`)}</td></tr>`).join("");
	const table = `<div class="scroll"><table><thead><tr><th>session</th><th>directory</th><th>held by</th><th>plain jobs</th><th>rules</th><th>mailbox</th><th>since you looked</th></tr></thead><tbody>${rows}</tbody></table></div>`;
	const running = [...snap.runs.map((run) => `run ${run.label} (${run.runId}) since ${run.startedAt}: ${run.promptPreview}`), ...snap.checks.map((check) => `check ${check.sourceLabel}/${check.eventLabel} (${check.traceId}) since ${check.startedAt}: ${check.cwd}`)];
	const runningHtml = running.length ? `<ul>${running.map((line) => `<li>${e(line)}</li>`).join("")}</ul>` : `<p>nothing running right now</p>`;
	const due = snap.nextDue ? `<p>next due ${e(snap.nextDue)}</p>` : "";
	const failing = snap.failing?.length ? `<section><h2>Failing</h2><ul>${snap.failing.map((item) => `<li>${e(item.job)}: ${e(item.error)}</li>`).join("")}</ul></section>` : "";
	const recent = snap.recent?.length ? `<section><h2>Recent runs</h2><ul>${snap.recent.map((item) => `<li>${e(item.ok ? "ok" : "FAIL")} ${e(item.at)} ${e(item.job)}${item.cost === undefined ? "" : ` · $${e(Number(item.cost).toFixed(3))}`}${item.error ? ` — ${e(item.error)}` : ""}</li>`).join("")}</ul></section>` : "";
	const mcp = snap.mcp.length ? `<section><h2>MCP</h2><ul>${snap.mcp.map((item) => `<li>${e(item.name)}: ${e(item.state)}${item.lastError ? ` — ${e(item.lastError)}` : ""}</li>`).join("")}</ul></section>` : "";
	const budget = snap.budget ? `<section><h2>Budget</h2><p>$${e(Number(snap.budget.spent).toFixed(2))} of $${e(Number(snap.budget.cap).toFixed(2))} today</p></section>` : "";
	// The same lines `pi-loops status` prints, so a person reads one wording in both places.
	const requests = snap.requests?.length ? `<section><h2>Requests</h2><ul>${requestLines(snap.requests, Date.now()).map((item) => `<li>${e(item.trim())}</li>`).join("")}</ul></section>` : "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="15"><title>pi-loops in the background</title><style>
${TOKENS}
body{font:15px/1.5 var(--font-ui);max-width:1100px;margin:0 auto;padding:1rem;background:var(--bg);color:var(--fg)}h1{font-size:1.35rem}h2{font-size:1.1rem}.muted{color:var(--dim)}a{color:var(--brand)}section{margin:1.5rem 0}.scroll{overflow-x:auto;background:var(--panel);border-radius:12px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.55rem;border-bottom:1px solid var(--line);vertical-align:top}th{white-space:nowrap;color:var(--dim);font-weight:500}tr:last-child td{border-bottom:0}ul{padding-left:1.4rem}li{margin:.35rem 0}footer{margin-top:2rem}
</style></head><body>
<header><p><a href="/">← back to the page</a></p><h1>pi-loops in the background</h1><p>pid ${e(snap.pid)} · pi-loops ${e(snap.version ?? "—")} · ${e(s.managed)} · started ${e(snap.startedAt)}${snap.model ? ` · model ${e(snap.model)}` : ""}</p></header>
<section><h2>Sessions</h2>${table}</section>
<section><h2>Running</h2>${runningHtml}${due}</section>
${requests}${budget}${failing}${recent}${mcp}
<footer><a href="/background.json">background.json</a></footer></body></html>`;
}

/**
 * `page-open` over the socket: the conversation's page, its pi started here when it is not open. A
 * new conversation is known by its pi's answer to `get_state`; until then it has no id to put in a
 * URL, so the answer waits for that, at most 15 seconds. `server` is the page once its bind settles,
 * undefined when it is not served: pi starts at once, and only the answer, which carries the
 * page's address, waits for the bind.
 */
export async function openForLaunch(
	req: Omit<PageOpenRequest, "op">,
	deps: {
		pool: ChildPool;
		server: Promise<PageServer | undefined>;
		notServed: () => string;
		heldTurn: (sessionId: string) => { runId: string; label: string } | undefined;
		lease: (sessionId: string) => Partial<Pick<SessionLease, "sessionFile" | "holder">> | undefined;
	},
): Promise<PageOpened> {
	const opened = await startForLaunch(req, deps);
	const server = await deps.server;
	if (!server) {
		// Nothing can reach a pi started for a page that is not served.
		if ("started" in opened) await deps.pool.stop(opened.sessionId, "the page is not served");
		return { error: deps.notServed() };
	}
	if ("error" in opened) return opened;
	const { sessionId, reused } = opened;
	return {
		url: `${server.url()}c/${encodeURIComponent(sessionId)}/`,
		sessionId,
		...(req.openFile ? server.openFileFor(sessionId) : { openKey: server.openKeyFor(sessionId) }),
		...(req.copyKey ? { copyKey: server.openKeyFor(sessionId, COPY_KEY_MS) } : {}),
		...(reused ? { reused: true as const } : {}),
		...(reused && req.piArgs.length ? { ignoredArgs: req.piArgs } : {}),
	};
}

/** The conversation `page-open` asks for, its pi started when it should be: `started` when this call started one. */
async function startForLaunch(
	req: Omit<PageOpenRequest, "op">,
	deps: Parameters<typeof openForLaunch>[1],
): Promise<{ sessionId: string; reused?: true; started?: true } | { error: string }> {
	const { pool } = deps;
	if (req.sessionId !== undefined) {
		const id = req.sessionId;
		if (pool.has(id)) return { sessionId: id, reused: true };
		// A turn pi-loops runs there, or a pi that keeps stopping: the conversation's page says which. A
		// pi started now would be a second writer, or a fourth crash.
		const lease = deps.lease(id);
		const file = req.sessionFile ?? lease?.sessionFile;
		if (decideOpen({ heldTurn: deps.heldTurn(id), lease, fileMissing: !!file && !fs.existsSync(file), crashes: pool.crashes(id), now: Date.now() }).kind !== "start") {
			// Whatever starts it later, the page after the wait or Start again, starts it as this launch asked.
			pool.recordArgs(id, req.piArgs);
			return { sessionId: id };
		}
		await pool.open({ sessionId: id, sessionFile: req.sessionFile ?? deps.lease(id)?.sessionFile, cwd: req.cwd, piArgs: req.piArgs });
		return { sessionId: id, started: true };
	}
	const child = await pool.open({ cwd: req.cwd, piArgs: req.piArgs });
	const key = await pool.named(child);
	if (key !== undefined && !key.startsWith("new-")) return { sessionId: key, started: true };
	const words = key === undefined ? pool.lastWords(`new-${child.pid}`) : child.recentStderr();
	return { error: `pi did not say which conversation it is in ${key === undefined ? "before it exited" : "within 15 s"}${words ? `: ${words}` : ""}` };
}

export function startPageServer(opts: PageServerOptions): Promise<PageServer> {
	const LOOPS_DIR = opts.dir;
	const TOKEN = opts.token;
	const VERSION = opts.version;
	const HOST_BIND = opts.bind.host;
	const PORT = opts.bind.port;
	const LOOPBACK = HOST_BIND === "127.0.0.1" || HOST_BIND === "::1" || HOST_BIND === "localhost";

	/**
	 * When each job runs next, as the scheduler worked it out.
	 *
	 * This used to be computed here, and understood only `every <interval>` — so a job on a cron
	 * expression, which is the first example in the README, showed no next run at all. Writing a second
	 * cron parser into this file was the wrong fix: the answer is a pure function of the job and the
	 * clock, and the scheduler already has the evaluator. It writes the answers to
	 * `next-runs.json` beside the store when one of them changes, and this reads them like every other
	 * file pi-loops keeps.
	 *
	 * Missing file, older pi-loops, no host yet: no next run shown, which is what was shown before.
	 */
	function nextRuns() {
		// The scheduler's one file. If two machines shared a `$HOME` they would both run every job and
		// overwrite one another's answers here; that is unsupported rather than handled
		// (docs/design.md §19).
		const doc = readJson(path.join(LOOPS_DIR, "next-runs.json"), { next: {} });
		return doc?.next && typeof doc.next === "object" ? doc.next : {};
	}

	function automation(cwd: string, sessionId: any, child: PageChild) {
		// The directory is the evidence, not any one file in it: a project with rules and no cron jobs
		// has no jobs.json at all, and reporting "pi-loops not found" there would be a lie.
		if (!fs.existsSync(LOOPS_DIR)) return { installed: false, dir: LOOPS_DIR };
		// A plain job runs only in the session that created it; the id in this session's header says
		// whether that is this one, and the panel says "resume it" rather than promising a time.
		// pi's own word first: before the first message there is no session file to read a header from,
		// and the window's own plain job was marked as another session's.
		const currentSession = sessionId || (child.sessionFile ? readHead(child.sessionFile)?.id : undefined);
		const jobsFile = readJson(path.join(LOOPS_DIR, "jobs.json"), { jobs: [] });
		/**
		 * This project's jobs, and the count of everything in other projects goes with it, because a
		 * list that silently drops things is worse than a longer list.
		 */
		const inThisProject = (j: any) => sameProject(j.cwd, cwd);
		const allJobs = jobsFile.jobs ?? [];
		const nexts = nextRuns();
		const hostPid = liveHostPid(LOOPS_DIR);
		const hostUp = hostPid !== undefined;
		// Read on every request, like hostPid: nothing runs a loop, or a closed conversation's plain job,
		// while no background process is up. The reason is the window's (its runtime snapshot); without
		// one yet, the plain fact.
		const paused = hostUp ? undefined : child.live.runtime?.paused || "pi-loops is not running";
		const jobs = allJobs.filter(inThisProject).map((j: any) => ({
			id: j.id,
			name: j.name,
			schedule: formatSchedule(j.schedule),
			stateful: !!j.stateful,
			enabled: !!j.enabled,
			prompt: maskSecrets(j.prompt),
			runCount: j.runCount ?? 0,
			lastError: maskSecrets(j.lastError),
			running: !!j.running,
			// The open body of a card shows these, which the terminal's `/cron` line has and the panel
			// did not; they leave the store as they were written, no reshaping.
			cwd: j.cwd,
			lastFiredAt: j.lastFiredAt,
			// Due ticks a run was too slow to take. The `lastError` a skip writes is cleared by the next
			// run; this count is not, so it is the last evidence a loop is losing cadence.
			skippedOverlap: j.skippedOverlap ?? 0,
			// Set only when it is not this machine's: the panel says so, and nothing else has to guess.
			// What to type to fix it. The terminal's version of this line says `/cron set <n>`, where n
			// is the position in a numbered list — which this panel does not have, so telling someone to
			// use one was telling them to go and find a terminal. A name or a full id resolves anywhere.
			ref: j.name || j.id,
			// Only for a job that is actually going to run: disabled, or belonging to another machine,
			// and a next run would be a promise nothing intends to keep — which is the rule `/cron`
			// follows. A time that has already passed is a stale answer rather than a next run (the job
			// fired and no tick has rewritten the file yet), and saying nothing beats saying something
			// visibly wrong.
			next: j.enabled && (j.stateful ? !paused : plainJobRuns(j, currentSession, hostUp, paused)) ? futureOnly(nexts[j.id]) : undefined,
			// Set for a plain job of a session that is not this one: where it runs, in the terminal's words.
			// A disabled one runs nowhere, and the card already says it is off.
			asleep: j.stateful ? (j.enabled && paused ? "paused: " + paused : undefined) : j.enabled ? plainJobWhere(j, currentSession, hostUp, paused) : undefined,
		}));
		const allRules = readJson(path.join(LOOPS_DIR, "triggers.json"), { rules: [] }).rules ?? [];
		const rules = allRules
			.filter(inThisProject)
			.map((r: any) => ({ id: r.id, condition: maskSecrets(r.condition), action: maskSecrets(r.action), enabled: !!r.enabled, fireOnce: !!r.fireOnce, firedAt: r.firedAt }));
		// Two counts, not one. They used to be added together, and `/cron` counts jobs only — so the
		// panel's number disagreed with the command's whenever a rule lived somewhere else, and the line
		// that exists to say "your job is not gone, it is elsewhere" pointed at `/cron all`, where a
		// reader would then count one job too few and conclude the panel was wrong about both.
		const elsewhere = { jobs: allJobs.length - jobs.length, rules: allRules.length - rules.length };

		let inboxNew = 0;
		let inboxDecisions = 0;
		try {
			for (const line of fs.readFileSync(path.join(LOOPS_DIR, "inbox.jsonl"), "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const e = JSON.parse(line);
					if ((e.status ?? "new") !== "new") continue;
					inboxNew++;
					if (e.kind === "checkpoint") inboxDecisions++;
				} catch {
					/* skip a torn line */
				}
			}
		} catch {
			/* no inbox yet */
		}

		// MCP servers and hooks are deliberately not counted from the config files here: what matters
		// is which ones actually connected and what they exposed, and that is in the runtime snapshot.
		// Read from host-service.json on every request: the runtime snapshot is written only when a change
		// is worth an entry, and pi-loops coming up may not be written for a minute.
		return { installed: true, dir: LOOPS_DIR, jobs, rules, inboxNew, inboxDecisions, elsewhere, hostPid, lastCheck: lastCheckIn(cwd), paused: jobs.some((j: any) => j.enabled && (j.stateful || (j.asleep && j.asleep.includes(" — paused: ")))) || rules.some((r: any) => r.enabled) ? paused : undefined, lastRun: lastRunIn(cwd) };
	}

	const requests = new RequestStore(LOOPS_DIR);
	const leases = new LeaseStore(LOOPS_DIR);
	const audit = new TriggerStore(LOOPS_DIR);
	const pool = opts.pool;
	const signed = (child: PageChild) => createdBy(child, VERSION);
	/** pi's session files, read for the list and for a conversation no lease names. Nothing is read until asked. */
	const index = new ConversationIndex(opts.sessionsRoot, undefined, () => leases.list().flatMap((l) => (l.sessionFile ? [l.sessionFile] : [])));
	const needsYou = new NeedsYouCounts(path.join(LOOPS_DIR, "inbox.jsonl"));

	/**
	 * `GET /conversations`: one project's conversations and the projects to switch to. `cwd` is only
	 * looked up among the projects found; without it, the project of `session` (its lease, else its
	 * file), else the newest. A file read: it never asks the pool for a pi.
	 */
	function conversationList(cwdAsked: string | null, sessionAsked: string | null): { status: number; body: Record<string, unknown> } {
		const all = leases.list();
		const byId = new Map(all.map((l) => [l.sessionId, l]));
		const alive = new Map<string, boolean>();
		const aliveOnce = (h: LeaseHolder) => {
			const key = `${h.pid}:${h.procStart ?? ""}:${h.acquiredAt}`;
			if (!alive.has(key)) alive.set(key, holderAlive(h));
			return alive.get(key) as boolean;
		};
		const waiting = new Set(requests.sessions());
		const jobs = readJson(path.join(LOOPS_DIR, "jobs.json"), { jobs: [] }).jobs;
		const readers: RowReaders = {
			lease: (id) => byId.get(id),
			alive: aliveOnce,
			open: (id) => pool.has(id),
			needsYou: () => needsYou.get(),
			queued: (id) => {
				if (!waiting.has(id)) return 0;
				try {
					return requests.list(id).filter((row) => row.kind === "input").length;
				} catch {
					return 0; // an id the store refuses has no rows
				}
			},
			projectCwds: () => [
				...all.flatMap((l) => (l.cwd && l.holder && aliveOnce(l.holder) ? [l.cwd] : [])),
				...(Array.isArray(jobs) ? jobs.flatMap((j: any) => (typeof j?.cwd === "string" ? [j.cwd] : [])) : []),
			],
		};
		const scan = index.scan();
		const projects = index.projects(readers, scan);
		const known = (cwd: string | undefined) => (cwd !== undefined && projects.some((p) => p.cwd === cwd) ? cwd : undefined);
		let cwd = cwdAsked ?? undefined;
		if (cwd === undefined) {
			const session = sessionAsked ? idFrom(sessionAsked) : undefined;
			cwd = (session !== undefined ? (known(byId.get(session)?.cwd) ?? known(index.byId(session)?.cwd)) : undefined) ?? projects[0]?.cwd;
		}
		if (cwd === undefined) return { status: 200, body: { cwd: null, rows: [], more: 0, projects } };
		const listed = known(cwd) !== undefined ? index.rows(cwd, readers, scan) : undefined;
		if (!listed) return { status: 404, body: { error: "no such project" } };
		return { status: 200, body: { cwd, rows: listed.rows, more: listed.more, projects } };
	}

	/** A person row's image bytes for the composer; a file that is gone or not the row's gives the text back alone, and the reason is logged. */
	function imagesOf(row: any) {
		try {
			return requests.images(row);
		} catch (err: any) {
			opts.log(`pi-loops web: ${err?.message ?? err}`);
			return [];
		}
	}

	/**
	 * The input rows queued for the session, in the order the engine offers them, as the page lists
	 * them: the person's and pi-loops' in one queue, each cancellable. A person row from a page that is
	 * gone is `offered`: nothing sends it until this page says so (`/queue/send`) or discards it. One pi
	 * refused (`last_error`, written by the holder) is taken out here, audited, and handed back to the
	 * composer with the error, through the event stream. One of this page's nobody took (`untaken`)
	 * says why, with send-here. With no pi-loops in this pi the file is nobody's to drain, and the
	 * queue the page shows is pi's own.
	 */
	function queuedRequests(sessionId: any, idle = false, child: PageChild) {
		if (typeof sessionId !== "string" || !sessionId || child.catalog.piLoopsLoaded === false) return [];
		const holder = holderNow(sessionId, child);
		const now = Date.now();
		let rows: any[];
		try {
			rows = queueOrder(requests.list(sessionId));
		} catch (err: any) {
			opts.log(`pi-loops web: requests: ${err?.message ?? err}`);
			return [];
		}
		const failed = rows.filter((row) => row.source === "person" && row.last_error !== undefined);
		for (const row of failed) {
			// The bytes first: removing the row removes its image file.
			const images = imagesOf(row);
			requests.remove(sessionId, [row.id]);
			audit.appendAudit({ cwd: row.payload?.cwd ?? "", type: "request", traceId: row.id, state: "failed", sourceLabel: row.source, eventLabel: sessionId, details: { session_id: sessionId, error: row.last_error, returned: "to the composer" } });
			child.broadcast({ type: "send_failed", id: row.id, text: row.payload?.text ?? "", images, error: row.last_error });
		}
		const jobNames = new Map((readJson(path.join(LOOPS_DIR, "jobs.json"), { jobs: [] }).jobs ?? []).map((j: any) => [j?.id, j?.name]).filter(([id, name]: any) => typeof id === "string" && typeof name === "string"));
		return rows
			.filter((row) => !failed.includes(row))
			.map((row) => ({
				id: row.id,
				source: row.source,
				label: labelOf(row, jobNames),
				// An offered row is shown whole: send vouches for all of it, so all of it is what you read.
				text: maskSecrets(String(row.payload?.text ?? "").replace(/^\[Trigger [^\]]+\]\s*/, "")).slice(0, row.source === "person" && !producerAlive(row) ? Infinity : TEXT_PREVIEW),
				images: row.payload?.images?.length ?? 0,
				created_at: row.created_at,
				mine: mine(row, child),
				offered: row.source === "person" && !producerAlive(row),
				stuck: untaken(row, holder, now, idle, child),
			}));
	}

	/**
	 * Who holds the session, as the page's answers need it: the pid, whether it is the pi behind this
	 * page, whether it stands aside, and whether it delivers person rows at all (src/lease.ts
	 * holderDelivers). Undefined when nobody alive holds it.
	 */
	function holderNow(sessionId: string, child: PageChild) {
		let lease;
		try {
			lease = leases.read(sessionId);
		} catch {
			return undefined; // no lease directory yet: nobody holds it
		}
		const holder = lease?.holder;
		if (!holder || !holderAlive(holder)) return undefined;
		return { kind: holderOf(lease, () => true, false).kind, pid: holder.pid, mine: holder.pid === child.pid, aside: holder.aside === true, delivers: holderDelivers(holder) };
	}

	/**
	 * A page's pi that holds its conversation but stands aside reads it again from disk. It stands aside
	 * when it took the conversation back from a terminal that wrote after it read the file, and a
	 * terminal has no way to tell it; in a terminal the person types /resume, and the page's pi has
	 * nobody to type it. pi refuses the swap during a turn, so a busy pi is tried again later. Not
	 * awaited: the page's poll answers at once, and the next one shows the conversation caught up.
	 */
	function catchUp(child: PageChild) {
		const sessionId = child.sessionId;
		if (!sessionId || child.catalog.piLoopsLoaded === false) return;
		const holder = holderNow(sessionId, child);
		if (!holder?.mine || !holder.aside) return;
		const last = caughtUpAt.get(child);
		if (last !== undefined && Date.now() - last < CATCH_UP_EVERY_MS) return;
		caughtUpAt.set(child, Date.now());
		child
			.swapSession(undefined, { restoreModel: true, reopen: true })
			.then((answer: any) => opts.log(answer?.success ? `page: ${sessionId.slice(0, 8)} read again from disk; it is current` : `page: ${sessionId.slice(0, 8)} could not be read again: ${answer?.error ?? "no answer"}`))
			.catch((err: any) => opts.log(`page: ${sessionId.slice(0, 8)} could not be read again: ${err?.message ?? err}`));
	}
	/** When each page pi last tried to catch up, so one that stays aside is not reloaded on every poll. */
	const caughtUpAt = new WeakMap<PageChild, number>();
	/** The session file's mtime when each page pi last read it: its start, then each catch-up. */
	const readAtMtime = new WeakMap<PageChild, number>();

	/**
	 * A page's pi that is a viewer (a terminal, or pi-loops in the background, holds the conversation)
	 * keeps the copy it read when it started; what the holder writes after that, an answer to a message
	 * sent from this page included, reaches the file and not this pi, so a reload showed the transcript
	 * without it. Once that pi is idle and the file has changed since it read it, it reads it again: the
	 * same rpc `switch_session` to the same file as `catchUp`, at most every 30 s, and only on a change,
	 * so the page's reload notice comes with something new and not with every poll.
	 */
	function catchUpViewer(child: PageChild, busy: boolean) {
		const sessionId = child.sessionId;
		const file = child.sessionFile;
		if (!sessionId || !file || busy || child.catalog.piLoopsLoaded === false) return;
		const holder = holderNow(sessionId, child);
		if (!holder || holder.mine) return;
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(file).mtimeMs;
		} catch {
			return; // no file yet: nothing written to read again
		}
		const readAt = readAtMtime.get(child) ?? child.startedAt;
		if (mtimeMs <= readAt) return;
		const last = caughtUpAt.get(child);
		if (last !== undefined && Date.now() - last < CATCH_UP_EVERY_MS) return;
		caughtUpAt.set(child, Date.now());
		child
			.swapSession(undefined, { restoreModel: true, reopen: true })
			.then((answer: any) => {
				if (answer?.success) readAtMtime.set(child, Math.max(mtimeMs, Date.now()));
				opts.log(answer?.success ? `page: ${sessionId.slice(0, 8)} read again from disk after its holder wrote to it` : `page: ${sessionId.slice(0, 8)} could not be read again: ${answer?.error ?? "no answer"}`);
			})
			.catch((err: any) => opts.log(`page: ${sessionId.slice(0, 8)} could not be read again: ${err?.message ?? err}`));
	}

	/**
	 * The child's `get_state`, with the request rows and the panel this side reads from disk, and who
	 * holds the conversation by the rule `/prompt` follows (`holderNow`): the page's held line and the
	 * notice after a send cannot disagree. A session id that is not the one the pool has this child
	 * under re-keys it, and its pages are told first.
	 */
	async function snapshot(child: PageChild) {
		catchUp(child);
		const state = await child.snapshot({ requests: (sessionId, idle) => queuedRequests(sessionId, idle, child), automation: (cwd, sessionId) => automation(cwd, sessionId, child) });
		pool.follow(child);
		catchUpViewer(child, !!state.busy || !!state.compacting);
		// Whether a message sent here goes to the holder at all: only a pi with pi-loops in it writes a
		// request row a terminal can take. Without, it answers the message itself, beside the terminal.
		if (child.catalog.piLoopsLoaded === undefined) await child.refreshCommands();
		const piLoops = child.catalog.piLoopsLoaded !== false;
		const id = typeof state.sessionId === "string" && state.sessionId ? state.sessionId : child.sessionId;
		const h = id ? holderNow(id, child) : undefined;
		return { ...state, holder: h ? { kind: h.kind, pid: h.pid, mine: h.mine, delivers: h.delivers, aside: h.aside, piLoops } : { kind: "none", mine: false, delivers: false, aside: false, piLoops } };
	}

	/** Event streams open across every child. */
	const clients = () => pool.list().reduce((n, c) => n + c.clients.size, 0);

	const CHECK: CheckOptions = { token: TOKEN, allowHosts: opts.allowHosts, loopback: LOOPBACK };
	/** The browsers that paired, and the keys minted for the addresses a browser fetches without our header. */
	const devices = new DeviceStore(LOOPS_DIR, TOKEN, opts.log);
	const urlKeys = new UrlKeys();
	const deviceCookie = (id: string) => `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`;

	/**
	 * One-shot keys for the browser launcher. The real token must not appear in argv: on Linux
	 * `/proc/<pid>/cmdline` is world-readable, so `xdg-open http://…?token=…` hands the token to every
	 * other account on the machine — and with it `/rpc`, which is the whole session. A key is valid for
	 * one page load, for a minute, opens the conversation it was made for, and the page it serves
	 * carries the real token.
	 */
	const OPEN_KEY_MS = 60_000;
	const openKeys = new Map<string, { sessionId: string; expires: number; file?: string }>();
	/** Forget a key, and remove the file that held it. */
	function dropOpenKey(key: string) {
		const file = openKeys.get(key)?.file;
		openKeys.delete(key);
		if (file) guard(opts.log, "remove open file", () => removeOpenFile(file))();
	}
	function openKeyFor(sessionId: string, ttlMs = OPEN_KEY_MS) {
		const now = Date.now();
		for (const [key, v] of openKeys) if (v.expires <= now) dropOpenKey(key);
		const key = randomBytes(16).toString("hex");
		openKeys.set(key, { sessionId, expires: now + ttlMs });
		return key;
	}
	function openFileFor(sessionId: string) {
		const openKey = openKeyFor(sessionId);
		const openFile = writeOpenFile(LOOPS_DIR, `${api.url()}c/${encodeURIComponent(sessionId)}/?open=${openKey}`);
		openKeys.get(openKey)!.file = openFile;
		// Unspent, the file goes when the key would have: nothing else may come to read it.
		setTimeout(() => {
			if (openKeys.get(openKey)?.file === openFile) dropOpenKey(openKey);
		}, OPEN_KEY_MS).unref();
		return { openKey, openFile };
	}
	/** The conversation a key opens, spending the key; undefined for one that is unknown or late. */
	function spendOpenKey(key: string | null) {
		const found = key ? openKeys.get(key) : undefined;
		if (!key || !found) return undefined;
		dropOpenKey(key);
		return found.expires > Date.now() ? found.sessionId : undefined;
	}
	// The keys of a process before this one died with it; so do the files that held them.
	guard(opts.log, "sweep open files", () => sweepOpenFiles(LOOPS_DIR))();

	/**
	 * A six-digit code for a phone. The token is 32 hex characters, which is fine to click and
	 * miserable to type on a screen keyboard, so the terminal prints a number instead: enter it once
	 * and that device has the cookie for good. Single use, and the scheme gives up after twenty wrong
	 * guesses — six digits is a million, so twenty tries is not a search, but the counter is what
	 * makes that a fact rather than an assumption.
	 */
	let pairCode = "";
	let pairTries = 0;
	let pairExpires = 0;

	function newPairCode() {
		pairCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
		pairExpires = Date.now() + PAIR_TTL_MS;
		pairTries = 0;
		return pairCode;
	}

	/** Used, cancelled, or expired: all three mean the same thing to everything downstream. */
	function clearPairCode() {
		pairCode = "";
		pairExpires = 0;
	}

	/**
	 * Check a pairing guess, and spend one of the twenty tries if it is wrong.
	 *
	 * Named for the side effect, because the side effect is the whole reason the order of the checks in
	 * `GET /` matters: a browser that is already signed in must be recognised as signed in *before*
	 * anything asks this, or reloading a bookmarked address that still carries an old `?pair=` burns a
	 * try the phone waiting on the other side of the room needs.
	 */
	function spendPairCode(given: string | null) {
		if (pairCode && Date.now() > pairExpires) clearPairCode();
		if (!pairCode || given == null) return false;
		// Shape first. A six-character guess can still be twelve bytes, and timingSafeEqual throws on a
		// length mismatch — which used to be a 500 that told a stranger a code was armed, and did it
		// without spending one of the twenty tries.
		if (typeof given !== "string" || !/^\d{6}$/.test(given)) {
			if (given) spendTry();
			return false;
		}
		if (timingSafeEqual(Buffer.from(given), Buffer.from(pairCode))) {
			clearPairCode();
			return true;
		}
		spendTry();
		return false;
	}

	/** A wrong code is either a typo or a search, and there is no way to tell them apart from here. */
	function spendTry() {
		if (++pairTries >= PAIR_MAX_TRIES) {
			clearPairCode();
			opts.log("pi-loops web: too many wrong pairing codes; ask for another one");
		}
	}

	/**
	 * What you chose last time, so the next session starts there.
	 *
	 * A session opens on pi's default model, which is why choosing the same one every morning was the
	 * first thing this front end asked of anybody. It lives next to the loops rather than in the
	 * package, so it survives an upgrade, and the launcher is what applies it — the terminal window
	 * gets the same memory as this one.
	 */
	function rememberPref(key: "model" | "thinking", setting: string) {
		writeUiPref(LOOPS_DIR, key, setting);
	}

	/** HTML written into the conversation instead of into a file, kept just long enough to look at. */
	const previews = new Map<string, { html: string; at: number }>();

	/** A session id from a URL, or undefined for one that is not a usable file name. */
	function idFrom(raw: string) {
		try {
			return sessionFileName(decodeURIComponent(raw));
		} catch {
			return undefined; // not an id: `..`, a slash, a malformed escape
		}
	}

	const viewOf = (sessionId: string): ChildView | undefined => pool.views().find((v) => v.sessionId === sessionId);
	const NO_SUCH = { error: "no such conversation" };
	const waitingLine = (label: string) => `pi-loops is running ${label} in this conversation; it opens when the turn ends`;
	const unsavedLine = (pid: number) => `This conversation is open in a terminal (pi ${pid}) and has nothing saved yet; it opens here after its first answer`;
	const crashLine = `pi stopped ${PAGE_CRASH_BUDGET.count} times within ${PAGE_CRASH_BUDGET.windowMs / 60_000} minutes in this conversation, so it is not started again on its own`;

	type Opened = { child: PageChild } | { status: number; body: Record<string, unknown>; decision?: ReturnType<typeof decideOpen> };

	/**
	 * The child of a conversation named in a URL, started when the conversation is one pi-loops knows
	 * and `decideOpen` says start. A session id is accepted only when it is a usable file name and the
	 * pool has it or a lease names it; `cwd` and pi's arguments never come from HTTP.
	 */
	async function conversation(sessionId: string | undefined): Promise<Opened> {
		if (sessionId === undefined) return { status: 404, body: NO_SUCH };
		// A conversation no lease names (from before 0.23, a `pi -p` run, a pi without pi-loops) opens
		// from pi's own file, found by its header id under pi's sessions root: what `pi --session` takes.
		const lease: Partial<Pick<SessionLease, "sessionFile" | "cwd" | "holder">> | undefined = opts.sessions.known(sessionId) ?? (pool.get(sessionId) ? undefined : index.byId(sessionId));
		const fileMissing = !!lease?.sessionFile && !fs.existsSync(lease.sessionFile);
		// Its own file now: a conversation pi started another one for opens as itself again.
		if (lease?.sessionFile && !fileMissing) pool.forgetMove(sessionId);
		const have = pool.get(sessionId);
		const known = have ? undefined : lease;
		if (!have && !(known?.cwd && known.sessionFile)) return { status: 404, body: NO_SUCH };
		const decision = decideOpen({ child: have ? viewOf(sessionId) : undefined, heldTurn: opts.heldTurn?.(sessionId), lease: known, fileMissing, crashes: pool.crashes(sessionId), now: Date.now() });
		if (decision.kind === "wait-background") return { status: 409, body: { error: waitingLine(decision.label), waiting: { runId: decision.runId, label: decision.label } }, decision };
		if (decision.kind === "wait-terminal") return { status: 409, body: { error: unsavedLine(decision.pid) }, decision };
		if (decision.kind === "crash-looping") return { status: 503, body: { error: crashLine }, decision };
		if (have) return { child: have };
		try {
			return { child: await pool.open({ sessionId, sessionFile: known?.sessionFile, cwd: known?.cwd as string, piArgs: argsFor(sessionId, known?.cwd as string) }) };
		} catch (err: any) {
			return { status: 503, body: { error: String(err?.message ?? err) } };
		}
	}

	/**
	 * The pi arguments a conversation's pi starts with: those recorded for it, else those its project's
	 * most recent conversation was opened with (a page open now, else a lease's), so a conversation
	 * opened from the list loads pi-loops with `-e` when the rest of that project's pages do. Never
	 * from HTTP.
	 */
	function argsFor(sessionId: string, cwd: string): string[] {
		const own = pool.argsOf(sessionId);
		if (own.length) return own;
		const live = pool.list().map((c) => ({ cwd: c.cwd, at: c.startedAt, args: c.piArgs }));
		let recorded: Array<{ cwd?: string; at: number; args: string[] }> = [];
		try {
			recorded = leases
				.list()
				.filter((l) => l.cwd === cwd && l.sessionId !== sessionId)
				.map((l) => ({ cwd: l.cwd, at: Date.parse(l.updatedAt) || 0, args: pool.argsOf(l.sessionId) }));
		} catch (err: any) {
			opts.log(`pi-loops page: leases: ${err?.message ?? err}`);
		}
		return projectArgs(cwd, [...live, ...recorded]);
	}

	/**
	 * The script a plain page carries, under a nonce of its own: the device secret, when this answer is
	 * the first visit that hands it over, and whatever else the page needs (`more`).
	 */
	function plainScript(secret: string | undefined, more = "") {
		if (!secret && !more) return undefined;
		const nonce = randomBytes(16).toString("hex");
		const keep = secret ? `const DEVICE_SECRET = "${secret}";\ntry { localStorage.setItem(${JSON.stringify(DEVICE_STORAGE_KEY)}, DEVICE_SECRET); } catch (e) {}\n` : "";
		return { csp: `script-src 'nonce-${nonce}'; connect-src 'self'`, html: `<script nonce="${nonce}">\n${keep}${more}</script>` };
	}

	/** The plain pages `GET /c/<id>/` answers when there is no page to give yet. */
	function plainPage(res: http.ServerResponse, status: number, body: string, opts: { refresh?: boolean; secret?: string; script?: string } = {}) {
		const script = plainScript(opts.secret, opts.script);
		res.writeHead(status, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; ${script ? `${script.csp}; ` : ""}form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
			"x-pi-loops-web": "1",
		});
		res.end(
			`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${opts.refresh ? '<meta http-equiv="refresh" content="5">' : ""}<title>pi-loops</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;background:#8881;padding:.5rem}</style></head><body>${body}${script?.html ?? ""}</body></html>`,
		);
	}

	/**
	 * Stop it, on the waiting page. No cookie authenticates a post, so the button trades the device
	 * cookie and the secret this origin keeps for the token, and posts with it.
	 */
	const stopScript = (sessionId: string) => {
		const base = `/c/${encodeURIComponent(sessionId)}/`;
		return `document.getElementById("stop").onclick = async () => {
  let secret = "";
  try { secret = localStorage.getItem(${JSON.stringify(DEVICE_STORAGE_KEY)}) || ""; } catch (e) {}
  const t = await fetch(${JSON.stringify(`${base}token`)}, { method: "POST", headers: { "x-pi-web-device-secret": secret } }).then((r) => r.json()).catch(() => ({}));
  if (t.token) await fetch(${JSON.stringify(`${base}stop-turn`)}, { method: "POST", headers: { "x-pi-web-token": t.token } }).catch(() => {});
  location.reload();
};
`;
	};

	/**
	 * The conversation `GET /` opens: the one the page opened last, while pi-loops can still open it,
	 * else the open one somebody looked at most recently. Undefined: the Background view instead.
	 */
	function rootPage(): string | undefined {
		const last = opts.lastPage?.();
		if (last !== undefined && (pool.get(last) || opts.sessions.known(last)?.sessionFile)) return last;
		return pool.views().sort((a, b) => b.lastClientAt - a.lastClientAt)[0]?.sessionId;
	}

	/**
	 * The Background view: what pi-loops in the background is doing, as HTML or JSON. Read-only: every
	 * action on it stays on the 0600 socket. Its error text can carry a path or a provider's message,
	 * so that goes to the log and the page says only that it is unavailable.
	 */
	function background(res: http.ServerResponse, read: () => HostStatus, as: "html" | "json", secret?: string) {
		let status: HostStatus;
		try {
			status = read();
		} catch (err: any) {
			opts.log(`pi-loops page: background view: ${err?.message ?? err}`);
			return void res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("status unavailable\n");
		}
		// The theme this browser chose on the page, before the first paint, as the page applies it.
		const script = as === "html" ? plainScript(secret, THEME_SCRIPT) : undefined;
		const headers: Record<string, string> = {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; ${script ? `${script.csp}; ` : ""}base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
			"x-pi-loops-web": "1",
		};
		if (as === "json") return void res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" }).end(`${JSON.stringify(status, null, 2)}\n`);
		res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(script ? renderHostPage(status).replace("<style>", () => `${script.html}<style>`) : renderHostPage(status));
	}

	/**
	 * `GET /` and `GET /c/<id>/`: the page of one conversation. The door, the open key and the pairing
	 * code come first, as they always have; then which conversation, and whether its pi can be had.
	 *
	 * Two kinds of load get a page. A first visit (the open key, the pairing code, or the token
	 * itself) gets the token and a device secret in its HTML, and the device cookie. A browser with a
	 * known device cookie gets the page with neither in it: the page trades the cookie and the secret
	 * it kept for the token at `/token`, so whoever else receives the cookie fetches HTML and no more.
	 */
	async function servePage(res: http.ServerResponse, url: URL, facts: RequestFacts, pathId: string | null | undefined) {
		// The second lock still applies: a page on another site cannot be allowed to fetch this
		// one just because it guessed the key, and only a browser on this machine ever has it.
		// Both of these hand out a device without a token, so both owe the same locks the token
		// routes have. Without the cross-site one, a page on any site could point an iframe at
		// this URL twenty times and burn the pairing code the phone was waiting for.
		const trusted = !placeRefused(facts, CHECK);
		// Asked first, because a browser that is already signed in must not pay for a pairing guess:
		// `spendPairCode` spends one of twenty tries, so a signed-in tab reloading a bookmark that
		// still carries an old `?pair=` used to burn a try. The open key is the other way round:
		// whichever load presents it first spends it, signed in or not, so nobody else has a minute to
		// trade it in. It may also arrive as a cross-site navigation, from the launch file (topLevelNavigation).
		const verdict = checkRequest(facts, CHECK);
		const tokened = "ok" in verdict;
		const known = trusted && devices.known(facts.device);
		let keyed: string | undefined;
		let paired = false;
		if (trusted || (hostAllowed(facts, CHECK) && topLevelNavigation(facts))) {
			keyed = spendOpenKey(url.searchParams.get("open"));
			// A key opens its own conversation and no other.
			if (keyed !== undefined && pathId !== undefined && pathId !== keyed) keyed = undefined;
		}
		if (trusted && keyed === undefined && !tokened && !known) paired = spendPairCode(url.searchParams.get("pair"));
		// The token in the header, on a device this server knows, is a page asking with what it already
		// holds (a fetch that followed a redirect, a tab with the token in memory): a new secret here is
		// one that page never learns, and its next reload meets the door. `?token=` is a person opening
		// the address pi-loops printed, on a browser that may have lost this origin's secret: that is
		// a first visit, and it gets a secret.
		const first = keyed !== undefined || paired || (tokened && !(known && verdict.via === "header"));
		if (!first && !known) return void res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-pi-loops-web": "1" }).end(DOOR);
		// The key and the code are spent now, whatever answer follows: the waiting page reloads itself
		// and the crash page has a link, and either arrives next with nothing but the device cookie.
		let secret: string | undefined;
		if (first) {
			const device = devices.enroll(facts.device);
			secret = device.secret;
			res.appendHeader("set-cookie", deviceCookie(device.id));
		}
		if (pathId === null) return void json(res, NO_SUCH, 404);

		const sessionId = pathId ?? keyed ?? rootPage();
		if (sessionId === undefined) {
			if (opts.background) return void background(res, opts.background, "html", secret);
			return void plainPage(res, 404, "<p>No conversation is open in the page yet.</p>", { secret });
		}
		if (url.searchParams.get("again") === "1") pool.clearCrashes(sessionId);
		const opened = await conversation(sessionId);
		if ("status" in opened) {
			const d = opened.decision;
			if (d?.kind === "wait-background") {
				// A delivery is a write, not a run: it has nothing to stop and ends on its own.
				if (d.label === DELIVERY_LABEL) return void plainPage(res, 200, `<p>${escapeHtml(waitingLine(d.label))}</p>`, { refresh: true, secret });
				return void plainPage(res, 200, `<p>${escapeHtml(waitingLine(d.label))}</p><p><button id="stop">Stop it</button></p>`, { refresh: true, secret, script: stopScript(sessionId) });
			}
			if (d?.kind === "wait-terminal") return void plainPage(res, 200, `<p>${escapeHtml(unsavedLine(d.pid))}.</p>`, { refresh: true, secret });
			if (d?.kind === "crash-looping") {
				const words = pool.lastWords(sessionId);
				return void plainPage(res, 503, `<p>${escapeHtml(crashLine)}.</p>${words ? `<pre>${escapeHtml(words)}</pre>` : ""}<p><a href="/c/${encodeURIComponent(sessionId)}/?again=1">Start again</a></p>`, { secret });
			}
			// pi could not be started: every one of the page's six is busy, say. A person reads this.
			if (opened.status === 503) return void plainPage(res, 503, `<p>${escapeHtml(opened.body.error)}.</p><p><a href="/">Back</a></p>`, { secret });
			return void json(res, opened.body, opened.status);
		}
		pool.touch(sessionId);
		opts.rememberPage?.(sessionId);
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			// The URL can carry the token, so no other site should ever be told it — and a first visit's
			// page carries it, so it must not sit in the browser's disk cache either.
			"referrer-policy": "no-referrer",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			/*
			 * The page carries the token in a variable, and the Markdown renderer turns model
			 * output into DOM. Those two facts are fine today and the review found nothing to get
			 * through the renderer — but a mistake there tomorrow would be a mistake that can
			 * exfiltrate a credential which never expires. This says: no origin but this one, for
			 * anything. Inline script and style are what this page is made of; the value is in
			 * connect-src and frame-ancestors, which is where a stolen token would have to go and
			 * how a hostile page would have to reach in.
			 */
			"content-security-policy":
				"default-src 'none'; connect-src 'self'; img-src 'self' data: blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
			// How a second launch on the same port knows the thing already there is one of these.
			"x-pi-loops-web": "1",
		});
		const id = sessionId;
		res.end(
			PAGE.replace("__TOKEN__", () => (first ? TOKEN : ""))
				.replace("__DEVICE_SECRET__", () => secret ?? "")
				.replace("__VERSION__", () => VERSION)
				.replace("__SESSION__", () => id),
		);
	}

	const server = http.createServer(
		guard(opts.log, "http", async (req: http.IncomingMessage, res: http.ServerResponse) => {
			// Inside the try: a request line that is not a URL (`GET //[`) threw here, outside it, and the
			// rejection nobody handled ended the front end.
			let url;
			try {
				url = new URL(req.url as string, "http://127.0.0.1");
			} catch {
				res.writeHead(400).end();
				return;
			}
			try {
				const facts = requestFacts(req, url);
				// 0.24 keeps 0.22.8's token, and 0.22.8 kept it in a cookie that goes to every port on this
				// host: whatever this answers, the browser forgets it.
				if (facts.legacyCookie) res.appendHeader("set-cookie", LEGACY_TOKEN_CLEAR);
				// Every conversation's routes are under `/c/<sessionId>/`; null for a prefix that names no
				// usable id, which nothing below answers but 404.
				const prefixed = /^\/c\/([^/]*)(\/.*)?$/.exec(url.pathname);
				const pathId = prefixed ? (idFrom(prefixed[1]) ?? null) : undefined;
				const route = prefixed ? (prefixed[2] ?? "/") : url.pathname;
				if (req.method === "GET" && route === "/") return void (await servePage(res, url, facts, pathId));
				/**
				 * Installability, before the token check on purpose. A browser fetches the manifest and the
				 * icon without credentials — they would 403 behind it, and the page would simply not be
				 * installable — and neither one says anything a stranger does not already know from the
				 * door page. There is no service worker: nothing here is worth caching, and a stale copy of
				 * a front end whose only job is to be live is worse than no copy at all. What this buys is
				 * the part that matters on a phone: an icon on the home screen and a window with no browser
				 * chrome eating a fifth of the screen.
				 */
				// Behind the same "did another site start this" lock as everything else. A browser fetching a
				// manifest or an icon for this page says same-origin; an <img> on someone else's page probing
				// a port range says cross-site, and would otherwise learn from the load that this is here.
				if ((url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg") && placeRefused(facts, CHECK)) {
					return void res.writeHead(403).end();
				}
				if (url.pathname === "/manifest.webmanifest") {
					res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8" });
					return void res.end(
						JSON.stringify({
							name: "pi-loops",
							short_name: "pi-loops",
							start_url: "/",
							scope: "/",
							display: "standalone",
							background_color: "#000000",
							theme_color: "#000000",
							icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
						}),
					);
				}
				if (url.pathname === "/icon.svg") {
					res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "max-age=86400" });
					return void res.end(ICON);
				}
				/*
				 * The device cookie and the secret this origin keeps, for the token: how a page served
				 * without the token gets it. The secret rides in a header no other site can set without a
				 * preflight this server never answers, and only the page's own origin can read it.
				 */
				if (prefixed && route === "/token" && req.method === "POST") {
					const refused = placeRefused(facts, CHECK);
					if (refused) return void json(res, { error: refused.why }, refused.status);
					if (pathId === null) return void json(res, NO_SUCH, 404);
					const secret = req.headers["x-pi-web-device-secret"];
					const traded = devices.trade(facts.device, typeof secret === "string" ? secret : undefined);
					if ("ok" in traded) return void json(res, { token: TOKEN });
					// This browser's cookie is no good any more: clear it, so its next load is the door.
					res.appendHeader("set-cookie", `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
					return void json(res, { error: traded.why }, traded.status);
				}
				/*
				 * What a browser fetches by address and cannot add a header to: the event stream, a file,
				 * a preview. Each takes a key minted for it at /key, and nothing else: no cookie, no
				 * ?token=, which would sit in a URL that a preview can read.
				 */
				const keyed: KeyKind | undefined =
					req.method !== "GET" ? undefined : prefixed && route === "/events" ? "events" : prefixed && route === "/file" ? "file" : !prefixed && url.pathname.startsWith("/preview/") ? "preview" : undefined;
				if (keyed) {
					const refused = placeRefused(facts, CHECK);
					if (refused) return void json(res, { error: refused.why }, refused.status);
					const key = url.searchParams.get("key");
					if (!key) return void json(res, { error: "no key" }, 401);
					const ask = keyed === "preview" ? { kind: keyed, path: url.pathname.slice("/preview/".length) } : { kind: keyed, sessionId: pathId ?? undefined, path: keyed === "file" ? (url.searchParams.get("path") ?? "") : undefined };
					if (!urlKeys.spend(key, ask)) return void json(res, { error: "bad key" }, 403);
				}
				// The Background view is read-only and has no token in it: a browser that paired may look.
				const view = !prefixed && req.method === "GET" && (url.pathname === "/background" || url.pathname === "/background.json");
				const verdict = keyed || (view && !placeRefused(facts, CHECK) && devices.known(facts.device)) ? undefined : checkRequest(facts, CHECK);
				if (verdict && !("ok" in verdict)) return void json(res, { error: verdict.why }, verdict.status);
				// Before any body is read: a form post from another site can only send a few content types,
				// and this one is not among them.
				// Stop it, on the waiting page, posts nothing: it has no body and so no content type.
				if (req.method === "POST" && route !== "/stop-turn" && !/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] ?? "")))
					return void json(res, { error: "a post must be application/json" }, 415);

				if (route === "/preview" && req.method === "POST") {
					// HTML the model wrote into the conversation rather than into a file. Held in memory,
					// briefly, and served under the same sandbox as anything else here.
					const { html } = await body(req);
					const text = String(html ?? "");
					if (text.length > PREVIEW_MAX_BYTES) return void json(res, { success: false, error: "too big to preview" }, 413);
					const id = randomBytes(9).toString("hex");
					previews.set(id, { html: text, at: Date.now() });
					// Two rules, said separately, because one of them used to be written as a condition inside a
					// loop over the Map and depended on it shrinking as it was walked.
					for (const [key, v] of previews) if (Date.now() - v.at > PREVIEW_TTL_MS) previews.delete(key);
					while (previews.size > PREVIEW_KEEP) previews.delete(previews.keys().next().value as string);
					return void json(res, { success: true, id });
				}
				if (url.pathname.startsWith("/preview/") && req.method === "GET") {
					const found = previews.get(url.pathname.slice("/preview/".length));
					if (!found) return void res.writeHead(404).end("that preview has expired");
					res.writeHead(200, {
						"content-type": "text/html; charset=utf-8",
						"x-content-type-options": "nosniff",
						"cache-control": "no-store",
						"content-security-policy": "sandbox allow-scripts",
						"referrer-policy": "no-referrer",
					});
					return void res.end(found.html);
				}
				if (route === "/pair" && req.method === "POST") {
					// Behind the token, so this is a browser that is already in asking for a code for the next
					// device. It replaces any outstanding one and resets the guess budget with it.
					if ((await body(req)).cancel) {
						// The dialog was closed. A code left armed and forgotten is the thing to avoid.
						clearPairCode();
						return void json(res, { success: true });
					}
					// Which addresses that device could actually use. The page knows the one it reached this
					// server on — which is the right answer under `tailscale serve` — and this adds the ones
					// only the machine can see. A loopback-only server has none, and the page says so.
					const port = (server.address() as AddressInfo | null)?.port ?? PORT;
					const addresses = LOOPBACK ? [] : lanAddresses(port);
					return void json(res, { success: true, code: newPairCode(), expiresIn: Math.round(PAIR_TTL_MS / 1000), addresses });
				}
				if (route === "/stop-turn" && req.method === "POST") {
					if (!pathId) return void json(res, NO_SUCH, 404);
					// The turn pi-loops runs here, or, before it says which, the run its lease names: it takes
					// the lease, then claims the job. A delivery has no run to stop and ends on its own.
					const held = opts.heldTurn?.(pathId);
					const holder = held ? undefined : opts.sessions.known(pathId)?.holder;
					const runId = held?.runId ?? (holder?.kind === "host" && holder.busy && holder.busy.jobId !== DELIVERY_JOB_ID ? holder.busy.runId : undefined);
					if (runId) opts.abortRun?.(runId);
					// No redirect: the button's fetch would follow it with the token, and the page reloads itself.
					return void res.writeHead(204, { "cache-control": "no-store" }).end();
				}
				if (view) {
					if (!opts.background) return void json(res, { error: "not found" }, 404);
					return void background(res, opts.background, url.pathname === "/background" ? "html" : "json");
				}
				// The conversation list: a file read behind the token. No device-cookie exemption, as the
				// Background view has: its titles are what people typed.
				if (!prefixed && url.pathname === "/conversations" && req.method === "GET") {
					const listed = conversationList(url.searchParams.get("cwd"), url.searchParams.get("session"));
					return void json(res, listed.body, listed.status);
				}
				if (pathId == null) return void json(res, prefixed ? NO_SUCH : { error: "not found" }, 404);
				if (route === "/key" && req.method === "POST") {
					// Behind the token, like every post: a key is a way to reach one address without it.
					const b = await body(req);
					const kind = b?.for;
					if (!KEY_KINDS.includes(kind)) return void json(res, { error: "a key is for events, a file or a preview" }, 400);
					if (kind !== "events" && (typeof b.path !== "string" || !b.path)) return void json(res, { error: `a ${kind} key needs its path` }, 400);
					return void json(res, { key: urlKeys.mint(pathId, kind, kind === "events" ? undefined : b.path) });
				}
				const opened = await conversation(pathId);
				if ("status" in opened) return void json(res, opened.body, opened.status);
				const child = opened.child;
				const touch = () => {
					const key = pool.keyOf(child);
					if (key !== undefined) pool.touch(key);
				};
				touch();
				if (route === "/events" && req.method === "GET") {
					// One person, a few tabs; a few conversations. An unbounded set is a way to run this
					// process out of memory.
					if (child.clients.size >= PAGE_STREAMS_PER_CHILD || clients() >= PAGE_STREAMS_TOTAL) return void json(res, { error: "too many event streams open" }, 429);
					res.on("error", guard(opts.log, "stream error", () => child.clients.delete(res)));
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
					res.write(": connected\n\n");
					// A browser opened mid-session still needs what already happened. A dialog is replayed only
					// while pi still waits for its answer, with the time it has left: one pi already answered by its
					// timeout would come back with a full countdown, and an approve would go nowhere.
					for (const e of child.backlog) {
						const ask = isDialog(e) ? child.live.pendingAsks.get(e.id) : undefined;
						if (isDialog(e) && !ask) continue;
						const out = ask?.expiresAt === undefined ? e : { ...e, timeout: Math.max(1, ask.expiresAt - Date.now()) };
						res.write(`data: ${JSON.stringify(out)}\n\n`);
					}
					child.clients.add(res);
					const keepAlive = setInterval(
						guard(opts.log, "keep-alive", () => res.write(": ping\n\n")),
						25_000,
					);
					req.on(
						"close",
						guard(opts.log, "stream closed", () => {
							clearInterval(keepAlive);
							child.clients.delete(res);
							touch();
						}),
					);
					return;
				}
				if (route === "/state" && req.method === "GET") return void json(res, await snapshot(child));
				if (route === "/history" && req.method === "GET") {
					const r = await child.rpc({ type: "get_messages" }, 20_000);
					// The number of the last event that happened before this transcript was taken.
					return void json(res, { messages: r?.success ? (r.data?.messages ?? []) : [], seq: child.eventSeq, epoch: child.epoch });
				}
				if (route === "/prompt" && req.method === "POST") {
					const { text, images, mode } = await body(req);
					if (!text && !(images ?? []).length) return void json(res, { success: false, error: "empty prompt" }, 400);
					const guard = commandRefusal(text ?? "", child);
					if (guard) return void json(res, guard, 400);
					const message = expandMentions(text ?? "", child.sessionCwd);
					if (message.trimStart().startsWith("/") || mode === "steer") {
						// A command acts on the process and may sit in a dialog for minutes; a steer belongs to
						// the turn that is running. Neither is queued content, so both stay rpc `prompt`: pi
						// runs an extension command at once even while streaming, and queues a steer behind
						// the turn (docs/web-ui-parity.md). pi answers a prompt command when the command has
						// *finished*, and a slash command may wait on a person for as long as a setup script
						// takes to read. Sixty seconds reported that as "timed out" while the command went on
						// to succeed.
						const patience = mode === "steer" ? undefined : 15 * 60_000;
						const answer = await child.rpc({ type: "prompt", message, streamingBehavior: mode === "steer" ? "steer" : "followUp", ...(images?.length ? { images } : {}) }, patience);
						// A command can change what is loaded (`/reload`): the next chat message is routed on a
						// list asked for after it, not before.
						if (mode !== "steer") child.refreshCommands().catch((err) => opts.log(`pi-loops web: commands: ${err?.message ?? err}`));
						return void json(res, answer);
					}
					// No pi-loops in this pi (older than the floor, a load error, extensions off): nobody would
					// drain a row, and the ring would reach the model as text. The text goes to pi, as before 0.24.
					if (child.catalog.piLoopsLoaded === undefined || Date.now() - child.catalog.commandsAt > COMMANDS_TTL_MS) await child.refreshCommands();
					if (!child.catalog.piLoopsLoaded) return void json(res, await child.rpc({ type: "prompt", message, streamingBehavior: "followUp", ...(images?.length ? { images } : {}) }));
					// Chat text is a request row (docs/design.md decision 23): it waits in the file, visible and
					// cancellable, until the pi holding the session is idle, survives Esc and pi exiting, and
					// runs in one order with what pi-loops addressed to the conversation. The ring is the bell
					// and the proof of who wrote it; the drain that answers it hands the row over if pi is idle.
					if (!child.sessionId) await snapshot(child);
					if (!child.sessionId) return void json(res, { success: false, error: "pi is not running" }, 503);
					// The bytes go to a file of their own; what reaches the file is checked here, at the edge.
					const attached = Array.isArray(images) && images.length ? images : undefined;
					if (attached && !attached.every((i) => i && typeof i === "object" && i.type === "image" && typeof i.data === "string" && typeof i.mimeType === "string")) return void json(res, { success: false, error: "bad image" }, 400);
					const row = personRow(randomUUID(), message, attached, { sessionId: child.sessionId, cwd: child.sessionCwd, createdBy: signed(child) });
					requests.append(row, attached);
					const holder = holderNow(child.sessionId, child);
					ring(child, row.id, requestFingerprint(row)).catch((err) => opts.log(`pi-loops web: ring: ${err?.message ?? err}`));
					// Owner decision O2: a terminal that holds the session and delivers answers the row. One
					// that holds it and cannot (standing aside, a one-shot run) is passed over: the page's own
					// pi runs the row (src/engine.ts), unless it is the one standing aside, in which case nothing
					// may write into the conversation until it is resumed, and the page says so.
					const where = holder && !holder.mine && holder.delivers ? { elsewhere: { pid: holder.pid } } : holder?.mine && holder.aside ? { aside: { pid: holder.pid } } : {};
					return void json(res, { success: true, queued: row.id, ...where });
				}
				if (route === "/model" && req.method === "POST") {
					// Recorded below, once pi has accepted it.
					// The catalog is rendered as `provider/id`; the command takes the two halves.
					const { model } = await body(req);
					const cut = String(model ?? "").indexOf("/");
					if (cut < 1) return void json(res, { success: false, error: "model must be provider/id" }, 400);
					const answer = await child.rpc({ type: "set_model", provider: model.slice(0, cut), modelId: model.slice(cut + 1) }, 20_000);
					// A different model has a different set of thinking levels; the picker must follow it.
					if (answer?.success) {
						await child.refreshCatalog();
						rememberPref("model", String(model));
					}
					return void json(res, answer);
				}
				if (route === "/thinking" && req.method === "POST") {
					const { level } = await body(req);
					const answer = await child.rpc({ type: "set_thinking_level", level });
					if (answer?.success) rememberPref("thinking", String(level));
					return void json(res, answer);
				}
				if (route === "/complete" && req.method === "POST") {
					const { text } = await body(req);
					return void json(res, { items: complete(text, child.sessionCwd, child) });
				}
				/**
				 * A file the session made, so you can look at it instead of at its source.
				 *
				 * Everything about this route is about not turning "show me that chart" into "run whatever
				 * the model wrote". It is anchored inside the session's own directory, the extensions it
				 * serves are a list rather than anything on disk, and every response is sandboxed — an
				 * opaque origin, which is what stops an HTML file the model wrote from turning round and
				 * driving the session with the cookie that fetched it.
				 */
				if (route === "/file" && req.method === "GET") {
					const wanted = url.searchParams.get("path") ?? "";
					const file = path.resolve(child.sessionCwd, wanted.startsWith("~/") ? path.join(os.homedir(), wanted.slice(2)) : wanted);
					const root = previewRoot(file, child);
					if (!root) return void res.writeHead(403).end("outside the session directory and your home directory");
					// A dot segment is where secrets live — .ssh, .env, .claude/.credentials.json — and
					// nothing anybody wants to *look at* begins with one. Checked on the path the filesystem
					// resolves to, not the one that was asked for: membership is decided after symlinks are
					// followed, and a rule applied before them is a rule with a door next to it. A link at
					// ~/Documents/cfg pointing into ~/.config is how that door gets used.
					const real = realpathish(file);
					const rel = path.relative(realpathish(root), real);
					if (rel.split(path.sep).some((seg) => seg.startsWith(".")) || isUnder(file, LOOPS_DIR)) {
						return void res.writeHead(403).end("not a file this previews");
					}
					const type = PREVIEW_TYPES[path.extname(real).toLowerCase()];
					if (!type) return void res.writeHead(415).end("not a kind of file this previews");
					// Outside the session's own directory, only things one *looks* at. A home directory holds
					// service-account keys named like ordinary JSON and password exports named like ordinary
					// CSV, and neither is a thing anybody previews — while a picture or a page is exactly
					// what an agent leaves in Downloads for a person to open.
					const inSessionDir = isUnder(file, child.sessionCwd);
					if (!inSessionDir && !VISUAL_TYPES.has(path.extname(real).toLowerCase())) {
						return void res.writeHead(415).end("outside the session directory, only pictures, PDFs and pages are shown");
					}
					// Opened once, and everything after this is about that one open file — not about the
					// name, which the session is free to point somewhere else in between.
					// Non-blocking: open(2) on a FIFO with no writer waits for one, and this is the event loop of
					// the process that runs every loop, rule and conversation. A FIFO then opens at once and is
					// refused below as not a file; a regular file reads as it always does.
					let fd;
					try {
						fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
					} catch {
						return void res.writeHead(404).end("no such file");
					}
					const stat = fs.fstatSync(fd);
					if (!stat.isFile()) {
						fs.closeSync(fd);
						return void res.writeHead(404).end("not a file");
					}
					if (stat.size > PREVIEW_MAX_BYTES) {
						fs.closeSync(fd);
						return void res.writeHead(413).end("too big to preview");
					}
					res.writeHead(200, {
						"content-type": type,
						"content-length": stat.size,
						"x-content-type-options": "nosniff",
						"cache-control": "no-store",
						/*
						 * An opaque origin: no cookie of ours is attached to anything it asks for, and it has
						 * no same-origin access to this server. On top of that it may not fetch anything,
						 * which is what stops a page from carrying its contents somewhere else — and scripts
						 * run only for the session's own files. `~/Downloads` is where a browser puts what
						 * the web gave you, and running that under an address you trust is not previewing.
						 */
						"content-security-policy": [
							inSessionDir ? "sandbox allow-scripts" : "sandbox",
							"default-src 'none'",
							"img-src data: blob:",
							"style-src 'unsafe-inline'",
							inSessionDir ? "script-src 'unsafe-inline'" : "script-src 'none'",
							"font-src data:",
						].join("; "),
						// It chooses its own referrer policy otherwise, and this address is our address.
						"referrer-policy": "no-referrer",
						"content-disposition": "inline",
					});
					// A read that fails (a vanished mount, EIO) ends this answer, not the process.
					return void fs
						.createReadStream(file, { fd })
						.on("error", (err) => {
							opts.log(`pi-loops web: reading ${file}: ${err.message}`);
							res.destroy();
						})
						.pipe(res);
				}
				if (route === "/abort" && req.method === "POST") {
					return void json(res, await child.rpc({ type: "abort" }));
				}
				if (route === "/compact" && req.method === "POST") {
					// What survives compaction is worth steering — "keep the API shapes, drop the search" is
					// the difference between a summary you can work from and one you have to undo. pi takes
					// the instructions the way `/compact <text>` does in the terminal.
					const { instructions } = await body(req);
					const custom = String(instructions ?? "").trim();
					return void json(res, await child.rpc({ type: "compact", ...(custom ? { customInstructions: custom.slice(0, 2000) } : {}) }, 300_000));
				}
				if (route === "/sessions" && req.method === "GET") {
					await snapshot(child); // whichever file pi is writing now is what the list is anchored to
					return void json(res, { sessions: child.listSessionsHere(), dir: child.sessionsDir() });
				}
				if (route === "/session/new" && req.method === "POST") {
					await snapshot(child);
					const answer = await child.swapSession(child.newSessionPath());
					// The pool re-keys the child to the new id and its pages are told, before this answers.
					await snapshot(child);
					return void json(res, answer);
				}
				if (route === "/session/switch" && req.method === "POST") {
					const { file } = await body(req);
					await snapshot(child);
					// The list this came from is the only place it may point: a path from the browser is not
					// a reason to open a file anywhere on the disk, and `switch_session` on something that is
					// not a session is how you get an empty session written over it.
					const wanted = typeof file === "string" ? path.resolve(file) : "";
					const match = child.listSessionsHere().find((s) => path.resolve(s.file) === wanted);
					if (!match) return void json(res, { success: false, error: "no session of this project has that path" }, 400);
					// One child per conversation: a conversation open in another child is opened there.
					const other = typeof match.id === "string" ? pool.get(match.id) : undefined;
					if (other && other !== child) return void json(res, { success: false, error: "that conversation is already open in the page", url: `/c/${encodeURIComponent(match.id)}/` }, 409);
					// The resolved path, which is the one that was checked: pi's cwd is not this process's,
					// so a relative path would be checked here and opened somewhere else.
					const answer = await child.swapSession(path.resolve(match.file), { restoreModel: true });
					await snapshot(child);
					return void json(res, answer);
				}
				if (route === "/queue/clear" && req.method === "POST") {
					// Everything "queued N ✕" counts: every input row, the person's and pi-loops', as each one's
					// own ✕ would cancel it, and what pi itself still holds (a steer, a command).
					const sid = child.sessionId;
					if (sid && child.catalog.piLoopsLoaded !== false) {
						for (const row of requests.list(sid)) if (row.kind === "input") requests.append(cancelRow(sid, { id: row.id }, "person", signed(child)));
						ring(child).catch((err) => opts.log(`pi-loops web: ring: ${err?.message ?? err}`));
					}
					return void json(res, await child.rpc({ type: "clear_queue" }));
				}
				if (route === "/queue/send-here" && req.method === "POST") {
					// A message of this page nobody took (`untaken`): out of the queue, audited, and sent to the
					// pi behind this page over rpc `prompt`, as every message went before 0.24. Removed here
					// rather than by a cancel row, since the point is that nobody is draining the rows.
					const { id } = await body(req);
					if (child.catalog.piLoopsLoaded === false) return void json(res, { success: false, error: NO_PI_LOOPS }, 400);
					if (!ROW_ID.test(id ?? "") || !child.sessionId) return void json(res, { success: false, error: "bad id" }, 400);
					const row = requests.list(child.sessionId).find((r) => r.id === id && r.kind === "input" && r.source === "person" && mine(r, child));
					if (!row) return void json(res, { success: false, error: "not queued" }, 404);
					const holder = holderNow(child.sessionId, child);
					if (holder?.mine && holder.aside) return void json(res, { success: false, error: "this page's pi shows an older copy of this conversation and reads it again once it is idle; send it then" }, 409);
					const images = imagesOf(row);
					// The check and the removal are one critical section: a holder that stamps the row handed
					// over in between keeps it, and this answers 409 instead of answering the message twice.
					const taken = requests.removeIf(child.sessionId, row.id, (r) => r.handed_at === undefined && mine(r, child));
					if (taken.outcome !== "removed") return void json(res, { success: false, error: taken.outcome === "kept" ? "already handed to pi" : "not queued" }, taken.outcome === "kept" ? 409 : 404);
					audit.appendAudit({ cwd: row.payload?.cwd ?? "", type: "request", traceId: row.id, state: "cancelled", sourceLabel: row.source, eventLabel: child.sessionId, details: { session_id: child.sessionId, kind: row.kind, sent: "over rpc, from the page" } });
					return void json(res, await child.rpc({ type: "prompt", message: row.payload?.text ?? "", streamingBehavior: "followUp", ...(images.length ? { images } : {}) }));
				}
				if (route === "/queue/cancel" && req.method === "POST") {
					// A cancel is a row too: the holder removes the queued row and audits it, whoever holds the
					// session. Discarding a message a previous page left behind is the same request.
					const { id } = await body(req);
					if (child.catalog.piLoopsLoaded === false) return void json(res, { success: false, error: NO_PI_LOOPS }, 400);
					if (!ROW_ID.test(id ?? "") || !child.sessionId) return void json(res, { success: false, error: "bad id" }, 400);
					if (!requests.list(child.sessionId).some((row) => row.id === id && row.kind === "input")) return void json(res, { success: false, error: "not queued" }, 404);
					requests.append(cancelRow(child.sessionId, { id }, "person", signed(child)));
					ring(child).catch((err) => opts.log(`pi-loops web: ring: ${err?.message ?? err}`));
					return void json(res, { success: true });
				}
				if (route === "/queue/send" && req.method === "POST") {
					// A message a previous page left queued ("not sent before pi stopped") becomes this page's,
					// under the lock, and is rung for. Only a person row: the ring is what makes a row believed as
					// typed here, and the page owns no other kind.
					const { id } = await body(req);
					if (child.catalog.piLoopsLoaded === false) return void json(res, { success: false, error: NO_PI_LOOPS }, 400);
					if (!ROW_ID.test(id ?? "") || !child.sessionId) return void json(res, { success: false, error: "bad id" }, 400);
					const sid = child.sessionId;
					const person = (row: any) => row.kind === "input" && row.source === "person" && row.id === id;
					if (requests.list(sid).some(person)) requests.update(sid, id, { created_by: signed(child) });
					const row = requests.list(sid).find(person);
					if (!row) return void json(res, { success: false, error: "not queued" }, 404);
					ring(child, row.id, requestFingerprint(row)).catch((err) => opts.log(`pi-loops web: ring: ${err?.message ?? err}`));
					return void json(res, { success: true, sent: row.id });
				}
				if (route === "/trigger/immediate" && req.method === "POST") {
					// "Run now" on a job. pi-loops exposes it as a command, and a command is a prompt here.
					const { id } = await body(req);
					if (!/^[A-Za-z0-9_-]{1,80}$/.test(id ?? "")) return void json(res, { success: false, error: "bad id" }, 400);
					const command = id.startsWith("dyn-") ? `/triggers run ${id}` : `/cron run ${id}`;
					return void json(res, await child.rpc({ type: "prompt", message: command }));
				}
				if (route === "/stats" && req.method === "GET") {
					// The cost, and the context gauge the terminal footer shows.
					const r = await child.rpc({ type: "get_session_stats" }, 20_000);
					return void json(res, r?.success ? r.data : { error: r?.error });
				}
				if (route === "/find" && req.method === "POST") {
					// Find. `get_entries` is the whole tree, so this searches abandoned branches and
					// pre-compaction history too, which is exactly what you want when looking for something
					// you remember saying.
					const { q } = await body(req);
					const needle = String(q ?? "").toLowerCase();
					if (needle.length < 2) return void json(res, { hits: [] });
					const r = await child.cachedEntries();
					const hits = [];
					for (const e of r?.success ? (r.data?.entries ?? []) : []) {
						const m = e?.message;
						if (!m) continue;
						const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? c.thinking ?? "").join(" ");
						const at = text.toLowerCase().indexOf(needle);
						if (at === -1) continue;
						hits.push({ role: m.role, when: e.timestamp, excerpt: text.slice(Math.max(0, at - 60), at + 140) });
						if (hits.length >= 50) break;
					}
					return void json(res, { hits });
				}
				if (route === "/undo" && req.method === "POST") {
					// Undo: fork from the last user message on this branch. pi hands back its text, so
					// the prompt returns to the composer rather than being lost.
					const r = await child.cachedEntries();
					if (!r?.success) return void json(res, { success: false, error: r?.error ?? "cannot read the session" }, 500);
					const entries = r.data?.entries ?? [];
					const last = [...entries].reverse().find((e) => e?.type === "message" && e.message?.role === "user");
					if (!last) return void json(res, { success: false, error: "nothing to undo" }, 400);
					const forked = await child.rpc({ type: "fork", entryId: last.id }, 30_000);
					child.entriesCache = { at: 0, value: undefined }; // the branch moved under us
					return void json(res, forked);
				}
				if (route === "/share" && req.method === "POST") {
					// pi-loops' command does the rendering, the redaction and the confirmation; its dialog
					// reaches the browser as an extension_ui_request like every other approval. It blocks on
					// that dialog, so this must not sit on a short timeout waiting for an answer.
					const { public: isPublic } = await body(req);
					if (!child.catalog.commandList.some((c) => c.name === "session-share")) return void json(res, { success: false, error: "pi-loops is not loaded in this session" }, 400);
					return void json(res, await child.rpc({ type: "prompt", message: isPublic ? "/session-share --public" : "/session-share" }, 600_000));
				}
				if (route === "/export" && req.method === "POST") {
					// Save. pi writes the HTML itself; this only reports where it landed.
					return void json(res, await child.rpc({ type: "export_html" }, 60_000));
				}
				if (route === "/ui-response" && req.method === "POST") {
					// Named fields only: spreading the body would let the caller set `type` and write any
					// command it liked to pi's stdin through a route that is meant to answer a dialog.
					const { id, value, confirmed, cancelled } = await body(req);
					if (typeof id !== "string" || !id) return void json(res, { error: "id required" }, 400);
					child.live.pendingAsks.delete(id);
					const answer: Record<string, unknown> = { type: "extension_ui_response", id };
					if (cancelled === true) answer.cancelled = true;
					else if (typeof confirmed === "boolean") answer.confirmed = confirmed;
					else if (value !== undefined) answer.value = String(value);
					child.writeToPi(`${JSON.stringify(answer)}\n`);
					return void json(res, { ok: true });
				}
				if (route === "/rpc" && req.method === "POST") {
					// Escape hatch: anything in pi's protocol this UI has not grown a button for yet.
					const command = await body(req);
					const type = String(command?.type ?? "");
					if (OWN_ROUTES.has(type)) return void json(res, { success: false, error: `${type} has a route of its own` }, 400);
					if (NO_ROUTE_AT_ALL.has(type)) return void json(res, { success: false, error: `${type} would replace the session the attached browsers are watching; switch sessions with /switch_session` }, 400);
					return void json(res, await child.rpc(command));
				}
				json(res, { error: "not found" }, 404);
			} catch (err: any) {
				json(res, { error: String(err?.message ?? err) }, 500);
			}
		}),
	);

	/** The last 64 KB of a file in the loops directory, newest line first; [] when there is none. */
	function tailLines(name: string) {
		try {
			const fd = fs.openSync(path.join(LOOPS_DIR, name), "r");
			try {
				const size = fs.fstatSync(fd).size;
				const len = Math.min(size, 64 * 1024);
				const buf = Buffer.alloc(len);
				fs.readSync(fd, buf, 0, len, size - len);
				return buf.toString("utf8").split("\n").reverse();
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return []; // no such file yet
		}
	}

	/**
	 * This project's latest rule check, from the tail of `triggers-audit.jsonl`. Checks run in the
	 * background, so their results no longer reach this session, where the "last check" line came from.
	 */
	function lastCheckIn(cwd: string) {
		for (const line of tailLines("triggers-audit.jsonl")) {
			let r;
			try {
				r = JSON.parse(line);
			} catch {
				continue; // the first line of the tail is usually cut
			}
			if (r && r.type === "trigger_result" && r.sourceLabel === "local:dynamic" && r.state !== "running" && typeof r.cwd === "string" && sameProject(r.cwd, cwd)) return { state: String(r.state), at: r.ts ?? r.at };
		}
		return undefined;
	}

	/**
	 * This project's latest loop run, from the tail of `runs.jsonl`. When loops ran in the window, each
	 * run left an entry in its session and the panel showed it; they run in the background now, and
	 * the run log is where the news is.
	 */
	function lastRunIn(cwd: string) {
		let text = "";
		try {
			const fd = fs.openSync(path.join(LOOPS_DIR, "runs.jsonl"), "r");
			try {
				const size = fs.fstatSync(fd).size;
				const len = Math.min(size, 64 * 1024);
				const buf = Buffer.alloc(len);
				fs.readSync(fd, buf, 0, len, size - len);
				text = buf.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return undefined; // no run log yet
		}
		const lines = text.split("\n").reverse();
		for (const line of lines) {
			let r;
			try {
				r = JSON.parse(line);
			} catch {
				continue; // the first line of the tail is usually cut, and a torn last line is possible
			}
			if (r && r.stateful && typeof r.cwd === "string" && sameProject(r.cwd, cwd)) return { label: r.jobName || String(r.jobId).slice(0, 13), ok: !!r.ok, at: r.finishedAt, findings: r.findings ?? 0 };
		}
		return undefined;
	}

	/**
	 * Where another conversation's plain job runs, read the way the terminal's `/cron` reads it
	 * (src/job-owner.ts): the conversation's lease names the process holding it — a window, or pi-loops
	 * answering in it — and a closed conversation whose file pi-loops knows runs in the background. Undefined
	 * for this conversation's own jobs. The panel used to say "resume it to run" for all of them.
	 */
	function plainJobWhere(j: any, currentSession: any, hostUp: boolean, paused: any) {
		if (currentSession && j.sessionId === currentSession) return undefined;
		const sid = "session " + String(j.sessionId || "?").slice(0, 8);
		const id = String(j.sessionId || "");
		const lease = SAFE_SESSION_ID.test(id) && !id.includes("..") ? readJson(path.join(LOOPS_DIR, "leases", id + ".json"), undefined) : undefined;
		const holder = lease && lease.holder;
		if (holder && pidAlive(holder.pid)) return holder.kind === "host" ? sid + " — runs in the background" : sid + " — open in pid " + holder.pid;
		if (lease && lease.sessionFile && fs.existsSync(lease.sessionFile)) return hostUp ? sid + " — runs in the background" : sid + " — paused: " + paused;
		return sid + " — resume it to run";
	}

	/** Whether a plain job has a next run anywhere: here, in another window, or in pi-loops. */
	function plainJobRuns(j: any, currentSession: any, hostUp: boolean, paused: any) {
		const where = plainJobWhere(j, currentSession, hostUp, paused);
		return where === undefined || !(where.endsWith("resume it to run") || where.includes(" — paused: "));
	}

	const port = () => (server.address() as AddressInfo | null)?.port ?? PORT;
	const api: PageServer = {
		url: () => `http://${LOOPBACK ? "127.0.0.1" : HOST_BIND === "0.0.0.0" ? "127.0.0.1" : HOST_BIND}:${port()}/`,
		port,
		newPairCode,
		openKeyFor,
		openFileFor,
		clients,
		close: () => {
			server.close();
			for (const key of [...openKeys.keys()]) dropOpenKey(key);
		},
	};
	return new Promise((resolve) => {
		server.on("error", guard(opts.log, "listen", opts.onListenError));
		server.listen(PORT, HOST_BIND, () => resolve(api));
	});
}
