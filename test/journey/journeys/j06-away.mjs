import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const A = "cron-journey-away-a";
const B = "cron-journey-away-b";
const hex = (n) => n.toString(16).padStart(32, "0");

export const id = "J6", title = "Leave and come back; the away card counts per project", expect = "head", active = true, milestone = "M5", page = "attach", tui = true, needs = ["tmux", "agent-browser"];

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const project = ctx.boot.project;
	const mine = ctx.boot.sessionId;
	if (!mine) throw new Error("the terminal's conversation has no id");
	/** A value the page computes, read back through agent-browser's eval (which prints it as JSON). */
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const card = () => page(`(() => { const c = document.querySelector("#awaySlot .away"); return c ? { text: c.querySelector(".sent").textContent, bad: [...c.querySelectorAll(".bad")].map((b) => ({ text: b.textContent, color: getComputedStyle(b).color })), fault: getComputedStyle(document.documentElement).getPropertyValue("--bad").trim(), buttons: [...c.querySelectorAll("button")].map((b) => b.textContent) } : null; })()`);
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};
	const tmux = (...args) => {
		const r = spawnSync("tmux", ["-L", ctx.boot.tmux.socket, ...args], { env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
		if (r.status !== 0) throw new Error(`tmux ${args[0]}: ${r.stderr}`);
		return r.stdout;
	};
	/** The terminal's screen with wrapped lines joined and runs of space collapsed: the line is longer than the pane. */
	const screen = () => tmux("capture-pane", "-p", "-J", "-t", ctx.boot.tmux.session).replace(/\s+/g, " ");
	const starts = () => fs.readdirSync(path.join(loops, "logs")).reduce((n, f) => n + (fs.readFileSync(path.join(loops, "logs", f), "utf8").match(/session start:/g) ?? []).length, 0);
	/** Start the terminal's pi again on the same conversation: its session-start line is the one to read. */
	const restartTerminal = async () => {
		const was = starts();
		tmux("clear-history", "-t", ctx.boot.tmux.session);
		tmux("respawn-pane", "-k", "-t", ctx.boot.tmux.session, `${path.join(ctx.boot.root, "bin", "pi-loops")} --tui --no-extensions -e ${ctx.boot.product} --model fake/fake-model --session ${mine}`);
		await ctx.waitFor("the terminal's pi started again", () => ({ ok: starts() > was, last: starts() }), 30000);
	};

	ctx.browser("open", `${ctx.boot.pageUrl}?token=${ctx.boot.token}`);
	await ctx.waitFor("the page", () => page(`!!document.getElementById("awaySlot")`), 30000);
	// "Yesterday 23:10" in the browser's own time zone: the card speaks it.
	const cursor = page(`(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1, 23, 10).toISOString(); })()`);
	const after = (m) => new Date(Date.now() - m * 60_000).toISOString();

	// Two loops in the project: one made in this conversation, one a recipe's made in another.
	fs.writeFileSync(path.join(loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [
		{ id: A, name: "away-a", schedule: { kind: "every", ms: 3_600_000 }, stateful: true, prompt: "look around", cwd: project, enabled: true, catchUp: true, createdAt: after(120), runCount: 0, skippedOverlap: 0, createdBy: { sessionId: mine, cwd: project } },
		{ id: B, name: "pr-watch", recipe: "pr-watch", schedule: { kind: "every", ms: 3_600_000 }, stateful: true, prompt: "watch", cwd: project, enabled: false, catchUp: false, createdAt: after(120), runCount: 0, skippedOverlap: 0, createdBy: { sessionId: "conversation-b", cwd: project } },
	] }));
	fs.writeFileSync(path.join(loops, "seen.json"), JSON.stringify({ v: 2, projects: { [fs.realpathSync(project)]: cursor }, sessions: {} }));
	const run = (n, over) => JSON.stringify({ runId: `seeded-${n}`, jobId: A, stateful: true, cwd: project, pid: 1, startedAt: after(31), finishedAt: after(30), ok: true, findings: 0, droppedFindings: 0, stateUpdated: false, forSession: mine, ...over });
	fs.writeFileSync(path.join(loops, "runs.jsonl"), [run(0, { finishedAt: new Date(Date.parse(cursor) - 60_000).toISOString() }), run(1, { ok: false, error: "boom" }), run(2, {}), run(3, { jobId: B, forSession: "conversation-b" }), run(4, { jobId: B, forSession: "conversation-b" })].join("\n") + "\n");
	const finding = (n, over) => JSON.stringify({ id: `inb-${hex(0xb0 + n)}`, created_at: after(20), status: "new", kind: "news", source: "cron:away-a", run_id: "seeded-1", cwd: project, text: `finding ${n}`, verified: null, dismiss_reason: null, job_id: A, session_id: mine, ...over });
	fs.writeFileSync(path.join(loops, "inbox.jsonl"), [
		finding(1, {}),
		finding(2, { source: "cron:pr-watch", job_id: B, run_id: "seeded-3", session_id: "conversation-b", text: "PR #7 has a red check" }),
		finding(3, { kind: "checkpoint", text: "#14 is ready — recommend merging · waits: your review · if not: it stays open" }),
	].join("\n") + "\n");

	// One real run of this conversation's loop, by pi-loops in the background: a written record counts too.
	const start = spawnSync(path.join(ctx.boot.root, "bin", "pi-loops"), ["start"], { cwd: project, env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
	if (start.error) throw start.error;
	if (start.status !== 0 && !/already running|a start is in progress/.test(start.stdout)) throw new Error(`pi-loops start exited ${start.status}: ${start.stdout}${start.stderr}`);
	const real = await ctx.waitFor("the loop's real run in runs.jsonl", () => {
		const recs = fs.readFileSync(path.join(loops, "runs.jsonl"), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } });
		const found = recs.find((r) => r.jobId === A && !String(r.runId).startsWith("seeded-"));
		return { ok: !!found, last: recs.length, value: found };
	}, 120000);
	const failed = 1 + (!real.ok && !real.aborted ? 1 : 0);

	// The page: per project, the recipe's finding counted, this conversation's marked; runs are the strip's.
	const want = /^Since yesterday 23:10 · 3 findings, 2 from this conversation( · \$\d+\.\d\d)?$/;
	const shown = await ctx.waitFor("the away card", () => {
		const now = card();
		return { ok: !!now && want.test(now.text), last: now, value: now };
	}, 45000);
	if (shown.buttons.join("|") !== "Mark all seen") throw new Error(`the card's buttons: ${shown.buttons.join("|")}`);
	shot("away.png");

	// The terminal's session-start line: the same counts.
	await restartTerminal();
	const line = await ctx.waitFor("the terminal's since-you-looked line", () => {
		const now = screen();
		const m = /\[inbox\] since you last looked \([^)]*\): \d+ loop runs?[^—]*— \/inbox/.exec(now);
		return { ok: !!m, last: now.slice(-600), value: m?.[0] };
	}, 30000);
	const counts = `5 loop runs (${failed} failed), 3 new findings (2 from this conversation)`;
	if (!line.includes(counts)) throw new Error(`the terminal counts differently: ${line} (wanted ${counts})`);
	fs.writeFileSync(path.join(ctx.dir, "terminal-line.txt"), `${line}\n`);
	ctx.addEvidence(path.join(ctx.dir, "terminal-line.txt"));

	// Mark all seen: the card goes, and stays gone after a reload; seen.json has the project's new cursor.
	ctx.browser("click", `#awaySlot .away [data-act="seen"]`);
	await ctx.waitFor("the card gone", () => ({ ok: card() === null, last: card() }), 30000);
	ctx.browser("open", `${ctx.boot.pageUrl}?token=${ctx.boot.token}`);
	await ctx.waitFor("the page again", () => page(`!!document.getElementById("cardsSlot") && document.querySelectorAll("#cardsSlot [data-inb]").length >= 3`), 30000);
	if (card() !== null) throw new Error(`the card is back after a reload: ${JSON.stringify(card())}`);
	const stored = JSON.parse(fs.readFileSync(path.join(loops, "seen.json"), "utf8")).projects[fs.realpathSync(project)];
	if (!(Date.parse(stored) > Date.parse(cursor))) throw new Error(`seen.json was not moved: ${stored}`);

	// The terminal again: nothing new, so no line.
	await restartTerminal();
	await new Promise((r) => setTimeout(r, 4000));
	const quiet = screen();
	if (quiet.includes("[inbox] since you last looked")) throw new Error(`the terminal still says what the page marked seen: ${quiet.slice(-600)}`);
	fs.writeFileSync(path.join(ctx.dir, "seen-sync.txt"), `${tmux("capture-pane", "-p", "-J", "-t", ctx.boot.tmux.session)}\nseen.json ${fs.realpathSync(project)}: ${stored}\n`);
	ctx.addEvidence(path.join(ctx.dir, "seen-sync.txt"));

	// A finding after the mark: one finding, and no run counted again.
	fs.appendFileSync(path.join(loops, "inbox.jsonl"), `${finding(4, { created_at: new Date().toISOString(), session_id: "conversation-b", source: "cron:pr-watch", job_id: B, text: "PR #8 has a conflict" })}\n`);
	ctx.browser("open", `${ctx.boot.pageUrl}?token=${ctx.boot.token}`);
	const fresh = await ctx.waitFor("the card with the one new finding", () => {
		const now = card();
		return { ok: !!now && /^Since (yesterday )?\d\d:\d\d · 1 finding$/.test(now.text), last: now, value: now };
	}, 45000);
	if (/run/.test(fresh.text)) throw new Error(`runs counted again: ${fresh.text}`);
	shot("away-after.png");

	// A phone: the card wraps above the cards, in the inbox pane, and nothing scrolls sideways.
	ctx.browser("set", "viewport", "390", "844");
	ctx.browser("open", `${ctx.boot.pageUrl}?token=${ctx.boot.token}#inbox`);
	const phone = await ctx.waitFor("the away card on a phone", () => {
		const now = page(`(() => { const c = document.querySelector("#awaySlot .away"); const first = document.querySelector("#cardsSlot [data-inb]"); return { card: !!c && !!c.offsetParent, above: !!c && !!first && c.getBoundingClientRect().bottom <= first.getBoundingClientRect().top, wide: document.documentElement.scrollWidth, width: window.innerWidth, pane: document.body.dataset.pane, visible: !!c && c.getBoundingClientRect().top >= 0 && c.getBoundingClientRect().top < window.innerHeight }; })()`);
		return { ok: now.card && now.pane === "inbox" && now.visible, last: now, value: now };
	}, 30000);
	if (!phone.above) throw new Error("the away card is not above the cards on a phone");
	if (phone.wide > phone.width) throw new Error(`the page scrolls sideways at 390 px: ${phone.wide} > ${phone.width}`);
	shot("phone-away.png");
}
