import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRemoteTty, openFileTarget, openUrl, openerFor } from "../src/browser-open.ts";
import { tmp } from "./tmp.ts";

/** The fake openers run with a PATH of their own, so they name `sleep` in full. */
const SLEEP = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();

const URL_WITH_AMP = "http://127.0.0.1:4173/c/s/?a=1&b=2";
const linux = { platform: "linux" as const, release: "6.8.0-45-generic" };
const wsl = { platform: "linux" as const, release: "6.18.54.1-microsoft-standard-WSL2" };

test("macOS opens with open, Windows with rundll32, as pi does", () => {
	assert.deepEqual(openerFor({ platform: "darwin", release: "24.0.0", env: {}, target: URL_WITH_AMP }), [{ cmd: "open", args: [URL_WITH_AMP], okExit: [0], waitMs: 1_500 }]);
	assert.deepEqual(openerFor({ platform: "win32", release: "10.0.26100", env: {}, target: URL_WITH_AMP }), [
		{ cmd: "rundll32", args: ["url.dll,FileProtocolHandler", URL_WITH_AMP], okExit: [0], waitMs: 1_500 },
	]);
});

test("WSL tries rundll32.exe from /mnt/c, then cmd.exe with & escaped, and never wslview", () => {
	const rundll = { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", URL_WITH_AMP], cwd: "/mnt/c", okExit: [0], waitMs: 1_500 };
	const cmd = { cmd: "cmd.exe", args: ["/c", "start", "", "http://127.0.0.1:4173/c/s/?a=1^&b=2"], cwd: "/mnt/c", okExit: [0], waitMs: 1_500 };
	assert.deepEqual(openerFor({ ...wsl, env: { WSL_DISTRO_NAME: "Ubuntu" }, target: URL_WITH_AMP }), [rundll, cmd]);
	assert.deepEqual(openerFor({ ...wsl, env: {}, target: URL_WITH_AMP }), [rundll, cmd], "release names microsoft");
	assert.deepEqual(openerFor({ ...linux, env: { WSL_DISTRO_NAME: "Ubuntu" }, target: URL_WITH_AMP }), [rundll, cmd], "WSL_DISTRO_NAME alone is WSL");
	const odd = openerFor({ ...wsl, env: { WSL_DISTRO_NAME: "U" }, target: "file://wsl.localhost/U/home/a^b|c&d/x.html" });
	assert.deepEqual(Array.isArray(odd) && odd.at(-1)!.args.at(-1), "file://wsl.localhost/U/home/a^^b^|c^&d/x.html", "cmd.exe reads ^ and | as well as &");
	assert.deepEqual(Array.isArray(odd) && odd[0].args.at(-1), "file://wsl.localhost/U/home/a^b|c&d/x.html", "rundll32.exe is given the address as it is");
});

test("other Linux opens with xdg-open only when there is a display", () => {
	assert.equal(openerFor({ ...linux, env: {}, target: URL_WITH_AMP }), "no-display");
	assert.deepEqual(openerFor({ ...linux, env: { DISPLAY: ":0" }, target: URL_WITH_AMP }), [{ cmd: "xdg-open", args: [URL_WITH_AMP], okExit: [0], waitMs: 10_000 }]);
	assert.deepEqual(openerFor({ ...linux, env: { WAYLAND_DISPLAY: "wayland-0" }, target: URL_WITH_AMP }), [{ cmd: "xdg-open", args: [URL_WITH_AMP], okExit: [0], waitMs: 10_000 }]);
});

test("over ssh or mosh nothing is opened, on any platform", () => {
	for (const k of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "MOSH_CONNECTION"]) {
		assert.equal(isRemoteTty({ [k]: "x" }), true, k);
		for (const base of [linux, wsl, { platform: "darwin" as const, release: "24" }])
			assert.equal(openerFor({ ...base, env: { [k]: "x", DISPLAY: ":0" }, target: URL_WITH_AMP }), "remote", `${k} on ${base.platform}`);
	}
	assert.equal(isRemoteTty({}), false);
});

test("a Windows browser reaches the launch file through wsl.localhost; elsewhere it is a plain file URL", () => {
	const file = "/home/me/.pi/agent/loops/pages/open/0123abcd.html";
	assert.equal(openFileTarget(file, { ...linux, env: {} }), "file:///home/me/.pi/agent/loops/pages/open/0123abcd.html");
	assert.equal(openFileTarget(file, { ...wsl, env: { WSL_DISTRO_NAME: "Ubuntu 24.04" } }), "file://wsl.localhost/Ubuntu%2024.04/home/me/.pi/agent/loops/pages/open/0123abcd.html");
	assert.equal(openFileTarget(file, { ...wsl, env: {} }), undefined, "no distro name: no address a Windows browser can read");
	for (const c of ["|", '"', ":", "*", "?", "<", ">", "\\"])
		assert.equal(openFileTarget(`/home/me/a${c}b/pages/open/0123abcd.html`, { ...wsl, env: { WSL_DISTRO_NAME: "U" } }), undefined, `a Windows browser cannot read a name holding ${c}`);
	assert.equal(openFileTarget("/home/me/a|b/pages/open/0123abcd.html", { ...linux, env: {} }), "file:///home/me/a%7Cb/pages/open/0123abcd.html", "a Linux browser can");
	for (const t of [openFileTarget(file, { ...linux, env: {} }), openFileTarget(file, { ...wsl, env: { WSL_DISTRO_NAME: "U" } })]) assert.doesNotMatch(t!, /open=/);
});

/** A PATH holding one fake `xdg-open` per behaviour, so `openUrl` runs the real spawn. */
function fakeOpener(script: string): NodeJS.ProcessEnv {
	const dir = tmp("pi-loops-opener-");
	fs.writeFileSync(path.join(dir, "xdg-open"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	return { PATH: dir, DISPLAY: ":0" };
}

test("opened means the opener exited with a success code or is still running; a failure exit or no opener is not opened", async () => {
	const run = (env: NodeJS.ProcessEnv) => openUrl(URL_WITH_AMP, { ...linux, env }, 300);
	assert.equal(await run(fakeOpener("exit 0")), true, "exit 0");
	assert.equal(await run(fakeOpener("exit 3")), false, "xdg-open's exit 3: no browser found");
	assert.equal(await run(fakeOpener(`exec ${SLEEP} 5`)), true, "still running after the wait");
	assert.equal(await run({ PATH: tmp("pi-loops-empty-"), DISPLAY: ":0" }), false, "no opener on PATH");
	assert.equal(await run({ PATH: tmp("pi-loops-empty-") }), false, "no display");
});

test("xdg-open that finds no browser after five seconds is not opened: it has ten", async () => {
	const started = Date.now();
	assert.equal(await openUrl(URL_WITH_AMP, { ...linux, env: fakeOpener(`${SLEEP} 5; exit 3`) }), false);
	assert.ok(Date.now() - started >= 5_000, "it waited for the exit");
});

// rundll32.exe and cmd.exe run from /mnt/c, which only a WSL machine has.
test("on WSL rundll32.exe gets the wsl.localhost address, and a failed one moves on to cmd.exe", { skip: !fs.existsSync("/mnt/c") && "no /mnt/c here" }, async () => {
	const dir = tmp("pi-loops-opener-");
	const log = path.join(dir, "log");
	const write = (name: string, code: number) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit ${code}\n`, { mode: 0o755 });
	write("wslview", 0);
	write("explorer.exe", 1);
	write("rundll32.exe", 2);
	write("cmd.exe", 0);
	const target = openFileTarget("/home/me/.pi/agent/loops/pages/open/0123abcd.html", { ...wsl, env: { WSL_DISTRO_NAME: "U" } })!;
	assert.equal(await openUrl(target, { ...wsl, env: { PATH: dir, WSL_DISTRO_NAME: "U" } }, 1000), true, "cmd.exe exit 0");
	assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
		"rundll32.exe url.dll,FileProtocolHandler file://wsl.localhost/U/home/me/.pi/agent/loops/pages/open/0123abcd.html",
		"cmd.exe /c start  file://wsl.localhost/U/home/me/.pi/agent/loops/pages/open/0123abcd.html",
	]);
});
