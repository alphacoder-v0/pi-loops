import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { LeaseStore } from "../src/lease.ts";
import { GONE_LINE, WAITING_COMMANDS, registerWaitingWindow } from "../src/waiting-window.ts";
import { PI_LOOPS_VERSION } from "../src/version.ts";

/** A 0.22 window, as v0.22.8 writes its presence entry: this test's own pid stands for its process. */
function olderWindow(dir: string): string {
	const file = path.join(dir, "presence", "old.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), instance: "old", sessionId: "s-old", cwd: "/home/p/proj", kind: "interactive", heartbeatAt: new Date().toISOString() }));
	return file;
}

/** What a waiting window gave pi: its commands and its handlers, and nothing else (the stand-in has no registerTool). */
function fakePi() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	return {
		commands, handlers,
		pi: {
			registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => void commands.set(name, options.handler),
			on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => void handlers.set(event, handler),
		} as any,
	};
}

const ctxFor = (notes: string[], sessionId = "01a1dce4-8ad1-77c0-89b0-475ccfeaf6aa") => ({
	hasUI: true, cwd: "/home/p/new",
	ui: { notify: (text: string) => void notes.push(text) },
	sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/home/p/new/s.jsonl" },
});

test("[waiting-window] while an older window is open, a window registers only the pi-loops commands, which answer with the line, and only two handlers", async () => {
	const dir = tmp();
	olderWindow(dir);
	const { pi, commands, handlers } = fakePi();
	registerWaitingWindow(pi, { dir, self: "0.24.3", instance: "w1", log: () => undefined });
	assert.deepEqual([...commands.keys()].sort(), [...WAITING_COMMANDS].sort());
	assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"], "no turn, input, tool or settle handler: nothing of a turn writes the stores");
	const notes: string[] = [];
	await commands.get("cron")!("add every 1m x", ctxFor(notes));
	assert.match(notes[0] ?? "", /^\[pi-loops\] pi-loops 0\.24\.3 is waiting: a pi window with pi-loops 0\.22 \(pid \d+, \/home\/p\/proj\) is still open\. .* Then run \/reload in this window\.$/);
	assert.equal(fs.existsSync(path.join(dir, "jobs.json")), false, "the command wrote nothing");
});

test("[waiting-window] the window holds its conversation's lease as this version, says the line at start, and says /reload once the older one is gone", async () => {
	const dir = tmp();
	const presence = olderWindow(dir);
	const { pi, commands, handlers } = fakePi();
	registerWaitingWindow(pi, { dir, self: PI_LOOPS_VERSION, instance: "w1", log: () => undefined });
	const notes: string[] = [];
	const sessionId = "01a1dce4-8ad1-77c0-89b0-475ccfeaf6ab";
	await handlers.get("session_start")!({ reason: "startup" }, ctxFor(notes, sessionId));
	const lease = new LeaseStore(dir).read(sessionId);
	assert.equal(lease?.holder?.pid, process.pid);
	assert.equal(lease?.holder?.version, PI_LOOPS_VERSION, "a lease with its version: no window of this version takes it for an older one");
	assert.match(notes[0] ?? "", /is waiting: a pi window with pi-loops 0\.22/);
	fs.rmSync(presence);
	const after: string[] = [];
	await commands.get("inbox")!("", ctxFor(after));
	assert.deepEqual(after, [`[pi-loops] ${GONE_LINE}`]);
	await handlers.get("session_shutdown")!({}, ctxFor([]));
	assert.equal(new LeaseStore(dir).read(sessionId)?.holder ?? null, null, "released when the window goes");
});

test("[waiting-window] the extension waits before it opens anything: the gate is its first act, and the commands it lists are the ones the extension registers", () => {
	const here = path.dirname(new URL(import.meta.url).pathname);
	const source = fs.readFileSync(path.join(here, "..", "src", "pi-loops.ts"), "utf8");
	const gate = source.indexOf("registerWaitingWindow(pi,");
	assert.ok(gate > 0, "the factory calls registerWaitingWindow");
	assert.match(source.slice(gate, gate + 200), /\n\t\treturn;\n/, "and returns at once");
	for (const opened of ["openStores(dir)", "pi.registerTool(", "pi.on(\"session_start\""]) assert.ok(source.indexOf(opened) > gate, `${opened} comes after the gate`);
	const registered = [...source.matchAll(/pi\.registerCommand\("([^"]+)"/g)].map((m) => m[1]).sort();
	assert.deepEqual(registered, [...WAITING_COMMANDS].sort());
});

test("[waiting-window] an older background alone does not keep it waiting: the window, once reloaded, replaces it", async () => {
	const dir = tmp();
	const presence = olderWindow(dir);
	// And pi-loops 0.22 in the background, which its window started.
	fs.writeFileSync(path.join(dir, "presence", "bg.json"), JSON.stringify({ pid: process.ppid, host: os.hostname(), instance: "bg", cwd: "", kind: "host", heartbeatAt: new Date().toISOString() }));
	const { pi, commands, handlers } = fakePi();
	registerWaitingWindow(pi, { dir, self: "0.24.3", instance: "w1", log: () => undefined, everyMs: 20 });
	const notes: string[] = [];
	await handlers.get("session_start")!({ reason: "startup" }, ctxFor(notes));
	assert.match(notes[0] ?? "", /is waiting: a pi window with pi-loops 0\.22/);
	fs.rmSync(presence);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(notes.at(-1), `[pi-loops] ${GONE_LINE}`, "said once its window is gone, though its background still runs");
	const after: string[] = [];
	await commands.get("cron")!("", ctxFor(after));
	assert.deepEqual(after, [`[pi-loops] ${GONE_LINE}`]);
	await handlers.get("session_shutdown")!({}, ctxFor([]));
});
