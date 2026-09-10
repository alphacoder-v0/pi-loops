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
			// Assigning innerHTML replaces what was there, text included — the stub has to do the same
			// or a test can pass on text the browser would have thrown away.
			set innerHTML(v: unknown) { e._html = String(v); e.children = []; e._text = ""; },
			get innerHTML() { return e._html ?? ""; },
			querySelector: () => el(),
			querySelectorAll: () => [],
			addEventListener(type: string, fn: any) { (e._on ??= {})[type] = fn; },
			removeAttribute() {},
			removeEventListener() {}, focus() {}, showModal() {}, click() {}, setAttribute() {}, remove() {},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
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
		// The theme is written on the root element, and the panel state is read back from storage.
		documentElement: el("html"),
		body: el("body"),
		// The side panel is reached by tag, not by id; it is a drawer on a narrow screen.
		querySelector: (sel: string) => {
			if (!byId.has(sel)) byId.set(sel, el(sel));
			return byId.get(sel);
		},
	};
	g.window = globalThis;
	// A browser that blocks site data throws on the accessor itself; the page has to survive that,
	// so the stub gives it storage that works and a matchMedia that says "wide screen".
	const store = new Map<string, string>();
	g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
	g.matchMedia = () => ({ matches: false, addEventListener() {} });
	g.Option = function (t: string, v: string) {
		const o = el("option");
		o.textContent = t;
		o.value = v;
		return o;
	};
	g.fetch = async (url: unknown) => ({
		json: async () =>
			String(url).includes("/state")
				? state
				: String(url).includes("/history")
					? history
					: String(url).includes("/pair")
						? { success: true, code: "123456", addresses: [] }
						: { success: true },
	});
	// The page asks where it is, to decide which address a phone should be pointed at.
	g.location = { origin: "https://box.tailnet.ts.net", port: "" };
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

test("your own message is drawn once, not once by you and once by pi", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const doc = (globalThis as any).document;
	doc.getElementById("input").value = "你好呀";
	await doc.getElementById("composer").onsubmit({ preventDefault() {} });
	// pi appends what you sent to the session and says so, which is how a second window would learn
	// about it — and how this one used to end up showing everything you typed twice.
	dom.source().onmessage({ data: JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "你好呀" }] } }) });

	const hits = dom.rendered().split("你好呀").length - 1;
	assert.equal(hits, 1, `drawn once; got ${hits} times`);
	dom.dispose();
});

test("terminal escape codes do not reach the screen as text", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const ESC = "\u001b";

	// A startup banner an extension drew for a terminal, arriving through the session.
	send({ type: "message_end", message: { role: "custom", customType: "notice", content: `${ESC}[38;5;240m╭────╮${ESC}[0m ${ESC}[1m先想后做${ESC}[0m` } });
	// And a reply that arrives coloured, split so that one escape sequence spans two deltas.
	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `hello ${ESC}[1` } });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "m世界" } });

	const shown = dom.rendered();
	assert.doesNotMatch(shown, /\u001b/, "no escape characters");
	assert.doesNotMatch(shown, /38;5;240m/, "and nothing left of the sequence around them");
	assert.match(shown, /╭────╮ 先想后做/, "the text itself survives");
	assert.match(shown, /hello 世界/, "including across the delta that split a sequence in half");
	dom.dispose();
});

test("Enter while an input method is mid-word does not send", { timeout: 20_000 }, async () => {
	// Typing Chinese means Enter picks a candidate from the IME's list. Treating that as "send"
	// posts half a sentence and empties the box you were writing in.
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const doc = (globalThis as any).document;
	const input = doc.getElementById("input");
	let submitted = 0;
	doc.getElementById("composer").requestSubmit = () => submitted++;

	input.value = "ni hao";
	input._on.compositionstart({});
	input.onkeydown({ key: "Enter", shiftKey: false, keyCode: 229, preventDefault() {} });
	assert.equal(submitted, 0, "the input method gets that Enter");

	// And the Enter that follows the very same composition, on the browsers that end it first.
	input._on.compositionend({});
	input.onkeydown({ key: "Enter", shiftKey: false, preventDefault() {} });
	assert.equal(submitted, 0, "and so does the one right after it ends");

	// A while later, with nothing being composed, Enter is a person pressing send.
	await new Promise((r) => setTimeout(r, 80));
	input.onkeydown({ key: "Enter", shiftKey: false, preventDefault() {} });
	assert.equal(submitted, 1, "then it sends");
	dom.dispose();
});

test("a reply is rendered as Markdown, and cannot smuggle markup through it", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const BT = String.fromCharCode(96);

	const reply = [
		"## Findings",
		"",
		"- **one** with " + BT + "code" + BT,
		"- a link: [docs](https://example.com/x)",
		"",
		BT + BT + BT + "sh",
		"echo 1 < 2",
		BT + BT + BT,
		"",
		// What a model can be talked into writing, and what a tool result can contain.
		"<img src=x onerror=alert(1)> and [click](javascript:alert(2))",
	].join("\n");

	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } });

	const html = dom.rendered();
	assert.match(html, /<h4>Findings<\/h4>/, "headings render");
	assert.match(html, /<li><strong>one<\/strong> with <code>code<\/code><\/li>/, "so do lists, bold and code spans");
	assert.match(html, /<pre class="code" data-lang="sh"><code>echo 1 &lt; 2<\/code><\/pre>/, "and fenced code, with its contents escaped");
	assert.match(html, /<a href="https:\/\/example\.com\/x"[^>]*>docs<\/a>/, "an http link is a link");

	// The two that matter: no tag the model wrote, and no scheme that runs code.
	assert.doesNotMatch(html, /<img/, "markup in the reply stays text");
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, "shown, escaped");
	assert.doesNotMatch(html, /href="javascript:/, "and a javascript: link is not made into one");
	dom.dispose();
});

test("a confirmation shows what is about to run, apart from the reasoning", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;

	// What the danger gate sends: the command, a blank line, then why it was stopped.
	dom.source().onmessage({
		data: JSON.stringify({
			type: "extension_ui_request",
			id: "u1",
			method: "confirm",
			title: "Dangerous command",
			message: "rm -rf /var/cache/app /\n\nthis would delete the root filesystem; the allow entry covers /var/cache/app only",
		}),
	});

	assert.equal(doc.getElementById("askBody").textContent, "rm -rf /var/cache/app /", "the command stands on its own");
	assert.match(doc.getElementById("askWhy").textContent, /root filesystem/, "and the reasoning is underneath it");
	assert.equal(doc.getElementById("askWhy").hidden, false);
	dom.dispose();
});

test("a count in the panel leads to the list behind it", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	// "1 tools" is not the question anyone has; which tool is.
	const panel = (globalThis as any).document.getElementById("runtime");
	assert.match(panel.innerHTML, /<button class="count" data-detail="d\d+">1 tools<\/button>/, `got:\n${panel.innerHTML}`);
	dom.dispose();
});

/**
 * The QR encoder, checked against a frozen matrix rather than against another encoder.
 *
 * This matrix was produced by this code and then *decoded* by OpenCV's QR reader, along with every
 * payload length up to the 106 characters version 6 holds — which is the only property that
 * matters: a scanner reads it. Two bugs were found that way and neither would have shown up in a
 * self-consistent test, because both produced a well-formed picture: a Reed-Solomon generator
 * polynomial built in the wrong direction, and the two copies of the format bits transposed.
 */
const QR_GOLDEN = [
		"11111110001100100111001111111",
		"10000010011000111100101000001",
		"10111010110100000011001011101",
		"10111010100011011100101011101",
		"10111010100110100111101011101",
		"10000010111010110100001000001",
		"11111110101010101010101111111",
		"00000000101000100010100000000",
		"10111110001101011100101111100",
		"11110001011100100011101110001",
		"10101011111101111000000000000",
		"00100101101110010001110101010",
		"10000010000110011101000001100",
		"01010001100011000001011010001",
		"10001011010001111000010011100",
		"11011100101011011010100000010",
		"11001110110010101110100101100",
		"11000100010100000111111110101",
		"10110111011100010100111100100",
		"10001100100110100000100100010",
		"10100110001110011110111110111",
		"00000000111001101100100011111",
		"11111110000001111101101011100",
		"10000010110111010001100010001",
		"10111010100010100100111110100",
		"10111010101011001000100001111",
		"10111010101111011011111111110",
		"10000010000010010010101001010",
		"11111110100100110101010010100",
];

function qrOf(text: string): { version: number; mask: number; rows: string[] } {
	// The encoder is self-contained at the top of the page script; run that much of it.
	const script = pageScript();
	const start = script.indexOf("const CAP = [null, 14,");
	const end = script.indexOf("/* ---------------- markdown");
	assert.ok(start > 0 && end > start, "found the encoder in the page");
	const fn = new Function(script.slice(start, end) + "\nreturn qrMatrix(arguments[0]);");
	const q = fn(text);
	return { version: q.version, mask: q.mask, rows: q.m.map((r: Int8Array) => Array.from(r).join("")) };
}

test("the QR encoder still produces the matrix a scanner was shown", () => {
	const q = qrOf("https://box.tailnet.ts.net/?pair=123456");
	assert.equal(q.version, 3);
	assert.equal(q.mask, 2);
	assert.deepEqual(q.rows, QR_GOLDEN);
});

test("adding a device shows a code and something to point a camera at", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;

	await doc.getElementById("adddev").onclick();
	assert.equal(doc.getElementById("pairCode").textContent, "123456", "the code, big enough to read across a desk");
	assert.match(doc.getElementById("pairQr").innerHTML, /^<svg[^>]*viewBox="0 0 37 37"/, "and a QR of the address plus the code");
	assert.match(doc.getElementById("pairWhere").textContent, /https:\/\/box\.tailnet\.ts\.net\//, "pointed at the address this browser reached");
	dom.dispose();
});

test("on an address only this machine can reach, it says so instead of showing a useless QR", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	(globalThis as any).location = { origin: "http://127.0.0.1:4173", port: "4173" };
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;

	await doc.getElementById("adddev").onclick();
	assert.equal(doc.getElementById("pairQr").innerHTML, "", "a QR of 127.0.0.1 would be a lie");
	assert.match(doc.getElementById("pairWhere").textContent, /tailscale serve --bg 4173/, "and it says what to do about it");
	dom.dispose();
});

test("the page's own helpers are all actually reachable", { timeout: 20_000 }, async () => {
	/**
	 * A block comment that is opened and never closed is valid JavaScript. `node --check` accepts it,
	 * the linter does not read this file, and the page still loads — it just quietly has a hole in it
	 * where a hundred lines of code used to be. That is how the QR encoder shipped for about ten
	 * minutes: defined, parsed, and commented out. Asking the page what it can see costs nothing.
	 */
	const dom = stubDom(STATE, { messages: [] });
	const g = globalThis as any;
	const names = ["plain", "markdownToHtml", "inlineMd", "safeHref", "qrMatrix", "qrSvg", "row", "renderMessage", "renderSidebar", "renderRuntime", "handle", "refresh", "onAsk", "copyBtn", "mdInto", "countOf", "applyTheme"];
	await new Function(pageScript() + `\n; globalThis.__seen = {${names.map((n) => `${n}: typeof ${n}`).join(", ")}};`)();
	await new Promise((r) => setTimeout(r, 300));

	const missing = names.filter((n) => g.__seen[n] !== "function");
	assert.deepEqual(missing, [], `every helper the page defines is reachable from the page; missing: ${missing.join(", ")}`);
	dom.dispose();
});
