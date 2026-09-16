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
import { applyImport, automationOf, exportSession, defaultExportPath, importSession, inspectArchive, offerToEnable, parseActivateMode } from "./archive.ts";
import { askHost, renderHostSnapshot } from "./host-control-channel.ts";
import { FINDING_FIELDS, Inbox, type InboxEntry, inProject, resolveInboxRef } from "./inbox.ts";
import { sameProject } from "./presence.ts";
import { redact } from "./redact.ts";
import { liveHost, stopHost } from "./host-control.ts";
import { type UiPrefs, readUiPrefs } from "./ui-prefs.ts";
import { JobStore, defaultLoopsDir } from "./store.ts";
import { automationBadge, previewText, readSessionHead } from "./session-head.ts";
import { AUTONOMY_LEVELS, type AutonomyLevel, INSTALL_ROOT, TRACKER_FILE, addLineFor, ensureExcluded, installDirFor, installFiles, installedRecipes, listRecipes, loadRecipe, planInstall, playbookFiles, readRecord, resolveRecipeRef } from "./recipe.ts";
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
		const arg = argv[i];
		const name = arg.startsWith("--") ? arg.slice(2).split("=")[0] : undefined;
		if (name && LAUNCH_FLAGS.has(name)) {
			ours.push(arg);
			// `--port 4173` takes a value; `--web` does not.
			if (!arg.includes("=") && LAUNCH_FLAGS_WITH_VALUE.has(name) && argv[i + 1] && !argv[i + 1].startsWith("-")) ours.push(argv[++i]);
			continue;
		}
		pi.push(arg);
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
	"    --activate-triggers: off never asks, on activates, ask (the default) prompts after the import.",
	"",
	"pi-loops sessions [--all] [--limit <n>]",
	"    List sessions, newest first: short id, when it started, its automation, what was first said in it.",
	"",
	"pi-loops inspect <file>",
	"    Show what an archive contains without writing anything.",
	"",
	"pi-loops host status | abort <run-id|trace-id> | stop",
	"    Look in on the background host that keeps the clock while no pi is open, or interrupt it.",
	"",
	"pi-loops recipe list | show <name|path> | add <name|path> [--cwd <dir>] [--level report|propose|act] [--overwrite]",
	"    The packaged recipes; what one installs; copy its playbooks into a project (.agents/skills/<name>/).",
	"    The setup script and the jobs need a pi open in the project: /recipe add <name> finds the copies and finishes.",
	"",
	"pi-loops inbox list [--all] [--cwd <dir>] | claim <id> | dismiss <id> [--reason <text>]   [--json]",
	"    The triage inbox with no pi open: what /inbox lists, and the two things it does to a finding.",
	"    --json prints the shape docs/downstream.md fixes for programs.",
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
	/** The header's timestamp. */
	startedAt?: string;
	/** `/name`, or the first thing the person said — what tells two sessions apart. */
	preview?: string;
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
				const head = readSessionHead(file);
				if (!head) continue;
				out.push({ id: head.id, file, cwd: head.cwd, mtimeMs: fs.statSync(file).mtimeMs, startedAt: head.startedAt, preview: head.name ?? head.first });
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

/**
 * Flags that never take a value, so the word after them is a positional: `inbox claim --json <id>`
 * must not read the id as the value of `--json`.
 */
const BOOLEAN_FLAGS = new Set(["all", "json", "check", "overwrite", "exclude-triggers", "help"]);

export function parseCliArgs(argv: string[]): Parsed {
	const [command = "", ...rest] = argv;
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		if (eq > 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
		else if (!BOOLEAN_FLAGS.has(arg.slice(2)) && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) flags.set(arg.slice(2), rest[++i]);
		else flags.set(arg.slice(2), true);
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
		// A signal that reaches us reaches this child too: the launcher and what it starts — pi in a
		// terminal, or `web.mjs` — share the terminal's process group, so Ctrl-C arrives at both. The
		// browser front end starts its own pi *outside* that group on purpose (see `src/web.mjs`), so
		// that pi is ended by web.mjs asking it to quit rather than by the group's SIGINT, and gets to
		// hand the clock to a headless host on the way out. Either way, wait for the child to finish
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
	if (command === "recipe") return recipeCommand(positional, { level: str("level"), overwrite: flags.has("overwrite") }, cwd, loopsDir, out);
	if (command === "inbox") return inboxCommand(positional, { all: flags.has("all"), json: flags.has("json"), reason: flags.get("reason") }, cwd, loopsDir, out);

	if (command === "sessions") {
		// `pickSession` refuses an unknown id, and there was no way to discover one.
		const sessions = listSessions(path.join(agentDir, "sessions"));
		const here = flags.has("all") ? sessions : sessions.filter((s) => s.cwd === cwd);
		if (!here.length) {
			out(flags.has("all") ? "no sessions recorded" : `no sessions recorded for ${cwd} (use --all)`);
			return 1;
		}
		// One line a person can tell sessions apart by: short id, when it started, the automation the
		// session has, what was first said in it. With --all the cwd sits after the id.
		const jobs = new JobStore(loopsDir).load();
		const rules = new TriggerStore(loopsDir).load();
		for (const s of here.slice(0, Number(str("limit") ?? 20))) {
			const badge = automationBadge(s.id, jobs, rules);
			out(`${s.id.slice(0, 16)}  ${flags.has("all") ? `${s.cwd}  ` : ""}${(s.startedAt ?? stamp(s.mtimeMs)).slice(0, 16)}${badge ? `  [${badge}]` : ""}  ${s.preview ? previewText(s.preview) : ""}`.trimEnd());
		}
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
		// The archive carries what the picked session created in its project — the one rule
		// `/session-export` follows too, in `automationOf`.
		const { jobs, rules } = automationOf(jobStore.load(), new TriggerStore(loopsDir).load(), picked.cwd, picked.id);
		const states: Record<string, string> = {};
		for (const job of jobs) {
			const loopState = job.stateful ? jobStore.readState(job.id) : undefined;
			if (loopState) states[job.id] = loopState;
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
		const mode = parseActivateMode(str("activate-triggers"));
		const jobStore = new JobStore(loopsDir);
		const triggerStore = new TriggerStore(loopsDir);
		// pi encodes a project as `--home-u-proj--` and `SessionManager.list()` reads only that one
		// directory, with no fallback — a hand-rolled name here would restore a session pi never sees.
		const sessionDir = SessionManager.create(cwd).getSessionDir();
		const existingJobs = jobStore.load();
		const existingRules = triggerStore.load();
		const summary = importSession({ archivePath: path.resolve(file), sessionDir, targetCwd: cwd, activate: mode === "on", existingJobs, existingRules, existingJobIds: new Set(existingJobs.map((j) => j.id)), existingRuleIds: new Set(existingRules.map((r) => r.id)) });
		// The writes and the rollback the slash command does, in `applyImport`.
		await applyImport(summary, jobStore, triggerStore);
		const skipped = (summary.skippedJobs ?? 0) + (summary.skippedRules ?? 0);
		// The id and the notes come out of the archive's own header, like everything `inspect` prints.
		out(`imported ${plain(summary.originalSessionId)} → ${summary.sessionId}`);
		out(`entries=${plain(String(summary.entryCount))} cron=${summary.jobs.length} triggers=${summary.rules.length} automation=${summary.automationEnabled ? "enabled" : "disabled"}${skipped ? ` skipped=${skipped} (already imported)` : ""}`);
		for (const note of summary.notes ?? []) out(`note: ${plain(note)}`);
		out(`session: ${summary.sessionPath}`);
		// `ask` is the default: the same question the slash command asks, once, after the import.
		// `askYesNo` already answers no with no terminal to ask at.
		const enabled = await offerToEnable(summary, jobStore, triggerStore, mode === "ask" ? (question, detail) => {
			if (process.stdin.isTTY) out(detail); // what the dialog shows above the question
			return askYesNo(question);
		} : undefined);
		if (enabled.jobs || enabled.rules) out(`enabled ${enabled.jobs} cron job(s) and ${enabled.rules} trigger rule(s)`);
		else if (!summary.automationEnabled && (summary.jobs.length || summary.rules.length)) out("automation is disabled; enable it with /cron enable <id> or re-import with --activate-triggers=on");
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
		// The route has to match how this copy was installed, for the same reason `upgrade` does: a
		// spec from the other one installs a second copy rather than replacing this one.
		const spec = upgradeSpec(packageRoot(), manifest().name ?? "", agentDir, "<newer release>", configuredNpmSource(packageRoot(), manifest().name ?? ""));
		out(`if you expected it, the copy you are running may be older than the command: ${spec ? `pi install ${spec}` : checkoutUpgradeHint()}`);
		out("");
	}
	out(CLI_USAGE);
	return asked ? 2 : 0;
}

const SUBCOMMANDS = new Set(["export", "import", "sessions", "inspect", "host", "recipe", "inbox", "web", "upgrade", "install-launcher", "help"]);

/**
 * `pi-loops inbox`: `/inbox list|claim|dismiss` for a shell with no pi open, and — with `--json` —
 * for a program. The JSON is the contract in docs/downstream.md: the fields, their names and their
 * types are fixed there, and `test/downstream/inbox.sh` reads them back with jq. What is not fixed:
 * the plain text, which is for a person at a prompt. A claim here marks the finding and stops,
 * since there is no session to hand it to; the caller is the one who acts on it.
 */
async function inboxCommand(positional: string[], opts: { all: boolean; json: boolean; reason?: string | true }, cwd: string, loopsDir: string, out: (line: string) => void): Promise<number> {
	const fail = (why: string): number => {
		out(opts.json ? JSON.stringify({ error: why }) : why);
		return 1;
	};
	try {
		return await inboxCommandBody(positional, opts, cwd, loopsDir, out, fail);
	} catch (err: any) {
		// A program reads one object either way: an unreadable file or a lock that timed out is an
		// `error` on stdout, not a usage dump on stderr.
		return fail(err?.message ?? String(err));
	}
}

async function inboxCommandBody(positional: string[], opts: { all: boolean; json: boolean; reason?: string | true }, cwd: string, loopsDir: string, out: (line: string) => void, fail: (why: string) => number): Promise<number> {
	const sub = positional[0] ?? "list";
	const inbox = new Inbox(loopsDir);
	if (sub === "list") {
		const entries = opts.all ? inbox.listNew() : inProject(inbox.listNew(), cwd, sameProject);
		if (opts.json) {
			out(JSON.stringify({ findings: entries.map(findingJson) }));
			return 0;
		}
		if (!entries.length) out(opts.all ? "inbox: nothing new on this machine" : `inbox: nothing new in ${cwd} (--all lists every project)`);
		for (const e of entries) out(findingLine(e));
		return 0;
	}
	if (sub === "claim" || sub === "dismiss") {
		const ref = positional[1];
		if (!ref) return fail(`inbox ${sub} needs a finding id`);
		if (opts.reason === true) return fail("--reason needs a text (--reason=<text> when it starts with --)");
		// An id or a prefix resolves machine-wide, as it does in /inbox, and only among what is new:
		// a finding already claimed or dismissed is not decided twice. A number resolves to nothing
		// here — `/inbox claim 3` is the number on a screen, and this command printed none — and the
		// digits only pick the wording, since "no entry matching '1'" reads like a missing finding.
		const entry = resolveInboxRef(inbox.listNew(), ref);
		if (!entry) return fail(/^\d+$/.test(ref.trim()) ? `inbox ${sub} takes a finding id (inb-…) or a prefix of one, not a number` : `no new inbox entry matching '${ref}'`);
		const updated = await inbox.setStatus(entry.id, sub === "claim" ? "claimed" : "dismissed", sub === "claim" ? "cli" : undefined, opts.reason);
		if (!updated) return fail(`inbox entry ${entry.id} is gone`);
		out(opts.json ? JSON.stringify({ finding: findingJson(updated) }) : `${updated.status} ${updated.id}`);
		return 0;
	}
	return fail(`unknown inbox command ${JSON.stringify(sub)} (list | claim <id> | dismiss <id> [--reason <text>])`);
}

/**
 * One finding as docs/downstream.md fixes it: the contract's fields of the entry and nothing else,
 * in their order, with what a person may read redacted. Fields are added at the end, never renamed.
 */
function findingJson(e: InboxEntry): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of FINDING_FIELDS) out[field] = e[field];
	out.text = redact(e.text);
	out.dismiss_reason = e.dismiss_reason === null ? null : redact(e.dismiss_reason);
	return out;
}

/** A person's line: the full id (it is what `claim` takes), the finding, where and when it came from. */
function findingLine(e: InboxEntry): string {
	const mark = `${e.kind === "checkpoint" ? "⚑ " : ""}${e.verified ? "✓ " : ""}`;
	return `${e.id}  ${mark}${plain(redact(e.text))}  (${path.basename(e.cwd) || e.cwd || "—"}, ${e.source}, ${e.created_at})`;
}

/**
 * `pi-loops recipe`: the deterministic part of `/recipe`, for a shell with no pi open. `add` copies
 * the playbooks, lists the directory in `.git/info/exclude` and writes the record — and stops there:
 * the setup script is shown to a person before it runs and the jobs are created after a
 * confirmation, both of which need the pi that `/recipe add` runs in. It finds the copies in place.
 */
async function recipeCommand(positional: string[], opts: { level?: string; overwrite: boolean }, cwd: string, loopsDir: string, out: (line: string) => void): Promise<number> {
	const sub = positional[0] ?? "list";
	if (sub === "list") {
		const packaged = listRecipes();
		const installed = new Map(installedRecipes(cwd).map((r) => [r.recipe, r]));
		const jobs = new JobStore(loopsDir).load().filter((j) => j.recipe && j.cwd === cwd);
		for (const r of packaged) {
			const rec = installed.get(r.manifest.name);
			const n = jobs.filter((j) => j.recipe === r.manifest.name).length;
			out(`${r.manifest.name.padEnd(17)} ${(rec ? `installed: ${rec.level}, ${n} job(s)` : "—").padEnd(28)} ${r.manifest.summary}`);
		}
		for (const rec of installed.values()) if (!packaged.some((r) => r.manifest.name === rec.recipe)) out(`${rec.recipe.padEnd(17)} installed from ${rec.source} (${rec.level})`);
		if (!packaged.length && !installed.size) out("no recipes packaged, none installed here");
		return 0;
	}
	if (sub === "show" || sub === "add") {
		const ref = positional[1];
		if (!ref) throw new Error(`recipe ${sub} needs a recipe name or a directory`);
		const resolved = resolveRecipeRef(ref, { cwd });
		const recipe = loadRecipe(resolved.dir);
		const m = recipe.manifest;
		const rel = path.join(INSTALL_ROOT, m.name);
		if (sub === "show") {
			out(`${m.name} (${recipe.dir})`);
			out(`  ${m.summary}`);
			out(`  levels: ${m.levels.join(", ")}   tracker: ${m.needsTracker ? "needs docs/agents/issue-tracker.md" : "not needed"}${m.setup ? `   setup: ${m.setup}` : ""}`);
			out(`  files → ${rel}/: ${playbookFiles(m).join(", ")}`);
			for (const j of m.jobs) out(`  /cron add ${addLineFor(j, rel)}`);
			const record = readRecord(installDirFor(cwd, m.name));
			if (record) out(`  installed in ${cwd}: ${record.level}, ${record.installedAt}, pi-loops ${record.version}`);
			return 0;
		}
		let level = m.levels[0];
		if (opts.level) {
			if (!m.levels.includes(opts.level as AutonomyLevel)) throw new Error(`${m.name} supports ${m.levels.join(", ")}, not "${opts.level}" (levels are ${AUTONOMY_LEVELS.join(", ")})`);
			level = opts.level as AutonomyLevel;
		}
		const plan = planInstall(recipe, cwd, level);
		const record = installFiles(recipe, cwd, level, { overwrite: opts.overwrite, source: resolved.source });
		const excluded = ensureExcluded(cwd, rel);
		if (m.needsTracker && fs.existsSync(path.join(cwd, TRACKER_FILE))) ensureExcluded(cwd, TRACKER_FILE, "file");
		out(`copied ${record.files.length} file(s) → ${plan.targetDir}/ (level ${level}${opts.level ? "" : ", the lowest; --level to choose"})`);
		for (const f of plan.changed) out(`  ${f}: ${opts.overwrite ? "overwritten" : "kept as edited (--overwrite replaces it)"}`);
		out(excluded === "no-git" ? "not a git repository: nothing to exclude" : `.git/info/exclude: ${excluded === "added" ? "added" : "already listed"}`);
		if (m.needsTracker && !fs.existsSync(path.join(cwd, TRACKER_FILE))) out(`${m.name} reads docs/agents/issue-tracker.md and this project has none: /recipe add ${m.name} in pi writes it with you first`);
		out(`no jobs created: open pi in ${cwd} and run /recipe add ${m.name} — it shows ${m.setup ? `${m.setup} and ` : ""}these lines, then creates them:`);
		for (const line of plan.addLines) out(`  /cron add ${line}`);
		return 0;
	}
	out(`unknown recipe command ${JSON.stringify(sub)}: pi-loops recipe list | show <name|path> | add <name|path>`);
	return 2;
}

/** `v1.2.3` → comparable parts; anything else is not a release and is ignored. */
function semver(tag: string): [number, number, number] | undefined {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Is `candidate` a later release than `current`? Compared numerically, so v0.10.0 beats v0.9.0. */
export function isNewerVersion(candidate: string, current: string): boolean {
	const left = semver(candidate);
	const right = semver(current);
	if (!left || !right) return false;
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] > right[i];
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

/** The directory this copy of the package lives in — one above the sources. */
function packageRoot(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Where this copy came from and what it is called, so an upgrade goes back to the same place. */
function manifest(): { name?: string; repositoryUrl?: string } {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
		const url = String(pkg?.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
		return { name: typeof pkg?.name === "string" ? pkg.name : undefined, repositoryUrl: url || undefined };
	} catch {
		return {}; // installed without its package.json: nothing to ask
	}
}

/**
 * Which `pi install` argument replaces *this* copy with `tag` — and `undefined` when none does.
 *
 * The one thing this must never do is offer a route the copy did not come down. `pi install` with a
 * different source does not replace anything: it adds a second package, both copies register
 * `cron_create` and the rest, and pi refuses to load the second one and exits with
 * `Tool "cron_create" conflicts with …`. Someone who installed from npm and then ran the upgrade
 * command this project ships would have done only what the README told them to.
 *
 * pi's layout answers the question, because it is where pi put the package:
 * an `npm:` package sits in a `node_modules` directory under its own name (the managed
 * `<agent dir>/npm/node_modules/<name>`, or the global one an older pi used), a `git:` package sits
 * at `<agent dir>/git/<host>/<owner>/<repo>` — which is the spec it was installed by, spelled as a
 * path — and a local checkout is in neither place. A checkout has no install to redo: it has a
 * remote, and `git pull` is its upgrade.
 */
export function upgradeSpec(packageDir: string, packageName: string, agentDir: string, tag: string, configuredSource?: string): string | undefined {
	if (npmInstallRoot(packageDir, packageName)) {
		// pi skips an exact npm version when it updates packages and moves anything else, so the
		// answer has to keep whichever of the two the install was. Pinning a bare install here would
		// make this upgrade the last one `pi update` ever does. The moving answer is `@latest`, not the
		// bare name: `npm install <name>` over an existing install keeps the range it saved and changes
		// nothing, while `@latest` is what pi's own update asks npm for and is not a pin to pi. Not
		// knowing how it was installed keeps the exact pin: it is the reading that cannot move a
		// package somewhere it was not asked to go.
		const configured = configuredSource === undefined ? undefined : npmSourceVersion(configuredSource, packageName);
		if (configured !== undefined && !isExactNpmVersion(configured)) return `npm:${packageName}@latest`;
		// Release tags are `v0.17.0`; the version npm knows the same release by is `0.17.0`.
		return `npm:${packageName}@${tag.replace(/^v/, "")}`;
	}
	const rel = path.relative(path.join(agentDir, "git"), path.resolve(packageDir));
	const parts = rel.split(path.sep);
	// Exactly host/owner/repo under that root: deeper or shallower is not a package pi installed,
	// and a checkout that merely happens to live under some other directory called `git` is not one
	// either — being wrong here is what produces the second copy.
	if (rel && !rel.startsWith("..") && parts.length === 3) return `git:${parts.join("/")}@${tag}`;
	return undefined;
}

/** The directory `npm install` ran in (the one holding `node_modules`), if this copy is an npm install. */
function npmInstallRoot(packageDir: string, packageName: string): string | undefined {
	const segments = path.resolve(packageDir).split(path.sep).filter(Boolean);
	// A scoped name is two segments on disk, so compare as many as the name has.
	const name = packageName.split("/").filter(Boolean);
	if (!name.length || segments.slice(-name.length).join("/") !== name.join("/") || segments[segments.length - name.length - 1] !== "node_modules") return undefined;
	return path.join(path.parse(path.resolve(packageDir)).root, ...segments.slice(0, -name.length - 1));
}

/**
 * The version an `npm:` source gives `packageName` — `""` for none — or undefined if it names some
 * other package. The name is known, so this compares a prefix rather than parsing a spec: a project's
 * `.pi/settings.json` can come from a cloned repository, and a general spec regex backtracks
 * quadratically on an entry built for it.
 */
function npmSourceVersion(source: string, packageName: string): string | undefined {
	const spec = source.trim().replace(/^npm:/, "").trim();
	if (!spec.startsWith(packageName)) return undefined;
	const rest = spec.slice(packageName.length);
	if (rest === "") return "";
	return rest.startsWith("@") ? rest.slice(1) : undefined;
}

/** What pi counts as pinned: a valid semver, which it also accepts with a leading `v`. */
function isExactNpmVersion(version: string): boolean {
	return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

/**
 * The `npm:` source this install is recorded under, as written. pi keeps a user install in
 * `<agent dir>/npm` and records it in `<agent dir>/settings.json`, and a project one in `.pi/npm`
 * recorded in `.pi/settings.json` — in both, the settings file sits beside the install root.
 */
export function configuredNpmSource(packageDir: string, packageName: string): string | undefined {
	const root = npmInstallRoot(packageDir, packageName);
	if (!root) return undefined;
	let packages: unknown;
	try {
		packages = JSON.parse(fs.readFileSync(path.join(path.dirname(root), "settings.json"), "utf8"))?.packages;
	} catch {
		// Missing (an older pi's global install has no settings beside it) or unreadable: not knowing
		// how this was installed is an answer `upgradeSpec` handles, not a reason to fail an upgrade.
		return undefined;
	}
	if (!Array.isArray(packages)) return undefined;
	for (const entry of packages) {
		const source = typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : undefined;
		if (source?.trim().startsWith("npm:") && npmSourceVersion(source, packageName) !== undefined) return source;
	}
	return undefined;
}

/** What to tell someone whose copy is a checkout: there is nothing for `pi install` to do. */
function checkoutUpgradeHint(): string {
	return `git pull in ${packageRoot()}, then restart pi`;
}

/**
 * Find the newest release and install it. `pi update --extensions` deliberately does not do this —
 * it reconciles a git package to the ref you pinned — so taking a release otherwise means looking
 * up a tag by hand and retyping it, which is a thing a command should do for you.
 */
async function upgrade(checkOnly: boolean, out: (line: string) => void): Promise<number> {
	const { name, repositoryUrl: repo } = manifest();
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
	const spec = upgradeSpec(packageRoot(), name ?? "", getAgentDir(), latest, configuredNpmSource(packageRoot(), name ?? ""));
	if (!spec) {
		// Nothing failed, so this is not an error: the newest release is out and the way to it is a
		// pull, not an install that would leave a second copy beside the checkout.
		out("this copy is a checkout, not something pi installed");
		out(`upgrade it with: ${checkoutUpgradeHint()}`);
		return 0;
	}
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
 * Where the launcher goes: `--dir` if given, otherwise the first of ~/.local/bin and /usr/local/bin
 * that is on PATH. One function, because the question asked before writing and the write itself
 * have to name the same directory.
 */
export function launcherTarget(dir: string | undefined, pathEnv: string = process.env.PATH ?? ""): string | undefined {
	if (dir) return path.resolve(dir);
	return [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin"].find((d) => isOnPath(d, pathEnv));
}

function isOnPath(dir: string, pathEnv: string = process.env.PATH ?? ""): boolean {
	return pathEnv.split(path.delimiter).filter(Boolean).some((p) => path.resolve(p) === path.resolve(dir));
}

/**
 * `/pi-loops install-launcher [--dir <dir>]`: the command line's `install-launcher`, asked first,
 * because inside pi it is a click away from replacing a launcher you already have. The question
 * names the directory that will be written and nothing else. Resolves undefined when the answer
 * is no; with nowhere to write there is nothing to ask, and the refusal says why.
 */
export async function installLauncherWithConfirm(args: string[], confirm: (title: string, body: string) => Promise<boolean>, out: (line: string) => void): Promise<number | undefined> {
	const flag = parseCliArgs(["install-launcher", ...args]).flags.get("dir");
	// No shell has expanded `~` on the way here, so it is expanded now or becomes a directory named `~`.
	const dir = typeof flag === "string" ? flag.replace(/^~(?=$|\/)/, os.homedir()) : undefined;
	const target = launcherTarget(dir);
	if (!target) return installLauncher(undefined, out);
	const reach = isOnPath(target) ? ["Afterwards `pi-loops` starts a session from any directory."] : [`${target} is not on your PATH, so \`pi-loops\` will not be found until it is.`];
	const ok = await confirm("Put `pi-loops` on your PATH?", [`This writes a launcher into ${target}.`, "", "It is a two-line shell script that runs this package with this node.", ...reach].join("\n"));
	if (!ok) return undefined;
	// The absolute directory the question named, not the flag again: resolving a relative --dir a
	// second time, after the dialog, would follow a working directory that may have moved meanwhile.
	return installLauncher(target, out);
}

/**
 * `pi install` puts this package under pi's managed directory rather than on your PATH, so the
 * command that is supposed to start your sessions is reachable only by absolute path. This writes
 * a two-line launcher into a directory that is already on your PATH, which is the smallest thing
 * that fixes it without asking you to publish or install anything else.
 */
export async function installLauncher(dir: string | undefined, out: (line: string) => void): Promise<number> {
	const target = launcherTarget(dir);
	if (!target) {
		out("no directory to install into: neither ~/.local/bin nor /usr/local/bin is on your PATH.");
		out("pass one with --dir <dir>, or add ~/.local/bin to PATH and run this again.");
		return 1;
	}
	if (dir && !isOnPath(target)) out(`note: ${target} is not on your PATH, so the command will not be found there yet`);
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
	const withDefaults = applyRememberedModel(pi, readUiPrefs(loopsDir(ours)));
	if (mode === "terminal") return runChild(process.env.PI_BIN || "pi", withDefaults);
	const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "web.mjs");
	return runChild(process.execPath, [web, ...ours.filter((a) => a !== "--web" && a !== "--tui"), ...(withDefaults.length ? ["--", ...withDefaults] : [])]);
}

/**
 * Where the data lives for this run: the flag, then the environment, then the default — the default
 * being the extension's own (`loops` under pi's agent directory, which `PI_CODING_AGENT_DIR` moves),
 * so the window reads what the session behind it writes.
 */
export function loopsDir(ours: string[]): string {
	const at = ours.indexOf("--loops-dir");
	if (at !== -1 && ours[at + 1]) return ours[at + 1];
	const eq = ours.find((a) => a.startsWith("--loops-dir="));
	if (eq) return eq.slice("--loops-dir=".length);
	return process.env.PI_LOOPS_DIR || defaultLoopsDir(getAgentDir());
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
