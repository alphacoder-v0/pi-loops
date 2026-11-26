import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const JOB = "cron-journey-triage";
const hex = (n) => n.toString(16).padStart(32, "0");
const CLAIMED = `inb-${hex(0xa1)}`;
const NEWS = `inb-${hex(0xa2)}`;
const DISMISSED = `inb-${hex(0xa3)}`;
const FIRST_PROMPT = "triage the issues";
const FIRST_ANSWER = "issue #14 has a reproduction and a brief";
const YES_LINE = "Running in the background, in the run that reported it.";
const CANCELLED = "Cancelled. The question is open again";

export const id = "J3", title = "Act on a decision from the page: a yes runs in the background, in the run that reported it", expect = "head", active = true, milestone = "M5a", page = "new", tui = false, needs = ["agent-browser"];
export function seed(dirs) {
	// A stateful loop the page's findings came from, disabled until the journey wants it to run.
	fs.writeFileSync(path.join(dirs.loops, "jobs.json"), JSON.stringify({ version: 3, jobs: [{ id: JOB, name: "issue-triage", schedule: { kind: "every", ms: 60000 }, stateful: true, prompt: FIRST_PROMPT, cwd: dirs.project, enabled: false, catchUp: true, createdAt: new Date(Date.now() + 120000).toISOString() }] }));
}

/** The run that filed the first decision, as pi writes a session: a header, then a tree of entries. */
function runTranscript(cwd) {
	const at = new Date(Date.now() - 120000).toISOString();
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	return [
		{ type: "session", version: 3, id: "run-journey", timestamp: at, cwd },
		{ type: "message", id: "e0000001", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: FIRST_PROMPT }], timestamp: Date.parse(at) } },
		{ type: "message", id: "e0000002", parentId: "e0000001", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: FIRST_ANSWER }], api: "openai-completions", provider: "fake", model: "fake-model", usage, stopReason: "stop", timestamp: Date.parse(at) } },
	];
}

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const sessionId = /\/c\/([^/]+)\//.exec(ctx.boot.pageUrl)?.[1];
	if (!sessionId) throw new Error(`no conversation in the page's address: ${ctx.boot.pageUrl}`);
	const transcript = path.join(loops, "sessions", JOB, "run-journey.jsonl");
	fs.mkdirSync(path.dirname(transcript), { recursive: true });
	fs.writeFileSync(transcript, runTranscript(ctx.boot.project).map((l) => JSON.stringify(l)).join("\n") + "\n");
	const at = (s) => new Date(Date.now() - s * 1000).toISOString();
	const finding = (over) => ({ created_at: at(60), status: "new", kind: "news", source: "cron:issue-triage", run_id: "run-journey", cwd: ctx.boot.project, verified: null, dismiss_reason: null, job_id: JOB, session_id: sessionId, ...over });
	fs.writeFileSync(path.join(loops, "inbox.jsonl"), [
		finding({ id: NEWS, text: "CI is green on main again. <b>bold</b> stays text." }),
		finding({ id: CLAIMED, kind: "checkpoint", text: "#14 brief posted — recommend ready-for-agent · waits: the implement loop skips it until labeled · if not: stays needs-triage", transcript, transcript_id: "run-journey" }),
		finding({ id: DISMISSED, kind: "checkpoint", text: "#15 looks like a crash in the parser — recommend a fix · waits: your label · if not: it stays open" }),
	].map((l) => JSON.stringify(l)).join("\n") + "\n");

	/** A value the page computes, read back through agent-browser's eval (which prints it as JSON). */
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const cards = () => page(`[...document.querySelectorAll(":is(#needsSlot,#cardsSlot) [data-inb]")].map((c) => ({ id: c.dataset.inb, text: c.textContent, html: c.innerHTML.includes("<b>bold"), line: c.querySelector(".cstat")?.textContent ?? "", acts: [...c.querySelectorAll(".acts button")].map((b) => b.dataset.act), needs: !!c.closest("#needsSlot") }))`);
	const card = (cardId) => cards().find((c) => c.id === cardId);
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};
	/** A press on a card's button, scrolled into view first as a person would: the list scrolls on its own. */
	const press = (selector) => {
		ctx.browser("scrollintoview", selector);
		ctx.browser("click", selector);
	};
	const modelLog = path.join(ctx.boot.root, "logs", "model.jsonl");
	const requests = () => (fs.existsSync(modelLog) ? fs.readFileSync(modelLog, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }) : []);
	const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join(""));
	const lastUser = (r) => textOf([...(r.messages ?? [])].reverse().find((x) => x.role === "user"));
	// Every line a card's status showed, in order, recorded by the page as it draws: a line the next
	// poll replaces at once is still a line a person saw.
	const watchLines = () => ctx.browser("eval", `(() => { window.__lines = []; const last = new Map(); const seen = () => { for (const c of document.querySelectorAll("[data-inb]")) { const t = c.querySelector(".cstat")?.textContent; if (t && last.get(c.dataset.inb) !== t) { last.set(c.dataset.inb, t); window.__lines.push([c.dataset.inb, t]); } } }; new MutationObserver(seen).observe(document.body, { subtree: true, childList: true, characterData: true }); return true; })()`);
	const linesOf = (cardId) => page(`(window.__lines ?? []).filter((l) => l[0] === ${JSON.stringify(cardId)}).map((l) => l[1])`);

	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	const listed = await ctx.waitFor("three cards, decisions first", () => {
		const now = cards();
		return { ok: now.length === 3, last: now, value: now };
	}, 30000);
	if (listed[2].id !== NEWS || listed.slice(0, 2).some((c) => c.id === NEWS)) throw new Error(`the decisions do not come first: ${listed.map((c) => c.id).join(", ")}`);
	const decision = listed.find((c) => c.id === CLAIMED);
	for (const words of ["Waiting on", "the implement loop skips it until labeled", "If you don't", "stays needs-triage", "Yes, do it", "No…", "Open the run"]) if (!decision.text.includes(words)) throw new Error(`the decision card lacks "${words}": ${decision.text}`);
	const news = listed.find((c) => c.id === NEWS);
	if (!news.text.includes("<b>bold</b>") || news.html) throw new Error(`a finding's HTML did not stay text: ${news.text}`);
	shot("decide.png");

	press(`[data-inb="${CLAIMED}"] [data-act="run"]`);
	await ctx.waitFor("the run's transcript in the dialog", () => {
		const now = page(`{ open: document.getElementById("detail").open, text: document.getElementById("detailBody").textContent }`);
		return { ok: now.open && now.text.includes(FIRST_ANSWER), last: now };
	}, 15000);
	shot("trace.png");
	ctx.browser("click", "#detailClose");
	await ctx.waitFor("the close button closes the run's dialog", () => {
		const open = page(`document.getElementById("detail").open`);
		return { ok: open === false, last: open };
	}, 10000);

	// A yes while the loop is off waits to run, and Cancel takes it back: the same card, open again.
	watchLines();
	press(`[data-inb="${CLAIMED}"] [data-act="claim"]`);
	await ctx.waitFor("the card says the yes runs in the background, in the run that reported it", () => ({ ok: linesOf(CLAIMED).includes(YES_LINE), last: linesOf(CLAIMED) }), 15000);
	const queued = await ctx.waitFor("the queued yes says it waits, with Cancel", () => {
		const now = card(CLAIMED);
		return { ok: !!now && now.line.startsWith("Waiting to run") && now.acts.includes("withdraw"), last: now, value: now };
	}, 15000);
	if (queued.acts.includes("claim")) throw new Error(`a queued yes still offers Yes: ${JSON.stringify(queued)}`);
	shot("queued.png");
	press(`[data-inb="${CLAIMED}"] [data-act="withdraw"]`);
	const reopened = await ctx.waitFor("the cancelled yes leaves the same card open again, with its Yes and No", () => {
		const now = card(CLAIMED);
		return { ok: !!now && now.needs && now.line === CANCELLED && now.acts.includes("claim") && now.acts.includes("no"), last: now, value: now };
	}, 15000);
	if (cards().filter((c) => c.id !== CLAIMED && c.text.includes("#14 brief posted")).length) throw new Error(`the cancel filed another card: ${JSON.stringify(cards())}`);
	shot("cancelled.png");

	// No… with a reason: the card says where the reason goes.
	const reasons = () => page(`getComputedStyle(document.querySelector('[data-inb="${DISMISSED}"] .why')).display`);
	if (reasons() !== "none") throw new Error("the reason chips show before No… is pressed");
	press(`[data-inb="${DISMISSED}"] [data-act="no"]`);
	if (reasons() === "none") throw new Error("No… did not show the reason chips");
	press(`[data-inb="${DISMISSED}"] [data-act="reason"][data-reason="Not a bug"]`);
	await ctx.waitFor("the dismiss says where the reason goes", () => {
		const now = card(DISMISSED);
		return { ok: !!now && now.text.includes("goes to issue-triage's next run"), last: now };
	}, 15000);

	// The loop is turned on and due: its next run, started by pi-loops in the background, hears the reason.
	const jobsFile = path.join(loops, "jobs.json");
	const store = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
	const job = store.jobs.find((j) => j.id === JOB);
	job.enabled = true;
	job.createdAt = new Date(Date.now() - 120000).toISOString();
	job.createdBy = { sessionId, cwd: ctx.boot.project };
	fs.writeFileSync(`${jobsFile}.journey`, JSON.stringify(store));
	fs.renameSync(`${jobsFile}.journey`, jobsFile);
	const start = spawnSync(path.join(ctx.boot.root, "bin", "pi-loops"), ["start"], { cwd: ctx.boot.project, env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
	if (start.error) throw start.error;
	if (start.status !== 0 && !/already running|a start is in progress/.test(start.stdout)) throw new Error(`pi-loops start exited ${start.status}: ${start.stdout}${start.stderr}`);

	// The yes again, on the card the cancel opened: it runs in the background, in the loop's own run.
	if (!reopened.acts.includes("claim")) throw new Error("the reopened card has no Yes");
	press(`[data-inb="${CLAIMED}"] [data-act="claim"]`);
	await ctx.waitFor("the card says the yes runs in the background again", () => ({ ok: linesOf(CLAIMED).filter((l) => l === YES_LINE).length === 2, last: linesOf(CLAIMED) }), 15000);
	const resumed = await ctx.waitFor("the loop's run resumes with the yes, carrying its first turn", () => {
		const asked = requests().filter((r) => lastUser(r).includes("A person read a finding your earlier run reported and said yes"));
		const carried = asked.filter((r) => { const all = JSON.stringify(r.messages ?? []); return all.includes(FIRST_PROMPT) && all.includes(FIRST_ANSWER); });
		return { ok: carried.length > 0, last: asked.map((r) => lastUser(r).slice(0, 80)), value: carried[0] };
	}, 120000);
	if (!lastUser(resumed).includes("#14 brief posted")) throw new Error(`the resumed run is not told which finding: ${lastUser(resumed)}`);
	const done = await ctx.waitFor("the card ends done", () => {
		const now = card(CLAIMED);
		return { ok: !!now && now.line.startsWith("Done"), last: { now, lines: linesOf(CLAIMED) }, value: now };
	}, 120000);
	if (done.acts.length) throw new Error(`a done answer still has buttons: ${JSON.stringify(done)}`);
	await ctx.waitFor("the loop's next run is told the reason in [reported]", () => {
		const told = requests().map((r) => JSON.stringify(r.messages ?? [])).filter((t) => t.includes("[reported]"));
		return { ok: told.some((t) => t.includes("Not a bug") && t.includes("#15 looks like a crash")), last: told.length };
	}, 120000);
	shot("claim.png");

	// The conversation the page shows got no hand-over: no message of the finding, and no turn of it reached the model.
	const handed = requests().map(lastUser).filter((t) => t.replace(/^\[Trigger [^\]]+\] /, "").startsWith("#14 brief posted") || t.includes("(from loop issue-triage in "));
	if (handed.length) throw new Error(`the claim was handed to a conversation: ${JSON.stringify(handed)}`);
	const feed = page(`[...document.querySelectorAll("#feed .row.user")].map((r) => r.textContent)`);
	if (feed.some((t) => t.includes("#14 brief posted"))) throw new Error(`the open conversation received the finding: ${JSON.stringify(feed)}`);
	const evidence = path.join(ctx.dir, "yes.txt");
	fs.writeFileSync(evidence, [`the card's lines, in order: ${JSON.stringify(linesOf(CLAIMED))}`, `the resumed request's last message:\n${lastUser(resumed)}`, `user rows in the open conversation: ${JSON.stringify(feed)}`].join("\n\n"));
	ctx.addEvidence(evidence);

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
