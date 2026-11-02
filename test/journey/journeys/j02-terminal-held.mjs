import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J2", title = "A terminal holds a conversation; a page message is answered in the terminal (O2)", expect = "trunk", active = true, page = "attach", tui = true, needs = ["tmux", "agent-browser"];
export async function run(ctx) {
	const before = ctx.term.screen();
	const beforeReplies = before.match(/pong from the stand-in/g)?.length ?? 0;
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	ctx.browser("fill", "#input", "answer from page");
	ctx.browser("press", "Enter");
	const terminal = await ctx.waitFor("page message answered in terminal", () => {
		const screen = ctx.term.screen();
		const replies = screen.match(/pong from the stand-in/g)?.length ?? 0;
		return screen.includes("answer from page") && replies > beforeReplies ? screen : undefined;
	}, 30000);
	const screenshot = path.join(ctx.dir, "terminal-held.png");
	const text = path.join(ctx.dir, "terminal.txt");
	ctx.browser("screenshot", screenshot);
	fs.writeFileSync(text, terminal);
	ctx.addEvidence(screenshot);
	ctx.addEvidence(text);
	process.stdout.write(`SHOT J2 ${screenshot}\nSHOT J2 ${text}\n`);
}
