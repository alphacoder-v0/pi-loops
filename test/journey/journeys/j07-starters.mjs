import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J7", title = "An empty project shows three starters", expect = "head", active = true, milestone = "M5", page = "new", tui = false, needs = ["agent-browser"];

export async function run(ctx) {
	const jobsFile = path.join(ctx.boot.loopsDir, "jobs.json");
	const jobs = () => (fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, "utf8")).jobs ?? [] : []);
	const bytes = () => (fs.existsSync(jobsFile) ? fs.readFileSync(jobsFile, "utf8") : "absent");
	/** A value the page computes, read back through agent-browser's eval (which prints it as JSON). */
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const starters = () => page(`[...document.querySelectorAll("#startersSlot [data-starter]")].map((c) => ({ name: c.dataset.starter, text: c.textContent, add: (() => { const b = c.querySelector('[data-act="add"]'); return b ? { text: b.textContent, disabled: b.disabled } : null; })() }))`);
	const asking = () => page(`document.getElementById("ask").open ? document.getElementById("ask").textContent : ""`);
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};

	// 1. A project with no loop and no rule: three starters, each its name, one line and Add.
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	const offered = await ctx.waitFor("three starters", () => {
		const now = starters();
		return { ok: now.length === 3, last: now, value: now };
	}, 30000);
	const order = offered.map((s) => s.name).join(",");
	if (order !== "daily-digest,pr-watch,changelog-draft") throw new Error(`the starters are not in the design's order: ${order}`);
	for (const s of offered) if (!s.text.startsWith(s.name) || s.text.includes("reads only") || !s.add || s.add.text !== "Add") throw new Error(`a starter that is not its name, one line and Add: ${JSON.stringify(s)}`);
	if (page(`document.getElementById("awaySlot").children.length`) !== 0) throw new Error("an away card in a project where nothing ran");
	shot("starters.png");

	// 2. Add changelog-draft: the wizard's one question, the install confirmation, as this page's dialog.
	const before = bytes();
	const add = `#startersSlot [data-starter="changelog-draft"] [data-act="add"]`;
	ctx.browser("click", add);
	await ctx.waitFor("the install confirmation", () => {
		const text = asking();
		return { ok: text.includes("Install recipe changelog-draft") && text.includes('"report"'), last: text };
	}, 60000);
	shot("starter-confirm.png");
	// Closed by clicking outside it: nothing is installed, and Add is live again.
	ctx.browser("mouse", "move", "3", "3");
	ctx.browser("mouse", "down");
	ctx.browser("mouse", "up");
	await ctx.waitFor("Add live again after the box closed", () => {
		const now = starters().find((s) => s.name === "changelog-draft");
		return { ok: asking() === "" && !!now?.add && now.add.text === "Add" && !now.add.disabled, last: now };
	}, 30000);
	if (bytes() !== before) throw new Error(`jobs.json changed though the box was closed: ${bytes()}`);

	// 3. Add again and say yes: the loop exists, in this project, and the starters go.
	ctx.browser("click", add);
	await ctx.waitFor("the install confirmation again", () => ({ ok: asking().includes("Install recipe changelog-draft"), last: asking() }), 60000);
	ctx.browser("click", "#askOk");
	const job = await ctx.waitFor("the recipe's job in jobs.json", () => {
		const found = jobs().find((j) => j.recipe === "changelog-draft");
		return { ok: !!found, last: jobs().map((j) => j.name), value: found };
	}, 60000);
	if (fs.realpathSync(job.cwd) !== fs.realpathSync(ctx.boot.project)) throw new Error(`the job is not in the project: ${job.cwd}`);
	// A new page conversation pi has not saved (Add is a command, not a message): the loop is the project's.
	if (job.createdBy !== undefined) throw new Error(`the loop names a conversation that was never saved: ${JSON.stringify(job.createdBy)}`);
	await ctx.waitFor("the loops rail lists it and the starters are gone", () => {
		const now = page(`{ starters: document.querySelectorAll("#startersSlot [data-starter]").length, away: document.getElementById("awaySlot").children.length, rail: document.getElementById("loops").textContent.includes("changelog-draft") }`);
		return { ok: now.starters === 0 && now.away === 0 && now.rail, last: now };
	}, 45000);
	shot("starter-add.png");
}
