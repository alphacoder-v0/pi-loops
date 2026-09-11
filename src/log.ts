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
import { redact } from "./redact.ts";
import { stamp } from "./schedule.ts";

const MAX_BYTES = 2_000_000;

export type LogLevel = "info" | "warn" | "error";

export class LoopsLog {
	readonly file: string;
	private failed = false;

	constructor(dir: string, name: string) {
		this.file = path.join(dir, "logs", name);
	}

	write(level: LogLevel, message: string): void {
		if (this.failed) return; // a log that cannot be written must never become the loudest problem
		const line = `${stamp()} ${level.padEnd(5)} ${redact(message)}\n`;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.appendFileSync(this.file, line);
			this.rotate();
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

	private rotate(): void {
		try {
			if (fs.statSync(this.file).size < MAX_BYTES) return;
			const lines = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean);
			fs.writeFileSync(this.file, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`);
		} catch {
			/* best effort */
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
