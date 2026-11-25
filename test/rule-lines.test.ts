import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleLines, triggerStatusLines } from "../src/rule-lines.ts";
import { formatLocal } from "../src/schedule.ts";
import type { DynamicTriggerRule } from "../src/triggers.ts";
import { checkLane } from "../src/lane.ts";
import { runHistory } from "../src/job-status.ts";
import type { RunRecord } from "../src/store.ts";

const HOME = "/home/dev";
const HERE = "/home/dev/code/acme-api";
const SESSION = "01a09fef-2222-7abc-8def-0123456789ab";

const rule = (over: Partial<DynamicTriggerRule> = {}): DynamicTriggerRule =>
	({ id: "dyn-0123abcd", condition: "the file /tmp/ready exists", action: "tell me", cwd: HERE, enabled: true, fireOnce: true, promoteToChat: true, createdAt: "2026-09-15T08:00:00.000+08:00", createdBy: { sessionId: SESSION, cwd: HERE }, ...over }) as DynamicTriggerRule;

const opts = { numbered: true, sessionId: SESSION, cwd: HERE, home: HOME, sameProject: (a: string, b: string) => a === b };

test("a rule row carries marks only where the rule differs from the Watch card's first answers: here, once", () => {
	assert.deepEqual(ruleLines([rule()], opts), [" 1. dyn-0123abcd when the file /tmp/ready exists -> tell me"]);
	const fired = "2026-09-15T09:30:00.000+08:00";
	assert.deepEqual(ruleLines([rule({ enabled: false, fireOnce: false, promoteToChat: false, firedAt: fired })], opts), [` 1. dyn-0123abcd [disabled, every time, to inbox, fired ${formatLocal(Date.parse(fired))}] when the file /tmp/ready exists -> tell me`]);
	assert.deepEqual(ruleLines([rule()], { ...opts, history: new Map([[checkLane(HERE)!, { streak: 5 }]]) }), [" 1. dyn-0123abcd [failing ×5] when the file /tmp/ready exists -> tell me"]);
	assert.deepEqual(ruleLines([rule({ cwd: "/home/dev/other", createdBy: { sessionId: "01a09fef-9999-7abc", cwd: "/home/dev/other" } })], { ...opts, numbered: false }), ["  - dyn-0123abcd when the file /tmp/ready exists -> tell me  (~/other)  (session 01a09fef-9999)"], "another project's and another conversation's are named");
	assert.ok(!ruleLines([rule()], opts).join("\n").match(/fire_once|promote_to_chat|audit_only|enabled/), "no code words");
});

test("/triggers status says in plain words what checks the rules, what it last found, and where the files are", () => {
	const at = "2026-09-15T09:30:00.000+08:00";
	const input = {
		rules: [rule(), rule({ enabled: false })],
		pollIntervalSecs: 60,
		running: true,
		lastCheck: { at, cwd: HERE, outcome: "no match" },
		home: HOME,
		pushSources: 1,
		sources: { total: 3, connected: 3, attention: 0 },
		runningCount: 0,
		deduplicated: 2,
		rulesFile: `${HOME}/.pi/agent/loops/triggers.json`,
		auditFile: `${HOME}/.pi/agent/loops/triggers-audit.jsonl`,
	};
	assert.deepEqual(triggerStatusLines(input), [
		"Rules: 2, 1 disabled",
		"Checks: every 60s while a rule is on, by pi-loops in the background",
		`Last check: ${formatLocal(Date.parse(at)).slice(11)} in ~/code/acme-api — no match`,
		"MCP push sources: 1",
		"Sources: 3, 3 connected",
		"Running 0 · deduplicated 2",
		"Files: ~/.pi/agent/loops/triggers.json, ~/.pi/agent/loops/triggers-audit.jsonl (/triggers audit [N])",
	]);
	assert.deepEqual(triggerStatusLines({ ...input, rules: [rule()], running: false, lastCheck: undefined, configError: "bad toml", sources: { total: 3, connected: 1, attention: 2 }, persistenceError: "disk full" }), [
		"Rules: 1",
		"Checks: every 60s while a rule is on, by pi-loops in the background — not running",
		"Last check: none yet",
		"MCP push sources: 1 (config error: bad toml)",
		"Sources: 3, 1 connected, 2 need attention",
		"Running 0 · deduplicated 2",
		"Files: ~/.pi/agent/loops/triggers.json, ~/.pi/agent/loops/triggers-audit.jsonl (/triggers audit [N])",
		"  ! disk full",
	]);
});

test("[clean-at-sink] no /triggers rules line carries a control or format character, whichever field held it", () => {
	const nasty = "a\u001b[2J‮b​c\u009bd";
	const rules = [
		rule({ id: `dyn-${nasty}`, condition: `c ${nasty}`, action: `x ${nasty}`, gate: { kind: "command", command: `gh ${nasty}` } } as Partial<DynamicTriggerRule>),
		rule({ cwd: `/home/dev/o ${nasty}`, createdBy: { sessionId: `s ${nasty}`, cwd: "/" }, proposed: { at: "", session: SESSION } } as Partial<DynamicTriggerRule>),
	];
	const lines = [...ruleLines(rules, opts), ...ruleLines(rules, { ...opts, numbered: false })];
	const text = lines.join("\n");
	for (const word of ["c a", "x a", "o a", "s a"]) assert.ok(text.includes(word), `${word}: ${text}`);
	for (const line of lines) assert.equal(/[\p{Cc}\p{Cf}]/u.test(line), false, JSON.stringify(line));
});

test("[rule-fields-dropped] a rule whose project has three failed check records is marked [failing ×3]; one with the failure fields 0.24.2 left and no failed records is not", () => {
	const lane = checkLane(HERE)!;
	const failed = (n: number): RunRecord => ({ runId: `chk-${n}`, jobId: lane, stateful: false, cwd: HERE, pid: 1, startedAt: `2026-09-15T0${n}:00:00.000Z`, finishedAt: `2026-09-15T0${n}:01:00.000Z`, ok: false, error: "the model refused", findings: 0, droppedFindings: 0, stateUpdated: false, cause: "check" }) as RunRecord;
	const history = runHistory([failed(1), failed(2), failed(3)]);
	assert.deepEqual(ruleLines([rule()], { ...opts, history }), [" 1. dyn-0123abcd [failing ×3] when the file /tmp/ready exists -> tell me"]);
	const left = rule({ consecutiveFailures: 7, lastCheckFailedAt: "2026-09-15T01:00:00.000Z" } as Partial<DynamicTriggerRule>);
	assert.deepEqual(ruleLines([left], { ...opts, history: runHistory([]) }), [" 1. dyn-0123abcd when the file /tmp/ready exists -> tell me"], "the fields on the rule count for nothing");
});
