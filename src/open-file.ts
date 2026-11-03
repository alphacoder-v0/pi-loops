/**
 * The file `pi-loops` opens the browser on. A one-shot open key in a URL on the opener's command
 * line is readable by every user on the machine (`/proc/<pid>/cmdline`), and whoever loads it first
 * gets the page with the token. So the key goes into a file only this user can read, the browser is
 * opened on that file's path, and the file sends it on to the keyed address. The background process
 * writes the file, because it is the one that sees the key spent: it removes the file then, or after
 * a minute, whichever comes first, and removes any left over when it starts.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Where the files are: a directory of their own, mode 0700, under `pages/`. */
export function openFileDir(loopsDir: string): string {
	return path.join(loopsDir, "pages", "open");
}

/** The page that sends a browser on to `url`, with nothing else in it. */
export function openFileHtml(url: string): string {
	// One navigation, never two: the key opens one load, so a refresh racing the script would meet
	// a spent key. The refresh is for a browser that runs no script.
	const attr = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	// JSON.stringify leaves "</script>" alone; escaping "<" keeps the address from ending the script.
	const js = JSON.stringify(url).replace(/</g, "\\u003c");
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<noscript><meta http-equiv="refresh" content="0;url=${attr}"></noscript>
<title>pi-loops</title></head>
<body><script>location.replace(${js})</script><a href="${attr}">Open pi-loops</a></body></html>
`;
}

/** Write a file that sends the browser to `url`, mode 0600 in a 0700 directory, and answer its path. */
export function writeOpenFile(loopsDir: string, url: string): string {
	const dir = openFileDir(loopsDir);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdir leaves an existing directory's mode as it was.
	fs.chmodSync(dir, 0o700);
	const file = path.join(dir, `${randomBytes(16).toString("hex")}.html`);
	// `wx`: a name that exists is not ours to write into.
	fs.writeFileSync(file, openFileHtml(url), { mode: 0o600, flag: "wx" });
	return file;
}

/** Remove one file; one already gone is what was wanted. */
export function removeOpenFile(file: string): void {
	fs.rmSync(file, { force: true });
}

/** Remove every file a process before this one left: their keys died with it. */
export function sweepOpenFiles(loopsDir: string): void {
	fs.rmSync(openFileDir(loopsDir), { recursive: true, force: true });
}
