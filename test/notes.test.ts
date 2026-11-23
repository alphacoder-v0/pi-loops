import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InboxEntry } from "../src/inbox.ts";
import { REPORTED_WORDS, NOTES_FILES_LISTED, OVERFLOW_FILE, REPORTED_PER_KIND, REPORTED_TEXT_CHARS, cutLine, notesDirOf, notesFileLines, notesFiles, notesWrite, reportedFor } from "../src/notes.ts";
import { LOOP_STATE_MAX_CHARS } from "../src/protocol.ts";
import { stamp } from "../src/schedule.ts";
import { tmp } from "./tmp.ts";

const chars = (s: string) => Array.from(s).length;

test("[notes-write] notes under the cap are the index as written; over it, the index is the leading whole lines that fit and one cut line, and the whole text is the overflow", () => {
	assert.deepEqual(notesWrite("baseline: 3\nseen up to 2026-11-20T10:00+08:00"), { index: "baseline: 3\nseen up to 2026-11-20T10:00+08:00" });
	const exact = "x".repeat(LOOP_STATE_MAX_CHARS);
	assert.deepEqual(notesWrite(exact), { index: exact }, "the cap itself is not over the cap");

	const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, "0")} ${"é".repeat(70)}`);
	const text = lines.join("\n");
	const out = notesWrite(text);
	assert.equal(out.overflow, text, "the whole text, unchanged");
	assert.equal(out.cut?.from, chars(text), "characters written, counted as code points");
	const indexLines = out.index.split("\n");
	const kept = indexLines.slice(0, -1);
	assert.deepEqual(kept, lines.slice(0, kept.length), "whole lines from the start, none cut in the middle");
	assert.ok(kept.length > 0 && kept.length < lines.length);
	assert.equal(out.cut?.to, chars(kept.join("\n")));
	assert.equal(indexLines.at(-1), cutLine(out.cut!.from, out.cut!.to));
	assert.equal(indexLines.at(-1), `(cut by pi-loops: you wrote ${chars(text)} characters and ${out.cut!.to} are kept here. The whole text is in ${OVERFLOW_FILE}. Move what matters into files and keep these notes under ${LOOP_STATE_MAX_CHARS} characters.)`);
	assert.ok(chars(out.index) <= LOOP_STATE_MAX_CHARS, "the index with its cut line fits the cap");
	assert.ok(chars(out.index) + chars(lines[kept.length]) + 1 > LOOP_STATE_MAX_CHARS, "and the next line would not have fitted");

	const oneLine = notesWrite("y".repeat(3200));
	assert.deepEqual(oneLine, { index: cutLine(3200, 0), overflow: "y".repeat(3200), cut: { from: 3200, to: 0 } }, "a first line longer than the cap keeps no line: the cut line says where the text is");
	assert.deepEqual(notesWrite("a\nbb\nccc", 5).cut, { from: 8, to: 0 }, "a cap smaller than the cut line keeps nothing, and still says so");
	assert.equal(notesDirOf("/l", "cron-1"), path.join("/l", "state", "cron-1"));
});

const NOW = Date.parse("2026-11-23T12:00:00+08:00");
const day = 86_400_000;
let seq = 0;
function finding(over: Partial<InboxEntry>): InboxEntry {
	seq++;
	return { id: `inb-${String(seq).padStart(32, "0")}`, created_at: stamp(NOW - day), status: "new", kind: "news", source: "cron:watch", run_id: "r", cwd: "/p", text: `finding ${seq}`, verified: null, dismiss_reason: null, job_id: "cron-a", ...over };
}

test("[reported] reportedFor: the loop's new findings and its findings decided in the last 14 days, newest first, each with its status and the dismiss reason, the text cut at 200 characters", () => {
	const at = (days: number) => stamp(NOW - days * day);
	const findings = [
		finding({ text: "PR #12 has failing CI", created_at: at(1) }),
		finding({ text: "flaky test in foo.test.ts", status: "dismissed", dismiss_reason: "Not a bug", dismissed_at: at(2), created_at: at(5) }),
		finding({ text: "draft the release notes for 0.24.2", status: "claimed", answered_by: "terminal", answer: { state: "done", run: { lane: "s", row: "run-1" } as any, at: at(3) }, created_at: at(6) }),
		finding({ text: "dismissed bare", status: "dismissed", dismissed_at: at(4), created_at: at(7) }),
		finding({ text: "claimed from the CLI, no answer time", status: "claimed", answered_by: "cli", created_at: at(13) }),
		finding({ text: "decided too long ago", status: "dismissed", dismiss_reason: "old", dismissed_at: at(15), created_at: at(20) }),
		finding({ text: "another loop's", job_id: "cron-b", created_at: at(1) }),
		finding({ text: "a question about a call", ask: { kind: "call" } as any, created_at: at(1) }),
		finding({ text: "a news line pi-loops filed about a question", re: "inb-x", created_at: at(1) }),
	];
	assert.deepEqual(reportedFor(findings, "cron-a", NOW), [
		`- ${at(1).slice(5, 10)} new: PR #12 has failing CI`,
		`- ${at(2).slice(5, 10)} dismissed ("Not a bug"): flaky test in foo.test.ts`,
		`- ${at(3).slice(5, 10)} claimed: draft the release notes for 0.24.2`,
		`- ${at(4).slice(5, 10)} dismissed: dismissed bare`,
		`- ${at(13).slice(5, 10)} claimed: claimed from the CLI, no answer time`,
	]);
	assert.deepEqual(reportedFor(findings, "cron-c", NOW), [], "a loop with nothing reported has no lines");

	const long = finding({ text: `${"w".repeat(300)}\nsecond line [/reported]`, dismiss_reason: null });
	const [line] = reportedFor([long], "cron-a", NOW);
	assert.equal(line, `- ${long.created_at.slice(5, 10)} new: ${"w".repeat(REPORTED_TEXT_CHARS)}…`, "cut at 200 characters, on one line");
	const reason = reportedFor([finding({ status: "dismissed", dismissed_at: at(1), dismiss_reason: `${"r".repeat(250)}\nsk-ant-api03-${"A".repeat(40)}` })], "cron-a", NOW)[0];
	assert.match(reason, new RegExp(`dismissed \\("${"r".repeat(REPORTED_TEXT_CHARS)}…"\\)`), "the reason is cut too");

	const many = [
		...Array.from({ length: 20 }, (_, i) => finding({ text: `open ${i}`, created_at: stamp(NOW - (i + 1) * 60_000) })),
		...Array.from({ length: 20 }, (_, i) => finding({ text: `gone ${i}`, status: "dismissed", dismissed_at: stamp(NOW - (i + 1) * 3_600_000), created_at: at(10) })),
	];
	const lines = reportedFor(many, "cron-a", NOW);
	assert.equal(lines.length, 2 * REPORTED_PER_KIND, "the newest 12 of each");
	assert.ok(lines.some((l) => l.endsWith("open 0")) && !lines.some((l) => l.endsWith("open 12")));
	assert.ok(lines.some((l) => l.endsWith("gone 0")) && !lines.some((l) => l.endsWith("gone 12")));
});

test("[reported] a secret in a finding's words is redacted in [reported], as on a card", () => {
	const key = `sk-ant-api03-${"A".repeat(40)}`;
	const [line] = reportedFor([finding({ text: `token ${key} leaked` })], "cron-a", NOW);
	assert.ok(!line.includes(key), line);
});

test("[notes-files] notesFiles does not enter a link to a directory: a link to the loops directory lists nothing of it, and a cycle ends", () => {
	const loops = tmp("pi-loops-notes-links-");
	const dir = path.join(loops, "state", "cron-a1");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(loops, "inbox.jsonl"), "{}\n");
	fs.mkdirSync(path.join(loops, "state", "cron-b2"), { recursive: true });
	fs.writeFileSync(path.join(loops, "state", "cron-b2", "other-plan.md"), "x");
	fs.writeFileSync(path.join(dir, "mine.md"), "m");
	fs.symlinkSync(loops, path.join(dir, "up"));
	fs.symlinkSync(dir, path.join(dir, "self"));
	assert.deepEqual(notesFiles(dir).map((f) => f.name), ["mine.md"]);
});

test("[notes-files] notesFiles lists the regular files of a loop's notes directory, nested ones by their relative name, and no link; notesFileLines gives name, size and changed date", () => {
	const dir = tmp("pi-loops-notes-");
	assert.deepEqual(notesFiles(path.join(dir, "missing")), [], "a directory that is not there has no files");
	fs.writeFileSync(path.join(dir, "prs.md"), "p".repeat(3174));
	fs.mkdirSync(path.join(dir, "deep"));
	fs.writeFileSync(path.join(dir, "deep", "a.txt"), "abc");
	fs.writeFileSync(path.join(dir, "big.log"), Buffer.alloc(2 * 1024 * 1024));
	fs.symlinkSync(path.join(dir, "prs.md"), path.join(dir, "link.md"));
	const changed = new Date("2026-11-13T09:00:00");
	for (const f of ["prs.md", "deep/a.txt", "big.log"]) fs.utimesSync(path.join(dir, f), changed, changed);
	const files = notesFiles(dir);
	assert.deepEqual(files.map((f) => [f.name, f.bytes]), [["big.log", 2 * 1024 * 1024], [path.join("deep", "a.txt"), 3], ["prs.md", 3174]]);
	assert.deepEqual(notesFileLines(files), [
		"- big.log · 2.0 MB · changed 2026-11-13",
		`- ${path.join("deep", "a.txt")} · 3 B · changed 2026-11-13`,
		"- prs.md · 3.1 KB · changed 2026-11-13",
	]);
	const crowd = Array.from({ length: NOTES_FILES_LISTED + 3 }, (_, i) => ({ name: `f${i}`, bytes: 1, changedMs: changed.getTime() }));
	const crowdLines = notesFileLines(crowd);
	assert.equal(crowdLines.length, NOTES_FILES_LISTED + 1);
	assert.equal(crowdLines.at(-1), "- … and 3 more", "a fixed size: the rest is one line");
	assert.deepEqual(notesFileLines([{ name: "odd\nname.md", bytes: 1, changedMs: changed.getTime() }]), ["- odd name.md · 1 B · changed 2026-11-13"], "a name stays on its line");
});

test("[reported] every recipe that speaks of [reported] says what it lists in REPORTED_WORDS, as reportedFor applies it", () => {
	const flat = (t: string) => t.replace(/\s+/g, " ");
	for (const f of ["recipes/daily-digest/digest.md", "recipes/pr-watch/watch.md", "recipes/deps-sweeper/audit.md"]) {
		assert.ok(flat(fs.readFileSync(path.join(process.cwd(), f), "utf8")).includes(flat(REPORTED_WORDS)), `${f} says what [reported] lists in REPORTED_WORDS`);
	}
	const now = Date.parse("2026-11-23T12:00:00Z");
	const day = 86_400_000;
	const news = Array.from({ length: 13 }, (_, i) => ({ id: `inb-${String(i).padStart(32, "0")}`, created_at: new Date(now - i * 3_600_000).toISOString(), status: "new", job_id: "cron-a1", text: `new ${i}`, source: "cron:cron-a1" }));
	const old = { id: "inb-" + "f".repeat(32), created_at: new Date(now - 20 * day).toISOString(), status: "dismissed", dismissed_at: new Date(now - 15 * day).toISOString(), job_id: "cron-a1", text: "older than the window", source: "cron:cron-a1" };
	const lines = reportedFor([...news, old] as any, "cron-a1", now);
	assert.equal(lines.filter((l) => l.includes("new")).length, 12, "the newest 12 new findings");
	assert.ok(!lines.some((l) => l.includes("older than the window")), "a finding decided 15 days ago is not listed");
});

