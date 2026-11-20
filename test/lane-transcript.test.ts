/**
 * src/session-head.ts `laneTranscript`: which file of a lane's own directory is the transcript of a
 * session id. Only a regular file, matched by the id in its header. A FIFO, a symlink, a directory,
 * a file whose header names another id, and an id two files name are no transcript. A FIFO must not
 * block the process: a test that opened one for reading would never end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { laneTranscript, laneTranscripts } from "../src/session-head.ts";
import { tmp } from "./tmp.ts";

const OWN = "0199aaaa-0000-7000-8000-0000000000a1";
const CONV = "0199bbbb-0000-7000-8000-0000000000b1";
const OTHER_LANE = "0199cccc-0000-7000-8000-0000000000c1";

function transcript(file: string, id: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd: "/proj" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`);
	return file;
}

test("[lane-transcript] a FIFO, a symlink to another lane's or a conversation's file, a directory and a file whose header names another id are no transcript of the lane; its own file is", { timeout: 10_000 }, () => {
	const root = tmp("pi-loops-lane-transcript-");
	const lane = path.join(root, "sessions", "cron-a1");
	const own = transcript(path.join(lane, "2026-11-20_own.jsonl"), OWN);
	const conversation = transcript(path.join(root, "conversations", `${CONV}.jsonl`), CONV);
	const otherLane = transcript(path.join(root, "sessions", "cron-b2", "t.jsonl"), OTHER_LANE);
	fs.symlinkSync(conversation, path.join(lane, `${CONV}.jsonl`));
	fs.symlinkSync(otherLane, path.join(lane, "other-lane.jsonl"));
	execFileSync("mkfifo", [path.join(lane, `${OTHER_LANE}-fifo.jsonl`)]);
	fs.mkdirSync(path.join(lane, `${CONV}-dir.jsonl`));
	transcript(path.join(lane, `${CONV}-dir.jsonl`, "inside.jsonl"), CONV);
	// Named for the conversation, and its header says another id: the header decides.
	transcript(path.join(lane, `named-${CONV}.jsonl`), "0199dddd-0000-7000-8000-0000000000d1");

	assert.equal(laneTranscript(lane, OWN), own, "the lane's own regular file, by its header");
	assert.equal(laneTranscript(lane, CONV), undefined, "a symlink to a conversation's file, a directory and a file named for it are not it");
	assert.equal(laneTranscript(lane, OTHER_LANE), undefined, "a symlink to another lane's file is not it");
	assert.deepEqual([...laneTranscripts(lane).keys()].sort(), [OWN, "0199dddd-0000-7000-8000-0000000000d1"].sort(), "only the regular files' headers are read; the FIFO is never opened");
	assert.equal(laneTranscript(path.join(root, "sessions", "gone"), OWN), undefined, "no directory, no transcript");
});

test("[lane-transcript] two files whose headers name one id: neither is the transcript", () => {
	const lane = path.join(tmp("pi-loops-lane-twice-"), "sessions", "cron-a1");
	transcript(path.join(lane, "a.jsonl"), OWN);
	transcript(path.join(lane, "b.jsonl"), OWN);
	assert.equal(laneTranscript(lane, OWN), undefined);
	assert.equal(laneTranscripts(lane).has(OWN), true, "the id is seen, and proves no file");
});
