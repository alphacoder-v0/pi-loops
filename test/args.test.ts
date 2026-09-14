import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CRON_ADD_USAGE, parseAddArgs, parseSetArgs, splitCommand, tokenize } from "../src/args.ts";

test("tokenize handles quotes and offsets", () => {
	const t = tokenize(`--name x "0 9 * * *" say "hi there"`);
	assert.deepEqual(t.map((x) => x.value), ["--name", "x", "0 9 * * *", "say", "hi there"]);
	assert.equal(t[2].quoted, true);
});

test("parseAddArgs: quoted cron + flags, prompt kept verbatim", () => {
	const a = parseAddArgs(`--name issues --no-catchup --timeout 20m "0 9 * * 1-5" check issues, quote "this" please`);
	assert.equal(a.name, "issues");
	assert.equal(a.catchUp, false);
	assert.equal(a.timeoutMs, 20 * 60_000);
	assert.deepEqual(a.schedule, { kind: "cron", expr: "0 9 * * 1-5" });
	assert.equal(a.prompt, `check issues, quote "this" please`);
	assert.equal(a.stateful, false);
});

test("parseAddArgs: bare cron tokens, every, in, @alias, --stateful", () => {
	assert.equal(parseAddArgs("*/30 * * * * summarize repo").prompt, "summarize repo");
	assert.deepEqual(parseAddArgs("every 30m ping").schedule, { kind: "every", ms: 1_800_000 });
	assert.equal(parseAddArgs("--inject in 10m remind me to check the tests").stateful, false);
	assert.equal(parseAddArgs("--stateful \"0 9 * * *\" watch").stateful, true);
	// The aliases the usage block now lists: `--loop` is `--stateful`, `--catchup` the counterpart of
	// `--no-catchup`, and both were parsed but written down nowhere.
	assert.equal(parseAddArgs("--loop \"0 9 * * *\" watch").stateful, true);
	assert.equal(parseAddArgs("--catchup every 1h x").catchUp, true);
	assert.deepEqual(parseAddArgs("@hourly do it").schedule, { kind: "cron", expr: "0 * * * *" });
	assert.deepEqual(parseAddArgs("--tools read,grep every 1h x").tools, ["read", "grep"]);
});

test("parseAddArgs errors", () => {
	assert.throws(() => parseAddArgs(""), /missing schedule; usage: \/cron add \[--stateful\]/);
	assert.throws(() => parseAddArgs("every 30m"), /missing prompt/);
	assert.throws(() => parseAddArgs("0 9 * * *"), /incomplete schedule|missing prompt/);
	assert.throws(() => parseAddArgs("--bogus every 1m x"), /unknown flag/);
	assert.throws(() => parseAddArgs("--name"), /needs a value/);
});

/**
 * Every flag `/cron add` accepts, split the way `CRON_ADD_USAGE` splits them: the ones the usage
 * line names, and the ones it deliberately leaves to the flag block at the top of `src/args.ts` and
 * to `/cron help`. A flag on neither list fails the test below, which is the point — adding one is a
 * decision about what the person who just mistyped the command is told, not only a case in the parser.
 */
const ON_THE_USAGE_LINE = ["--stateful", "--verify"];
const LEFT_TO_CRON_HELP = ["--loop", "--inject", "--catchup", "--no-catchup", "--name", "--cwd", "--model", "--thinking", "--tools", "--timeout", "--checker-model"];

test("every flag /cron add accepts is either on the usage line or left to /cron help on purpose", () => {
	// Read the accepted flags out of the parser rather than keeping a third list by hand: the usage
	// line said `--stateful` was the only one for as long as the two could drift silently.
	const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "args.ts"), "utf8");
	const parser = source.slice(source.indexOf("export function parseAddArgs"), source.indexOf("export function splitCommand"));
	const accepted = [...new Set([...parser.matchAll(/"(--[a-z][a-z-]*)"/g)].map((m) => m[1]))].sort();
	assert.deepEqual(accepted, [...ON_THE_USAGE_LINE, ...LEFT_TO_CRON_HELP].sort(), "a flag /cron add accepts belongs on one of the two lists above");
	// And each of them really parses, so a stale list cannot pass by naming a flag nothing accepts.
	const value: Record<string, string> = { "--name": "n", "--cwd": "/tmp", "--model": "openai/gpt-5", "--thinking": "high", "--tools": "read", "--timeout": "20m", "--checker-model": "openai/gpt-5" };
	for (const flag of accepted) assert.doesNotThrow(() => parseAddArgs(`${flag} ${value[flag] ?? ""} every 1h x`), `${flag} should parse`);

	const named = [...new Set([...CRON_ADD_USAGE.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))].sort();
	assert.deepEqual(named, [...ON_THE_USAGE_LINE].sort(), "the usage line names those two flags and no others");
	assert.match(CRON_ADD_USAGE, /\/cron help/, "and points at where the rest are written down");
	// It is printed inside a notification (`cron: missing schedule; …`), so pasting every flag there is here
	// would wrap in any terminal and be read by nobody.
	assert.ok(!CRON_ADD_USAGE.includes("\n") && CRON_ADD_USAGE.length <= 110, "one line, short enough to survive the prefix the error adds");
});

test("splitCommand", () => {
	assert.deepEqual(splitCommand("  Add  every 1m hi "), { sub: "add", rest: "every 1m hi" });
	assert.deepEqual(splitCommand(""), { sub: "", rest: "" });
});

test("parseAddArgs: single-token aliases and 'every hour'", () => {
	assert.deepEqual(parseAddArgs("daily summarize the repo").schedule, { kind: "cron", expr: "0 9 * * *" });
	assert.equal(parseAddArgs("daily summarize the repo").prompt, "summarize the repo");
	assert.deepEqual(parseAddArgs("every hour check CI").schedule, { kind: "cron", expr: "0 * * * *" });
	assert.equal(parseAddArgs("every hour check CI").prompt, "check CI");
	assert.deepEqual(parseAddArgs("每天 看一下 issues").schedule, { kind: "cron", expr: "0 9 * * *" });
});


test("a thinking level is a level pi knows, wherever it is typed", () => {
	// `--thinking hgih` was stored as typed and cast into `createAgentSession` at run time, so the
	// typo surfaced hours later as a failed run instead of at the command that made it.
	assert.equal(parseAddArgs("--thinking high every 1m x").thinking, "high");
	assert.throws(() => parseAddArgs("--thinking hgih every 1m x"), /unknown thinking level "hgih"; pick one of off, minimal, low/);
	assert.throws(() => parseAddArgs("--thinking HIGH every 1m x"), /unknown thinking level/);
	// `/cron set` and `/triggers set` share this parser, so both refuse it.
	assert.throws(() => parseSetArgs("issues --thinking hgih"), /unknown thinking level "hgih"/);
	assert.equal(parseSetArgs("issues --thinking minimal").thinking, "minimal");
	assert.equal(parseSetArgs("issues --thinking -").thinking, null, "clearing the pin is not a level");
});

test("catch-up flags: default undefined (job kind decides), --catchup / --no-catchup explicit", () => {
	assert.equal(parseAddArgs("every 1m x").catchUp, undefined);
	assert.equal(parseAddArgs("--catchup every 1m x").catchUp, true);
	assert.equal(parseAddArgs("--no-catchup every 1m x").catchUp, false);
});

test("parseSetArgs: /cron set and /triggers set flags; `-` clears a pinned value", () => {
	const s = parseSetArgs(`issues --model openai/gpt-5.5 --thinking high --timeout 20m --name nightly`);
	assert.equal(s.ref, "issues");
	assert.equal(s.model, "openai/gpt-5.5");
	assert.equal(s.thinking, "high");
	assert.equal(s.timeoutMs, 20 * 60_000);
	assert.equal(s.name, "nightly");
	const c = parseSetArgs(`3 --model - --thinking current --timeout -`);
	assert.equal(c.ref, "3");
	assert.equal(c.model, null, "`-` means: use the running session's model");
	assert.equal(c.thinking, null);
	assert.equal(c.timeoutMs, null);
	assert.throws(() => parseSetArgs(`--model x`), /usage: .* set <id>/);
	assert.throws(() => parseSetArgs(`x --bogus 1`), /unknown flag --bogus/);
	assert.throws(() => parseSetArgs(`x`), /nothing to change/);
});

test("/cron set --prompt / --schedule: reword a loop or move it without minting a new job id", () => {
	const p = parseSetArgs(`3 --prompt "check the CI and report only what changed"`, { job: true });
	assert.equal(p.ref, "3");
	assert.equal(p.prompt, "check the CI and report only what changed");
	// A prompt is free text: quotes inside it survive, and other flags still parse around it.
	const q = parseSetArgs(`3 --prompt "say \\"hi\\" politely" --name nightly`, { job: true });
	assert.equal(q.prompt, `say "hi" politely`);
	assert.equal(q.name, "nightly");
	// The schedule is parsed here, so a typo never reaches the store.
	assert.deepEqual(parseSetArgs(`issues --schedule "0 9 * * 1-5"`, { job: true }).schedule, { kind: "cron", expr: "0 9 * * 1-5" });
	assert.deepEqual(parseSetArgs("issues --schedule @daily", { job: true }).schedule, { kind: "cron", expr: "0 0 * * *" });
	assert.deepEqual(parseSetArgs("issues --schedule daily", { job: true }).schedule, { kind: "cron", expr: "0 9 * * *" });
	assert.deepEqual(parseSetArgs(`issues --schedule "every 30m"`, { job: true }).schedule, { kind: "every", ms: 1_800_000 });
	assert.throws(() => parseSetArgs(`issues --schedule "0 9 * * funday"`, { job: true }), /invalid cron field/);
	// A one-shot would be fired and then removed, taking the notes this edit exists to keep.
	assert.throws(() => parseSetArgs(`issues --schedule "in 10m"`, { job: true }), /recurring schedule/);
	assert.throws(() => parseSetArgs(`issues --schedule "at 2026-09-08T18:00"`, { job: true }), /recurring schedule/);
	// A rule has neither, so /triggers set (which passes no options) must not accept them.
	assert.throws(() => parseSetArgs(`issues --prompt "x"`), /unknown flag --prompt/);
	assert.throws(() => parseSetArgs("issues --schedule @daily"), /unknown flag --schedule/);
});

test("/cron set: `-` never silently erases a prompt or a schedule", () => {
	assert.throws(() => parseSetArgs("issues --prompt -", { job: true }), /cannot be cleared/);
	assert.throws(() => parseSetArgs("issues --prompt current", { job: true }), /cannot be cleared/);
	assert.throws(() => parseSetArgs("issues --schedule -", { job: true }), /cannot be cleared/);
	// Quoted, it is the text the user meant.
	assert.equal(parseSetArgs(`issues --prompt "-"`, { job: true }).prompt, "-");
	assert.throws(() => parseSetArgs(`issues --prompt ""`, { job: true }), /cannot be empty/);
	// An unquoted multi-word prompt looks like a second job ref; say what to do about it.
	assert.throws(() => parseSetArgs("issues --prompt check the CI", { job: true }), /quote/);
});

test("a job's name has to be usable as a reference, on the edit path as much as on the create path", async () => {
	const { checkJobName } = await import("../src/tools.ts");
	const jobs = [{ id: "cron-a", name: "ci" }, { id: "cron-b", name: "nightly" }] as any;
	// A name is how a job is referred to, so a duplicate makes every later `/cron run ci` ambiguous.
	assert.throws(() => checkJobName("ci", jobs), /already exists/);
	assert.throws(() => checkJobName("my job", jobs), /1-40 chars/);
	assert.throws(() => checkJobName("a".repeat(41), jobs), /1-40 chars/);
	// Renaming a job to what it is already called is not a collision: the caller excludes it.
	assert.doesNotThrow(() => checkJobName("ci", jobs.filter((j: any) => j.id !== "cron-a")));
	assert.doesNotThrow(() => checkJobName("build.2_x-y", jobs));
	assert.doesNotThrow(() => checkJobName(undefined, jobs));
});
