/**
 * src/guard.ts: `judgeCall` arm by arm in the order of design 2.3, and `guardCall` against a real
 * inbox in a temporary directory. No SDK and no model: test/reopen.test.ts drives the guard through
 * a real sub-session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AskOrigin, type Call, type DeclaredCap, type Grant, type ResolvedCap, askFindingId, askId, callKey, inputHash, resolveCap } from "../src/ask.ts";
import { type CallVerdict, type GuardDeps, type GuardSeed, type GuardTurn, type Question, type ToolCallFacts, GuardSeats, guardCall, guardTurn, judgeCall, subagentGuardExtension, unhandledAsk } from "../src/guard.ts";
import { Inbox, type InboxEntry as Finding } from "../src/inbox.ts";
import { refusal, windowGuard, windowSeed } from "../src/window-guard.ts";
import { tmp } from "./tmp.ts";

const LANE = "@cron-a1";
const PUSH = "git push --force origin main";
const PUSH_REASON = "git push --force on main/master";
const NOW = Date.parse("2026-11-20T02:00:00.000Z");
const ORIGIN: AskOrigin = { source: "cron:a1", run_id: "run-1", cwd: "/proj", job_id: "cron-a1", who: "the loop a1" };
const cfg = { allowCommands: [] as string[] };
const bash = (command: string, extra: Partial<{ toolCallId: string; parentToolCallId: string }> = {}) => ({ toolName: "bash", toolCallId: extra.toolCallId ?? "call-1", input: { command }, ...(extra.parentToolCallId ? { parentToolCallId: extra.parentToolCallId } : {}) });
const pushKey = callKey("bash", inputHash({ command: PUSH }));
const callOf = (command: string, reason: string): Call => ({ tool: "bash", tool_call_id: "call-0", command, input_sha256: inputHash({ command }), reason });
const grantOf = (command: string, reason = PUSH_REASON): Grant => ({ finding: "inb-0", ask: "ask-granted", call: callOf(command, reason) }) as unknown as Grant;
/** A run's own SessionManager, as the guard sees it: an object with its session id. */
const sm = (id: string) => ({ getSessionId: () => id });
const capOf = (declared: DeclaredCap): ResolvedCap => resolveCap(declared, 900_000);
const turn = (over: Partial<GuardTurn> = {}): GuardTurn => ({ resumable: true, lane: LANE, open: new Map(), refused: new Map(), asked: 0, ...over });

test("[Q1] judgeCall: the policy passes a call, whatever the inbox says", () => {
	assert.deepEqual(judgeCall(bash("ls -la"), turn(), cfg), { kind: "allow" });
	assert.deepEqual(judgeCall({ toolName: "read", toolCallId: "c", input: { path: "/etc/passwd" } }, turn(), cfg), { kind: "allow" }, "only a shell command is screened");
	assert.deepEqual(judgeCall(bash(PUSH), turn({ refused: new Map([[pushKey, "2026-11-19"]]) }), { allowCommands: [PUSH] }), { kind: "allow" }, "[danger] allow comes first");
});

test("[Q1] judgeCall: a policy allow of the granted call spends the grant", () => {
	assert.deepEqual(judgeCall(bash(PUSH), turn({ granted: grantOf(PUSH) }), { allowCommands: [PUSH] }), { kind: "allow", grantUsed: true });
	assert.deepEqual(judgeCall(bash("ls"), turn({ granted: grantOf(PUSH) }), cfg), { kind: "allow" }, "another call allowed by the policy leaves the grant");
});

test("[Q1] judgeCall: the granted call passes, before a no and an open question", () => {
	const all = turn({ granted: grantOf(PUSH), refused: new Map([[pushKey, "2026-11-19"]]), open: new Map([[pushKey, "ask-open"]]) });
	assert.deepEqual(judgeCall(bash(PUSH, { toolCallId: "another-id" }), all, cfg), { kind: "granted", ask: "ask-granted" }, "a new call id: the grant is bound to the tool and the input");
	assert.equal(judgeCall(bash(`${PUSH} --quiet`), turn({ granted: grantOf(PUSH) }), cfg).kind, "question", "another input is not the granted call");
	assert.equal(judgeCall({ toolName: "powershell", toolCallId: "c", input: { command: PUSH } }, turn({ granted: grantOf(PUSH) }), cfg).kind, "question", "another tool is not either");
});

test("[Q1] judgeCall: a no that holds is refused with its date, before an open question", () => {
	const v = judgeCall(bash(PUSH), turn({ refused: new Map([[pushKey, "2026-11-19"]]), open: new Map([[pushKey, "ask-open"]]) }), cfg);
	assert.deepEqual(v, { kind: "refuse", reason: PUSH_REASON, whyNot: { why: "no", date: "2026-11-19" } });
});

test("[Q1] judgeCall: an open question for the same call is asked, and files no second one", () => {
	assert.deepEqual(judgeCall(bash(PUSH, { toolCallId: "call-2" }), turn({ open: new Map([[pushKey, "ask-open"]]), asked: 3 }), cfg), { kind: "asked", ask: "ask-open" }, "before the caps");
});

test("[Q1] judgeCall: a call that needs a person and can be asked is a question", () => {
	assert.deepEqual(judgeCall(bash(PUSH, { toolCallId: "call-7" }), turn({ asked: 2, open: new Map([["bash other", "ask-x"], ["bash more", "ask-y"], ["bash third", "ask-z"]]) }), cfg), {
		kind: "question",
		ask: { kind: "call", call: { tool: "bash", tool_call_id: "call-7", command: PUSH, input_sha256: inputHash({ command: PUSH }), reason: PUSH_REASON } },
	});
});

test("[Q1] judgeCall: each reason nobody is asked", () => {
	const why = (call: ReturnType<typeof bash>, t: GuardTurn) => {
		const v = judgeCall(call, t, cfg);
		assert.equal(v.kind, "refuse");
		return v.kind === "refuse" ? v.whyNot.why : undefined;
	};
	assert.equal(why(bash(PUSH, { parentToolCallId: "outer" }), turn()), "no-transcript", "a nested call's id is in no transcript");
	assert.equal(why(bash(PUSH), turn({ resumable: false, lane: undefined })), "no-transcript", "a session with no file: a checker");
	assert.equal(why(bash(`${PUSH} ${"x".repeat(300)}`), turn()), "too-long");
	assert.equal(why(bash(`${PUSH}\u001b[2K`), turn()), "not-as-written", "a terminal escape would hide part of it");
	assert.equal(why(bash(`GITHUB_TOKEN=ghp_${"a".repeat(36)} ${PUSH}`), turn()), "not-as-written", "a secret is never put in front of a person");
	assert.equal(why(bash(PUSH), turn({ asked: 3 })), "turn-cap");
	assert.equal(why(bash(PUSH), turn({ open: new Map([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]) })), "lane-cap");
});

test("[Q1] [not-as-written] a command the card would not show as itself is not asked about: a newline, a carriage return, a tab, a run of spaces", () => {
	for (const command of [`echo checking status\n${PUSH}`, `echo checking status\r${PUSH}`, `echo checking\t&& ${PUSH}`, `echo checking  && ${PUSH}`, `echo checking\u00a0&& ${PUSH}`, `echo checking\u2028${PUSH}`]) {
		const v = judgeCall(bash(command), turn(), cfg);
		assert.deepEqual(v.kind === "refuse" ? v.whyNot : v, { why: "not-as-written" }, JSON.stringify(command));
	}
	assert.equal(judgeCall(bash(`echo checking && ${PUSH}`), turn(), cfg).kind, "question", "one space between words is shown as written");
});

test("guardTurn: one lane's new questions and the nos of the last 14 days, and the grant until it is used", () => {
	const ask = (id: string, lane: string, command: string) => ({ kind: "call", id, lane, session_id: "s", title: "t", call: callOf(command, "r"), created_at: "2026-11-01T00:00:00.000Z" });
	const finding = (over: Partial<Finding>): Finding => ({ id: "inb-x", created_at: "2026-11-01T00:00:00.000Z", status: "new", kind: "checkpoint", source: "s", run_id: "r", cwd: "/proj", text: "t", verified: null, dismiss_reason: null, ...over }) as Finding;
	const findings = [
		finding({ ask: ask("ask-1", LANE, "a") as Finding["ask"] }),
		finding({ ask: ask("ask-2", "@cron-other", "b") as Finding["ask"] }),
		finding({ status: "dismissed", dismissed_at: "2026-11-15T10:00:00.000+08:00", ask: ask("ask-3", LANE, "c") as Finding["ask"] }),
		finding({ status: "dismissed", dismissed_at: "2026-10-01T10:00:00.000Z", ask: ask("ask-4", LANE, "d") as Finding["ask"] }),
		finding({ status: "claimed", ask: ask("ask-5", LANE, "e") as Finding["ask"] }),
	];
	const seats = new GuardSeats();
	const { seat } = seats.enter(sm("s"), "/s.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj", tools: ["bash"] }), grant: grantOf(PUSH) });
	const t = guardTurn(seat, findings, NOW);
	assert.deepEqual([...t.open], [[callKey("bash", inputHash({ command: "a" })), "ask-1"]], "another lane's question and a claimed one are not open here");
	assert.deepEqual([...t.refused], [[callKey("bash", inputHash({ command: "c" })), "2026-11-15"]], "a no older than 14 days no longer holds");
	assert.deepEqual([t.resumable, t.lane, t.granted?.ask], [true, LANE, "ask-granted"]);
	seat.grantUsed = true;
	assert.equal(guardTurn(seat, findings, NOW).granted, undefined, "a used grant admits nothing");
	const none = guardTurn(undefined, findings, NOW);
	assert.deepEqual([none.resumable, none.lane, none.open.size, none.refused.size], [false, undefined, 0, 0], "no seat: no lane, nothing read");
});

test("GuardSeats: one seat per session, found by the session object and not by its file; the report names the grant only for a run that had one", () => {
	const seats = new GuardSeats();
	const seed: GuardSeed = { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }) };
	const session = sm("a");
	const a = seats.enter(session, "/a.jsonl", seed);
	assert.throws(() => seats.enter(session, "/a.jsonl", seed), /already has the guard's seat/);
	assert.equal(seats.of(session), a.seat);
	assert.equal(seats.of(sm("a")), undefined, "another session with the same file and id has no seat");
	assert.equal(seats.of(undefined), undefined);
	a.seat.asked.push("ask-1");
	assert.deepEqual(a.leave(), { asked: ["ask-1"] });
	assert.equal(seats.of(session), undefined, "a run that left has no seat");
	const b = seats.enter(sm("b"), "/b.jsonl", { ...seed, grant: grantOf(PUSH) });
	assert.deepEqual(b.leave(), { grant_used: false, asked: [] });
});

/** A real inbox, and how often the guard read it. */
function world(allow: string[] = []) {
	const inbox = new Inbox(tmp("pi-loops-guard-"));
	let reads = 0;
	const log: string[] = [];
	const deps: GuardDeps = {
		inbox: { list: () => (reads++, inbox.list()), fileOnce: (entry, id) => inbox.fileOnce(entry, id) },
		allowCommands: () => allow,
		now: () => NOW,
		log: (m) => log.push(m),
	};
	return { inbox, deps, log, reads: () => reads };
}

test("[Q1] guardCall: a blocked call files one question, with the derived id and the hash of the input it saw", async () => {
	const w = world();
	const seats = new GuardSeats();
	const { seat, leave } = seats.enter(sm("s1"), "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj", tools: ["bash", "read"] }) });
	const first = await guardCall(bash(PUSH, { toolCallId: "call-1" }), seat, w.deps);
	assert.equal(first?.block, true);
	assert.match(first!.reason, /^asked a person: git push --force on main\/master\. pi-loops did not run this/);
	const ask = askId("s1", "call-1");
	const filed = w.inbox.list();
	assert.deepEqual(filed.map((f) => f.id), [askFindingId(ask)]);
	assert.deepEqual([filed[0].ask?.id, filed[0].ask?.lane, filed[0].lane, filed[0].ask?.session_id, filed[0].ask?.call.input_sha256, filed[0].ask?.run?.tools], [ask, LANE, LANE, "s1", inputHash({ command: PUSH }), ["bash", "read"]]);

	const again = await guardCall(bash(PUSH, { toolCallId: "call-2" }), seat, w.deps);
	assert.match(again!.reason, /^asked a person:/, "the same call later in the turn is told it is asked");
	await guardCall(bash(PUSH, { toolCallId: "call-1" }), seat, w.deps);
	assert.equal(w.inbox.list().length, 1, "a second block of the same call in the same lane files no second question");
	assert.deepEqual(leave(), { asked: [ask] }, "and it is counted once");
});

test("[Q1] [asked-open] a question whose yes waits to run or runs is open: a later run of the lane that makes the same call is told it is asked, and files no second question", async () => {
	const w = world();
	const first = new GuardSeats().enter(sm("s1"), "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }) });
	await guardCall(bash(PUSH), first.seat, w.deps);
	const [question] = w.inbox.list();
	const claim = { id: "ans-1", pid: 1, started_at: "2026-11-20T01:30:00.000Z" };
	for (const answer of [{ state: "pending", at: "2026-11-20T01:00:00.000Z" }, { state: "started", run: claim, at: "2026-11-20T01:30:00.000Z" }]) {
		const yes = { ...question, status: "claimed", answered_by: "terminal", claimed_by: "s0", answer } as Finding;
		const filed: string[] = [];
		const deps: GuardDeps = { ...w.deps, inbox: { list: () => [yes], fileOnce: (_entry, id) => (filed.push(id), Promise.resolve(yes)) } };
		const later = new GuardSeats().enter(sm("s2"), "/runs/s2.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }) });
		const out = await guardCall(bash(PUSH, { toolCallId: "call-2" }), later.seat, deps);
		assert.match(out!.reason, /^asked a person:/, `${answer.state}: the later run is told it is asked`);
		assert.deepEqual([filed, later.leave().asked], [[], []], `${answer.state}: no second question beside the yes`);
		assert.deepEqual([...guardTurn(later.seat, [yes], NOW).open.values()], [question.ask!.id], `${answer.state}: the question is open`);
	}
});

test("[Q1] [asked-open] the run a yes started is not told its own question is open: after its grant is used, the same call again files a new question (J13 step 4)", async () => {
	const w = world();
	const first = new GuardSeats().enter(sm("s1"), "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }) });
	await guardCall(bash(PUSH), first.seat, w.deps);
	const [question] = w.inbox.list();
	const running = { ...question, status: "claimed", answered_by: "terminal", claimed_by: "s0", answer: { state: "started", run: { id: "ans-1", pid: 1, started_at: "2026-11-20T01:30:00.000Z" }, at: "2026-11-20T01:30:00.000Z" } } as Finding;
	const grant = { finding: running.id, ask: running.ask!.id, call: running.ask!.call } as unknown as Grant;
	const filed: string[] = [];
	const deps: GuardDeps = { ...w.deps, inbox: { list: () => [running], fileOnce: (_entry, id) => (filed.push(id), Promise.resolve(running)) } };
	const answer = new GuardSeats().enter(sm("s1"), "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }), grant });
	assert.equal(await guardCall(bash(PUSH, { toolCallId: "call-2" }), answer.seat, deps), undefined, "the granted call runs");
	const again = await guardCall(bash(PUSH, { toolCallId: "call-3" }), answer.seat, deps);
	assert.match(again!.reason, /^asked a person:/, "the same call again is blocked and asked about");
	assert.equal(filed.length, 1, "it files a new question: the person is asked about the second call");
	assert.deepEqual([...guardTurn(answer.seat, [running], NOW).open.keys()], [], "its own question is not open to the run that answers it");
	const other = new GuardSeats().enter(sm("s2"), "/runs/s2.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }) });
	assert.deepEqual([...guardTurn(other.seat, [running], NOW).open.values()], [running.ask!.id], "another run of the lane still finds it open");
});

test("[Q1] guardCall: a nested call is refused with the words of the guard before questions, and files nothing", async () => {
	const w = world();
	const { seat } = new GuardSeats().enter(sm("s1"), "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }) });
	const out = await guardCall(bash(PUSH, { toolCallId: "call-1/1", parentToolCallId: "call-1" }), seat, w.deps);
	assert.match(out!.reason, /^refused by pi-loops: git push --force on main\/master\. This run is unattended, so commands that can destroy data or the machine are not allowed/);
	assert.deepEqual([w.inbox.list().length, seat.asked], [0, []]);
});

test("[Q1] guardCall: with no seat a dangerous call is refused and nobody is asked; ordinary work reads no inbox", async () => {
	const w = world();
	const out = await guardCall(bash(PUSH), undefined, w.deps);
	assert.match(out!.reason, /^refused by pi-loops: git push --force on main\/master\. This run is unattended, so commands that can destroy data or the machine are not allowed; do the safe part and report what you would need a human for\.$/, "a run with no seat keeps the words of the guard before questions");
	assert.equal(await guardCall(bash("cargo test"), undefined, w.deps), undefined);
	assert.deepEqual([w.inbox.list().length, w.reads()], [0, 0]);
	assert.equal(w.log.length, 1, "each block is logged");
});

test("[Q1] guardCall: a no that holds refuses with its date, and a failed filing refuses: a call is never let through on an error", async () => {
	const w = world();
	const { seat } = new GuardSeats().enter(sm("s1"), "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }) });
	await guardCall(bash(PUSH), seat, w.deps);
	const dismissed = { ...w.inbox.list()[0], status: "dismissed", dismissed_at: "2026-11-19T09:00:00.000Z" };
	const failing: GuardDeps = { ...w.deps, inbox: { list: () => [dismissed as Finding], fileOnce: () => Promise.reject(new Error("disk full")) } };
	const no = await guardCall(bash(PUSH, { toolCallId: "call-9" }), seat, failing);
	assert.match(no!.reason, /Nobody was asked: a person said no to this on 2026-11-19\./);
	const broken = await guardCall(bash("sudo reboot", { toolCallId: "call-10" }), seat, failing);
	assert.match(broken!.reason, /^refused by pi-loops: sudo invocation\. Nobody was asked: the question could not be filed \(disk full\)/);
	const unreadable = await guardCall(bash("sudo reboot"), seat, { ...w.deps, inbox: { list: () => { throw new Error("torn"); }, fileOnce: w.deps.inbox.fileOnce } });
	assert.equal(unreadable?.block, true, "an inbox that cannot be read blocks the call");
});

test("[Q1] guardCall: a grant is used once; a policy allow of the granted call spends it without reading the inbox", async () => {
	const w = world();
	const seats = new GuardSeats();
	const granted = seats.enter(sm("s2"), "/runs/s2.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }), grant: grantOf(PUSH) });
	assert.equal(await guardCall(bash(PUSH, { toolCallId: "call-a" }), granted.seat, w.deps), undefined, "the granted call goes through");
	assert.equal(w.reads(), 0, "and reads no inbox");
	const second = await guardCall(bash(PUSH, { toolCallId: "call-b" }), granted.seat, w.deps);
	assert.match(second!.reason, /^asked a person:/, "a second identical call is not granted: it is asked about");
	assert.deepEqual(granted.leave(), { grant_used: true, asked: [askId("s2", "call-b")] });

	const allowed = world([PUSH]);
	const policy = seats.enter(sm("s3"), "/runs/s3.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }), grant: grantOf(PUSH) });
	assert.equal(await guardCall(bash(PUSH), policy.seat, allowed.deps), undefined);
	assert.deepEqual([policy.leave(), allowed.reads()], [{ grant_used: true, asked: [] }, 0], "[danger] allow ran the granted call: the grant counts as used");

	const unused = seats.enter(sm("s4"), "/runs/s4.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }), grant: grantOf(PUSH) });
	assert.equal(await guardCall(bash("ls"), unused.seat, w.deps), undefined);
	assert.deepEqual(unused.leave(), { grant_used: false, asked: [] }, "another call the policy passes leaves the grant unused");
});

test("[review-F1] a nested call never uses a grant: it is refused before the grant is looked at, and a policy allow of it spends nothing", async () => {
	const nested = bash(PUSH, { toolCallId: "call-1/1", parentToolCallId: "call-1" });
	assert.deepEqual(judgeCall(nested, turn({ granted: grantOf(PUSH) }), cfg), { kind: "refuse", reason: PUSH_REASON, whyNot: { why: "no-transcript" } });
	assert.deepEqual(judgeCall(nested, turn({ granted: grantOf(PUSH) }), { allowCommands: [PUSH] }), { kind: "allow" }, "the policy passes it, and the grant stays");
	const w = world();
	const { seat, leave } = new GuardSeats().enter(sm("s5"), "/runs/s5.jsonl", { lane: LANE, origin: ORIGIN, cap: capOf({ cwd: "/proj" }), grant: grantOf(PUSH) });
	const out = await guardCall(nested, seat, w.deps);
	assert.match(out!.reason, /^refused by pi-loops: git push --force on main\/master\. This run is unattended/);
	assert.deepEqual([leave(), w.inbox.list().length], [{ grant_used: false, asked: [] }, 0], "the grant is unused and nothing is filed");
});

const OWN = "reads or writes pi-loops' own files";

/** A loops directory and a project beside it, with a link from the project into the loops directory. */
function ownFiles() {
	const root = tmp("pi-loops-guard-own-");
	const loops = path.join(root, "loops");
	const proj = path.join(root, "proj");
	fs.mkdirSync(loops, { recursive: true });
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.symlinkSync(loops, path.join(proj, "state"));
	return { loops, proj, policy: { allowCommands: [] as string[], loopsDir: loops } };
}
const write = (p: string, cwd: string, toolName = "write") => ({ toolName, toolCallId: "call-w", cwd, input: toolName === "edit" ? { path: p, edits: [{ oldText: "a", newText: "b" }] } : { path: p, content: "{}" } });
const NOT_SHOWN = "a person cannot see on the card what this call would read or write, so a yes would be blind";

test("[M5a.8d] judgeCall: a read, a write, an edit or a grep into the loops directory is refused and nobody is asked, since the card cannot show it; a write to the project is not; a shell command that names the directory is a question", () => {
	const { loops, proj, policy } = ownFiles();
	const t = turn();
	for (const call of [write(path.join(loops, "inbox.jsonl"), proj), write(path.join(loops, "jobs.json"), proj, "edit"), write(path.join(proj, "state", "inbox.jsonl"), proj), write("../loops/requests/@cron-a1.jsonl", proj), write("state/clock.json", proj), write(loops, proj), write(`@${loops}/hooks.toml`, proj), { toolName: "read", toolCallId: "call-w", cwd: proj, input: { path: "state/web-token" } }, { toolName: "grep", toolCallId: "call-w", cwd: proj, input: { pattern: "token", path: ".." } }]) {
		assert.deepEqual(judgeCall(call, t, policy), { kind: "refuse", reason: OWN, whyNot: { why: "not-shown" } }, JSON.stringify(call.input));
	}
	for (const call of [write(path.join(proj, "src", "a.ts"), proj), write("src/a.ts", proj), write(`${loops}-old/x`, proj), { toolName: "read", toolCallId: "c", cwd: proj, input: { path: "src/a.ts" } }]) assert.deepEqual(judgeCall(call, t, policy), { kind: "allow" }, JSON.stringify(call));
	const seatless = judgeCall(write(path.join(loops, "inbox.jsonl"), proj), turn({ resumable: false, lane: undefined }), policy);
	assert.deepEqual(seatless, { kind: "refuse", reason: OWN, whyNot: { why: "no-transcript" } }, "with no seat it is refused with the words of a run that has none");
	assert.equal(judgeCall(bash(`echo '{}' >> ${loops}/inbox.jsonl`), t, policy).kind, "question", "a shell command that names it is shown as written: a question");
	assert.deepEqual(judgeCall(bash("pi-loops inbox claim inb-1"), t, policy), { kind: "question", ask: { kind: "call", call: { tool: "bash", tool_call_id: "call-1", command: "pi-loops inbox claim inb-1", input_sha256: inputHash({ command: "pi-loops inbox claim inb-1" }), reason: "answers for a person" } } });
	assert.deepEqual(judgeCall(bash("pi-loops inbox claim inb-1"), t, { ...policy, allowCommands: ["pi-loops inbox claim inb-1"] }), { kind: "allow" }, "an allow entry permits it, as for any other rule");
});

test("[M5a.8d] guardCall: a write or an edit into the loops directory is refused, the model is told to report what it needed, and nothing is filed", async () => {
	const { loops, proj } = ownFiles();
	const w = world();
	const deps: GuardDeps = { ...w.deps, loopsDir: loops };
	const { seat, leave } = new GuardSeats().enter(sm("s1"), "/runs/s1.jsonl", { lane: LANE, origin: { ...ORIGIN, cwd: proj }, cap: capOf({ cwd: proj }) });
	for (const call of [write("../loops/inbox.jsonl", proj), write(path.join(loops, "config.toml"), proj, "edit")]) {
		const out = await guardCall(call, seat, deps);
		assert.equal(out?.reason, `refused by pi-loops: ${OWN}. Nobody was asked: ${NOT_SHOWN}. Finish what does not need it, and report what you would need a person for.`, JSON.stringify(call.input));
	}
	assert.equal(await guardCall(write("src/a.ts", proj), seat, deps), undefined);
	assert.deepEqual([w.inbox.list().length, leave().asked], [0, []], "no question is filed");
});

test("[M5a.8d] the sub-agent guard judges a relative path against the run's cwd: a checker's relative write into the loops directory is refused", async () => {
	const { loops, proj } = ownFiles();
	const w = world();
	const handler = (subagentGuardExtension(new GuardSeats(), { ...w.deps, loopsDir: loops }) as unknown as { handlers: Map<string, Array<(...args: unknown[]) => Promise<{ block: true; reason: string } | undefined>>> }).handlers.get("tool_call")![0];
	const out = await handler({ toolName: "write", toolCallId: "call-c", input: { path: "../loops/inbox.jsonl", content: "{}" } }, { sessionManager: {}, cwd: proj });
	assert.match(out?.reason ?? "", /^refused by pi-loops: reads or writes pi-loops' own files\. This run is unattended/);
	assert.equal(await handler({ toolName: "write", toolCallId: "call-d", input: { path: "src/a.ts", content: "{}" } }, { sessionManager: {}, cwd: proj }), undefined, "a write to the project goes through");
	assert.equal(w.inbox.list().length, 0);
});

test("[PR271] judgeCall: a run that reads the page's token, pairs a browser or starts a pi of the person's is asked about, as a call that answers for a person", () => {
	const via = `T=$(pi-loops status --url | sed 's/.*token=//'); curl -s -X POST -H "x-pi-web-token: $T" -H 'content-type: application/json' -d '{"id":"inb-0123456789abcdef0123456789abcdef"}' http://127.0.0.1:4173/inbox/claim`;
	for (const command of ["pi-loops status --url", "pi-loops pair", "pi-loops open", via, 'pi -p "/inbox claim 1"', "echo '/inbox claim 1' | pi -p"]) {
		assert.deepEqual(judgeCall(bash(command), turn(), cfg), { kind: "question", ask: { kind: "call", call: { tool: "bash", tool_call_id: "call-1", command, input_sha256: inputHash({ command }), reason: "answers for a person" } } }, command);
	}
	assert.deepEqual(judgeCall(bash("pi-loops status"), turn(), cfg), { kind: "allow" }, "status without its address");
});

test("[M5b.2] one decider: a call gets the same verdict in a background turn and in a window's scheduled turn; only what each handler does with it differs", async () => {
	const { loops, proj } = ownFiles();
	const ALLOWED = "rm -rf /var/cache/x";
	const policy = { allowCommands: [ALLOWED], loopsDir: loops };
	const at = (call: ReturnType<typeof bash> | ReturnType<typeof write>): ToolCallFacts => ({ ...call, toolCallId: "call-1", cwd: proj });
	const question = (command: string, reason: string): CallVerdict => ({ kind: "question", ask: { kind: "call", call: { tool: "bash", tool_call_id: "call-1", command, input_sha256: inputHash({ command }), reason } } });
	const undeclared = "bash is not among the tools the job declared (read)";
	const asked = (reason: string) => `asked a person: ${reason}. pi-loops did not run this and put the question in front of them. Do not wait for the answer and do not try another way to do the same thing. Finish what does not need it.`;
	const rows: Array<{ name: string; call: ToolCallFacts; declared?: { tools: string[] }; verdict: CallVerdict; background?: "asked" | "not-shown" | "allowed"; window: "asked" | "blind" | "allowed" }> = [
		{ name: "a dangerous command", call: at(bash(PUSH)), verdict: question(PUSH, PUSH_REASON), background: "asked", window: "asked" },
		{ name: "a path tool into the loops directory", call: at(write("../loops/inbox.jsonl", proj)), verdict: { kind: "refuse", reason: OWN, whyNot: { why: "not-shown" } }, background: "not-shown", window: "blind" },
		// The runner gives a background run only the tools its cap declares, so its turn declares none and the handler is not driven here.
		{ name: "a tool outside what the row declared", call: at(bash("echo hi")), declared: { tools: ["read"] }, verdict: question("echo hi", undeclared), window: "asked" },
		{ name: "an allowed call", call: at(bash("ls -la")), verdict: { kind: "allow" }, background: "allowed", window: "allowed" },
		{ name: "an allow-listed command", call: at(bash(ALLOWED)), verdict: { kind: "allow" }, background: "allowed", window: "allowed" },
	];
	for (const row of rows) {
		const cap = { kind: "row" as const, id: "run-1111222233334444", mode: "unattended" as const, ...(row.declared ?? {}) };
		const seat = new GuardSeats().enter(sm("s1"), "/runs/s1.jsonl", { lane: LANE, origin: { ...ORIGIN, cwd: proj }, cap: capOf({ cwd: proj }) }).seat;
		const background = guardTurn(seat, [], NOW, row.declared);
		const windowSeat = new GuardSeats().enter(sm("s"), "/sessions/s.jsonl", windowSeed(cap, "s", proj, undefined)).seat;
		const inWindow = guardTurn(windowSeat, [], NOW, row.declared);
		assert.deepEqual(judgeCall(row.call, background, policy), row.verdict, `${row.name}: background`);
		assert.deepEqual(judgeCall(row.call, inWindow, policy), row.verdict, `${row.name}: window`);
		const reason = row.verdict.kind === "question" ? row.verdict.ask.call.reason : row.verdict.kind === "refuse" ? row.verdict.reason : "";

		if (row.background) {
			const w = world([ALLOWED]);
			const out = await guardCall(row.call, seat, { ...w.deps, loopsDir: loops });
			const expected = { asked: { block: true, reason: asked(reason) }, "not-shown": { block: true, reason: `refused by pi-loops: ${reason}. Nobody was asked: ${NOT_SHOWN}. Finish what does not need it, and report what you would need a person for.` }, allowed: undefined }[row.background];
			assert.deepEqual(out, expected, `${row.name}: the background's handler`);
			assert.equal(w.inbox.list().length, row.background === "asked" ? 1 : 0, `${row.name}: the background files a question only for a question`);
		}

		const w = world([ALLOWED]);
		const ctx = { cwd: proj, sessionManager: { getSessionId: () => "s", getSessionFile: () => "/sessions/s.jsonl" } };
		const handler = windowGuard({ current: () => cap, config: () => ({ windowGuard: true, ...policy }), log: () => undefined, inbox: w.deps.inbox, now: () => NOW, jobOf: () => undefined });
		const out = await handler({ toolName: row.call.toolName, toolCallId: row.call.toolCallId, input: row.call.input }, ctx);
		const expected = { asked: { block: true, reason: asked(reason) }, blind: { block: true, reason: refusal(reason, "blind") }, allowed: undefined }[row.window];
		assert.deepEqual(out, expected, `${row.name}: the window's handler`);
		assert.deepEqual(w.inbox.list().map((f) => f.ask?.lane), row.window === "asked" ? ["s"] : [], `${row.name}: the window files a question only for a question, in the conversation's lane`);
	}
});

test("[M5b.2] a question of a kind a handler does not take does not compile", () => {
	type Wider = Question | { kind: "proposal"; job: string };
	const handled = (ask: Wider): string => {
		switch (ask.kind) {
			case "call":
				return ask.call.tool;
			default:
				// @ts-expect-error a proposal reaches the default: M5b.5 adds its case to every handler
				return unhandledAsk(ask.kind);
		}
	};
	assert.equal(handled({ kind: "call", call: callOf(PUSH, PUSH_REASON) }), "bash");
	assert.throws(() => unhandledAsk("proposal" as never), /a question of kind proposal has no handler/);
});
