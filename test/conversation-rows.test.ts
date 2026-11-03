import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { ConversationIndex, countNeedsYou, HEAD_CACHE_CAP, holderOf, NeedsYouCounts, plainText, projectArgs, projectLabel, ROW_CAP, type RowReaders, titleOf } from "../src/conversation-rows.ts";
import type { LeaseHolder, SessionLease } from "../src/lease.ts";
import { readSessionHead } from "../src/session-head.ts";

/** A session file as pi writes one: the header, then entries. `extra` is appended as written (a torn line, say). */
function session(dir: string, name: string, head: { id: string; cwd: string }, lines: unknown[] = [], extra = "", mtime?: number): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, [JSON.stringify({ type: "session", ...head, timestamp: "2026-11-01T10:00:00.000Z" }), ...lines.map((l) => JSON.stringify(l))].join("\n") + "\n" + extra);
	if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
	return file;
}
const said = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });

const holder = (extra: Partial<LeaseHolder> = {}): LeaseHolder => ({ kind: "terminal", pid: 41, instance: "i", acquiredAt: "2026-11-01T10:00:00.000Z", pushServers: [], ...extra });

function readers(extra: Partial<RowReaders> = {}): RowReaders {
	return { lease: () => undefined, alive: () => true, open: () => false, needsYou: () => new Map(), queued: () => 0, projectCwds: () => [], ...extra };
}

test("a title is the name someone gave the conversation, else the first thing said, as one line of 60", () => {
	assert.equal(titleOf({ name: "release notes", first: "draft them" }), "release notes");
	assert.equal(titleOf({ first: "fix the\n/search cache" }), "fix the /search cache");
	assert.equal(titleOf({ first: "x".repeat(80) }), `${"x".repeat(60)}…`);
	assert.equal(titleOf({ name: "  ", first: undefined }), undefined, "a blank name and nothing said: no title");
	assert.equal(titleOf(undefined), undefined);
});

test("holderOf: a page child's lease is the page's, a terminal's the terminal's, a host's pi-loops'; a dead one is nobody's", () => {
	const alive = () => true;
	assert.deepEqual(holderOf({ holder: holder() }, alive, false), { kind: "terminal", pid: 41, delivers: true });
	assert.deepEqual(holderOf({ holder: holder({ page: true }) }, alive, true), { kind: "page", pid: 41, delivers: true });
	assert.deepEqual(holderOf({ holder: holder({ kind: "host" }) }, alive, false), { kind: "background", pid: 41, delivers: true });
	assert.deepEqual(holderOf({ holder: holder({ aside: true }) }, alive, false), { kind: "terminal", pid: 41, delivers: false }, "a terminal standing aside answers nothing");
	assert.deepEqual(holderOf({ holder: holder({ mode: "print" }) }, alive, false), { kind: "terminal", pid: 41, delivers: false }, "nor does a one-shot run");
	assert.deepEqual(holderOf({ holder: holder() }, () => false, false), { kind: "none", delivers: false }, "a dead pid holds nothing");
	assert.deepEqual(holderOf({ holder: null }, alive, false), { kind: "none", delivers: false });
	assert.deepEqual(holderOf(undefined, alive, true), { kind: "page", delivers: true }, "a pool child whose lease is not written yet");
});

test("needs you counts the new decisions by the conversation that made the loop, and skips a torn line", () => {
	const text = [
		{ status: "new", kind: "checkpoint", session_id: "a" },
		{ status: "new", kind: "checkpoint", session_id: "a" },
		{ status: "new", kind: "news", session_id: "a" },
		{ status: "claimed", kind: "checkpoint", session_id: "a" },
		{ kind: "checkpoint", session_id: "b" },
		{ status: "new", kind: "checkpoint" },
	].map((e) => JSON.stringify(e)).join("\n") + '\n{"status":"new","kind":"checkp';
	assert.deepEqual([...countNeedsYou(text)], [["a", 2], ["b", 1]]);
	const dir = tmp("pi-loops-rows-");
	const counts = new NeedsYouCounts(path.join(dir, "inbox.jsonl"));
	assert.equal(counts.get().size, 0, "no inbox yet");
	fs.writeFileSync(path.join(dir, "inbox.jsonl"), text);
	assert.equal(counts.get().get("a"), 2);
});

test("a project is keyed by the cwd in its newest header, labelled with ~ for home, and a lease's or a job's cwd is offered too", () => {
	const root = tmp("pi-loops-rows-");
	session(path.join(root, "--work-api--"), "1.jsonl", { id: "s1", cwd: "/work/api" }, [said("one")], "", Date.now() - 60_000);
	session(path.join(root, "--work-api--"), "2.jsonl", { id: "s2", cwd: "/work/api" }, [said("two")]);
	session(path.join(root, "--work-web--"), "3.jsonl", { id: "s3", cwd: "/work/web" }, [said("three")], "", Date.now() - 3_600_000);
	// A directory name that decodes to something else does not matter: the header says.
	session(path.join(root, "--misleading--"), "4.jsonl", { id: "s4", cwd: "/work/real" }, [], "", Date.now() - 7_200_000);
	fs.mkdirSync(path.join(root, "--empty--"));
	const index = new ConversationIndex(root);
	const projects = index.projects({ projectCwds: () => ["/work/loops-only", "/work/api", ""] });
	assert.deepEqual(projects.map((p) => p.cwd), ["/work/api", "/work/web", "/work/real", "/work/loops-only"]);
	assert.deepEqual(projects.map((p) => p.conversations), [2, 1, 1, 0]);
	assert.equal(projects[3].lastActivityAt, undefined);
	assert.equal(projectLabel("/home/me/code/api", "/home/me"), "~/code/api");
	assert.equal(projectLabel("/home/meo", "/home/me"), "/home/meo", "a sibling of home is not under it");
});

test("rows: newest first, a title from the head, the holder from the lease, needs you and queued counted", () => {
	const root = tmp("pi-loops-rows-");
	const dir = path.join(root, "--work-api--");
	session(dir, "a.jsonl", { id: "a", cwd: "/work/api" }, [said("fix the cache"), { type: "session_info", name: "cache fix" }], "", Date.now() - 60_000);
	session(dir, "b.jsonl", { id: "b", cwd: "/work/api" }, [said("release notes")]);
	session(dir, "c.jsonl", { id: "c", cwd: "/work/api" }, [], "", Date.now() - 120_000);
	const index = new ConversationIndex(root);
	const leases: Record<string, Partial<SessionLease>> = { a: { holder: holder() }, b: { holder: holder({ kind: "host" }) } };
	const got = index.rows("/work/api", readers({ lease: (id) => leases[id], open: (id) => id === "c", needsYou: () => new Map([["a", 2]]), queued: (id) => (id === "b" ? 1 : 0) }));
	assert.ok(got);
	assert.deepEqual(got.rows.map((r) => [r.sessionId, r.title, r.holder, r.open, r.needsYou, r.queued]), [
		["b", "release notes", "background", false, 0, 1],
		["a", "cache fix", "terminal", false, 2, 0],
		["c", undefined, "page", true, 0, 0],
	]);
	assert.equal(got.more, 0);
	assert.ok(!Number.isNaN(Date.parse(got.rows[0].lastActivityAt)));
	assert.equal(index.rows("/work/other", readers()), undefined, "a cwd that is not a project here is not looked up");
	assert.deepEqual(index.rows("/work/loops-only", readers({ projectCwds: () => ["/work/loops-only"] })), { rows: [], more: 0 }, "a project only a lease or a job names has no rows");
});

test("a torn last line keeps the earlier title; a torn header is not a row; a link is not a session file", () => {
	const root = tmp("pi-loops-rows-");
	const dir = path.join(root, "--work-api--");
	session(dir, "torn.jsonl", { id: "torn", cwd: "/work/api" }, [said("the earlier title")], '{"type":"session_info","name":"half wri');
	fs.writeFileSync(path.join(dir, "bad.jsonl"), '{"type":"session","id":"bad","cw');
	fs.symlinkSync(path.join(dir, "torn.jsonl"), path.join(dir, "link.jsonl"));
	const got = new ConversationIndex(root).rows("/work/api", readers());
	assert.deepEqual(got?.rows.map((r) => [r.sessionId, r.title]), [["torn", "the earlier title"]]);
});

test("at most 500 rows, the rest counted in more", () => {
	const root = tmp("pi-loops-rows-");
	const dir = path.join(root, "--work-api--");
	for (let i = 0; i < ROW_CAP + 3; i++) session(dir, `${i}.jsonl`, { id: `s${i}`, cwd: "/work/api" }, [], "", Date.now() - i * 1000);
	const got = new ConversationIndex(root).rows("/work/api", readers());
	assert.equal(got?.rows.length, ROW_CAP);
	assert.equal(got?.more, 3);
	assert.equal(got?.rows[0].sessionId, "s0", "newest first");
});

test("200 conversations: a warm answer reads no head again, and one file written since is the one read", () => {
	const root = tmp("pi-loops-rows-");
	const dir = path.join(root, "--work-api--");
	for (let i = 0; i < 200; i++) session(dir, `${String(i).padStart(3, "0")}.jsonl`, { id: `s${i}`, cwd: "/work/api" }, [said(`conversation ${i}`)], "", Date.now() - i * 1000);
	const reads: string[] = [];
	const index = new ConversationIndex(root, (file) => {
		reads.push(file);
		return readSessionHead(file);
	});
	const cold = Date.now();
	assert.equal(index.rows("/work/api", readers())?.rows.length, 200);
	const coldMs = Date.now() - cold;
	assert.ok(coldMs < 1500, `a cold answer took ${coldMs} ms`);
	assert.equal(reads.length, 200, "each head read once, cold");
	reads.length = 0;
	const warm = Date.now();
	index.projects({ projectCwds: () => [] });
	assert.equal(index.rows("/work/api", readers())?.rows.length, 200);
	const warmMs = Date.now() - warm;
	assert.deepEqual(reads, [], "a warm answer reads no head");
	assert.ok(warmMs < 300, `a warm answer took ${warmMs} ms`);
	fs.appendFileSync(path.join(dir, "007.jsonl"), `${JSON.stringify(said("more"))}\n`);
	index.rows("/work/api", readers());
	assert.deepEqual(reads.map((f) => path.basename(f)), ["007.jsonl"], "only the file written since");
});

test("byId finds a file by its header id, under the sessions root only, and refuses what is not an id", () => {
	const root = tmp("pi-loops-rows-");
	const dir = path.join(root, "--work-api--");
	// pi's own name carries the id; a page's new conversation is named after another uuid.
	const named = session(dir, "2026-11-01_a1b2.jsonl", { id: "a1b2", cwd: "/work/api" });
	const other = session(dir, "2026-11-01_zzzz.jsonl", { id: "c3d4", cwd: "/work/api" });
	const index = new ConversationIndex(root);
	assert.deepEqual(index.byId("a1b2"), { sessionFile: named, cwd: "/work/api" });
	assert.deepEqual(index.byId("c3d4"), { sessionFile: other, cwd: "/work/api" });
	assert.equal(index.byId("nobody"), undefined);
	assert.equal(index.byId(".."), undefined);
	assert.equal(index.byId("../x"), undefined);
	const outside = tmp("pi-loops-rows-");
	session(outside, "x.jsonl", { id: "x9", cwd: "/work/api" });
	assert.equal(index.byId("x9"), undefined, "a file outside the root is not found");
});

test("without a sessions root only the directories leases name are read", () => {
	const root = tmp("pi-loops-rows-");
	const leased = session(path.join(root, "--work-api--"), "a.jsonl", { id: "a", cwd: "/work/api" });
	session(path.join(root, "--work-web--"), "b.jsonl", { id: "b", cwd: "/work/web" });
	const index = new ConversationIndex(undefined, undefined, () => [leased, "relative/x.jsonl"]);
	assert.deepEqual(index.projects({ projectCwds: () => [] }).map((p) => p.cwd), ["/work/api"]);
	assert.equal(index.byId("b"), undefined);
	assert.equal(index.byId("a")?.sessionFile, leased);
	assert.deepEqual(new ConversationIndex(undefined).projects({ projectCwds: () => [] }), [], "and with no lease, nothing");
});

/* ------------------------------------------------------------------ rework 1 */

test("a title is drawn as text: no escape sequence, control or bidi override reaches it", () => {
	assert.equal(titleOf({ first: "evil \u001b[31mred\u001b[0m \u202ereversed\u0007" }), "evil red reversed");
	assert.equal(plainText("a\u001b]0;title\u0007b\u2066c\u0085d"), "abcd");
});

test("a row says whether its holder answers what is sent to it", () => {
	const root = tmp("pi-loops-rows-");
	const dir = path.join(root, "--work-api--");
	session(dir, "a.jsonl", { id: "a", cwd: "/work/api" });
	session(dir, "b.jsonl", { id: "b", cwd: "/work/api" }, [], "", Date.now() - 1000);
	const leases: Record<string, Partial<SessionLease>> = { a: { holder: holder() }, b: { holder: holder({ mode: "print" }) } };
	const got = new ConversationIndex(root).rows("/work/api", readers({ lease: (id) => leases[id] }));
	assert.deepEqual(got?.rows.map((r) => [r.sessionId, r.holder, r.delivers]), [["a", "terminal", true], ["b", "terminal", false]]);
});

test("an answer looks at every directory once, for its projects and its rows", () => {
	const root = tmp("pi-loops-rows-");
	session(path.join(root, "--work-api--"), "a.jsonl", { id: "a", cwd: "/work/api" });
	const index = new ConversationIndex(root);
	const scan = index.scan();
	index.projects(readers(), scan);
	index.rows("/work/api", readers(), scan);
	assert.equal(index.scans, 1);
});

test("the head cache lets its least recently used head go, not all of them", () => {
	const reads: string[] = [];
	const index = new ConversationIndex(undefined, (file) => (reads.push(file), undefined));
	const head = (n: number) => (index as any).head({ file: `/f${n}`, mtimeMs: 1, size: 1 });
	for (let i = 0; i < HEAD_CACHE_CAP; i++) head(i);
	head(0); // used again: the newest
	head(HEAD_CACHE_CAP); // one past the cap: the oldest unused (f1) goes
	reads.length = 0;
	head(0);
	assert.deepEqual(reads, [], "a head used recently is still there");
	head(1);
	assert.deepEqual(reads, ["/f1"], "the least recently used one went");
});

test("byId on an id no file has: bounded the first time, and no file read again until a directory changes", () => {
	const root = tmp("pi-loops-rows-");
	// Five projects of 2,000 each: a directory is looked at up to 2,000 entries, as the list cuts it.
	const dirOf = (i: number) => path.join(root, `--work-${Math.floor(i / 2000)}--`);
	for (let d = 0; d < 5; d++) fs.mkdirSync(dirOf(d * 2000), { recursive: true });
	const header = (i: number) => `${JSON.stringify({ type: "session", id: `0000${i}`, cwd: "/work/api", timestamp: "2026-11-01T10:00:00.000Z" })}\n${JSON.stringify(said("x".repeat(2000)))}\n`;
	for (let i = 0; i < 10_000; i++) fs.writeFileSync(path.join(dirOf(i), `2026-11-01_${String(i).padStart(5, "0")}.jsonl`), header(i));
	const heads: string[] = [];
	const ids: string[] = [];
	const index = new ConversationIndex(root, (f) => (heads.push(f), readSessionHead(f)), undefined, (f) => {
		ids.push(f);
		const line = fs.readFileSync(f, "utf8").split("\n")[0];
		return JSON.parse(line).id;
	});
	const cold = Date.now();
	assert.equal(index.byId("nobody"), undefined);
	const coldMs = Date.now() - cold;
	assert.equal(heads.length, 0, "no head is read for an id no file is named after");
	assert.equal(ids.length, 10_000, "each header once");
	assert.ok(coldMs < 3000, `a cold miss over 10,000 files took ${coldMs} ms`);
	ids.length = 0;
	const warm = Date.now();
	assert.equal(index.byId("nobody"), undefined);
	assert.deepEqual([heads.length, ids.length], [0, 0], "a warm miss reads nothing");
	assert.ok(Date.now() - warm < 100, `a warm miss took ${Date.now() - warm} ms`);
	assert.equal(index.byId("someone-else"), undefined);
	assert.equal(ids.length, 0, "another miss reads no header again either");
	fs.mkdirSync(path.join(root, "--work-late--"));
	fs.writeFileSync(path.join(root, "--work-late--", "2026-11-02_late.jsonl"), `${JSON.stringify({ type: "session", id: "nobody", cwd: "/work/api" })}\n`);
	assert.equal(index.byId("nobody")?.cwd, "/work/api", "a file added since is found");
});

test("a conversation started with no arguments takes those its project's latest one was opened with", () => {
	assert.deepEqual(projectArgs("/work/api", [
		{ cwd: "/work/api", at: 1, args: ["-e", "/old"] },
		{ cwd: "/work/api", at: 3, args: ["-e", "/new"] },
		{ cwd: "/work/api", at: 5, args: [] },
		{ cwd: "/work/web", at: 9, args: ["-e", "/web"] },
	]), ["-e", "/new"]);
	assert.deepEqual(projectArgs("/work/none", [{ cwd: "/work/api", at: 1, args: ["-e", "/x"] }]), []);
	assert.deepEqual(projectArgs("/work/api", [{ cwd: "/work/api", at: 1, args: ["--session", "abc", "-e", "/x", "--session-id=def", "-c", "--fork", "f", "--name", "n", "--model", "m"] }]), ["-e", "/x", "--model", "m"], "never another conversation's own choice of conversation");
});
