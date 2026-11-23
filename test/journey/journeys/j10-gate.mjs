import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J10", title = "A gate holds a rule until its path exists and a loop while its command says the same", expect = "head", active = true, milestone = "M7", page = "new", tui = true, needs = ["agent-browser"];

/** The sentence's tool call, as J8 has the stand-in make it. */
export const modelTools = [{ match: "build.done", tool: "new_trigger", args: { condition: "~/build.done appears", action: "tell me it is there" } }];

export function seed(dirs) {
	fs.writeFileSync(path.join(dirs.loops, "config.toml"), "[triggers]\npoll_interval_secs = 1\n");
	// The stand-in answers a rule check by looking for the condition's path under the sandbox HOME.
	return { modelEnv: { FAKE_MODEL_TOOL_SCRIPT: JSON.stringify(modelTools), FAKE_MODEL_RULE_PATHS: "1" } };
}

/** Polls to wait through with the file absent. pi-loops polls on its 30-second tick, so this is about a minute and a half. */
const POLLS = 3;
/** Looks the loop's gate holds before the journey changes what it reads: each is a minute apart. */
const HELD = 2;
const LOOP = "gated";
const GATE = "cat gate.txt";
const PROMPT = "report what gate.txt says";

const jsonl = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }); } catch { return []; /* not written yet */ } };
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c?.text ?? "").join(""));

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const home = ctx.boot.env.HOME;
	const rulesFile = path.join(loops, "triggers.json");
	const rules = () => { try { return JSON.parse(fs.readFileSync(rulesFile, "utf8")).rules; } catch { return []; /* not written yet */ } };
	const audit = () => jsonl(path.join(loops, "triggers-audit.jsonl"));
	const polls = () => { try { return JSON.parse(fs.readFileSync(path.join(loops, "polls.json"), "utf8")); } catch { return {}; /* not claimed yet */ } };
	const jobs = () => { try { return JSON.parse(fs.readFileSync(path.join(loops, "jobs.json"), "utf8")).jobs; } catch { return []; /* not written yet */ } };
	const clock = (job) => { try { return JSON.parse(fs.readFileSync(path.join(loops, "clock.json"), "utf8")).jobs?.[job]; } catch { return undefined; /* being rewritten */ } };
	const page = (expr) => JSON.parse(JSON.parse(ctx.browser("eval", `JSON.stringify(${expr})`).trim()));
	const shot = (name) => {
		const file = path.join(ctx.dir, name);
		ctx.browser("screenshot", file);
		ctx.addEvidence(file);
	};
	const evidence = (name, text) => {
		const file = path.join(ctx.dir, name);
		fs.writeFileSync(file, text);
		ctx.addEvidence(file);
	};
	const modelLog = path.join(ctx.boot.root, "logs", "model.jsonl");
	const lastUser = (r) => textOf([...(r.messages ?? [])].reverse().find((x) => x.role === "user"));
	const loopAsks = () => jsonl(modelLog).filter((r) => lastUser(r).includes(PROMPT));
	const gateFile = path.join(ctx.boot.project, "gate.txt");

	// 1. A loop with a command gate, added in the terminal. It runs at its first slot, a minute from now,
	// while the rule below waits for its path: the two gates are seen side by side.
	fs.writeFileSync(gateFile, "build 1\n");
	ctx.term.type(`/cron add --stateful --name ${LOOP} --gate '${GATE}' "every 1m" ${PROMPT}`);
	ctx.term.press("Enter");
	const loop = await ctx.waitFor("the gated loop in jobs.json", () => { const j = jobs().find((x) => x.name === LOOP); return { ok: !!j, last: jobs(), value: j }; }, 20000);
	if (loop.gate?.command !== GATE || loop.stateful !== true) throw new Error(`the loop does not carry the gate: ${JSON.stringify(loop)}`);
	const runs = () => jsonl(path.join(loops, "runs.jsonl")).filter((r) => r.jobId === loop.id);

	// 2. The sentence, from the Watch box, set up from its card: the rule the person's page child creates.
	ctx.browser("set", "viewport", "1280", "800");
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	await ctx.waitFor("the Watch for… button", () => page(`!!document.getElementById("watchFor")`), 30000);
	ctx.browser("click", "#watchFor");
	ctx.browser("fill", "#watchText", "When ~/build.done appears, tell me it is there");
	ctx.browser("click", "#watchRead");
	await ctx.waitFor("the rule card", () => page(`[...document.querySelectorAll("#watchCards .proposal")].length === 1`), 30000);
	ctx.browser("click", "#watchCards .proposal button.primary");
	const rule = await ctx.waitFor("the rule, set up from its proposal", () => ({ ok: rules().length === 1 && rules()[0].enabled === true && !rules()[0].proposed, last: rules(), value: rules()[0] }), 30000);
	// A settled card closes the box and gives the composer back, so the next message sends.
	await ctx.waitFor("the box closed and the composer focused", () => { const s = page(`({ open: document.getElementById("watch").open, focus: document.activeElement && document.activeElement.id })`); return { ok: s.open === false && s.focus === "input", last: s }; }, 10000);

	// 3. Polls with the file absent: no running row, no model check, one waiting row. Before anything
	// else is asserted, so a build without the path gate fails here, on the model checks it makes.
	const created = audit().length;
	const claims = new Set();
	await ctx.waitFor(`${POLLS} polls`, () => {
		for (const [key, at] of Object.entries(polls())) if (key.endsWith(`:${rule.cwd}`)) claims.add(at);
		return { ok: claims.size >= POLLS, last: [...claims] };
	}, (POLLS + 2) * 31000);
	const since = audit().slice(created);
	// Only this rule's checks: the gated loop of the same project writes its own rows in the same ticks.
	const running = since.filter((r) => r.type === "trigger_result" && r.state === "running" && r.details?.cwd === rule.cwd && r.sourceLabel === "local:dynamic");
	const waiting = audit().filter((r) => r.type === "trigger" && r.state === "waiting" && r.eventLabel === rule.id);
	evidence("precheck.txt", `polls ${[...claims].join(", ")}\nrunning rows ${running.length}\nwaiting rows ${waiting.length}\n${since.map((r) => JSON.stringify(r)).join("\n")}\n`);
	if (running.length) throw new Error(`a model check ran before the file existed (${running.length} running rows)`);
	if (waiting.length !== 1) throw new Error(`expected one waiting row, got ${waiting.length}`);
	// Recorded at creation, with ~ resolved to the creating process's home.
	const gate = rule.gate;
	if (gate?.kind !== "path" || gate?.resolved !== path.join(home, "build.done") || gate?.of !== rule.condition) throw new Error(`the rule carries no path gate for ${path.join(home, "build.done")}: ${JSON.stringify(rule)}`);
	const look = await ctx.waitFor("the rule's row says it waits", () => {
		const t = page(`[...document.querySelectorAll("#auto [data-rulelook]")].map((e) => e.textContent).join(" | ")`);
		return { ok: /waits for ~\/build\.done · next look [^·]+ · no model call until the file exists/.test(t), last: t, value: t };
	}, 20000);
	shot("precheck.png");

	// 4. The file appears: the next poll's look lets the rule through to the model, once.
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

	// 5. The loop's first look found output no run had seen: one run, which read it in its [gate] block.
	const first = await ctx.waitFor("the loop's first run, its reading seen", () => {
		const c = clock(loop.id);
		return { ok: runs().length >= 1 && !!c?.gate?.seen, last: { runs: runs().length, gate: c?.gate }, value: c.gate.seen };
	}, 150000);
	if (!runs()[0].ok) throw new Error(`the loop's first run failed: ${JSON.stringify(runs()[0])}`);
	if (!loopAsks().some((r) => lastUser(r).includes("[gate]") && lastUser(r).includes("build 1"))) throw new Error("the first run's prompt has no [gate] block with what the gate read");
	const asksAfterFirst = loopAsks().length;

	// 6. The output stays the same: each look holds the slot. No run, no model call, and the looks are counted.
	const held = await ctx.waitFor(`${HELD} held looks`, () => { const g = clock(loop.id)?.gate; return { ok: (g?.looks ?? 0) >= HELD && g.seen?.digest === first.digest, last: g, value: g }; }, (HELD + 2) * 61000);
	if (runs().length !== 1) throw new Error(`the gate held, yet the loop ran ${runs().length} times`);
	if (loopAsks().length !== asksAfterFirst) throw new Error(`the gate held, yet the model was asked ${loopAsks().length - asksAfterFirst} more time(s)`);
	ctx.term.clearHistory();
	ctx.term.type("/cron");
	ctx.term.press("Enter");
	const heldLine = new RegExp(`gate: \`${GATE}\`: the same for (\\d+) looks since \\d\\d:\\d\\d; no model call until it changes`);
	const listing = await ctx.waitFor("/cron says the gate holds", () => { const s = ctx.term.screen({ history: 200, joined: true }); const m = heldLine.exec(s); return { ok: !!m && Number(m[1]) >= HELD, last: s, value: s }; }, 20000);
	evidence("cron.txt", listing);
	const rowText = () => page(`[...document.querySelectorAll("#auto [data-loopx]")].map((e) => e.textContent).join(" | ")`);
	const row = await ctx.waitFor("the page's loop row says no model call while the gate says the same", () => {
		const t = rowText();
		return { ok: new RegExp(`No model call while \`${GATE}\` says the same · last changed \\d\\d:\\d\\d`).test(t), last: t, value: t };
	}, 30000);
	ctx.browser("scrollintoview", `#auto [data-key="job:${loop.id}"]`);
	shot("gate-row.png");

	// 7. The output changes: the next look opens the slot. One run, whose [gate] block has the new output.
	fs.writeFileSync(gateFile, "build 2\n");
	await ctx.waitFor("the loop's second run", () => ({ ok: runs().length >= 2, last: { runs: runs().length, gate: clock(loop.id)?.gate } }), 3 * 61000);
	const second = runs()[1];
	if (!second.ok) throw new Error(`the loop's second run failed: ${JSON.stringify(second)}`);
	const ask = loopAsks().slice(asksAfterFirst).find((r) => lastUser(r).includes("[gate]"));
	if (!ask || !lastUser(ask).includes("build 2")) throw new Error(`the run after the change has no [gate] block with the new output: ${ask ? lastUser(ask) : "no request"}`);
	// The new reading is seen now, and the next look holds again: the change woke the loop once.
	const after = await ctx.waitFor("the new reading held by the next look", () => { const g = clock(loop.id)?.gate; return { ok: !!g?.seen && g.seen.digest !== first.digest && g.looks >= 1, last: g, value: g }; }, 3 * 61000);
	if (runs().length !== 2) throw new Error(`the change woke the loop ${runs().length - 1} times, not once`);
	const block = lastUser(ask);
	evidence("gate.txt", [`loop ${JSON.stringify(loop)}`, `held ${JSON.stringify(held)}`, `page row: ${row}`, `after the change ${JSON.stringify(after)}`, `runs ${JSON.stringify(runs().map((r) => ({ startedAt: r.startedAt, ok: r.ok })))}`, `the second run's [gate] block:\n${block.slice(block.indexOf("[gate]"), block.indexOf("[/gate]") + "[/gate]".length)}`].join("\n\n"));
}
