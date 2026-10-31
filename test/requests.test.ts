import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmp } from "./tmp.ts";
import { RequestStore, parseRequestLine, type SessionRequest } from "../src/requests.ts";

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
