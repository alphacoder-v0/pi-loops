import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The page's own script, run against a DOM stub.
 *
 * Everything else about the browser front end was checked by asking its HTTP routes with curl,
 * which never executes a line of the page — and so `num is not defined` shipped in four releases,
 * where it threw inside the first `refresh()`, killed the startup, and left the front end with no
 * EventSource at all: you could send a message and never see a reply. A parser (`node --check`)
 * cannot catch that and the linter does not read template literals.
 */
function pageScript(): string {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const html = /const PAGE = String\.raw`([\s\S]*)`;\s*$/.exec(src)?.[1];
	assert.ok(html, "found the page in src/web.mjs");
	return html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</" + "script>")).replace("__TOKEN__", "test-token");
}

interface StubElement {
	_text: string;
	children: StubElement[];
	[k: string]: unknown;
}

/** Just enough DOM for the page to run: what it touches, nothing more. */
function stubDom(state: unknown, history: unknown) {
	const made: StubElement[] = [];
	const el = (tag = "div"): any => {
		const e: any = {
			tag, children: [], _text: "", className: "", style: {}, dataset: {}, hidden: false, options: [], value: "",
			append: (...cs: any[]) => e.children.push(...cs),
			set textContent(v: unknown) { e._text = String(v); },
			get textContent() { return e._text; },
			set innerHTML(v: unknown) { e._html = String(v); e.children = []; },
			get innerHTML() { return e._html ?? ""; },
			querySelector: () => el(),
			querySelectorAll: () => [],
			addEventListener() {}, removeEventListener() {}, focus() {}, showModal() {}, click() {}, setAttribute() {}, remove() {},
			get parentElement() { return (e._parent ??= el()); },
		};
		made.push(e);
		return e;
	};
	const byId = new Map<string, any>();
	const g = globalThis as any;
	g.document = {
		getElementById: (id: string) => {
			if (!byId.has(id)) byId.set(id, el());
			return byId.get(id);
		},
		createElement: (t: string) => el(t),
		addEventListener() {},
	};
	g.window = globalThis;
	g.Option = function (t: string, v: string) {
		const o = el("option");
		o.textContent = t;
		o.value = v;
		return o;
	};
	g.fetch = async (url: unknown) => ({
		json: async () => (String(url).includes("/state") ? state : String(url).includes("/history") ? history : {}),
	});
	let source: any;
	g.EventSource = class {
		constructor(url: string) {
			source = this;
			(this as any).url = url;
		}
	};
	// The page polls its own state every few seconds; a test process that inherits that timer never
	// exits. The one-shot timers it also uses are left alone, because startup depends on them.
	const realSetInterval = g.setInterval;
	g.setInterval = () => 0;
	return {
		made,
		// Both, because the feed writes text nodes and the sidebar writes markup.
		rendered: () => made.map((m) => `${m._text ?? ""}\n${(m as any)._html ?? ""}`).join("\n"),
		source: () => source,
		dispose: () => {
			g.setInterval = realSetInterval;
		},
	};
}

const STATE = {
	ok: true, sessionId: "01a0", cwd: "/work/api", model: { id: "m", provider: "p", label: "p/m" },
	modelCatalog: [{ id: "m", provider: "p", name: "M" }], thinkingLevel: "high", busy: false, messageCount: 0,
	queue: { steering: [], followUp: [] },
	// The shape a real session has: pi-loops writes a snapshot, and rendering it is where the page broke.
	runtime: { version: "0.0.0", scheduler: { running: true, leader: true, runs: 0, checks: 0 }, counts: {}, mcp: [{ name: "hub", state: "connected", kind: "stdio", tools: ["a"] }], hooks: { count: 1, events: ["run_end"] }, tools: ["read"], at: new Date().toISOString() },
	automation: { installed: true, dir: "/loops", jobs: [{ id: "cron-a", name: "nightly", schedule: "0 9 * * *", stateful: true, enabled: true, prompt: "check", runCount: 3, running: false }], rules: [], inboxNew: 2 },
	piAlive: true,
};

test("the page starts, subscribes, and renders a streamed reply", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	// If startup throws — anywhere, including while drawing the sidebar — there is no subscription,
	// and the front end silently stops being a front end.
	assert.ok(dom.source(), "an EventSource was created");
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	send({ type: "agent_start" });
	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "thinking out loud" } });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "你好！" } });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "有什么可以帮你的吗？" } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好！有什么可以帮你的吗？" }] } });
	send({ type: "agent_end" });

	const shown = dom.rendered();
	assert.match(shown, /你好！有什么可以帮你的吗？/, `the reply reached the page; got:\n${shown.slice(0, 400)}`);
	assert.match(shown, /thinking out loud/);
	// The sidebar drew too, which is the part that was throwing.
	assert.match(shown, /nightly/);
	dom.dispose();
});

test("a tool call and a dead pi both reach the page", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	// A tool call reaches the page as part of the assistant's stream, not as a separate event.
	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" } });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { name: "bash", arguments: { command: "ls -la" } } } });
	send({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "total 0" }] } });
	send({ type: "pi_exit", code: 1, signal: null, stderr: 'Error: Tool "cron_create" conflicts with /elsewhere' });

	const shown = dom.rendered();
	assert.match(shown, /bash/, "the tool it called");
	assert.match(shown, /ls -la/, "and what it ran");
	assert.match(shown, /total 0/, "and what came back");
	// Why pi died belongs on the page: the alternative is a terminal you opened this window to avoid.
	assert.match(shown, /conflicts with \/elsewhere/);
	dom.dispose();
});

/**
 * The sidebar reads jobs.json and triggers.json, which are files on disk — written by earlier
 * versions, by hand, by a half-finished write. A field of the wrong type there used to throw inside
 * `renderSidebar`, and because the whole panel is built as one string and assigned at the end, one
 * bad job took every other job's card with it.
 */
test("a job with the wrong types in it does not blank the sidebar", { timeout: 20_000 }, async () => {
	const automation = {
		installed: true, dir: "/loops",
		jobs: [
			{ id: 1234, schedule: "0 9 * * *", enabled: true, prompt: 7, runCount: '<img src=x onerror="alert(1)">', lastError: 500 },
			{ id: "cron-b", name: "healthy", schedule: "every 5m", enabled: true, prompt: "ok", runCount: 1 },
		],
		rules: [{ enabled: true, fireOnce: false, action: "notify" }], // no condition at all
		inboxNew: '<b>x</b>',
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	assert.ok(dom.source(), "startup survived the bad job");
	const shown = dom.rendered();
	assert.match(shown, /healthy/, `the well-formed job still drew; got:\n${shown.slice(0, 600)}`);
	// And nothing out of those files reached the DOM as markup.
	assert.doesNotMatch(shown, /<img src=x/);
	assert.doesNotMatch(shown, /<b>x<\/b>/);
	dom.dispose();
});
