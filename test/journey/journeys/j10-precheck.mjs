import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J10", title = "A path-only rule makes no model call until the path exists", expect = "head", active = true, milestone = "M7", page = "new", tui = false, needs = ["agent-browser"];

/** The sentence's tool call, as J8 has the stand-in make it. */
export const modelTools = [{ match: "build.done", tool: "new_trigger", args: { condition: "~/build.done appears", action: "tell me it is there" } }];

export function seed(dirs) {
	fs.writeFileSync(path.join(dirs.loops, "config.toml"), "[triggers]\npoll_interval_secs = 1\n");
	// The stand-in answers a rule check by looking for the condition's path under the sandbox HOME.
	return { modelEnv: { FAKE_MODEL_TOOL_SCRIPT: JSON.stringify(modelTools), FAKE_MODEL_RULE_PATHS: "1" } };
}

/** Polls to wait through with the file absent. pi-loops polls on its 30-second tick, so this is about a minute and a half. */
const POLLS = 3;

const jsonl = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }); } catch { return []; /* not written yet */ } };

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const home = ctx.boot.env.HOME;
	const rulesFile = path.join(loops, "triggers.json");
	const rules = () => { try { return JSON.parse(fs.readFileSync(rulesFile, "utf8")).rules; } catch { return []; /* not written yet */ } };
	const audit = () => jsonl(path.join(loops, "triggers-audit.jsonl"));
	const polls = () => { try { return JSON.parse(fs.readFileSync(path.join(loops, "polls.json"), "utf8")); } catch { return {}; /* not claimed yet */ } };
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};

	// 1. The sentence, from the Watch box, set up from its card: the rule the person's page child creates.
	ctx.browser("set", "viewport", "1280", "800");
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	await ctx.waitFor("the Watch for… button", () => page(`!!document.getElementById("watchFor")`), 30000);
	ctx.browser("click", "#watchFor");
	ctx.browser("fill", "#watchText", "When ~/build.done appears, tell me it is there");
	ctx.browser("click", "#watchRead");
	await ctx.waitFor("the rule card", () => page(`[...document.querySelectorAll("#watchCards .plan")].length === 1`), 30000);
	ctx.browser("click", "#watchCards .plan button.primary");
	const rule = await ctx.waitFor("the rule", () => ({ ok: rules().length === 1, last: rules(), value: rules()[0] }), 30000);
	ctx.browser("click", "#watchClose");

	// 2. Polls with the file absent: no running row, no model check, one waiting row. Before anything
	// else is asserted, so a build without the pre-check fails here, on the model checks it makes.
	const created = audit().length;
	const claims = new Set();
	await ctx.waitFor(`${POLLS} polls`, () => {
		for (const [key, at] of Object.entries(polls())) if (key.endsWith(`:${rule.cwd}`)) claims.add(at);
		return { ok: claims.size >= POLLS, last: [...claims] };
	}, (POLLS + 2) * 31000);
	const since = audit().slice(created);
	const running = since.filter((r) => r.type === "trigger_result" && r.state === "running" && r.details?.cwd === rule.cwd);
	const waiting = audit().filter((r) => r.type === "trigger" && r.state === "waiting" && r.eventLabel === rule.id);
	const lines = `polls ${[...claims].join(", ")}\nrunning rows ${running.length}\nwaiting rows ${waiting.length}\n${since.map((r) => JSON.stringify(r)).join("\n")}\n`;
	fs.writeFileSync(path.join(ctx.dir, "precheck.txt"), lines);
	ctx.addEvidence(path.join(ctx.dir, "precheck.txt"));
	if (running.length) throw new Error(`a model check ran before the file existed (${running.length} running rows)`);
	if (waiting.length !== 1) throw new Error(`expected one waiting row, got ${waiting.length}`);
	// 3. Recorded at creation, with ~ resolved to the creating process's home.
	if (rule.precheck?.resolved !== path.join(home, "build.done") || rule.precheck?.of !== rule.condition) throw new Error(`the rule carries no pre-check for ${path.join(home, "build.done")}: ${JSON.stringify(rule)}`);
	const look = await ctx.waitFor("the rule's row says it waits", () => {
		const t = page(`[...document.querySelectorAll("#auto [data-rulelook]")].map((e) => e.textContent).join(" | ")`);
		return { ok: /waits for ~\/build\.done · next look [^·]+ · no model call until the file exists/.test(t), last: t, value: t };
	}, 20000);
	shot("precheck.png");

	// 4. The file appears: the next poll's look lets the rule through to the model.
	fs.writeFileSync(path.join(home, "build.done"), "");
	const appeared = await ctx.waitFor("the appeared row", () => { const r = audit().find((x) => x.type === "trigger" && x.state === "appeared" && x.eventLabel === rule.id); return { ok: !!r, last: audit().slice(-3), value: r }; }, 3 * 31000);
	const check = await ctx.waitFor("the check the look let through", () => {
		const r = audit().find((x) => x.type === "trigger_result" && x.state === "running" && (x.details?.prechecked ?? []).includes(rule.id));
		return { ok: !!r, last: audit().slice(-3), value: r };
	}, 31000);
	const done = await ctx.waitFor("the check's result", () => { const r = audit().find((x) => x.traceId === check.traceId && x.type === "trigger_result" && x.state === "completed"); return { ok: !!r, last: audit().slice(-3), value: r }; }, 60000);
	if (!(done.details?.matched_rule_ids ?? []).includes(rule.id)) throw new Error(`the check did not match the rule once the file existed: ${JSON.stringify(done)}`);
	await ctx.waitFor("the fire-once rule disarmed by its match", () => ({ ok: rules()[0]?.enabled === false, last: rules() }), 10000);
	fs.appendFileSync(path.join(ctx.dir, "precheck.txt"), `row: ${look}\nappeared ${JSON.stringify(appeared)}\nrunning ${JSON.stringify(check)}\ncompleted ${JSON.stringify(done)}\n`);
}
