import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import * as path from "node:path";
import { RequestStore, imageRef, parseRequestLine, type SessionRequest } from "../src/requests.ts";
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
	store.append(row("1", { session_id: "b" }));
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
	const unhanded = (r: SessionRequest) => r.handed_at === undefined;
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
	assert.equal(parseRequestLine(JSON.stringify(row("x", { payload: { text: "t", cwd: "/", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] as any } }))), undefined);
});

const row = (id: string, over: Partial<SessionRequest> = {}): SessionRequest => ({ v: 2, id, session_id: "s", kind: "input", source: "rule:local:dynamic", mode: "none", wake: "append", payload: { text: `[Trigger ${id}] hello`, cwd: "/" }, created_at: "2026-01-01T00:00:00Z", created_by: { pid: 1, instance: "w", version: "0" }, attempts: 0, ...over });

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
	assert.equal(parseRequestLine(newer), undefined);
	assert.equal(parseRequestLine(unknownKind), undefined);
	assert.equal(parseRequestLine("nope"), undefined);
	assert.equal(parseRequestLine(JSON.stringify(row("5")))?.id, "5");
});

test("a session id that could leave the directory is refused", () => {
	const store = new RequestStore(tmp());
	assert.throws(() => store.append(row("1", { session_id: "../x" })), /invalid session id/);
});

test("a row appended after a write cut short is not lost to the torn line", () => {
	const store = new RequestStore(tmp());
	store.append(row("1"));
	fs.appendFileSync(store.file("s"), '{"torn":');
	store.append(row("2"));
	assert.deepEqual(store.list("s").map((r) => r.id), ["1", "2"]);
});

test("a row whose fields are not the shape the engine reads is skipped, not thrown on", () => {
	assert.equal(parseRequestLine(JSON.stringify({ ...row("1"), source: 7 })), undefined);
	assert.equal(parseRequestLine(JSON.stringify({ ...row("1"), mode: null })), undefined);
	assert.equal(parseRequestLine(JSON.stringify({ ...row("1"), payload: { text: 3, cwd: "/" } })), undefined);
	assert.equal(parseRequestLine(JSON.stringify({ ...row("1"), payload: "text" })), undefined);
	// The engine reads the producer of every local row: one without it would throw in each drain.
	const { created_by: _, ...noProducer } = row("1");
	assert.equal(parseRequestLine(JSON.stringify(noProducer)), undefined);
	assert.equal(parseRequestLine(JSON.stringify({ ...row("1"), created_by: { pid: "1", instance: "w", version: "0" } })), undefined);
	assert.equal(parseRequestLine(JSON.stringify({ ...row("1"), created_by: { pid: 1, instance: "w", version: "0", left: 0 } })), undefined);
	assert.equal(parseRequestLine(JSON.stringify(row("1")))?.id, "1");
});

test("a row naming another session, or with a requires or target of the wrong shape, is skipped", () => {
	const store = new RequestStore(tmp());
	store.append(row("1"));
	fs.appendFileSync(store.file("s"), `${JSON.stringify(row("2", { session_id: "other" }))}\n`);
	assert.deepEqual(store.list("s").map((r) => r.id), ["1"], "a planted row for another conversation is not this file's");
	assert.equal(parseRequestLine(JSON.stringify(row("3", { payload: { text: "[Trigger 3] x", cwd: "/", requires: "srv" as any } }))), undefined);
	assert.equal(parseRequestLine(JSON.stringify(row("4", { kind: "stop", target: "x" as any }))), undefined);
	assert.equal(parseRequestLine(JSON.stringify(row("5", { kind: "stop", target: { current: true } as any }))), undefined);
	assert.equal(parseRequestLine(JSON.stringify(row("6", { kind: "stop", target: { id: "1" } })))?.id, "6");
});
