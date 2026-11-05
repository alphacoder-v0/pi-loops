import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J8", title = "One sentence sets up a schedule or a rule through a confirmation card", expect = "head", active = true, milestone = "M6", page = "new", tui = false, needs = ["agent-browser"];

/** What the stand-in model answers each example with: the tool call a real model would make (test/downstream/fake-model.mjs). */
export const modelTools = [
	{ match: "build.done", tool: "new_trigger", args: { condition: "~/build.done appears", action: "run cargo test and show me the result" } },
	{ match: "TODO.md", tool: "cron_create", args: { schedule: "0 9 * * *", action: "read TODO.md and tell me about new unchecked items", stateful: true } },
	{ match: "CI", tool: "cron_create", args: { schedule: "every 30m", action: "看一下 CI，红了告诉我" } },
	{ match: "helloworld", tool: "new_trigger", args: { condition: "$HOME/helloworld exists", action: "print its contents" } },
	{ match: "review asking for changes", tool: "new_trigger", args: { condition: "a PR of mine gets a review asking for changes", action: "tell me" } },
];

/** Handed to the stand-in model by the harness (test/journey/boot.mjs). */
export const seed = async () => ({ modelEnv: { FAKE_MODEL_TOOL_SCRIPT: JSON.stringify(modelTools) } });

const EXAMPLES = {
	buildDone: "When ~/build.done appears, run cargo test and show me the result",
	morning: "Every morning at 9, read TODO.md and tell me about new unchecked items",
	ci: "每 30 分钟看一下 CI，红了告诉我",
	hello: "When $HOME/helloworld exists, print its contents",
	review: "When a PR of mine gets a review asking for changes, tell me",
};

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const jobsFile = path.join(loops, "jobs.json");
	const rulesFile = path.join(loops, "triggers.json");
	const modelLog = path.join(ctx.boot.root, "logs", "model.jsonl");
	const bytes = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "absent");
	const rules = () => (fs.existsSync(rulesFile) ? JSON.parse(fs.readFileSync(rulesFile, "utf8")).rules : []);
	const jobs = () => (fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, "utf8")).jobs : []);
	const modelCalls = () => (fs.existsSync(modelLog) ? fs.readFileSync(modelLog, "utf8").split("\n").filter(Boolean).length : 0);
	/** A value the page computes, read back through agent-browser's eval (which prints it as JSON). */
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const cards = () => page(`[...document.querySelectorAll("#watchCards .plan")].map((c) => ({ id: c.dataset.plan || "", text: c.textContent, on: [...c.querySelectorAll(".chips button.on")].map((b) => b.textContent), status: (c.querySelector(".cstat") || {}).textContent || "" }))`);
	const feedReceipts = () => page(`[...document.querySelectorAll("#feed .row.plan .plan .cstat")].map((s) => s.textContent)`);
	const readSentence = async (sentence, via) => {
		if (via) ctx.browser("click", via);
		else ctx.browser("fill", "#watchText", sentence);
		const typed = page(`document.getElementById("watchText").value`);
		if (typed !== sentence) throw new Error(`the box holds ${JSON.stringify(typed)}, not the sentence`);
		ctx.browser("click", "#watchRead");
	};
	const waitCard = (what, ok) => ctx.waitFor(what, () => { const now = cards(); return { ok: now.length === 1 && ok(now[0]), last: now, value: now[0] }; }, 30000);
	const setItUp = () => ctx.browser("click", "#watchCards .plan button.primary");
	const waitReceipt = (what, re) => ctx.waitFor(what, () => { const now = cards(); return { ok: now.length === 1 && re.test(now[0].status), last: now, value: now[0] }; }, 30000);
	/** The conversation the page shows now: it changes once the journey starts a new one. */
	const sessionId = () => page(`location.pathname`).split("/")[2];
	const lease = (sid) => JSON.parse(fs.readFileSync(path.join(loops, "leases", `${sid}.json`), "utf8"));
	const sessionFile = () => lease(sessionId()).sessionFile;
	const watchNotes = () => fs.readFileSync(sessionFile(), "utf8").split("\n").filter((l) => l.includes('"pi-loops:watch"'));

	// 1. The box, with its examples, on a short laptop screen: every click lands without scrolling.
	ctx.browser("set", "viewport", "1280", "577");
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	await ctx.waitFor("the Watch for… button", () => page(`!!document.getElementById("watchFor")`), 30000);
	ctx.browser("click", "#watchFor");
	await ctx.waitFor("the sentence box with six examples", () => { const n = page(`document.getElementById("watch").open ? document.querySelectorAll("#watchEx button").length : 0`); return { ok: n === 6, last: n }; }, 10000);
	const boxShot = path.join(ctx.dir, "watch-box.png");
	ctx.browser("screenshot", boxShot);
	ctx.addEvidence(boxShot);

	// 2. A rule from the build.done example: the card, and nothing in the store.
	await readSentence(EXAMPLES.buildDone, "#watchEx button:nth-of-type(2)");
	const ruleCard = await waitCard("the rule card", (c) => c.text.includes("When something happens") && c.text.includes("every 10 minutes") && c.on.includes("Show it in this conversation") && c.on.some((t) => t.startsWith("Once")));
	if (rules().length !== 0) throw new Error(`a rule exists before Set it up: ${JSON.stringify(rules())}`);
	const ruleShot = path.join(ctx.dir, "watch-rule.png");
	ctx.browser("screenshot", ruleShot);
	ctx.addEvidence(ruleShot);

	// 3. Set it up: one rule, this conversation, once; the receipt here and in the transcript; the note in the session file.
	setItUp();
	await waitReceipt("the rule receipt", /^Set up dyn-/);
	const made = rules();
	if (made.length !== 1 || made[0].promoteToChat !== true || made[0].fireOnce !== true) throw new Error(`expected one rule with promoteToChat and fireOnce: ${JSON.stringify(made)}`);
	await ctx.waitFor("the receipt in the transcript", () => { const r = feedReceipts(); return { ok: r.some((t) => t.startsWith("Set up dyn-")), last: r }; }, 10000);
	await ctx.waitFor("the pi-loops:watch note in the session file", () => { const n = watchNotes(); return { ok: n.length === 1 && n[0].includes(ruleCard.id), last: n.length }; }, 10000);

	// 3b. A new conversation in the same pi (pi runs the extension again in the same process): it
	// is still the page's, on its lease and in what the tools do.
	const first = sessionId();
	ctx.browser("click", "#watchClose");
	ctx.browser("click", "#newConv");
	const second = await ctx.waitFor("a new conversation in the page", () => { const sid = sessionId(); return { ok: !!sid && sid !== first && fs.existsSync(path.join(loops, "leases", `${sid}.json`)), last: sid, value: sid }; }, 30000);
	await ctx.waitFor("the new conversation's lease marked as the page's", () => { const h = lease(second).holder || {}; return { ok: h.page === true, last: h }; }, 10000);
	ctx.browser("click", "#watchFor");
	await ctx.waitFor("the box again", () => page(`document.getElementById("watch").open === true`), 10000);
	await readSentence(EXAMPLES.buildDone, "#watchEx button:nth-of-type(2)");
	await waitCard("a card in the new conversation", (c) => c.text.includes("When something happens"));
	if (rules().length !== 1) throw new Error(`the new conversation created instead of drafting: ${JSON.stringify(rules())}`);
	ctx.browser("click", "#watchCards .plan .acts button:not(.primary)");
	await waitReceipt("its cancel receipt", /^Not set up$/);

	// 4. A schedule from the morning sentence: a stateful cron job.
	await readSentence(EXAMPLES.morning);
	await waitCard("the daily card", (c) => c.text.includes("On a schedule") && c.text.includes("every day at 09:00") && c.on.includes("Put it in my inbox"));
	setItUp();
	await waitReceipt("the job receipt", /^Set up cron-/);
	const daily = jobs().find((j) => j.schedule.kind === "cron");
	if (!daily || daily.schedule.expr !== "0 9 * * *" || daily.stateful !== true) throw new Error(`expected a stateful 0 9 * * * job: ${JSON.stringify(jobs())}`);

	// 5. The Chinese sentence: every 30 minutes.
	await readSentence(EXAMPLES.ci);
	await waitCard("the half-hour card", (c) => c.text.includes("On a schedule") && c.text.includes("every 30m"));
	setItUp();
	await waitReceipt("the second job receipt", /^Set up cron-/);
	if (!jobs().some((j) => j.schedule.kind === "every" && j.schedule.ms === 1800000)) throw new Error(`expected an every-30m job: ${JSON.stringify(jobs())}`);

	// 6. Something to do now: the card says so, no model call, nothing written.
	const callsBefore = modelCalls();
	const storesBefore = [bytes(jobsFile), bytes(rulesFile)];
	await readSentence("run the tests");
	await ctx.waitFor("the now card", () => { const c = cards(); return { ok: c.length === 1 && c[0].text.includes("This reads like something to do now, not something to watch."), last: c }; }, 10000);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	if (modelCalls() !== callsBefore) throw new Error("the now card cost a model call");
	if (JSON.stringify([bytes(jobsFile), bytes(rulesFile)]) !== JSON.stringify(storesBefore)) throw new Error("the now card wrote to a store");

	// 7. A rule, then Cancel: both files byte for byte as they were.
	await readSentence(EXAMPLES.hello);
	await waitCard("the helloworld card", (c) => c.text.includes("$HOME/helloworld exists"));
	const beforeCancel = [bytes(jobsFile), bytes(rulesFile)];
	ctx.browser("click", "#watchCards .plan .acts button:not(.primary)");
	await waitReceipt("the cancel receipt", /^Not set up$/);
	if (JSON.stringify([bytes(jobsFile), bytes(rulesFile)]) !== JSON.stringify(beforeCancel)) throw new Error("Cancel wrote to a store");

	// 8. Repeats → Every time: fire_once false.
	await readSentence(EXAMPLES.review);
	await waitCard("the review card", (c) => c.text.includes("review asking for changes"));
	ctx.browser("click", "#watchCards .plan .chips button[data-key=every]");
	setItUp();
	await waitReceipt("the repeating rule's receipt", /^Set up dyn-.*every time$/);
	const repeating = rules().find((r) => r.condition.includes("review asking for changes"));
	if (!repeating || repeating.fireOnce !== false) throw new Error(`expected a repeating rule: ${JSON.stringify(rules())}`);

	// 9. The step-3 answer, replayed with the token: nothing is created twice.
	const rulesBefore = rules().length;
	const notesBefore = watchNotes().length;
	const replay = await fetch(`${ctx.boot.pageUrl}watch`, { method: "POST", headers: { "x-pi-web-token": ctx.boot.token, "content-type": "application/json" }, body: JSON.stringify({ planId: ruleCard.id, verdict: "set", where: "chat", once: true }) });
	if (replay.status !== 200) throw new Error(`the replay answered ${replay.status}`);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	if (rules().length !== rulesBefore) throw new Error(`the replay made a rule: ${rules().length} now, ${rulesBefore} before`);
	if (watchNotes().length !== notesBefore) throw new Error("the replay left a second note");
	const replayFile = path.join(ctx.dir, "replay.txt");
	fs.writeFileSync(replayFile, `status ${replay.status}\nrules ${rulesBefore} -> ${rules().length}\nnotes ${notesBefore} -> ${watchNotes().length}\n`);
	ctx.addEvidence(replayFile);

	// 10. A phone: the box and a card, nothing scrolling sideways, buttons at least 32 px tall.
	ctx.browser("set", "viewport", "390", "844");
	ctx.browser("click", "#watchClose");
	// On a phone the conversation list is the Inbox pane, which is where the box opens from.
	ctx.browser("click", "#tabInbox");
	await ctx.waitFor("the inbox pane", () => page(`document.body.dataset.pane === "inbox"`), 10000);
	ctx.browser("click", "#watchFor");
	await readSentence(EXAMPLES.buildDone, "#watchEx button:nth-of-type(2)");
	await waitCard("the rule card on a phone", (c) => c.text.includes("When something happens"));
	const widths = page(`({ page: document.documentElement.scrollWidth, dialog: document.getElementById("watch").scrollWidth, buttons: [...document.querySelectorAll("#watch button")].map((b) => b.getBoundingClientRect().height) })`);
	if (widths.page > 390 || widths.dialog > 390) throw new Error(`something scrolls sideways at 390px: ${JSON.stringify(widths)}`);
	if (widths.buttons.some((h) => h > 0 && h < 32)) throw new Error(`a button is under 32px: ${JSON.stringify(widths.buttons)}`);
	const phoneShot = path.join(ctx.dir, "phone-watch.png");
	ctx.browser("screenshot", phoneShot);
	ctx.addEvidence(phoneShot);
}
