import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J8", title = "One sentence proposes a schedule or a rule, answered from one card in the page or pi's selector in a terminal", expect = "head", active = true, milestone = "M6", page = "new", tui = true, needs = ["agent-browser"];

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
	const cardsIn = (where) => page(`[...document.querySelectorAll(${JSON.stringify(where)})].map((c) => ({ id: c.dataset.proposal || "", text: c.textContent, buttons: [...c.querySelectorAll(".acts:not(.others) button")].map((b) => b.textContent), status: (c.querySelector(".cstat") || {}).textContent || "" }))`);
	const cards = () => cardsIn("#watchCards .proposal");
	const planCards = () => page(`[...document.querySelectorAll("#watchCards .plan")].map((c) => c.textContent)`);
	const feedCards = () => cardsIn("#feed .row.proposal .proposal");
	const readSentence = async (sentence, via) => {
		if (via) ctx.browser("click", via);
		else ctx.browser("fill", "#watchText", sentence);
		const typed = page(`document.getElementById("watchText").value`);
		if (typed !== sentence) throw new Error(`the box holds ${JSON.stringify(typed)}, not the sentence`);
		ctx.browser("click", "#watchRead");
	};
	const waitCard = (what, ok) => ctx.waitFor(what, () => { const now = cards(); return { ok: now.length === 1 && ok(now[0]), last: now, value: now[0] }; }, 30000);
	const setItUp = () => ctx.browser("click", "#watchCards .proposal button.primary");
	const cancel = () => ctx.browser("click", "#watchCards .proposal .acts:not(.others) button:last-child");
	const waitFeedReceipt = (what, id, re) => ctx.waitFor(what, () => { const now = feedCards().filter((c) => c.id === id); return { ok: now.length === 1 && re.test(now[0].status) && now[0].buttons.length === 0, last: now, value: now[0] }; }, 30000);
	const boxClosed = (what) => ctx.waitFor(what, () => { const s = page(`({ open: document.getElementById("watch").open, focus: document.activeElement && document.activeElement.id })`); return { ok: s.open === false && s.focus === "input", last: s }; }, 10000);
	/** The conversation the page shows now. */
	const sessionId = () => page(`location.pathname`).split("/")[2];
	const lease = (sid) => JSON.parse(fs.readFileSync(path.join(loops, "leases", `${sid}.json`), "utf8"));
	const sessionLines = () => fs.readFileSync(lease(sessionId()).sessionFile, "utf8").split("\n");
	/** The receipts a conversation got, by id: a row that waits in its queue, or delivered into its session file. */
	const receipts = (sid) => {
		const queued = path.join(loops, "requests", `${sid}.jsonl`);
		const text = [queued, lease(sid).sessionFile].filter((f) => f && fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
		return [...new Set([...text.matchAll(/\[Trigger (rcp-[0-9a-f]{32})\]/g)].map((m) => m[1]))];
	};

	// 1. The box, with its examples, on a short laptop screen: every click lands without scrolling.
	ctx.browser("set", "viewport", "1280", "577");
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	await ctx.waitFor("the Watch for… button", () => page(`!!document.getElementById("watchFor")`), 30000);
	ctx.browser("click", "#watchFor");
	await ctx.waitFor("the sentence box with three examples", () => { const n = page(`document.getElementById("watch").open ? document.querySelectorAll("#watchEx button").length : 0`); return { ok: n === 3, last: n }; }, 10000);
	const boxShot = path.join(ctx.dir, "watch-box.png");
	ctx.browser("screenshot", boxShot);
	ctx.addEvidence(boxShot);

	// 2. A rule from the build.done example: the model proposes it, and its card is in the box. The
	// rule is written, off, and waits for the person.
	await readSentence(EXAMPLES.buildDone, "#watchEx button:nth-of-type(2)");
	const ruleCard = await waitCard("the rule's card", (c) => c.text.includes("Set up this watch?") && c.text.includes("~/build.done appears") && c.text.includes("every 10 minutes") && !c.text.includes("/new-trigger") && c.buttons[0] === "Set it up · this conversation · once" && c.buttons.includes("Other…") && c.buttons.at(-1) === "Cancel");
	const proposed = rules();
	if (proposed.length !== 1 || proposed[0].enabled !== false || proposed[0].proposed?.session !== sessionId()) throw new Error(`expected one proposed rule of this conversation: ${JSON.stringify(proposed)}`);
	if (ruleCard.id !== `rule:${proposed[0].id}`) throw new Error(`the card names ${ruleCard.id}, not the proposed rule`);
	const feedBefore = feedCards().length;
	if (feedBefore !== 0) throw new Error(`the card is drawn in the transcript too while the box is open: ${feedBefore}`);
	const ruleShot = path.join(ctx.dir, "watch-rule.png");
	ctx.browser("screenshot", ruleShot);
	ctx.addEvidence(ruleShot);

	// 3. Set it up: the rule is on, in this conversation, once; the box closes and the receipt is in the
	// transcript once; one receipt row in the conversation; the tool's result in the session file.
	setItUp();
	await waitFeedReceipt("the rule's receipt in the transcript", ruleCard.id, /^Set up · this conversation · once$/);
	await boxClosed("the box closed and the composer focused");
	const made = rules();
	if (made.length !== 1 || made[0].enabled !== true || made[0].proposed || made[0].promoteToChat !== true || made[0].fireOnce !== true) throw new Error(`expected one rule set up with promoteToChat and fireOnce: ${JSON.stringify(made)}`);
	await ctx.waitFor("one receipt in the conversation", () => { const r = receipts(sessionId()); return { ok: r.length === 1, last: r }; }, 10000);
	if (!sessionLines().some((l) => l.includes('"toolName":"new_trigger"') && l.includes(`proposed dynamic trigger ${made[0].id}`))) throw new Error("the tool's proposed result is not in the session file");
	if (sessionLines().some((l) => l.includes('"pi-loops:watch"'))) throw new Error("a pi-loops:watch note is in the session file");

	// 3b. A new conversation in the same pi (pi runs the extension again in the same process): it
	// is still the page's, on its lease and in what the tools do.
	const first = sessionId();
	ctx.browser("click", "#newConv");
	const second = await ctx.waitFor("a new conversation in the page", () => { const sid = sessionId(); return { ok: !!sid && sid !== first && fs.existsSync(path.join(loops, "leases", `${sid}.json`)), last: sid, value: sid }; }, 30000);
	await ctx.waitFor("the new conversation's lease marked as the page's", () => { const h = lease(second).holder || {}; return { ok: h.page === true, last: h }; }, 10000);
	ctx.browser("click", "#watchFor");
	await ctx.waitFor("the box again", () => page(`document.getElementById("watch").open === true`), 10000);
	await readSentence(EXAMPLES.buildDone, "#watchEx button:nth-of-type(2)");
	const again = await waitCard("a card in the new conversation", (c) => c.text.includes("~/build.done appears"));
	if (rules().find((r) => `rule:${r.id}` === again.id)?.proposed?.session !== second) throw new Error(`the new conversation's proposal names another conversation: ${JSON.stringify(rules())}`);
	if (feedCards().some((c) => c.id === ruleCard.id)) throw new Error("the first conversation's receipt is drawn in the second");
	cancel();
	await waitFeedReceipt("its cancel receipt", again.id, /^Cancelled\. Nothing runs\.$/);
	if (rules().length !== 1) throw new Error(`Cancel left the new conversation's rule: ${JSON.stringify(rules())}`);

	// 4. A schedule from the morning sentence: Set it up · inbox makes a stateful cron job.
	ctx.browser("click", "#watchFor");
	await readSentence(EXAMPLES.morning);
	const daily = await waitCard("the daily card", (c) => c.text.includes("every day at 09:00") && c.buttons[0] === "Set it up · inbox");
	setItUp();
	await waitFeedReceipt("the job's receipt", daily.id, /^Set up · inbox$/);
	const dailyJob = jobs().find((j) => `schedule:${j.id}` === daily.id);
	if (!dailyJob || dailyJob.schedule.expr !== "0 9 * * *" || dailyJob.stateful !== true || dailyJob.enabled !== true || dailyJob.proposed) throw new Error(`expected a stateful 0 9 * * * job, set up: ${JSON.stringify(jobs())}`);

	// 5. Cancel: the helloworld rule is removed, and nothing ran.
	ctx.browser("click", "#watchFor");
	await readSentence(EXAMPLES.hello);
	const hello = await waitCard("the helloworld card", (c) => c.text.includes("$HOME/helloworld exists"));
	cancel();
	await waitFeedReceipt("the cancel receipt", hello.id, /^Cancelled\. Nothing runs\.$/);
	if (rules().some((r) => r.condition.includes("helloworld"))) throw new Error(`Cancel left the rule: ${JSON.stringify(rules())}`);

	// 6. Other…: the inbox, every time (fire_once false).
	ctx.browser("click", "#watchFor");
	await readSentence(EXAMPLES.review);
	const review = await waitCard("the review card", (c) => c.text.includes("review asking for changes"));
	ctx.browser("click", "#watchCards .proposal .acts:not(.others) button:nth-child(2)");
	ctx.browser("click", "#watchCards .proposal .acts.others button:nth-child(3)");
	await waitFeedReceipt("the repeating rule's receipt", review.id, /^Set up · inbox · every time$/);
	const repeating = rules().find((r) => r.condition.includes("review asking for changes"));
	if (!repeating || repeating.fireOnce !== false || repeating.promoteToChat !== false || repeating.enabled !== true) throw new Error(`expected a repeating inbox rule: ${JSON.stringify(rules())}`);

	// 7. Something to do now: the card says so, no model call, nothing written.
	const callsBefore = modelCalls();
	const storesBefore = [bytes(jobsFile), bytes(rulesFile)];
	ctx.browser("click", "#watchFor");
	await readSentence("run the tests");
	await ctx.waitFor("the now card", () => { const c = planCards(); return { ok: c.length === 1 && c[0].includes("This reads like something to do now, not something to watch."), last: c }; }, 10000);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	if (modelCalls() !== callsBefore) throw new Error("the now card cost a model call");
	if (JSON.stringify([bytes(jobsFile), bytes(rulesFile)]) !== JSON.stringify(storesBefore)) throw new Error("the now card wrote to a store");
	ctx.browser("click", "#watchClose");

	// 8. The step-3 answer again, from another surface: already answered, nothing written; the old route is gone.
	const origin = new URL(ctx.boot.pageUrl).origin;
	const headers = { "x-pi-web-token": ctx.boot.token, "content-type": "application/json" };
	const rulesBytes = bytes(rulesFile);
	const receiptsBefore = receipts(first).length + receipts(second).length;
	const replay = await fetch(`${origin}/watch/answer`, { method: "POST", headers, body: JSON.stringify({ kind: "rule", id: made[0].id, answer: "Cancel" }) });
	const replayed = await replay.json();
	await new Promise((resolve) => setTimeout(resolve, 1500));
	if (replay.status !== 200 || replayed.line !== "already answered: set up") throw new Error(`the replay answered ${replay.status} ${JSON.stringify(replayed)}`);
	const oldRoute = await fetch(`${origin}/c/${sessionId()}/watch`, { method: "POST", headers, body: JSON.stringify({ planId: "wp-0123456789abcdef", verdict: "set", where: "chat", once: true }) });
	if (oldRoute.status !== 404) throw new Error(`POST /c/<session>/watch answered ${oldRoute.status}, not 404`);
	if (bytes(rulesFile) !== rulesBytes || receipts(first).length + receipts(second).length !== receiptsBefore) throw new Error("the replay wrote");
	const replayFile = path.join(ctx.dir, "replay.txt");
	fs.writeFileSync(replayFile, `/watch/answer ${replay.status} ${JSON.stringify(replayed)}\n/c/<session>/watch ${oldRoute.status}\n`);
	ctx.addEvidence(replayFile);

	// 9. A reload: every proposal here was answered, so no card is drawn, and nothing waits.
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	await ctx.waitFor("the page again", () => page(`!!document.getElementById("watchFor") && document.querySelectorAll("#feed .row").length > 0`), 30000);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const reloaded = feedCards();
	if (reloaded.some((c) => c.buttons.length > 0)) throw new Error(`a card waits after the reload: ${JSON.stringify(reloaded)}`);
	const reloadShot = path.join(ctx.dir, "after-reload.png");
	ctx.browser("screenshot", reloadShot);
	ctx.addEvidence(reloadShot);

	// 10. A phone: the box and a card, nothing scrolling sideways, buttons at least 32 px tall. The
	// card left waiting is in the transcript after a reload, as its record says.
	ctx.browser("set", "viewport", "390", "844");
	// On a phone the conversation list is the Inbox pane, which is where the box opens from.
	ctx.browser("click", "#tabInbox");
	await ctx.waitFor("the inbox pane", () => page(`document.body.dataset.pane === "inbox"`), 10000);
	ctx.browser("click", "#watchFor");
	await readSentence(EXAMPLES.buildDone, "#watchEx button:nth-of-type(2)");
	const phoneCard = await waitCard("the rule card on a phone", (c) => c.text.includes("~/build.done appears"));
	const widths = page(`({ page: document.documentElement.scrollWidth, dialog: document.getElementById("watch").scrollWidth, buttons: [...document.querySelectorAll("#watch button")].map((b) => b.getBoundingClientRect().height) })`);
	if (widths.page > 390 || widths.dialog > 390) throw new Error(`something scrolls sideways at 390px: ${JSON.stringify(widths)}`);
	if (widths.buttons.some((h) => h > 0 && h < 32)) throw new Error(`a button is under 32px: ${JSON.stringify(widths.buttons)}`);
	const phoneShot = path.join(ctx.dir, "phone-watch.png");
	ctx.browser("screenshot", phoneShot);
	ctx.addEvidence(phoneShot);
	ctx.browser("set", "viewport", "1280", "577");
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	await ctx.waitFor("the waiting card in the transcript after a reload", () => { const now = feedCards().filter((c) => c.id === phoneCard.id); return { ok: now.length === 1 && now[0].buttons[0] === "Set it up · this conversation · once", last: now }; }, 30000);

	// 11. The terminal: the same sentence proposes; `/triggers enable` asks with pi's selector, the
	// card's rows as its title and the same options, the model's choice first. Enter sets it up; Esc
	// on the schedule's question leaves it proposed.
	const term = (what) => ctx.waitFor(what.name, () => { const screen = ctx.term.screen(); return { ok: what.ok(screen), last: screen, value: screen }; }, 30000);
	const proposedRule = (sid) => rules().find((r) => r.proposed && r.proposed.session !== sid);
	ctx.term.type(EXAMPLES.buildDone);
	ctx.term.press("Enter");
	const termRule = await ctx.waitFor("the terminal's proposal", () => { const r = proposedRule(sessionId()); return { ok: !!r, last: rules().length, value: r }; }, 30000);
	if (termRule.enabled !== false) throw new Error("the terminal's watch runs before it is answered");
	await term({ name: "the model told the person sees a card", ok: (s) => s.includes("proposed dynamic trigger") });
	ctx.term.type(`/triggers enable ${termRule.id}`);
	ctx.term.press("Enter");
	const selector = await term({ name: "pi's selector with the card's rows and the options", ok: (s) => s.includes("Set up this watch?") && s.includes("Waits for: ~/build.done appears") && /→ Set it up · this conversation · once/.test(s) && s.includes("Set it up · inbox · every time") && s.includes("Cancel") });
	const selectorFile = path.join(ctx.dir, "terminal-selector.txt");
	fs.writeFileSync(selectorFile, selector);
	ctx.addEvidence(selectorFile);
	ctx.term.press("Enter");
	await ctx.waitFor("the terminal's rule set up", () => { const r = rules().find((x) => x.id === termRule.id); return { ok: !!r && r.enabled === true && !r.proposed, last: r }; }, 30000);
	const termSet = rules().find((x) => x.id === termRule.id);
	if (termSet.promoteToChat !== true || termSet.fireOnce !== true) throw new Error(`the terminal's first option is this conversation, once: ${JSON.stringify(termSet)}`);
	await term({ name: "the selector gone after the answer", ok: (s) => !s.includes("↑↓ navigate") });
	ctx.term.type(EXAMPLES.ci);
	ctx.term.press("Enter");
	const termJob = await ctx.waitFor("the terminal's schedule proposal", () => { const j = jobs().find((x) => x.proposed && x.schedule.kind === "every"); return { ok: !!j, last: jobs().length, value: j }; }, 30000);
	await term({ name: "the model told the schedule waits", ok: (s) => s.includes("proposed cron job") });
	const jobsBeforeEsc = bytes(jobsFile);
	ctx.term.type(`/cron enable ${termJob.id}`);
	ctx.term.press("Enter");
	await term({ name: "the schedule's selector, the inbox first", ok: (s) => s.includes("Set up this watch?") && s.includes("Runs: every 30m") && /→ Set it up · inbox\b/.test(s) });
	ctx.term.press("Escape");
	await term({ name: "the selector gone after Esc", ok: (s) => !s.includes("↑↓ navigate") });
	await new Promise((resolve) => setTimeout(resolve, 1500));
	if (bytes(jobsFile) !== jobsBeforeEsc) throw new Error("Esc wrote to jobs.json");
	const dismissedFile = path.join(ctx.dir, "terminal-dismissed.txt");
	fs.writeFileSync(dismissedFile, ctx.term.screen());
	ctx.addEvidence(dismissedFile);
}
