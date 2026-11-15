import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J11", title = "A terminal opens a conversation while pi-loops answers a scheduled job in it: the turn stops, and the prompt is answered once more, in the terminal", expect = "head", active = true, milestone = "M3", page = "new", tui = true, needs = ["tmux", "agent-browser"];

const JOB = "cron-11111111111111111111111111111111";
const PROMPT = "wait for the build, then say so";
const NOTICE = "pi-loops was answering a scheduled job in this conversation when you opened it, and stopped";

/** The stand-in holds the job's turn open with one `sleep`, in the background and in the terminal alike; every other message gets the reply at once. */
export function seed() {
	return { modelEnv: { FAKE_MODEL_TOOL_SCRIPT: JSON.stringify([{ match: PROMPT, tool: "bash", args: { command: "sleep 40" } }]) } };
}

const jsonl = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }); } catch { return []; /* not written yet */ } };

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	// The conversation the terminal holds, not one the page opened: its holder is a terminal in tui mode.
	const leases = () => fs.readdirSync(path.join(loops, "leases")).filter((f) => f.endsWith(".json")).flatMap((f) => { try { return [JSON.parse(fs.readFileSync(path.join(loops, "leases", f), "utf8"))]; } catch { return []; /* being rewritten */ } });
	const session = leases().find((l) => l.holder?.kind === "terminal" && l.holder.mode === "tui" && l.sessionFile)?.sessionId;
	if (!session) throw new Error(`no conversation is held by the terminal: ${JSON.stringify(leases().map((l) => l.holder))}`);
	const tmux = (...args) => spawnSync("tmux", ["-L", ctx.boot.tmux.socket, ...args], { env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
	const lease = () => { try { return JSON.parse(fs.readFileSync(path.join(loops, "leases", `${session}.json`), "utf8")); } catch { return undefined; /* being rewritten */ } };
	const rows = () => jsonl(path.join(loops, "requests", `${session}.jsonl`)).filter((r) => r.source === `cron:${JOB}`);
	const runs = () => jsonl(path.join(loops, "runs.jsonl")).filter((r) => r.jobId === JOB);
	const sessionFile = lease()?.sessionFile;
	if (!sessionFile) throw new Error(`the terminal's lease names no session file: ${JSON.stringify(lease())}`);
	/** The job's prompts in the conversation, by the id each carries. */
	const prompts = () => jsonl(sessionFile).filter((e) => e.type === "message" && e.message?.role === "user").map((e) => (typeof e.message.content === "string" ? e.message.content : (e.message.content ?? []).map((c) => c.text ?? "").join(""))).filter((t) => t.includes(PROMPT)).map((t) => /^\[Trigger ([^\]]+)\]/.exec(t)?.[1] ?? "no id");

	// 1. The terminal closes: nobody holds the conversation, and pi-loops in the background knows its file.
	tmux("kill-session", "-t", ctx.boot.tmux.session);
	await ctx.waitFor("the terminal's process to end", () => { const holder = lease()?.holder; return { ok: !holder || spawnSync("kill", ["-0", String(holder.pid)], { stdio: "ignore" }).status !== 0, last: holder }; }, 30000);

	// 2. A plain job of that conversation whose slot is due. Written as a person's `/cron add` leaves it.
	const jobsFile = path.join(loops, "jobs.json");
	const store = fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, "utf8")) : { version: 2, jobs: [] };
	store.jobs.push({ id: JOB, name: "build-watch", schedule: { kind: "every", ms: 60 * 60_000 }, stateful: false, sessionId: session, prompt: PROMPT, cwd: ctx.boot.project, enabled: true, catchUp: true, createdAt: new Date(Date.now() - 61 * 60_000).toISOString(), runCount: 0, skippedOverlap: 0 });
	fs.writeFileSync(`${jobsFile}.journey`, JSON.stringify(store));
	fs.renameSync(`${jobsFile}.journey`, jobsFile);

	// 3. pi-loops in the background starts the turn: the job's row has a claim, and the lease names the run.
	//    It leaves a file that was written in the last two minutes alone, so this can take a few ticks.
	const claimed = await ctx.waitFor("the held turn's claim", () => { const row = rows().find((r) => r.run); return { ok: !!row && lease()?.holder?.kind === "host", last: { rows: rows(), holder: lease()?.holder }, value: row }; }, 300000);
	await ctx.waitFor("the prompt in the conversation", () => ({ ok: prompts().includes(claimed.id), last: prompts() }), 30000);
	const status = spawnSync(path.join(ctx.boot.root, "bin", "pi-loops"), ["status"], { cwd: ctx.boot.project, env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
	if (!status.stdout.includes("running build-watch")) throw new Error(`pi-loops status does not list the turn:\n${status.stdout}${status.stderr}`);

	// 4. A person opens the conversation in a terminal while the turn runs.
	const command = `${path.join(ctx.boot.root, "bin", "pi-loops")} --tui --no-extensions -e ${path.join(ctx.boot.root, "product")} --model fake/fake-model --session ${sessionFile}`;
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "again", "-x", "200", "-y", "50", "-c", ctx.boot.project, command);
	const screen = () => tmux("capture-pane", "-p", "-S", "-200", "-t", "again").stdout ?? "";
	const took = await ctx.waitFor("the terminal to hold the conversation", () => { const holder = lease()?.holder; return { ok: holder?.kind === "terminal", last: holder, value: Date.parse(holder?.acquiredAt ?? "") }; }, 60000);

	// 5. The turn stops: its record says it was handed back, by no person.
	const record = await ctx.waitFor("the record of the turn that was taken back", () => { const r = runs().find((x) => x.runId === claimed.run.id); return { ok: !!r, last: runs(), value: r }; }, 30000);
	if (record.aborted !== true || record.stoppedBy !== undefined) throw new Error(`the record does not say the turn was handed back: ${JSON.stringify(record)}`);
	const said = await ctx.waitFor("the window's notice", () => { const s = screen(); return { ok: s.replace(/\s+/g, " ").includes(NOTICE), last: s, value: s }; }, 30000);

	// 6. The prompt is asked once more, in the terminal: the turn's own prompt was written, so a successor row asks again.
	const again = await ctx.waitFor("the successor's prompt in the conversation", () => { const ids = prompts(); return { ok: ids.length === 2 && ids[0] === claimed.id && ids[1] !== claimed.id, last: ids, value: ids }; }, 120000);
	await ctx.waitFor("the job's queue to be empty", () => ({ ok: rows().length === 0, last: rows() }), 120000);
	// The successor's own answer: an assistant message that ends the turn, after the successor's prompt.
	const entries = () => jsonl(sessionFile).filter((e) => e.type === "message");
	const text = (e) => (typeof e.message.content === "string" ? e.message.content : (e.message.content ?? []).map((c) => c.text ?? "").join(""));
	await ctx.waitFor("the successor's answer in the conversation", () => {
		const all = entries();
		const asked = all.findIndex((e) => e.message.role === "user" && text(e).includes(`[Trigger ${again[1]}]`));
		const answered = all.slice(asked + 1).some((e) => e.message.role === "assistant" && text(e).includes(ctx.reply));
		return { ok: asked !== -1 && answered, last: all.slice(-4).map((e) => `${e.message.role}: ${text(e).slice(0, 60)}`) };
	}, 180000);
	if (runs().length !== 1) throw new Error(`the background ran the job again: ${JSON.stringify(runs())}`);
	// What the background wrote into the conversation after the window took it: what pi writes when a
	// turn is aborted, and no more. The result of the tool that was running, and the turn's error.
	const all = entries();
	const first = all.findIndex((e) => e.message.role === "user" && text(e).includes(`[Trigger ${claimed.id}]`));
	const second = all.findIndex((e) => e.message.role === "user" && text(e).includes(`[Trigger ${again[1]}]`));
	// Counted: every answer or tool result from the first prompt to the end of the file that was
	// written after the take-back and does not follow from the successor's prompt. So a second
	// answer by the background is counted wherever it is: after the successor's prompt, or on the
	// branch that leads to it.
	const parents = new Map(jsonl(sessionFile).map((e) => [e.id, e.parentId]));
	const followsSuccessor = (e) => { for (let at = e.id; at; at = parents.get(at)) if (at === all[second].id) return true; return false; };
	const late = all.slice(first + 1).filter((e) => (e.message.role === "assistant" || e.message.role === "toolResult") && !followsSuccessor(e) && Date.parse(e.timestamp ?? "") >= took).map((e) => `${e.message.role}${e.message.stopReason ? `(${e.message.stopReason})` : ""}: ${text(e).slice(0, 60)}`);
	if (late.length > 2 || late.some((line) => !/^(toolResult|assistant\(error\)|assistant\(aborted\))/.test(line))) throw new Error(`the background wrote more than the end of an aborted turn after the take-back: ${JSON.stringify(late)}`);
	const job = JSON.parse(fs.readFileSync(jobsFile, "utf8")).jobs.find((j) => j.id === JOB);
	if (job?.runCount !== 1 || job.consecutiveFailures) throw new Error(`the slot was counted twice, or the hand-back counted as a failure: ${JSON.stringify(job)}`);

	const evidence = path.join(ctx.dir, "take-back.txt");
	fs.writeFileSync(evidence, [`status while the turn ran:\n${status.stdout}${status.stderr}`, `claim ${JSON.stringify(claimed.run)}`, `record ${JSON.stringify(record)}`, `prompts in the conversation, by id: ${JSON.stringify(again)}`, `what the background wrote into the conversation after the take-back (${late.length}): ${JSON.stringify(late)}`, `job ${JSON.stringify(job)}`, `terminal:\n${said}`].join("\n\n"));
	ctx.addEvidence(evidence);
	const final = path.join(ctx.dir, "terminal-after.txt");
	fs.writeFileSync(final, screen());
	ctx.addEvidence(final);
}
