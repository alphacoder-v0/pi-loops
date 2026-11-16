import * as fs from "node:fs";
import * as path from "node:path";

export const id = "J12", title = "Two messages with the same words from the page are both answered", expect = "head", active = true, milestone = "M3b", page = "new", tui = false, needs = ["agent-browser"];

const WORDS = "check the build again";

/** The stand-in holds the first turn open with a `sleep`, so the second message waits in the queue behind it. */
export function seed() {
	return { modelEnv: { FAKE_MODEL_TOOL_SCRIPT: JSON.stringify([{ match: WORDS, tool: "bash", args: { command: "sleep 6" } }]) } };
}

const jsonl = (file) => { try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; /* a line still being written */ } }); } catch { return []; /* not written yet */ } };
const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));

export async function run(ctx) {
	const loops = ctx.boot.loopsDir;
	const leases = () => { try { return fs.readdirSync(path.join(loops, "leases")).filter((f) => f.endsWith(".json")).flatMap((f) => { try { return [JSON.parse(fs.readFileSync(path.join(loops, "leases", f), "utf8"))]; } catch { return []; /* being rewritten */ } }); } catch { return []; /* no lease yet */ } };
	ctx.browser("open", `${ctx.boot.url}?token=${ctx.boot.token}`);
	ctx.browser("fill", "#input", WORDS);
	ctx.browser("press", "Enter");
	const lease = await ctx.waitFor("the page's conversation", () => { const l = leases().find((x) => x.sessionFile); return { ok: !!l, last: leases(), value: l }; }, 20000);
	ctx.browser("fill", "#input", WORDS);
	ctx.browser("press", "Enter");
	const asked = () => jsonl(lease.sessionFile).filter((e) => e.type === "message" && e.message?.role === "user" && textOf(e.message).includes(WORDS));
	const answered = () => jsonl(lease.sessionFile).filter((e) => e.type === "message" && e.message?.role === "assistant" && textOf(e.message).includes(ctx.reply));
	await ctx.waitFor("both messages written and answered", () => ({ ok: asked().length === 2 && answered().length >= 2, last: { asked: asked().length, answered: answered().length } }), 60000);
	const marks = asked().map((e) => e.message.piLoopsRow?.id);
	if (marks.some((m) => !m) || new Set(marks).size !== 2) throw new Error(`each message is not its own row's: ${JSON.stringify(marks)}`);
	await ctx.waitFor("the queue empty", () => { const rows = jsonl(path.join(loops, "requests", `${lease.sessionId}.jsonl`)); return { ok: rows.length === 0, last: rows }; }, 20000);
	await new Promise((resolve) => setTimeout(resolve, 5000));
	if (asked().length !== 2) throw new Error(`the words were sent ${asked().length} times`);
	const screenshot = path.join(ctx.dir, "same-words.png");
	ctx.browser("screenshot", screenshot);
	ctx.addEvidence(screenshot);
	const evidence = path.join(ctx.dir, "same-words.txt");
	fs.writeFileSync(evidence, `marks ${JSON.stringify(marks)}\nanswered ${answered().length}\n`);
	ctx.addEvidence(evidence);
}
