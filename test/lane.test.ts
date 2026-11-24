import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { checkLane, laneFileName, loopLane, parseLane } from "../src/lane.ts";
import { sessionFileName } from "../src/lease.ts";
import { triggerSessionKey } from "../src/check-run.ts";

const conversations = ["s1", "01a1dce4-8ad1-77c0-89b0-475ccfeaf683", "A", "a.b_c-d", "a".repeat(128)];
const loops = ["@cron-0123456789abcdef0123456789abcdef", "@cron-a", `@cron-${"a".repeat(123)}`];
const checks = ["@check-piz-1a2b3c4d", "@check-a"];
/** Ids that are no lane: each could leave `requests/`, or names a kind this version does not have. */
const refused = [
	"", " ", " s1", "s1 ", ".", "..", ".hidden", "-x", "_x", "a/b", "a\\b", "a..b", "a\0b", "a\nb", "é", "a".repeat(129),
	"@", "@@cron-a", "@cron", "@cron-", "@check", "@check-", "@wake-a", "@x", "@cron-a/b", "@cron-a\\b", "@cron-..", "@cron-a..b", "@cron-a\0", "@cron-a b",
	`@cron-${"a".repeat(124)}`, "@../x", "@/etc/passwd", "s1@cron-a", "cron-@a",
];

test("[lane-file-name] a lane's kind is read from its id: a session id, @cron- for a loop, @check- for a project's checks", () => {
	for (const id of conversations) assert.deepEqual(parseLane(id), { kind: "conversation", id }, id);
	for (const id of loops) assert.deepEqual(parseLane(id), { kind: "loop", id }, id);
	for (const id of checks) assert.deepEqual(parseLane(id), { kind: "check", id }, id);
});

test("[lane-file-name] an id that is no lane parses to nothing and never throws", () => {
	for (const id of refused) assert.equal(parseLane(id), undefined, JSON.stringify(id));
	for (const notAString of [undefined, null, 5, {}, ["s1"]]) assert.equal(parseLane(notAString as unknown as string), undefined);
});

test("[lane-file-name] a lane's file name is its id, and an id that is no lane has none", () => {
	for (const id of [...conversations, ...loops, ...checks]) assert.equal(laneFileName(id), id);
	for (const id of refused) assert.throws(() => laneFileName(id), (err: Error) => err.message === `invalid lane id: ${id}`, JSON.stringify(id));
});

test("[lane-file-name] no lane names a path outside its directory", () => {
	const dir = path.resolve("/loops/requests");
	for (const id of [...conversations, ...loops, ...checks]) {
		for (const suffix of [".jsonl", ".lock", `.${"0".repeat(32)}.images.json`]) {
			const file = path.resolve(dir, `${laneFileName(id)}${suffix}`);
			assert.equal(path.dirname(file), dir, id);
			assert.equal(path.basename(file), `${id}${suffix}`, id);
		}
	}
});

test("a session id is a conversation's lane and nothing else: an @ lane is refused where a session id is asked, with the message it had", () => {
	for (const id of conversations) assert.equal(sessionFileName(id), id);
	for (const id of [...loops, ...checks, ...refused]) assert.throws(() => sessionFileName(id), (err: Error) => err.message === `invalid session id: ${id}`, JSON.stringify(id));
});

test("a loop's lane is @ and its job's id, and a job whose id makes no lane has none", () => {
	assert.equal(loopLane("cron-0123456789abcdef0123456789abcdef"), "@cron-0123456789abcdef0123456789abcdef");
	assert.deepEqual(parseLane(loopLane("cron-ab12")!), { kind: "loop", id: "@cron-ab12" });
	for (const jobId of ["loop-ab12", "", "cron-", "cron-a/b", "cron-..", `cron-${"a".repeat(124)}`]) assert.equal(loopLane(jobId), undefined, JSON.stringify(jobId));
});

test("[check-lane-symlink] a project reached through a symlink has one check lane, named for the real directory", () => {
	const root = fs.realpathSync(tmp("pi-loops-lane-link-"));
	const real = path.join(root, "proj");
	const link = path.join(root, "link");
	fs.mkdirSync(real);
	fs.symlinkSync(real, link);
	assert.equal(checkLane(link), checkLane(real));
	assert.match(checkLane(link)!, /^@check-proj-[0-9a-f]{8}$/);
});

test("a project's check lane is @check-, its directory's name and a digest of its path; two projects named alike have two lanes, and no project has none", () => {
	const a = fs.realpathSync(tmp("pi-loops-lane-"));
	const one = path.join(a, "one", "web");
	const two = path.join(a, "two", "web");
	fs.mkdirSync(one, { recursive: true });
	fs.mkdirSync(two, { recursive: true });
	assert.match(checkLane(one)!, /^@check-web-[0-9a-f]{8}$/);
	assert.notEqual(checkLane(one), checkLane(two));
	assert.equal(checkLane(one), checkLane(one), "stable for a project");
	assert.equal(checkLane(one), `@check-${triggerSessionKey(one).slice("triggers-".length)}`, "the key of the project's check transcripts, without its prefix");
	assert.equal(checkLane(""), undefined, "a rule with no project has no check lane");
	// Whatever the directory is called, the lane is one the grammar takes.
	for (const name of ["a b", "..", "a..b", "é", ".hidden", "x".repeat(250), "@cron-x"]) {
		const lane = checkLane(path.join(a, name));
		assert.equal(parseLane(lane!)?.kind, "check", `${name} -> ${lane}`);
	}
});
