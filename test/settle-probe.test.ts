/**
 * The fact of pi that design stage 5d rests on: an extension's `agent_settled` handler can open
 * `ctx.ui.select` in pi's interactive terminal, and the person's answer reaches the handler.
 *
 * Real pi runs in a pseudo-terminal (test/journey/terminal.mjs) against the stand-in model, with a
 * temporary HOME, agent dir and loops dir. Each turn that settles opens the probe's selector; three
 * turns answer it with Enter, with Down and Enter, and with Esc. It skips where pi or python3 is not
 * on PATH. Measured against pi 1.2.0: Esc resolves the selector with undefined.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openTerminal } from "./journey/terminal.mjs";
import { tmp } from "./tmp.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function commandPath(name: string): string | undefined {
	const result = spawnSync("sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8", timeout: 10000 });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

const pi = commandPath("pi");
const python = commandPath("python3");
const skip = process.platform === "win32" ? "the probe drives pi through a unix pseudo-terminal, which Windows does not have"
	: !pi ? "pi is not on PATH"
	: !python ? "python3 is not on PATH (test/journey/terminal.py drives the pseudo-terminal)"
	: false;

// "warning", not "info": pi draws every info line from its latest message, so a redraw would show the last answer three times.
const PROBE = `export default function (pi) {
	pi.on("agent_settled", async (_e, ctx) => {
		let a;
		try {
			a = await ctx.ui.select("settle probe", ["one", "two"]);
		} catch (error) {
			ctx.ui.notify(\`settle probe rejected: \${error?.message ?? error}\`, "warning");
			return;
		}
		ctx.ui.notify(\`settle probe answered: \${a}\`, "warning");
	});
}
`;

test("an agent_settled handler opens a selector in pi's terminal, and the answer reaches it", { skip, timeout: 120000 }, async () => {
	const version = spawnSync(pi!, ["--version"], { encoding: "utf8", timeout: 10000 }).stdout.trim();
	const root = tmp("pi-loops-settle-probe-");
	const dirs = Object.fromEntries(["home", "agent", "loops", "project"].map((name) => [name, path.join(root, name)])) as Record<string, string>;
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
	const probe = path.join(root, "settle-probe.js");
	fs.writeFileSync(probe, PROBE);
	const env: Record<string, string> = {
		HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.agent, PI_LOOPS_DIR: dirs.loops,
		XDG_CONFIG_HOME: path.join(dirs.home, ".config"), XDG_CACHE_HOME: path.join(dirs.home, ".cache"),
		XDG_DATA_HOME: path.join(dirs.home, ".local", "share"), XDG_STATE_HOME: path.join(dirs.home, ".local", "state"),
		LANG: "C.UTF-8", TZ: "UTC", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NO_PROXY: "127.0.0.1,localhost",
	};
	const portFile = path.join(root, "model.port");
	let model: ChildProcess | undefined;
	let term: ReturnType<typeof openTerminal> | undefined;
	const screen = () => term?.screen({ history: 400, joined: true }) ?? "";
	const until = async (what: string, ok: () => boolean, ms = 30000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (ok()) return;
			await sleep(50);
		}
		throw new Error(`${what} (pi ${version}); the screen was:\n${screen()}`);
	};
	const count = (text: string) => screen().split(text).length - 1;
	try {
		model = spawn(process.execPath, [path.join(repo, "test/downstream/fake-model.mjs"), portFile], { cwd: dirs.project, env: { ...env, PATH: process.env.PATH ?? "", FAKE_MODEL_REPLY: "pong from the stand-in" }, stdio: "ignore" });
		await until("the stand-in model did not start", () => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").trim() !== "", 10000);
		const port = fs.readFileSync(portFile, "utf8").trim();
		fs.writeFileSync(path.join(dirs.agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-model" }] } } }));
		term = openTerminal({ dir: path.join(root, "terminal"), command: [pi!, "--no-session", "--no-extensions", "-e", probe, "--model", "fake/fake-model"], cwd: dirs.project, env });

		// The selector takes the editor's slot: its title, the options with the cursor on the first, and its key hint.
		const selectorOpen = () => /\n settle probe\n+ → one\n+   two\n+ ↑↓ navigate/.test(`\n${term!.screen()}`);
		const turn = async (message: string, keys: string, answer: string) => {
			const answers = count(answer);
			term!.type(message);
			await sleep(300);
			term!.press("Enter");
			await until(`the selector did not open after "${message}"`, selectorOpen);
			await sleep(300);
			term!.type(keys);
			await until(`"${answer}" did not appear after "${message}"`, () => count(answer) > answers && !selectorOpen(), 10000);
			return screen();
		};

		await until("pi's editor did not start", () => term!.alive() && screen().includes("fake-model"));
		const first = await turn("first probe turn", "\r", "Warning: settle probe answered: one");
		assert.match(first, /pong from the stand-in/);
		await turn("second probe turn", "\x1b[B\r", "Warning: settle probe answered: two");
		// A lone ESC is told from the start of a sequence by a pause; Esc gives undefined in pi 1.2.0.
		const third = await turn("third probe turn", "\x1b", "Warning: settle probe answered: undefined");
		assert.doesNotMatch(third, /settle probe rejected/);
	} finally {
		term?.stop();
		if (model && model.exitCode === null) model.kill("SIGTERM");
	}
});
