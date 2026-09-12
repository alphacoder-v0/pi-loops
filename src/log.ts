/**
 * A file every process writes its diagnostics to.
 *
 * Everything except the headless host went to `ctx.ui.notify`, which is not written to the
 * session file — so `/new`, `/resume` or a crash erased every warning the automation had produced.
 * A loop that failed at 03:00 left nothing behind to read at 09:00.
 *
 * Rotated in place past `MAX_BYTES`, like the run log and the audit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pidAlive } from "./lock.ts";
import { capRedacted } from "./redact.ts";
import { stamp } from "./schedule.ts";

export const MAX_LOG_BYTES = 2_000_000;

/**
 * What one log line may say, in characters — the same bound `hooks.ts` puts on a hook's captured
 * output, for the same reason: the text usually comes from something else's stdout, and a diagnostic
 * nobody bounded is how a 2 MB log becomes one line.
 */
export const MAX_LOG_LINE_CHARS = 4000;

/**
 * Halve a log file in place once it passes `maxBytes`. One home for "rotated at 2 MB": the headless
 * host writes its own file (its stdout and stderr go there too, so an MCP server's chatter lands in
 * it) and used to carry a second copy of this, free to drift from the rule every other log follows.
 */
export function rotateInPlace(file: string, maxBytes: number = MAX_LOG_BYTES): void {
	try {
		if (fs.statSync(file).size < maxBytes) return;
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		const keep = Math.floor(lines.length / 2);
		// One line can be over the limit on its own, and `slice(-0)` is the whole array — so without
		// this the file would be rewritten identical forever, and every later write would pay a full
		// read and write of it. The same guard the run log and the inbox carry.
		fs.writeFileSync(file, keep === 0 ? "" : `${lines.slice(-keep).join("\n")}\n`);
	} catch {
		/* best effort */
	}
}

export type LogLevel = "info" | "warn" | "error";

export class LoopsLog {
	readonly file: string;
	private failed = false;

	constructor(dir: string, name: string) {
		this.file = path.join(dir, "logs", name);
	}

	write(level: LogLevel, message: string): void {
		if (this.failed) return; // a log that cannot be written must never become the loudest problem
		const line = `${stamp()} ${level.padEnd(5)} ${capRedacted(message, MAX_LOG_LINE_CHARS)}\n`;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.appendFileSync(this.file, line);
			rotateInPlace(this.file);
		} catch {
			this.failed = true;
		}
	}

	info(message: string): void {
		this.write("info", message);
	}
	warn(message: string): void {
		this.write("warn", message);
	}
	error(message: string): void {
		this.write("error", message);
	}

	/** The last `n` lines, for `/cron scheduler` and a future bug report. */
	tail(n = 40): string[] {
		try {
			return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-n);
		} catch {
			return [];
		}
	}

}

/**
 * Old per-process logs are not interesting once their process is gone; keep the newest few. A log
 * whose pid is still running is never deleted, however old it looks: a headless host can sit idle
 * for days while newer sessions come and go, and its log is the one a user goes looking for.
 */
export function pruneLogs(dir: string, keep = 5): void {
	const logsDir = path.join(dir, "logs");
	try {
		const files = fs
			.readdirSync(logsDir)
			.filter((f) => f.startsWith("pi-") && f.endsWith(".log"))
			.map((f) => ({ f, mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		for (const { f } of files.slice(keep)) {
			const pid = Number(f.slice(3, -4));
			if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) continue;
			fs.rmSync(path.join(logsDir, f), { force: true });
		}
	} catch {
		/* nothing to prune */
	}
}
