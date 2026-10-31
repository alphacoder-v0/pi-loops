import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const ONLY_SENDER = "window-executor.ts";
/** A session write into a conversation nobody has open, not a send to pi: the held adapter's `append`. */
const SESSION_WRITE = { file: "host-runtime.ts", call: 'appendCustomMessageEntry("pi-loops:trigger"' };

function sources(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(full);
		return /\.(ts|mjs)$/.test(entry.name) ? [full] : [];
	});
}

/** The code without its comments: a comment may name a call it tells the reader not to make. */
function stripComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every `sendMessage(` whose arguments, up to the end of the statement, name the trigger message type. */
function triggerSends(code: string): number {
	let count = 0;
	for (let at = code.indexOf("sendMessage("); at >= 0; at = code.indexOf("sendMessage(", at + 1)) {
		const end = code.indexOf(";", at);
		if (code.slice(at, end < 0 ? undefined : end).includes("pi-loops:trigger")) count++;
	}
	return count;
}

test("no file in src/ but window-executor.ts calls sendUserMessage or sends a pi-loops:trigger message", () => {
	const offenders: string[] = [];
	let sender = 0;
	for (const file of sources(SRC)) {
		const code = stripComments(fs.readFileSync(file, "utf8"));
		const sends = (code.match(/sendUserMessage\(/g)?.length ?? 0) + triggerSends(code);
		if (path.basename(file) === ONLY_SENDER) sender = sends;
		else if (sends) offenders.push(`${path.relative(SRC, file)} (${sends})`);
	}
	assert.ok(sender > 0, `${ONLY_SENDER} is the executor: it has to send`);
	assert.deepEqual(offenders, [], "a prompt reaches pi through the window executor only");
	const held = stripComments(fs.readFileSync(path.join(SRC, SESSION_WRITE.file), "utf8"));
	assert.ok(held.includes(SESSION_WRITE.call), `the held adapter writes the entry into the session file itself, the one allowed exception, and that is not a send`);
	assert.equal(triggerSends(held), 0);
});
