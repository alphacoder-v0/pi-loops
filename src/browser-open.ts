/**
 * Which command opens a browser here, and whether one did. The table copies pi's own opener (macOS
 * `open`, Windows `rundll32`) and adds the WSL branch pi lacks: there `xdg-open` finds no browser and
 * exits 3 after five seconds, so the Windows side is asked directly, with pi's Windows opener. "Opened" comes from the exit
 * code, never from the spawn alone: a terminal that says it opened a browser when nothing opened
 * leaves a person waiting for a window that never comes.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import { pathToFileURL } from "node:url";

/**
 * One command to try: what to run, from where, which exit codes mean the browser got it, and how
 * long it may run before still running counts as opened.
 */
export type Opener = { cmd: string; args: string[]; cwd?: string; okExit: number[]; waitMs: number };

/** For an opener that exits as soon as it has handed the address on. */
const QUICK_MS = 1_500;
/** xdg-open that finds no browser exits 3 after about five seconds. */
const XDG_OPEN_MS = 10_000;

/** What the choice depends on, passed in so a test can be any machine. */
export type OpenEnv = { platform: NodeJS.Platform; release: string; env: NodeJS.ProcessEnv };

/** ssh and mosh set at least one of these; opening a browser on the far end helps nobody. */
export function isRemoteTty(env: NodeJS.ProcessEnv = process.env): boolean {
	return ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "MOSH_CONNECTION"].some((k) => !!env[k]);
}

function isWsl(e: Pick<OpenEnv, "platform" | "release" | "env">): boolean {
	return e.platform === "linux" && (!!e.env.WSL_DISTRO_NAME || /microsoft/i.test(e.release));
}

/** The commands to try in order, or why none is tried. */
export function openerFor(e: OpenEnv & { target: string }): Opener[] | "no-display" | "remote" {
	if (isRemoteTty(e.env)) return "remote";
	const t = e.target;
	if (e.platform === "darwin") return [{ cmd: "open", args: [t], okExit: [0], waitMs: QUICK_MS }];
	// No shell: cmd would read `&` in the address as the end of the command.
	if (e.platform === "win32") return [{ cmd: "rundll32", args: ["url.dll,FileProtocolHandler", t], okExit: [0], waitMs: QUICK_MS }];
	// Both start from a Windows drive: a long \\wsl.localhost cwd breaks them. Not wslview: wslu 3.2.3
	// reads a wsl.localhost address as a relative Linux path and exits 0 without opening anything. Not
	// explorer.exe: it exits 1 whether or not anything opened. rundll32 exits 0 even for a missing
	// file, so cmd.exe is reached only when rundll32.exe cannot start.
	if (isWsl(e))
		return [
			{ cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", t], cwd: "/mnt/c", okExit: [0], waitMs: QUICK_MS },
			// cmd re-reads its line: `^` escapes the characters it would act on.
			{ cmd: "cmd.exe", args: ["/c", "start", "", t.replace(/[\^&|]/g, "^$&")], cwd: "/mnt/c", okExit: [0], waitMs: QUICK_MS },
		];
	if (!e.env.DISPLAY && !e.env.WAYLAND_DISPLAY) return "no-display";
	return [{ cmd: "xdg-open", args: [t], okExit: [0], waitMs: XDG_OPEN_MS }];
}

/**
 * The address the opener is given for the launch file, which holds the one-use key so no argv does.
 * On WSL the browser is a Windows one, which reads the file through `\\wsl.localhost`: measured on
 * WSL 2 with rundll32 and `cmd.exe /c start`, each loads the file and follows it to the page.
 * Undefined on WSL without `WSL_DISTRO_NAME`, which that address needs, and for a path holding a
 * character Windows does not allow in a name: `\\wsl.localhost` shows those under other names, so
 * the browser cannot find the file while rundll32 still exits 0.
 */
export function openFileTarget(file: string, e: Pick<OpenEnv, "platform" | "release" | "env">): string | undefined {
	const href = pathToFileURL(file).href;
	if (!isWsl(e)) return href;
	const distro = e.env.WSL_DISTRO_NAME;
	return distro && !/[\\:*?"<>|]/.test(file) ? `file://wsl.localhost/${encodeURIComponent(distro)}${href.slice("file://".length)}` : undefined;
}

/** This machine, as `openerFor` reads it. */
export function thisMachine(): OpenEnv {
	return { platform: process.platform, release: os.release(), env: process.env };
}

/**
 * Hand `target` to each opener in turn until one takes it: true when one exits with a code it
 * counts as success, or is still running at its own deadline, which is how a browser started
 * straight from the opener looks. `waitMs` replaces every deadline, for a test.
 */
export async function openUrl(target: string, e: OpenEnv = thisMachine(), waitMs?: number): Promise<boolean> {
	const openers = openerFor({ ...e, target });
	if (typeof openers === "string") return false;
	for (const opener of openers) if (await tryOpener(opener, e.env, waitMs ?? opener.waitMs)) return true;
	return false;
}

function tryOpener(o: Opener, env: NodeJS.ProcessEnv, waitMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(o.cmd, o.args, { stdio: "ignore", detached: true, cwd: o.cwd, env });
		} catch {
			resolve(false); // the next opener, or the printed link
			return;
		}
		const timer = setTimeout(() => {
			child.unref();
			resolve(true);
		}, waitMs);
		child.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code !== null && o.okExit.includes(code));
		});
	});
}

/** One command that copies its stdin to the clipboard and exits 0 when it has. */
export type CopyCommand = { cmd: string; args: string[]; cwd?: string };

/**
 * The clipboard commands to try in order, the ones pi's `copyToClipboard` runs. Not OSC 52, which
 * pi also writes and which no terminal confirms: tmux in Windows Terminal drops it, so a terminal
 * that said "copied" after it could be wrong. None over ssh or mosh, where this machine's clipboard
 * is not the one in front of you.
 */
export function copyCommandsFor(e: OpenEnv): CopyCommand[] {
	if (isRemoteTty(e.env)) return [];
	if (e.platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
	if (e.platform === "win32") return [{ cmd: "clip", args: [] }];
	if (e.platform !== "linux") return [];
	// The link is ASCII, so clip.exe reading it in the console code page changes nothing.
	const windows = isWsl(e) ? [{ cmd: "clip.exe", args: [], cwd: "/mnt/c" }] : [];
	return [
		...windows,
		...(e.env.WAYLAND_DISPLAY ? [{ cmd: "wl-copy", args: [] }] : []),
		...(e.env.DISPLAY ? [{ cmd: "xclip", args: ["-selection", "clipboard"] }, { cmd: "xsel", args: ["--clipboard", "--input"] }] : []),
	];
}

/** Copy `text` with the first command that takes it: true only when one exited 0. */
export async function copyText(text: string, e: OpenEnv = thisMachine()): Promise<boolean> {
	for (const c of copyCommandsFor(e)) if (await runCopy(c, text, e.env)) return true;
	return false;
}

const COPY_WAIT_MS = 5_000;

function runCopy(c: CopyCommand, text: string, env: NodeJS.ProcessEnv): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			// xclip and xsel stay behind to own the selection; "exit" is the command that answered.
			child = spawn(c.cmd, c.args, { stdio: ["pipe", "ignore", "ignore"], cwd: c.cwd, env });
		} catch {
			resolve(false); // the next command
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			resolve(false);
		}, COPY_WAIT_MS);
		child.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
		child.stdin?.once("error", () => {}); // EPIPE from a command that exited first: its exit code decides
		child.stdin?.end(text);
	});
}
