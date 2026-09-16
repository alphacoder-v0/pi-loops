import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import * as fs from "node:fs";
import { Inbox } from "../src/inbox.ts";

test("listNew puts checkpoints first and keeps file order inside each group; list() is the file order", async () => {
	const inbox = new Inbox(tmp("pi-loops-inbox-"));
	const base = { source: "cron:demo", runId: "r", jobId: "j", cwd: "/p" };
	await inbox.append({ ...base, text: "PR #20: merged" });
	await inbox.append({ ...base, text: "#14 brief posted · waits: your label · if not: stays needs-triage", kind: "checkpoint" });
	await inbox.append({ ...base, text: "CI red on main" });
	await inbox.append({ ...base, text: "promote research/007 · waits: your merge · if not: the branch stays", kind: "checkpoint" });
	assert.deepEqual(inbox.listNew().map((e) => e.text.slice(0, 8)), ["#14 brie", "promote ", "PR #20: ", "CI red o"]);
	assert.deepEqual(inbox.list().map((e) => e.text.slice(0, 8)), ["PR #20: ", "#14 brie", "CI red o", "promote "]);
	assert.deepEqual(inbox.listNew().map((e) => e.kind), ["checkpoint", "checkpoint", undefined, undefined]);
	assert.equal(inbox.newCount(), 4);
	assert.equal(inbox.decisionCount(), 2);
	// Claimed and dismissed entries leave the triage order but keep their kind in the history.
	await inbox.setStatus(inbox.listNew()[0].id, "claimed", "s1");
	assert.equal(inbox.decisionCount(), 1);
	assert.equal(inbox.list().find((e) => e.status === "claimed")?.kind, "checkpoint");
});

test("an entry written before kind existed reads as news, and a kind that is not the word is ignored", () => {
	const dir = tmp("pi-loops-inbox-");
	const inbox = new Inbox(dir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		inbox.file,
		[
			JSON.stringify({ id: "inb-1", created_at: "2026-09-15T00:00:00.000+00:00", source: "cron:old", text: "old finding · waits: you", trace_id: "r", status: "new", job_id: "j", cwd: "/p" }),
			JSON.stringify({ id: "inb-2", created_at: "2026-09-15T00:00:01.000+00:00", source: "cron:odd", text: "odd", trace_id: "r", status: "new", job_id: "j", cwd: "/p", kind: "urgent" }),
		].join("\n") + "\n",
	);
	assert.deepEqual(inbox.listNew().map((e) => e.kind), [undefined, undefined], "the kind is what the run wrote at append time, never re-read from the text");
	assert.equal(inbox.decisionCount(), 0);
});
