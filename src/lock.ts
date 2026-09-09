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

/**
 * Synchronous sibling of `withFileLock`, for the append paths that must stay synchronous
 * (`Inbox.append` is called from hook callbacks that cannot await). The critical section is a
 * single `appendFileSync`, so the spin never lasts more than a few milliseconds.
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
	const staleMs = opts.staleMs ?? 10_000;
	// Longer than `staleMs` on purpose: a lock left by a process killed between mkdir and rm can
	// only be broken after it goes stale, and a shorter deadline would spin and then throw instead.
	const deadline = Date.now() + (opts.timeoutMs ?? staleMs + 5_000);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const spin = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			fs.mkdirSync(lockPath);
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			// The deadline is checked on every path: a lock directory we can neither stat nor remove
			// (EACCES, or a Windows EPERM) must not turn into an event-loop-blocking hot spin.
			if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
			try {
				if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				/* vanished, or unreadable: wait and try again */
			}
			Atomics.wait(spin, 0, 0, 5 + Math.floor(Math.random() * 10));
		}
	}
	try {
		return fn();
	} finally {
		try {
			fs.rmSync(lockPath, { recursive: true, force: true });
		} catch {
			/* the stale window will break it */
		}
	}
}

/** Run `fn` while holding `<lockPath>` (a directory created with mkdir, which is atomic). */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
	const staleMs = opts.staleMs ?? 10_000;
	// Longer than `staleMs`, for the same reason as the synchronous sibling: a lock left behind by
	// a killed process can only be broken once it goes stale, and a shorter deadline would give up
	// just before that moment and throw instead.
	const timeoutMs = opts.timeoutMs ?? staleMs + 5_000;
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
	// fsync before the rename: without it a crash can leave the rename applied and the data not,
	// i.e. an empty file where the store used to be. The directory is synced too so the rename
	// itself survives. Both are best-effort — a filesystem that refuses them is not a reason to fail.
	let fd: number | undefined;
	try {
		fd = fs.openSync(tmp, "w");
		fs.writeFileSync(fd, data, "utf8");
		try {
			fs.fsyncSync(fd);
		} catch {
			/* not supported here */
		}
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	fs.renameSync(tmp, file);
	try {
		const dir = fs.openSync(path.dirname(file), "r");
		try {
			fs.fsyncSync(dir);
		} finally {
			fs.closeSync(dir);
		}
	} catch {
		/* directory fsync is not portable; the file fsync above is the important half */
	}
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
