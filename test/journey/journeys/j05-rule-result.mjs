import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = `dyn-${"5a".repeat(16)}`;
export const id = "J5", title = "A matched rule's result is visible without promote_to_chat", expect = "head", active = true, milestone = "M4", page = "new", tui = false, needs = ["agent-browser"];
// The stand-in model answers every check with this: the rule matched, and what its action printed.
export const reply = `matched ${RULE}. hello, world; test result: ok`;
export function seed(dirs) {
	fs.writeFileSync(path.join(dirs.loops, "config.toml"), "[triggers]\npoll_interval_secs = 1\n");
	// Disabled until the journey knows the page's conversation, which made the rule.
	fs.writeFileSync(path.join(dirs.loops, "triggers.json"), JSON.stringify({ version: 1, rules: [{ id: RULE, condition: "~/build.done appears", action: "print hello, world and run the tests", cwd: dirs.project, enabled: false, fireOnce: false, promoteToChat: false, createdAt: new Date().toISOString() }] }));
}
const jsonl = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }); } catch { return []; /* not written yet */ } };

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const sessionId = /\/c\/([^/]+)\//.exec(ctx.boot.pageUrl)?.[1];
	if (!sessionId) throw new Error(`no conversation in the page's address: ${ctx.boot.pageUrl}`);
	const rulesFile = path.join(loops, "triggers.json");
	const setRule = (patch) => {
		const store = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
		Object.assign(store.rules[0], patch);
		fs.writeFileSync(rulesFile, JSON.stringify(store));
	};
	const inbox = () => jsonl(path.join(loops, "inbox.jsonl"));
	const audit = () => jsonl(path.join(loops, "triggers-audit.jsonl"));
	const results = () => audit().filter((a) => a.type === "trigger_result" && a.state === "completed" && (a.details?.matched_rule_ids ?? []).includes(RULE));
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};
	const startLoops = () => {
		const start = spawnSync(path.join(ctx.boot.root, "bin", "pi-loops"), ["start"], { cwd: ctx.boot.project, env: ctx.boot.env, encoding: "utf8", timeout: 10000 });
		if (start.error) throw start.error;
		if (start.status !== 0 && !/already running|a start is in progress/.test(start.stdout)) throw new Error(`pi-loops start exited ${start.status}: ${start.stdout}${start.stderr}`);
	};

	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	setRule({ enabled: true, createdBy: { sessionId } });
	startLoops();
	const first = await ctx.waitFor("the check matched", () => ({ ok: results().length >= 1, last: audit().slice(-3), value: results()[0] }), 90000);
	// One check is one finding, filed for the conversation that made the rule, with what the check said.
	setRule({ enabled: false });
	const filed = await ctx.waitFor("one finding for the check", () => {
		const mine = inbox().filter((e) => e.run_id === first.traceId);
		return { ok: mine.length === 1, last: mine, value: mine[0] };
	}, 15000);
	if (filed.source !== "trigger:local:dynamic" || filed.session_id !== sessionId || filed.job_id !== RULE || !filed.text.includes("hello, world")) throw new Error(`the finding is not the check's result for this conversation: ${JSON.stringify(filed)}`);
	const skipped = audit().find((a) => a.traceId === first.traceId && a.type === "trigger_promotion");
	if (skipped?.state !== "skipped") throw new Error(`without promote_to_chat the result is not in the conversation: ${JSON.stringify(skipped)}`);
	const card = await ctx.waitFor("the card names the rule", () => {
		const text = page(`[...document.querySelectorAll("#cardsSlot [data-inb]")].map((c) => c.textContent).join(" | ")`);
		return { ok: text.includes("hello, world") && text.includes("rule ~/build.done appears"), last: text, value: text };
	}, 30000);
	await ctx.waitFor("the strip lists the rule result", () => {
		const text = page(`document.getElementById("activitySlot").textContent`);
		return { ok: /rule result/.test(text), last: text };
	}, 30000);
	ctx.browser("click", "#activitySlot .strip-head");
	const row = await ctx.waitFor("the rule's row in the open strip", () => {
		const rows = page(`[...document.querySelectorAll("#activitySlot li.act")].map((li) => li.textContent)`);
		const mine = rows.find((t) => t.includes("rule ~/build.done appears"));
		return { ok: !!mine && mine.includes("in inbox"), last: rows, value: mine };
	}, 15000);
	shot("rule-result.png");
	const evidence = path.join(ctx.dir, "rule-result.txt");
	fs.writeFileSync(evidence, `finding: ${JSON.stringify(filed)}\ncard: ${card}\nstrip: ${row}\n`);
	ctx.addEvidence(evidence);

	// promote_to_chat: the result is in the conversation too, and still one finding.
	const before = results().length;
	setRule({ enabled: true, promoteToChat: true });
	const second = await ctx.waitFor("a promoted check", () => {
		const now = results();
		return { ok: now.length > before, last: now.length, value: now[before] };
	}, 90000);
	setRule({ enabled: false });
	const promotion = await ctx.waitFor("the promotion", () => {
		const row = audit().find((a) => a.traceId === second.traceId && a.type === "trigger_promotion");
		return { ok: !!row, last: audit().slice(-3), value: row };
	}, 30000);
	if (promotion.state !== "promoted" && promotion.state !== "appended") throw new Error(`the promoted result did not go to the conversation: ${JSON.stringify(promotion)}`);
	await ctx.waitFor("the result in the conversation", () => {
		const text = page(`document.getElementById("feed").textContent`);
		return { ok: text.includes(`[Trigger ${second.traceId}`) || text.includes("hello, world; test result: ok"), last: text.slice(-400) };
	}, 30000);
	const twice = inbox().filter((e) => e.run_id === second.traceId);
	if (twice.length !== 1) throw new Error(`a promoted result is ${twice.length} findings, not 1: ${JSON.stringify(twice)}`);
	shot("rule-chat.png");
}
