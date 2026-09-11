/**
 * `pi-loops export|import` — session archives from a command line.
 *
 * An archive is a backup and migration format, and a backup you can only drive by hand from inside
 * a running TUI cannot be put in a cron entry, a CI step, or run on a fresh machine before opening
 * anything. This dispatches before any pi session exists.
 *
 *   pi-loops export [--session <id>] [--cwd <dir>] [--output <file>] [--exclude-triggers]
 *   pi-loops import <file> [--cwd <dir>] [--activate-triggers=off|ask|on]
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { exportSession, defaultExportPath, importSession, inspectArchive } from "./archive.ts";
import { askHost, renderHostSnapshot } from "./host-control-channel.ts";
import { liveHost, stopHost } from "./host-control.ts";
import { JobStore, defaultLoopsDir } from "./store.ts";
import { TriggerStore } from "./triggers.ts";
import { PI_LOOPS_VERSION } from "./version.ts";
import { stamp } from "./schedule.ts";

/**
 * Which front end `pi-loops` opens when you do not say. A browser is the better window when one is
 * reachable, and useless when it is not — so the rule is: a local terminal
 * gets the browser, an ssh session gets the terminal it is already looking at, and anything that is
 * not a terminal at all gets pi in whatever mode its own flags ask for.
 */
export type UiMode = "web" | "terminal";

export function resolveUiMode(input: { web: boolean; tui: boolean; interactiveTty: boolean; remoteTty: boolean }): UiMode {
	if (input.web) return "web";
	if (input.tui) return "terminal";
	if (!input.interactiveTty) return "terminal";
	return input.remoteTty ? "terminal" : "web";
}

/** ssh and mosh set at least one of these; opening a browser on the far end helps nobody. */
export function isRemoteTty(env: NodeJS.ProcessEnv = process.env): boolean {
	return ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "MOSH_CONNECTION"].some((k) => !!env[k]);
}

/** Flags `pi-loops` reads for itself when launching; everything else is pi's. */
const LAUNCH_FLAGS = new Set(["web", "tui", "port", "host", "allow-host", "open", "no-open", "no-auth", "loops-dir", "help"]);
/** The ones that take the next argument as their value. */
const LAUNCH_FLAGS_WITH_VALUE = new Set(["port", "host", "allow-host", "loops-dir"]);

/**
 * Split `pi-loops <flags> <rest>` into ours and pi's. Unknown flags go to pi on purpose: the point
 * of this command is that you can type what you would have typed after `pi`.
 */
export function splitLaunchArgs(argv: string[]): { ours: string[]; pi: string[] } {
	const dashdash = argv.indexOf("--");
	if (dashdash !== -1) return { ours: argv.slice(0, dashdash), pi: argv.slice(dashdash + 1) };
	const ours: string[] = [];
	const pi: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const name = a.startsWith("--") ? a.slice(2).split("=")[0] : undefined;
		if (name && LAUNCH_FLAGS.has(name)) {
			ours.push(a);
			// `--port 4173` takes a value; `--web` does not.
			if (!a.includes("=") && LAUNCH_FLAGS_WITH_VALUE.has(name) && argv[i + 1] && !argv[i + 1].startsWith("-")) ours.push(argv[++i]);
			continue;
		}
		pi.push(a);
	}
	return { ours, pi };
}

export const CLI_USAGE = [
	"pi-loops [--web | --tui] [--port <n>] [--no-auth] [<pi flags>]",
	"    Start a session. On a local terminal that means the browser UI; over ssh, and anywhere",
	"    without a terminal, it means pi itself. --web and --tui say which, and anything this",
	"    command does not recognise is passed to pi (pi-loops --model anthropic/claude-opus-5).",
	"    --no-auth drops the token: the browser UI is then open to anything on this machine.",
	"    --host <addr> binds somewhere other than loopback, so a phone can reach it; the terminal",
	"    prints a six-digit pairing code for that device. --allow-host <name,...> accepts a proxy,",
	"    and a name resolved by public DNS puts the token back in charge of keeping strangers out.",
	"",
	"pi-loops upgrade [--check]",
	"    Install the newest release from the repository this copy came from. --check only looks.",
	"",
	"pi-loops install-launcher [--dir <dir>]",
	"    Put a `pi-loops` launcher on your PATH, so this command works from anywhere.",
	"",
	"pi-loops export [--session <id>] [--cwd <dir>] [--output <file>] [--exclude-triggers]",
	"    Bundle a session and its automation into a .pisession archive.",
	"    Default session: the newest one for --cwd (default: the current directory).",
	"",
	"pi-loops import <file> [--cwd <dir>] [--activate-triggers=off|ask|on]",
	"    Restore an archive into --cwd (default: the current directory).",
	"    Imported automation stays disabled unless --activate-triggers=on (ask: prompt on a terminal).",
	"",
	"pi-loops sessions [--all] [--limit <n>]",
	"    List session ids you can export, newest first.",
	"",
	"pi-loops inspect <file>",
	"    Show what an archive contains without writing anything.",
	"",
	"pi-loops host status | abort <run-id|trace-id> | stop",
	"    Look in on the background host that keeps the clock while no pi is open, or interrupt it.",
].join("\n");

/**
 * An archive is a file someone sent you, and `inspect` is the command you run *before* trusting it.
 * Escape sequences in a prompt could clear the screen, repaint earlier lines or hide the rest of
 * the listing, so nothing from the archive reaches the terminal with control characters intact.
 */
function plain(text: string): string {
	// Newlines go too: every field printed through here is one line, and a prompt carrying one could
	// forge a whole extra row in the listing. The last group is the bidi overrides and isolates,
	// which reorder what is around them without being visible themselves.
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
}

interface SessionFile {
	id: string;
	file: string;
	cwd: string;
	mtimeMs: number;
}

/** pi keeps `<agentDir>/sessions/<encoded cwd>/<timestamp>_<uuid>.jsonl`; the header names the cwd. */
export function listSessions(sessionsRoot: string): SessionFile[] {
	const out: SessionFile[] = [];
	let projects: string[];
	try {
		projects = fs.readdirSync(sessionsRoot);
	} catch {
		return out;
	}
	for (const project of projects) {
		const dir = path.join(sessionsRoot, project);
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of files) {
			if (!name.endsWith(".jsonl")) continue;
			const file = path.join(dir, name);
			try {
				const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n", 1)[0] ?? "{}");
				if (typeof header?.id !== "string") continue;
				out.push({ id: header.id, file, cwd: typeof header.cwd === "string" ? header.cwd : "", mtimeMs: fs.statSync(file).mtimeMs });
			} catch {
				/* not a readable session */
			}
		}
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A full id or a unique prefix; with neither, the newest session of `cwd`. */
export function pickSession(sessions: SessionFile[], opts: { id?: string; cwd: string }): SessionFile {
	if (opts.id) {
		const exact = sessions.find((s) => s.id === opts.id);
		if (exact) return exact;
		const byPrefix = sessions.filter((s) => s.id.startsWith(opts.id!));
		if (byPrefix.length === 1) return byPrefix[0];
		if (byPrefix.length > 1) throw new Error(`session id ${opts.id} is ambiguous (${byPrefix.length} matches)`);
		throw new Error(`no session with id ${opts.id}`);
	}
	const here = sessions.filter((s) => s.cwd === opts.cwd);
	if (!here.length) throw new Error(`no sessions recorded for ${opts.cwd}; pass --session <id>`);
	return here[0];
}

interface Parsed {
	command: string;
	positional: string[];
	flags: Map<string, string | true>;
}

export function parseCliArgs(argv: string[]): Parsed {
	const [command = "", ...rest] = argv;
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (!a.startsWith("--")) {
			positional.push(a);
			continue;
		}
		const eq = a.indexOf("=");
		if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
		else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) flags.set(a.slice(2), rest[++i]);
		else flags.set(a.slice(2), true);
	}
	return { command, positional, flags };
}

async function askYesNo(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await new Promise<string>((r) => rl.question(`${question} [y/N] `, r));
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

/** Run a child to completion, sharing this terminal, and answer with its exit code. */
function runChild(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit", env: env ?? process.env });
		child.on("error", (err: any) => {
			process.stderr.write(`pi-loops: could not start ${command}: ${err?.message ?? err}\n`);
			resolve(1);
		});
		// A signal that reaches us reaches the child too (same process group); wait for it to finish
		// rather than exiting first and leaving a session with no terminal attached to it.
		child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
	});
}

export async function runCli(argv: string[], out: (line: string) => void = console.log): Promise<number> {
	if (cliRoute(argv) === "launch") return launch(argv, out);
	const { command, positional, flags } = parseCliArgs(argv);
	const str = (name: string): string | undefined => {
		const v = flags.get(name);
		return typeof v === "string" ? v : undefined;
	};
	const agentDir = getAgentDir();
	const loopsDir = process.env.PI_LOOPS_DIR || defaultLoopsDir(agentDir);
	const cwd = path.resolve(str("cwd") ?? process.cwd());

	if (command === "web" || command === "tui") return launch(argv, out);
	if (command === "upgrade") return upgrade(flags.has("check"), out);
	if (command === "install-launcher") return installLauncher(str("dir"), out);

	if (command === "sessions") {
		// `pickSession` refuses an unknown id, and there was no way to discover one.
		const sessions = listSessions(path.join(agentDir, "sessions"));
		const here = flags.has("all") ? sessions : sessions.filter((s) => s.cwd === cwd);
		if (!here.length) {
			out(flags.has("all") ? "no sessions recorded" : `no sessions recorded for ${cwd} (use --all)`);
			return 1;
		}
		for (const s of here.slice(0, Number(str("limit") ?? 20))) out(`${s.id}  ${stamp(s.mtimeMs)}  ${s.cwd}`);
		return 0;
	}

	if (command === "inspect") {
		// What is in this archive, without writing anything.
		const file = positional[0];
		if (!file) throw new Error("inspect needs an archive path");
		const info = inspectArchive(path.resolve(file));
		out(`${plain(info.schema)}  exported ${plain(info.createdAt)}  from ${plain(info.sourceCwd)}`);
		// The counts come out of the same manifest and are only numbers if it says so.
		out(`entries=${plain(String(info.entryCount))} cron=${info.jobs.length} triggers=${info.rules.length} loop-state=${plain(String(info.loopStateCount))}`);
		for (const j of info.jobs) out(`  cron  ${j.enabled ? "enabled " : "disabled"} ${plain(j.schedule)}  ${plain(j.prompt)}`);
		for (const r of info.rules) out(`  rule  ${r.enabled ? "enabled " : "disabled"} when ${plain(r.condition)} -> ${plain(r.action)}`);
		return 0;
	}

	if (command === "export") {
		const sessions = listSessions(path.join(agentDir, "sessions"));
		const picked = pickSession(sessions, { id: str("session"), cwd });
		const jobStore = new JobStore(loopsDir);
		// The archive carries this project's automation, the way the slash command does.
		const jobs = jobStore.load().filter((j) => j.cwd === picked.cwd);
		const rules = new TriggerStore(loopsDir).load().filter((r) => r.cwd === picked.cwd);
		const states: Record<string, string> = {};
		for (const j of jobs) {
			const st = j.stateful ? jobStore.readState(j.id) : undefined;
			if (st) states[j.id] = st;
		}
		const outputPath = path.resolve(str("output") ?? defaultExportPath(process.cwd(), picked.id));
		const summary = exportSession({ sessionFile: picked.file, cwd: picked.cwd, jobs, rules, states, excludeTriggers: flags.has("exclude-triggers"), outputPath, piVersion: process.env.PI_VERSION ?? "unknown", piLoopsVersion: PI_LOOPS_VERSION });
		out(`exported ${picked.id} → ${outputPath}`);
		out(`entries=${summary.entryCount} cron=${summary.hasCron ? jobs.length : 0} triggers=${summary.hasTriggers ? rules.length : 0} loop-state=${summary.loopStateCount}`);
		return 0;
	}

	if (command === "import") {
		const file = positional[0];
		if (!file) throw new Error("import needs an archive path");
		const mode = str("activate-triggers") ?? "off";
		if (!["off", "ask", "on"].includes(mode)) throw new Error(`--activate-triggers must be off, ask or on (got ${mode})`);
		const jobStore = new JobStore(loopsDir);
		const triggerStore = new TriggerStore(loopsDir);
		// pi encodes a project as `--home-u-proj--` and `SessionManager.list()` reads only that one
		// directory, with no fallback — a hand-rolled name here would restore a session pi never sees.
		const sessionDir = SessionManager.create(cwd).getSessionDir();
		const activate = mode === "on" || (mode === "ask" && (await askYesNo("Activate the imported automation now?")));
		const existingJobs = jobStore.load();
		const existingRules = triggerStore.load();
		const summary = importSession({ archivePath: path.resolve(file), sessionDir, targetCwd: cwd, activate, existingJobs, existingRules, existingJobIds: new Set(existingJobs.map((j) => j.id)), existingRuleIds: new Set(existingRules.map((r) => r.id)) });
		// The same order the slash command uses, so a half-import leaves neither store inconsistent.
		if (summary.jobs.length) await jobStore.mutate((jobs) => ({ jobs: [...jobs, ...summary.jobs], result: undefined }));
		for (const [id, text] of Object.entries(summary.states)) jobStore.writeState(id, text);
		if (summary.rules.length) await triggerStore.mutate((rules) => rules.push(...summary.rules));
		const skipped = (summary.skippedJobs ?? 0) + (summary.skippedRules ?? 0);
		// The id and the notes come out of the archive's own header, like everything `inspect` prints.
		out(summary.transcriptImported === false ? `imported automation from a pie archive (${plain(summary.originalSessionId)})` : `imported ${plain(summary.originalSessionId)} → ${summary.sessionId}`);
		out(`entries=${plain(String(summary.entryCount))} cron=${summary.jobs.length} triggers=${summary.rules.length} automation=${summary.automationEnabled ? "enabled" : "disabled"}${skipped ? ` skipped=${skipped} (already imported)` : ""}`);
		for (const note of summary.notes ?? []) out(`note: ${plain(note)}`);
		if (summary.transcriptImported !== false) out(`session: ${summary.sessionPath}`);
		if (!summary.automationEnabled && (summary.jobs.length || summary.rules.length)) out("automation is disabled; enable it with /cron enable <id> or re-import with --activate-triggers=on");
		return 0;
	}

	if (command === "host") {
		const sub = positional[0] ?? "status";
		if (sub === "status") {
			const res = await askHost(loopsDir, { op: "status" });
			if (!res) {
				// No answer is not the same as no host: one wedged on a hung MCP read still holds the
				// record. Fall back to it, so the user gets a pid and a log to look at.
				const rec = liveHost(loopsDir);
				if (rec) {
					out(`background host pid ${rec.pid} on ${rec.host} is not answering (started ${rec.startedAt})`);
					out(`  log: ${path.join(loopsDir, "host.log")}`);
					out(`  stop it with: pi-loops host stop`);
					return 1;
				}
				out("no background host is running (it runs only while no pi is open)");
				return 1;
			}
			if (!res.ok) throw new Error(res.error);
			out("background host");
			for (const line of renderHostSnapshot(res.snapshot!)) out(line);
			return 0;
		}
		if (sub === "abort") {
			const ref = positional[1];
			if (!ref) throw new Error("host abort needs a run id or a trigger trace id");
			// A run id is `run-<32 hex>`; anything else is treated as a trigger trace.
			const res = await askHost(loopsDir, ref.startsWith("run-") ? { op: "abort", runId: ref } : { op: "abort", traceId: ref });
			if (!res) throw new Error("no background host is running");
			if (!res.ok) throw new Error(res.error);
			out(res.aborted ? `aborted ${ref}` : `nothing running with id ${ref}`);
			return res.aborted ? 0 : 1;
		}
		if (sub === "stop") {
			const res = await askHost(loopsDir, { op: "stop" });
			if (res?.ok) {
				out("asked the background host to stop");
				return 0;
			}
			// It did not answer; SIGTERM the recorded pid, which is what `/cron host stop` does.
			const pid = stopHost(loopsDir);
			out(pid ? `background host (pid ${pid}) was not answering; sent SIGTERM` : "no background host is running");
			return pid ? 0 : 1;
		}
		throw new Error(`unknown host command ${JSON.stringify(sub)}`);
	}

	const asked = command && command !== "help" && command !== "--help";
	if (asked) {
		// Naming the command, and the version running, because the likeliest reason a subcommand is
		// unknown is that it was added after the copy you have — which is exactly the case where
		// printing a usage list and nothing else leaves you staring at it. An upgrade command can
		// never be in the version that predates it.
		out(`unknown command ${JSON.stringify(command)} (this is pi-loops v${PI_LOOPS_VERSION})`);
		out(`if you expected it, the copy you are running may be older than the command: pi install git:github.com/alphacoder-v0/pi-loops@<newer tag>`);
		out("");
	}
	out(CLI_USAGE);
	return asked ? 2 : 0;
}

const SUBCOMMANDS = new Set(["export", "import", "sessions", "inspect", "host", "web", "upgrade", "install-launcher", "help"]);

/** `v1.2.3` → comparable parts; anything else is not a release and is ignored. */
function semver(tag: string): [number, number, number] | undefined {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Is `a` a later release than `b`? Compared numerically, so v0.10.0 beats v0.9.0. */
export function isNewerVersion(a: string, b: string): boolean {
	const x = semver(a);
	const y = semver(b);
	if (!x || !y) return false;
	for (let i = 0; i < 3; i++) {
		if (x[i] !== y[i]) return x[i] > y[i];
	}
	return false;
}

/**
 * The newest release tag in `git ls-remote --tags` output. Release tags only: a branch, an rc or a
 * `^{}` peeled entry is not something to upgrade someone to without being asked.
 */
export function newestReleaseTag(lsRemote: string): string | undefined {
	let best: string | undefined;
	for (const line of lsRemote.split("\n")) {
		const ref = line.split(/\s+/)[1];
		if (!ref?.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
		const tag = ref.slice("refs/tags/".length);
		if (!semver(tag)) continue;
		if (!best || isNewerVersion(tag, best)) best = tag;
	}
	return best;
}

/** Where this copy came from, so an upgrade goes back to the same place a fork included. */
function repositoryUrl(): string | undefined {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
		const url = String(pkg?.repository?.url ?? "");
		return url.replace(/^git\+/, "").replace(/\.git$/, "") || undefined;
	} catch {
		return undefined; // installed without its package.json: nothing to ask
	}
}

/**
 * Find the newest release and install it. `pi update --extensions` deliberately does not do this —
 * it reconciles a git package to the ref you pinned — so taking a release otherwise means looking
 * up a tag by hand and retyping it, which is a thing a command should do for you.
 */
async function upgrade(checkOnly: boolean, out: (line: string) => void): Promise<number> {
	const repo = repositoryUrl();
	if (!repo) {
		out("cannot tell where this copy came from (no package.json next to it)");
		return 1;
	}
	const ls = spawnSync("git", ["ls-remote", "--tags", "--refs", repo], { encoding: "utf8" });
	if (ls.status !== 0) {
		out(`could not read tags from ${repo}: ${(ls.stderr || "").trim() || `git exited ${ls.status}`}`);
		return 1;
	}
	const latest = newestReleaseTag(ls.stdout ?? "");
	if (!latest) {
		out(`no release tags at ${repo}`);
		return 1;
	}
	out(`installed: v${PI_LOOPS_VERSION}    latest: ${latest}`);
	if (!isNewerVersion(latest, `v${PI_LOOPS_VERSION}`)) {
		out("already up to date");
		return 0;
	}
	const spec = `git:${repo.replace(/^https?:\/\//, "")}@${latest}`;
	if (checkOnly) {
		out(`upgrade with: pi install ${spec}`);
		return 0;
	}
	out(`pi install ${spec}`);
	const code = await runChild(process.env.PI_BIN || "pi", ["install", spec]);
	if (code === 0) out("upgraded — restart pi, or `pi-loops` again, to load it");
	return code;
}

/**
 * Starting a session is the thing you do most often, so bare `pi-loops` does it, and so does
 * anything that begins with a flag — `pi-loops --model x` should mean what `pi --model x` means.
 *
 * A bare word is never passed on, though: `pi-loops exprot` is a typo, and turning it into an
 * argument for pi would start a session and hide the mistake, which is the worst of both.
 */
export function cliRoute(argv: string[]): "launch" | "subcommand" {
	const first = argv[0];
	if (first === undefined) return "launch";
	if (first === "--help" || first === "-h" || first === "help") return "subcommand";
	if (first.startsWith("-")) return "launch";
	// Known or not, a word goes down the subcommand path — which is where the unknown-command
	// message lives, and `web` and `tui` are handled there as launch words.
	return "subcommand";
}

/**
 * `pi install` puts this package under pi's managed directory rather than on your PATH, so the
 * command that is supposed to start your sessions is reachable only by absolute path. This writes
 * a two-line launcher into a directory that is already on your PATH, which is the smallest thing
 * that fixes it without asking you to publish or install anything else.
 */
export async function installLauncher(dir: string | undefined, out: (line: string) => void): Promise<number> {
	const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
	const target = dir ? path.resolve(dir) : [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin"].find((d) => onPath.includes(path.resolve(d)));
	if (!target) {
		out("no directory to install into: neither ~/.local/bin nor /usr/local/bin is on your PATH.");
		out("pass one with --dir <dir>, or add ~/.local/bin to PATH and run this again.");
		return 1;
	}
	if (dir && !onPath.includes(target)) out(`note: ${target} is not on your PATH, so the command will not be found there yet`);
	const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli-entry.mjs");
	const file = path.join(target, "pi-loops");
	// A launcher rather than a symlink: it survives the package moving, and it names the node that
	// is running now, which is the one known to be new enough for this code.
	const script = `#!/bin/sh\n# pi-loops launcher, written by \`pi-loops install-launcher\`.\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`;
	try {
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(file, script, { mode: 0o755 });
		fs.chmodSync(file, 0o755);
	} catch (err: any) {
		out(`could not write ${file}: ${err?.message ?? err}`);
		return 1;
	}
	out(`wrote ${file}`);
	out(`  it runs ${entry}`);
	out("  `pi-loops` now starts a session; `pi-loops --tui` opens the terminal one instead");
	return 0;
}

/**
 * Start a session: the browser front end, or pi itself. Both are complete pi sessions — the browser
 * one runs `pi --mode rpc` behind a page (src/web.mjs) — so this is a choice of window, not of
 * product, and `--tui` is always there when the guess is wrong.
 */
async function launch(argv: string[], out: (line: string) => void): Promise<number> {
	const { ours, pi } = splitLaunchArgs(argv[0] === "web" || argv[0] === "tui" ? argv.slice(1) : argv);
	const has = (name: string) => ours.includes(`--${name}`);
	if (has("help")) {
		out(CLI_USAGE);
		return 0;
	}
	const mode = resolveUiMode({
		web: argv[0] === "web" || has("web"),
		tui: argv[0] === "tui" || has("tui"),
		interactiveTty: !!process.stdout.isTTY && !!process.stdin.isTTY,
		remoteTty: isRemoteTty(),
	});
	const withDefaults = applyRememberedModel(pi, uiPrefs(loopsDir(ours)));
	if (mode === "terminal") return runChild(process.env.PI_BIN || "pi", withDefaults);
	const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "web.mjs");
	return runChild(process.execPath, [web, ...ours.filter((a) => a !== "--web" && a !== "--tui"), ...(withDefaults.length ? ["--", ...withDefaults] : [])]);
}

/** Where the data lives for this run: the flag, then the environment, then the default. */
function loopsDir(ours: string[]): string {
	const at = ours.indexOf("--loops-dir");
	if (at !== -1 && ours[at + 1]) return ours[at + 1];
	const eq = ours.find((a) => a.startsWith("--loops-dir="));
	if (eq) return eq.slice("--loops-dir=".length);
	return process.env.PI_LOOPS_DIR || path.join(os.homedir(), ".pi", "agent", "loops");
}

export interface UiPrefs {
	model?: string;
	thinking?: string;
}

function uiPrefs(dir: string): UiPrefs {
	try {
		const doc = JSON.parse(fs.readFileSync(path.join(dir, "ui.json"), "utf8"));
		return { model: typeof doc.model === "string" ? doc.model : undefined, thinking: typeof doc.thinking === "string" ? doc.thinking : undefined };
	} catch {
		return {}; // no preferences yet, or a file somebody edited into something else
	}
}

/**
 * The model you last chose, for the next session that has no opinion of its own.
 *
 * Not for a session that is being resumed — that one already has a model, and the one it was
 * having the conversation with is the right one — and not when you said which model on the command
 * line, because you just said. Everything else is a new session starting on pi's default, which is
 * how you ended up choosing the same model every morning.
 */
export function applyRememberedModel(piArgs: string[], prefs: UiPrefs): string[] {
	const said = (name: string) => piArgs.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (said("continue") || piArgs.includes("-c") || said("resume") || piArgs.includes("-r") || said("session") || said("session-id")) return piArgs;
	const out = [...piArgs];
	if (prefs.model && !said("model")) out.push("--model", prefs.model);
	if (prefs.thinking && !said("thinking")) out.push("--thinking", prefs.thinking);
	return out;
}
