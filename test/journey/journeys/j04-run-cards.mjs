import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export const id = "J4", title = "Loop runs and run cards in the conversation", expect = "trunk", active = true, page = "new", tui = true, needs = ["tmux"];
export function seed(dirs) {
	fs.writeFileSync(path.join(dirs.loops, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "cron-journey-run-card", name: "journey-card", schedule: { kind: "every", ms: 60000 }, stateful: true, prompt: "report the journey run", cwd: dirs.project, enabled: true, catchUp: true, createdAt: new Date(Date.now() + 120000).toISOString(), runCount: 0, skippedOverlap: 0 }] }));
}
export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const jobsFile = path.join(loops, "jobs.json");
	const store = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
	store.jobs[0].createdAt = new Date(Date.now() - 120000).toISOString();
	store.jobs[0].createdBy = { sessionId: ctx.boot.sessionId, cwd: ctx.boot.project };
	fs.writeFileSync(jobsFile, JSON.stringify(store));
	const start = spawnSync(path.join(ctx.boot.root, "bin", "pi-loops"), ["start"], { cwd: ctx.boot.project, env: ctx.boot.env, encoding: "utf8" });
	if (start.error) throw start.error;
	const runsFile = path.join(loops, "runs.jsonl");
	const entry = await ctx.waitFor("loop run", () => {
		try { return fs.readFileSync(runsFile, "utf8").split("\n").filter(Boolean).map(JSON.parse).find((row) => row.jobId === "cron-journey-run-card"); } catch { return undefined; }
	}, 60000);
	if (!entry.ok) throw new Error("the loop run failed");
	const leaseFile = path.join(loops, "leases", `${ctx.boot.sessionId}.json`);
	const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
	if (!lease.sessionFile) throw new Error("the creating conversation has no session file");
	const conversation = await ctx.waitFor("run card in creating conversation", () => {
		try { const text = fs.readFileSync(lease.sessionFile, "utf8"); return text.includes("cron journey-card") ? text : false; } catch { return false; }
	}, 60000);
	const evidence = path.join(ctx.dir, "conversation.txt");
	fs.writeFileSync(evidence, conversation.slice(-20000));
	ctx.addEvidence(evidence);
	process.stdout.write(`SHOT J4 ${evidence}\n`);
}
