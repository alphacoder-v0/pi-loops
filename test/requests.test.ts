import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import * as path from "node:path";
import { RequestStore, imageRef, parseRow, type Row, type UnclaimedRow } from "../src/requests.ts";
import { personRow } from "../src/engine.ts";

test("each conversation's queue has its own lock, and a requests.lock an older version left is nobody's", () => {
	// One `requests.lock` for every session meant a rewrite of one session's file (or a lock left by
	// a dead process) held every writer of every other session, event loop blocked, for the stale wait.
	const dir = tmp();
	const store = new RequestStore(dir);
	// Session a's lock, held by this live process: a's writers wait, b's must not.
	fs.mkdirSync(path.join(dir, "requests", "a.lock"), { recursive: true });
	fs.writeFileSync(path.join(dir, "requests", "a.lock", "owner"), `${process.pid}.-.deadbeef0000`);
	fs.mkdirSync(path.join(dir, "requests.lock"), { recursive: true });
	fs.writeFileSync(path.join(dir, "requests.lock", "owner"), `${process.pid}.-.deadbeef0000`);
	const startedAt = Date.now();
	store.append(row("1", { lane: "b" }));
	store.remove("b", []);
	assert.ok(Date.now() - startedAt < 2_000, `b's append and rewrite waited on nobody (${Date.now() - startedAt} ms)`);
	assert.deepEqual(store.list("b").map((r) => r.id), ["1"]);
	assert.deepEqual(store.sessions(), ["b"], "a lock directory is not a session");
	assert.equal(fs.existsSync(path.join(dir, "requests", "a.lock")), true, "a's lock is still a's");
});

test("update says whether the row was there, and removeIf removes a row only while its condition holds, in one critical section", () => {
	const store = new RequestStore(tmp());
	const by = { pid: 1, instance: "web", version: "0" };
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	store.append(personRow("p1", "one", [image], { sessionId: "s", cwd: "/p", createdBy: by }), [image]);
	store.append(personRow("p2", "two", undefined, { sessionId: "s", cwd: "/p", createdBy: by }));
	assert.equal(store.update("s", "p2", { handed_at: "2026-01-01T00:00:00Z" }), true, "stamped");
	assert.equal(store.update("s", "gone", { handed_at: "2026-01-01T00:00:00Z" }), false, "a row that is not there cannot be stamped, and the caller is told");
	const unhanded = (r: Row) => r.handed_at === undefined;
	assert.deepEqual(store.removeIf("s", "p2", unhanded), { outcome: "kept", row: store.list("s")[1] }, "a row already handed to pi stays");
	assert.deepEqual(store.list("s").map((r) => r.id), ["p1", "p2"]);
	const taken = store.removeIf("s", "p1", unhanded);
	assert.equal(taken.outcome, "removed");
	assert.deepEqual(store.list("s").map((r) => r.id), ["p2"]);
	assert.equal(fs.existsSync(store.imageFile("s", "p1")), false, "its image file goes with it");
	assert.deepEqual(store.removeIf("s", "p1", unhanded), { outcome: "missing" });
});

test("an append that fails leaves no image file behind", () => {
	const store = new RequestStore(tmp());
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	const row = personRow("p1", "look", [image], { sessionId: "s", cwd: "/p", createdBy: { pid: 1, instance: "web", version: "0" } });
	// A directory where the queue file should be: the append throws after the image was written.
	fs.mkdirSync(store.file("s"), { recursive: true });
	assert.throws(() => store.append(row, [image]));
	assert.equal(fs.existsSync(store.imageFile("s", "p1")), false, "the image file was taken back with the failed append");
});

test("sweepImages removes image files no row names, once they are a minute old", () => {
	const store = new RequestStore(tmp());
	const by = { pid: 1, instance: "web", version: "0" };
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	store.append(personRow("p1", "kept", [image], { sessionId: "s", cwd: "/p", createdBy: by }), [image]);
	const dir = path.join(store.dir, "requests");
	const old = path.join(dir, `s.${"a".repeat(32)}.images.json`);
	const young = path.join(dir, `other.${"b".repeat(32)}.images.json`);
	fs.writeFileSync(old, "[]");
	fs.writeFileSync(young, "[]");
	const twoMinutesAgo = new Date(Date.now() - 120_000);
	fs.utimesSync(old, twoMinutesAgo, twoMinutesAgo);
	assert.deepEqual(store.sweepImages(), [old], "the old orphan goes");
	assert.equal(fs.existsSync(store.imageFile("s", "p1")), true, "a file a row names stays, whatever its age");
	assert.equal(fs.existsSync(young), true, "a young orphan may be an append in flight");
	assert.deepEqual(store.sweepImages(Date.now() + 120_000), [young], "and goes once it is old");
});

test("a person row's image bytes live beside the queue, and the row carries their digests", () => {
	const dir = tmp();
	const store = new RequestStore(dir);
	const image = { type: "image" as const, data: Buffer.alloc(256 * 1024, 7).toString("base64"), mimeType: "image/png" };
	const by = { pid: 1, instance: "web", version: "0" };
	const p1 = personRow("p1", "look", [image, { ...image, mimeType: "image/jpeg" }], { sessionId: "s", cwd: "/p", createdBy: by });
	store.append(p1, [image, { ...image, mimeType: "image/jpeg" }]);
	store.append(personRow("p2", "no image", undefined, { sessionId: "s", cwd: "/p", createdBy: by }));
	assert.ok(fs.statSync(store.file("s")).size < 2_000, `the queue file is lines, not bytes: ${fs.statSync(store.file("s")).size} bytes`);
	const [listed] = store.list("s");
	assert.deepEqual(listed.payload?.images, [imageRef(image), { ...imageRef(image), mimeType: "image/jpeg" }], "the row names its images by digest");
	assert.deepEqual(store.images(listed), [image, { ...image, mimeType: "image/jpeg" }], "the bytes come back from the file beside it");
	assert.deepEqual(store.images(store.list("s")[1]), [], "a row without images has none to read");
	// Bytes that are not the row's are refused, not sent as the person's.
	fs.writeFileSync(store.imageFile("s", "p1"), JSON.stringify([{ ...image, data: "AAAA" }, image]));
	assert.throws(() => store.images(listed), /not the ones it was written with/);
	fs.rmSync(store.imageFile("s", "p1"));
	assert.throws(() => store.images(listed), /cannot be read/);
	// The file goes with the row, and only the row's.
	store.append(p1, [image, { ...image, mimeType: "image/jpeg" }]);
	store.remove("s", ["p2"]);
	assert.equal(fs.existsSync(store.imageFile("s", "p1")), true);
	store.remove("s", ["p1"]);
	assert.equal(fs.existsSync(store.imageFile("s", "p1")), false);
	assert.deepEqual(store.sessions(), [], "an image file is not a session either");
	// A row whose images are not digests is not this version's to act on.
	assert.equal(parseRow(JSON.stringify(row("x", { payload: { text: "t", cwd: "/", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] as any } }))), undefined);
});

const row = (id: string, over: Partial<UnclaimedRow> = {}): UnclaimedRow => ({ v: 3, id, lane: "s", kind: "input", source: "rule:local:dynamic", mode: "none", wake: "append", payload: { text: `[Trigger ${id}] hello`, cwd: "/" }, created_at: "2026-01-01T00:00:00Z", created_by: { pid: 1, instance: "w", version: "0" }, attempts: 0, ...over });
const v2Line = '{"v":2,"id":"r1","session_id":"s1","kind":"input","source":"cli","mode":"attended","created_at":"2026-11-01T00:00:00.000+00:00","created_by":{"pid":1,"instance":"w","version":"0.24.2"},"attempts":0,"payload":{"text":"hi","cwd":"/p"}}';

test("[v2-read-as-v3] a line written by 0.24.2 is listed under its lane", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${v2Line}\n`);
	const [listed] = store.list("s1");
	assert.equal(listed.v, 3);
	assert.equal(listed.lane, "s1");
	assert.equal(Object.hasOwn(listed, "session_id"), false);
});

test("[v2-read-as-v3] a row this version appends is a v3 line with lane and no session_id", () => {
	const store = new RequestStore(tmp());
	store.append(row("r1", { lane: "s1" }));
	const written = JSON.parse(fs.readFileSync(store.file("s1"), "utf8"));
	assert.equal(written.v, 3);
	assert.equal(written.lane, "s1");
	assert.equal(Object.hasOwn(written, "session_id"), false);
});

test("[v2-read-as-v3] a v2 line this version does not change keeps its bytes through a rewrite", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${v2Line}\n${JSON.stringify(row("r2", { lane: "s1" }))}\n`);
	// Each kind of rewrite: a claim of another row, a patch of it, a refused removal, a removal.
	assert.equal(store.claim("s1", "r2", { id: "run-9", pid: 1, started_at: "2026-11-01T00:00:00.000+00:00" }), true);
	assert.equal(fs.readFileSync(store.file("s1"), "utf8").split("\n")[0], v2Line, "after another row was claimed");
	assert.equal(store.update("s1", "r2", { attempts: 1 }), true);
	assert.equal(fs.readFileSync(store.file("s1"), "utf8").split("\n")[0], v2Line, "after another row was patched");
	assert.equal(store.removeIf("s1", "r2", () => false).outcome, "kept");
	assert.equal(fs.readFileSync(store.file("s1"), "utf8").split("\n")[0], v2Line, "after a removal that was refused");
	store.remove("s1", ["r2"]);
	assert.equal(fs.readFileSync(store.file("s1"), "utf8"), `${v2Line}\n`, "after another row was removed: the file is that line and nothing else");
});

test("[v2-read-as-v3] a v2 row this version patches stays a version 2 line: the version that wrote it still reads it", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${v2Line}\n`);
	// Every field a drain patches: a failure, a backoff, a hand-over stamp, the producer leaving.
	assert.equal(store.update("s1", "r1", { attempts: 1, last_error: "boom", not_before: "2026-11-01T00:01:00.000+00:00", handed_at: "2026-11-01T00:00:30.000+00:00" }), true);
	const written = JSON.parse(fs.readFileSync(store.file("s1"), "utf8"));
	assert.deepEqual([written.v, written.session_id, Object.hasOwn(written, "lane")], [2, "s1", false], "as 0.24.2 reads a line: version 2, with session_id");
	assert.deepEqual([written.attempts, written.last_error, written.not_before, written.handed_at], [1, "boom", "2026-11-01T00:01:00.000+00:00", "2026-11-01T00:00:30.000+00:00"]);
	const { attempts: _a, last_error: _e, not_before: _n, handed_at: _h, ...rest } = written;
	const { attempts: _b, ...original } = JSON.parse(v2Line);
	assert.deepEqual(rest, original, "every other field is as 0.24.2 wrote it");
	// This version reads it as it reads any version 2 line, and a second patch keeps it version 2.
	assert.deepEqual([store.list("s1")[0].lane, store.list("s1")[0].attempts], ["s1", 1]);
	store.update("s1", "r1", { attempts: 2 });
	assert.equal(JSON.parse(fs.readFileSync(store.file("s1"), "utf8")).v, 2);
});

test("[v2-read-as-v3] a row this version appended is patched as version 3", () => {
	const store = new RequestStore(tmp());
	store.append(row("r1", { lane: "s1" }));
	store.update("s1", "r1", { attempts: 1 });
	const written = JSON.parse(fs.readFileSync(store.file("s1"), "utf8"));
	assert.deepEqual([written.v, written.lane, Object.hasOwn(written, "session_id")], [3, "s1", false]);
});

test("a line of a version this one does not know is kept and not listed", () => {
	const store = new RequestStore(tmp());
	const unknown = JSON.stringify({ ...JSON.parse(v2Line), v: 4 });
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${unknown}\n`);
	assert.deepEqual(store.list("s1"), []);
	store.remove("s1", []);
	assert.equal(fs.readFileSync(store.file("s1"), "utf8"), `${unknown}\n`);
});

test("a v3 line without a lane, and a v2 line without a session_id, are kept and not listed", () => {
	const store = new RequestStore(tmp());
	const { lane: _, ...withoutLane } = row("r1", { lane: "s1" });
	const { session_id: __, ...withoutSessionId } = { ...JSON.parse(v2Line) };
	// A version reads its own field only: a version 3 line that names its queue as version 2 did is not read, nor the reverse.
	const lines = [JSON.stringify(withoutLane), JSON.stringify(withoutSessionId), JSON.stringify({ ...withoutLane, session_id: "s1" }), JSON.stringify({ ...withoutSessionId, lane: "s1" })];
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${lines.join("\n")}\n`);
	assert.deepEqual(store.list("s1"), []);
	store.remove("s1", []);
	assert.equal(fs.readFileSync(store.file("s1"), "utf8"), `${lines.join("\n")}\n`);
});

test("append, list, remove and sessions keep rows in order and drop the file with the last row", () => {
	const store = new RequestStore(tmp());
	store.append(row("1"));
	store.append(row("2"));
	assert.deepEqual(store.list("s").map((r) => r.id), ["1", "2"]);
	assert.deepEqual(store.sessions(), ["s"]);
	store.remove("s", ["1"]);
	assert.deepEqual(store.list("s").map((r) => r.id), ["2"]);
	store.remove("s", ["2"]);
	assert.equal(fs.existsSync(store.file("s")), false);
	assert.deepEqual(store.sessions(), []);
	assert.deepEqual(store.list("never"), [], "a session with no file has no rows");
});

test("a line this version cannot act on is skipped by list and kept by remove and update", () => {
	const store = new RequestStore(tmp());
	store.append(row("1"));
	const newer = JSON.stringify({ ...row("3"), v: 3, kind: "redact" });
	const unknownKind = JSON.stringify({ ...row("4"), kind: "resume" });
	fs.appendFileSync(store.file("s"), `${newer}\n${unknownKind}\n`);
	store.append(row("2"));
	fs.appendFileSync(store.file("s"), '{"torn":');
	assert.deepEqual(store.list("s").map((r) => r.id), ["1", "2"], "only rows of this version, of a known kind, that parse");
	store.update("s", "2", { attempts: 1, last_error: "no", not_before: "2026-01-01T00:01:00Z" });
	store.remove("s", ["1"]);
	const lines = fs.readFileSync(store.file("s"), "utf8").split("\n").filter(Boolean);
	assert.deepEqual([lines[0], lines[1], lines[3]], [newer, unknownKind, '{"torn":'], "kept verbatim: a newer row for the version that wrote it, a torn line as it is");
	assert.deepEqual(store.list("s").map((r) => [r.id, r.attempts, r.last_error]), [["2", 1, "no"]], "the update reached the row");
	assert.equal(parseRow(newer), undefined);
	assert.equal(parseRow(unknownKind), undefined);
	assert.equal(parseRow("nope"), undefined);
	assert.equal(parseRow(JSON.stringify(row("5")))?.id, "5");
});

test("a session id that could leave the directory is refused", () => {
	const store = new RequestStore(tmp());
	assert.throws(() => store.append(row("1", { lane: "../x" })), /invalid lane id: \.\.\/x/);
});

test("a row appended after a write cut short is not lost to the torn line", () => {
	const store = new RequestStore(tmp());
	store.append(row("1"));
	fs.appendFileSync(store.file("s"), '{"torn":');
	store.append(row("2"));
	assert.deepEqual(store.list("s").map((r) => r.id), ["1", "2"]);
});

test("a row whose fields are not the shape the engine reads is skipped, not thrown on", () => {
	assert.equal(parseRow(JSON.stringify({ ...row("1"), source: 7 })), undefined);
	assert.equal(parseRow(JSON.stringify({ ...row("1"), mode: null })), undefined);
	assert.equal(parseRow(JSON.stringify({ ...row("1"), payload: { text: 3, cwd: "/" } })), undefined);
	assert.equal(parseRow(JSON.stringify({ ...row("1"), payload: "text" })), undefined);
	// The engine reads the producer of every local row: one without it would throw in each drain.
	const { created_by: _, ...noProducer } = row("1");
	assert.equal(parseRow(JSON.stringify(noProducer)), undefined);
	assert.equal(parseRow(JSON.stringify({ ...row("1"), created_by: { pid: "1", instance: "w", version: "0" } })), undefined);
	assert.equal(parseRow(JSON.stringify({ ...row("1"), created_by: { pid: 1, instance: "w", version: "0", left: 0 } })), undefined);
	assert.equal(parseRow(JSON.stringify(row("1")))?.id, "1");
});

test("a row naming another session, or with a requires or target of the wrong shape, is skipped", () => {
	const store = new RequestStore(tmp());
	store.append(row("1"));
	fs.appendFileSync(store.file("s"), `${JSON.stringify(row("2", { lane: "other" }))}\n`);
	assert.deepEqual(store.list("s").map((r) => r.id), ["1"], "a planted row for another conversation is not this file's");
	assert.equal(parseRow(JSON.stringify(row("3", { payload: { text: "[Trigger 3] x", cwd: "/", requires: "srv" as any } }))), undefined);
	assert.equal(parseRow(JSON.stringify(row("4", { kind: "stop", target: "x" as any }))), undefined);
	assert.equal(parseRow(JSON.stringify(row("5", { kind: "stop", target: { current: true } as any }))), undefined);
	assert.equal(parseRow(JSON.stringify(row("6", { kind: "stop", target: { id: "1" } })))?.id, "6");
});

const claim = { id: "run-1", pid: 4242, procStart: "100", started_at: "2026-11-01T00:00:00.000+00:00" };

test("[lanes-and-sessions] a conversation's queue is in sessions(), a loop's and a check's are in lanes() with their kind, and a file that names no lane is in neither", () => {
	const store = new RequestStore(tmp());
	store.append(row("c1", { lane: "s1" }));
	store.append(row("l1", { lane: "@cron-0123abcd" }));
	store.append(row("k1", { lane: "@check-piz-1a2b3c4d" }));
	const dir = path.dirname(store.file("s1"));
	for (const name of ["@x.jsonl", "@cron-.jsonl", ".hidden.jsonl", "notes.txt"]) fs.writeFileSync(path.join(dir, name), "{}\n");
	assert.deepEqual(store.sessions(), ["s1"]);
	assert.deepEqual(store.lanes().sort((a, b) => a.id.localeCompare(b.id)), [{ kind: "check", id: "@check-piz-1a2b3c4d" }, { kind: "loop", id: "@cron-0123abcd" }]);
	assert.deepEqual(store.list("@cron-0123abcd").map((r) => r.id), ["l1"], "a lane's rows are listed for the lane");
	assert.deepEqual(store.list("@x"), [], "an id that is no lane has no rows, and asking is not an error");
	for (const name of ["@x.jsonl", "@cron-.jsonl", ".hidden.jsonl"]) assert.equal(fs.existsSync(path.join(dir, name)), true, `${name} stays for whatever wrote it`);
});

test("[lanes-and-sessions] a row that names another lane than its file's is not this file's for any method", () => {
	const store = new RequestStore(tmp());
	store.append(row("mine", { lane: "s1" }));
	const stray = JSON.stringify(row("stray", { lane: "s2" }));
	fs.appendFileSync(store.file("s1"), `${stray}\n`);
	assert.deepEqual(store.list("s1").map((r) => r.id), ["mine"]);
	assert.equal(store.update("s1", "stray", { attempts: 2 }), false, "not patched");
	assert.deepEqual(store.removeIf("s1", "stray", () => true), { outcome: "missing" }, "not taken");
	store.remove("s1", ["stray", "mine"]);
	assert.equal(fs.readFileSync(store.file("s1"), "utf8"), `${stray}\n`, "not removed: the line is as it was written");
});

test("a claim is written once: only on a row that has none, and it makes the line version 3", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${v2Line}\n`);
	assert.equal(store.claim("s1", "r1", claim), true);
	assert.equal(store.claim("s1", "r1", { ...claim, id: "run-2", pid: 1 }), false, "a second claim does not take it");
	assert.equal(store.claim("s1", "no-such-row", claim), false);
	const listed = store.list("s1")[0];
	assert.deepEqual(listed.run, claim, "the first claim stands");
	const line = JSON.parse(fs.readFileSync(store.file("s1"), "utf8"));
	assert.deepEqual([line.v, line.lane, "session_id" in line], [3, "s1", false], "an older version cannot read a claimed row, so it cannot hand it over a second time");
	assert.equal(store.update("s1", "r1", { run: undefined, attempts: 1 }), true);
	assert.equal("run" in JSON.parse(fs.readFileSync(store.file("s1"), "utf8")), false, "a patch can clear a claim");
	assert.equal(store.claim("s1", "r1", { ...claim, id: "run-3" }), true, "and the row can be claimed again");
});

test("a line whose claim is damaged is kept and not listed: a broken claim is not a free row", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	const lines = [{ run: "x" }, { run: { id: "r", pid: "1", started_at: "t" } }, { run: { id: "r", pid: 1 } }, { run: { pid: 1, started_at: "t" } }, { run: null }].map((over) => JSON.stringify({ ...row("d", { lane: "s1" }), ...over }));
	// A version 2 line never has a claim: one that does is not a claimed row an older version would also read as free.
	lines.push(JSON.stringify({ ...JSON.parse(v2Line), id: "d", run: { id: "r", pid: 1, started_at: "2026-11-01T00:00:00.000+00:00" } }));
	fs.writeFileSync(store.file("s1"), `${lines.join("\n")}\n`);
	assert.deepEqual(store.list("s1"), []);
	store.remove("s1", ["d"]);
	assert.equal(fs.readFileSync(store.file("s1"), "utf8"), `${lines.join("\n")}\n`);
});

test("only an input can be claimed: a stop or a cancel is never a run, and a line that says otherwise is not read", () => {
	const store = new RequestStore(tmp());
	const stop = { ...row("st", { lane: "s1" }), kind: "stop" as const, mode: "none" as const, payload: undefined, target: { id: "x" } };
	store.append(stop);
	assert.equal(store.claim("s1", "st", { id: "run-1", pid: 1, started_at: "2026-11-01T00:00:00.000+00:00" }), false);
	assert.equal(store.list("s1")[0].run, undefined);
	const forged = JSON.stringify({ ...stop, id: "forged", run: { id: "run-2", pid: 1, started_at: "2026-11-01T00:00:00.000+00:00" } });
	fs.appendFileSync(store.file("s1"), `${forged}\n`);
	assert.deepEqual(store.list("s1").map((r) => r.id), ["st"], "a claimed stop is a line this version does not act on");
	assert.equal(fs.readFileSync(store.file("s1"), "utf8").includes(forged), true, "and it stays as it was written");
});

test("a version 2 row is listed with its source line version", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${v2Line}\n`);
	assert.equal(store.list("s1")[0].line, 2);
});

test("a version 3 row has no source line field, even when the disk line has one", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${JSON.stringify({ ...row("r1", { lane: "s1" }), line: 2 })}\n`);
	assert.equal(Object.hasOwn(store.list("s1")[0], "line"), false);
});

test("updating a version 2 row keeps its version and never writes the reader field", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${v2Line}\n`);
	assert.equal(store.update("s1", "r1", { attempts: 1 }), true);
	const written = JSON.parse(fs.readFileSync(store.file("s1"), "utf8"));
	assert.equal(written.v, 2);
	assert.equal(Object.hasOwn(written, "line"), false);
});

test("claiming a version 2 row writes version 3 without the reader field", () => {
	const store = new RequestStore(tmp());
	fs.mkdirSync(path.dirname(store.file("s1")), { recursive: true });
	fs.writeFileSync(store.file("s1"), `${v2Line}\n`);
	assert.equal(store.claim("s1", "r1", claim), true);
	const written = JSON.parse(fs.readFileSync(store.file("s1"), "utf8"));
	assert.equal(written.v, 3);
	assert.equal(Object.hasOwn(written, "line"), false);
});

test("appending a row with the reader field never writes it", () => {
	const store = new RequestStore(tmp());
	store.append(row("r1", { line: 2 }));
	const written = JSON.parse(fs.readFileSync(store.file("s"), "utf8"));
	assert.equal(Object.hasOwn(written, "line"), false);
});
