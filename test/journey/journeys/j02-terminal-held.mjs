import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const HELD = "Your terminal has this conversation. What you send here is answered there.";

export const id = "J2", title = "A terminal holds a conversation; the page says so, and a page message is answered in the terminal (O2)", expect = "head", active = true, milestone = "M2", page = "attach", tui = true, needs = ["tmux", "agent-browser"];
export async function run(ctx) {
	// A second conversation in the project, written by pi itself with no pi-loops in it: no lease
	// names it, so the list finds it in pi's own files and the page opens it from there.
	const seeded = spawnSync(path.join(ctx.boot.root, "bin", "pi"), ["-p", "a second conversation", "--no-extensions", "--model", "fake/fake-model"], { cwd: ctx.boot.project, env: ctx.boot.env, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
	if (seeded.status !== 0) throw new Error(`pi -p did not write a second conversation: ${seeded.stderr || seeded.stdout}`);
	const held = ctx.boot.sessionId;
	if (!held) throw new Error("the terminal's conversation has no id");
	/** A value the page computes, read back through agent-browser's eval (which prints it as JSON). */
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	// Read while the page may still be loading (after a click or Back): an element not there yet reads
	// as empty, so the wait goes on instead of the journey failing on a half-built page.
	const shown = () => page(`{ url: location.pathname, on: (document.querySelector("#convs .conv.on") || { dataset: {} }).dataset.conv, title: document.getElementById("title")?.textContent ?? "", held: !document.getElementById("held") || document.getElementById("held").hidden ? "" : document.getElementById("held").textContent, rows: [...document.querySelectorAll("#convs [data-conv]")].map((a) => [a.dataset.conv, (a.querySelector(".who") || {}).textContent || ""]) }`);

	const before = ctx.term.screen();
	const countReplies = (screen) => screen.split(ctx.reply).length - 1;
	const beforeReplies = countReplies(before);
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	const listed = await ctx.waitFor("two conversations in the list, the terminal's tagged terminal", () => {
		const now = shown();
		return { ok: now.rows.length >= 2 && now.rows.some(([conv, tag]) => conv === held && tag.startsWith("terminal")), last: now, value: now };
	}, 30000);
	const other = listed.rows.find(([conv]) => conv !== held)?.[0];
	if (listed.rows.find(([conv]) => conv === other)?.[1].startsWith("terminal")) throw new Error(`the conversation no terminal holds is tagged terminal: ${JSON.stringify(listed.rows)}`);
	await ctx.waitFor("the held line above the composer, before anything is sent", () => {
		const now = shown();
		return { ok: now.url === `/c/${held}/` && now.on === held && now.held.includes(HELD), last: now };
	}, 30000);
	const listShot = path.join(ctx.dir, "list.png");
	ctx.browser("screenshot", listShot);
	ctx.addEvidence(listShot);

	ctx.browser("click", `#convs [data-conv="${other}"]`);
	await ctx.waitFor("the other conversation, marked in the list, with no held line", () => {
		const now = shown();
		return { ok: now.url === `/c/${other}/` && now.on === other && now.held === "" && now.title === "a second conversation", last: now };
	}, 30000);
	ctx.browser("back");
	await ctx.waitFor("back on the terminal's conversation, with the held line again", () => {
		const now = shown();
		return { ok: now.url === `/c/${held}/` && now.on === held && now.held.includes(HELD), last: now };
	}, 30000);

	ctx.browser("fill", "#input", "answer from page");
	ctx.browser("press", "Enter");
	const terminal = await ctx.waitFor("page message answered in terminal", () => {
		const screen = ctx.term.screen();
		return { ok: screen.includes("answer from page") && countReplies(screen) > beforeReplies, last: screen, value: screen };
	}, 30000);
	await ctx.waitFor("the page's notice that the terminal answered", () => {
		const text = ctx.browser("get", "text", "body");
		return { ok: text.includes("answered there"), last: text };
	}, 30000);
	const screenshot = path.join(ctx.dir, "o2.png");
	const text = path.join(ctx.dir, "terminal.txt");
	ctx.browser("screenshot", screenshot);
	fs.writeFileSync(text, terminal);
	ctx.addEvidence(screenshot);
	ctx.addEvidence(text);
}
