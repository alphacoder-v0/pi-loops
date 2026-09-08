/**
 * Small cross-process primitives: a mkdir-based file lock, atomic writes,
 * and pid liveness. No native deps, works on any POSIX fs (and NTFS).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LockOptions {
	/** A lock older than this is considered abandoned and is broken. */
	staleMs?: number;
	/** Give up after this long. */
	timeoutMs?: number;
}

/** Run `fn` while holding `<lockPath>` (a directory created with mkdir, which is atomic). */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
	const staleMs = opts.staleMs ?? 10_000;
	const timeoutMs = opts.timeoutMs ?? 5_000;
	const deadline = Date.now() + timeoutMs;
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	for (;;) {
		try {
			fs.mkdirSync(lockPath);
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			try {
				const age = Date.now() - fs.statSync(lockPath).mtimeMs;
				if (age > staleMs) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue; // vanished between EEXIST and stat
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
			await sleep(20 + Math.floor(Math.random() * 30));
		}
	}
	try {
		return await fn();
	} finally {
		fs.rmSync(lockPath, { recursive: true, force: true });
	}
}

/** Write via temp file + rename so readers never see a torn file. */
export function writeFileAtomic(file: string, data: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
	fs.writeFileSync(tmp, data, "utf8");
	fs.renameSync(tmp, file);
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}
