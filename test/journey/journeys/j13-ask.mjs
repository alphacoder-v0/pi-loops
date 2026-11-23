import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J13", title = "A loop asks, a person answers, the run resumes", expect = "head", active = true, milestone = "M5a", page = "new", tui = false, needs = ["agent-browser"];

const JOB = "cron-13131313131313131313131313131313";
const PROMPT = "ship the release fix";
const MARKER = "pushed.txt";
// The guard asks about it (git push --force on main/master); the echo is how the journey sees that it ran.
const COMMAND = `echo ran >> ${MARKER} && git push --force origin main`;
const RESUMED = "A person said yes to the call you asked about";
const ASKED = "asked a person:";
const NO_LINE = "You said no. release-fix is told on its next run, and the same command is refused for 14 days.";
/** A plain job of the conversation the page holds open: its scheduled turn runs in that window, and asks. */
const PLAIN = "cron-31313131313131313131313131313131";
const WINDOW_PROMPT = "check the deploy window";
const WINDOW_MARKER = "window.txt";
const WINDOW_COMMAND = `echo ran >> ${WINDOW_MARKER} && git push --force origin main`;
/** Long enough for the person to say yes while the scheduled turn still runs. */
const HOLD = "sleep 60";
const APPROVED = "Approved. It runs in this conversation after the current turn.";
const WAITING = "Waiting to run";

const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c?.text ?? "").join(""));

/**
 * The stand-in's script. The loop's run makes the call once. The run a yes resumes makes it twice:
 * the call the person allowed, then the same call again. The window's scheduled turn makes its call,
 * then holds the turn with a `sleep`; the window's answer turn makes the allowed call once. Everything
 * else gets the reply.
 */
export function seed() {
	return {
		answer: (messages) => {
			const last = messages.findLastIndex((m) => m.role === "user");
			if (last === -1) return undefined;
			const text = textOf(messages[last]);
			const results = messages.slice(last).filter((m) => m.role === "tool").length;
			const call = { tool: "bash", args: { command: COMMAND } };
			const windowCall = { tool: "bash", args: { command: WINDOW_COMMAND } };
			if (text.includes(RESUMED) && text.includes(WINDOW_COMMAND)) return results < 1 ? windowCall : undefined;
			if (text.includes(WINDOW_PROMPT)) return results === 0 ? windowCall : results === 1 ? { tool: "bash", args: { command: HOLD } } : undefined;
			if (text.includes(RESUMED)) return results < 2 ? call : undefined;
			if (text.includes(PROMPT)) return results < 1 ? call : undefined;
			return undefined;
		},
	};
}

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const marker = path.join(ctx.boot.project, MARKER);
	/** A value the page computes, read back through agent-browser's eval (which prints it as JSON). */
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const cards = () => page(`[...document.querySelectorAll(":is(#needsSlot,#cardsSlot) [data-inb]")].map((c) => ({ id: c.dataset.inb, text: c.textContent, line: c.querySelector(".cstat")?.textContent ?? "", acts: [...c.querySelectorAll(".acts button")].map((b) => b.dataset.act), needs: !!c.closest("#needsSlot") }))`);
	const card = (cardId) => cards().find((c) => c.id === cardId);
	const questions = () => cards().filter((c) => c.text.includes(COMMAND));
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
	const lastUser = (r) => textOf([...(r.messages ?? [])].reverse().find((x) => x.role === "user"));
	const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);

	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	await ctx.waitFor("the page's inbox", () => page(`!!document.getElementById("needsSlot")`), 30000);

	// 1. A loop of the project, due now, written as `/cron add` leaves it. pi-loops in the background runs it.
	const jobsFile = path.join(loops, "jobs.json");
	const store = fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, "utf8")) : { version: 3, jobs: [] };
	store.jobs.push({ id: JOB, name: "release-fix", schedule: { kind: "every", ms: 24 * 60 * 60_000 }, stateful: true, owner: "project", prompt: PROMPT, cwd: ctx.boot.project, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 24 * 60 * 60_000 - 60_000).toISOString() });
	fs.writeFileSync(`${jobsFile}.journey`, JSON.stringify(store));
	fs.renameSync(`${jobsFile}.journey`, jobsFile);

	// 2. Its call is held for a person: the approval card under Needs you, and the command did not run.
	const asked = await ctx.waitFor("the loop's question under Needs you", () => {
		const now = questions();
		return { ok: now.length === 1 && now[0].needs, last: cards(), value: now[0] };
	}, 120000);
	for (const words of ["git push --force on main/master", "Waiting on", "release-fix went on without it", "If you don't", "it stays undone"]) if (!asked.text.includes(words)) throw new Error(`the approval card lacks "${words}": ${asked.text}`);
	if (!asked.acts.includes("claim") || !asked.acts.includes("no")) throw new Error(`the approval card has no Yes and No: ${JSON.stringify(asked)}`);
	if (!page(`[...document.querySelectorAll("#needsSlot .grp")].some((g) => g.textContent === "Needs you")`)) throw new Error("the question is not under Needs you");
	const first = requests().find((r) => lastUser(r).includes(PROMPT));
	if (!first) throw new Error("the loop's run never reached the model");
	if (ran() !== 0) throw new Error(`the command ran before anyone said yes: ${ran()} time(s)`);
	shot("ask.png");

	// 3. Yes: at a tick, the run that asked resumes its own transcript, and the allowed call runs once.
	press(`[data-inb="${asked.id}"] [data-act="claim"]`);
	const resumed = await ctx.waitFor("the run that asked resumes with the yes, carrying its first turn", () => {
		const back = requests().filter((r) => lastUser(r).includes(RESUMED));
		const carried = back.filter((r) => { const all = JSON.stringify(r.messages ?? []); return all.includes(PROMPT) && all.includes(ASKED); });
		return { ok: carried.length > 0, last: back.length, value: carried[0] };
	}, 120000);
	if (!lastUser(resumed).includes(COMMAND)) throw new Error(`the resumed run is not told which call: ${lastUser(resumed)}`);
	const done = await ctx.waitFor("the approval card ends done", () => {
		const now = card(asked.id);
		return { ok: !!now && now.line.startsWith("Done"), last: now, value: now };
	}, 120000);
	if (done.acts.length) throw new Error(`a done answer still has buttons: ${JSON.stringify(done)}`);
	shot("done.png");

	// 4. The same call a second time in that run is not let through: it is asked about again, and the command ran once.
	const again = await ctx.waitFor("the second identical call asked about again", () => {
		const now = questions().filter((c) => c.id !== asked.id);
		return { ok: now.length === 1 && now[0].needs && now[0].acts.includes("claim"), last: cards(), value: now[0] };
	}, 60000);
	const second = requests().filter((r) => lastUser(r).includes(RESUMED)).map((r) => (r.messages ?? []).filter((m) => m.role === "tool").map(textOf));
	if (!second.some((results) => results.length >= 3 && results.at(-1).includes(ASKED))) throw new Error(`the run was not told its second call was asked about: ${JSON.stringify(second)}`);
	if (ran() !== 1) throw new Error(`the allowed command ran ${ran()} time(s), not once`);

	// 5. No… to the second question: the card says what a no does.
	press(`[data-inb="${again.id}"] [data-act="no"]`);
	press(`[data-inb="${again.id}"] [data-act="reason"][data-reason="Not now"]`);
	await ctx.waitFor("the no says the run is told and the command is refused", () => {
		const now = card(again.id);
		return { ok: !!now && now.text.includes(NO_LINE), last: now };
	}, 15000);
	if (ran() !== 1) throw new Error(`the command ran ${ran()} time(s) after the no`);
	shot("no.png");

	// 6. A conversation the page holds open: the person talks in it, so its window is the page's pi.
	const sessionId = page(`location.pathname`).split("/")[2];
	const lease = () => { try { return JSON.parse(fs.readFileSync(path.join(loops, "leases", `${sessionId}.json`), "utf8")); } catch { return undefined; /* being rewritten */ } };
	ctx.browser("fill", "#input", "hello before the deploy check");
	ctx.browser("press", "Enter");
	await ctx.waitFor("the reply in the page", () => { const text = ctx.browser("get", "text", "body"); return { ok: text.includes(ctx.reply), last: text.slice(-400) }; }, 30000);
	await ctx.waitFor("the page's pi holds the conversation", () => { const l = lease(); return { ok: l?.holder?.page === true && !!l.sessionFile && fs.existsSync(l.sessionFile), last: l }; }, 30000);
	const sessionFile = lease().sessionFile;
	const windowMarker = path.join(ctx.boot.project, WINDOW_MARKER);
	const windowRan = () => (fs.existsSync(windowMarker) ? fs.readFileSync(windowMarker, "utf8").split("\n").filter(Boolean).length : 0);
	const answerRecords = () => (fs.existsSync(path.join(loops, "runs.jsonl")) ? fs.readFileSync(path.join(loops, "runs.jsonl"), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }) : []).filter((r) => r.cause === "answer" && r.sessionId === sessionId);

	// 7. A plain job of that conversation, due now, written as `/cron add` in it leaves it. Its scheduled
	//    turn runs in the page's pi; the call is held for a person, under Needs you, and the turn goes on.
	const plain = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
	plain.jobs.push({ id: PLAIN, name: "deploy-check", schedule: { kind: "every", ms: 24 * 60 * 60_000 }, stateful: false, sessionId, prompt: WINDOW_PROMPT, cwd: ctx.boot.project, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 24 * 60 * 60_000 - 60_000).toISOString() });
	fs.writeFileSync(`${jobsFile}.journey`, JSON.stringify(plain));
	fs.renameSync(`${jobsFile}.journey`, jobsFile);
	const windowQuestion = await ctx.waitFor("the window's question under Needs you", () => {
		const now = cards().filter((c) => c.text.includes(WINDOW_COMMAND));
		return { ok: now.length === 1 && now[0].needs && now[0].acts.includes("claim"), last: cards(), value: now[0] };
	}, 180000);
	const filed = fs.readFileSync(path.join(loops, "inbox.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.id === windowQuestion.id);
	if (filed?.lane !== sessionId || filed?.ask?.session_id !== sessionId) throw new Error(`the window's question is not the conversation's: ${JSON.stringify(filed)}`);
	if (windowRan() !== 0) throw new Error(`the window's command ran before anyone said yes: ${windowRan()} time(s)`);
	if (!requests().some((r) => lastUser(r).includes(WINDOW_PROMPT) && (r.messages ?? []).some((m) => m.role === "tool" && textOf(m).includes(ASKED)))) throw new Error("the scheduled turn was not told its call was asked about");

	// 8. Yes on the page while the scheduled turn still runs: the card says it runs in this conversation after the current turn.
	press(`[data-inb="${windowQuestion.id}"] [data-act="claim"]`);
	// The click's answer says it; once the page draws the card again, it says the answer waits (with
	// why, once the window has met its row). The order in the conversation below proves the rest.
	const approved = await ctx.waitFor("the approved line on the window's question", () => {
		const now = card(windowQuestion.id);
		return { ok: !!now && (now.line === APPROVED || now.line.startsWith(WAITING)), last: now, value: now };
	}, 15000);
	shot("window-approved.png");

	// 9. After the turn, the yes runs in that conversation, in the page's pi: the allowed call runs once,
	//    the card ends Done, and the conversation was never handed to pi-loops in the background.
	const windowDone = await ctx.waitFor("the window's question ends done", () => {
		const now = card(windowQuestion.id);
		return { ok: !!now && now.line.startsWith("Done"), last: now, value: now };
	}, 120000);
	shot("window-done.png");
	if (windowRan() !== 1) throw new Error(`the allowed call ran ${windowRan()} time(s) in the window, not once`);
	const [record, ...more] = answerRecords();
	if (!record || more.length || record.ok !== true || record.grant_used !== true || record.resumed !== sessionFile) throw new Error(`expected one answer record of the conversation, ok, its grant used, in its own file: ${JSON.stringify(answerRecords())}`);
	if (lease()?.holder?.page !== true) throw new Error(`the conversation is no longer the page's: ${JSON.stringify(lease())}`);
	// After the current turn: in the conversation, the answer's turn starts after the scheduled turn's
	// hold ended, and the call that ran is the answer's own.
	const entries = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const callOf = (e, command) => e.message?.role === "assistant" && (e.message.content ?? []).some((c) => c.type === "toolCall" && c.arguments?.command === command);
	const holdCall = entries.find((e) => callOf(e, HOLD))?.message.content.find((c) => c.type === "toolCall").id;
	const heldUntil = entries.findIndex((e) => e.message?.role === "toolResult" && e.message.toolCallId === holdCall);
	const answerAt = entries.findIndex((e) => e.type === "custom_message" && e.customType === "pi-loops:turn" && typeof e.content === "string" && e.content.includes(RESUMED) && e.content.includes(WINDOW_COMMAND));
	const ranAt = entries.findIndex((e, i) => i > answerAt && callOf(e, WINDOW_COMMAND));
	if (heldUntil === -1 || answerAt <= heldUntil || ranAt <= answerAt) throw new Error(`the yes did not run after the current turn, in its own turn: hold ends at ${heldUntil}, the answer's turn at ${answerAt}, its call at ${ranAt}`);

	const evidence = path.join(ctx.dir, "ask.txt");
	fs.writeFileSync(evidence, [`the question: ${JSON.stringify(asked)}`, `the resumed request's last message:\n${lastUser(resumed)}`, `the tool results the resumed run saw: ${JSON.stringify(second)}`, `the answered card: ${JSON.stringify(done)}`, `the question asked again: ${JSON.stringify(again)}`, `${MARKER}: ${ran()} line(s)`, `the window's question: ${JSON.stringify(windowQuestion)}`, `the window's question after the yes: ${JSON.stringify(approved)}`, `the window's answered card: ${JSON.stringify(windowDone)}`, `the window's answer record: ${JSON.stringify(record)}`, `${WINDOW_MARKER}: ${windowRan()} line(s)`].join("\n\n"));
	ctx.addEvidence(evidence);
}
