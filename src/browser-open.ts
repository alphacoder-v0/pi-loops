/**
 * Which command opens a browser here, and whether one did. The table copies pi's own opener (macOS
 * `open`, Windows `rundll32`) and adds the WSL branch pi lacks: there `xdg-open` finds no browser and
 * exits 3 after five seconds, so the Windows side is asked directly. "Opened" comes from the exit
 * code, never from the spawn alone: a terminal that says it opened a browser when nothing opened
 * leaves a person waiting for a window that never comes.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** One command to try: what to run, from where, and which exit codes mean the browser got it. */
export type Opener = { cmd: string; args: string[]; cwd?: string; okExit: number[] };

/** What the choice depends on, passed in so a test can be any machine. */
export type OpenEnv = { platform: NodeJS.Platform; release: string; env: NodeJS.ProcessEnv; onPath: (cmd: string) => boolean };

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
	if (e.platform === "darwin") return [{ cmd: "open", args: [t], okExit: [0] }];
	// No shell: cmd would read `&` in the address as the end of the command.
	if (e.platform === "win32") return [{ cmd: "rundll32", args: ["url.dll,FileProtocolHandler", t], okExit: [0] }];
	if (isWsl(e))
		return [
			...(e.onPath("wslview") ? [{ cmd: "wslview", args: [t], okExit: [0] }] : []),
			// explorer.exe exits 1 when it has handed the address on. A long \\wsl.localhost cwd
			// breaks it, so it starts from a Windows drive.
			{ cmd: "explorer.exe", args: [t], cwd: "/mnt/c", okExit: [0, 1] },
			{ cmd: "cmd.exe", args: ["/c", "start", "", t.replace(/&/g, "^&")], cwd: "/mnt/c", okExit: [0] },
		];
	if (!e.env.DISPLAY && !e.env.WAYLAND_DISPLAY) return "no-display";
	return [{ cmd: "xdg-open", args: [t], okExit: [0] }];
}

/**
 * The address the opener is given for the launch file, which holds the one-use key so no argv does.
 * On WSL the browser is a Windows one, which reads the file through `\\wsl.localhost`: measured on
 * WSL 2 with explorer.exe, rundll32 and `cmd.exe /c start`, each loads the file and follows it to the
 * page. Undefined on WSL without `WSL_DISTRO_NAME`, which that address needs.
 */
export function openFileTarget(file: string, e: Pick<OpenEnv, "platform" | "release" | "env">): string | undefined {
	const href = pathToFileURL(file).href;
	if (!isWsl(e)) return href;
	const distro = e.env.WSL_DISTRO_NAME;
	return distro ? `file://wsl.localhost/${encodeURIComponent(distro)}${href.slice("file://".length)}` : undefined;
}

/** This machine, as `openerFor` reads it. */
export function thisMachine(): OpenEnv {
	return { platform: process.platform, release: os.release(), env: process.env, onPath: (cmd) => onPath(cmd, process.env.PATH) };
}

function onPath(cmd: string, pathEnv: string | undefined): boolean {
	return (pathEnv ?? "").split(path.delimiter).some((dir) => {
		if (!dir) return false;
		try {
			fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
			return true;
		} catch {
			return false; // not in this directory
		}
	});
}

/**
 * Hand `target` to each opener in turn until one takes it: true when one exits with a code it
 * counts as success, or is still running after `waitMs`, which is how a browser started straight
 * from the opener looks.
 */
export async function openUrl(target: string, e: OpenEnv = thisMachine(), waitMs = 1_500): Promise<boolean> {
	const openers = openerFor({ ...e, target });
	if (typeof openers === "string") return false;
	for (const opener of openers) if (await tryOpener(opener, e.env, waitMs)) return true;
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
