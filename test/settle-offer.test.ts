/**
 * What a terminal window offers when a turn settles (design stage 5d, 6.3, 6.4): its conversation's
 * open questions and proposals, one selector at a time. The answers go through the real
 * `personAnswers` and `askProposal` over real stores; pi's selector is stood in for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { type PersonAnswers, personAnswers } from "../src/answers.ts";
import { questionFinding } from "../src/ask.ts";
import type { InboxEntry } from "../src/inbox.ts";
import { stamp } from "../src/schedule.ts";
import { type Offer, type OfferDeps, type SettleInput, offerAtSettle, oneRunAtATime, settleOffers } from "../src/settle-offer.ts";
import type { LoopJob } from "../src/store.ts";
import { openStores } from "../src/stores.ts";
import type { Proposal } from "../src/watch-plan.ts";
import { tmp } from "./tmp.ts";

const HERE = "0199aaaa-0000-7000-8000-0000000000a1";
const OTHER = "0199aaaa-0000-7000-8000-0000000000b2";
const JOB = "cron-0123456789abcdef0123456789abcdef";
const BY = { pid: process.pid, instance: "test", version: "0" };
const CMD = "sudo systemctl restart api";

const question = (id: string, over: Partial<InboxEntry> = {}, lane: string = HERE): InboxEntry => ({
	id, created_at: "2026-11-20T10:00:00.000Z", status: "new", kind: "checkpoint", source: "cron:deploy-check", run_id: "run-1", cwd: "/p", text: "Run it?", verified: null, dismiss_reason: null, job_id: JOB,
	ask: { kind: "call", id: `ask-${id}`, lane: lane as any, session_id: HERE, title: 'The scheduled prompt "deploy-check" asks to run a command', call: { tool: "bash", tool_call_id: "c1", command: CMD, input_sha256: "a".repeat(64), reason: "sudo invocation" }, created_at: "2026-11-20T10:00:00.000Z" },
	...over,
});
const proposedJob = (id: string, at: string, session = HERE, over: Partial<LoopJob> = {}): LoopJob =>
	({ id, name: id.replace(/^cron-/, ""), schedule: { kind: "every", ms: 600_000 }, stateful: true, prompt: "report new pull requests", cwd: "/p", enabled: false, catchUp: true, createdAt: at, proposed: { at, session }, ...over }) as LoopJob;
const asJob = (job: LoopJob): Proposal => ({ kind: "schedule", job });
const ready = { sessionId: HERE, held: true, idle: true, queued: 0, mode: "tui", hasUI: true };
const input = (over: Partial<SettleInput> = {}): SettleInput => ({ ...ready, findings: [], proposals: [], offered: new Set(), ...over });
const ids = (offers: Offer[]) => offers.map((o) => (o.kind === "question" ? o.finding.id : o.proposal.kind === "schedule" ? o.proposal.job.id : o.proposal.rule.id));

test("settleOffers offers this conversation's open questions, then its proposals, each oldest first, and nothing when the window may not ask", () => {
	const findings = [
		question("inb-late", { created_at: "2026-11-20T10:05:00.000Z" }),
		question("inb-early", { created_at: "2026-11-20T10:01:00.000Z" }),
		question("inb-other", {}, OTHER),
		question("inb-loop", {}, "@cron-0123456789abcdef0123456789abcdef"),
		question("inb-answered", { status: "claimed" }),
		question("inb-dismissed", { status: "dismissed" }),
		{ ...question("inb-plain"), ask: undefined },
		question("inb-shown"),
	];
	const proposals = [
		asJob(proposedJob("cron-late", "2026-11-20T09:30:00.000Z")),
		{ kind: "rule", rule: { id: "dyn-early", condition: "~/x appears", action: "say so", cwd: "/p", enabled: false, fireOnce: true, promoteToChat: true, createdAt: "2026-11-20T09:00:00.000Z", proposed: { at: "2026-11-20T09:00:00.000Z", session: HERE } } } as unknown as Proposal,
		asJob(proposedJob("cron-other", "2026-11-20T08:00:00.000Z", OTHER)),
		asJob({ ...proposedJob("cron-enabled", "2026-11-20T08:00:00.000Z"), enabled: true, proposed: undefined }),
		asJob(proposedJob("cron-shown", "2026-11-20T08:00:00.000Z")),
	];
	const offered = new Set(["inb-shown", "cron-shown"]);
	assert.deepEqual(ids(settleOffers(input({ findings, proposals, offered }))), ["inb-early", "inb-late", "dyn-early", "cron-late"]);
	for (const [why, over] of [["not held", { held: false }], ["not idle", { idle: false }], ["a row queued", { queued: 1 }], ["the page's pi", { mode: "rpc" }], ["no UI", { hasUI: false }], ["no conversation", { sessionId: undefined }]] as const) {
		assert.deepEqual(settleOffers(input({ findings, proposals, ...over })), [], why);
	}
});

/** A loops directory with one conversation's question, the real answers, and a selector that answers from a script. */
function world(answersOf: (string | undefined)[]) {
	const dir = tmp("pi-loops-settle-offer-");
	const stores = openStores(dir);
	const conversation = path.join(dir, `${HERE}.jsonl`);
	fs.writeFileSync(conversation, "");
	const real = personAnswers({ inbox: stores.inbox, requests: stores.requests, jobs: stores.jobs, audit: stores.rules, sessionFile: (id) => (id === HERE ? conversation : undefined), self: () => BY, now: Date.now, log: () => undefined });
	const said: [string, string][] = [];
	const say: PersonAnswers["say"] = (id, word, from, opts) => {
		said.push([id, word]);
		return real.say(id, word, from, opts);
	};
	const shown: { title: string; options: string[] }[] = [];
	const printed: string[] = [];
	const offered = new Set<string>();
	const state = { ok: true };
	const deps: OfferDeps = {
		select: async (title, options) => {
			shown.push({ title, options });
			return answersOf.shift();
		},
		say: (id, word) => say(id, word, { by: "terminal", session: HERE }),
		proposals: { stores: { jobs: stores.jobs, rules: stores.rules, requests: stores.requests }, ctx: { now: Date.now, by: BY, actor: "slash", auditJob: () => undefined, pollSecs: 600 } },
		loopName: (id) => (id === JOB ? "deploy-check" : undefined),
		refused: (id, refusal) => `inbox entry ${id} ${refusal.refused === "already" ? `was already ${refusal.status}` : "is already answered"}`,
		stillOk: () => state.ok,
		offered,
		print: (line) => void printed.push(line),
	};
	const file = async () => {
		const made = questionFinding({ tool: "bash", tool_call_id: "c1", command: CMD, input_sha256: "a".repeat(64), reason: "sudo invocation" }, { lane: HERE, sessionId: HERE, sessionFile: conversation, cap: { cwd: dir, model: null, thinking: null, tools: "session", builtinTools: "session", timeoutMs: 1000 } as any }, { source: "cron:deploy-check", run_id: "run-1", cwd: dir, job_id: JOB, session_id: HERE, who: "deploy-check" }, stamp(Date.now()));
		return stores.inbox.fileOnce(made.entry, made.id);
	};
	const finding = (id: string) => stores.inbox.list().find((f) => f.id === id)!;
	return { dir, stores, deps, said, shown, printed, offered, state, file, finding };
}

test("a question's selector has design 6.4's title, lines and options; Yes and No go through say once and print their line, and Esc says nothing", async () => {
	const title = ["Allow this once?", 'The scheduled prompt "deploy-check" asked to run bash: sudo invocation.', CMD, "It went on without it. Yes runs it once in a new turn. Esc leaves the question open (/inbox)."].join("\n");
	const yes = world(["Yes, run it once"]);
	const asked = await yes.file();
	assert.deepEqual(await offerAtSettle([{ kind: "question", finding: asked }], yes.deps), [{ kind: "question", id: asked.id, said: "Y1" }]);
	assert.deepEqual(yes.shown, [{ title, options: ["No, do not run it", "Yes, run it once"] }]);
	assert.deepEqual(yes.said, [[asked.id, "yes"]]);
	assert.deepEqual(yes.printed, ['queued: your yes to "deploy-check" runs after the current turn']);
	assert.equal(yes.finding(asked.id).answer?.state, "pending");
	assert.ok(yes.stores.requests.list(HERE).some((row) => row.id.startsWith("ans-")), "the yes is a row of this conversation");

	const no = world(["No, do not run it"]);
	const refused = await no.file();
	await offerAtSettle([{ kind: "question", finding: refused }], no.deps);
	assert.deepEqual(no.said, [[refused.id, "no"]]);
	assert.deepEqual(no.printed, ['said no: "deploy-check" is told in this conversation']);
	assert.equal(no.finding(refused.id).status, "dismissed");

	const esc = world([undefined]);
	const left = await esc.file();
	assert.deepEqual(await offerAtSettle([{ kind: "question", finding: left }], esc.deps), [{ kind: "question", id: left.id, said: "esc" }]);
	assert.deepEqual(esc.said, [], "Esc calls nothing");
	assert.deepEqual(esc.printed, []);
	assert.equal(esc.finding(left.id).status, "new");
	assert.deepEqual(esc.stores.requests.list(HERE), []);
});

test("a question answered on another surface while the selector was open prints the refusal say gives", async () => {
	const w = world(["Yes, run it once"]);
	const asked = await w.file();
	const select = w.deps.select;
	w.deps.select = async (title, options) => {
		await w.deps.say(asked.id, "no");
		return select(title, options);
	};
	await offerAtSettle([{ kind: "question", finding: asked }], w.deps);
	assert.deepEqual(w.printed, [`inbox entry ${asked.id} was already dismissed`]);
	assert.equal(w.finding(asked.id).status, "dismissed");
});

test("a proposal's selector sets it up or cancels it through askProposal, and Esc leaves it proposed with the stays-proposed line", async () => {
	const set = world(["Set it up · inbox"]);
	const job = await set.stores.jobs.add(proposedJob("cron-pr-watch", stamp(Date.now())));
	assert.deepEqual(await offerAtSettle([{ kind: "proposal", proposal: asJob(job) }], set.deps), [{ kind: "proposal", id: job.id, outcome: "set" }]);
	assert.match(set.shown[0].title, /^Set up this watch\?\n/);
	assert.equal(set.shown[0].options.at(-1), "Cancel");
	assert.deepEqual(set.printed, ["set up: pr-watch · every 10m · inbox"], "the line /cron enable prints");
	const after = set.stores.jobs.load().find((j) => j.id === job.id)!;
	assert.equal(after.enabled, true);
	assert.equal(after.proposed, undefined);

	const cancel = world(["Cancel"]);
	const gone = await cancel.stores.jobs.add(proposedJob("cron-pr-watch", stamp(Date.now())));
	await offerAtSettle([{ kind: "proposal", proposal: asJob(gone) }], cancel.deps);
	assert.deepEqual(cancel.printed, ["cancelled: pr-watch is removed and nothing ran"]);
	assert.deepEqual(cancel.stores.jobs.load(), []);

	const esc = world([undefined, undefined]);
	const kept = await esc.stores.jobs.add(proposedJob("cron-pr-watch", stamp(Date.now())));
	const rule = await esc.stores.rules.add({ condition: "~/build.done appears", action: "run cargo test", cwd: esc.dir, proposed: { at: stamp(Date.now()), session: HERE } });
	await offerAtSettle([{ kind: "proposal", proposal: asJob(kept) }, { kind: "proposal", proposal: { kind: "rule", rule } }], esc.deps);
	assert.deepEqual(esc.printed, ["the watch stays proposed: /cron enable pr-watch asks again", `the watch stays proposed: /triggers enable ${rule.id} asks again`]);
	assert.ok(esc.stores.jobs.load()[0].proposed, "the job stays proposed");
	assert.ok(esc.stores.rules.load()[0].proposed, "the rule stays proposed");
	assert.deepEqual(esc.stores.requests.list(HERE), [], "no receipt");
});

test("stillOk turning false between two offers stops the rest; a shown id is not offered at the next settle; a second settle while offers are open starts no second run", async () => {
	const w = world([undefined, undefined]);
	const first = await w.file();
	const job = await w.stores.jobs.add(proposedJob("cron-pr-watch", stamp(Date.now())));
	const offers = settleOffers(input({ findings: w.stores.inbox.list(), proposals: [asJob(job)], offered: w.offered }));
	assert.deepEqual(ids(offers), [first.id, job.id]);
	const select = w.deps.select;
	w.deps.select = async (title, options) => {
		w.state.ok = false;
		return select(title, options);
	};
	assert.deepEqual(await offerAtSettle(offers, w.deps), [{ kind: "question", id: first.id, said: "esc" }]);
	assert.equal(w.shown.length, 1, "the proposal's selector did not open");
	assert.deepEqual(ids(settleOffers(input({ findings: w.stores.inbox.list(), proposals: [asJob(job)], offered: w.offered }))), [job.id], "the question shown once is not offered again; the proposal never shown is");

	let release!: () => void;
	const opened: number[] = [];
	const run = oneRunAtATime(async (n: number) => {
		opened.push(n);
		await new Promise<void>((resolve) => (release = resolve));
	});
	const one = run(1);
	assert.ok(one, "the first settle starts a run");
	assert.equal(run(2), undefined, "a second settle while it is open does nothing");
	release();
	await one;
	const three = run(3);
	assert.ok(three, "once it closed, the next settle starts one");
	release();
	await three;
	assert.deepEqual(opened, [1, 3]);
});
