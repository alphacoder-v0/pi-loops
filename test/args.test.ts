import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddArgs, splitCommand, tokenize } from "../src/args.ts";

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
	assert.deepEqual(parseAddArgs("@hourly do it").schedule, { kind: "cron", expr: "0 * * * *" });
	assert.deepEqual(parseAddArgs("--tools read,grep every 1h x").tools, ["read", "grep"]);
});

test("parseAddArgs errors", () => {
	assert.throws(() => parseAddArgs(""), /missing schedule/);
	assert.throws(() => parseAddArgs("every 30m"), /missing prompt/);
	assert.throws(() => parseAddArgs("0 9 * * *"), /incomplete schedule|missing prompt/);
	assert.throws(() => parseAddArgs("--bogus every 1m x"), /unknown flag/);
	assert.throws(() => parseAddArgs("--name"), /needs a value/);
});

test("splitCommand", () => {
	assert.deepEqual(splitCommand("  Add  every 1m hi "), { sub: "add", rest: "every 1m hi" });
	assert.deepEqual(splitCommand(""), { sub: "", rest: "" });
});

test("parseAddArgs: single-token pie aliases and 'every hour'", () => {
	assert.deepEqual(parseAddArgs("daily summarize the repo").schedule, { kind: "cron", expr: "0 9 * * *" });
	assert.equal(parseAddArgs("daily summarize the repo").prompt, "summarize the repo");
	assert.deepEqual(parseAddArgs("every hour check CI").schedule, { kind: "cron", expr: "0 * * * *" });
	assert.equal(parseAddArgs("every hour check CI").prompt, "check CI");
	assert.deepEqual(parseAddArgs("每天 看一下 issues").schedule, { kind: "cron", expr: "0 9 * * *" });
});


test("catch-up flags: default undefined (job kind decides), --catchup / --no-catchup explicit", () => {
	assert.equal(parseAddArgs("every 1m x").catchUp, undefined);
	assert.equal(parseAddArgs("--catchup every 1m x").catchUp, true);
	assert.equal(parseAddArgs("--no-catchup every 1m x").catchUp, false);
});
