import assert from "node:assert/strict";
import { test } from "node:test";
import { openTerminal } from "./journey/terminal.mjs";
import { tmp } from "./tmp.ts";

test("journey terminal tracks VT screens, scrollback, and typed input", async () => {
	const dir = tmp("pi-loops-terminal-");
	const terminal = openTerminal({
		dir,
		command: [process.execPath, "-e", "process.stdout.write('abcd界zqr\\nA\\nB\\nC\\nD\\nE\\n\\x1b[2;1H\\x1b[2Kclean'); process.stdin.setRawMode(true); let input = ''; process.stdin.on('data', b => { input += b.toString(); if (input.endsWith('\\r')) { process.stdout.write('\\r\\x1b[2KGOT:' + input.slice(0, -1)); process.exit(0); } });"],
		cwd: process.cwd(),
		env: process.env,
		rows: 5,
		cols: 8,
	});
	const wait = async (probe: () => string, match: (screen: string) => boolean) => {
		const deadline = Date.now() + 1800;
		while (Date.now() < deadline) {
			const value = probe();
			if (match(value)) return value;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`terminal screen did not settle: ${probe()}`);
	};
	try {
		const full = await wait(() => terminal.screen({ history: 200 }), (screen) => screen.includes("clean"));
		assert.match(full, /clean/);
		assert(full.includes("abcd界zq"));
		const joinedOff = full.split("\n");
		assert(joinedOff.includes("abcd界zq"));
		assert(joinedOff.includes("r"));
		const joinedOn = terminal.screen({ history: 200, joined: true });
		assert(joinedOn.includes("abcd界zqr"));
		assert(full.includes("A"));
		terminal.clearHistory();
		await wait(() => terminal.screen({ history: 200 }), (screen) => !screen.includes("abcd界zq"));
		terminal.type("ping");
		terminal.press("Enter");
		const echoed = await wait(() => terminal.screen({ history: 200 }), (screen) => screen.includes("GOT:ping"));
		assert.match(echoed, /GOT:ping/);
		const deadline = Date.now() + 500;
		while (terminal.alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(terminal.alive(), false);
	} finally {
		terminal.stop();
	}
}, { timeout: 3000 });
