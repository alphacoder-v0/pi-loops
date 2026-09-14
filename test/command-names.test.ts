import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * pi drops an extension command that shares a name with one of its own built-ins ("conflicts with
 * built-in interactive command. Skipping in autocomplete."), and the built-in wins at the prompt —
 * so the command silently does nothing in the terminal while still working in modes that have no
 * built-ins, which is exactly how `/share` shipped and was verified. The list is not exported from
 * the package, so this reads it out of the installed build.
 */
function builtinCommandNames(): string[] {
	const root = execSync("npm root -g", { encoding: "utf8" }).trim();
	const file = path.join(root, "@earendil-works", "pi-coding-agent", "dist", "core", "slash-commands.js");
	const source = fs.readFileSync(file, "utf8");
	return [...source.matchAll(/name:\s*"([a-z][a-z0-9:-]*)"/g)].map((m) => m[1]);
}

function ourCommandNames(): string[] {
	const source = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");
	return [...source.matchAll(/registerCommand\("([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
}

test("no command of ours has the name of one of pi's own", () => {
	const builtins = new Set(builtinCommandNames());
	assert.ok(builtins.size > 10, `read ${builtins.size} built-in names — the parser has probably gone stale`);
	const ours = ourCommandNames();
	assert.ok(ours.length > 5, `read ${ours.length} of our commands — the parser has probably gone stale`);
	const clashes = ours.filter((name) => builtins.has(name));
	assert.deepEqual(clashes, [], `these are shadowed by pi's own commands and will not run in the terminal: ${clashes.join(", ")}`);
});

/**
 * Which subcommands a command has is decided by its `switch (sub)`; which ones a person is *told*
 * about is three hand-maintained lists beside it — the menu printed on a mistyped word, the text
 * `<cmd> help` prints, and the completion popup. They drifted: `/cron`'s menu was missing `set`,
 * `clear`, `cost`, `gc` and `host`, `/cron help` never mentioned `snapshot`, `/triggers` had lost
 * `hooks` and `panel` from its menu and its completions both, and `/inbox` had lost `list`. The
 * tests below read the `case` labels out of the dispatcher and hold all three lists to them, so a
 * `case` added later fails here until every list that claims to describe it says so.
 */
const EXTENSION = fs.readFileSync(path.join(process.cwd(), "src", "pi-loops.ts"), "utf8");

/** The `case "…"` labels of the `switch (sub)` whose `default:` arm prints `unknown /<command> …`. */
function dispatcherCases(command: string): string[] {
	const end = EXTENSION.indexOf(`unknown /${command} `);
	assert.ok(end > 0, `no \`unknown /${command}\` arm in src/pi-loops.ts — this test's parser has gone stale`);
	const start = EXTENSION.lastIndexOf("switch (sub) {", end);
	assert.ok(start > 0, `no \`switch (sub)\` before the /${command} default arm — this test's parser has gone stale`);
	const cases = [...EXTENSION.slice(start, end).matchAll(/\bcase "([a-z-]*)":/g)].map((m) => m[1]);
	assert.ok(cases.length > 5, `read ${cases.length} /${command} subcommands — this test's parser has gone stale`);
	return cases;
}

/** The value of a one-line `const <name> = "…";`, quotes stripped. */
function constantString(name: string): string {
	const head = `const ${name} = `;
	const at = EXTENSION.indexOf(head);
	assert.ok(at > 0, `no ${name} in src/pi-loops.ts — this test's parser has gone stale`);
	return EXTENSION.slice(at + head.length, EXTENSION.indexOf("\n", at))
		.replace(/;$/, "")
		.replace(/^["'`]|["'`]$/g, "");
}

/** The source of a `const <name> = [ … ];` array — enough to ask whether it spells something out. */
function constantBlock(name: string): string {
	const at = EXTENSION.indexOf(`const ${name} = [`);
	assert.ok(at > 0, `no ${name} in src/pi-loops.ts — this test's parser has gone stale`);
	const end = EXTENSION.indexOf("\n\t];", at);
	assert.ok(end > at, `${name} does not end where this test expects — its parser has gone stale`);
	return EXTENSION.slice(at, end);
}

/** The strings of the `const subs = [ … ]` a command's `getArgumentCompletions` offers. */
function completionNames(anchor: string): string[] {
	const at = EXTENSION.indexOf(anchor);
	assert.ok(at > 0, `no ${anchor} in src/pi-loops.ts — this test's parser has gone stale`);
	const from = EXTENSION.indexOf("const subs = [", at);
	const slice = EXTENSION.slice(from, EXTENSION.indexOf("]", from));
	assert.ok(from > at && slice.length < 400, `the completion list after ${anchor} is not where this test expects it`);
	return [...slice.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The names a `[a|b <id>|c]` menu offers: the first word of each alternative. */
function menuNames(usage: string): string[] {
	// To the *matching* bracket, so a menu that spells an argument (`add [--stateful] …`) is read
	// whole rather than cut off at the first `]` and reported as a disagreement it is not.
	const open = usage.indexOf("[");
	let depth = 0;
	let close = -1;
	for (let i = open; i >= 0 && i < usage.length; i++) {
		if (usage[i] === "[") depth++;
		else if (usage[i] === "]" && --depth === 0) {
			close = i;
			break;
		}
	}
	assert.ok(open >= 0 && close > open, `this usage line is not an [a|b|c] menu: ${usage}`);
	return [...new Set(usage.slice(open + 1, close).split("|").map((part) => part.trim().split(/\s/)[0]))];
}

const COMMANDS = [
	{
		command: "cron",
		usage: "CRON_USAGE",
		help: "CRON_HELP",
		completionsAfter: "const cronCompletions",
		// Second spellings of the case they fall through to: deliberately in none of the three lists.
		aliases: ["", "ls", "status", "resume", "pause", "rm", "delete"],
		// In the menu and the completions, but not written `/cron <sub>` in the help text — and why.
		helpSpellsDifferently: { list: "the first line of the help shows it as the bare `/cron`", help: "it is the text being read" },
		alsoCompleted: [],
	},
	{
		command: "inbox",
		usage: "INBOX_USAGE",
		help: "INBOX_HELP",
		completionsAfter: 'registerCommand("inbox"',
		aliases: ["", "--all"],
		helpSpellsDifferently: { list: "the first line of the help shows it as the bare `/inbox`", help: "it is the text being read" },
		// `--all` is a flag, not a subcommand — it may follow any of them, so it is worth completing.
		alsoCompleted: ["--all"],
	},
	{
		command: "recipe",
		usage: "RECIPE_USAGE",
		help: "RECIPE_HELP",
		completionsAfter: 'registerCommand("recipe"',
		aliases: ["", "ls", "rm"],
		helpSpellsDifferently: { list: "the first line of the help shows it as the bare `/recipe`", help: "it is the text being read" },
		alsoCompleted: [],
	},
	{
		command: "triggers",
		usage: "TRIGGERS_USAGE",
		help: "TRIGGERS_HELP",
		completionsAfter: 'registerCommand("triggers"',
		aliases: ["", "resume", "pause", "rm", "delete"],
		helpSpellsDifferently: { status: "the first line of the help shows it as the bare `/triggers`", help: "it is the text being read" },
		alsoCompleted: [],
	},
];

for (const c of COMMANDS) {
	test(`every /${c.command} subcommand the dispatcher accepts is named in the menu, the help text and the completions`, () => {
		const cases = dispatcherCases(c.command);
		const stale = c.aliases.filter((a) => !cases.includes(a));
		assert.deepEqual(stale, [], `these are declared aliases of /${c.command} but no longer case labels: ${stale.join(", ")}`);
		const subs = cases.filter((sub) => !c.aliases.includes(sub)).sort();

		assert.deepEqual(menuNames(constantString(c.usage)).sort(), subs, `${c.usage} and the /${c.command} dispatcher disagree about which subcommands exist`);

		const help = constantBlock(c.help);
		const excused = Object.keys(c.helpSpellsDifferently) as string[];
		const strayExcuse = excused.filter((sub) => !subs.includes(sub));
		assert.deepEqual(strayExcuse, [], `${c.help} excuses subcommands that do not exist: ${strayExcuse.join(", ")}`);
		for (const sub of subs) {
			if (excused.includes(sub)) continue;
			assert.ok(help.includes(`/${c.command} ${sub}`), `${c.help} never mentions /${c.command} ${sub} — say what it does, or excuse it above with a reason`);
		}

		assert.deepEqual(completionNames(c.completionsAfter).sort(), [...subs, ...c.alsoCompleted].sort(), `the /${c.command} completions and the dispatcher disagree`);
	});
}

test("the /cron and /triggers menus fit a notification, and say where the arguments went", () => {
	for (const name of ["CRON_USAGE", "TRIGGERS_USAGE"]) {
		const usage = constantString(name);
		const command = name === "CRON_USAGE" ? "cron" : "triggers";
		// Printed inside `unknown /cron command: sdf. usage: /cron …`, in one notification line: naming
		// all nineteen *and* spelling their arguments is more than that line can carry, so the names
		// are here and the arguments are one `help` away. That trade is what this asserts.
		assert.ok(!usage.includes("\n") && usage.length <= 170, `${name} has to stay one short line (${usage.length} chars)`);
		assert.match(usage, new RegExp(`/${command} help`), `${name} drops the argument spellings, so it has to point at /${command} help`);
	}
});
