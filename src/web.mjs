#!/usr/bin/env node
// pi-web — a browser front end for pi, in one file with no dependencies.
//
//   node pi-web.mjs [--port 4173] [--no-open] [-- <pi args>]
//
// It runs `pi --mode rpc`, which is pi with no terminal UI: commands in on stdin as JSON lines,
// events out on stdout the same way. The browser speaks that protocol through this process, so the
// session is a real pi session — same models, tools, extensions, session file, `--resume` — with a
// different front end. This is the shape pie's `pie web` has, done across a process boundary
// instead of inside the binary.
//
// The automation panel reads pi-loops' own files (jobs.json, triggers.json, inbox.jsonl) rather
// than scraping command output: they are on this machine, they are JSON, and text meant for a
// human is a bad wire format.
//
// Binds loopback only, with a token. There is deliberately no flag to bind anywhere else.

import { spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/* ------------------------------------------------------------------ arguments */

/**
 * The version of this file, baked into the page it serves.
 *
 * A tab that has been open across an upgrade looks exactly like a current one — the panel even
 * shows a version, but that is the server's, read live. The page had no way to say how old *it*
 * was, which is how three rounds of "no reply appears" were spent on a page that could not have
 * received one. Now it says.
 */
const VERSION = (() => {
	try {
		return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "?";
	} catch {
		return "?"; // running from somewhere without the manifest; the comparison simply goes quiet
	}
})();

const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const piArgs = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const flag = (name) => own.includes(`--${name}`);
const value = (name, fallback) => {
	// Both spellings, because `--host=0.0.0.0` used to parse as "no --host at all" — which bound
	// loopback and skipped the refusal that goes with binding anywhere else.
	const eq = own.find((a) => a.startsWith(`--${name}=`));
	if (eq) return eq.slice(name.length + 3);
	const i = own.indexOf(`--${name}`);
	return i !== -1 && own[i + 1] ? own[i + 1] : fallback;
};

if (flag("help")) {
	console.log(`pi-web — a browser front end for pi

  node pi-web.mjs [options] [-- <pi args>]

  --port <n>        port on 127.0.0.1 (default 4173; 0 takes any free one)
  --loops-dir <p>   pi-loops directory for the automation panel (default $PI_LOOPS_DIR)
  --no-open         do not open a browser
  --help

Anything after -- goes to pi, e.g.  node pi-web.mjs -- --model anthropic/claude-opus-5`);
	process.exit(0);
}

// `--port 0` means "any free port", the way pie's --web-port does; the URL printed below is the
// one that was actually bound.
const portArg = value("port", "4173");
const PORT = /^\d+$/.test(String(portArg)) ? Number(portArg) : 4173;
const LOOPS_DIR = value("loops-dir", process.env.PI_LOOPS_DIR || path.join(os.homedir(), ".pi", "agent", "loops"));
/**
 * The token is kept in a file rather than made fresh each launch, so the address stays the same
 * one every time: bookmark http://127.0.0.1:4173/ and it works tomorrow. It is a boring secret —
 * 0600 in the loops directory, next to the jobs it lets you run — and it exists because anything
 * that reaches /rpc gets the whole session, including any *website* you happen to have open (a
 * page cannot read this server's answers, but without a check it could still tell your agent what
 * to do). You will not have to type it: the browser gets a cookie on the first visit.
 */
function storedToken() {
	const file = path.join(LOOPS_DIR, "web-token");
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
	} catch (err) {
		if (err?.code !== "ENOENT") {
			// Anything other than "not there yet" is a thing to say out loud rather than paper over
			// by writing a new token: it means the path is not what this expects it to be.
			console.error(`pi-loops web: ${err?.message ?? err}`);
			process.exit(1);
		}
	}
	const made = randomBytes(16).toString("hex");
	fs.mkdirSync(LOOPS_DIR, { recursive: true });
	fs.writeFileSync(file, `${made}\n`, { mode: 0o600, flag: "w" });
	fs.chmodSync(file, 0o600);
	return made;
}

const TOKEN = process.env.PI_WEB_TOKEN || storedToken();
const COOKIE = "pi_web_token";
/**
 * `--no-auth`: no token, no cookie, nothing to carry — anything on this machine that can reach
 * 127.0.0.1 gets the session. What is left of the fence is `localHost()` and the `Sec-Fetch-Site`
 * check below, which together still keep a *browser* on another site out; what you are giving up
 * is the guarantee against everything else, other accounts and other programs included.
 */
const NO_AUTH = flag("no-auth");
/**
 * What to bind. Loopback by default, because the safe thing should not need to be asked for. A
 * phone cannot reach a loopback address at all, so `--host 0.0.0.0` (or a specific interface) is
 * how the front end gets onto your own network — and at that point the token stops being a
 * formality, which is why `--no-auth` is refused here rather than quietly obeyed.
 */
const HOST_BIND = value("host", "127.0.0.1");
const LOOPBACK = HOST_BIND === "127.0.0.1" || HOST_BIND === "::1" || HOST_BIND === "localhost";
if (!LOOPBACK && NO_AUTH) {
	console.error("pi-loops web: --no-auth is refused with --host: that would put an unauthenticated shell on the network");
	process.exit(1);
}
// It is substituted into a JS string literal in the page and into a URL on the console, so what it
// may contain is not a matter of taste: a quote ends the literal early and the rest of the token
// becomes code. Say so at startup rather than serving a broken page.
if (!/^[A-Za-z0-9_-]{8,}$/.test(TOKEN)) {
	console.error("PI_WEB_TOKEN must be at least 8 characters of letters, digits, - or _");
	process.exit(1);
}
const HOST = os.hostname();

/* ------------------------------------------------------------------ pi, in rpc mode */

const pi = spawn(process.env.PI_BIN || "pi", ["--mode", "rpc", ...piArgs], { stdio: ["pipe", "pipe", "pipe"] });
let piAlive = true;

pi.on("error", (err) => {
	console.error(`could not start pi: ${err.message}`);
	process.exit(1);
});
pi.on("exit", (code, signal) => {
	piAlive = false;
	// The page has to be told *why*. pi's own reasons for refusing to start — a duplicate extension,
	// a provider that will not authenticate — are on its stderr, and a browser tab that just says
	// "pi exited" sends you to the terminal to find out what a terminal already knew.
	broadcast({ type: "pi_exit", code, signal, stderr: recentStderr() });
	console.error(`pi exited (${signal || code})`);
	// Long enough for that event to reach an attached browser before this process goes with it.
	setTimeout(() => process.exit(code ?? 0), 500);
});

/**
 * pi's stderr, forwarded to ours and kept — bounded — so the page can show the last of it when pi
 * dies. Bounded because a chatty provider error can be very long and nobody reads past the end.
 */
const STDERR_KEEP = 8000;
let stderrTail = "";
function recentStderr() {
	return stderrTail.trim();
}
pi.stderr.on("data", (d) => {
	process.stderr.write(d);
	stderrTail = (stderrTail + d.toString("utf8")).slice(-STDERR_KEEP);
});

let nextId = 1;
const pending = new Map();

/**
 * Write one line to pi. Its stdin is a pipe to another process: it can be gone before the `exit`
 * event that sets `piAlive`, and an EPIPE arrives as an unhandled `error` event on the socket,
 * which ends this process too. A browser front end whose pi died should say so, not die with it.
 */
function writeToPi(line) {
	if (!piAlive) return false;
	try {
		pi.stdin.write(line);
		return true;
	} catch (err) {
		console.error(`pi-web: could not write to pi: ${err?.message ?? err}`);
		return false;
	}
}
pi.stdin.on("error", (err) => {
	piAlive = false;
	console.error(`pi-web: pi's input closed: ${err?.message ?? err}`);
});

/** Send one RPC command and wait for the response that carries its id. */
function rpc(command, timeoutMs = 60_000) {
	if (!piAlive) return Promise.resolve({ success: false, error: "pi is not running" });
	const id = `web-${nextId++}`;
	if (!writeToPi(`${JSON.stringify({ ...command, id })}\n`)) return Promise.resolve({ success: false, error: "pi is not running" });
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			// A command that never answers must not hold a browser request open for ever.
			if (pending.delete(id)) resolve({ success: false, error: `timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		pending.set(id, (msg) => {
			clearTimeout(timer);
			resolve(msg);
		});
	});
}

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
		if (msg.type === "response" && msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
			continue; // a command's own answer belongs to its caller, not to the feed
		}
		observe(msg);
		broadcast(msg);
	}
});

/* ------------------------------------------------------------------ what the server keeps */

let entriesCache = { at: 0, value: undefined };

const live = {
	queue: { steering: [], followUp: [] },
	goal: undefined,
	lastPoll: undefined,
	runtime: undefined,
	lastError: undefined,
	pendingAsks: new Map(), // dialogs asked while no browser was attached
};

/** Fold the events that carry state a late-joining browser still needs. */
function observe(ev) {
	if (ev.type === "queue_update") live.queue = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
	if (ev.type === "extension_ui_request") {
		if (ev.method === "confirm" || ev.method === "select" || ev.method === "input" || ev.method === "editor") {
			live.pendingAsks.set(ev.id, ev);
		}
	}
	if (ev.type === "entry_appended") {
		entriesCache = { at: 0, value: undefined }; // the session moved; search and undo must re-read
		const entry = ev.entry;
		if (entry?.type !== "custom") return;
		// pi-loops writes its own state into the session as custom entries, so the panel can read it
		// structurally instead of parsing the text it prints for a person.
		if (entry.customType === "goal_state") live.goal = entry.data;
		if (entry.customType === "trigger_result") live.lastPoll = { ...entry.data, at: entry.timestamp };
		// Which MCP servers actually connected, what they exposed, who owns the clock: state that
		// lives in the pi process and is in no file this side could open.
		if (entry.customType === "pi_loops_snapshot") live.runtime = entry.data;
	}
}

/* ------------------------------------------------------------------ pi-loops, read from disk */

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

/**
 * Is `file` inside `root`? A `startsWith` on the resolved path is not this test: with root
 * `/home/u/proj`, `/home/u/proj-secrets/.env` passes it. Symlinks are resolved first, so a link
 * planted in the project cannot point out of it either.
 */
function inside(file, root) {
	let real = file;
	let realRoot = root;
	try {
		realRoot = fs.realpathSync(root);
		// The file may not exist yet (completion); resolve the deepest part that does.
		real = fs.realpathSync(file);
	} catch {
		try {
			real = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
		} catch {
			return false;
		}
	}
	const rel = path.relative(realRoot, real);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** pi-loops' own rule: a job belongs to this project if its cwd is the session's, or under it. */
/**
 * The same question the extension answers, answered the same way.
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
function realProjectPath(p) {
	if (!p) return "";
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p); // not there right now — a mount that has not arrived, most likely
	}
}

/** A root so broad that containment would mean "everything": never treated as one project. */
function tooBroad(dir) {
	return dir === "/" || dir === os.homedir() || path.dirname(dir) === dir;
}

function within(root, p) {
	const a = realProjectPath(root);
	const b = realProjectPath(p);
	if (!a || !b) return false;
	if (a === b) return true;
	if (tooBroad(a)) return false;
	const rel = path.relative(a, b);
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sameProject(jobCwd, sessionCwd) {
	if (!jobCwd || !sessionCwd) return false;
	return within(sessionCwd, jobCwd) || within(jobCwd, sessionCwd);
}

function formatSchedule(s) {
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

/** Only for `every`: cron needs a parser, and a wrong next-run time is worse than none. */
function nextRun(job) {
	if (job.schedule?.kind !== "every") return undefined;
	const base = Date.parse(job.lastFiredAt || job.createdAt);
	if (!Number.isFinite(base)) return undefined;
	const now = Date.now();
	let t = base + job.schedule.ms;
	while (t <= now) t += job.schedule.ms;
	return new Date(t).toISOString();
}

function automation(cwd) {
	// The directory is the evidence, not any one file in it: a project with rules and no cron jobs
	// has no jobs.json at all, and reporting "pi-loops not found" there would be a lie.
	if (!fs.existsSync(LOOPS_DIR)) return { installed: false, dir: LOOPS_DIR };
	const jobsFile = readJson(path.join(LOOPS_DIR, "jobs.json"), { jobs: [] });
	/**
	 * This project's, whatever machine they were made on.
	 *
	 * The host used to be part of this test, so a job stamped with another hostname vanished from
	 * the panel — and a hostname changes on its own: a rebuilt container, a machine renamed by
	 * DHCP, a restored backup. What you got was a job sitting enabled in `jobs.json`, never running,
	 * invisible in the one place you would look. The terminal always listed it and said whose it
	 * was; so does this, and the count of everything in other projects goes with it, because a list
	 * that silently drops things is worse than a longer list.
	 */
	const here = (j) => sameProject(j.cwd, cwd);
	const allJobs = jobsFile.jobs ?? [];
	const jobs = allJobs.filter(here).map((j) => ({
		id: j.id,
		name: j.name,
		schedule: formatSchedule(j.schedule),
		stateful: !!j.stateful,
		enabled: !!j.enabled,
		prompt: j.prompt,
		runCount: j.runCount ?? 0,
		lastError: j.lastError,
		running: !!j.running,
		// Set only when it is not this machine's: the panel says so, and nothing else has to guess.
		otherHost: j.host && j.host !== HOST ? j.host : undefined,
		// What to type to fix it. The terminal's version of this line says `/cron set <n>`, where n
		// is the position in a numbered list — which this panel does not have, so telling someone to
		// use one was telling them to go and find a terminal. A name or a full id resolves anywhere.
		ref: j.name || j.id,
		next: j.host && j.host !== HOST ? undefined : nextRun(j),
	}));
	const allRules = readJson(path.join(LOOPS_DIR, "triggers.json"), { rules: [] }).rules ?? [];
	const rules = allRules
		.filter(here)
		.map((r) => ({ id: r.id, condition: r.condition, action: r.action, enabled: !!r.enabled, fireOnce: !!r.fireOnce, firedAt: r.firedAt }));
	const elsewhere = allJobs.length - jobs.length + (allRules.length - rules.length);

	let inboxNew = 0;
	try {
		for (const line of fs.readFileSync(path.join(LOOPS_DIR, "inbox.jsonl"), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				if ((JSON.parse(line).status ?? "new") === "new") inboxNew++;
			} catch {
				/* skip a torn line */
			}
		}
	} catch {
		/* no inbox yet */
	}

	// MCP servers and hooks are deliberately not counted from the config files here: what matters
	// is which ones actually connected and what they exposed, and that is in the runtime snapshot.
	return { installed: true, dir: LOOPS_DIR, jobs, rules, inboxNew, elsewhere };
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
	{ name: "compact", description: "compact the context; anything after it steers the summary" },
];

/** Commands this front end answers some other way, so typing one is not sent to the model as text. */
const UI_COMMANDS = {
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
function guardCommand(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const name = trimmed.slice(1).split(/\s/)[0];
	if (!name) return undefined;
	if (commandList.some((c) => c.name === name)) return undefined;
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
function expandMentions(text, cwd) {
	const seen = new Set();
	const blocks = [];
	for (const m of text.matchAll(/(^|\s)@([^\s]+)/g)) {
		const rel = m[2].replace(/[.,;:)\]]+$/, "");
		if (seen.has(rel)) continue;
		seen.add(rel);
		const file = path.resolve(cwd, rel);
		// A mention must not read outside the project, and a huge file is a mistake, not a mention.
		if (!inside(file, cwd)) continue;
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

/* ------------------------------------------------------------------ the snapshot */

let modelCatalog = [];
let thinkingLevels = [];
let commandList = [];

async function refreshCatalogues() {
	const [models, commands, levels] = await Promise.all([
		rpc({ type: "get_available_models" }, 10_000),
		rpc({ type: "get_commands" }, 10_000),
		// Which thinking levels mean anything for the model in use: the map pi carries has nulls in
		// it, and offering a level a model does not have is offering nothing.
		rpc({ type: "get_available_thinking_levels" }, 10_000),
	]);
	if (levels?.success) thinkingLevels = levels.data?.levels ?? [];
	// pi says a great deal more about a model than its name, and the page can use most of it: which
	// of them take images, how big a context is, what a token costs. Keeping only the id meant the
	// picker was 33 identical-looking lines and the attach button was a guess.
	if (models?.success) {
		modelCatalog = (models.data?.models ?? []).map((m) => ({
			id: m.id,
			provider: m.provider,
			name: m.name,
			images: Array.isArray(m.input) ? m.input.includes("image") : undefined,
			reasoning: !!m.reasoning,
			contextWindow: m.contextWindow,
			cost: m.cost ? { input: m.cost.input, output: m.cost.output } : undefined,
		}));
	}
	if (commands?.success) commandList = (commands.data?.commands ?? []).map((c) => ({ name: c.name, description: c.description, source: c.source }));
}

/**
 * A session that has been running has its snapshot somewhere back in the transcript, and pi-loops
 * only writes a new one when something changes — so read the last one, then ask for a fresh one.
 */
async function primeRuntime() {
	const entries = await rpc({ type: "get_entries" }, 20_000);
	if (entries?.success) {
		for (const e of entries.data?.entries ?? []) {
			if (e?.type === "custom" && e.customType === "pi_loops_snapshot") live.runtime = e.data;
			if (e?.type === "custom" && e.customType === "goal_state") live.goal = e.data;
		}
	}
	if (commandList.some((c) => c.name === "cron")) await rpc({ type: "prompt", message: "/cron snapshot" }, 20_000);
}

/**
 * The session's directory, as pi reports it. `@mention` expansion and path completion are anchored
 * here and nowhere else: the browser is told this value and echoes it back on every request, and a
 * root that the caller supplies is not a boundary at all — `inside(f, "/")` is true of every file
 * on the disk. Reaching those routes already needs the token, which /rpc turns into the whole
 * session, so this is an invariant kept rather than a hole closed.
 */
let sessionCwd = process.cwd();

/**
 * Which file the session is being written to, as of the last `get_state`.
 *
 * Everything about starting or resuming a session is anchored to this one value rather than to
 * anything the browser supplies: its directory is where a new session goes and the only place
 * `/sessions` will list, and switching to it is the one destination that is refused (pi treats
 * a switch to the file it is already writing as a brand-new session pointed at that file, which
 * is two sessions with one file between them).
 */
let sessionFile;

async function snapshot() {
	const state = await rpc({ type: "get_state" }, 15_000);
	const s = state?.success ? state.data : {};
	const cwd = s.cwd || process.cwd();
	sessionCwd = cwd;
	if (typeof s.sessionFile === "string" && s.sessionFile) sessionFile = s.sessionFile;
	return {
		ok: !!state?.success,
		sessionId: s.sessionId,
		sessionName: s.sessionName,
		sessionFile: s.sessionFile,
		cwd,
		model: s.model ? { id: s.model.id, provider: s.model.provider, label: `${s.model.provider}/${s.model.id}` } : undefined,
		modelCatalog,
		thinkingLevels,
		// The page polls this. Comparing these two against what it has received is how it notices
		// that it is no longer being told anything — a dropped stream, a suspended tab, or a server
		// that has been restarted under it.
		seq: eventSeq,
		epoch: EPOCH,
		// What is serving this, so a page can tell whether it is the page this server would send.
		version: VERSION,
		thinkingLevel: s.thinkingLevel,
		busy: !!s.isStreaming,
		compacting: !!s.isCompacting,
		messageCount: s.messageCount ?? 0,
		queue: live.queue,
		goal: live.goal,
		lastPoll: live.lastPoll,
		runtime: live.runtime,
		pendingAsks: [...live.pendingAsks.values()],
		automation: automation(cwd),
		piAlive,
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
function sessionsDir() {
	return sessionFile ? path.dirname(sessionFile) : undefined;
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
const SESSION_HEAD = 64 * 1024;
function listSessionsHere(limit = 40) {
	const dir = sessionsDir();
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
	const open = sessionFile ? realOf(sessionFile) : undefined;
	for (const entry of out.slice(0, limit)) {
		const head = readHead(entry.file);
		if (!head) continue; // not a session file, or not a readable one
		sessions.push({ ...entry, ...head, current: realOf(entry.file) === open });
	}
	return sessions;
}

/** The header, a name if one was set early, and the first thing a person said. */
function readHead(file) {
	let text;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(SESSION_HEAD);
			text = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, SESSION_HEAD, 0));
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
	const cut = text.length >= SESSION_HEAD;
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
		const said = typeof content === "string" ? content : (content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join(" ");
		// A mention is expanded before it is sent, so the first user message can be a whole file.
		if (said.trim()) first = said.trim().slice(0, 200);
	}
	return { id: header.id, startedAt: header.timestamp, name, first, messages, truncated: cut };
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
function newSessionPath() {
	const dir = sessionsDir();
	if (!dir) return undefined;
	return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
}

/**
 * Swap the session under the page.
 *
 * Refused while a turn is running: the swap aborts it, and losing a reply you are waiting for is
 * not something to discover afterwards. The page asks first, which is where the question belongs;
 * this is the check that means it cannot be skipped by a stale tab.
 */
async function swapSession(file) {
	if (!piAlive) return { success: false, error: "pi is not running" };
	if (!file) return { success: false, error: "this session has no file on disk (pi was started with --no-session)" };
	const before = await rpc({ type: "get_state" }, 15_000);
	if (!before?.success) return { success: false, error: before?.error ?? "pi did not answer" };
	if (before.data?.isStreaming || before.data?.isCompacting) return { success: false, error: "a turn is running — stop it first" };
	const current = before.data?.sessionFile;
	if (current && realOf(file) === realOf(current)) return { success: false, error: "this is the session you are already in" };
	const answer = await rpc({ type: "switch_session", sessionPath: file }, 60_000);
	if (!answer?.success) return answer ?? { success: false, error: "pi did not answer" };
	if (answer.data?.cancelled) return { success: true, data: { cancelled: true } };

	// A different session is a different sequence of events: the numbers the page was counting mean
	// nothing against the ones that start now, and the epoch is how it is told that.
	EPOCH = randomBytes(6).toString("hex");
	backlog.length = 0;
	entriesCache = { at: 0, value: undefined };
	live.queue = { steering: [], followUp: [] };
	live.goal = undefined;
	live.lastPoll = undefined;
	live.runtime = undefined;
	live.lastError = undefined;
	// Dialogs belong to the session that asked them. The extension that was waiting for an answer
	// went down with the swap, and answering now would be answering nobody.
	live.pendingAsks.clear();
	sessionFile = file;
	// The rebuilt extensions register their commands again, and pi-loops writes a snapshot for the
	// panel only when something changes — so ask for both rather than showing the old session's.
	await refreshCatalogues();
	await primeRuntime();
	return answer;
}

/* ------------------------------------------------------------------ http */

const clients = new Set();
const backlog = [];

/**
 * Every event carries a number, and the history hand-off says which number it was current at. The
 * browser replays the transcript, then ignores anything from the backlog it already has — exactly,
 * instead of the "drop message_end for the first 300ms" guess this replaces. That guess dropped
 * live events whenever the backlog held a turn that was still running: the tool results and the
 * end-of-message that turns a streamed reply into rendered Markdown both went with it, so you got
 * a page of raw asterisks and tools stuck on "running".
 */
let eventSeq = 0;
/**
 * Which run of this process the numbers belong to. Without it, a browser holding number 40 from the
 * process that just exited quietly ignores the first forty events of the one that replaced it —
 * every number is "already seen". A restart is not a gap, it is a different sequence entirely.
 */
let EPOCH = randomBytes(6).toString("hex");

function broadcast(event) {
	if (event && typeof event === "object") {
		event.seq = ++eventSeq;
		event.epoch = EPOCH;
	}
	backlog.push(event);
	if (backlog.length > 800) backlog.shift();
	const data = `data: ${JSON.stringify(event)}\n\n`;
	for (const res of clients) {
		try {
			res.write(data);
		} catch {
			clients.delete(res);
		}
	}
}

/** Constant-time compare, so a token cannot be found a byte at a time. */
function sameToken(given) {
	if (typeof given !== "string" || given.length !== TOKEN.length) return false;
	return timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

/**
 * Only this machine, and only under a name that resolves to it. Without the Host check a page on
 * any site could point a hostname at 127.0.0.1 and talk to this server from the browser; the token
 * is what actually stops that, and this is the second lock.
 */
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\])$/;
/**
 * Where the connection actually came from, for the tailnet case. `tailscale serve` proxies to
 * loopback, so a genuine one arrives on a local socket; a direct connection to the tailnet address
 * arrives from 100.64/10, which is the range Tailscale hands out. A `.ts.net` Host from anywhere
 * else is a name pointed at this machine by someone, which is the thing the check is for.
 */
function fromTailnet(req) {
	const from = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
	if (from === "127.0.0.1" || from === "::1") return true;
	const octets = from.split(".").map(Number);
	return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** Names you put in front of this yourself: a reverse proxy, a hostname on your own network. */
const ALLOWED_HOSTS = new Set(
	String(value("allow-host", ""))
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean),
);

function localHost(req) {
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

/**
 * The cookie the page was given on its first visit. `SameSite=Strict` is the point of it: a browser
 * does not attach it to anything another site initiated, not even a top-level link, so it opens
 * this server to the tab you opened yourself and to nothing else.
 */
function cookieToken(req) {
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
function crossSite(req) {
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

function authed(req, url) {
	if (!localHost(req) || crossSite(req)) return false;
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
const PAIR_MAX_TRIES = 20;
/** Long enough to find your phone and point it at the screen; not long enough to forget about. */
const PAIR_TTL_MS = 10 * 60 * 1000;

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

function pairOk(given) {
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
		console.error("pi-loops web: too many wrong pairing codes; ask for another one");
	}
}

async function body(req) {
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

const json = (res, data, code = 200) => {
	// Some of these carry a session, a transcript, or a live pairing code; none are worth caching.
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(data));
};

/** Slash commands at the start of the line, and `@`-paths anywhere — pie's /complete. */
async function complete(text, cwd) {
	const trimmed = text ?? "";
	if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
		const q = trimmed.slice(1).toLowerCase();
		// The page's own first, and only once: an extension is free to register a command of one of
		// these names, but the page intercepts the line before it is sent, so that is the one that
		// would run and offering both would be offering a choice that does not exist.
		return [...PAGE_COMMANDS, ...commandList.filter((c) => !PAGE_COMMANDS.some((p) => p.name === c.name))]
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
	if (!inside(dir, cwd)) return [];
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

/** The whole session, for search and undo. Typing in the search box must not re-read it per key. */
async function cachedEntries() {
	if (Date.now() - entriesCache.at < 3_000 && entriesCache.value) return entriesCache.value;
	const r = await rpc({ type: "get_entries" }, 30_000);
	entriesCache = { at: Date.now(), value: r };
	return r;
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	try {
		if (url.pathname === "/" && req.method === "GET") {
			const key = url.searchParams.get("open");
			// The second lock still applies: a page on another site cannot be allowed to fetch this
			// one just because it guessed the key, and only a browser on this machine ever has it.
			// Both of these hand out the cookie without a token, so both owe the same locks the token
			// routes have. Without the cross-site one, a page on any site could point an iframe at
			// this URL twenty times and burn the pairing code the phone was waiting for.
			const trusted = localHost(req) && !crossSite(req);
			const openOk = trusted && ((key && openKey && key === openKey && Date.now() < openKeyExpires) || pairOk(url.searchParams.get("pair")));
			if (openOk) openKey = ""; // one load, then it is spent
			if (!openOk && !authed(req, url)) return void res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-pi-loops-web": "1" }).end(DOOR);
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
		if ((url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg") && (!localHost(req) || crossSite(req))) {
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
			if (clients.size >= 16) return void json(res, { error: "too many event streams open" }, 429);
			res.on("error", () => clients.delete(res));
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(": connected\n\n");
			// A browser opened mid-session still needs what already happened.
			for (const e of backlog) res.write(`data: ${JSON.stringify(e)}\n\n`);
			clients.add(res);
			const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
			req.on("close", () => {
				clearInterval(keepAlive);
				clients.delete(res);
			});
			return;
		}
		if (url.pathname === "/state") return void json(res, await snapshot());
		if (url.pathname === "/history") {
			const r = await rpc({ type: "get_messages" }, 20_000);
			// The number of the last event that happened before this transcript was taken.
			return void json(res, { messages: r?.success ? (r.data?.messages ?? []) : [], seq: eventSeq, epoch: EPOCH });
		}
		if (url.pathname === "/prompt" && req.method === "POST") {
			const { text, images, mode } = await body(req);
			if (!text && !(images ?? []).length) return void json(res, { success: false, error: "empty prompt" }, 400);
			const guard = guardCommand(text ?? "");
			if (guard) return void json(res, guard, 400);
			// Submitting while a turn runs queues instead of racing it, as the TUI does.
			const type = mode === "steer" ? "steer" : mode === "follow_up" ? "follow_up" : "prompt";
			const message = expandMentions(text ?? "", sessionCwd);
			return void json(res, await rpc({ type, message, ...(images?.length ? { images } : {}) }));
		}
		if (url.pathname === "/model" && req.method === "POST") {
			// Recorded below, once pi has accepted it.
			// The catalogue is rendered as `provider/id`; the command takes the two halves.
			const { model } = await body(req);
			const cut = String(model ?? "").indexOf("/");
			if (cut < 1) return void json(res, { success: false, error: "model must be provider/id" }, 400);
			const answer = await rpc({ type: "set_model", provider: model.slice(0, cut), modelId: model.slice(cut + 1) }, 20_000);
			// A different model has a different set of thinking levels; the picker must follow it.
			if (answer?.success) {
				await refreshCatalogues();
				rememberPref("model", String(model));
			}
			return void json(res, answer);
		}
		if (url.pathname === "/thinking" && req.method === "POST") {
			const { level } = await body(req);
			const answer = await rpc({ type: "set_thinking_level", level });
			if (answer?.success) rememberPref("thinking", String(level));
			return void json(res, answer);
		}
		if (url.pathname === "/complete" && req.method === "POST") {
			const { text } = await body(req);
			return void json(res, { items: await complete(text, sessionCwd) });
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
			const file = path.resolve(sessionCwd, wanted.startsWith("~/") ? path.join(os.homedir(), wanted.slice(2)) : wanted);
			const root = previewRoot(file);
			if (!root) return void res.writeHead(403).end("outside the session directory and your home directory");
			// A dot segment is where secrets live — .ssh, .env, .claude/.credentials.json — and
			// nothing anybody wants to *look at* begins with one. Checked on the path the filesystem
			// resolves to, not the one that was asked for: membership is decided after symlinks are
			// followed, and a rule applied before them is a rule with a door next to it. A link at
			// ~/Documents/cfg pointing into ~/.config is how that door gets used.
			const real = realOf(file);
			const rel = path.relative(realOf(root), real);
			if (rel.split(path.sep).some((seg) => seg.startsWith(".")) || inside(file, LOOPS_DIR)) {
				return void res.writeHead(403).end("not a file this previews");
			}
			const type = PREVIEW_TYPES[path.extname(real).toLowerCase()];
			if (!type) return void res.writeHead(415).end("not a kind of file this previews");
			// Outside the session's own directory, only things one *looks* at. A home directory holds
			// service-account keys named like ordinary JSON and password exports named like ordinary
			// CSV, and neither is a thing anybody previews — while a picture or a page is exactly
			// what an agent leaves in Downloads for a person to open.
			const own = inside(file, sessionCwd);
			if (!own && !VISUAL_TYPES.has(path.extname(real).toLowerCase())) {
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
					own ? "sandbox allow-scripts" : "sandbox",
					"default-src 'none'",
					"img-src data: blob:",
					"style-src 'unsafe-inline'",
					own ? "script-src 'unsafe-inline'" : "script-src 'none'",
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
			for (const [key, v] of previews) if (previews.size > 8 || Date.now() - v.at > 30 * 60_000) previews.delete(key);
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
			const port = server.address()?.port ?? PORT;
			const addresses = LOOPBACK ? [] : lanAddresses().map((a) => ({ url: `http://${a.address}:${port}/`, via: a.name }));
			return void json(res, { success: true, code: newPairCode(), expiresIn: Math.round(PAIR_TTL_MS / 1000), addresses });
		}
		if (url.pathname === "/abort" && req.method === "POST") return void json(res, await rpc({ type: "abort" }));
		if (url.pathname === "/compact" && req.method === "POST") {
			// What survives compaction is worth steering — "keep the API shapes, drop the search" is
			// the difference between a summary you can work from and one you have to undo. pi takes
			// the instructions the way `/compact <text>` does in the terminal.
			const { instructions } = await body(req);
			const custom = String(instructions ?? "").trim();
			return void json(res, await rpc({ type: "compact", ...(custom ? { customInstructions: custom.slice(0, 2000) } : {}) }, 300_000));
		}
		if (url.pathname === "/sessions" && req.method === "GET") {
			await snapshot(); // whichever file pi is writing now is what the list is anchored to
			return void json(res, { sessions: listSessionsHere(), dir: sessionsDir() });
		}
		if (url.pathname === "/session/new" && req.method === "POST") {
			await snapshot();
			return void json(res, await swapSession(newSessionPath()));
		}
		if (url.pathname === "/session/switch" && req.method === "POST") {
			const { file } = await body(req);
			await snapshot();
			// The list this came from is the only place it may point: a path from the browser is not
			// a reason to open a file anywhere on the disk, and `switch_session` on something that is
			// not a session is how you get an empty session written over it.
			const wanted = typeof file === "string" ? path.resolve(file) : "";
			const match = listSessionsHere().find((s) => path.resolve(s.file) === wanted);
			if (!match) return void json(res, { success: false, error: "no session of this project has that path" }, 400);
			// The resolved path, which is the one that was checked: pi's cwd is not this process's,
			// so a relative path would be checked here and opened somewhere else.
			return void json(res, await swapSession(path.resolve(match.file)));
		}
		if (url.pathname === "/queue/clear" && req.method === "POST") return void json(res, await rpc({ type: "clear_queue" }));
		if (url.pathname === "/trigger/immediate" && req.method === "POST") {
			// pie's "▶ run now". pi-loops exposes it as a command, and a command is a prompt here.
			const { id } = await body(req);
			if (!/^[A-Za-z0-9_-]{1,80}$/.test(id ?? "")) return void json(res, { success: false, error: "bad id" }, 400);
			const command = id.startsWith("dyn-") ? `/triggers run ${id}` : `/cron run ${id}`;
			return void json(res, await rpc({ type: "prompt", message: command }));
		}
		if (url.pathname === "/stats") {
			// pie's /cost, and the context gauge the TUI footer shows.
			const r = await rpc({ type: "get_session_stats" }, 20_000);
			return void json(res, r?.success ? r.data : { error: r?.error });
		}
		if (url.pathname === "/find" && req.method === "POST") {
			// pie's /find. `get_entries` is the whole tree, so this searches abandoned branches and
			// pre-compaction history too, which is exactly what you want when looking for something
			// you remember saying.
			const { q } = await body(req);
			const needle = String(q ?? "").toLowerCase();
			if (needle.length < 2) return void json(res, { hits: [] });
			const r = await cachedEntries();
			const hits = [];
			for (const e of r?.success ? (r.data?.entries ?? []) : []) {
				const m = e?.message;
				if (!m) continue;
				const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? c.thinking ?? "").join(" ");
				const at = text.toLowerCase().indexOf(needle);
				if (at === -1) continue;
				hits.push({ id: e.id, role: m.role, when: e.timestamp, excerpt: text.slice(Math.max(0, at - 60), at + 140) });
				if (hits.length >= 50) break;
			}
			return void json(res, { hits });
		}
		if (url.pathname === "/undo" && req.method === "POST") {
			// pie's /undo: fork from the last user message on this branch. pi hands back its text, so
			// the prompt returns to the composer rather than being lost.
			const r = await cachedEntries();
			if (!r?.success) return void json(res, { success: false, error: r?.error ?? "cannot read the session" }, 500);
			const entries = r.data?.entries ?? [];
			const last = [...entries].reverse().find((e) => e?.type === "message" && e.message?.role === "user");
			if (!last) return void json(res, { success: false, error: "nothing to undo" }, 400);
			const forked = await rpc({ type: "fork", entryId: last.id }, 30_000);
			entriesCache = { at: 0, value: undefined }; // the branch moved under us
			return void json(res, forked);
		}
		if (url.pathname === "/share" && req.method === "POST") {
			// pi-loops' command does the rendering, the redaction and the confirmation; its dialog
			// reaches the browser as an extension_ui_request like every other approval. It blocks on
			// that dialog, so this must not sit on a short timeout waiting for an answer.
			const { public: isPublic } = await body(req);
			if (!commandList.some((c) => c.name === "session-share")) return void json(res, { success: false, error: "pi-loops is not loaded in this session" }, 400);
			return void json(res, await rpc({ type: "prompt", message: isPublic ? "/session-share --public" : "/session-share" }, 600_000));
		}
		if (url.pathname === "/export" && req.method === "POST") {
			// pie's /save. pi writes the HTML itself; this only reports where it landed.
			return void json(res, await rpc({ type: "export_html" }, 60_000));
		}
		if (url.pathname === "/ui-response" && req.method === "POST") {
			// Named fields only: spreading the body would let the caller set `type` and write any
			// command it liked to pi's stdin through a route that is meant to answer a dialog.
			const { id, value, confirmed, cancelled } = await body(req);
			if (typeof id !== "string" || !id) return void json(res, { error: "id required" }, 400);
			live.pendingAsks.delete(id);
			const answer = { type: "extension_ui_response", id };
			if (cancelled === true) answer.cancelled = true;
			else if (typeof confirmed === "boolean") answer.confirmed = confirmed;
			else if (value !== undefined) answer.value = String(value);
			writeToPi(`${JSON.stringify(answer)}\n`);
			return void json(res, { ok: true });
		}
		if (url.pathname === "/rpc" && req.method === "POST") {
			// Escape hatch: anything in pi's protocol this UI has not grown a button for yet.
			return void json(res, await rpc(await body(req)));
		}
		json(res, { error: "not found" }, 404);
	} catch (err) {
		json(res, { error: String(err?.message ?? err) }, 500);
	}
});

/**
 * The port is fixed on purpose — one address, bookmarkable — and the price of a fixed port is that
 * you can collide with yourself. Running `pi-loops` twice is not a mistake worth an error message:
 * the second one hands you the window the first one is already serving, and gets out of the way
 * rather than leaving a second pi running behind a server that never bound.
 */
server.on("error", (err) => {
	if (err?.code !== "EADDRINUSE") {
		console.error(`pi-loops web: cannot listen on port ${PORT}: ${err?.message ?? err}`);
		return void leave(1);
	}
	const there = `http://127.0.0.1:${PORT}/`;
	// No credentials on this request. Whatever is on that port might not be one of ours, and a
	// secret sent to find that out has already been sent. An instance of this program answers the
	// header on its 403 too, so the question can be asked without proving anything.
	fetch(there)
		.then((r) => {
			if (r.headers.get("x-pi-loops-web") !== "1") throw new Error("not ours");
			console.log(`pi-loops web is already running on ${there} — opening that`);
			// A browser asked for a URL it already has open answers by bringing that tab forward,
			// without reloading it — so starting the session again handed you the same page you were
			// already looking at, however old it was. A different address every time means the tab
			// is replaced rather than merely focused, which is the difference between "it opened"
			// and "it opened the version I just installed".
			if (!flag("no-open") && process.stdout.isTTY) openBrowser(`${there}?opened=${Date.now().toString(36)}`);
			leave(0);
		})
		.catch(() => {
			console.error(`pi-loops web: port ${PORT} is taken by something else; --port <n> picks another`);
			leave(1);
		});
});

/** Take the pi we started with us: it has no server in front of it and nobody to talk to. */
function leave(code) {
	try {
		pi.kill("SIGTERM");
	} catch {
		// already gone, which is the outcome we wanted
	}
	process.exit(code);
}
server.listen(PORT, HOST_BIND, async () => {
	// The port actually bound, which is not the one asked for when that was 0.
	const port = server.address()?.port ?? PORT;
	console.log(`pi-loops web on http://${LOOPBACK ? "127.0.0.1" : HOST_BIND === "0.0.0.0" ? "127.0.0.1" : HOST_BIND}:${port}/`);
	if (!LOOPBACK) {
		for (const a of lanAddresses()) console.log(`  on this network: http://${a.address}:${port}/  (${a.name})`);
		// Worth saying once, out loud: this is plain http, and the cookie it hands out is a token
		// that outlives the process. `tailscale serve` gets the same phone in over TLS and leaves
		// this server on loopback, which is why the docs lead with it.
		console.log("  this is unencrypted; on a network you do not own, prefer: tailscale serve --bg " + port);
	}
	// The code is what another device actually uses: the door page asks for it, so nobody types 32
	// hex characters on a screen keyboard. Printed on loopback too, because `tailscale serve` puts a
	// phone in front of a loopback-bound server and that phone still has to get in once. On a
	// terminal only — it stays live until someone pairs, so a log file holding it is a log file
	// holding the way in. A browser that is already signed in can mint another through /pair.
	if (process.stdout.isTTY) console.log(`  pairing code for another device: ${newPairCode()}`);
	if (NO_AUTH) console.log("  --no-auth: anything that can reach this port can drive this session");
	// Only needed by a browser that has not been here before; after one visit the cookie is enough.
	// On a terminal only: this token outlives the process now, and stdout redirected to a file is a
	// credential written to a file, where a per-launch random one used to expire on its own.
	else if (process.stdout.isTTY) console.log(`  first visit from another browser: http://127.0.0.1:${port}/?token=${TOKEN}`);
	await refreshCatalogues();
	await primeRuntime();
	if (!flag("no-open") && process.stdout.isTTY) {
		openKeyExpires = Date.now() + 60_000;
		openBrowser(`http://127.0.0.1:${port}/?open=${openKey}`);
	}
});

/**
 * The addresses another device on your networks could actually use.
 *
 * `internal` in Node means loopback and nothing else, so the raw list also contains every virtual
 * bridge this machine happens to run — docker0, libvirt, VirtualBox. Those are addresses that
 * belong to something else on the phone's network, and sending a live pairing code to one hands a
 * secret to a stranger. Named ones are dropped; the rest are ordered by how likely they are to be
 * the one that works, tailnet first, and each is shown with its interface so a wrong guess here is
 * visible rather than silent.
 */
const VIRTUAL = /^(docker|virbr|br-|veth|vmnet|vboxnet|lxcbr|podman|cni|flannel|kube)/i;

function lanAddresses() {
	const out = [];
	for (const [name, list] of Object.entries(os.networkInterfaces())) {
		if (VIRTUAL.test(name)) continue;
		for (const ni of list ?? []) {
			if (ni.family !== "IPv4" || ni.internal) continue;
			const [a, b] = ni.address.split(".").map(Number);
			// 100.64/10 is the range Tailscale hands out: if there is one, it is the answer.
			const rank = a === 100 && b >= 64 && b <= 127 ? 0 : a === 192 && b === 168 ? 1 : a === 10 ? 2 : 3;
			out.push({ address: ni.address, name, rank });
		}
	}
	return out.sort((x, y) => x.rank - y.rank);
}

function openBrowser(url) {
	const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	try {
		spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
	} catch {
		/* a URL on stdout is enough */
	}
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		try {
			pi.kill("SIGTERM");
		} catch {
			/* already gone */
		}
		process.exit(0);
	});
}

/**
 * What an unauthorised browser gets. Deliberately not the token: this is the request that has not
 * proved anything. Telling you where it lives costs an attacker nothing they did not already have
 * — reading the file needs your account — and saves you a search.
 */
const DOOR = `<!doctype html><meta charset="utf-8"><title>pi-loops</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<body style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;background:Canvas;color:CanvasText">
<h2 style="font-weight:600">This browser has not been here before.</h2>
<p>Start the session from a terminal on this machine and it will open a window that works from
then on:</p>
<pre style="background:#8881;padding:.7rem 1rem;border-radius:6px;overflow:auto">pi-loops</pre>
<p style="opacity:.7">On a browser that is already signed in, press <b>add device</b> — it shows a
QR to point this camera at, and the same six digits to type if you would rather. Either way, this
device stays signed in afterwards.</p>
<form method="get" style="display:flex;gap:.5rem">
  <input name="pair" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6"
         placeholder="000000" style="font:inherit;letter-spacing:.3em;padding:.55rem .7rem;flex:1;min-width:0;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit">
  <button style="font:inherit;padding:.55rem 1rem;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit">enter</button>
</form>`;

/**
 * What you chose last time, so the next session starts there.
 *
 * A session opens on pi's default model, which is why choosing the same one every morning was the
 * first thing this front end asked of anybody. It lives next to the loops rather than in the
 * package, so it survives an upgrade, and the launcher is what applies it — the terminal window
 * gets the same memory as this one.
 */
function rememberPref(key, value) {
	const file = path.join(LOOPS_DIR, "ui.json");
	let doc = {};
	try {
		doc = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
	} catch {
		// no file yet, or one that is not readable as JSON: this write replaces it
	}
	if (doc[key] === value) return;
	doc[key] = value;
	try {
		fs.mkdirSync(LOOPS_DIR, { recursive: true });
		fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
	} catch (err) {
		console.error(`pi-loops web: could not remember ${key}: ${err?.message ?? err}`);
	}
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
function previewRoot(file) {
	if (inside(file, sessionCwd)) return sessionCwd;
	const home = os.homedir();
	// A container with HOME=/ would make the whole disk a preview root, which is not a home
	// directory in any sense this rule means.
	if (home && home !== "/" && inside(file, home)) return home;
	return undefined;
}

/** The path the filesystem actually means: symlinks followed as far as anything exists. */
function realOf(file) {
	try {
		return fs.realpathSync(file);
	} catch {
		try {
			return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
		} catch {
			return path.resolve(file);
		}
	}
}

/** What is worth *looking* at, as opposed to reading: the list that applies outside the project. */
const VISUAL_TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".pdf", ".html", ".htm"]);

/** What a preview will serve, and nothing else: an extension not on this list is not previewed. */
const PREVIEW_TYPES = {
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
/** HTML written into the conversation instead of into a file, kept just long enough to look at. */
const previews = new Map();

/** Maskable, so Android can crop it to whatever shape the launcher uses without eating the mark. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="#111"/>
<g fill="none" stroke="#4ade80" stroke-width="34" stroke-linecap="round">
<path d="M150 190h212"/><path d="M212 190v148"/><path d="M300 190v112a36 36 0 0 0 62 24"/>
</g></svg>`;

/* ------------------------------------------------------------------ the page */

const PAGE = String.raw`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest">
<script>
  // Before the first paint, which is the whole reason it is up here in a tag of its own rather
  // than with the rest of the script: applied any later, the page renders light and then blinks.
  try { var t = localStorage.getItem("theme"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch (e) {}
</script>
<title>pi web</title>
<style>
/* Named colours rather than translucent greys over whatever the browser paints. Every surface is
   stated, so the page looks the same on a machine whose default background is not white — and so
   dark is a design rather than an inversion of light. */
:root{
  color-scheme:light;
  --bg:#f7f7f7;--panel:#fff;--side:#fafafa;--field:#fff;--soft:#eee;
  --ink:#111;--muted:#666;--faint:#999;--line:#dcdcdc;--line-strong:#bbb;
  --accent:#2f7d5d;--warn:#a4620f;--bad:#b3261e;--shadow:rgba(0,0,0,.14);
  /* Two fonts, because there are two kinds of text here. Prose — what the model wrote, what you
     wrote — reads better proportional, Chinese especially. Anything that came from a terminal or
     has columns in it stays monospace, and that stack names CJK faces whose characters are exactly
     twice the ASCII advance: without one, a box a terminal drew comes apart on the first Chinese
     character. */
  --font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Sarasa Mono SC","Noto Sans Mono CJK SC","Source Han Mono SC",monospace;
  /* One column of text, centred, however wide the window is: a 2000px line is not readable. The
     composer uses the same figure so the two line up. */
  --pad:max(16px,calc((100% - 58rem) / 2));
}
@media (prefers-color-scheme:dark){html:not([data-theme=light]){
  color-scheme:dark;
  --bg:#0a0a0a;--panel:#0f0f0f;--side:#0c0c0c;--field:#161616;--soft:#1c1c1c;
  --ink:#f2f2f2;--muted:#a0a0a0;--faint:#6a6a6a;--line:#282828;--line-strong:#454545;
  --accent:#5fbf93;--warn:#d99a4e;--bad:#e26a62;--shadow:rgba(0,0,0,.5);
}}
html[data-theme=dark]{
  color-scheme:dark;
  --bg:#0a0a0a;--panel:#0f0f0f;--side:#0c0c0c;--field:#161616;--soft:#1c1c1c;
  --ink:#f2f2f2;--muted:#a0a0a0;--faint:#6a6a6a;--line:#282828;--line-strong:#454545;
  --accent:#5fbf93;--warn:#d99a4e;--bad:#e26a62;--shadow:rgba(0,0,0,.5);
}
*{box-sizing:border-box}
/* dvh, not vh: a phone's address bar slides away and 100vh keeps counting the space it used to
   occupy, so the composer sits below the fold exactly when you are trying to type into it. */
body{margin:0;height:100vh;height:100dvh;display:flex;background:var(--bg);color:var(--ink);font:15px/1.62 var(--font-ui);-webkit-font-smoothing:antialiased}
main{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--panel)}

header{display:flex;gap:10px;align-items:center;padding:9px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap;min-height:52px}
header b{font-weight:650}
header .cwd{color:var(--muted);font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 9px;background:var(--field);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(34vw,26rem)}
header .grow{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
select,button,textarea,input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:5px 9px}
/* A select's dropdown is drawn by the platform, not by the page. With a transparent background the
   list is painted on system white while the options keep the page's text colour — light-on-white in
   a dark theme. Canvas and CanvasText follow color-scheme, so both halves agree in both themes. */
select,option{background:Canvas;color:CanvasText}
select:focus,textarea:focus,input:focus{outline:none;border-color:var(--line-strong)}
button{cursor:pointer;color:var(--muted)}
button:hover{color:var(--ink);background:var(--soft)}
button.primary{border-color:var(--accent);color:var(--ink)}
.badge{border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px;color:var(--muted);white-space:nowrap}

/* Not a toast that fades: this is the difference between the window working and not, and it stays
   until it is dealt with. Clicking it does the one thing it asks for. */
#stale{display:block;width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;
       background:var(--warn);color:#fff;padding:7px var(--pad);text-align:left;font-size:13px}
#stale:hover{background:var(--warn);color:#fff;filter:brightness(1.08)}
#stale[hidden]{display:none}
#findbar{display:flex;gap:8px;align-items:center;padding:7px var(--pad);border-bottom:1px solid var(--line);background:var(--side)}
/* The UA rule for [hidden] loses to any author rule that sets display, so this has to say it. */
#findbar[hidden]{display:none}
#findbar input{flex:1}
.hit{border-left:2px solid var(--line-strong);padding-left:10px;font-size:13px;color:var(--muted);font-family:var(--font-mono)}

#feed{flex:1;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:20px var(--pad) 24px;display:flex;flex-direction:column;gap:14px;overflow-wrap:anywhere}
/* The feed is a column flexbox with a definite height, so its children shrink by default: a tall
   block — an expanded tool, a long reply — was squeezed to fit instead of making the feed scroll,
   and its last line was cut in half. */
#feed>*{flex:0 0 auto}
.row{position:relative;min-width:0;max-width:100%}
.role{display:flex;gap:8px;align-items:center;color:var(--faint);font-size:11px;letter-spacing:.03em;text-transform:uppercase;margin-bottom:3px}
/* The copy button is not part of the conversation, so it waits until you are on the block. A finger
   has no hover, so on a touch screen it is simply always there. */
.role button{border:0;padding:0 5px;font-size:11px;background:none;min-height:0;color:var(--faint);opacity:0;text-transform:none}
.row:hover .role button,.row:focus-within .role button{opacity:1}
.role button:hover{color:var(--ink);background:none}
@media (pointer:coarse){.role button{opacity:.7}}

/* You, on the right, in a bubble; the model, full width, as prose. The shape says who is speaking
   before a word of it is read, which is most of what makes a long session scannable. */
.row.user{align-self:flex-end;max-width:min(84%,40rem)}
.row.user>span{display:block;white-space:pre-wrap;background:var(--soft);border-radius:16px 16px 5px 16px;padding:9px 14px}
.row.user .role{justify-content:flex-end}
/* Status lines are context, not conversation: quiet, small, monospace. */
.notice{color:var(--muted);font-family:var(--font-mono);font-size:12.5px;white-space:pre-wrap}
.err{color:var(--ink);border-left:2px solid var(--bad);padding-left:10px;font-family:var(--font-mono);font-size:12.5px;white-space:pre-wrap}
.row>span{white-space:pre-wrap;word-break:break-word}
/* The markdown body is block-level HTML; pre-wrap there turns the whitespace between tags into
   blank lines. It is set on the span itself, so the selector has to be more specific than .row>span. */
.row>span.md,.md{white-space:normal}

/* A tool call and what it returned are one thing, and it is closed. A tool that prints two hundred
   lines should not push the conversation off the screen to do it. */
/* The run of them is the block; each one inside is a line. */
/* Closed, it is a line of text — a box drawn around one line is itself the noise this is about.
   The box appears when you open it, because then there is something in it. */
details.work{border:1px solid transparent;border-radius:10px;overflow:hidden}
details.work[open]{border-color:var(--line);background:var(--side)}
details.work:not([open])>summary{padding-left:0;padding-right:0}
details.work>summary{cursor:pointer;display:flex;align-items:center;gap:8px;padding:7px 11px;font-family:var(--font-mono);font-size:12px;color:var(--muted);list-style:none}
details.work>summary::-webkit-details-marker{display:none}
details.work>summary::before{content:"▸";color:var(--faint);flex:0 0 auto}
details.work[open]>summary::before{content:"▾"}
details.work>summary>span.what{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.work>summary:hover{color:var(--ink)}
details.work>details.tool,details.work>details.think,details.work>.note{border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;padding:6px 11px}
details.work>.note{color:var(--muted);font-family:var(--font-mono);font-size:12px;white-space:pre-wrap}
details.tool{border:1px solid var(--line);border-radius:10px;background:var(--side);overflow:hidden}
details.tool>summary{cursor:pointer;display:flex;align-items:center;gap:8px;padding:7px 11px;font-family:var(--font-mono);font-size:12px;color:var(--muted);list-style:none}
details.tool>summary::-webkit-details-marker{display:none}
details.tool>summary::before{content:"▸";color:var(--faint);flex:0 0 auto}
details.tool[open]>summary::before{content:"▾"}
details.tool>summary>span.what{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.tool>summary>span.state{color:var(--faint);font-size:11px}
details.tool>summary>button{border:0;background:none;color:var(--faint);padding:0 5px;font-size:11px;min-height:0;opacity:0}
details.tool:hover>summary>button,details.tool:focus-within>summary>button{opacity:1}
@media (pointer:coarse){details.tool>summary>button{opacity:.7}}
details.tool>summary:hover{color:var(--ink)}
details.tool.err{border-color:var(--bad);padding-left:0}
details.tool pre{margin:0;padding:9px 11px;border-top:1px solid var(--line);max-height:22em;overflow:auto;color:var(--muted)}
details.think{color:var(--muted)}
details.think:not([open])>summary{padding-left:0}
details.think>summary{cursor:pointer;font-size:12px;color:var(--faint);list-style:none}
details.think>summary::-webkit-details-marker{display:none}
details.think>summary::before{content:"▸ ";color:var(--faint)}
details.think>summary .peek{color:var(--faint);font-style:italic}
details.think[open]>summary .peek{display:none}
details.think[open]>summary::before{content:"▾ "}
details.think pre{border-left:2px solid var(--line);padding-left:10px;font-style:italic;font-size:13px}
pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;max-height:22em;overflow:auto;font-family:var(--font-mono);font-size:12.5px;line-height:1.55}

.empty{margin:auto;max-width:34rem;color:var(--muted);text-align:center}
.empty h2{font-size:15px;font-weight:650;color:var(--ink);margin:0 0 6px}
.empty p{margin:.4em 0}
.empty code{font-family:var(--font-mono);font-size:12.5px;background:var(--soft);border-radius:5px;padding:1px 5px}

.md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
.md p{margin:0 0 10px}
.md h3,.md h4,.md h5,.md h6{margin:14px 0 7px;line-height:1.25;font-weight:650}
.md h3{font-size:16px}.md h4{font-size:14.5px}.md h5,.md h6{font-size:13.5px;color:var(--muted)}
.md ul,.md ol{margin:0 0 10px 22px;padding:0}.md li{margin:3px 0}
.md blockquote{margin:0 0 10px;padding-left:12px;border-left:2px solid var(--line-strong);color:var(--muted)}
.md code{border:1px solid var(--line);border-radius:5px;background:var(--side);padding:1px 5px;font-family:var(--font-mono);font-size:.88em;overflow-wrap:anywhere}
.md pre.code{border:1px solid var(--line);border-radius:10px;background:var(--side);padding:11px 12px;margin:0 0 10px;position:relative;white-space:pre;overflow:auto;max-height:none}
.md pre.code code{border:0;background:none;padding:0;font-size:13px}
.md pre.code[data-lang]::before{content:attr(data-lang);position:absolute;top:4px;right:9px;font-size:10px;color:var(--faint)}
.md pre.code button.preview{position:absolute;top:2px;right:44px;font-size:11px;padding:1px 8px;min-height:0;background:var(--panel)}
.md hr{border:0;border-top:1px solid var(--line);margin:14px 0}
.md a{color:var(--ink);text-decoration:underline;text-underline-offset:2px}
/* A link to something on disk says so, so it is not mistaken for a link to the web. */
.md a.file::before{content:"⇱ ";color:var(--faint);text-decoration:none}
/* A path that was written in backticks keeps looking like one, and is a link as well. */
.md a.file>code{border-color:var(--line-strong)}
.md img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;margin:4px 0;display:block}
.md table{border-collapse:collapse;margin:0 0 10px;display:block;overflow-x:auto;max-width:100%;font-size:13.5px}
.md th,.md td{border:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top}
.md th{font-weight:650;background:var(--soft);white-space:nowrap}

/* Sitting just above the composer, out of the way of the text, and only while there is something
   below the fold to go to. */
#newer{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 6px);z-index:6;
       border-radius:999px;padding:4px 12px;font-size:12.5px;background:var(--field);
       border-color:var(--line-strong);box-shadow:0 4px 14px var(--shadow)}
form#composer{display:flex;flex-direction:column;gap:7px;padding:10px var(--pad) calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--panel);position:relative}
.composer-row{display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;resize:none;min-height:46px;max-height:40vh;background:var(--field);border-color:var(--line-strong);border-radius:12px;padding:10px 13px}
.hint{font-size:12px;color:var(--faint);display:flex;gap:10px}
#thumbs{display:flex;gap:6px;flex-wrap:wrap}
#thumbs .thumb{position:relative;line-height:0}
#thumbs img{height:46px;border:1px solid var(--line);border-radius:6px}
img.shot{max-width:100%;max-height:26em;height:auto;border:1px solid var(--line);border-radius:8px;margin:6px 0 0;display:block}
#thumbs .x{position:absolute;top:-6px;right:-6px;width:20px;height:20px;min-height:0;padding:0;border-radius:999px;background:var(--panel);border:1px solid var(--line-strong);color:var(--muted);font-size:12px;line-height:1}
#pop{position:absolute;bottom:100%;left:var(--pad);right:var(--pad);max-height:min(15em,32vh);overflow:auto;border:1px solid var(--line-strong);border-radius:8px;background:var(--field);box-shadow:0 10px 30px var(--shadow);display:none;z-index:5}
#pop div{padding:8px 11px;cursor:pointer;display:flex;gap:10px;border-bottom:1px solid var(--line)}
#pop div:last-child{border-bottom:0}
#pop div.sel,#pop div:hover{background:var(--soft)}
#pop .h{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

aside{width:21rem;border-left:1px solid var(--line);overflow:auto;background:var(--side);padding:0}
aside.hidden{display:none}
aside>div{padding:14px 15px;border-bottom:1px solid var(--line)}
aside h2{font-size:12px;font-weight:700;color:var(--ink);margin:0 0 9px;letter-spacing:0;text-transform:none}
.card{border:1px solid var(--line);border-radius:8px;background:var(--field);padding:8px 10px;margin-bottom:7px;font-size:13px}
.card .t{display:flex;gap:7px;align-items:center}
.card .t b{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .m{color:var(--muted);font-size:12px}
.card button{padding:2px 9px;font-size:12px;margin-left:auto;min-height:0}
.off{opacity:.5}
.dot{display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:6px;vertical-align:middle}
.up{background:var(--accent)}.down{background:var(--bad)}.idle{background:var(--faint)}
/* Counts as a row of figures rather than a sentence: the number is the thing being read, and each
   one is a target big enough for a finger. */
.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--field);margin-top:8px}
.metrics>*{min-width:0;padding:8px 9px;border-right:1px solid var(--line);text-align:left;min-height:46px;border-radius:0;border-top:0;border-bottom:0}
.metrics>*:last-child{border-right:0}
.metrics b{display:block;font-size:16px;line-height:1.2;color:var(--ink)}
.metrics span{display:block;color:var(--muted);font-size:11px}
button.metric{background:none;border-left:0;cursor:pointer}
button.metric:hover{background:var(--soft)}
button.count{border:0;padding:0;background:none;font:inherit;min-height:0;text-decoration:underline dotted;text-underline-offset:2px;color:inherit}
button.count:hover{background:none;color:var(--ink)}

dialog{border:1px solid var(--line);border-radius:12px;padding:16px;max-width:42rem;width:min(92vw,42rem);background:var(--panel);color:var(--ink);box-shadow:0 16px 48px var(--shadow)}
dialog::backdrop{background:rgba(0,0,0,.4)}
dialog h3{margin:0 0 10px;font-size:14px;font-weight:650}
dialog pre{background:var(--side);border:1px solid var(--line);padding:9px 10px;border-radius:8px}
dialog menu{display:flex;gap:8px;justify-content:flex-end;padding:0;margin:14px 0 0}
#pairPick{width:100%;margin-bottom:8px}
.qr{display:flex;justify-content:center;padding:6px 0}
.qr svg{width:min(62vw,240px);height:auto;background:#fff;padding:8px;border-radius:8px}
/* By id, not by a class called "code": markdown fenced blocks are <pre class="code"> and were
   inheriting this one's letter-spacing, which spread every line of code out across the page. */
#pairCode{text-align:center;font-size:32px;letter-spacing:.28em;padding:8px 0 2px;font-variant-numeric:tabular-nums;font-family:var(--font-mono)}
#pairWhere{text-align:center;padding-bottom:4px}
.detail-row{padding:4px 0;border-bottom:1px solid var(--line);font-size:13px;font-family:var(--font-mono)}
.detail-row:last-child{border-bottom:0}
/* A session is picked by recognising the conversation, so the first thing said is the line that
   matters and everything else is a caption under it. */
#sessBody{max-height:60vh;overflow:auto}
.sess{display:block;width:100%;text-align:left;padding:9px 10px;margin-bottom:6px;border:1px solid var(--line);
      border-radius:9px;background:var(--side);color:var(--ink);cursor:pointer}
.sess:hover{border-color:var(--accent)}
/* Two lines of the opening prompt, so a long one does not turn the list into a page. */
.sess b{font-weight:600;font-size:13px;line-height:1.35;
        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sess span{display:block;margin-top:3px;font-size:11px;color:var(--muted);font-family:var(--font-mono)}
.sess[disabled]{cursor:default;opacity:.75;border-style:dashed}
.sess[disabled]:hover{border-color:var(--line)}
#detailBody{max-height:60vh;overflow:auto}

/* ---------------------------------------------------------------- narrow screens */
/* The panel is not dropped on a phone, it is put behind a button: what a loop is doing is the
   reason to open this on a phone at all. It slides over the conversation rather than taking a
   third of it, the way a drawer does everywhere else. */
#drawer,#more{display:none}
/* The drawer covers the conversation, so tapping "somewhere else" has to mean the whole of
   somewhere else — not the 47px strip the drawer happens to leave. It dims what it covers, which
   is also how you know the panel is on top of the conversation rather than beside it. */
#scrim{display:none}
#actions{display:contents}
/* In the sheet they are a list, not a row, and each one is a full-width target. */
#menuBody #actions{display:flex;flex-direction:column;gap:8px}
#menuBody #actions button{width:100%;text-align:left;min-height:44px}
@media (max-width:900px){
  :root{--pad:12px}
  #drawer,#more{display:inline-block}
  /* Thirteen controls do not fit across a phone. The ones you reach for mid-conversation stay;
     the rest are one tap away behind ⋯, which is where they belong on a screen this size. */
  header>#actions,.grow>#actions{display:none}
  #menuBody #actions{display:flex}
  aside{position:fixed;top:0;right:0;bottom:0;width:min(88vw,23rem);z-index:40;
        box-shadow:-14px 0 40px var(--shadow);transform:translateX(101%);transition:transform .18s ease;
        padding-bottom:calc(10px + env(safe-area-inset-bottom))}
  aside.hidden{display:block}
  aside.open{transform:none}
  #scrim:not([hidden]){display:block;position:fixed;inset:0;z-index:39;background:rgba(0,0,0,.4)}
  header{padding:8px 12px;gap:7px;padding-top:calc(8px + env(safe-area-inset-top))}
  #feed{gap:12px}
  .row.user{max-width:92%}
  /* Anything under 16px makes iOS Safari zoom the whole page the moment you focus it, and it does
     not zoom back out. Touch targets get a finger's worth of height at the same time. */
  textarea,input,select{font-size:16px}
  textarea{min-height:44px}
  /* Three buttons beside the box left it about 150 characters wide, with its own scrollbar. The
     box gets the width; the buttons get a row of their own and split it. */
  .composer-row{flex-wrap:wrap}
  .composer-row textarea{flex:1 1 100%}
  .composer-row button{flex:1 1 0}
  /* The path is in the Session panel. Here it was costing a whole header row, on a screen where
     the header was already taking an eighth of the height. */
  header .cwd{display:none}
  /* And the name of the program, which is on the tab, the home screen icon and the address bar
     already. What is left fits on one row: which model, how hard it is thinking, what it cost,
     whether it is busy. */
  header>b{display:none}
  header select{max-width:8.5rem}
  header{min-height:0}
  button{padding:8px 12px;min-height:40px}
  .card button,.role button{min-height:32px}
  .hint{display:none}
}
@media (pointer:coarse){button,select{min-height:40px}}
</style>
<main>
  <header>
    <b>pi web</b>
    <span class="cwd" id="cwd"></span>
    <select id="model" title="Model"></select>
    <select id="thinking" title="Thinking level">
      <option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option>
    </select>
    <span class="grow">
      <span class="badge" id="queue" hidden></span>
      <span class="badge" id="cost" title="Session tokens and cost"></span>
      <button id="expand" title="Expand every step">▸ steps</button>
      <span id="actions">
        <button id="reload" title="Load this page again from the server">reload</button>
        <button id="find" title="Search the whole session, including abandoned branches" aria-label="Search this session">find</button>
        <button id="undo" title="Fork from your last message and put it back in the composer">undo</button>
        <button id="save" title="Export this session as HTML">save</button>
        <button id="share" title="Upload a redacted transcript as a GitHub gist (asks first)">share</button>
        <button id="compact" title="Summarise the context so far and carry on (/compact &lt;instructions&gt; steers it)">compact</button>
        <button id="clear" title="Start a new session — this one stays on disk">clear</button>
        <button id="resume" title="Go back to an earlier session in this project">resume</button>
        <button id="adddev" title="Show a code and a QR for signing in another device" aria-label="Add a device">add device</button>
        <button id="theme" title="Theme: system, light, dark" aria-label="Change theme">◐</button>
      </span>
      <span class="badge" id="status">connecting</span>
      <button id="more" title="Session actions" aria-label="Session actions">⋯</button>
      <button id="drawer" title="Automation, runtime and session panel" aria-label="Toggle the side panel" aria-expanded="true">panel</button>
    </span>
  </header>
  <div id="findbar" hidden><input id="findq" placeholder="search this session…" ><span id="findn" class="notice"></span></div>
  <button id="stale" hidden></button>
  <div id="feed" role="log" aria-live="polite" aria-label="Conversation"></div>
  <form id="composer">
    <button type="button" id="newer" hidden>↓ newer</button>
    <div id="pop"></div>
    <div id="thumbs"></div>
    <div class="composer-row">
      <textarea id="input" placeholder="Message pi — / for commands, @ for files, Enter sends"></textarea>
      <button type="button" id="attach">attach</button>
      <button type="submit" class="primary">send</button>
      <button type="button" id="stop">stop</button>
    </div>
    <div class="hint"><span>Enter send · Shift+Enter newline · paste images</span><span id="sid"></span></div>
    <input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
  </form>
</main>
<aside>
  <div><h2>Automation</h2><div id="auto"></div></div>
  <div><h2>Runtime</h2><div id="runtime" class="notice">—</div></div>
  <div><h2>Goal</h2><div id="goal" class="notice">none</div></div>
  <div><h2>Session</h2><div id="meta" class="notice"></div></div>
</aside>
<div id="scrim" hidden></div>
<dialog id="menu" aria-label="Session actions" role="dialog">
  <h3>Session</h3><div id="menuBody"></div>
  <menu><button id="menuClose" value="close">close</button></menu>
</dialog>
<dialog id="pairdlg" aria-labelledby="pairTitle" role="dialog">
  <h3 id="pairTitle">Add a device</h3>
  <select id="pairPick" aria-label="Which address to point that device at" hidden></select>
  <div id="pairQr" class="qr"></div>
  <div id="pairCode"></div>
  <div id="pairWhere" class="notice"></div>
  <menu><button id="pairClose" value="close">close</button></menu>
</dialog>
<dialog id="detail" aria-labelledby="detailTitle" role="dialog">
  <h3 id="detailTitle"></h3><div id="detailBody"></div>
  <menu><button value="close">close</button></menu>
</dialog>
<dialog id="sessdlg" aria-labelledby="sessTitle" role="dialog">
  <h3 id="sessTitle">Earlier sessions</h3>
  <div id="sessBody"></div>
  <menu><button id="sessClose" value="close">close</button></menu>
</dialog>
<dialog id="ask" aria-labelledby="askTitle" role="dialog"><form method="dialog">
  <h3 id="askTitle"></h3><pre id="askBody"></pre><div id="askWhy" class="notice" hidden></div><div id="askField"></div>
  <menu><button value="cancel">cancel</button><button value="ok" class="primary" id="askOk">approve</button></menu>
</form></dialog>
<script>
const TOKEN = "__TOKEN__";
/** The version this page was served by. The server says its own in /state; a difference is age. */
const PAGE_VERSION = "__VERSION__";
const api = (p, b) => fetch(p + (p.includes("?") ? "&" : "?") + "token=" + TOKEN, b === undefined ? {} : { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
const $ = (id) => document.getElementById(id);
const feed = $("feed"), statusEl = $("status");
let state = {}, cwd = "", busy = false, atBottom = true, takesImages = true;
/** Installed once the stream is up; until then a poll has nothing to compare against. */
let checkStream;

feed.addEventListener("scroll", () => {
  atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  if (atBottom) $("newer").hidden = true;
});
/**
 * Following the bottom, but only while you are at it: an update must not yank the page while you
 * are reading back through it. The cost of that is silence — a reply arrives, a tool finishes, and
 * nothing on screen says so — which is what the pill is for.
 */
const scroll = () => {
  if (atBottom) {
    feed.scrollTop = feed.scrollHeight;
    $("newer").hidden = true;
  } else {
    $("newer").hidden = false;
  }
};

/**
 * Text on its way to the screen. pi's session carries whatever was written to it, and plenty of
 * that was written for a terminal: an extension's startup banner, a coloured diff, a spinner. A
 * browser has no terminal to interpret those, so without this you read the escape codes themselves
 * — ESC[38;5;240m before every box character. Stripped rather than rendered: colour is not what
 * those bytes are here for, and a page that executes terminal control sequences is a worse idea.
 */
function plain(s) {
  return String(s ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[[(][0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    // Bidi embeddings, overrides and isolates: invisible characters that reorder the line drawn
    // around them. A session named "delete\u202e evil red" draws as "deleteder live" — a different
    // conversation from the one that would open, in the control that decides which one opens. The
    // marks ordinary mixed-direction text uses (U+200E, U+200F) are left alone; these are the ones
    // whose only use on a line of someone else's text is to make it say something else.
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * A QR code, so a phone is pointed at the screen instead of typing a token.
 *
 * Byte mode, error correction level M, versions 1 to 6 — 106 characters, which is more than any
 * address this prints. Verified against a real decoder (OpenCV) at every length up to that, not
 * against another encoder: what matters is whether a scanner reads it.
 *
 */
const CAP = [null, 14, 26, 42, 62, 84, 106];
const TOTAL = [null, 26, 44, 70, 100, 134, 172];
const BLOCKS = [null, 1, 1, 1, 2, 2, 4];
const ECPB = [null, 10, 16, 26, 18, 24, 16];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    // The coefficients run highest power first, so multiplying by x keeps each index and
    // multiplying by a constant moves one to the right. Written the other way round this builds
    // the reverse polynomial, which produces plausible-looking parity that no scanner accepts.
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecc(data, n) {
  const gen = generator(n);
  const rest = new Uint8Array(data.length + n);
  rest.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = rest[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) rest[i + j] ^= mul(gen[j], factor);
  }
  return rest.slice(data.length);
}

function bitsOf(text) {
  const bytes = new TextEncoder().encode(text);
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(4, 4);            // byte mode
  push(bytes.length, 8); // count, 8 bits for versions 1-9
  for (const b of bytes) push(b, 8);
  return { bits, length: bytes.length };
}

function encode(text) {
  const { bits, length } = bitsOf(text);
  const version = CAP.findIndex((c, i) => i > 0 && c >= length);
  if (version < 1) return undefined; // longer than this encoder covers
  const dataWords = TOTAL[version] - BLOCKS[version] * ECPB[version];
  for (let i = 0; i < 4 && bits.length < dataWords * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0; words.length < dataWords; pad++) words.push(pad % 2 ? 0x11 : 0xec);

  // Split into blocks, each with its own error correction, then interleave both halves.
  const n = BLOCKS[version];
  const short = Math.floor(dataWords / n);
  const long = dataWords % n; // that many blocks at the end carry one extra data codeword
  const blocks = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = short + (i >= n - long ? 1 : 0);
    const data = Uint8Array.from(words.slice(at, at + size));
    at += size;
    blocks.push({ data, ec: ecc(data, ECPB[version]) });
  }
  const out = [];
  for (let i = 0; i < short + 1; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ECPB[version]; i++) for (const b of blocks) out.push(b.ec[i]);
  return { version, size: 17 + version * 4, words: out };
}

/* ------------------------------------------------------------------ the matrix */

const FORMAT_MASK = 0x5412;

function formatBits(mask) {
  // EC level M is 00; the five data bits are that plus the mask, extended by BCH(15,5).
  let value = (0b00 << 3) | mask;
  let rest = value << 10;
  for (let i = 4; i >= 0; i--) if ((rest >> (i + 10)) & 1) rest ^= 0x537 << i;
  return ((value << 10) | rest) ^ FORMAT_MASK;
}

function blank(size) {
  return { m: Array.from({ length: size }, () => new Int8Array(size).fill(-1)), size };
}

function place(grid, r, c, v) {
  grid.m[r][c] = v;
}

function finder(grid, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= grid.size || cc >= grid.size) continue;
      const edge = dr === -1 || dr === 7 || dc === -1 || dc === 7;
      const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      place(grid, rr, cc, edge ? 0 : ring || core ? 1 : 0);
    }
  }
}

function reserveFormat(grid) {
  const s = grid.size;
  for (let i = 0; i < 9; i++) {
    if (grid.m[8][i] === -1) place(grid, 8, i, 0);
    if (grid.m[i][8] === -1) place(grid, i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    place(grid, 8, s - 1 - i, 0);
    place(grid, s - 1 - i, 8, 0);
  }
  place(grid, s - 8, 8, 1); // the dark module, always set
}

function skeleton(version) {
  const grid = blank(17 + version * 4);
  const s = grid.size;
  finder(grid, 0, 0);
  finder(grid, 0, s - 7);
  finder(grid, s - 7, 0);
  for (let i = 8; i < s - 8; i++) {
    place(grid, 6, i, i % 2 === 0 ? 1 : 0);
    place(grid, i, 6, i % 2 === 0 ? 1 : 0);
  }
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if (grid.m[r][c] !== -1) continue; // never on top of a finder
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          place(grid, r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }
  reserveFormat(grid);
  return grid;
}

/** The zigzag: two columns at a time, right to left, skipping the timing column. */
function fill(grid, words) {
  const bits = [];
  for (const w of words) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
  const s = grid.size;
  let at = 0;
  let up = true;
  for (let right = s - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern is not a data column
    for (let step = 0; step < s; step++) {
      const row = up ? s - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (grid.m[row][col] !== -1) continue;
        grid.m[row][col] = at < bits.length ? bits[at++] : 0;
      }
    }
    up = !up;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m, s) {
  let score = 0;
  // Rule 1: runs of five or more of the same colour, in both directions.
  for (let i = 0; i < s; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < s; j++) {
        if (line[j] === line[j - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }
  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < s - 1; r++) for (let c = 0; c < s - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // Rule 3: the finder-like pattern, which must not appear in the data.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, at, pat) => pat.every((v, k) => line[at + k] === v);
  for (let i = 0; i < s; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= s; j++) {
      for (const line of [row, col]) if (matches(line, j, A) || matches(line, j, B)) score += 40;
    }
  }
  // Rule 4: how far the proportion of dark modules is from half.
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  score += Math.floor(Math.abs((dark * 100) / (s * s) - 50) / 5) * 10;
  return score;
}

function matrixWithMask(text, only) {
  const data = encode(text);
  if (!data) return undefined;
  const base = skeleton(data.version);
  const reserved = base.m.map((row) => Int8Array.from(row, (v) => (v === -1 ? 0 : 1)));
  fill(base, data.words);
  const s = base.size;

  let best;
  for (let mask = only ?? 0; mask < (only === undefined ? 8 : only + 1); mask++) {
    const m = base.m.map((row, r) => Int8Array.from(row, (v, c) => (reserved[r][c] ? v : v ^ (MASKS[mask](r, c) ? 1 : 0))));
    const bits = formatBits(mask);
    const at = (i) => (bits >> i) & 1;
    // Two copies, so a damaged corner still leaves the mask readable. Bit 0 is the least
    // significant, and the two copies walk the corner in opposite directions.
    for (let i = 0; i < 6; i++) m[i][8] = at(i);
    m[7][8] = at(6);
    m[8][8] = at(7);
    m[8][7] = at(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = at(i);
    for (let i = 0; i < 7; i++) m[8][s - 1 - i] = at(i);
    for (let i = 7; i < 15; i++) m[s - 15 + i][8] = at(i);
    m[s - 8][8] = 1; // the dark module is not part of the format bits and is always set
    const score = penalty(m, s);
    if (!best || score < best.score) best = { score, m, mask };
  }
  return { size: s, version: data.version, mask: best.mask, m: best.m };
}

const qrMatrix = (text) => matrixWithMask(text, undefined);

/* ---------------- markdown ---------------- */
/**
 * A small Markdown renderer. A model writes Markdown whether or not the front end reads it, so a
 * page that shows the source is showing you asterisks and pipes where a list and a table were
 * meant. This covers what actually turns up in a reply: fenced code, headings, lists, quotes,
 * rules, and inline code, emphasis and links.
 *
 * Everything is escaped before anything is added, and the only attribute this ever writes is an
 * href that had to survive a scheme check first. A reply is not trusted input — it is whatever the
 * model was persuaded to write, and a tool result inside it is whatever a web page said.
 */
const MD_ESCAPES = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" };
const mdEsc = (t) => String(t ?? "").replace(/[<>&"']/g, (c) => MD_ESCAPES[c]);

/** http and https and nothing else: javascript: and data: are both a way to run code from a link. */
function safeHref(url) {
  const trimmed = String(url ?? "").trim();
  // The placeholder marker means a code span was taken out of this URL and will be put back after
  // the attribute is written — so the address would not be the one the link says. Leave it as text.
  if (trimmed.includes("\u0000")) return "";
  return /^https?:\/\//i.test(trimmed) ? mdEsc(trimmed) : "";
}

/**
 * A path the session wrote, turned into something you can look at.
 *
 * A reply that says "I put the chart in ./out/chart.png" is a reply you cannot see the chart in.
 * Anything that is not an absolute URL is treated as a path relative to the session's directory
 * and handed to /file, which decides whether it exists, whether it is inside, and whether it is a
 * kind of thing worth showing — none of which the page is in a position to know.
 */
function fileHref(url) {
  const trimmed = String(url ?? "").trim();
  if (!trimmed || trimmed.includes("\u0000")) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return ""; // a scheme of its own
  // No token in it. These are same-origin requests from this page, so the cookie authenticates
  // them — and a page the model wrote, opened from one of these links, can read its own address.
  // A credential that outlives the process has no business being in a URL that document can see.
  return "/file?path=" + encodeURIComponent(trimmed.replace(/^\.\//, ""));
}

/**
 * A path written in prose, rather than as a link.
 *
 * "I put it in /home/you/Downloads/report.html" is how a model actually says where something is,
 * and until now that was a sentence with a dead end in it. Only paths that name a file this can
 * show — the extension list, the same one the server enforces — so ordinary words with slashes in
 * them are left alone.
 */
/** The whole of a code span, and nothing but a path. */
const ONLY_A_PATH = /^(?:~\/|\.{0,2}\/)[^\s<>"']+\.(?:png|jpe?g|gif|webp|avif|svg|pdf|html?|txt|md|csv|json)$/i;

const PREVIEWABLE = /(^|[^\w\/~.-])((?:~\/|\.{0,2}\/)[^\s)<>"'，。；：]+\.(?:png|jpe?g|gif|webp|avif|svg|pdf|html?|txt|md|csv|json))(?=$|[^\w-])/gi;

function linkPathsInProse(html) {
  // Only the text between tags: run over the whole string and it would find the paths inside the
  // href attributes it has just written. And not inside a link, where it would nest one in another.
  let depth = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part, i) => {
      if (i % 2) {
        if (/^<a\b/i.test(part)) depth++;
        else if (/^<\/a>/i.test(part)) depth = Math.max(0, depth - 1);
        return part;
      }
      if (depth) return part;
      return part.replace(PREVIEWABLE, (whole, before, p) => {
        const href = fileHref(p);
        if (!href) return whole;
        const image = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(p);
        return (
          before +
          (image
            ? '<img src="' + href + '" alt="' + mdEsc(p) + '" loading="lazy">'
            : '<a href="' + href + '" target="_blank" rel="noreferrer noopener" class="file">' + mdEsc(p) + "</a>")
        );
      });
    })
    .join("");
}

// This page is a template literal inside a Node file, so a backtick cannot be written here at all
// — and Markdown is made of them. Building the character keeps those two facts from colliding.
const BT = String.fromCharCode(96);
const RE_CODESPAN = new RegExp(BT + "([^" + BT + "]+)" + BT, "g");
const FENCE = "^\\s*" + BT + BT + BT;

function inlineMd(text) {
  // Code spans first and put back last, so nothing inside them is read as markup.
  const spans = [];
  let out = String(text).replace(RE_CODESPAN, (_, code) => {
    spans.push(code);
    return "\u0000" + (spans.length - 1) + "\u0000";
  });
  out = mdEsc(out)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // Images first, or the link rule would eat them: ![alt](src) is a link with a bang in front.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, src) => {
      const where = safeHref(src) || fileHref(src);
      return where ? '<img src="' + where + '" alt="' + mdEsc(alt) + '" loading="lazy">' : whole;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
      const safe = safeHref(href);
      if (safe) return '<a href="' + safe + '" target="_blank" rel="noreferrer noopener">' + label + "</a>";
      const local = fileHref(href);
      return local ? '<a href="' + local + '" target="_blank" rel="noreferrer noopener" class="file">' + label + "</a>" : whole;
    });
  out = linkPathsInProse(out);
  /**
   * And a code span that is *only* a path is a path.
   *
   * Backticks around a filename is how a model writes one — I put it in, then the path in them —
   * and treating that as a literal string to be left alone was a rule that fired on exactly the
   * case it was meant to serve. A span with anything else in it is still a literal string, and a
   * path inside a fenced block is still code.
   */
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const raw = String(spans[Number(i)] ?? "").trim();
    const href = ONLY_A_PATH.test(raw) ? fileHref(raw) : "";
    if (!href) return "<code>" + mdEsc(spans[Number(i)]) + "</code>";
    if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(raw)) return '<img src="' + href + '" alt="' + mdEsc(raw) + '" loading="lazy">';
    return '<a href="' + href + '" target="_blank" rel="noreferrer noopener" class="file"><code>' + mdEsc(raw) + "</code></a>";
  });
}

/** One table row into its cells: the outer pipes are optional, the inner ones are the separator. */
function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function markdownToHtml(src) {
  const lines = String(src ?? "").split("\n");
  const html = [];
  let list = "";
  let para = [];
  const flushPara = () => { if (para.length) { html.push("<p>" + inlineMd(para.join("\n")) + "</p>"); para = []; } };
  const flushList = () => { if (list) { html.push("</" + list + ">"); list = ""; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = new RegExp(FENCE + "(\\w*)").exec(line);
    if (fence) {
      flushPara(); flushList();
      const body = [];
      for (i++; i < lines.length && !new RegExp(FENCE).test(lines[i]); i++) body.push(lines[i]);
      html.push('<pre class="code"' + (fence[1] ? ' data-lang="' + mdEsc(fence[1]) + '"' : "") + "><code>" + mdEsc(body.join("\n")) + "</code></pre>");
      continue;
    }
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    if (head) { flushPara(); flushList(); html.push("<h" + (head[1].length + 2) + ">" + inlineMd(head[2]) + "</h" + (head[1].length + 2) + ">"); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) { flushPara(); flushList(); html.push("<hr>"); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flushPara(); flushList(); html.push("<blockquote>" + inlineMd(quote[1]) + "</blockquote>"); continue; }
    // A table is the one block that needs the line after it to be recognised at all: the divider is
    // what separates a header row from a paragraph that happens to contain pipes.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flushPara(); flushList();
      const aligns = cells(lines[i + 1]).map((c) => (/^:.*:$/.test(c) ? "center" : c.startsWith(":") ? "left" : c.endsWith(":") ? "right" : ""));
      const head = cells(line);
      const body = [];
      for (i += 2; i < lines.length && lines[i].includes("|"); i++) body.push(cells(lines[i]));
      const cell = (tag, text, n) => "<" + tag + (aligns[n] ? ' style="text-align:' + aligns[n] + '"' : "") + ">" + inlineMd(text) + "</" + tag + ">";
      html.push(
        "<table><thead><tr>" + head.map((c, n) => cell("th", c, n)).join("") + "</tr></thead><tbody>" +
          body.map((r) => "<tr>" + r.map((c, n) => cell("td", c, n)).join("") + "</tr>").join("") +
          "</tbody></table>",
      );
      i--;
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const want = item[1] ? "ul" : "ol";
      if (list !== want) { flushList(); html.push("<" + want + ">"); list = want; }
      html.push("<li>" + inlineMd(item[3]) + "</li>");
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    para.push(line);
  }
  flushPara(); flushList();
  return html.join("");
}

/* ---------------- feed ---------------- */

/**
 * Copy, which on a phone is the difference between having a command and retyping it. The clipboard
 * API needs a secure context, and http://192.168.x.x is not one — so there is a fallback, and it is
 * the only reason this is more than one line.
 */
function copyBtn(getText) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "copy";
  b.title = "Copy this message";
  b.onclick = async (e) => {
    e.stopPropagation();
    const text = getText();
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("copy refused");
      }
      b.textContent = "copied";
    } catch (_) {
      b.textContent = "copy failed";
    }
    setTimeout(() => { b.textContent = "copy"; }, 1400);
  };
  return b;
}

/** Replace a row's plain text with its rendered Markdown, keeping the source for the copy button. */
function mdInto(el, text) {
  el.raw = text;
  el.className = "md";
  el.innerHTML = markdownToHtml(plain(text));
  // A page written into the conversation is a page you cannot look at. This opens it — sandboxed,
  // served back by this process, never rendered inside this document.
  for (const pre of el.querySelectorAll?.('pre.code[data-lang="html"]') ?? []) {
    // Read before the button goes in, or the word "preview" ends up inside the page it opens.
    const source = pre.textContent;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preview";
    b.textContent = "preview";
    b.onclick = async () => {
      const r = await api("/preview", { html: source });
      if (!r.success) return row("err", "error", r.error || "could not open a preview");
      window.open("/preview/" + r.id, "_blank", "noopener");
    };
    pre.append(b);
  }
}

/** The clock, on hover, the way pie does it: a long session has no other answer to "when". */
function stamp(el) {
  el.title = new Date().toLocaleTimeString();
  return el;
}

function row(cls, role, text) {
  const el = document.createElement("div");
  el.className = "row " + cls;
  const b = document.createElement("span");
  if (role) {
    const r = document.createElement("div");
    r.className = "role";
    const name = document.createElement("span");
    name.textContent = role;
    r.append(name);
    // Only where there is something worth copying: a status line is not.
    if (cls === "" || cls === "tool" || cls === "user") r.append(copyBtn(() => b.raw ?? b.textContent ?? ""));
    el.append(r);
  }
  if (text) b.textContent = plain(text);
  el.append(b);
  clearEmpty();
  endToolGroup();
  feed.append(stamp(el));
  scroll();
  return b;
}
/**
 * A tool call and what it returned are one block, and it is closed.
 *
 * They used to be two rows, both open: the arguments as a block of JSON, then however many
 * thousand characters came back. One shell command could push the conversation off the screen,
 * and on a phone it did. The summary is the line that matters — which tool, on what — and the rest
 * is one tap away.
 */
const openCalls = [];

function argSummary(args) {
  if (typeof args === "string") return args;
  const o = args ?? {};
  // The first string that looks like the subject: a command, a path, a pattern.
  for (const k of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "id"]) {
    if (typeof o[k] === "string" && o[k]) return o[k];
  }
  const first = Object.values(o).find((v) => typeof v === "string" && v);
  return first ?? Object.keys(o).join(", ");
}

/**
 * A run of tool calls is one line, not one line each.
 *
 * A turn that reads four files and runs two commands used to spend six rows of the conversation
 * saying so, and the conversation is the thing you are reading. Consecutive calls collect into one
 * block: while they are running its summary is the one that is running, so you can still see what
 * it is doing; when the turn ends it becomes "6 tools · read, bash" and closes. Everything is still
 * there, one click in.
 */
let toolGroup;

/**
 * One block for a stretch of work.
 *
 * Thinking and tool calls arrive interleaved — think, read, think, run, think — and each one used
 * to take a row of the conversation. A long agentic turn was thirty rows of plumbing around three
 * sentences of answer. They collect here instead: while it is happening the line says what is
 * happening, and when the answer arrives it closes into "6 steps · thinking, read, bash".
 */
function toolGroupFor() {
  if (toolGroup && toolGroup.parentElement === feed) return toolGroup;
  const d = document.createElement("details");
  d.className = "row work";
  d.open = allOpen;
  const s = document.createElement("summary");
  const what = document.createElement("span");
  what.className = "what";
  s.append(what);
  d.append(s);
  d.what = what;
  d.names = [];
  clearEmpty();
  feed.append(stamp(d));
  toolGroup = d;
  return d;
}

/** While a turn runs, the line says what is happening; afterwards, what happened. */
function describeGroup(d, live) {
  if (!d) return;
  const n = d.names.length;
  if (live) {
    d.what.textContent = live;
    return;
  }
  const unique = [...new Set(d.names)];
  d.what.textContent = n + (n === 1 ? " step · " : " steps · ") + unique.slice(0, 4).join(", ") + (unique.length > 4 ? "…" : "");
}

/** Anything that is not part of the work ends the stretch: an answer, a message, a notice. */
function endToolGroup() {
  if (toolGroup) describeGroup(toolGroup, "");
  toolGroup = undefined;
}

/**
 * Every stretch of work at once, because that is how a person reads them: either the conversation
 * on its own, or the whole of what went into it. The choice is kept in this browser.
 */
let allOpen = remembered("work", "closed") === "open";

function setAllWork(open) {
  allOpen = open;
  remember("work", open ? "open" : "closed");
  for (const d of feed.querySelectorAll?.("details.work") ?? []) d.open = open;
  const b = $("expand");
  b.textContent = open ? "▾ steps" : "▸ steps";
  b.title = open ? "Collapse every step" : "Expand every step";
}

/** One image content block, as an image. The data is base64 in the message; nothing is fetched. */
function imageOf(c) {
  const img = document.createElement("img");
  img.className = "shot";
  img.loading = "lazy";
  img.alt = "image";
  // The type comes out of a tool result, which is whatever some web page said. An <img> would not
  // parse anything else anyway; pinning it keeps the URL from carrying a second thing entirely.
  const type = /^image\/(png|jpeg|gif|webp|avif)$/.test(c.mimeType || "") ? c.mimeType : "image/png";
  img.src = "data:" + type + ";base64," + String(c.data).replace(/[^A-Za-z0-9+/=]/g, "");
  return img;
}

function toolRow(name, args, id, orphan) {
  const el = document.createElement("details");
  el.className = "row tool";
  const sum = document.createElement("summary");
  const what = document.createElement("span");
  what.className = "what";
  const state = document.createElement("span");
  state.className = "state";
  el.state = state;
  // Copying a tool call means copying what it ran and what came back, which is the pair of things
  // you paste into a bug report.
  sum.append(what, state, copyBtn(() => [...el.querySelectorAll("pre")].map((x) => x.textContent).join("\n\n")));
  el.append(sum);
  const pre = document.createElement("pre");
  el.append(pre);
  el.what = what;
  el.setArgs = (a) => {
    what.textContent = plain(name + "  " + argSummary(a)).slice(0, 200);
    pre.textContent = plain(typeof a === "string" ? a : JSON.stringify(a ?? {}, null, 1));
  };
  el.setArgs(args);
  state.textContent = "running";
  const group = toolGroupFor();
  group.names.push(name);
  group.append(el);
  describeGroup(group, plain(name + "  " + argSummary(args)).slice(0, 120));
  // A block made to hold an orphan result is not waiting for one. Registering it here is what used
  // to break the pairing for everything after it.
  if (!orphan) {
    openCalls.push({ id, name, el });
    if (openCalls.length > 100) openCalls.shift();
  }
  scroll();
  return el;
}

/**
 * Which call a result belongs to.
 *
 * By id when there is one, because two calls to the same tool can finish in either order and a
 * queue keyed on the name would hand each one the other's output. By name only as a fallback, and
 * a result that matches nothing gets a block of its own rather than corrupting the list — the
 * earlier version pushed that orphan onto the queue it had just failed to find, and every later
 * result for that tool was off by one for the life of the tab.
 */
function claimCall(id, name) {
  let at = id ? openCalls.findIndex((c) => c.id === id) : -1;
  if (at === -1) at = openCalls.findIndex((c) => c.name === name);
  if (at === -1) return undefined;
  return openCalls.splice(at, 1)[0].el;
}

/** Nothing is coming for these now. They stop claiming to be running, and stop being remembered. */
function endOpenCalls() {
  for (const c of openCalls) if (c.el.state.textContent === "running") c.el.state.textContent = "stopped";
  openCalls.length = 0;
  endToolGroup();
}

function toolResult(name, text, isError, id) {
  const el = claimCall(id, name) ?? toolRow(name || "tool", "", undefined, true);
  el.state.textContent = isError ? "error" : "";
  if (isError) el.classList.add("err");
  const pre = document.createElement("pre");
  pre.textContent = plain(text.length > 8000 ? text.slice(0, 8000) + "\n… (" + text.length + " chars)" : text);
  el.append(pre);
  scroll();
  return el;
}
/**
 * Thinking is closed, and clicking opens it — which it always was. What it was missing is a reason
 * to click: a line saying only "thinking" hides an unknown amount of unknown text. The summary
 * carries the first of it and how much there is, so the choice is an informed one.
 */
function thinkRow() {
  const d = document.createElement("details");
  d.className = "row think";
  const s = document.createElement("summary");
  const label = document.createElement("span");
  label.textContent = "thinking";
  const peek = document.createElement("span");
  peek.className = "peek";
  s.append(label, peek);
  d.append(s);
  const p = document.createElement("pre");
  d.append(p);
  // Kept up to date as the deltas arrive, and it is the closed state that shows it.
  p.onGrow = () => {
    const text = p.textContent.replace(/\s+/g, " ").trim();
    peek.textContent = text ? " · " + (text.length > 90 ? text.slice(0, 90) + "…" : text) : "";
    describeGroup(d.parentElement?.classList?.contains("work") ? d.parentElement : undefined, "thinking · " + text.slice(0, 90));
  };
  clearEmpty();
  // Thinking is part of the work, not a separate row of the conversation.
  const group = toolGroupFor();
  group.names.push("thinking");
  group.append(d);
  scroll();
  return p;
}

/* ---------------- streaming assembly: deltas are keyed by contentIndex ---------------- */
let blocks = new Map();
const blockAt = (key, make) => { if (!blocks.has(key)) blocks.set(key, make()); return blocks.get(key); };
/** Append a delta, keeping the raw text: an escape sequence can be split across two of them. */
function grow(el, delta) {
  el.raw = (el.raw || "") + delta;
  el.textContent = plain(el.raw);
  el.onGrow?.();
}

function handle(ev) {
  switch (ev.type) {
    case "agent_start": busy = true; setStatus(); break;
    case "agent_end": busy = false; endOpenCalls(); setStatus(); refresh(); break;
    case "message_start": blocks = new Map(); break;
    case "message_update": {
      const d = ev.assistantMessageEvent || {};
      if (d.type === "text_delta") grow(blockAt("t" + d.contentIndex, () => row("", "assistant", "")), d.delta);
      else if (d.type === "thinking_delta") grow(blockAt("k" + d.contentIndex, thinkRow), d.delta);
      else if (d.type === "toolcall_start") blockAt("c" + d.contentIndex, () => toolRow(d.toolName, "", d.toolCallId ?? d.id));
      else if (d.type === "toolcall_end" && d.toolCall) blocks.get("c" + d.contentIndex)?.setArgs(d.toolCall.arguments);
      break;
    }
    case "message_end":
      // Markdown is rendered once the message is whole. Half a fenced block is not a fenced block,
      // and re-parsing on every delta would rewrite the DOM under a finger that is scrolling it.
      for (const [key, el] of blocks) if (key[0] === "t" && el.raw) mdInto(el, el.raw);
      renderMessage(ev.message, true);
      break;
    case "queue_update": state.queue = { steering: ev.steering || [], followUp: ev.followUp || [] }; setStatus(); break;
    case "extension_ui_request": onAsk(ev); break;
    case "entry_appended": if (ev.entry?.type === "custom") refresh(); break;
    case "compaction_end":
      // A compaction you asked for is reported by the call that asked for it. This line is for the
      // one pi does on its own when the context fills up — and it used to say "context compacted"
      // for that one whether it had worked, been aborted, or failed, and say it a second time over
      // the top of a manual one that had just reported the opposite.
      if (ev.reason !== "manual") row("notice", "", compactionLine(ev.result, ev.aborted, ev.errorMessage, true));
      refresh();
      break;
    case "pi_exit": {
      busy = false;
      statusEl.textContent = "pi exited";
      // The reason belongs on the page. Anything else means reading a terminal you may have opened
      // this window precisely to avoid.
      const why = (ev.stderr || "").trim();
      const el = row("err", "pi exited" + (ev.signal ? " (" + ev.signal + ")" : ev.code == null ? "" : " (code " + ev.code + ")"), "");
      if (why) {
        const pre = document.createElement("pre");
        pre.textContent = plain(why.length > 4000 ? why.slice(-4000) : why);
        el.parentElement.append(pre);
      } else {
        el.textContent = "it stopped without saying why; the terminal that started this has its output";
      }
      scroll();
      break;
    }
  }
}

/**
 * What you typed, drawn here the moment you sent it — and sent back by pi when it lands, because a
 * front end that joined later has to see it too. Both are right; showing both is not. Each message
 * drawn locally is remembered until its echo arrives and cancels it.
 */
const drewLocally = [];
function alreadyDrawn(text) {
  const at = drewLocally.indexOf(text);
  if (at === -1) return false;
  drewLocally.splice(at, 1);
  return true;
}

function renderMessage(m, live) {
  if (!m) return;
  if (m.role === "user") {
    const text = typeof m.content === "string" ? m.content : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const imgs = typeof m.content === "string" ? 0 : (m.content || []).filter((c) => c.type === "image").length;
    const shown = text + (imgs ? "\n[" + imgs + " image(s)]" : "");
    if (live && alreadyDrawn(shown)) return;
    if (text || imgs) {
      const body = row("user", "you", text);
      // What you sent, shown back. A line saying "[2 image(s)]" is a receipt, not a message.
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === "image" && c.data) body.parentElement.append(imageOf(c));
      }
    }
  } else if (m.role === "toolResult") {
    const parts = Array.isArray(m.content) ? m.content : [m.content];
    const text = parts.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("");
    const el = toolResult(m.toolName || "tool", text, m.isError, m.toolCallId ?? m.id);
    // A tool that answers with a picture was answering with nothing at all until now: the image
    // blocks were filtered out and only the text of the result was kept.
    for (const c of parts) if (c && c.type === "image" && c.data) el.append(imageOf(c));
  } else if (m.role === "custom") {
    // A promotion pi-loops pushed into the chat ("[Trigger ...] ..."), or another extension message.
    // display:false means the model sees it and the person is not meant to.
    if (m.display === false) return;
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    const capped = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
    /**
     * Where it goes depends on when it arrived. An extension that logs what a tool just did — "wrote
     * 166 lines to x.html" — speaks in the middle of a stretch of work, and belongs inside it: as a
     * row of its own it both takes a line and cuts the stretch in two, so six steps and thirty-five
     * become three rows instead of one. A message that arrives between turns is a message.
     */
    if (toolGroup) {
      const el = document.createElement("div");
      el.className = "note";
      const name = document.createElement("div");
      name.className = "role";
      name.textContent = m.customType || "note";
      const body = document.createElement("span");
      body.textContent = plain(capped);
      el.append(name, body);
      toolGroup.append(el);
      toolGroup.names.push(m.customType || "note");
      describeGroup(toolGroup, plain(capped).slice(0, 120));
      scroll();
      return;
    }
    row("tool", m.customType || "custom", capped);
  } else if (m.role === "assistant" && !live) {
    for (const c of m.content || []) {
      if (c.type === "text" && c.text) mdInto(row("", "assistant", ""), c.text);
      else if (c.type === "thinking" && c.thinking) {
        const p = thinkRow();
        p.textContent = plain(c.thinking);
        p.onGrow();
      }
      else if (c.type === "toolCall") toolRow(c.name, c.arguments, c.id).state.textContent = "";
    }
  }
}

function setStatus() {
  const q = (state.queue?.steering?.length || 0) + (state.queue?.followUp?.length || 0);
  const qe = $("queue");
  qe.hidden = !q;
  qe.textContent = "queued " + q + " ✕";
  qe.onclick = () => api("/queue/clear", {}).then(refresh);
  statusEl.textContent = busy ? "working…" : "ready";
}

/* ---------------- the automation panel ---------------- */
// Quotes included: the sidebar interpolates a job id into an attribute, and jobs.json is a file on
// disk, not something this page gets to assume is well formed.
const ESCAPES = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" };
function esc(s) { return String(s ?? "").replace(/[<>&"']/g, (c) => ESCAPES[c]); }
// A count out of a JSON file is a number only if the file says so: a runCount holding an img tag
// with an onerror handler is a perfectly valid file, and interpolating it raw reaches the DOM.
function num(n) { return Number.isFinite(Number(n)) ? Number(n) : 0; }
// And .slice() is a string method: a job whose lastError is a number, or which has no id at all,
// is a file this page has to draw, not a reason for the whole panel to stop redrawing.
function str(v) { return v === undefined || v === null ? "" : String(v); }

function renderSidebar(s) {
  const a = s.automation || {};
  const box = $("auto");
  if (!a.installed) { box.innerHTML = '<div class="notice">pi-loops not found in ' + esc(a.dir || "") + "</div>"; }
  else {
    let html = "";
    html += '<div class="notice">inbox <b>' + num(a.inboxNew) + "</b> new · " + num(a.jobs.length) + " job(s) · " + num(a.rules.length) + " rule(s)</div>";
    for (const j of a.jobs) {
      html += '<div class="card' + (j.enabled ? "" : " off") + '"><div class="t"><b>' + esc(j.name || str(j.id).slice(0, 14)) + "</b>" +
        '<span class="m">' + esc(j.schedule) + (j.stateful ? " · loop" : "") + "</span>" +
        '<button data-run="' + esc(j.id) + '">run</button></div>' +
        '<div class="m">' + esc(str(j.prompt).slice(0, 90)) + "</div>" +
        '<div class="m">' + (j.running ? "running · " : "") + "runs " + num(j.runCount) + (j.next ? " · next " + esc(new Date(j.next).toLocaleTimeString()) : "") + "</div>" +
        // A job belonging to a hostname this machine no longer has: it is listed, because it exists,
        // and it says why nothing is happening rather than leaving you to find out from the silence.
        (j.otherHost ? '<div class="m" style="color:#c93">other host: ' + esc(str(j.otherHost)) + " — run <b>/cron set " + esc(str(j.ref)) + " --host here</b></div>" : "") +
        (j.lastError ? '<div class="m" style="color:#c66">' + esc(str(j.lastError).slice(0, 120)) + "</div>" : "") + "</div>";
    }
    for (const r of a.rules) {
      html += '<div class="card' + (r.enabled ? "" : " off") + '"><div class="t"><b>rule</b><span class="m">' + (r.fireOnce ? "once" : "repeat") + "</span></div>" +
        '<div class="m">when ' + esc(str(r.condition).slice(0, 80)) + "</div><div class=\"m\">→ " + esc(str(r.action).slice(0, 80)) + "</div></div>";
    }
    if (!a.jobs.length && !a.rules.length) html += '<div class="notice">no jobs or rules in this project</div>';
    // The store is machine-wide and this list is not: without this line, a job made in another
    // directory is indistinguishable from a job that is gone.
    if (a.elsewhere) html += '<div class="notice">+ ' + num(a.elsewhere) + " in other projects — /cron all</div>";
    if (s.lastPoll) html += '<div class="notice">last check: ' + esc(s.lastPoll.state || "") + " · " + esc(new Date(s.lastPoll.at).toLocaleTimeString()) + "</div>";
    box.innerHTML = html;
    box.querySelectorAll("[data-run]").forEach((b) => (b.onclick = () => api("/trigger/immediate", { id: b.dataset.run })));
  }
  renderRuntime(s.runtime);
  $("goal").textContent = s.goal ? (s.goal.condition || "") + " — " + (s.goal.status || "") + " (" + (s.goal.iterations ?? 0) + ")" : "none";
  $("meta").textContent = [s.sessionName, s.messageCount + " messages", s.model?.label].filter(Boolean).join(" · ");
}

// What only the pi process knows: which servers connected, what they exposed, who owns the clock.
// pi-loops writes it as a pi_loops_snapshot entry; nothing here is guessed from config files.
/**
 * A count on its own answers "how many" and nothing else — and the question a person actually has
 * is which ones. Any number rendered through this can be clicked for the list behind it.
 */
const detailLists = new Map();
let detailSeq = 0;
function countOf(n, label, names) {
  const list = (names || []).filter(Boolean).map(String);
  if (!list.length) return num(n) + " " + esc(label);
  const key = "d" + detailSeq++;
  detailLists.set(key, { title: label, items: list });
  return '<button class="count" data-detail="' + key + '">' + num(n) + " " + esc(label) + "</button>";
}

/** A row of figures rather than a sentence: the number is what is being read. */
function metrics(items) {
  const cells = items.map(([label, n, names]) => {
    const list = (names || []).filter(Boolean).map(String);
    const inner = "<b>" + num(n) + "</b><span>" + esc(label) + "</span>";
    if (!list.length) return "<div>" + inner + "</div>";
    const key = "d" + detailSeq++;
    detailLists.set(key, { title: label, items: list });
    return '<button class="metric" data-detail="' + key + '">' + inner + "</button>";
  });
  return '<div class="metrics">' + cells.join("") + "</div>";
}

function showDetail(key) {
  const d = detailLists.get(key);
  if (!d) return;
  $("detailTitle").textContent = d.title + " (" + d.items.length + ")";
  const body = $("detailBody");
  body.innerHTML = "";
  for (const item of d.items) {
    const row = document.createElement("div");
    row.className = "detail-row";
    row.textContent = item;
    body.append(row);
  }
  $("detail").showModal();
}

/**
 * Thirty-three lines of provider-slash-id is a list, not a picker. Grouped by provider, named the
 * a person would name them, and annotated with the two things that decide the choice: how much
 * context there is and whether it can look at a picture.
 */
function drawModels(catalog, current) {
  const sel = $("model");
  const key = catalog.length + "|" + (current ?? "");
  if (sel.dataset.n === key) return; // unchanged; do not disturb a menu somebody has open
  sel.dataset.n = key;
  sel.innerHTML = "";
  const byProvider = new Map();
  for (const m of catalog) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  const label = (m) => {
    const bits = [m.name || m.id];
    if (m.contextWindow) bits.push(Math.round(m.contextWindow / 1000) + "k");
    if (m.images) bits.push("images");
    return bits.join(" · ");
  };

  // What you have chosen before, most recent first — this browser only, and only ones still
  // offered. pi already filters the catalogue to providers you have configured, so everything here
  // is usable; this is about the difference between usable and used.
  const recent = remembered("models", "").split(",").filter(Boolean);
  const spec = (m) => m.provider + "/" + m.id;
  const known = new Map(catalog.map((m) => [spec(m), m]));
  const mine = recent.map((k) => known.get(k)).filter(Boolean).slice(0, 5);
  if (mine.length) {
    const g = document.createElement("optgroup");
    g.label = "recent";
    for (const m of mine) g.append(new Option(label(m), spec(m)));
    sel.append(g);
  }

  // Then the provider whose model is in use, then the rest as pi listed them.
  const here = current ? String(current).split("/")[0] : undefined;
  const order = [...byProvider.keys()].sort((a, b) => (a === here ? -1 : b === here ? 1 : 0));
  for (const provider of order) {
    const g = document.createElement("optgroup");
    g.label = provider;
    for (const m of byProvider.get(provider)) g.append(new Option(label(m), spec(m)));
    sel.append(g);
  }
}

/** Only the levels this model has. A level pi maps to null is a level that does nothing. */
function drawThinking(levels, current) {
  const sel = $("thinking");
  const list = (levels && levels.length ? levels : ["off", "minimal", "low", "medium", "high", "xhigh"]).map(String);
  if (sel.dataset.levels !== list.join(",")) {
    sel.dataset.levels = list.join(",");
    sel.innerHTML = "";
    for (const l of list) sel.append(new Option(l, l));
  }
  if (current) sel.value = current;
}

function renderRuntime(rt) {
  const box = $("runtime");
  // The panel is redrawn every few seconds; without this the lists behind it accumulate for as long
  // as the tab is open.
  detailLists.clear();
  if (!rt) { box.textContent = "no snapshot yet — /cron snapshot writes one"; return; }
  const dot = (state) => '<span class="dot ' + (state === "connected" ? "up" : state === "disabled" || state === "idle" ? "idle" : "down") + '"></span>';
  let html = "";
  const sc = rt.scheduler || {};
  html += "<div>" + dot(sc.running ? (sc.leader ? "connected" : "idle") : "down") +
    (sc.running ? (sc.leader ? "owns the clock" : "standby (another pi owns the clock)") : "scheduler not running") +
    (sc.runs || sc.checks ? " · " + num(sc.runs) + " run(s), " + num(sc.checks) + " check(s)" : "") + "</div>";
  for (const m of rt.mcp || []) {
    html += "<div>" + dot(m.state) + esc(m.name) + " <span class=\"m\">" + esc(m.state) + " · " + countOf((m.tools || []).length, "tools", m.tools) +
      (m.injects ? " · injects" : "") + (m.queued ? " · " + num(m.queued) + " queued" : "") + "</span></div>" +
      (m.lastError ? '<div class="m" style="color:#c66">  ' + esc(String(m.lastError).slice(0, 120)) + "</div>" : "");
  }
  if (rt.mcpConfigError) html += '<div class="m" style="color:#c66">mcp.toml: ' + esc(rt.mcpConfigError) + "</div>";
  const h = rt.hooks || {};
  html += metrics([
    ["hooks", h.count, h.events],
    ["tools", (rt.tools || []).length, rt.tools],
    ["mcp", (rt.mcp || []).length, (rt.mcp || []).map((m) => m.name)],
  ]);
  if (rt.poll) html += '<div class="m">last check ' + esc(new Date(rt.poll.at).toLocaleTimeString()) + " · " + esc(rt.poll.outcome || "") + "</div>";
  html += '<div class="m">snapshot ' + esc(new Date(rt.at).toLocaleTimeString()) + " · v" + esc(rt.version || "?") + "</div>";
  box.innerHTML = html;
  // The lists are rebuilt with the panel, so the handler is attached to the panel, not the buttons.
  box.onclick = (e) => {
    // The tiles have a <b> and a <span> filling them, so the click target is usually one of those
    // and not the button carrying the key. Ask upwards.
    const key = e.target?.closest?.("[data-detail]")?.dataset?.detail ?? e.target?.dataset?.detail;
    if (key) showDetail(key);
  };
}

async function refresh() {
  state = await api("/state");
  checkStream?.(state);
  checkAge(state);
  cwd = state.cwd || "";
  $("cwd").textContent = cwd;
  $("cwd").title = cwd;
  $("sid").textContent = (state.sessionId || "").slice(0, 8);
  drawModels(state.modelCatalog || [], state.model?.label);
  if (state.model) $("model").value = state.model.label;
  drawThinking(state.thinkingLevels, state.thinkingLevel);
  // Whether this model can look at an image is something pi knows and the button was guessing at.
  const here = (state.modelCatalog || []).find((m) => state.model && m.provider + "/" + m.id === state.model.label);
  takesImages = here?.images !== false;
  $("attach").disabled = !takesImages;
  $("attach").title = takesImages ? "Attach images" : (state.model?.id || "this model") + " does not take images";
  busy = state.busy;
  setStatus();
  renderSidebar(state);
  api("/stats").then((st) => {
    if (!st || st.error) return;
    const pct = st.contextUsage?.percent;
    $("cost").textContent = "$" + (st.cost ?? 0).toFixed(3) + " · " + Math.round((st.tokens?.total ?? 0) / 1000) + "k" + (pct == null ? "" : " · ctx " + Math.round(pct) + "%");
  });
  for (const ask of state.pendingAsks || []) onAsk(ask);
}

/* ---------------- extension dialogs (pi-loops' approvals land here) ---------------- */
const asked = new Set();
function onAsk(req) {
  if (req.method === "notify") { row("notice", "", req.message); return; }
  if (!["confirm", "select", "input", "editor"].includes(req.method)) return;
  if (asked.has(req.id)) return;
  asked.add(req.id);
  const dlg = $("ask");
  $("askTitle").textContent = req.title || req.method;
  /**
   * A confirmation is only worth anything if you can see what you are confirming. The danger gate
   * sends a message with the command in it and a line saying why it was stopped; run together in
   * one paragraph they read as prose and get waved through. Split on the first blank line: what is
   * about to run goes in a box of its own, the reasoning goes under it.
   */
  const text = String(req.message || "");
  const cut = text.indexOf("\n\n");
  const subject = cut === -1 ? text : text.slice(0, cut);
  const why = cut === -1 ? "" : text.slice(cut + 2).trim();
  $("askBody").textContent = plain(subject);
  const reason = $("askWhy");
  reason.textContent = plain(why);
  reason.hidden = !why;
  const field = $("askField");
  field.innerHTML = "";
  let input = null;
  if (req.method === "select") { input = document.createElement("select"); for (const o of req.options || []) input.append(new Option(o, o)); field.append(input); }
  if (req.method === "input" || req.method === "editor") {
    input = document.createElement("textarea");
    input.style.width = "100%"; input.rows = req.method === "editor" ? 8 : 2; input.value = req.prefill || "";
    field.append(input);
  }
  $("askOk").textContent = req.method === "confirm" ? "approve" : "ok";
  // Esc closes a dialog with no returnValue, which is already "declined". What must not happen is a
  // stray Enter approving something: the cancel button holds the focus, so it is what Enter hits.
  setTimeout(() => dlg.querySelector("menu button")?.focus(), 0);
  dlg.returnValue = "";
  dlg.showModal();
  dlg.addEventListener("close", () => {
    const ok = dlg.returnValue === "ok";
    const answer = { id: req.id };
    if (!ok) answer.cancelled = true;
    else if (req.method === "confirm") answer.confirmed = true;
    else answer.value = input ? input.value : undefined;
    api("/ui-response", answer);
    row("notice", "", (req.title || req.method) + " → " + (ok ? "approved" : "declined"));
  }, { once: true });
}

/* ---------------- composer ---------------- */
let images = [];
function drawThumbs() {
  $("thumbs").innerHTML = "";
  images.forEach((im, i) => {
    // A visible ✕ rather than a tooltip: a finger cannot hover, so "click to remove" was a secret.
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.src = "data:" + im.mimeType + ";base64," + im.data;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.textContent = "✕";
    x.title = "Remove this image";
    x.setAttribute("aria-label", "Remove this image");
    x.onclick = () => { images.splice(i, 1); drawThumbs(); };
    wrap.append(img, x);
    $("thumbs").append(wrap);
  });
}
/** One message is one message. Ten images is already an unusual one, and a hundred is a mistake. */
const MAX_IMAGES = 10;

function addFile(file) {
  if (images.length >= MAX_IMAGES) return row("notice", "", "up to " + MAX_IMAGES + " images per message; the rest were left out");
  const r = new FileReader();
  r.onload = () => { images.push({ type: "image", data: String(r.result).split(",")[1], mimeType: file.type }); drawThumbs(); };
  r.readAsDataURL(file);
}
/**
 * On a phone, tapping a button beside the box first blurs the box — which dismisses the soft
 * keyboard, which relayouts the page — and the tap then lands wherever that button used to be.
 * "send" appears dead. Taking the focus steal away makes the click land where you aimed it. This
 * is not visible in a desktop browser, which has no soft keyboard to dismiss.
 */
for (const b of document.querySelectorAll("form#composer button")) {
  b.addEventListener("pointerdown", (e) => e.preventDefault());
}

$("attach").onclick = () => $("file").click();
$("file").onchange = (e) => { for (const f of e.target.files) addFile(f); e.target.value = ""; };
$("input").addEventListener("paste", (e) => {
  const pics = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
  if (!pics.length) return;
  if (!takesImages) return void row("notice", "", (state.model?.id || "this model") + " does not take images; the paste was dropped");
  for (const item of pics) addFile(item.getAsFile());
});

$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("input");
  const text = input.value.trim();
  if (!text && !images.length) return;
  input.value = ""; hidePop();
  if (text) { history.push(text); if (history.length > 200) history.shift(); }
  histIdx = -1;
  // Typed rather than clicked, which is how these get used once they are a habit. They run here
  // instead of being sent: anything attached stays in the tray, and a session about to be replaced
  // is not given a message it would carry nowhere.
  if (pageCommand(text)) return;
  const payload = { text, images, mode: busy ? "follow_up" : undefined };
  const shown = text + (images.length ? "\n[" + images.length + " image(s)]" : "");
  if (!busy) {
    row("user", "you", shown);
    drewLocally.push(shown);
    // A message pi never echoes back must not sit here waiting to swallow a later one.
    if (drewLocally.length > 20) drewLocally.shift();
  }
  images = []; drawThumbs();
  const r = await api("/prompt", payload);
  if (!r.success) row("err", "error", r.error || JSON.stringify(r));
};
$("stop").onclick = () => api("/abort", {});

/* ---------------- find, undo, save ---------------- */
$("find").onclick = () => {
  const bar = $("findbar");
  bar.hidden = !bar.hidden;
  if (!bar.hidden) $("findq").focus();
};
let findTimer;
$("findq").oninput = () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const q = $("findq").value.trim();
    if (q.length < 2) { $("findn").textContent = ""; return; }
    const r = await api("/find", { q });
    const hits = r.hits || [];
    $("findn").textContent = hits.length + " hit(s)";
    // Results go into the feed rather than a separate pane: it is where you were already reading.
    row("notice", "", "find: " + q);
    for (const h of hits.slice(0, 20)) row("hit", h.role + " · " + new Date(h.when).toLocaleString(), "…" + h.excerpt + "…");
  }, 250);
};
$("undo").onclick = async () => {
  const r = await api("/undo", {});
  if (!r.success) return row("err", "error", r.error || "cannot undo");
  if (r.data?.cancelled) return row("notice", "", "undo was cancelled by an extension");
  // pi hands back the forked message; put it where it came from.
  $("input").value = r.data?.text ?? "";
  // Everything on the screen goes, so nothing may still be holding a node that used to be on it.
  feed.innerHTML = "";
  emptyEl = undefined;
  toolGroup = undefined;
  openCalls.length = 0;
  blocks = new Map();
  const hist = await api("/history");
  for (const m of hist.messages || []) renderMessage(m, false);
  // Only claim the message is back if it is. pi hands one back when there was one to hand back.
  row("notice", "", $("input").value ? "forked from your last message — it is back in the composer" : "forked from your last message");
  refresh();
};
$("save").onclick = async () => {
  const r = await api("/export", {});
  row("notice", "", r.success ? "saved " + r.data.path : "export failed: " + (r.error || ""));
};
// pi-loops' /share renders and redacts, then asks — the dialog arrives here like any other.
$("share").onclick = () => api("/share", {});

/* ---------------- keeping the context in hand ---------------- */

/**
 * Compact, and say what it did.
 *
 * "context compacted" on its own is the reason nobody trusted this button: compaction costs a model
 * call and throws most of the conversation away, and a line that reports neither is asking to be
 * taken on faith. pi hands back what it was and what it became, so that is what goes on the screen.
 */
function compactionLine(result, aborted, errorMessage, automatic) {
  if (aborted) return "compaction aborted";
  if (!result) return "compaction failed: " + (errorMessage || "no reason given");
  // Thousands where there are thousands. A summary that came out at 312 tokens was reported as
  // "0k", which reads as "gone" rather than "small" — and the numbers either side of that arrow are
  // the whole reason the line exists.
  const k = (n) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
  const before = result.tokensBefore, after = result.estimatedTokensAfter, cost = result.usage?.cost?.total;
  return (automatic ? "context compacted on its own" : "context compacted") +
    (before && after ? " · " + k(before) + " → " + k(after) : "") +
    (cost ? " · $" + cost.toFixed(3) : "");
}

async function compactNow(instructions) {
  const said = row("notice", "", instructions ? "compacting — " + instructions : "compacting…");
  const r = await api("/compact", instructions ? { instructions } : {});
  said.textContent = plain(compactionLine(r.success ? r.data : undefined, false, r.error, false));
  refresh();
}

/** Why the next reload is happening, when it is happening because somebody asked for it. */
let swapWhy = "";

/**
 * Start a new session, or go back to one.
 *
 * Nothing is deleted by either: the session being left is a file on disk that resume lists, which
 * is the difference between this and clearing a terminal.
 */
async function swap(call, body, why) {
  // Said before the request, not after it. The new session starts announcing itself the moment pi
  // swaps — and those events carry the new epoch, so the reload is often already under way by the
  // time this call returns. Setting the reason afterwards lost the race every time in a browser and
  // never once against a stand-in: what you got was "the session restarted", over an empty feed,
  // for a session you had just asked to start.
  swapWhy = why;
  const note = row("notice", "", "switching…");
  const r = await api(call, body);
  // Mid-turn the server refuses rather than asking, and its refusal says what to do about it. A
  // dialog here would be a second way to answer the same question, on the one screen where the
  // turn it is about is already visible.
  if (!r.success) { swapWhy = ""; note.textContent = plain(r.error || "could not switch session"); return; }
  if (r.data?.cancelled) { swapWhy = ""; note.textContent = "an extension stopped the switch"; return; }
  // The feed is not cleared here. The epoch changed under the page, and the reload that follows is
  // the same one a restarted server gets — one path, already tested, rather than two that drift.
  refresh();
}

/**
 * The commands the page runs itself. Returns true when the line was one of them.
 *
 * The server keeps the same list and refuses these on the prompt route, so a tab left open across
 * an upgrade is told to reload rather than having /clear delivered to the model as two words.
 */
function pageCommand(text) {
  const m = /^\/(\w[\w-]*)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return false;
  const name = m[1].toLowerCase();
  const rest = m[2].trim();
  if (name !== "clear" && name !== "new" && name !== "resume" && name !== "compact") return false;
  row("user", "you", text.trim());
  if (name === "compact") compactNow(rest);
  else if (name === "resume") openSessions();
  else swap("/session/new", {}, "new session — the one you left is under resume");
  return true;
}

$("compact").onclick = () => compactNow("");
$("clear").onclick = () => swap("/session/new", {}, "new session — the one you left is under resume");

/** The sessions of this project, newest first — the conversation, not the filename. */
async function openSessions() {
  const body = $("sessBody");
  body.innerHTML = "";
  $("sessdlg").showModal();
  const r = await api("/sessions");
  const list = r.sessions || [];
  body.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "no other sessions saved for this project yet";
    body.append(empty);
    return;
  }
  for (const s of list) {
    const b = document.createElement("button");
    b.className = "sess";
    if (s.current) b.disabled = true;
    const title = document.createElement("b");
    // plain() everywhere else, and especially here: this is the control that decides which
    // conversation comes back, and a bidi override in a name makes one read as another.
    title.textContent = plain(s.name || s.first || "") || "(nothing said yet)";
    const meta = document.createElement("span");
    const when = s.mtimeMs ? new Date(s.mtimeMs).toLocaleString() : "";
    // The count is what was read, and only part of a long session is read: say "20+" rather than
    // a number that is quietly wrong.
    const msgs = s.messages + (s.truncated ? "+" : "") + " message(s)";
    meta.textContent = [when, msgs, s.current ? "this session" : ""].filter(Boolean).join(" · ");
    b.append(title, meta);
    if (!s.current) {
      b.onclick = () => {
        $("sessdlg").close();
        swap("/session/switch", { file: s.file }, "back in: " + (s.name || s.first || "an earlier session"));
      };
    }
    body.append(b);
  }
}
$("resume").onclick = openSessions;
$("sessClose").onclick = () => $("sessdlg").close();
$("model").onchange = async (e) => {
  // Remembered here and nowhere else, so the next time this browser opens the picker the ones you
  // reach for are at the top of it.
  const was = remembered("models", "").split(",").filter(Boolean);
  remember("models", [e.target.value, ...was.filter((m) => m !== e.target.value)].slice(0, 5).join(","));
  const r = await api("/model", { model: e.target.value });
  if (!r.success) row("err", "error", r.error || "model not available — check credentials");
  refresh();
};
$("thinking").onchange = (e) => api("/thinking", { level: e.target.value }).then(refresh);

/* ---------------- adding a device ---------------- */

/** The matrix as an SVG. One rect per dark module; a version 6 code is 41 across, which is fine. */
function qrSvg(q) {
  const quiet = 4;
  const span = q.size + quiet * 2;
  let rects = "";
  for (let r = 0; r < q.size; r++) {
    // One rect per run of dark modules rather than per module: fewer nodes, same picture.
    let run = 0;
    for (let c = 0; c <= q.size; c++) {
      if (c < q.size && q.m[r][c]) { run++; continue; }
      if (run) rects += '<rect x="' + (c - run + quiet) + '" y="' + (r + quiet) + '" width="' + run + '" height="1"/>';
      run = 0;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + span + " " + span + '" shape-rendering="crispEdges" role="img" aria-label="Pairing code as a QR code">' +
    '<rect width="' + span + '" height="' + span + '" fill="#fff"/><g fill="#000">' + rects + "</g></svg>";
}

$("adddev").onclick = async () => {
  const r = await api("/pair", {});
  if (!r.success) { row("err", "error", r.error || "could not make a pairing code"); return; }
  $("pairCode").textContent = r.code;

  // The address this browser reached, first: under tailscale serve that is the tailnet name, and
  // it is the only one anybody had to configure. Then whatever else the machine can see — which is
  // a guess, so when there is more than one the choice is offered rather than made.
  const here = location.origin + "/";
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(here);
  const candidates = (loopback ? [] : [{ url: here, via: "this window" }]).concat(r.addresses || []);

  const pick = $("pairPick");
  pick.innerHTML = "";
  for (const c of candidates) pick.append(new Option(c.url + " (" + c.via + ")", c.url));
  pick.hidden = candidates.length < 2;

  const draw = () => {
    const target = pick.value || candidates[0]?.url;
    const qr = target ? qrMatrix(target + "?pair=" + r.code) : undefined;
    $("pairQr").innerHTML = qr ? qrSvg(qr) : "";
    $("pairWhere").textContent = target
      ? "Scan it, or open " + target + " on that device and type the code. Good for " +
        Math.round((r.expiresIn || 600) / 60) + " minutes, once."
      : "This window is on " + here + ", which only this machine can reach. Run  tailscale serve --bg " +
        (location.port || 80) + "  and reload, or start with --host 0.0.0.0.";
  };
  pick.onchange = draw;
  draw();
  $("pairdlg").showModal();
};
/**
 * Closing the dialog retires the code. It is a live grant that a camera resolves in one frame, so
 * leaving it armed — and on screen behind whatever you do next — because nobody pressed anything
 * is the wrong default.
 */
function closePairing() {
  $("pairQr").innerHTML = "";
  $("pairCode").textContent = "";
  $("pairWhere").textContent = "";
  $("pairdlg").close();
  api("/pair", { cancel: true });
}
$("pairClose").onclick = closePairing;
$("pairdlg").addEventListener("close", () => { if ($("pairCode").textContent) closePairing(); });

/**
 * Clicking away from a dialog closes it. A native <dialog> does not do this on its own: the
 * backdrop is drawn by the browser and takes the click, so the click target is the dialog element
 * itself while the point is outside its box. That is the test.
 */
for (const dlg of document.querySelectorAll("dialog")) {
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg) return; // a click on something inside it
    const r = dlg.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (outside) dlg.close();
  });
}

/* ---------------- the actions sheet ---------------- */
/**
 * The same buttons, moved rather than duplicated: a second copy means two of every id, two
 * handlers, and one of them going stale the next time somebody edits the other. On a wide screen
 * they live in the header; on a narrow one they are behind ⋯, and this carries them there and back.
 */
$("more").onclick = () => {
  $("menuBody").append($("actions"));
  $("menu").showModal();
};
function closeMenu() {
  document.querySelector("header .grow").insertBefore($("actions"), $("status"));
  $("menu").close();
}
$("menuClose").onclick = closeMenu;
$("menu").addEventListener("close", () => { if ($("menuBody").children.length) closeMenu(); });
/**
 * The sheet gets out of the way *before* the button does its job, not after. A modal dialog makes
 * the rest of the document inert, so an action that ends by focusing something — find, for one —
 * had its focus call ignored and then no keyboard came up. Capture phase, so this runs first.
 */
$("menuBody").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") closeMenu(); }, true);

/**
 * This page against the one the server would send now. They differ when something was installed
 * while this window was open — at which point everything still looks fine and none of the fixes in
 * the new version are running here, because they are not in this document.
 */
function checkAge(s) {
  if (!s?.version || s.version === PAGE_VERSION || PAGE_VERSION === "__" + "VERSION__") return;
  const bar = $("stale");
  bar.hidden = false;
  bar.textContent = "This window is running v" + PAGE_VERSION + "; v" + s.version + " is installed. Reload to use it.";
}
$("stale").onclick = () => location.reload();

/* ---------------- theme, and the side panel ---------------- */
/**
 * Both of these are a preference about this browser and nothing else — no server, no session, no
 * other device. localStorage is where that belongs, and it is allowed to fail: a private window,
 * a browser set to block site data, a thumbnailer. The page has to come up either way.
 */
function remembered(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (_) {
    return fallback;
  }
}
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    // Nothing to do and nothing worth saying: the preference simply does not outlive the tab.
  }
}

const THEMES = ["system", "light", "dark"];
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  $("theme").textContent = theme === "system" ? "◐" : theme === "light" ? "☀" : "☾";
  $("theme").title = "Theme: " + theme + " (click to change)";
}
let theme = remembered("theme", "system");
applyTheme(THEMES.includes(theme) ? theme : "system");
$("theme").onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  remember("theme", theme);
};

const side = document.querySelector("aside");
/**
 * One button, two jobs, because the panel means two different things depending on the width. On a
 * narrow screen it is a drawer that slides over the conversation; on a wide one it is a column that
 * can be given back to the conversation, and that choice is worth remembering.
 */
function applyPanel(hidden) {
  side.classList.toggle("hidden", hidden);
  $("drawer").setAttribute("aria-expanded", String(!hidden));
}
let panelHidden = remembered("panel", "shown") === "hidden";
applyPanel(panelHidden);
/** Open or shut, in one place, so the scrim can never disagree with the drawer. */
function setDrawer(open) {
  side.classList.toggle("open", open);
  $("scrim").hidden = !open;
  $("drawer").setAttribute("aria-expanded", String(open));
}
$("scrim").onclick = () => setDrawer(false);

// The one button that is always the right answer when something looks wrong.
$("reload").onclick = () => location.reload();
$("expand").onclick = () => setAllWork(!allOpen);

$("newer").onclick = () => {
  atBottom = true;
  feed.scrollTop = feed.scrollHeight;
  $("newer").hidden = true;
};

$("drawer").onclick = (e) => {
  e.stopPropagation();
  if (window.matchMedia && window.matchMedia("(max-width:900px)").matches) {
    setDrawer(!side.classList.contains("open"));
    return;
  }
  panelHidden = !panelHidden;
  applyPanel(panelHidden);
  remember("panel", panelHidden ? "hidden" : "shown");
};
// Tapping the conversation puts the drawer away too, for the sliver of it the drawer leaves.
feed.addEventListener("click", () => setDrawer(false));

/* ---------------- completion ---------------- */
const pop = $("pop");
let items = [], sel = 0;
/**
 * Every keystroke asks for completions, and the answers do not necessarily come back in the order
 * they were asked for. Without this, typing "@src/we" quickly showed the whole of src/ — the reply
 * to "@src/" arriving after the reply to "@src/we" and overwriting it. Only the newest request is
 * allowed to draw.
 */
let popSeq = 0;
/**
 * Closing counts as newer, or an answer still in flight reopens what was just closed. Typing
 * "/compact keep the summary short" asks for completions on "/compact", closes the list on the
 * space, and then had the answer arrive and put it back — so Enter accepted "/compact" instead of
 * sending the line. Anything with an argument was reachable by mouse and not by typing.
 */
const hidePop = () => { popSeq++; pop.style.display = "none"; items = []; };

async function updatePop() {
  const el = $("input");
  const upto = el.value.slice(0, el.selectionStart);
  const line = upto.split("\n").pop();
  const mine = ++popSeq;
  const r = await api("/complete", { text: line });
  if (mine !== popSeq) return; // something newer is already on its way
  items = r.items || [];
  if (!items.length) return hidePop();
  sel = 0;
  render();
  pop.style.display = "block";
}
function render() {
  pop.innerHTML = "";
  items.forEach((it, i) => {
    const d = document.createElement("div");
    if (i === sel) d.className = "sel";
    d.innerHTML = "<span>" + esc(it.value) + '</span><span class="h">' + esc(it.hint) + "</span>";
    d.onclick = () => accept(i);
    pop.append(d);
  });
}
function accept(i) {
  const it = items[i];
  const el = $("input");
  const upto = el.value.slice(0, el.selectionStart);
  const nl = upto.lastIndexOf("\n") + 1;
  const line = upto.slice(nl);
  const from = it.replaceFrom !== undefined ? nl + it.replaceFrom : nl;
  el.value = el.value.slice(0, from) + it.value + (it.value.endsWith("/") ? "" : " ") + el.value.slice(el.selectionStart);
  el.focus();
  hidePop();
}
const history = [];
let histIdx = -1;
let histDraft = "";

/**
 * Whether an input method is mid-word. Typing Chinese, Japanese or Korean means Enter picks a
 * candidate from the IME's own list — it is not a request to send anything, and treating it as one
 * sends half a sentence and clears what you were writing. The isComposing flag is the answer where
 * it is set; keyCode 229 says the same thing on browsers that only report it that way, and the last
 * milliseconds after composition ends cover the browsers that fire compositionend first and hand
 * the very same Enter to keydown afterwards.
 */
let composing = false;
let composedAt = 0;
$("input").addEventListener("compositionstart", () => { composing = true; });
$("input").addEventListener("compositionend", () => { composing = false; composedAt = Date.now(); });
const midWord = (e) => composing || e.isComposing || e.keyCode === 229 || Date.now() - composedAt < 50;

$("input").onkeydown = (e) => {
  if (midWord(e)) return;
  // Prompt history, but only while the caret is on the first/last line, so arrows still navigate
  // a multi-line draft.
  if (!items.length && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const el = $("input");
    const before = el.value.slice(0, el.selectionStart);
    const after = el.value.slice(el.selectionStart);
    const atTop = !before.includes("\n");
    const atEnd = !after.includes("\n");
    if (e.key === "ArrowUp" && atTop && history.length) {
      if (histIdx === -1) histDraft = el.value;
      histIdx = Math.min(histIdx + 1, history.length - 1);
      el.value = history[history.length - 1 - histIdx];
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" && atEnd && histIdx >= 0) {
      histIdx -= 1;
      el.value = histIdx === -1 ? histDraft : history[history.length - 1 - histIdx];
      e.preventDefault();
      return;
    }
  }
  if (items.length) {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % items.length; render(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(); return; }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); accept(sel); return; }
    if (e.key === "Escape") { hidePop(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
};
$("input").oninput = () => {
  const el = $("input");
  const line = el.value.slice(0, el.selectionStart).split("\n").pop();
  if (/(^\/[\w-]*$)|(@[^\s]*$)/.test(line)) updatePop(); else hidePop();
};

/**
 * What a new session looks like before anything has happened. A blank rectangle is the one thing a
 * front end can show that says nothing at all — and this is also the first screen on a phone that
 * has just been paired, where "what is this and what do I type" is a real question.
 */
let emptyEl;
function showEmpty() {
  if (feed.children.length) return;
  const el = document.createElement("div");
  el.className = "empty";
  const h = document.createElement("h2");
  h.textContent = "A pi session, in a browser.";
  const p1 = document.createElement("p");
  p1.textContent = "Type below and press Enter. Slash for commands, @ for files, and images can be pasted straight in.";
  const p2 = document.createElement("p");
  p2.textContent = "Everything scheduled — loops, cron jobs, triggers — is in the panel, and keeps running whether or not this window is open.";
  el.append(h, p1, p2);
  emptyEl = el;
  feed.append(el);
}

/**
 * Anything arriving in the feed retires the empty state. Called on every row, so it holds the one
 * node rather than walking the feed: replaying a long history was a scan per message.
 */
function clearEmpty() {
  if (!emptyEl) return;
  emptyEl.remove();
  emptyEl = undefined;
}

/* ---------------- start ---------------- */
(async () => {
  setAllWork(allOpen);
  await refresh();
  const hist = await api("/history");
  for (const m of hist.messages || []) renderMessage(m, false);
  showEmpty();
  feed.scrollTop = feed.scrollHeight;
  // Only what happened after the transcript we just replayed. The server numbers every event and
  // told us which number that was, so this is exact: a turn that is running right now keeps
  // streaming into the page instead of being dropped for being too early.
  let seen = hist.seq ?? 0;
  let epoch = hist.epoch;
  /**
   * The feed is built by appending, which is what keeps a selection alive and a tool panel open —
   * but it also means an event that never arrives is simply missing, and the page goes quietly out
   * of date until someone reloads it. The numbers make that detectable: a jump means the stream
   * dropped something (a reconnect, a slow tab the browser suspended), and the answer is to take
   * the transcript again rather than carry on with a hole in it.
   */
  /**
   * Taking the transcript again takes a moment, and events keep arriving while it happens. They
   * used to be drawn onto a feed that the resync was about to empty — so a message sent at exactly
   * the wrong moment went in and then vanished. They wait here instead, and are applied against the
   * numbering the new transcript establishes.
   */
  let resyncing = false;
  let behind = 0;
  const waiting = [];

  /** What to call this reload: what was asked for, if anything was, and once. */
  const took = () => {
    const why = swapWhy || "the session restarted — the conversation above was reloaded";
    swapWhy = "";
    return why;
  };

  async function resync(why) {
    resyncing = true;
    feed.innerHTML = "";
    emptyEl = undefined;
    toolGroup = undefined;
    openCalls.length = 0;
    blocks = new Map();
    const again = await api("/history");
    for (const m of again.messages || []) renderMessage(m, false);
    seen = again.seq ?? seen;
    epoch = again.epoch ?? epoch;
    // Said after the clearing, or it would be the first thing the clearing removes.
    row("notice", "", why);
    showEmpty();
    feed.scrollTop = feed.scrollHeight;
    resyncing = false;
    behind = 0;
    // Whatever happened while we were reading: anything the transcript already covers is dropped by
    // the same rule as always.
    const held = waiting.splice(0, waiting.length);
    for (const ev of held) take(ev);
    refresh();
  }

  /**
   * The poll is the heartbeat.
   *
   * Everything else here reacts to events, which is no use at all when the events are what stopped
   * arriving — and they do: a server restarted under an open page, a stream the browser dropped
   * while the tab was in the background, a proxy that closed it quietly. The page went on looking
   * alive, drawing what you typed and never showing an answer, until somebody thought to reload it.
   * /state carries the same two numbers the stream does, so a page that is behind can see that it
   * is behind. Twice in a row, because one poll can simply overtake an event in flight.
   */
  checkStream = (s) => {
    // A reload ends by refreshing, and a refresh polls: without this the two call each other.
    if (resyncing || !s || !s.epoch) return;
    if (s.epoch !== epoch) {
      epoch = s.epoch;
      seen = s.seq ?? seen;
      behind = 0;
      void resync(took()).catch(() => {});
      return;
    }
    if ((s.seq ?? 0) > seen) behind++;
    else behind = 0;
    if (behind >= 2) {
      behind = 0;
      void resync("the connection dropped — the conversation above was reloaded").catch(() => {});
    }
  };

  const es = new EventSource("/events?token=" + TOKEN);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (resyncing) return void waiting.push(ev); // applied once the transcript is back
    take(ev);
  };

  function take(ev) {
    if (!ev.seq) return handle(ev); // not numbered: nothing to reason about
    if (epoch && ev.epoch && ev.epoch !== epoch) {
      // A different run of the server: its numbers mean nothing next to the ones we were counting.
      epoch = ev.epoch;
      seen = ev.seq;
      void resync(took()).catch(() => {});
      return;
    }
    if (ev.seq <= seen) return; // already in the transcript we replayed
    if (ev.seq > seen + 1 && seen > 0) {
      // Something in between never arrived. Do not draw this one on top of the gap.
      seen = ev.seq;
      void resync("reconnected — the conversation above was reloaded").catch(() => {});
      return;
    }
    seen = ev.seq;
    handle(ev);
  }

  es.onerror = () => { statusEl.textContent = "reconnecting…"; };
  es.onopen = () => refresh();
  setInterval(refresh, 8000);
})();
</script>`;
