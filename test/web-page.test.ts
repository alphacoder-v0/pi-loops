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
/**
 * The page has two scripts: a short one in the head that applies the stored theme before the first
 * paint, and the rest at the bottom. `lastIndexOf` takes the second, which is what these tests run.
 */
function headScript(): string {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const html = /const PAGE = String\.raw`([\s\S]*)`;\s*$/.exec(src)?.[1] ?? "";
	return html.slice(html.indexOf("<script>") + 8, html.indexOf("</" + "script>"));
}

/** A version for the page under test: what matters is only whether it matches what /state says. */
const PAGE_UNDER_TEST = "0.0.0-test";

function pageScript(): string {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const html = /const PAGE = String\.raw`([\s\S]*)`;\s*$/.exec(src)?.[1];
	assert.ok(html, "found the page in src/web.mjs");
	// The server substitutes both of these on the way out; the tests have to as well or the page is
	// running with placeholders where its own identity should be.
	return html
		.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</" + "script>"))
		.replace("__TOKEN__", "test-token")
		.replace("__VERSION__", PAGE_UNDER_TEST);
}

interface StubElement {
	_text: string;
	children: StubElement[];
	[k: string]: unknown;
}

/** Just enough DOM for the page to run: what it touches, nothing more. */
function stubDom(state: unknown, history: unknown) {
	const made: StubElement[] = [];
	const detach = (c: any) => {
		const kids = c?._parent?.children;
		const at = kids?.indexOf(c) ?? -1;
		if (at >= 0) kids.splice(at, 1);
	};
	const el = (tag = "div"): any => {
		const e: any = {
			tag, children: [], _text: "", className: "", style: {}, dataset: {}, hidden: false, options: [], value: "",
			// Adding a node that already has a parent moves it, in a browser and here: without that,
			// the actions sheet test would pass with the buttons in two places at once.
			append: (...cs: any[]) => {
				for (const c of cs) { detach(c); if (c && typeof c === "object") c._parent = e; e.children.push(c); }
			},
			// Faithful enough to matter: the page removes nodes (the empty state, an image
			// thumbnail) and moves them (the actions sheet), and a no-op remove() would let a test
			// pass on a page that leaves both copies on the screen.
			insertBefore: (child: any, ref: any) => {
				detach(child);
				if (child && typeof child === "object") child._parent = e;
				const at = e.children.indexOf(ref);
				e.children.splice(at === -1 ? e.children.length : at, 0, child);
			},
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
			removeEventListener() {}, focus() {}, click() {}, setAttribute() {},
			// A browser sets `open` on both; the page reads it back to decide whether a click landed
			// on a dialog that is actually on the screen.
			showModal() { e.open = true; },
			close() { e.open = false; },
			getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
			remove() {
				const kids = e._parent?.children;
				const at = kids?.indexOf(e) ?? -1;
				if (at >= 0) kids.splice(at, 1);
			},
			classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
			get parentElement() { return (e._parent ??= el()); },
		};
		made.push(e);
		return e;
	};
	const byId = new Map<string, any>();
	// The page looks these up by tag as a group; create them first so the group is not empty.
	for (const id of ["ask", "detail", "pairdlg", "menu", "sessdlg"]) byId.set(id, el("dialog"));
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
		// The page reaches for groups of elements too — every dialog, the composer's buttons — and
		// gets back something it iterates. An empty list is a fine answer; not being a function is not.
		querySelectorAll: (sel: string) => (sel === "dialog" ? [byId.get("ask"), byId.get("detail"), byId.get("pairdlg"), byId.get("menu"), byId.get("sessdlg")].filter(Boolean) : []),
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
	// exits. The one-shot timers it also uses are left alone, because startup depends on them. The
	// callback is kept so a test can decide when a poll happens — some behaviour only exists there.
	const realSetInterval = g.setInterval;
	const polls: Array<() => unknown> = [];
	g.setInterval = (fn: () => unknown) => {
		polls.push(fn);
		return 0;
	};
	return {
		made,
		// Both, because the feed writes text nodes and the sidebar writes markup.
		rendered: () => made.map((m) => `${m._text ?? ""}\n${(m as any)._html ?? ""}`).join("\n"),
		source: () => source,
		/** Run the page's own polling callback, as the eight-second timer would. */
		poll: async () => {
			for (const fn of polls) await fn();
			await new Promise((r) => setTimeout(r, 60));
		},
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
	// One block, closed, holding both — not two open ones. A tool that prints two hundred lines
	// should not push the conversation off the screen to do it.
	const tools = dom.made.filter((el: any) => el.tag === "details" && String(el.className) === "row tool");
	assert.equal(tools.length, 1, "the call and its result are one block");
	// And the run of calls is one row of the conversation, not one row per call.
	const groups = dom.made.filter((el: any) => String(el.className) === "row work");
	assert.equal(groups.length, 1, "collected into a single block");
	assert.equal(tools[0]._parent, groups[0], "which is where the call lives");
	assert.equal(tools[0].children.filter((c: any) => c.tag === "pre").length, 2, "arguments and output, both inside it");
	assert.equal(tools[0].open ?? false, false, "and it starts closed");
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

test("an empty session says what it is, and the first message clears it", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	assert.match(dom.rendered(), /A pi session, in a browser/, "a blank rectangle says nothing at all");
	dom.source().onmessage({ data: JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) });
	const feed = (globalThis as any).document.getElementById("feed");
	assert.equal(feed.children.some((c: any) => c.className === "empty"), false, "and it goes when something arrives");
	dom.dispose();
});

test("the header's secondary actions move into a sheet and back, once each", { timeout: 20_000 }, async () => {
	// Moved rather than duplicated: two copies would mean two of every id and one of them going
	// stale the next time somebody edits the other.
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;

	doc.getElementById("more").onclick();
	assert.equal(doc.getElementById("menuBody").children.length, 1, "the actions went into the sheet");
	assert.equal(doc.getElementById("menuBody").children[0], doc.getElementById("actions"), "the same element, not a copy");
	doc.getElementById("menuClose").onclick();
	assert.equal(doc.getElementById("menuBody").children.length, 0, "and came back out");
	dom.dispose();
});

test("the stored theme is applied before the first paint", () => {
	// Applied with the rest of the script, a dark page renders light and then blinks. The test that
	// matters is where the code is, not what it does: it has to be its own tag, above the style.
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const html = /const PAGE = String\.raw`([\s\S]*)`;\s*$/.exec(src)?.[1] ?? "";
	assert.ok(html.indexOf("<script>") < html.indexOf("<style>"), "the theme script comes before the stylesheet");

	const head = headScript();
	assert.match(head, /documentElement\.dataset\.theme/, "and it sets the theme on the root element");

	const g = globalThis as any;
	const root: any = { dataset: {} };
	g.document = { documentElement: root };
	g.localStorage = { getItem: () => "dark" };
	new Function(head)();
	assert.equal(root.dataset.theme, "dark");

	// A browser that blocks site data throws on the accessor itself; the page still has to come up.
	g.localStorage = { getItem: () => { throw new Error("denied"); } };
	root.dataset = {};
	new Function(head)();
	assert.equal(root.dataset.theme, undefined);
});

test("two calls to the same tool keep their own results, in whatever order they finish", { timeout: 20_000 }, async () => {
	/**
	 * Pairing by name alone is only right if results come back in call order, and they do not: two
	 * shells started together finish when they finish. The earlier version also pushed an orphan
	 * result onto the queue it had just failed to match, and every later result for that tool was
	 * off by one for the life of the tab.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const tools = () => dom.made.filter((el: any) => el.tag === "details" && String(el.className) === "row tool");
	const textOf = (el: any) => el.children.filter((c: any) => c.tag === "pre").map((c: any) => c._text).join("|");

	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, toolCallId: "call-a", toolName: "bash" } });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolCallId: "call-b", toolName: "bash" } });
	// B finishes first.
	send({ type: "message_end", message: { role: "toolResult", toolName: "bash", toolCallId: "call-b", content: [{ type: "text", text: "output-B" }] } });
	send({ type: "message_end", message: { role: "toolResult", toolName: "bash", toolCallId: "call-a", content: [{ type: "text", text: "output-A" }] } });

	assert.equal(tools().length, 2, "two calls, two blocks");
	assert.match(textOf(tools()[0]), /output-A/, "the first call kept its own output");
	assert.match(textOf(tools()[1]), /output-B/, "and so did the second");
	dom.dispose();
});

test("a result nobody called for gets its own block and does not break the next pairing", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const tools = () => dom.made.filter((el: any) => el.tag === "details" && String(el.className) === "row tool");
	const textOf = (el: any) => el.children.filter((c: any) => c.tag === "pre").map((c: any) => c._text).join("|");

	// History that starts mid-turn: a result with no call in front of it.
	send({ type: "message_end", message: { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "orphan" }] } });
	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, toolName: "grep" } });
	send({ type: "message_end", message: { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "the real one" }] } });

	assert.equal(tools().length, 2);
	assert.match(textOf(tools()[0]), /orphan/);
	assert.match(textOf(tools()[1]), /the real one/, "the call after it still got its own result");
	dom.dispose();
});

test("a tool call that never returns stops saying it is running", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	send({ type: "agent_start" });
	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, toolName: "bash" } });
	const block: any = dom.made.filter((el: any) => el.tag === "details" && String(el.className) === "row tool")[0];
	const state = () => block.children[0].children.find((c: any) => c.className === "state")._text;
	assert.equal(state(), "running");
	// You pressed stop, or the turn ended without it.
	send({ type: "agent_end" });
	assert.equal(state(), "stopped", "nothing is coming for it now, and it should stop claiming otherwise");
	dom.dispose();
});

test("the find bar is actually hidden, and a metric tile is clickable where the numbers are", () => {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	// A rule that sets display beats the browser's own [hidden] rule, so the page has to say it.
	assert.match(src, /#findbar\[hidden\]\{display:none\}/, "the find bar can be hidden at all");

	// The tiles are a <b> and a <span> filling the button, so a click almost never lands on the
	// button itself; the handler has to look upwards for the key.
	const dom = stubDom(STATE, { messages: [] });
	try {
		const script = pageScript();
		assert.match(script, /closest\?\.\("\[data-detail\]"\)/, "the panel's click handler asks upwards for the key");
	} finally {
		dom.dispose();
	}
});

test("events already in the transcript are skipped by number, not by a timer", { timeout: 20_000 }, async () => {
	/**
	 * The page replays the transcript and then subscribes, and the backlog it joins may contain the
	 * same messages. This used to be handled by dropping every message_end for the first 300ms —
	 * which also dropped the live ones whenever the backlog held a turn that was still running.
	 * What arrived instead was a reply frozen as raw Markdown with its tools stuck on "running",
	 * because both of those are finished by a message_end. Found by opening the page and looking.
	 */
	const dom = stubDom(STATE, { messages: [], seq: 7 });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	// Backlog: already in the transcript we replayed.
	send({ type: "message_end", seq: 5, message: { role: "user", content: [{ type: "text", text: "already-seen" }] } });
	// Live: it happened after.
	send({ type: "message_end", seq: 8, message: { role: "user", content: [{ type: "text", text: "brand-new" }] } });

	const shown = dom.rendered();
	assert.doesNotMatch(shown, /already-seen/, "the backlog does not double the transcript");
	assert.match(shown, /brand-new/, "and a live event is not dropped for arriving early");
	dom.dispose();
});

test("the stylesheet does not let one thing style another", () => {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	// The pairing code used to be `class="code"`, which is also what a fenced code block gets, so
	// every line of code on the page was rendered with .28em of letter-spacing. Seen, not deduced.
	assert.doesNotMatch(src, /id="pairCode" class="code"/, "the pairing code is styled by its id");
	assert.match(src, /#pairCode\{[^}]*letter-spacing/, "and the letter-spacing belongs to it alone");
	// The feed is a column flexbox with a definite height: without this its children shrink, and a
	// tall block — an expanded tool, a long reply — is squeezed with its last line cut in half.
	assert.match(src, /#feed>\*\{flex:0 0 auto\}/, "feed children keep their height");
});

test("a stale completion answer cannot overwrite a newer one", { timeout: 20_000 }, async () => {
	/**
	 * Every keystroke asks for completions and the answers do not come back in order. Typing
	 * "@src/we" quickly showed the whole of src/ — the reply to "@src/" arriving after the reply to
	 * "@src/we" and overwriting it. Found by typing it in a browser.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const g = globalThis as any;
	const doc = g.document;

	let nth = 0;
	g.fetch = async (url: unknown, opts: any) => {
		if (!String(url).includes("/complete")) return { json: async () => ({ success: true }) };
		const which = nth++;
		// The older request answers later — with the wider, staler list.
		const items = which === 0 ? [{ value: "@src/", hint: "dir" }, { value: "@src/args.ts", hint: "file" }] : [{ value: "@src/web.mjs", hint: "file" }];
		const delay = which === 0 ? 80 : 10;
		return { json: () => new Promise((r) => setTimeout(() => r({ items }), delay)) };
	};

	const input = doc.getElementById("input");
	assert.equal(typeof input.oninput, "function", "the page installed an input handler");
	input.value = "@src/";
	input.selectionStart = 5;
	input.oninput();
	input.value = "@src/we";
	input.selectionStart = 7;
	input.oninput();
	await new Promise((r) => setTimeout(r, 200));

	await new Promise((r) => setTimeout(r, 200));
	// render() empties the popup and appends a div per item, so the markup is on the children.
	const html = [...doc.getElementById("pop").children].map((c: any) => c.innerHTML).join(" ");
	assert.match(html, /@src\/web\.mjs/, "the newest answer is the one on screen");
	assert.doesNotMatch(html, /@src\/args\.ts/, `and the stale one never draws; got:\n${html}`);
	dom.dispose();
});

test("undo does not claim to have put a message back when it has not", () => {
	// pi hands back the forked message when there was one. The notice used to say it was in the
	// composer either way.
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(src, /\$\("input"\)\.value \? "forked from your last message — it is back in the composer" : "forked from your last message"/);
});

test("the door page is readable on a phone and follows the system theme", () => {
	// It is the first screen a new device sees, and it had neither a viewport nor a colour scheme:
	// desktop-width text, and a white flash on a phone in dark mode.
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const door = /const DOOR = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
	assert.match(door, /name="viewport"/, "it has a viewport");
	assert.match(door, /name="color-scheme" content="light dark"/, "and follows the system theme");
	assert.match(door, /background:Canvas;color:CanvasText/, "with surfaces that follow it too");
});

test("a gap in the event stream reloads the conversation instead of leaving a hole", { timeout: 20_000 }, async () => {
	/**
	 * Appending is what keeps a selection alive and a tool panel open, but it also means an event
	 * that never arrives is simply missing and the page goes quietly out of date. A reconnect, or a
	 * tab the browser suspended, is exactly that. The numbers make it detectable.
	 */
	const dom = stubDom(STATE, { messages: [{ role: "assistant", content: [{ type: "text", text: "from the transcript" }] }], seq: 3 });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	send({ type: "message_end", seq: 4, message: { role: "user", content: [{ type: "text", text: "in order" }] } });
	assert.match(dom.rendered(), /in order/, "the next one in sequence is drawn");

	// 9 means 5 to 8 never arrived.
	send({ type: "message_end", seq: 9, message: { role: "user", content: [{ type: "text", text: "after the gap" }] } });
	await new Promise((r) => setTimeout(r, 200));

	const shown = dom.rendered();
	assert.match(shown, /the conversation above was reloaded/, "it says what happened");
	assert.match(shown, /from the transcript/, "and the transcript is taken again");
	assert.doesNotMatch(shown, /after the gap/, "rather than drawing on top of a hole");
	dom.dispose();
});

test("a message carries at most ten images", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;

	(globalThis as any).FileReader = class {
		onload: any;
		result = "data:image/png;base64,AAAA";
		readAsDataURL() { this.onload?.(); }
	};
	const files = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}.png`, type: "image/png" }));
	doc.getElementById("file").onchange({ target: { files, value: "" } });
	await new Promise((r) => setTimeout(r, 100));

	assert.equal(doc.getElementById("thumbs").children.length, 10, "ten of them");
	assert.match(dom.rendered(), /up to 10 images per message/, "and it says why the rest are missing");
	dom.dispose();
});

test("clicking outside a dialog closes it; clicking inside does not", { timeout: 20_000 }, async () => {
	// A native <dialog> does not do this on its own: the browser's backdrop takes the click, so the
	// target is the dialog while the point is outside its box.
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const dlg = (globalThis as any).document.getElementById("ask");
	assert.ok(dlg._on?.click, "the page listened for clicks on it");

	dlg.open = true;
	dlg._on.click({ target: dlg, clientX: 50, clientY: 50 });
	assert.equal(dlg.open, true, "a click on the dialog itself is not a click away from it");
	dlg._on.click({ target: dlg, clientX: 500, clientY: 500 });
	assert.equal(dlg.open, false, "a click on the backdrop is");
	dom.dispose();
});

test("a phone's soft keyboard cannot steal the tap on send", () => {
	// Tapping a button beside the box blurs the box, which dismisses the keyboard, which relayouts
	// the page — and the tap lands where the button used to be. Not reproducible in a desktop
	// browser, which is why this is asserted on the source rather than on behaviour.
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(src, /form#composer button[\s\S]{0,240}pointerdown[\s\S]{0,80}preventDefault/, "the composer's buttons do not take focus on pointerdown");
});

test("a run of tool calls is one row, and the next run is a new one", { timeout: 20_000 }, async () => {
	/**
	 * A turn that reads four files and runs two commands used to spend six rows of the conversation
	 * saying so, and the conversation is the thing being read. Consecutive calls collect; anything
	 * else — a reply, a thought — ends the run.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const groups = () => dom.made.filter((el: any) => String(el.className) === "row work");

	send({ type: "message_start" });
	for (const [i, name] of ["read", "read", "bash"].entries()) {
		send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: i, toolCallId: "c" + i, toolName: name } });
	}
	assert.equal(groups().length, 1, "three calls, one row");
	assert.equal(groups()[0].children.filter((c: any) => c.tag === "details").length, 3, "with all three inside it");
	// The summary is a <summary> holding a span; the text is on the span.
	const summary = groups()[0].children.find((c: any) => c.tag === "summary");
	assert.match(summary.children.map((c: any) => c._text).join(" "), /bash|read/, "and says what is running");

	// The reply ends the run.
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "and here is what I found" } });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 4, toolCallId: "c9", toolName: "write" } });
	assert.equal(groups().length, 2, "a call after the reply starts a new row");
	dom.dispose();
});

test("a reply can show a picture, and point at a file you can open", { timeout: 20_000 }, async () => {
	/**
	 * "I put the chart in ./out/chart.png" is a sentence you cannot see the chart in, and a page the
	 * model wrote is HTML source in a code block. A path in a reply is a path to something this
	 * process can serve — checked, typed and sandboxed on the way out.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const BT = String.fromCharCode(96);

	const reply = [
		"here it is: ![chart](./out/chart.png)",
		"",
		"and the write-up is in [out/report.html](out/report.html), or on [the web](https://example.com/x).",
		"",
		"a link that is not a link: [x](javascript:alert(1))",
	].join("\n");
	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } });

	const html = dom.rendered();
	assert.match(html, /<img src="\/file\?path=out%2Fchart\.png" alt="chart"/, "the picture is a picture");
	assert.match(html, /<a href="\/file\?path=out%2Freport\.html"[^>]*class="file"/, "the file is something to open");
	// And the token is not in either of them: a page the model wrote can read its own address.
	assert.doesNotMatch(html, /file\?path=[^"]*token=/, "no credential in a URL a preview can read");
	assert.match(html, /<a href="https:\/\/example\.com\/x"/, "and a web link is still a web link");
	assert.doesNotMatch(html, /href="javascript:/, "while a scheme of its own is not made into one");
	dom.dispose();
});

test("an image that came back from a tool is shown, not dropped", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, toolCallId: "c1", toolName: "screenshot" } });
	send({
		type: "message_end",
		message: {
			role: "toolResult",
			toolName: "screenshot",
			toolCallId: "c1",
			content: [{ type: "text", text: "took a shot" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
		},
	});

	const shot = dom.made.find((el: any) => el.tag === "img" && String(el.className) === "shot");
	assert.ok(shot, "the image block reached the screen");
	assert.match(String(shot.src), /^data:image\/png;base64,iVBORw0KGgo=$/, "as itself, from the message, fetching nothing");
	dom.dispose();
});

test("what arrives while the conversation is reloading lands after it, not before", { timeout: 20_000 }, async () => {
	/**
	 * Taking the transcript again takes a moment, and events keep arriving while it happens. The
	 * feed is emptied before that wait, so nothing already drawn is lost — but an event that lands
	 * during it was being drawn *first* and the transcript appended underneath, putting the newest
	 * message above the conversation it belongs to. They wait their turn now.
	 */
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [{ role: "assistant", content: [{ type: "text", text: "from the transcript" }] }], seq: 3 });
	// /history answers slowly, so there is a window to arrive in.
	const realFetch = g.fetch;
	let asked = 0;
	g.fetch = async (url: unknown, opts: any) => {
		const r = await realFetch(url, opts);
		if (!String(url).includes("/history")) return r;
		// The second time, the transcript is taken after the event that opened the gap — which is
		// what a server reports: the number that was current when it answered.
		const seq = ++asked === 1 ? 3 : 40;
		return { json: async () => { await new Promise((res) => setTimeout(res, 120)); return { ...(await r.json()), seq }; } };
	};

	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 500));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	// A gap starts a reload…
	send({ type: "message_end", seq: 40, message: { role: "user", content: [{ type: "text", text: "the one that opened the gap" }] } });
	// …and this arrives while it is happening.
	send({ type: "message_end", seq: 41, message: { role: "user", content: [{ type: "text", text: "sent during the reload" }] } });
	await new Promise((r) => setTimeout(r, 400));

	// What is on the screen now, not what was ever created: the whole point is that something was
	// drawn and then removed.
	const onScreen = (el: any): string =>
		[el._text ?? "", el._html ?? "", ...(el.children ?? []).map(onScreen)].join(" ");
	const rows = (globalThis as any).document.getElementById("feed").children.map(onScreen);
	const transcript = rows.findIndex((t: string) => /from the transcript/.test(t));
	const late = rows.findIndex((t: string) => /sent during the reload/.test(t));
	assert.ok(transcript >= 0, `the transcript came back; got:\n${rows.join("\n")}`);
	assert.ok(late >= 0, "and what arrived meanwhile is there");
	assert.ok(late > transcript, `in that order; got:\n${rows.join("\n")}`);
	dom.dispose();
});

test("a page that stops receiving events notices by itself", { timeout: 20_000 }, async () => {
	/**
	 * Everything else here reacts to events, which is no use when the events are what stopped
	 * arriving. A server restarted under an open page, a stream the browser dropped in a background
	 * tab: the page goes on looking alive, drawing what you typed and never showing an answer, until
	 * somebody thinks to reload it. The poll carries the same numbers the stream does, so being
	 * behind is something the page can see.
	 */
	const g = globalThis as any;
	const state: any = { ...STATE, seq: 5, epoch: "aaa" };
	// A real server answers both routes from the same counter, so the history follows the state.
	const history: any = { messages: [{ role: "assistant", content: [{ type: "text", text: "what was there" }] }] };
	Object.defineProperty(history, "seq", { get: () => state.seq });
	Object.defineProperty(history, "epoch", { get: () => state.epoch });
	const dom = stubDom(state, history);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const feedText = () => {
		const walk = (el: any): string => [el._text ?? "", el._html ?? "", ...(el.children ?? []).map(walk)].join(" ");
		return walk(doc.getElementById("feed"));
	};

	// The stream has gone quiet and the server has moved on. One poll is not evidence — an event can
	// simply be in flight — so nothing happens on the first.
	state.seq = 9;
	await dom.poll();
	assert.doesNotMatch(feedText(), /connection dropped/, "one poll ahead is not evidence");

	// Twice in a row is.
	await dom.poll();
	await new Promise((r) => setTimeout(r, 200));
	assert.match(feedText(), /connection dropped/, "the page says what happened");
	assert.match(feedText(), /what was there/, "and takes the transcript again");

	// A server that has been replaced is noticed at once: its numbers mean nothing next to ours.
	state.epoch = "bbb";
	state.seq = 2;
	await dom.poll();
	await new Promise((r) => setTimeout(r, 200));
	assert.match(feedText(), /session restarted/, "a restart needs no second opinion");
	dom.dispose();
});

test("a page left open across an upgrade says so", { timeout: 20_000 }, async () => {
	/**
	 * A tab that has been open across an upgrade looks exactly like a current one. The panel even
	 * shows a version — the server's, read live — so the one thing on screen that looks like an
	 * answer to "how old is this page" is answering a different question. Three rounds of "no reply
	 * appears" were spent on a page that could not have received one.
	 */
	const state: any = { ...STATE, version: "9.9.9" };
	const dom = stubDom(state, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;

	await dom.poll();
	const bar = doc.getElementById("stale");
	assert.equal(bar.hidden, false, "it says something");
	assert.match(bar.textContent, new RegExp("running v" + PAGE_UNDER_TEST.replace(/\./g, "\\.")), "which version this page is");
	assert.match(bar.textContent, /9\.9\.9 is installed/, "which version is installed");
	assert.match(bar.textContent, /Reload/, "and what to do about it");

	// The same version is not news.
	state.version = PAGE_UNDER_TEST;
	doc.getElementById("stale").hidden = true;
	await dom.poll();
	assert.equal(doc.getElementById("stale").hidden, true, "a current page says nothing");
	dom.dispose();
});

test("a stretch of work is one row, and one button opens every one of them", { timeout: 20_000 }, async () => {
	/**
	 * Thinking and tool calls arrive interleaved — think, read, think, run, think — and each one
	 * used to take a row of the conversation. A long agentic turn was thirty rows of plumbing around
	 * three sentences of answer.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const doc = (globalThis as any).document;
	const work = () => dom.made.filter((el: any) => String(el.className) === "row work");

	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "first I look" } });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolCallId: "c1", toolName: "read" } });
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "then I think again" } });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 3, toolCallId: "c2", toolName: "bash" } });

	assert.equal(work().length, 1, "thinking and tools together are one row");
	const summary = work()[0].children.find((c: any) => c.tag === "summary");
	assert.match(summary.children.map((c: any) => c._text).join(" "), /think|read|bash/, "which says what is going on");

	// The answer ends the stretch; the next one starts its own.
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 4, delta: "here is the answer" } });
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 5, delta: "more" } });
	assert.equal(work().length, 2, "and a new stretch after the answer is a new row");

	// One button for all of them, remembered.
	doc.getElementById("expand").onclick();
	assert.match(doc.getElementById("expand").textContent, /▾/, "the button says what it will do next");
	dom.dispose();
});

test("a path written in prose becomes something to open, and a picture becomes a picture", { timeout: 20_000 }, async () => {
	/**
	 * "I put it in /home/you/Downloads/report.html" is how a model says where something is, and
	 * until now that was a sentence with a dead end in it.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	const reply = [
		"做好了：/home/you/Downloads/report.html",
		"",
		"上面那张就是它 —— ~/Downloads/card.png 。",
		"",
		"不受影响的：a/b、http://x.com/y.png、`code/x.png`",
		"",
		"而这个要能点开：`/home/you/Downloads/形式化证明.html`（模型就是这么写路径的）",
		"",
		"这个要显示成图：`~/Downloads/card2.png`",
		"",
		"这个不动：`cat ./a.html`",
	].join("\n");
	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } });

	const html = dom.rendered();
	assert.match(html, /<a href="\/file\?path=%2Fhome%2Fyou%2FDownloads%2Freport\.html"[^>]*class="file"/, "an absolute path after a full-width colon");
	assert.match(html, /<img src="\/file\?path=~%2FDownloads%2Fcard\.png"/, "and a picture is shown, not linked");
	assert.doesNotMatch(html, /file\?path=code/, "an ordinary code span is left as written");
	assert.doesNotMatch(html, /file\?path=[^"]*x\.com/, "and a web address is not a file");

	// Backticks around a filename is how a model writes one, and leaving that alone was a rule
	// firing on exactly the case it was meant to serve.
	assert.match(html, /<a href="\/file\?path=%2Fhome%2Fyou%2FDownloads%2F[^"]*"[^>]*class="file"><code>/, "a code span that is only a path is a link");
	assert.match(html, /<img src="\/file\?path=~%2FDownloads%2Fcard2\.png"/, "and one that is only a picture is the picture");
	assert.match(html, /<code>cat \.\/a\.html<\/code>/, "a span with anything else in it stays a literal string");
	dom.dispose();
});

test("an extension speaking mid-work does not cut the stretch in two", { timeout: 20_000 }, async () => {
	/**
	 * An extension that logs what a tool just did — "wrote 166 lines to x.html" — speaks in the
	 * middle of a stretch of work. As a row of its own it takes a line *and* ends the stretch, so
	 * six steps and thirty-five become three rows of conversation instead of one.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const work = () => dom.made.filter((el: any) => String(el.className) === "row work");

	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, toolCallId: "c1", toolName: "write" } });
	send({ type: "message_end", message: { role: "custom", customType: "karpathy", content: "write /home/you/code/x.html | 166 lines" } });
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolCallId: "c2", toolName: "edit" } });

	assert.equal(work().length, 1, "still one stretch");
	assert.equal(work()[0].children.filter((c: any) => String(c.className) === "note").length, 1, "with the note inside it");

	// Between turns it is a message again, not something buried.
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "done" } });
	send({ type: "message_end", message: { role: "custom", customType: "trigger", content: "[Trigger deploy] the build failed twice" } });
	const shown = dom.rendered();
	assert.match(shown, /Trigger deploy/, "a message that arrives between turns is a message");
	assert.equal(work().length, 1, "and does not open a stretch of its own");
	dom.dispose();
});

/**
 * The two things you do between turns rather than during them: summarise what is there, or put it
 * down and start again. Both are typed as often as they are clicked — they are the same habit
 * brought over from a terminal — so the composer has to run them rather than send them.
 */
test("clear, resume and compact are typed as well as clicked", { timeout: 20_000 }, async () => {
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	const calls: Array<{ url: string; body: unknown }> = [];
	const realFetch = g.fetch;
	g.fetch = async (url: unknown, opts: any) => {
		calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : undefined });
		if (String(url).includes("/compact")) return { json: async () => ({ success: true, data: { tokensBefore: 150_000, estimatedTokensAfter: 32_000, usage: { cost: { total: 0.03 } } } }) };
		if (String(url).includes("/session/")) return { json: async () => ({ success: true, data: { cancelled: false } }) };
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const submit = async (text: string) => {
		doc.getElementById("input").value = text;
		await doc.getElementById("composer").onsubmit({ preventDefault() {} });
		await new Promise((r) => setTimeout(r, 60));
	};
	const went = (part: string) => calls.filter((c) => c.url.includes(part));

	await submit("/clear");
	assert.equal(went("/session/new").length, 1, `typing it starts a session; got ${calls.map((c) => c.url).join(", ")}`);
	assert.equal(went("/prompt").length, 0, "and is not delivered to the model as two words");

	// What to keep is the difference between a summary you can work from and one you undo by hand.
	await submit("/compact keep the API shapes");
	assert.deepEqual(went("/compact").pop()?.body, { instructions: "keep the API shapes" });
	// And it says what it did: "context compacted" alone is a line asking to be taken on faith.
	assert.match(dom.rendered(), /context compacted · 150k → 32k · \$0\.030/);
	// pi announces the compaction it was asked for as well, and the page used to answer it a second
	// time with a bare "context compacted" — over the top of a manual one that had just said it
	// failed. The event line is for the compaction nobody asked for.
	dom.source().onmessage({ data: JSON.stringify({ type: "compaction_end", reason: "manual", result: { tokensBefore: 150_000, estimatedTokensAfter: 32_000 } }) });
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(dom.rendered().match(/context compacted/g)?.length, 1, "said once");
	// The one that happens on its own is still announced — and truthfully when it did not happen.
	dom.source().onmessage({ data: JSON.stringify({ type: "compaction_end", reason: "threshold", result: null, aborted: false, errorMessage: "quota exceeded" }) });
	await new Promise((r) => setTimeout(r, 60));
	assert.match(dom.rendered(), /compaction failed: quota exceeded/, "an auto-compaction that failed does not report success");
	// A summary that came out at 312 tokens is 312, not "0k" — which reads as gone rather than small.
	dom.source().onmessage({ data: JSON.stringify({ type: "compaction_end", reason: "threshold", result: { tokensBefore: 11_000, estimatedTokensAfter: 312 } }) });
	await new Promise((r) => setTimeout(r, 60));
	assert.match(dom.rendered(), /11k → 312/);

	await submit("/resume");
	assert.equal(went("/sessions").length, 1, "the picker is the same one the button opens");
	assert.equal(doc.getElementById("sessdlg").open, true, "and it is on the screen");

	// The composer is still a composer: an ordinary message is not intercepted.
	await submit("what does this do?");
	assert.equal(went("/prompt").length, 1);
	g.fetch = realFetch;
	dom.dispose();
});

test("the session you are in is not offered as one to go back to", { timeout: 20_000 }, async () => {
	// pi answers a switch to the file it is already writing by starting an empty session pointed at
	// that file — two sessions with one file between them. The row is shown, because leaving it out
	// makes the list look like it lost one, and it is not a thing to click.
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	const realFetch = g.fetch;
	const sessions = [
		{ file: "/s/now.jsonl", id: "a", first: "the one open now", messages: 4, mtimeMs: Date.now(), current: true },
		{ file: "/s/older.jsonl", id: "b", name: "yesterday's refactor", messages: 22, truncated: true, mtimeMs: Date.now() - 86_400_000, current: false },
	];
	const asked: unknown[] = [];
	g.fetch = async (url: unknown, opts: any) => {
		if (String(url).includes("/sessions")) return { json: async () => ({ sessions }) };
		if (String(url).includes("/session/switch")) { asked.push(JSON.parse(opts.body)); return { json: async () => ({ success: true, data: {} }) }; }
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	await doc.getElementById("resume").onclick();
	await new Promise((r) => setTimeout(r, 60));

	const rows = doc.getElementById("sessBody").children;
	assert.equal(rows.length, 2, "both are listed");
	assert.equal(rows[0].disabled, true, "the one you are in cannot be picked");
	assert.equal(typeof rows[1].onclick, "function");
	// A session is recognised by the conversation, not by a filename or a uuid.
	const shown = rows.map((r: any) => r.children.map((c: any) => c._text).join(" | ")).join("\n");
	assert.match(shown, /the one open now/);
	assert.match(shown, /yesterday's refactor/, "a name set on a session wins over its first message");
	assert.match(shown, /22\+ message\(s\)/, "and a count that was cut short says so");

	rows[1].onclick();
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(asked, [{ file: "/s/older.jsonl" }]);
	g.fetch = realFetch;
	dom.dispose();
});

test("the reload after clearing says what was asked for, not that something restarted", { timeout: 20_000 }, async () => {
	// Swapping the session reuses the reload a restarted server gets, which is the right machinery
	// and the wrong sentence: "the session restarted — the conversation above was reloaded" is said
	// over an empty feed to someone who just pressed clear and knows exactly what happened.
	const g = globalThis as any;
	const state: any = { ...STATE, epoch: "e1", seq: 0 };
	// One server, so one epoch: /state and /history agree, and the transcript the reload takes is
	// the new session's.
	const history: any = { messages: [], epoch: "e1", seq: 0 };
	const dom = stubDom(state, history);
	const realFetch = g.fetch;
	g.fetch = async (url: unknown, opts: any) => {
		if (String(url).includes("/session/new")) {
			state.epoch = history.epoch = "e2"; // the server swapped underneath: how the page finds out
			return { json: async () => ({ success: true, data: { cancelled: false } }) };
		}
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	g.document.getElementById("clear").onclick();
	await new Promise((r) => setTimeout(r, 60));
	await dom.poll();
	await new Promise((r) => setTimeout(r, 200));

	const shown = dom.rendered();
	assert.match(shown, /new session — the one you left is under resume/, `it says what happened; got:\n${shown.slice(-400)}`);
	assert.doesNotMatch(shown, /the session restarted/, "and not the sentence for an epoch nobody asked to change");
	g.fetch = realFetch;
	dom.dispose();
});

test("the new session announcing itself does not beat the page to the reason", { timeout: 20_000 }, async () => {
	// The race a stand-in cannot lose and a browser never won: pi starts talking the moment it
	// swaps, and those events carry the new epoch — so the reload is already under way when the
	// request that asked for it returns. Found by clicking the button in Chrome, where every clear
	// said "the session restarted" over an empty feed.
	const g = globalThis as any;
	const state: any = { ...STATE, epoch: "e1", seq: 0 };
	const history: any = { messages: [], epoch: "e1", seq: 0 };
	const dom = stubDom(state, history);
	const realFetch = g.fetch;
	g.fetch = async (url: unknown, opts: any) => {
		if (String(url).includes("/session/new")) {
			state.epoch = history.epoch = "e2";
			// The stream gets there first, which is the whole point.
			dom.source().onmessage({ data: JSON.stringify({ type: "entry_appended", seq: 1, epoch: "e2", entry: { type: "custom", customType: "pi_loops_snapshot", data: {} } }) });
			return { json: async () => ({ success: true, data: { cancelled: false } }) };
		}
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	g.document.getElementById("clear").onclick();
	await new Promise((r) => setTimeout(r, 300));

	const shown = dom.rendered();
	assert.match(shown, /new session — the one you left is under resume/, `it still says what happened; got:\n${shown.slice(-400)}`);
	assert.doesNotMatch(shown, /the session restarted/);
	g.fetch = realFetch;
	dom.dispose();
});

test("a completion answer in flight does not reopen a list the space just closed", { timeout: 20_000 }, async () => {
	// Typing "/compact keep the summary short" asks for completions on "/compact", closes the list
	// when the space arrives, and then the answer came back and put it back on the screen — so Enter
	// accepted "/compact" instead of sending the line. Every slash command that takes an argument
	// was reachable by mouse and not by typing. Found in Chrome, not by a unit test.
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const realFetch = g.fetch;
	g.fetch = async (url: unknown, opts: any) => {
		if (!String(url).includes("/complete")) return realFetch(url, opts);
		// The answer is slow, which is the only reason the bug was ever visible.
		return { json: () => new Promise((r) => setTimeout(() => r({ items: [{ value: "/compact", hint: "" }] }), 80)) };
	};

	const input = doc.getElementById("input");
	input.value = "/compact";
	input.selectionStart = 8;
	input.oninput();
	// The space, before that answer lands.
	input.value = "/compact ";
	input.selectionStart = 9;
	input.oninput();
	await new Promise((r) => setTimeout(r, 250));

	assert.equal(doc.getElementById("pop").style.display, "none", "the list stays closed");
	g.fetch = realFetch;
	dom.dispose();
});
