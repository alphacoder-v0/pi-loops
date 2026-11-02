import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export const id = "J4", title = "Loop runs and run cards in the conversation", expect = "trunk", active = true, page = "new", tui = true, needs = ["tmux"];
export function seed(dirs) {
	fs.writeFileSync(path.join(dirs.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-journey-run-card", name: "journey-card", schedule: { kind: "every", ms: 60000 }, stateful: true, prompt: "report the journey run", cwd: dirs.project, enabled: false, catchUp: true, createdAt: new Date(Date.now() + 120000).toISOString(), runCount: 0, skippedOverlap: 0 }] }));
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; /* the lease holder exited */ } };

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
	const runsFile = path.join(loops, "runs.jsonl");
	const entry = await ctx.waitFor("loop run", () => {
		try { return fs.readFileSync(runsFile, "utf8").split("\n").filter(Boolean).map(JSON.parse).find((row) => row.jobId === "cron-journey-run-card"); } catch { return undefined; /* run log may be absent or being appended */ }
	}, 60000);
	if (!entry.ok || entry.forSession !== ctx.boot.sessionId) throw new Error("the loop run failed or belongs to another conversation");
	const leaseFile = path.join(loops, "leases", `${ctx.boot.sessionId}.json`);
	const card = await ctx.waitFor("run card in creating conversation and terminal", () => {
		try {
			const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
			const liveTerminal = lease.holder?.kind === "terminal" && lease.holder.mode === "tui" && alive(lease.holder.pid);
			const conversation = fs.readFileSync(lease.sessionFile, "utf8");
			const cardRow = conversation.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.type === "custom" && row.customType === "pi-loops:view" && row.data?.title?.startsWith("cron journey-card"));
			const screen = ctx.term.screen();
			return liveTerminal && cardRow && screen.includes("cron journey-card") ? { conversation, screen } : false;
		} catch { return false; /* session lease or transcript may be mid-write */ }
	}, 60000);
	const conversationFile = path.join(ctx.dir, "conversation.txt");
	const screenFile = path.join(ctx.dir, "terminal.txt");
	fs.writeFileSync(conversationFile, card.conversation.slice(-20000));
	fs.writeFileSync(screenFile, card.screen);
	ctx.addEvidence(conversationFile);
	ctx.addEvidence(screenFile);
}
