/**
 * The page server in this process, over a pool of stand-in pis: what test/page-server.test.ts,
 * test/page-children.test.ts and test/person-rows.test.ts drive. Not a test file itself, so the
 * tests that import it do not run each other's tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LeaseStore } from "../src/lease.ts";
import { ChildPool, type ChildPoolOptions } from "../src/page-children.ts";
import { type PageServer, type PageServerOptions, ring, startPageServer, unsentPersonRows } from "../src/page-server.ts";
import { RequestStore } from "../src/requests.ts";

export const TEST_TOKEN = "t".repeat(32);

/**
 * A stand-in pi in rpc mode. It answers `get_state` with the session id it was started for (the
 * file name of `--session`, else `sessionId`), records every command it is sent in `log`, and says
 * `lines` the moment it starts. `crashAfter` makes it start a turn and die in it. `argv` gets one line
 * per start: the arguments it was started with, as JSON. `stream` starts a turn `afterMs` after it
 * starts and streams `words` as text deltas, one every `stepMs`.
 */
export function fakePi(dir: string, opts: { sessionId?: string; sessionFile?: string; commands?: string[]; log?: string; lines?: unknown[]; crashAfter?: boolean; argv?: string; stream?: { words: string[]; stepMs: number; afterMs: number } } = {}): string {
	const file = path.join(dir, `fakepi-${Math.random().toString(36).slice(2, 10)}`);
	const script = [
		"#!/usr/bin/env node",
		'const fs = require("node:fs");',
		'const path = require("node:path");',
		'const at = process.argv.indexOf("--session");',
		`const sessionId = at === -1 ? ${JSON.stringify(opts.sessionId)} : path.basename(process.argv[at + 1]);`,
		`const log = ${JSON.stringify(opts.log ?? "")};`,
		...(opts.argv ? [`fs.appendFileSync(${JSON.stringify(opts.argv)}, JSON.stringify(process.argv.slice(2)) + "\\n");`] : []),
		`for (const ev of ${JSON.stringify(opts.lines ?? [])}) process.stdout.write(JSON.stringify(ev) + "\\n");`,
		...(opts.stream
			? [
					'const say = (ev) => process.stdout.write(JSON.stringify(ev) + "\\n");',
					`const words = ${JSON.stringify(opts.stream.words)};`,
					"setTimeout(() => {",
					'  say({ type: "agent_start" }); say({ type: "message_start" });',
					"  let n = 0;",
					"  const step = setInterval(() => {",
					'    if (n < words.length) return say({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: words[n++] } });',
					"    clearInterval(step);",
					'    say({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: words.join("") }], stopReason: "stop" } });',
					'    say({ type: "agent_end" }); say({ type: "agent_settled", aborted: false });',
					`  }, ${opts.stream.stepMs});`,
					`}, ${opts.stream.afterMs});`,
				]
			: []),
		...(opts.crashAfter ? ['process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");', 'setTimeout(() => { process.stderr.write("the provider hung up\\n"); process.exit(1); }, 300);'] : []),
		'let buf = "";',
		'process.stdin.on("data", (d) => {',
		"  buf += d; let i;",
		'  while ((i = buf.indexOf("\\n")) !== -1) {',
		"    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
		"    if (!line.trim()) continue;",
		"    let m; try { m = JSON.parse(line); } catch { continue; }",
		'    if (log) fs.appendFileSync(log, line + "\\n");',
		"    const data =",
		`      m.type === "get_state" ? { cwd: process.cwd(), sessionId, isStreaming: false${opts.sessionFile ? `, sessionFile: ${JSON.stringify(opts.sessionFile)}` : ""} }`,
		`      : m.type === "get_commands" ? { commands: ${JSON.stringify(opts.commands ?? [])}.map((name) => ({ name, source: "extension" })) }`,
		"      : {};",
		'    process.stdout.write(JSON.stringify({ type: "response", id: m.id, success: true, data }) + "\\n");',
		"  }",
		"});",
		"setInterval(() => {}, 1e9);",
		"",
	].join("\n");
	fs.writeFileSync(file, script, { mode: 0o755 });
	return file;
}

/** Wait for `ok`, polling; false when it never came. */
export async function until(ok: () => boolean, ms = 5000): Promise<boolean> {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 20))) if (ok()) return true;
	return ok();
}

export interface TestPage {
	loops: string;
	pool: ChildPool;
	server: PageServer;
	url: string;
	logs: string[];
	get(p: string): Promise<{ status: number; body: any }>;
	post(p: string, b: unknown): Promise<{ status: number; body: any }>;
	stop(): Promise<void>;
}

/** The server on port 0 over a pool whose children are `fake`, with the loops directory under `dir`. */
export async function startTestPage(dir: string, fake: string, extra: { pool?: Partial<ChildPoolOptions>; server?: Partial<PageServerOptions> } = {}): Promise<TestPage> {
	const loops = path.join(dir, "loops");
	const logs: string[] = [];
	const log = (line: string) => void logs.push(line);
	const requests = new RequestStore(loops);
	const pool = new ChildPool({ dir: loops, command: () => ({ command: fake, args: [] }), env: process.env, version: "0.0.0-test", log, ring: (c) => ring(c), unsent: (c) => unsentPersonRows(requests, c), ...extra.pool });
	const leases = new LeaseStore(loops);
	const server = await startPageServer({
		dir: loops,
		bind: { host: "127.0.0.1", port: 0 },
		allowHosts: [],
		token: TEST_TOKEN,
		version: "0.0.0-test",
		pool,
		sessions: { known: (id) => leases.read(id) },
		log,
		onListenError: (err) => log(`listen: ${err.message}`),
		...extra.server,
	});
	const url = server.url();
	const answer = async (r: Response) => ({ status: r.status, body: await r.json() });
	return {
		loops,
		pool,
		server,
		url,
		logs,
		get: async (p) => answer(await fetch(`${url}${p}`, { headers: { "x-pi-web-token": TEST_TOKEN } })),
		post: async (p, b) => answer(await fetch(`${url}${p}`, { method: "POST", headers: { "x-pi-web-token": TEST_TOKEN, "content-type": "application/json" }, body: JSON.stringify(b) })),
		stop: async () => {
			server.close();
			await pool.stopAll();
		},
	};
}

/** What one first visit left in the browser: the device cookie (`name=value`) and the secret its page was handed. */
export interface FirstVisit {
	status: number;
	cookie: string;
	setCookie: string;
	secret: string;
	html: string;
}

/** The secret a served page hands over, or "" when it hands none. */
export const secretIn = (html: string) => /DEVICE_SECRET = "([0-9a-f]*)"/.exec(html)?.[1] ?? "";

/** A browser that has never been here, opening `sessionId` through the launcher's open key. */
export async function firstVisit(page: TestPage, sessionId: string): Promise<FirstVisit> {
	const res = await fetch(`${page.url}c/${sessionId}/?open=${page.server.openKeyFor(sessionId)}`);
	const html = await res.text();
	const setCookie = res.headers.get("set-cookie") ?? "";
	return { status: res.status, cookie: setCookie.split(";")[0], setCookie, secret: secretIn(html), html };
}

/** A key for one address, minted the way the page mints it. */
export async function mintKey(page: TestPage, sessionId: string, kind: string, keyPath?: string): Promise<string> {
	const r = await page.post(`c/${sessionId}/key`, { for: kind, path: keyPath });
	if (typeof r.body?.key !== "string") throw new Error(`no key: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body.key;
}
