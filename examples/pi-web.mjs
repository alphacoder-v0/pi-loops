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
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/* ------------------------------------------------------------------ arguments */

const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const piArgs = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const flag = (name) => own.includes(`--${name}`);
const value = (name, fallback) => {
	const i = own.indexOf(`--${name}`);
	return i !== -1 && own[i + 1] ? own[i + 1] : fallback;
};

if (flag("help")) {
	console.log(`pi-web — a browser front end for pi

  node pi-web.mjs [options] [-- <pi args>]

  --port <n>        port on 127.0.0.1 (default 4173)
  --loops-dir <p>   pi-loops directory for the automation panel (default $PI_LOOPS_DIR)
  --no-open         do not open a browser
  --help

Anything after -- goes to pi, e.g.  node pi-web.mjs -- --model anthropic/claude-opus-5`);
	process.exit(0);
}

const PORT = Number(value("port", 4173)) || 4173;
const LOOPS_DIR = value("loops-dir", process.env.PI_LOOPS_DIR || path.join(os.homedir(), ".pi", "agent", "loops"));
const TOKEN = process.env.PI_WEB_TOKEN || randomBytes(16).toString("hex");
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
	broadcast({ type: "pi_exit", code, signal });
	console.error(`pi exited (${signal || code})`);
	setTimeout(() => process.exit(code ?? 0), 100);
});
pi.stderr.on("data", (d) => process.stderr.write(d));

let nextId = 1;
const pending = new Map();

/** Send one RPC command and wait for the response that carries its id. */
function rpc(command, timeoutMs = 60_000) {
	if (!piAlive) return Promise.resolve({ success: false, error: "pi is not running" });
	const id = `web-${nextId++}`;
	pi.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
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
function sameProject(jobCwd, sessionCwd) {
	if (!jobCwd || !sessionCwd) return false;
	const a = path.resolve(jobCwd);
	const b = path.resolve(sessionCwd);
	return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
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
	const mine = (j) => (!j.host || j.host === HOST) && sameProject(j.cwd, cwd);
	const jobs = (jobsFile.jobs ?? []).filter(mine).map((j) => ({
		id: j.id,
		name: j.name,
		schedule: formatSchedule(j.schedule),
		stateful: !!j.stateful,
		enabled: !!j.enabled,
		prompt: j.prompt,
		runCount: j.runCount ?? 0,
		lastError: j.lastError,
		running: !!j.running,
		next: nextRun(j),
	}));
	const rules = (readJson(path.join(LOOPS_DIR, "triggers.json"), { rules: [] }).rules ?? [])
		.filter(mine)
		.map((r) => ({ id: r.id, condition: r.condition, action: r.action, enabled: !!r.enabled, fireOnce: !!r.fireOnce, firedAt: r.firedAt }));

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
	return { installed: true, dir: LOOPS_DIR, jobs, rules, inboxNew };
}

/* ------------------------------------------------------------------ what a prompt needs first */

/** Commands this front end implements itself, so typing one is not sent to the model as text. */
const UI_COMMANDS = {
	model: "use the model picker in the header",
	compact: "use the compact button in the header",
	thinking: "use the thinking picker in the header",
	abort: "use the stop button",
	cost: "shown in the header, next to the buttons",
	find: "use the find button",
	history: "press ↑ in the composer",
	undo: "use the undo button",
	save: "use the save button",
	export: "use the save button",
	clear: "not available here — start a new session instead",
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
let commandList = [];

async function refreshCatalogues() {
	const [models, commands] = await Promise.all([rpc({ type: "get_available_models" }, 10_000), rpc({ type: "get_commands" }, 10_000)]);
	if (models?.success) modelCatalog = (models.data?.models ?? []).map((m) => ({ id: m.id, provider: m.provider, name: m.name }));
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

async function snapshot() {
	const state = await rpc({ type: "get_state" }, 15_000);
	const s = state?.success ? state.data : {};
	const cwd = s.cwd || process.cwd();
	return {
		ok: !!state?.success,
		sessionId: s.sessionId,
		sessionName: s.sessionName,
		cwd,
		model: s.model ? { id: s.model.id, provider: s.model.provider, label: `${s.model.provider}/${s.model.id}` } : undefined,
		modelCatalog,
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

/* ------------------------------------------------------------------ http */

const clients = new Set();
const backlog = [];

function broadcast(event) {
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
function localHost(req) {
	const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
	return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function authed(req, url) {
	if (!localHost(req)) return false;
	return sameToken(url.searchParams.get("token")) || sameToken(req.headers["x-pi-web-token"]);
}

/**
 * A one-shot key for the browser launcher. The real token must not appear in argv: on Linux
 * `/proc/<pid>/cmdline` is world-readable, so `xdg-open http://…?token=…` hands the token to every
 * other account on the machine — and with it `/rpc`, which is the whole session. This key is valid
 * for one page load, for a minute, and the page it serves carries the real token.
 */
let openKey = randomBytes(16).toString("hex");
let openKeyExpires = 0;

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
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
};

/** Slash commands at the start of the line, and `@`-paths anywhere — pie's /complete. */
async function complete(text, cwd) {
	const trimmed = text ?? "";
	if (trimmed.startsWith("/") && !trimmed.includes(" ")) {
		const q = trimmed.slice(1).toLowerCase();
		return commandList
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
			const openOk = key && openKey && key === openKey && Date.now() < openKeyExpires;
			if (openOk) openKey = ""; // one load, then it is spent
			if (!openOk && !authed(req, url)) return void res.writeHead(403, { "content-type": "text/plain" }).end("bad or missing token");
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				// The URL carries the token, so no other site should ever be told it.
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
			});
			return void res.end(PAGE.replace("__TOKEN__", TOKEN));
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
			return void json(res, { messages: r?.success ? (r.data?.messages ?? []) : [] });
		}
		if (url.pathname === "/prompt" && req.method === "POST") {
			const { text, images, mode, cwd } = await body(req);
			if (!text && !(images ?? []).length) return void json(res, { success: false, error: "empty prompt" }, 400);
			const guard = guardCommand(text ?? "");
			if (guard) return void json(res, guard, 400);
			// Submitting while a turn runs queues instead of racing it, as the TUI does.
			const type = mode === "steer" ? "steer" : mode === "follow_up" ? "follow_up" : "prompt";
			const message = expandMentions(text ?? "", cwd || process.cwd());
			return void json(res, await rpc({ type, message, ...(images?.length ? { images } : {}) }));
		}
		if (url.pathname === "/model" && req.method === "POST") {
			// The catalogue is rendered as `provider/id`; the command takes the two halves.
			const { model } = await body(req);
			const cut = String(model ?? "").indexOf("/");
			if (cut < 1) return void json(res, { success: false, error: "model must be provider/id" }, 400);
			const answer = await rpc({ type: "set_model", provider: model.slice(0, cut), modelId: model.slice(cut + 1) }, 20_000);
			return void json(res, answer);
		}
		if (url.pathname === "/thinking" && req.method === "POST") {
			const { level } = await body(req);
			return void json(res, await rpc({ type: "set_thinking_level", level }));
		}
		if (url.pathname === "/complete" && req.method === "POST") {
			const { text, cwd } = await body(req);
			return void json(res, { items: await complete(text, cwd || process.cwd()) });
		}
		if (url.pathname === "/abort" && req.method === "POST") return void json(res, await rpc({ type: "abort" }));
		if (url.pathname === "/compact" && req.method === "POST") return void json(res, await rpc({ type: "compact" }, 300_000));
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
			pi.stdin.write(`${JSON.stringify(answer)}\n`);
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

server.listen(PORT, "127.0.0.1", async () => {
	console.log(`pi-web on http://127.0.0.1:${PORT}/?token=${TOKEN}`);
	await refreshCatalogues();
	await primeRuntime();
	if (!flag("no-open") && process.stdout.isTTY) {
		openKeyExpires = Date.now() + 60_000;
		openBrowser(`http://127.0.0.1:${PORT}/?open=${openKey}`);
	}
});

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

/* ------------------------------------------------------------------ the page */

const PAGE = String.raw`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi web</title>
<style>
:root{color-scheme:light dark;--line:#8884;--dim:#8889;--accent:#4a8;--warn:#c84;}
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;font:13.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{flex:1;display:flex;flex-direction:column;min-width:0}
header{display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header .cwd{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38ch}
header .grow{margin-left:auto;display:flex;gap:10px;align-items:center}
select,button,textarea,input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:4px;padding:4px 8px}
button{cursor:pointer}
button.primary{border-color:var(--accent)}
#findbar{display:flex;gap:8px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--line)}
#findbar input{flex:1}
#feed{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
.hit{border-left:3px solid var(--line);padding-left:9px;font-size:12.5px;opacity:.85}
.dot{display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:5px}
.up{background:var(--accent)}.down{background:#c55}.idle{background:#8886}
.row{white-space:pre-wrap;word-break:break-word}
.role{font-size:11px;opacity:.5;letter-spacing:.04em;text-transform:uppercase}
.user{border-left:3px solid var(--accent);padding-left:9px}
.tool{border-left:3px solid var(--warn);padding-left:9px;opacity:.9}
.err{border-left:3px solid #c55;padding-left:9px}
.notice{opacity:.65;font-size:12.5px}
details.think{opacity:.7}
details.think summary{cursor:pointer;font-size:12px;opacity:.7}
pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;max-height:22em;overflow:auto}
form#composer{display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-top:1px solid var(--line);position:relative}
.composer-row{display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;resize:none;min-height:58px;max-height:40vh}
.hint{font-size:11px;opacity:.45;display:flex;gap:10px}
#thumbs{display:flex;gap:6px;flex-wrap:wrap}
#thumbs img{height:44px;border:1px solid var(--line);border-radius:4px}
#pop{position:absolute;bottom:100%;left:12px;right:12px;max-height:15em;overflow:auto;border:1px solid var(--line);border-radius:6px;background:Canvas;display:none;z-index:5}
#pop div{padding:4px 8px;cursor:pointer;display:flex;gap:10px}
#pop div.sel{background:#8882}
#pop .h{opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
aside{width:23rem;border-left:1px solid var(--line);overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:12px}
aside h2{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin:0 0 4px}
.card{border:1px solid var(--line);border-radius:6px;padding:7px 9px;margin-bottom:6px;font-size:12.5px}
.card .t{display:flex;gap:6px;align-items:center}
.card .t b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .m{opacity:.6;font-size:11.5px}
.card button{padding:1px 7px;font-size:11px;margin-left:auto}
.off{opacity:.45}
.badge{border:1px solid var(--line);border-radius:99px;padding:0 7px;font-size:11.5px}
dialog{border:1px solid var(--line);border-radius:8px;padding:14px;max-width:42rem;width:90vw;background:Canvas;color:CanvasText}
dialog h3{margin:0 0 8px;font-size:13px}
dialog pre{background:#8881;padding:8px;border-radius:4px}
dialog menu{display:flex;gap:8px;justify-content:flex-end;padding:0;margin:12px 0 0}
@media (max-width:900px){aside{display:none}}
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
      <button id="find" title="Search the whole session, including abandoned branches">find</button>
      <button id="undo" title="Fork from your last message and put it back in the composer">undo</button>
      <button id="save" title="Export this session as HTML">save</button>
      <button id="compact" title="Compact the context">compact</button>
      <span class="badge" id="status">connecting</span>
    </span>
  </header>
  <div id="findbar" hidden><input id="findq" placeholder="search this session…" ><span id="findn" class="notice"></span></div>
  <div id="feed"></div>
  <form id="composer">
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
<dialog id="ask"><form method="dialog">
  <h3 id="askTitle"></h3><pre id="askBody"></pre><div id="askField"></div>
  <menu><button value="cancel">cancel</button><button value="ok" class="primary" id="askOk">approve</button></menu>
</form></dialog>
<script>
const TOKEN = "__TOKEN__";
const api = (p, b) => fetch(p + (p.includes("?") ? "&" : "?") + "token=" + TOKEN, b === undefined ? {} : { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
const $ = (id) => document.getElementById(id);
const feed = $("feed"), statusEl = $("status");
let state = {}, cwd = "", busy = false, atBottom = true;

feed.addEventListener("scroll", () => { atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40; });
const scroll = () => { if (atBottom) feed.scrollTop = feed.scrollHeight; };

function row(cls, role, text) {
  const el = document.createElement("div");
  el.className = "row " + cls;
  if (role) { const r = document.createElement("div"); r.className = "role"; r.textContent = role; el.append(r); }
  const b = document.createElement("span");
  if (text) b.textContent = text;
  el.append(b);
  feed.append(el); scroll();
  return b;
}
function toolRow(name, args) {
  const el = document.createElement("div");
  el.className = "row tool";
  const r = document.createElement("div"); r.className = "role"; r.textContent = "tool · " + name; el.append(r);
  const pre = document.createElement("pre"); pre.textContent = typeof args === "string" ? args : JSON.stringify(args ?? {}, null, 1); el.append(pre);
  feed.append(el); scroll();
  return el;
}
function thinkRow() {
  const d = document.createElement("details"); d.className = "row think";
  const s = document.createElement("summary"); s.textContent = "thinking"; d.append(s);
  const p = document.createElement("pre"); d.append(p);
  feed.append(d); scroll();
  return p;
}

/* ---------------- streaming assembly: deltas are keyed by contentIndex ---------------- */
let blocks = new Map();
const blockAt = (key, make) => { if (!blocks.has(key)) blocks.set(key, make()); return blocks.get(key); };

function handle(ev) {
  switch (ev.type) {
    case "agent_start": busy = true; setStatus(); break;
    case "agent_end": busy = false; setStatus(); refresh(); break;
    case "message_start": blocks = new Map(); break;
    case "message_update": {
      const d = ev.assistantMessageEvent || {};
      if (d.type === "text_delta") blockAt("t" + d.contentIndex, () => row("", "assistant", "")).textContent += d.delta;
      else if (d.type === "thinking_delta") blockAt("k" + d.contentIndex, thinkRow).textContent += d.delta;
      else if (d.type === "toolcall_start") blockAt("c" + d.contentIndex, () => toolRow(d.toolName, "…")).dataset.tool = d.toolName;
      else if (d.type === "toolcall_end" && d.toolCall) {
        const el = blocks.get("c" + d.contentIndex);
        if (el) el.querySelector("pre").textContent = JSON.stringify(d.toolCall.arguments ?? {}, null, 1);
      }
      break;
    }
    case "message_end": renderMessage(ev.message, true); break;
    case "queue_update": state.queue = { steering: ev.steering || [], followUp: ev.followUp || [] }; setStatus(); break;
    case "extension_ui_request": onAsk(ev); break;
    case "entry_appended": if (ev.entry?.type === "custom") refresh(); break;
    case "compaction_end": row("notice", "", "context compacted"); refresh(); break;
    case "pi_exit": statusEl.textContent = "pi exited"; busy = false; break;
  }
}

function renderMessage(m, live) {
  if (!m) return;
  if (m.role === "user") {
    const text = typeof m.content === "string" ? m.content : (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const imgs = typeof m.content === "string" ? 0 : (m.content || []).filter((c) => c.type === "image").length;
    if (text || imgs) row("user", "you", text + (imgs ? "\n[" + imgs + " image(s)]" : ""));
  } else if (m.role === "toolResult") {
    const text = Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join("") : String(m.content ?? "");
    const el = row(m.isError ? "err" : "tool", "result · " + (m.toolName || ""), "");
    const pre = document.createElement("pre");
    pre.textContent = text.length > 8000 ? text.slice(0, 8000) + "\n… (" + text.length + " chars)" : text;
    el.parentElement.append(pre); scroll();
  } else if (m.role === "custom") {
    // A promotion pi-loops pushed into the chat ("[Trigger ...] ..."), or another extension message.
    // display:false means the model sees it and the person is not meant to.
    if (m.display === false) return;
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    row("tool", m.customType || "custom", text.length > 4000 ? text.slice(0, 4000) + "…" : text);
  } else if (m.role === "assistant" && !live) {
    for (const c of m.content || []) {
      if (c.type === "text" && c.text) row("", "assistant", c.text);
      else if (c.type === "thinking" && c.thinking) thinkRow().textContent = c.thinking;
      else if (c.type === "toolCall") toolRow(c.name, c.arguments);
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

function renderSidebar(s) {
  const a = s.automation || {};
  const box = $("auto");
  if (!a.installed) { box.innerHTML = '<div class="notice">pi-loops not found in ' + esc(a.dir || "") + "</div>"; }
  else {
    let html = "";
    html += '<div class="notice">inbox <b>' + a.inboxNew + "</b> new · " + a.jobs.length + " job(s) · " + a.rules.length + " rule(s)</div>";
    for (const j of a.jobs) {
      html += '<div class="card' + (j.enabled ? "" : " off") + '"><div class="t"><b>' + esc(j.name || j.id.slice(0, 14)) + "</b>" +
        '<span class="m">' + esc(j.schedule) + (j.stateful ? " · loop" : "") + "</span>" +
        '<button data-run="' + esc(j.id) + '">run</button></div>' +
        '<div class="m">' + esc((j.prompt || "").slice(0, 90)) + "</div>" +
        '<div class="m">' + (j.running ? "running · " : "") + "runs " + num(j.runCount) + (j.next ? " · next " + esc(new Date(j.next).toLocaleTimeString()) : "") + "</div>" +
        (j.lastError ? '<div class="m" style="color:#c66">' + esc(j.lastError.slice(0, 120)) + "</div>" : "") + "</div>";
    }
    for (const r of a.rules) {
      html += '<div class="card' + (r.enabled ? "" : " off") + '"><div class="t"><b>rule</b><span class="m">' + (r.fireOnce ? "once" : "repeat") + "</span></div>" +
        '<div class="m">when ' + esc(r.condition.slice(0, 80)) + "</div><div class=\"m\">→ " + esc(r.action.slice(0, 80)) + "</div></div>";
    }
    if (!a.jobs.length && !a.rules.length) html += '<div class="notice">no jobs or rules in this project</div>';
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
function renderRuntime(rt) {
  const box = $("runtime");
  if (!rt) { box.textContent = "no snapshot yet — /cron snapshot writes one"; return; }
  const dot = (state) => '<span class="dot ' + (state === "connected" ? "up" : state === "disabled" || state === "idle" ? "idle" : "down") + '"></span>';
  let html = "";
  const sc = rt.scheduler || {};
  html += "<div>" + dot(sc.running ? (sc.leader ? "connected" : "idle") : "down") +
    (sc.running ? (sc.leader ? "owns the clock" : "standby (another pi owns the clock)") : "scheduler not running") +
    (sc.runs || sc.checks ? " · " + num(sc.runs) + " run(s), " + num(sc.checks) + " check(s)" : "") + "</div>";
  for (const m of rt.mcp || []) {
    html += "<div>" + dot(m.state) + esc(m.name) + " <span class=\"m\">" + esc(m.state) + " · " + num((m.tools || []).length) + " tools" +
      (m.injects ? " · injects" : "") + (m.queued ? " · " + num(m.queued) + " queued" : "") + "</span></div>" +
      (m.lastError ? '<div class="m" style="color:#c66">  ' + esc(String(m.lastError).slice(0, 120)) + "</div>" : "");
  }
  if (rt.mcpConfigError) html += '<div class="m" style="color:#c66">mcp.toml: ' + esc(rt.mcpConfigError) + "</div>";
  const h = rt.hooks || {};
  html += "<div>hooks " + num(h.count) + (h.events?.length ? " (" + h.events.map(esc).join(", ") + ")" : "") + " · tools " + num((rt.tools || []).length) + "</div>";
  if (rt.poll) html += '<div class="m">last check ' + esc(new Date(rt.poll.at).toLocaleTimeString()) + " · " + esc(rt.poll.outcome || "") + "</div>";
  html += '<div class="m">snapshot ' + esc(new Date(rt.at).toLocaleTimeString()) + " · v" + esc(rt.version || "?") + "</div>";
  box.innerHTML = html;
}

async function refresh() {
  state = await api("/state");
  cwd = state.cwd || "";
  $("cwd").textContent = cwd;
  $("cwd").title = cwd;
  $("sid").textContent = (state.sessionId || "").slice(0, 8);
  const sel = $("model");
  if (sel.options.length !== (state.modelCatalog || []).length) {
    sel.innerHTML = "";
    for (const m of state.modelCatalog || []) sel.append(new Option(m.provider + "/" + m.id, m.provider + "/" + m.id));
  }
  if (state.model) sel.value = state.model.label;
  if (state.thinkingLevel) $("thinking").value = state.thinkingLevel;
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
  $("askBody").textContent = req.message || "";
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
    const img = document.createElement("img");
    img.src = "data:" + im.mimeType + ";base64," + im.data;
    img.title = "click to remove";
    img.onclick = () => { images.splice(i, 1); drawThumbs(); };
    $("thumbs").append(img);
  });
}
function addFile(file) {
  const r = new FileReader();
  r.onload = () => { images.push({ type: "image", data: String(r.result).split(",")[1], mimeType: file.type }); drawThumbs(); };
  r.readAsDataURL(file);
}
$("attach").onclick = () => $("file").click();
$("file").onchange = (e) => { for (const f of e.target.files) addFile(f); e.target.value = ""; };
$("input").addEventListener("paste", (e) => {
  for (const item of e.clipboardData?.items || []) if (item.type.startsWith("image/")) addFile(item.getAsFile());
});

$("composer").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("input");
  const text = input.value.trim();
  if (!text && !images.length) return;
  input.value = ""; hidePop();
  if (text) { history.push(text); if (history.length > 200) history.shift(); }
  histIdx = -1;
  const payload = { text, images, cwd, mode: busy ? "follow_up" : undefined };
  if (!busy) row("user", "you", text + (images.length ? "\n[" + images.length + " image(s)]" : ""));
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
  feed.innerHTML = "";
  const hist = await api("/history");
  for (const m of hist.messages || []) renderMessage(m, false);
  row("notice", "", "forked from your last message — it is back in the composer");
  refresh();
};
$("save").onclick = async () => {
  const r = await api("/export", {});
  row("notice", "", r.success ? "saved " + r.data.path : "export failed: " + (r.error || ""));
};
$("compact").onclick = () => { row("notice", "", "compacting…"); api("/compact", {}).then(refresh); };
$("model").onchange = async (e) => {
  const r = await api("/model", { model: e.target.value });
  if (!r.success) row("err", "error", r.error || "model not available — check credentials");
  refresh();
};
$("thinking").onchange = (e) => api("/thinking", { level: e.target.value }).then(refresh);

/* ---------------- completion ---------------- */
const pop = $("pop");
let items = [], sel = 0;
const hidePop = () => { pop.style.display = "none"; items = []; };
async function updatePop() {
  const el = $("input");
  const upto = el.value.slice(0, el.selectionStart);
  const line = upto.split("\n").pop();
  const r = await api("/complete", { text: line, cwd });
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

$("input").onkeydown = (e) => {
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

/* ---------------- start ---------------- */
(async () => {
  await refresh();
  const hist = await api("/history");
  for (const m of hist.messages || []) renderMessage(m, false);
  feed.scrollTop = feed.scrollHeight;
  // Only events from here on: the backlog would double the history that was just replayed.
  const seen = new Set(["message_end"]);
  const es = new EventSource("/events?token=" + TOKEN);
  let ready = false;
  setTimeout(() => (ready = true), 300);
  es.onmessage = (e) => { const ev = JSON.parse(e.data); if (!ready && seen.has(ev.type)) return; handle(ev); };
  es.onerror = () => { statusEl.textContent = "reconnecting…"; };
  es.onopen = () => refresh();
  setInterval(refresh, 8000);
})();
</script>`;
