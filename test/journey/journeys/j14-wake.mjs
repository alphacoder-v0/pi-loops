import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J14", title = "A loop wakes itself once, and stops", expect = "head", active = true, milestone = "M7", page = "new", tui = true, needs = ["agent-browser"];

const LOOP = "wake-check";
const PROMPT = "look at the release queue";
const NOTE = "look again";
const WOKEN = `you asked to be woken: ${NOTE}`;
const SET = "set: this loop wakes at";

const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c?.text ?? "").join(""));

/**
 * The stand-in's script. The loop's first run calls wake_me once, then replies. The run the wake
 * starts reads the note under [woken] and only replies, so it sets no wake.
 */
export function seed() {
	return {
		answer: (messages) => {
			const last = messages.findLastIndex((m) => m.role === "user");
			if (last === -1) return undefined;
			const text = textOf(messages[last]);
			if (!text.includes(PROMPT) || text.includes(WOKEN)) return undefined;
			return messages.slice(last).some((m) => m.role === "tool") ? undefined : { tool: "wake_me", args: { when: "in 1m", note: NOTE } };
		},
	};
}

const jsonl = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }); } catch { return []; /* not written yet */ } };

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const jobs = () => { try { return JSON.parse(fs.readFileSync(path.join(loops, "jobs.json"), "utf8")).jobs; } catch { return []; /* not written yet */ } };
	const clock = (job) => { try { return JSON.parse(fs.readFileSync(path.join(loops, "clock.json"), "utf8")).jobs?.[job]; } catch { return undefined; /* being rewritten */ } };
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const modelLog = path.join(ctx.boot.root, "logs", "model.jsonl");
	const lastUser = (r) => textOf([...(r.messages ?? [])].reverse().find((x) => x.role === "user"));
	const loopAsks = () => jsonl(modelLog).filter((r) => lastUser(r).includes(PROMPT));
	const evidence = (name, text) => {
		const file = path.join(ctx.dir, name);
		fs.writeFileSync(file, text);
		ctx.addEvidence(file);
	};
	const terminal = (what, re) => {
		ctx.term.clearHistory();
		ctx.term.type(what);
		ctx.term.press("Enter");
		return ctx.waitFor(`${what} on the screen`, () => { const s = ctx.term.screen({ history: 200, joined: true }); return { ok: re.test(s), last: s, value: s }; }, 20000);
	};

	// 1. A loop whose schedule is a day away, added in the terminal and run once by hand.
	ctx.term.type(`/cron add --stateful --name ${LOOP} "every 1d" ${PROMPT}`);
	ctx.term.press("Enter");
	const loop = await ctx.waitFor("the loop in jobs.json", () => { const j = jobs().find((x) => x.name === LOOP); return { ok: !!j, last: jobs(), value: j }; }, 20000);
	const runs = () => jsonl(path.join(loops, "runs.jsonl")).filter((r) => r.jobId === loop.id);
	ctx.term.type(`/cron run ${LOOP}`);
	ctx.term.press("Enter");

	// 2. The first run calls wake_me: its transcript has the tool's line, and clock.json the wake.
	const first = await ctx.waitFor("the loop's first run", () => ({ ok: runs().length >= 1, last: runs().length, value: runs()[0] }), 90000);
	if (!first.ok || !first.sessionFile) throw new Error(`the first run failed or has no transcript: ${JSON.stringify(first)}`);
	const results = jsonl(first.sessionFile).filter((e) => e.message?.role === "toolResult" && e.message.toolName === "wake_me").map((e) => textOf(e.message));
	if (results.length !== 1 || !results[0].startsWith(SET) || !results[0].includes(`("${NOTE}")`)) throw new Error(`the transcript has no wake_me success line: ${JSON.stringify(results)}`);
	const wake = clock(loop.id)?.followup;
	if (!wake) throw new Error(`clock.json has no wake for the loop: ${JSON.stringify(clock(loop.id))}`);

	// 3. Before the wake: /cron says it, and the page's loop row shows it with a ✕.
	const nextWake = new RegExp(`next wake \\d\\d:\\d\\d, asked by the loop: "${NOTE}"`);
	const listing = await terminal("/cron", nextWake);
	evidence("cron.txt", listing);
	ctx.browser("set", "viewport", "1280", "800");
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	const row = await ctx.waitFor("the page's loop row shows the wake with a ✕", () => {
		const r = page(`[...document.querySelectorAll("#auto [data-loopx]")].map((e) => ({ text: e.textContent, clear: e.querySelectorAll('[data-act="wake-clear"]').length }))`);
		const hit = r.find((x) => nextWake.test(x.text));
		return { ok: !!hit && hit.clear === 1, last: r, value: hit };
	}, 30000);
	if (runs().length !== 1) throw new Error(`the loop ran again before its wake: ${runs().length} runs`);
	ctx.browser("scrollintoview", `#auto [data-key="job:${loop.id}"]`);
	const shotFile = path.join(ctx.dir, "wake-row.png");
	ctx.browser("screenshot", shotFile);
	ctx.addEvidence(shotFile);

	// 4. The wake starts the second run: its prompt has the note under [woken], and /cron runs says it woke itself.
	await ctx.waitFor("the run the wake started", () => ({ ok: runs().length >= 2, last: { runs: runs().length, clock: clock(loop.id) } }), 120000);
	const second = runs()[1];
	if (!second.ok) throw new Error(`the woken run failed: ${JSON.stringify(second)}`);
	const woken = loopAsks().find((r) => lastUser(r).includes("[woken]") && lastUser(r).includes(WOKEN));
	if (!woken) throw new Error("the woken run's prompt has no [woken] block with the note");
	const ran = await terminal(`/cron runs ${LOOP}`, new RegExp(`, woke itself: "${NOTE}"`));
	evidence("cron-runs.txt", ran);

	// 5. The woken run set no wake: nothing more starts. Past a minute and a tick, still two runs and no wake.
	if (clock(loop.id)?.followup) throw new Error(`a wake is left after the woken run: ${JSON.stringify(clock(loop.id))}`);
	await new Promise((resolve) => setTimeout(resolve, 95000));
	if (runs().length !== 2) throw new Error(`the loop ran ${runs().length} times, not twice`);
	if (clock(loop.id)?.followup) throw new Error(`a wake appeared after the woken run: ${JSON.stringify(clock(loop.id))}`);
	// The listing printed after `/cron runs`: the screen still holds the earlier one above it.
	const listed = (s) => { const at = s.lastIndexOf(`Recent runs of ${LOOP}`); return at === -1 ? "" : s.slice(at); };
	const after = listed(await terminal("/cron", { test: (s) => /^\s+\d+\. cron-\S+ "wake-check"/m.test(listed(s)) }));
	if (/next wake/.test(after)) throw new Error(`/cron still shows a wake after the woken run:\n${after}`);
	evidence("wake.txt", [`the wake_me result: ${results[0]}`, `clock.json after the first run: ${JSON.stringify(wake)}`, `the page row: ${JSON.stringify(row)}`, `the woken run's prompt:\n${lastUser(woken)}`, `runs ${JSON.stringify(runs().map((r) => ({ startedAt: r.startedAt, ok: r.ok, woken: r.woken })))}`, `/cron at the end:\n${after}`].join("\n\n"));
}
