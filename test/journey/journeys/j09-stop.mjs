import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J9", title = "Stop a running background run from the page", expect = "head", active = true, milestone = "M7", page = "new", tui = false, needs = ["agent-browser"];

const LOOP = "cron-9a9a9a9a";
const SPARE = "cron-9b9b9b9b";
const job = (id, name, cwd) => ({ id, name, schedule: { kind: "every", ms: 10 * 60_000 }, stateful: true, prompt: "wait for the build, then report", cwd, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 20 * 60_000).toISOString(), runCount: 0, skippedOverlap: 0 });

/** Two loops due at once; the stand-in answers each run with one `sleep 120`, which holds it open until stopped. */
export function seed(dirs) {
	fs.writeFileSync(path.join(dirs.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [job(LOOP, "pr-watch", dirs.project), job(SPARE, "nightly", dirs.project)] }));
	return { modelEnv: { FAKE_MODEL_TOOL_COMMAND: "sleep 120" } };
}

const jsonl = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }); } catch { return []; /* not written yet */ } };

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const jobs = () => { try { return JSON.parse(fs.readFileSync(path.join(loops, "jobs.json"), "utf8")).jobs; } catch { return []; /* being rewritten */ } };
	const marker = (id) => jobs().find((j) => j.id === id)?.running;
	const runs = (id) => jsonl(path.join(loops, "runs.jsonl")).filter((r) => r.jobId === id);
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const row = (id) => `#auto [data-loopx="${id}"]`;
	const rowText = (id) => page(`(document.querySelector(${JSON.stringify(row(id))}) || {}).textContent || ""`);
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};

	// 1. Both loops are running in the background, each held by its sleep.
	const running = await ctx.waitFor("the loop's running marker", () => ({ ok: !!marker(LOOP)?.runId && !!marker(SPARE)?.runId, last: jobs().map((j) => [j.id, j.running]), value: marker(LOOP) }), 90000);
	ctx.browser("set", "viewport", "1280", "800");
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	await ctx.waitFor("Stop this run on the loop's row", () => page(`!!document.querySelector(${JSON.stringify(`${row(LOOP)} button[data-act=stop]`)})`), 30000);
	shot("stop-row.png");

	// 2. Stop this run, then Keep running: the confirm closes, nothing is sent, the run goes on.
	ctx.browser("click", `${row(LOOP)} button[data-act=stop]`);
	const asked = await ctx.waitFor("the confirm", () => { const t = rowText(LOOP); return { ok: t.includes("Stop this run of pr-watch?"), last: t, value: t }; }, 10000);
	if (!asked.includes("The next run happens on schedule.")) throw new Error(`the confirm does not say when it runs next: ${asked}`);
	ctx.browser("click", `${row(LOOP)} button[data-act=stop-cancel]`);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	if (marker(LOOP)?.runId !== running.runId) throw new Error(`Keep running stopped the run: ${JSON.stringify(marker(LOOP))}`);
	if (runs(LOOP).length) throw new Error(`a record after Keep running: ${JSON.stringify(runs(LOOP))}`);
	shot("stop-cancel.png");

	// 3. Stop this run, then Stop it: the record says a person stopped it, within 5 s.
	ctx.browser("click", `${row(LOOP)} button[data-act=stop]`);
	await ctx.waitFor("the confirm again", () => page(`!!document.querySelector(${JSON.stringify(`${row(LOOP)} button[data-act=stop-confirm]`)})`), 10000);
	const clicked = Date.now();
	ctx.browser("click", `${row(LOOP)} button[data-act=stop-confirm]`);
	const record = await ctx.waitFor("the stopped run's record", () => { const r = runs(LOOP).find((x) => x.runId === running.runId); return { ok: !!r, last: runs(LOOP), value: r }; }, 10000);
	const tookMs = Date.now() - clicked;
	if (tookMs > 5000) throw new Error(`the run took ${tookMs}ms to end`);
	if (record.stoppedBy !== "person" || record.aborted !== true || record.error !== "stopped by a person") throw new Error(`the record does not say a person stopped it: ${JSON.stringify(record)}`);
	await ctx.waitFor("the marker gone", () => ({ ok: !marker(LOOP), last: marker(LOOP) }), 10000);
	await ctx.waitFor("the row says so", () => { const t = rowText(LOOP); return { ok: t.includes("Stopped by you."), last: t }; }, 15000);
	shot("stop.png");

	// 4. Two ticks later nothing has run it again: the slot was spent, and the next run is on schedule.
	await new Promise((resolve) => setTimeout(resolve, 65000));
	if (marker(LOOP) || runs(LOOP).length !== 1) throw new Error(`the stopped loop ran again: ${JSON.stringify({ marker: marker(LOOP), runs: runs(LOOP) })}`);
	const after = jobs().find((j) => j.id === LOOP);
	if (!after?.lastFiredAt || after.runCount !== 0) throw new Error(`the slot was handed back or counted: ${JSON.stringify(after)}`);
	const evidence = path.join(ctx.dir, "stop.txt");
	fs.writeFileSync(evidence, `clicked -> record ${tookMs}ms\nrecord ${JSON.stringify(record)}\nrows after two ticks ${runs(LOOP).length}\njob ${JSON.stringify(after)}\n`);
	ctx.addEvidence(evidence);

	// 5. A phone: the other loop's confirm fits, nothing scrolls sideways, buttons are at least 32 px tall.
	ctx.browser("set", "viewport", "390", "844");
	ctx.browser("click", "#tabLoops");
	await ctx.waitFor("the Loops pane", () => page(`document.body.dataset.pane === "loops"`), 10000);
	if (!marker(SPARE)) throw new Error("the second loop is no longer running");
	ctx.browser("click", `${row(SPARE)} button[data-act=stop]`);
	await ctx.waitFor("the confirm on a phone", () => page(`!!document.querySelector(${JSON.stringify(`${row(SPARE)} button[data-act=stop-confirm]`)})`), 10000);
	const sizes = page(`({ page: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll(${JSON.stringify(`${row(SPARE)} button`)})].map((b) => { const r = b.getBoundingClientRect(); return { h: r.height, right: r.right }; }) })`);
	if (sizes.page > 390) throw new Error(`the page scrolls sideways at 390px: ${JSON.stringify(sizes)}`);
	if (sizes.buttons.length < 2 || sizes.buttons.some((b) => b.h < 32 || b.right > 390)) throw new Error(`a button is under 32px or off the screen: ${JSON.stringify(sizes)}`);
	shot("phone-stop.png");
	ctx.browser("click", `${row(SPARE)} button[data-act=stop-cancel]`);
}
