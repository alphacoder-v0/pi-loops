/**
 * `pi-loops export|import` — pie's `pie session export|import` as a command line.
 *
 * An archive is a backup and migration format, and a backup you can only drive by hand from inside
 * a running TUI cannot be put in a cron entry, a CI step, or run on a fresh machine before opening
 * anything. This dispatches before any pi session exists, exactly as pie does (`main.rs:224-226`).
 *
 *   pi-loops export [--session <id>] [--cwd <dir>] [--output <file>] [--exclude-triggers]
 *   pi-loops import <file> [--cwd <dir>] [--activate-triggers=off|ask|on]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { exportSession, defaultExportPath, importSession, inspectArchive } from "./archive.ts";
import { askHost, renderHostSnapshot } from "./host-control-channel.ts";
import { liveHost, stopHost } from "./host-control.ts";
import { JobStore, defaultLoopsDir } from "./store.ts";
import { TriggerStore } from "./triggers.ts";
import { PI_LOOPS_VERSION } from "./version.ts";

export const CLI_USAGE = [
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

/** pie accepts a full id or a unique prefix; with neither, the newest session of `cwd`. */
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

export async function runCli(argv: string[], out: (line: string) => void = console.log): Promise<number> {
	const { command, positional, flags } = parseCliArgs(argv);
	const str = (name: string): string | undefined => {
		const v = flags.get(name);
		return typeof v === "string" ? v : undefined;
	};
	const agentDir = getAgentDir();
	const loopsDir = process.env.PI_LOOPS_DIR || defaultLoopsDir(agentDir);
	const cwd = path.resolve(str("cwd") ?? process.cwd());

	if (command === "sessions") {
		// `pickSession` refuses an unknown id, and there was no way to discover one.
		const sessions = listSessions(path.join(agentDir, "sessions"));
		const here = flags.has("all") ? sessions : sessions.filter((s) => s.cwd === cwd);
		if (!here.length) {
			out(flags.has("all") ? "no sessions recorded" : `no sessions recorded for ${cwd} (use --all)`);
			return 1;
		}
		for (const s of here.slice(0, Number(str("limit") ?? 20))) out(`${s.id}  ${new Date(s.mtimeMs).toISOString()}  ${s.cwd}`);
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

	out(CLI_USAGE);
	return command && command !== "help" && command !== "--help" ? 2 : 0;
}
