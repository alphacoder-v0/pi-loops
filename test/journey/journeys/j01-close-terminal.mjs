import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J1", title = "Close the terminal that started the page; the phone page still answers", expect = "head", active = true, milestone = "M1", page = "new", tui = false, needs = ["agent-browser"];
export async function run(ctx) {
	// The launcher printed the page and exited: there is no terminal left to close.
	const code = await ctx.waitFor("pi-loops to exit after opening the page", () => {
		const exit = ctx.boot.pageExitCode();
		return { ok: exit !== null, last: exit, value: String(exit) };
	}, 10000);
	if (code !== "0") throw new Error(`pi-loops exited ${code}, not 0`);
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	ctx.browser("fill", "#input", "hello after close");
	ctx.browser("press", "Enter");
	await ctx.waitFor("the reply in the page", () => {
		const text = ctx.browser("get", "text", "body");
		return { ok: text.includes(ctx.reply), last: text };
	}, 5000);
	const screenshot = path.join(ctx.dir, "close-terminal.png");
	ctx.browser("screenshot", screenshot);
	ctx.addEvidence(screenshot);
	const status = spawnSync(path.join(ctx.boot.root, "bin", "pi-loops"), ["status"], { cwd: ctx.boot.project, env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
	const text = path.join(ctx.dir, "status.txt");
	fs.writeFileSync(text, `${status.stdout}${status.stderr}`);
	ctx.addEvidence(text);
	if (!/^ {2}page: .*1 open conversation\b/m.test(status.stdout)) throw new Error(`pi-loops status has no page line with 1 open conversation:\n${status.stdout}${status.stderr}`);
}
