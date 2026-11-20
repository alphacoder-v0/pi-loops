/**
 * src/guard.ts: `judgeCall` arm by arm in the order of design 2.3, and `guardCall` against a real
 * inbox in a temporary directory. No SDK and no model: test/reopen.test.ts drives the guard through
 * a real sub-session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type AskOrigin, type Call, type Grant, askFindingId, askId, callKey, inputHash } from "../src/ask.ts";
import { type GuardDeps, type GuardSeed, type GuardTurn, GuardSeats, guardCall, guardTurn, judgeCall } from "../src/guard.ts";
import { Inbox, type InboxEntry as Finding } from "../src/inbox.ts";
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
const turn = (over: Partial<GuardTurn> = {}): GuardTurn => ({ unattended: true, hop: 1, resumable: true, lane: LANE, open: new Map(), refused: new Map(), asked: 0, ...over });

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
		call: { tool: "bash", tool_call_id: "call-7", command: PUSH, input_sha256: inputHash({ command: PUSH }), reason: PUSH_REASON },
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

test("guardTurn: one lane's new questions and the nos of the last 14 days, and the grant until it is used", () => {
	const ask = (id: string, lane: string, command: string) => ({ kind: "call", id, lane, session_file: "/s.jsonl", title: "t", call: callOf(command, "r"), created_at: "2026-11-01T00:00:00.000Z" });
	const finding = (over: Partial<Finding>): Finding => ({ id: "inb-x", created_at: "2026-11-01T00:00:00.000Z", status: "new", kind: "checkpoint", source: "s", run_id: "r", cwd: "/proj", text: "t", verified: null, dismiss_reason: null, ...over }) as Finding;
	const findings = [
		finding({ ask: ask("ask-1", LANE, "a") as Finding["ask"] }),
		finding({ ask: ask("ask-2", "@cron-other", "b") as Finding["ask"] }),
		finding({ status: "dismissed", dismissed_at: "2026-11-15T10:00:00.000+08:00", ask: ask("ask-3", LANE, "c") as Finding["ask"] }),
		finding({ status: "dismissed", dismissed_at: "2026-10-01T10:00:00.000Z", ask: ask("ask-4", LANE, "d") as Finding["ask"] }),
		finding({ status: "claimed", ask: ask("ask-5", LANE, "e") as Finding["ask"] }),
	];
	const seats = new GuardSeats();
	const { seat } = seats.enter({}, "/s.jsonl", { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj", tools: ["bash"] }, grant: grantOf(PUSH) });
	const t = guardTurn(seat, findings, 1, NOW);
	assert.deepEqual([...t.open], [[callKey("bash", inputHash({ command: "a" })), "ask-1"]], "another lane's question and a claimed one are not open here");
	assert.deepEqual([...t.refused], [[callKey("bash", inputHash({ command: "c" })), "2026-11-15"]], "a no older than 14 days no longer holds");
	assert.deepEqual([t.resumable, t.lane, t.tools, t.granted?.ask], [true, LANE, ["bash"], "ask-granted"]);
	seat.grantUsed = true;
	assert.equal(guardTurn(seat, findings, 1, NOW).granted, undefined, "a used grant admits nothing");
	const none = guardTurn(undefined, findings, 1, NOW);
	assert.deepEqual([none.resumable, none.lane, none.open.size, none.refused.size], [false, undefined, 0, 0], "no seat: no lane, nothing read");
});

test("GuardSeats: one seat per session, found by the session object and not by its file; the report names the grant only for a run that had one", () => {
	const seats = new GuardSeats();
	const seed: GuardSeed = { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj" } };
	const session = {};
	const a = seats.enter(session, "/a.jsonl", seed);
	assert.throws(() => seats.enter(session, "/a.jsonl", seed), /already has the guard's seat/);
	assert.equal(seats.of(session), a.seat);
	assert.equal(seats.of({}), undefined, "another session with the same file has no seat");
	assert.equal(seats.of(undefined), undefined);
	a.seat.asked.push("ask-1");
	assert.deepEqual(a.leave(), { asked: ["ask-1"] });
	assert.equal(seats.of(session), undefined, "a run that left has no seat");
	const b = seats.enter({}, "/b.jsonl", { ...seed, grant: grantOf(PUSH) });
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
		hop: 1,
		now: () => NOW,
		log: (m) => log.push(m),
	};
	return { inbox, deps, log, reads: () => reads };
}

test("[Q1] guardCall: a blocked call files one question, with the derived id and the hash of the input it saw", async () => {
	const w = world();
	const seats = new GuardSeats();
	const { seat, leave } = seats.enter({}, "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj", tools: ["bash", "read"] } });
	const first = await guardCall(bash(PUSH, { toolCallId: "call-1" }), seat, w.deps);
	assert.equal(first?.block, true);
	assert.match(first!.reason, /^asked a person: git push --force on main\/master\. pi-loops did not run this/);
	const ask = askId("/runs/s1.jsonl", "call-1");
	const filed = w.inbox.list();
	assert.deepEqual(filed.map((f) => f.id), [askFindingId(ask)]);
	assert.deepEqual([filed[0].ask?.id, filed[0].ask?.lane, filed[0].lane, filed[0].ask?.session_file, filed[0].ask?.call.input_sha256, filed[0].ask?.run?.tools], [ask, LANE, LANE, "/runs/s1.jsonl", inputHash({ command: PUSH }), ["bash", "read"]]);

	const again = await guardCall(bash(PUSH, { toolCallId: "call-2" }), seat, w.deps);
	assert.match(again!.reason, /^asked a person:/, "the same call later in the turn is told it is asked");
	await guardCall(bash(PUSH, { toolCallId: "call-1" }), seat, w.deps);
	assert.equal(w.inbox.list().length, 1, "a second block of the same call in the same lane files no second question");
	assert.deepEqual(leave(), { asked: [ask] }, "and it is counted once");
});

test("[Q1] guardCall: a nested call is refused with the words of the guard before questions, and files nothing", async () => {
	const w = world();
	const { seat } = new GuardSeats().enter({}, "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj" } });
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
	const { seat } = new GuardSeats().enter({}, "/runs/s1.jsonl", { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj" } });
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
	const granted = seats.enter({}, "/runs/s2.jsonl", { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj" }, grant: grantOf(PUSH) });
	assert.equal(await guardCall(bash(PUSH, { toolCallId: "call-a" }), granted.seat, w.deps), undefined, "the granted call goes through");
	assert.equal(w.reads(), 0, "and reads no inbox");
	const second = await guardCall(bash(PUSH, { toolCallId: "call-b" }), granted.seat, w.deps);
	assert.match(second!.reason, /^asked a person:/, "a second identical call is not granted: it is asked about");
	assert.deepEqual(granted.leave(), { grant_used: true, asked: [askId("/runs/s2.jsonl", "call-b")] });

	const allowed = world([PUSH]);
	const policy = seats.enter({}, "/runs/s3.jsonl", { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj" }, grant: grantOf(PUSH) });
	assert.equal(await guardCall(bash(PUSH), policy.seat, allowed.deps), undefined);
	assert.deepEqual([policy.leave(), allowed.reads()], [{ grant_used: true, asked: [] }, 0], "[danger] allow ran the granted call: the grant counts as used");

	const unused = seats.enter({}, "/runs/s4.jsonl", { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj" }, grant: grantOf(PUSH) });
	assert.equal(await guardCall(bash("ls"), unused.seat, w.deps), undefined);
	assert.deepEqual(unused.leave(), { grant_used: false, asked: [] }, "another call the policy passes leaves the grant unused");
});

test("[review-F1] a nested call never uses a grant: it is refused before the grant is looked at, and a policy allow of it spends nothing", async () => {
	const nested = bash(PUSH, { toolCallId: "call-1/1", parentToolCallId: "call-1" });
	assert.deepEqual(judgeCall(nested, turn({ granted: grantOf(PUSH) }), cfg), { kind: "refuse", reason: PUSH_REASON, whyNot: { why: "no-transcript" } });
	assert.deepEqual(judgeCall(nested, turn({ granted: grantOf(PUSH) }), { allowCommands: [PUSH] }), { kind: "allow" }, "the policy passes it, and the grant stays");
	const w = world();
	const { seat, leave } = new GuardSeats().enter({}, "/runs/s5.jsonl", { lane: LANE, origin: ORIGIN, cap: { cwd: "/proj" }, grant: grantOf(PUSH) });
	const out = await guardCall(nested, seat, w.deps);
	assert.match(out!.reason, /^refused by pi-loops: git push --force on main\/master\. This run is unattended/);
	assert.deepEqual([leave(), w.inbox.list().length], [{ grant_used: false, asked: [] }, 0], "the grant is unused and nothing is filed");
});
