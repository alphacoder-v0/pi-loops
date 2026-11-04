import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export const id = "J4", title = "Five runs of a loop: three cards in the conversation, five in the strip and the panel", expect = "head", active = true, page = "new", tui = true, needs = ["tmux", "agent-browser"];
const JOB = "cron-journey-run-card";
export function seed(dirs) {
	fs.writeFileSync(path.join(dirs.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: JOB, name: "journey-card", schedule: { kind: "every", ms: 60000 }, stateful: true, prompt: "report the journey run", cwd: dirs.project, enabled: false, catchUp: true, createdAt: new Date(Date.now() + 120000).toISOString(), runCount: 0, skippedOverlap: 0 }] }));
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; /* the lease holder exited */ } };
const jsonl = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }); } catch { return []; /* not written yet */ } };

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const jobsFile = path.join(loops, "jobs.json");
	const store = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
	store.jobs[0].enabled = true;
	store.jobs[0].createdAt = new Date(Date.now() - 120000).toISOString();
	store.jobs[0].createdBy = { sessionId: ctx.boot.sessionId, cwd: ctx.boot.project };
	fs.writeFileSync(jobsFile, JSON.stringify(store));
	const start = spawnSync(path.join(ctx.boot.root, "bin", "pi-loops"), ["start"], { cwd: ctx.boot.project, env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
	if (start.error) throw start.error;
	if (start.status !== 0 && !/already running|a start is in progress/.test(start.stdout)) throw new Error(`pi-loops start exited ${start.status}: ${start.stdout}${start.stderr}`);
	const runsFile = path.join(loops, "runs.jsonl");
	const runs = () => jsonl(runsFile).filter((r) => r.jobId === JOB);
	await ctx.waitFor("the loop's first run", () => ({ ok: runs().length >= 1, last: runs().length }), 90000);
	// Four more, asked from the terminal as a person would (`/cron run`), one after another.
	for (let n = 2; n <= 5; n++) {
		await ctx.waitFor(`run ${n - 1} finished and nothing running`, () => {
			const job = JSON.parse(fs.readFileSync(jobsFile, "utf8")).jobs.find((j) => j.id === JOB);
			return { ok: runs().length >= n - 1 && !job?.running, last: { runs: runs().length, running: job?.running } };
		}, 60000);
		if (runs().length >= n) continue; // the clock ran it already
		ctx.term.send("/cron run journey-card", "Enter");
		await ctx.waitFor(`run ${n}`, () => ({ ok: runs().length >= n, last: runs().length }), 60000);
	}
	const five = runs().slice(0, 5);
	if (five.map((r) => r.ordinal).join(",") !== "1,2,3,4,5" || five.some((r) => !r.ok || r.forSession !== ctx.boot.sessionId)) throw new Error(`the five runs are not ordinals 1..5 of this conversation's loop: ${JSON.stringify(five.map((r) => [r.ordinal, r.ok, r.forSession]))}`);
	const leaseFile = path.join(loops, "leases", `${ctx.boot.sessionId}.json`);
	const cards = await ctx.waitFor("three cards in the creating conversation, and the panel's Runs", () => {
		const screen = ctx.term.screen();
		try {
			const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
			const liveTerminal = lease.holder?.kind === "terminal" && lease.holder.mode === "tui" && alive(lease.holder.pid);
			const rows = jsonl(lease.sessionFile).filter((row) => row.type === "custom" && row.customType === "pi-loops:view" && row.data?.title?.startsWith("cron journey-card"));
			return { ok: liveTerminal && rows.length >= 3 && /Runs/.test(screen), last: { rows: rows.length, screen }, value: { rows, screen, file: lease.sessionFile } };
		} catch { return { ok: false, last: screen }; /* lease or transcript may be mid-write */ }
	}, 60000);
	// One more tick for a fourth card to show up if it was going to.
	await new Promise((r) => setTimeout(r, 35000));
	const after = jsonl(cards.file).filter((row) => row.type === "custom" && row.customType === "pi-loops:view" && row.data?.title?.startsWith("cron journey-card"));
	if (after.length !== 3) throw new Error(`the conversation has ${after.length} run cards, not 3: ${after.map((r) => r.data.title).join(" | ")}`);
	const screenFile = path.join(ctx.dir, "terminal.txt");
	fs.writeFileSync(screenFile, ctx.term.screen());
	ctx.addEvidence(screenFile);
	const conversationFile = path.join(ctx.dir, "conversation.txt");
	fs.writeFileSync(conversationFile, after.map((r) => r.data.title).join("\n") + "\n");
	ctx.addEvidence(conversationFile);

	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};
	// The conversation that created the loop, where its three cards are: only there do they say "in chat".
	ctx.browser("open", `${ctx.boot.url}c/${ctx.boot.sessionId}/?token=${ctx.boot.token}`);
	await ctx.waitFor("the strip says five runs", () => {
		const text = page(`document.getElementById("activitySlot").textContent`);
		return { ok: /5 runs today/.test(text), last: text };
	}, 30000);
	shot("strip-closed.png");
	ctx.browser("click", "#activitySlot .strip-head");
	const rows = await ctx.waitFor("the strip lists five runs", () => {
		const now = page(`[...document.querySelectorAll("#activitySlot li.act")].map((li) => li.textContent)`);
		return { ok: now.filter((t) => t.includes("journey-card")).length === 5, last: now, value: now };
	}, 15000);
	if (rows.filter((t) => t.includes("in chat")).length !== 3) throw new Error(`three rows should say the run is in the conversation: ${rows.join(" | ")}`);
	shot("strip-open.png");
	ctx.browser("click", "#activitySlot .strip-head");
	ctx.browser("set", "viewport", "390", "844");
	ctx.browser("open", `${ctx.boot.pageUrl}?token=${ctx.boot.token}#chat`);
	const phone = await ctx.waitFor("the strip on a phone", () => {
		const now = page(`{ h: document.querySelector("#activitySlot .strip-head")?.offsetHeight ?? 0, wide: document.documentElement.scrollWidth, width: window.innerWidth }`);
		return { ok: now.h > 0, last: now, value: now };
	}, 30000);
	if (phone.h > 44) throw new Error(`the closed strip is ${phone.h} px tall at 390 px: more than one line`);
	if (phone.wide > phone.width) throw new Error(`the page scrolls sideways at 390 px: ${phone.wide} > ${phone.width}`);
	shot("phone-strip.png");
}
