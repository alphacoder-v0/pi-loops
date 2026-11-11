import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const JOB = "cron-journey-triage";
const hex = (n) => n.toString(16).padStart(32, "0");
const CLAIMED = `inb-${hex(0xa1)}`;
const NEWS = `inb-${hex(0xa2)}`;
const DISMISSED = `inb-${hex(0xa3)}`;

export const id = "J3", title = "Act on a decision from the page", expect = "head", active = true, milestone = "M3", page = "new", tui = false, needs = ["agent-browser"];
export function seed(dirs) {
	// A stateful loop the page's findings came from, disabled until the journey wants its next run.
	fs.writeFileSync(path.join(dirs.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: JOB, name: "issue-triage", schedule: { kind: "every", ms: 60000 }, stateful: true, prompt: "triage the issues", cwd: dirs.project, enabled: false, catchUp: true, createdAt: new Date(Date.now() + 120000).toISOString(), runCount: 0, skippedOverlap: 0 }] }));
}

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const sessionId = /\/c\/([^/]+)\//.exec(ctx.boot.pageUrl)?.[1];
	if (!sessionId) throw new Error(`no conversation in the page's address: ${ctx.boot.pageUrl}`);
	// The run that filed the first decision, as a loop's run leaves it under sessions/<job>/.
	const transcript = path.join(loops, "sessions", JOB, "run-journey.jsonl");
	fs.mkdirSync(path.dirname(transcript), { recursive: true });
	fs.writeFileSync(transcript, [{ type: "session", version: 3, id: "run-journey", cwd: ctx.boot.project }, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "issue #14 has a reproduction and a brief" }] } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
	const at = (s) => new Date(Date.now() - s * 1000).toISOString();
	const finding = (over) => ({ created_at: at(60), status: "new", kind: "news", source: "cron:issue-triage", run_id: "run-journey", cwd: ctx.boot.project, verified: null, dismiss_reason: null, job_id: JOB, session_id: sessionId, ...over });
	fs.writeFileSync(path.join(loops, "inbox.jsonl"), [
		finding({ id: NEWS, text: "CI is green on main again. <b>bold</b> stays text." }),
		finding({ id: CLAIMED, kind: "checkpoint", text: "#14 brief posted — recommend ready-for-agent · waits: the implement loop skips it until labeled · if not: stays needs-triage", transcript }),
		finding({ id: DISMISSED, kind: "checkpoint", text: "#15 looks like a crash in the parser — recommend a fix · waits: your label · if not: it stays open" }),
	].map((l) => JSON.stringify(l)).join("\n") + "\n");

	/** A value the page computes, read back through agent-browser's eval (which prints it as JSON). */
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const cards = () => page(`[...document.querySelectorAll(":is(#needsSlot,#cardsSlot) [data-inb]")].map((c) => ({ id: c.dataset.inb, text: c.textContent, html: c.innerHTML.includes("<b>bold") }))`);
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};
	const modelLog = path.join(ctx.boot.root, "logs", "model.jsonl");
	const requests = () => (fs.existsSync(modelLog) ? fs.readFileSync(modelLog, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }) : []);
	const lastUser = (r) => { const m = [...(r.messages ?? [])].reverse().find((x) => x.role === "user"); return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join(""); };
	const inbox = () => fs.readFileSync(path.join(loops, "inbox.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	const listed = await ctx.waitFor("three cards, decisions first", () => {
		const now = cards();
		return { ok: now.length === 3, last: now, value: now };
	}, 30000);
	if (listed[2].id !== NEWS || listed.slice(0, 2).some((c) => c.id === NEWS)) throw new Error(`the decisions do not come first: ${listed.map((c) => c.id).join(", ")}`);
	const decision = listed.find((c) => c.id === CLAIMED);
	for (const words of ["Waiting on", "the implement loop skips it until labeled", "If you don't", "stays needs-triage", "Yes, do it", "No…", "See the run"]) if (!decision.text.includes(words)) throw new Error(`the decision card lacks "${words}": ${decision.text}`);
	const news = listed.find((c) => c.id === NEWS);
	if (!news.text.includes("<b>bold</b>") || news.html) throw new Error(`a finding's HTML did not stay text: ${news.text}`);
	shot("decide.png");

	ctx.browser("click", `[data-inb="${CLAIMED}"] [data-act="run"]`);
	await ctx.waitFor("the run's transcript in the dialog", () => {
		const now = page(`{ open: document.getElementById("detail").open, text: document.getElementById("detailBody").textContent }`);
		return { ok: now.open && now.text.includes("issue #14 has a reproduction and a brief"), last: now };
	}, 15000);
	shot("trace.png");
	ctx.browser("click", "#detailClose");
	await ctx.waitFor("the close button closes the run's dialog", () => {
		const open = page(`document.getElementById("detail").open`);
		return { ok: open === false, last: open };
	}, 10000);

	ctx.browser("click", `[data-inb="${CLAIMED}"] [data-act="claim"]`);
	await ctx.waitFor("the card says the claim runs here", () => {
		const now = cards().find((c) => c.id === CLAIMED);
		return { ok: !!now && /Running in|Starting/.test(now.text), last: now };
	}, 15000);
	await ctx.waitFor("the claim's turn reaches the model", () => {
		const asked = requests().map(lastUser);
		return { ok: asked.some((t) => t.startsWith("A recurring loop (cron:issue-triage")), last: asked.slice(-3) };
	}, 60000);
	const claimed = inbox().find((e) => e.id === CLAIMED);
	if (claimed.status !== "claimed" || claimed.claimed_by !== sessionId) throw new Error(`the finding is not claimed by the page's conversation: ${JSON.stringify(claimed)}`);
	shot("claim.png");

	const reasons = () => page(`getComputedStyle(document.querySelector('[data-inb="${DISMISSED}"] .why')).display`);
	if (reasons() !== "none") throw new Error("the reason chips show before No… is pressed");
	ctx.browser("click", `[data-inb="${DISMISSED}"] [data-act="no"]`);
	if (reasons() === "none") throw new Error("No… did not show the reason chips");
	ctx.browser("click", `[data-inb="${DISMISSED}"] [data-act="reason"][data-reason="Not a bug"]`);
	await ctx.waitFor("the dismiss says where the reason goes", () => {
		const text = page(`[...document.querySelectorAll("#needsSlot,#cardsSlot")].map((s) => s.textContent).join(" ")`);
		return { ok: text.includes("goes to issue-triage's next run"), last: text };
	}, 15000);

	// The loop's next run: enabled, due, and started by pi-loops in the background.
	const jobsFile = path.join(loops, "jobs.json");
	const store = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
	store.jobs[0].enabled = true;
	store.jobs[0].createdAt = new Date(Date.now() - 120000).toISOString();
	store.jobs[0].createdBy = { sessionId, cwd: ctx.boot.project };
	fs.writeFileSync(jobsFile, JSON.stringify(store));
	const start = spawnSync(path.join(ctx.boot.root, "bin", "pi-loops"), ["start"], { cwd: ctx.boot.project, env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
	if (start.error) throw start.error;
	if (start.status !== 0 && !/already running|a start is in progress/.test(start.stdout)) throw new Error(`pi-loops start exited ${start.status}: ${start.stdout}${start.stderr}`);
	await ctx.waitFor("the loop's next run is told the reason", () => {
		const told = requests().map((r) => JSON.stringify(r.messages ?? [])).filter((t) => t.includes("[dismissed]"));
		return { ok: told.some((t) => t.includes("Not a bug") && t.includes("#15 looks like a crash")), last: told.length };
	}, 90000);
	shot("dismiss.png");

	ctx.browser("set", "viewport", "390", "844");
	ctx.browser("open", `${ctx.boot.pageUrl}?token=${ctx.boot.token}#inbox`);
	const phone = await ctx.waitFor("the inbox pane on a phone", () => {
		const now = page(`{ cards: document.querySelectorAll(":is(#needsSlot,#cardsSlot) [data-inb]").length, short: [...document.querySelectorAll(":is(#needsSlot,#cardsSlot) .icard button")].filter((b) => b.offsetParent && b.offsetHeight < 32).map((b) => b.textContent + " " + b.offsetHeight), buttons: [...document.querySelectorAll(":is(#needsSlot,#cardsSlot) .icard button")].filter((b) => b.offsetParent).length, wide: document.documentElement.scrollWidth, width: window.innerWidth, pane: document.body.dataset.pane }`);
		return { ok: now.pane === "inbox" && now.cards >= 1 && now.buttons >= 1, last: now, value: now };
	}, 30000);
	if (phone.short.length) throw new Error(`inbox buttons under 32 px on a phone: ${phone.short.join(", ")}`);
	if (phone.wide > phone.width) throw new Error(`the page scrolls sideways at 390 px: ${phone.wide} > ${phone.width}`);
	shot("phone-cards.png");
}
