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
import { cancelRow, personRow, queueOrder, requestFingerprint } from "./engine.ts";
import { holderAlive, holderDelivers, LeaseStore, procStart } from "./lease.ts";
import { pidAlive } from "./lock.ts";
import { COMMANDS_TTL_MS, isDialog, maskSecrets, NO_PI_LOOPS, type PageChild, readHead } from "./page-children.ts";
import { realpathish } from "./paths.ts";
import { RequestStore } from "./requests.ts";
import { TriggerStore } from "./triggers.ts";
import { writeUiPref } from "./ui-prefs.ts";
import { DOOR, ICON, PAGE } from "./web.mjs";
import { producerAlive } from "./window-executor.ts";

export interface PageServerOptions {
	dir: string;
	bind: { host: string; port: number };
	allowHosts: string[];
	noAuth: boolean;
	token: string;
	version: string;
	child: () => PageChild;
	log: (line: string) => void;
	onListenError: (err: NodeJS.ErrnoException) => void;
}

export interface PageServer {
	url(): string;
	port(): number;
	newPairCode(): string;
	armOpenKey(): string;
	close(): void;
}

const COOKIE = "pi_web_token";

/**
 * The token is kept in a file rather than made fresh each launch, so the address stays the same
 * one every time: bookmark http://127.0.0.1:4173/ and it works tomorrow. It is a boring secret —
 * 0600 in the loops directory, next to the jobs it lets you run — and it exists because anything
 * that reaches /rpc gets the whole session, including any *website* you happen to have open (a
 * page cannot read this server's answers, but without a check it could still tell your agent what
 * to do). You will not have to type it: the browser gets a cookie on the first visit.
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

/** This process, as the rows it writes name it: a row is sent only while it lives (docs/design.md decision 23). */
const OWN_START = procStart(process.pid);
const mine = (row: any, child: PageChild) => row.created_by.pid === process.pid && row.created_by.instance === child.instance;
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
	if (holder.mine && holder.aside) return { pid, line: notTaken("this page's pi shows an older copy of this conversation; /resume to see it") };
	if (holder.aside) return { pid, line: notTaken("shows an older copy of this conversation"), button: sendHere };
	if (!holder.delivers) return { pid, line: notTaken("a non-interactive pi"), button: sendHere };
	if (holder.mine) return { pid, line: notTaken("this page's pi did not take it"), button: sendHere };
	return { pid, line: `pi ${pid} holds this conversation and has not taken it yet (it may be busy)`, button: `answer here instead (a branch pi ${pid} will not see)` };
}

/* ------------------------------------------------------------------ http */

/** A Host that is an address rather than a name: nothing to re-resolve, so nothing to rebind. */
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\])$/;
/**
 * Where the connection actually came from, for the tailnet case. `tailscale serve` proxies to
 * loopback, so a genuine one arrives on a local socket; a direct connection to the tailnet address
 * arrives from 100.64/10, which is the range Tailscale hands out. A `.ts.net` Host from anywhere
 * else is a name pointed at this machine by someone, which is the thing the check is for.
 */
function fromTailnet(req: http.IncomingMessage) {
	const from = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
	if (from === "127.0.0.1" || from === "::1") return true;
	const octets = from.split(".").map(Number);
	return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * The cookie the page was given on its first visit. `SameSite=Strict` is the point of it: a browser
 * does not attach it to anything another site initiated, not even a top-level link, so it opens
 * this server to the tab you opened yourself and to nothing else.
 */
function cookieToken(req: http.IncomingMessage) {
	for (const part of String(req.headers.cookie ?? "").split(";")) {
		const cut = part.indexOf("=");
		if (cut > 0 && part.slice(0, cut).trim() === COOKIE) return part.slice(cut + 1).trim();
	}
	return undefined;
}

/**
 * The browser says who started the request, and it is not something a page can lie about. It costs
 * nothing and it is the only lock left standing under `--no-auth`, where a form post from any site
 * would otherwise reach /prompt — a page cannot read the answer, but it does not need to. Absent
 * from curl and from older browsers, so its absence cannot be treated as a failure.
 */
function crossSite(req: http.IncomingMessage) {
	const site = req.headers["sec-fetch-site"];
	// "same-site" is not the same as "same origin": a cookie's SameSite is scoped to the site, and a
	// site ignores the port — http://localhost:5173, which is any Vite dev server on this machine,
	// is the same site as this one and its pages are handed the cookie. Those are the pages most
	// likely to exist and to be attacked, so same-site is a no, not a yes.
	if (site === "cross-site" || site === "same-site") return true;
	// A browser that does not send that header still sends Origin on anything that could do harm.
	const origin = req.headers.origin;
	// "null" is what an opaque origin sends — a sandboxed document, which is exactly what the file
	// previews are served as. Treating it as same-site would let one of them back in on a browser
	// that sends no Sec-Fetch-Site.
	if (origin === "null") return true;
	if (!origin) return false;
	try {
		return new URL(origin).host !== req.headers.host;
	} catch {
		return true; // an Origin that is not a URL is not one this server put there
	}
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

export function startPageServer(opts: PageServerOptions): Promise<PageServer> {
	const LOOPS_DIR = opts.dir;
	const TOKEN = opts.token;
	const VERSION = opts.version;
	const NO_AUTH = opts.noAuth;
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
	const createdBy = (child: PageChild) => ({ pid: process.pid, instance: child.instance, procStart: OWN_START, version: VERSION });

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
		return { pid: holder.pid, mine: holder.pid === child.pid, aside: holder.aside === true, delivers: holderDelivers(holder) };
	}

	/** The child's `get_state`, with the request rows and the panel this side reads from disk. */
	function snapshot(child: PageChild) {
		return child.snapshot({ requests: (sessionId, idle) => queuedRequests(sessionId, idle, child), automation: (cwd, sessionId) => automation(cwd, sessionId, child) });
	}

	/**
	 * Constant-time compare, so a token cannot be found a byte at a time. Lengths are compared as bytes:
	 * `timingSafeEqual` throws on buffers of different byte lengths, and a token of the right number of
	 * characters with one non-ASCII character in it reached that throw before any check passed.
	 */
	function sameToken(given: unknown) {
		if (typeof given !== "string") return false;
		const a = Buffer.from(given);
		const b = Buffer.from(TOKEN);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	/** Names you put in front of this yourself: a reverse proxy, a hostname on your own network. */
	const ALLOWED_HOSTS = new Set(
		opts.allowHosts
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean),
	);

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
	function hostAllowed(req: http.IncomingMessage) {
		const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
		if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return true;
		// With no token, the only thing standing between a request and the session is where it came
		// from, so nothing but loopback counts. Refusing --no-auth at bind time was not enough: a
		// loopback-bound server reached through `tailscale serve` — or `tailscale funnel`, which is the
		// open internet — arrives here as a local socket carrying a tailnet name.
		if (NO_AUTH) return false;
		// Bound to the network on purpose: the phone reaches this by IP, so a bare IP address has to be
		// allowed. An address cannot be rebound — there is no name to re-resolve — which is the whole
		// reason the rule is shaped this way.
		if (!LOOPBACK && IP_LITERAL.test(host)) return true;
		// Tailscale's MagicDNS names. `tailscale serve` is the good way to reach this from a phone: it
		// terminates TLS on the tailnet and proxies to loopback here, so the request arrives looking
		// local but carrying the tailnet name as its Host. That zone belongs to Tailscale and its names
		// resolve to tailnet devices, so it is not a name an attacker can point at this machine.
		if (host.endsWith(".ts.net") && fromTailnet(req)) return true;
		return ALLOWED_HOSTS.has(host.toLowerCase());
	}

	function authed(req: http.IncomingMessage, url: URL) {
		if (!hostAllowed(req) || crossSite(req)) return false;
		if (NO_AUTH) return true;
		return sameToken(url.searchParams.get("token")) || sameToken(req.headers["x-pi-web-token"]) || sameToken(cookieToken(req));
	}

	/**
	 * A one-shot key for the browser launcher. The real token must not appear in argv: on Linux
	 * `/proc/<pid>/cmdline` is world-readable, so `xdg-open http://…?token=…` hands the token to every
	 * other account on the machine — and with it `/rpc`, which is the whole session. This key is valid
	 * for one page load, for a minute, and the page it serves carries the real token.
	 */
	let openKey = randomBytes(16).toString("hex");
	let openKeyExpires = 0;

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

	const server = http.createServer(async (req, res) => {
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
			const child = opts.child();
			if (url.pathname === "/" && req.method === "GET") {
				const key = url.searchParams.get("open");
				// The second lock still applies: a page on another site cannot be allowed to fetch this
				// one just because it guessed the key, and only a browser on this machine ever has it.
				// Both of these hand out the cookie without a token, so both owe the same locks the token
				// routes have. Without the cross-site one, a page on any site could point an iframe at
				// this URL twenty times and burn the pairing code the phone was waiting for.
				const trusted = hostAllowed(req) && !crossSite(req);
				// Asked first, because the two ways in below both have a cost and a browser that is already
				// signed in should pay neither. `spendPairCode` spends one of twenty tries, so a signed-in
				// tab reloading a bookmark that still carries an old `?pair=` used to burn a try — and the
				// one-shot launcher key was spent the same way, on a browser that did not need it.
				const signedIn = authed(req, url);
				const openOk =
					!signedIn && trusted && ((key && openKey && key === openKey && Date.now() < openKeyExpires) || spendPairCode(url.searchParams.get("pair")));
				if (openOk) openKey = ""; // one load, then it is spent
				if (!openOk && !signedIn) return void res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-pi-loops-web": "1" }).end(DOOR);
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					// The URL carries the token, so no other site should ever be told it — and the page
					// itself carries it, so it must not sit in the browser's disk cache either.
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
					// Why this browser never has to see the token again. A year, because the token in the
					// file outlives the process and a front end you have to re-authorise is a chore.
					"set-cookie": `${COOKIE}=${TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
				});
				return void res.end(PAGE.replace("__TOKEN__", () => TOKEN).replace("__VERSION__", () => VERSION));
			}
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
			if ((url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg") && (!hostAllowed(req) || crossSite(req))) {
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
						background_color: "#111111",
						theme_color: "#111111",
						icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
					}),
				);
			}
			if (url.pathname === "/icon.svg") {
				res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "max-age=86400" });
				return void res.end(ICON);
			}
			if (!authed(req, url)) return void json(res, { error: "bad or missing token" }, 403);

			if (url.pathname === "/events" && req.method === "GET") {
				// One person, a few tabs. An unbounded set is a way to run this process out of memory.
				if (child.clients.size >= 16) return void json(res, { error: "too many event streams open" }, 429);
				res.on("error", () => child.clients.delete(res));
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
				const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
				req.on("close", () => {
					clearInterval(keepAlive);
					child.clients.delete(res);
				});
				return;
			}
			if (url.pathname === "/state" && req.method === "GET") return void json(res, await snapshot(child));
			if (url.pathname === "/history" && req.method === "GET") {
				const r = await child.rpc({ type: "get_messages" }, 20_000);
				// The number of the last event that happened before this transcript was taken.
				return void json(res, { messages: r?.success ? (r.data?.messages ?? []) : [], seq: child.eventSeq, epoch: child.epoch });
			}
			if (url.pathname === "/prompt" && req.method === "POST") {
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
				const row = personRow(randomUUID(), message, attached, { sessionId: child.sessionId, cwd: child.sessionCwd, createdBy: createdBy(child) });
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
			if (url.pathname === "/model" && req.method === "POST") {
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
			if (url.pathname === "/thinking" && req.method === "POST") {
				const { level } = await body(req);
				const answer = await child.rpc({ type: "set_thinking_level", level });
				if (answer?.success) rememberPref("thinking", String(level));
				return void json(res, answer);
			}
			if (url.pathname === "/complete" && req.method === "POST") {
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
			if (url.pathname === "/file" && req.method === "GET") {
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
				let fd;
				try {
					fd = fs.openSync(file, "r");
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
				return void fs.createReadStream(file, { fd }).pipe(res);
			}
			if (url.pathname === "/preview" && req.method === "POST") {
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
			if (url.pathname === "/pair" && req.method === "POST") {
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
			if (url.pathname === "/abort" && req.method === "POST") {
				return void json(res, await child.rpc({ type: "abort" }));
			}
			if (url.pathname === "/compact" && req.method === "POST") {
				// What survives compaction is worth steering — "keep the API shapes, drop the search" is
				// the difference between a summary you can work from and one you have to undo. pi takes
				// the instructions the way `/compact <text>` does in the terminal.
				const { instructions } = await body(req);
				const custom = String(instructions ?? "").trim();
				return void json(res, await child.rpc({ type: "compact", ...(custom ? { customInstructions: custom.slice(0, 2000) } : {}) }, 300_000));
			}
			if (url.pathname === "/sessions" && req.method === "GET") {
				await snapshot(child); // whichever file pi is writing now is what the list is anchored to
				return void json(res, { sessions: child.listSessionsHere(), dir: child.sessionsDir() });
			}
			if (url.pathname === "/session/new" && req.method === "POST") {
				await snapshot(child);
				return void json(res, await child.swapSession(child.newSessionPath()));
			}
			if (url.pathname === "/session/switch" && req.method === "POST") {
				const { file } = await body(req);
				await snapshot(child);
				// The list this came from is the only place it may point: a path from the browser is not
				// a reason to open a file anywhere on the disk, and `switch_session` on something that is
				// not a session is how you get an empty session written over it.
				const wanted = typeof file === "string" ? path.resolve(file) : "";
				const match = child.listSessionsHere().find((s) => path.resolve(s.file) === wanted);
				if (!match) return void json(res, { success: false, error: "no session of this project has that path" }, 400);
				// The resolved path, which is the one that was checked: pi's cwd is not this process's,
				// so a relative path would be checked here and opened somewhere else.
				return void json(res, await child.swapSession(path.resolve(match.file), { restoreModel: true }));
			}
			if (url.pathname === "/queue/clear" && req.method === "POST") {
				// Everything "queued N ✕" counts: every input row, the person's and pi-loops', as each one's
				// own ✕ would cancel it, and what pi itself still holds (a steer, a command).
				const sid = child.sessionId;
				if (sid && child.catalog.piLoopsLoaded !== false) {
					for (const row of requests.list(sid)) if (row.kind === "input") requests.append(cancelRow(sid, { id: row.id }, "person", createdBy(child)));
					ring(child).catch((err) => opts.log(`pi-loops web: ring: ${err?.message ?? err}`));
				}
				return void json(res, await child.rpc({ type: "clear_queue" }));
			}
			if (url.pathname === "/queue/send-here" && req.method === "POST") {
				// A message of this page nobody took (`untaken`): out of the queue, audited, and sent to the
				// pi behind this page over rpc `prompt`, as every message went before 0.24. Removed here
				// rather than by a cancel row, since the point is that nobody is draining the rows.
				const { id } = await body(req);
				if (child.catalog.piLoopsLoaded === false) return void json(res, { success: false, error: NO_PI_LOOPS }, 400);
				if (!ROW_ID.test(id ?? "") || !child.sessionId) return void json(res, { success: false, error: "bad id" }, 400);
				const row = requests.list(child.sessionId).find((r) => r.id === id && r.kind === "input" && r.source === "person" && mine(r, child));
				if (!row) return void json(res, { success: false, error: "not queued" }, 404);
				const holder = holderNow(child.sessionId, child);
				if (holder?.mine && holder.aside) return void json(res, { success: false, error: "this page's pi shows an older copy of this conversation; /resume it first" }, 409);
				const images = imagesOf(row);
				// The check and the removal are one critical section: a holder that stamps the row handed
				// over in between keeps it, and this answers 409 instead of answering the message twice.
				const taken = requests.removeIf(child.sessionId, row.id, (r) => r.handed_at === undefined && mine(r, child));
				if (taken.outcome !== "removed") return void json(res, { success: false, error: taken.outcome === "kept" ? "already handed to pi" : "not queued" }, taken.outcome === "kept" ? 409 : 404);
				audit.appendAudit({ cwd: row.payload?.cwd ?? "", type: "request", traceId: row.id, state: "cancelled", sourceLabel: row.source, eventLabel: child.sessionId, details: { session_id: child.sessionId, kind: row.kind, sent: "over rpc, from the page" } });
				return void json(res, await child.rpc({ type: "prompt", message: row.payload?.text ?? "", streamingBehavior: "followUp", ...(images.length ? { images } : {}) }));
			}
			if (url.pathname === "/queue/cancel" && req.method === "POST") {
				// A cancel is a row too: the holder removes the queued row and audits it, whoever holds the
				// session. Discarding a message a previous page left behind is the same request.
				const { id } = await body(req);
				if (child.catalog.piLoopsLoaded === false) return void json(res, { success: false, error: NO_PI_LOOPS }, 400);
				if (!ROW_ID.test(id ?? "") || !child.sessionId) return void json(res, { success: false, error: "bad id" }, 400);
				if (!requests.list(child.sessionId).some((row) => row.id === id && row.kind === "input")) return void json(res, { success: false, error: "not queued" }, 404);
				requests.append(cancelRow(child.sessionId, { id }, "person", createdBy(child)));
				ring(child).catch((err) => opts.log(`pi-loops web: ring: ${err?.message ?? err}`));
				return void json(res, { success: true });
			}
			if (url.pathname === "/queue/send" && req.method === "POST") {
				// A message a previous page left queued ("not sent before pi stopped") becomes this page's,
				// under the lock, and is rung for. Only a person row: the ring is what makes a row believed as
				// typed here, and the page owns no other kind.
				const { id } = await body(req);
				if (child.catalog.piLoopsLoaded === false) return void json(res, { success: false, error: NO_PI_LOOPS }, 400);
				if (!ROW_ID.test(id ?? "") || !child.sessionId) return void json(res, { success: false, error: "bad id" }, 400);
				const sid = child.sessionId;
				const person = (row: any) => row.kind === "input" && row.source === "person" && row.id === id;
				if (requests.list(sid).some(person)) requests.update(sid, id, { created_by: createdBy(child) });
				const row = requests.list(sid).find(person);
				if (!row) return void json(res, { success: false, error: "not queued" }, 404);
				ring(child, row.id, requestFingerprint(row)).catch((err) => opts.log(`pi-loops web: ring: ${err?.message ?? err}`));
				return void json(res, { success: true, sent: row.id });
			}
			if (url.pathname === "/trigger/immediate" && req.method === "POST") {
				// "Run now" on a job. pi-loops exposes it as a command, and a command is a prompt here.
				const { id } = await body(req);
				if (!/^[A-Za-z0-9_-]{1,80}$/.test(id ?? "")) return void json(res, { success: false, error: "bad id" }, 400);
				const command = id.startsWith("dyn-") ? `/triggers run ${id}` : `/cron run ${id}`;
				return void json(res, await child.rpc({ type: "prompt", message: command }));
			}
			if (url.pathname === "/stats" && req.method === "GET") {
				// The cost, and the context gauge the terminal footer shows.
				const r = await child.rpc({ type: "get_session_stats" }, 20_000);
				return void json(res, r?.success ? r.data : { error: r?.error });
			}
			if (url.pathname === "/find" && req.method === "POST") {
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
			if (url.pathname === "/undo" && req.method === "POST") {
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
			if (url.pathname === "/share" && req.method === "POST") {
				// pi-loops' command does the rendering, the redaction and the confirmation; its dialog
				// reaches the browser as an extension_ui_request like every other approval. It blocks on
				// that dialog, so this must not sit on a short timeout waiting for an answer.
				const { public: isPublic } = await body(req);
				if (!child.catalog.commandList.some((c) => c.name === "session-share")) return void json(res, { success: false, error: "pi-loops is not loaded in this session" }, 400);
				return void json(res, await child.rpc({ type: "prompt", message: isPublic ? "/session-share --public" : "/session-share" }, 600_000));
			}
			if (url.pathname === "/export" && req.method === "POST") {
				// Save. pi writes the HTML itself; this only reports where it landed.
				return void json(res, await child.rpc({ type: "export_html" }, 60_000));
			}
			if (url.pathname === "/ui-response" && req.method === "POST") {
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
			if (url.pathname === "/rpc" && req.method === "POST") {
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
	});

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
		armOpenKey: () => {
			openKeyExpires = Date.now() + 60_000;
			return openKey;
		},
		close: () => {
			server.close();
		},
	};
	return new Promise((resolve) => {
		server.on("error", opts.onListenError);
		server.listen(PORT, HOST_BIND, () => resolve(api));
	});
}
