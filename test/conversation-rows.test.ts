import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { ConversationIndex, countNeedsYou, holderOf, NeedsYouCounts, projectLabel, ROW_CAP, type RowReaders, titleOf } from "../src/conversation-rows.ts";
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
