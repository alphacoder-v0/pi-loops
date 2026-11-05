import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { THINKING_LEVELS } from "../src/thinking.ts";

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
/** The conversation the page under test was served for: its routes are under /c/<this>/. */
const SESSION_UNDER_TEST = "test-session";

function pageScript(served: { token?: string; secret?: string } = {}): string {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const html = /const PAGE = String\.raw`([\s\S]*)`;\s*$/.exec(src)?.[1];
	assert.ok(html, "found the page in src/web.mjs");
	// The server substitutes these on the way out; the tests have to as well or the page is
	// running with placeholders where its own identity should be.
	return html
		.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</" + "script>"))
		.replace("__TOKEN__", served.token ?? "test-token")
		.replace("__DEVICE_SECRET__", served.secret ?? "")
		.replace("__SESSION__", SESSION_UNDER_TEST)
		.replace("__VERSION__", PAGE_UNDER_TEST);
}

interface StubElement {
	_text: string;
	children: StubElement[];
	[k: string]: unknown;
}

/** Just enough DOM for the page to run: what it touches, nothing more. */
function stubDom(state: unknown, history: unknown, session = new Map<string, string>(), answers: Record<string, unknown> = {}) {
	const made: StubElement[] = [];
	/** Every fetch the page made: the path, the headers, and the body it posted. */
	const calls: Array<{ url: string; body?: unknown; headers?: Record<string, string> }> = [];
	const detach = (c: any) => {
		const kids = c?._parent?.children;
		const at = kids?.indexOf(c) ?? -1;
		if (at >= 0) kids.splice(at, 1);
	};
	const el = (tag = "div"): any => {
		const e: any = {
			tag, children: [], _text: "", className: "", style: {}, dataset: {}, hidden: false, options: [], value: "", _details: [],
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
			set innerHTML(v: unknown) {
				e._html = String(v); e.children = []; e._text = "";
				// The sidebar builds itself as one HTML string, so its <details> cards exist nowhere
				// but in that string. The open-state test needs the real thing: each data-keyed details
				// becomes a stub element the page can read `open` off and write it back on.
				e._details = [];
				const re = /<details\b[^>]*\bdata-key="([^"]*)"[^>]*>/g;
				let m;
				while ((m = re.exec(e._html))) {
					const d = el("details");
					d.dataset.key = m[1];
					e._details.push(d);
				}
				// A loop row's slot and a waiting rule's line: the page fills them with textContent once the
				// panel is assigned, so they have to exist as elements to be filled.
				e._slots = [];
				const slots = /<span\b[^>]*\bdata-(loopx|rulelook)="([^"]*)"[^>]*>/g;
				while ((m = slots.exec(e._html))) {
					const span = el("span");
					span.dataset[m[1]] = m[2];
					e._slots.push(span);
				}
				// A picture the session made: the page gives it an address once a key is minted for it.
				e._files = [];
				const files = /<img\b[^>]*\bdata-file="([^"]*)"[^>]*>/g;
				while ((m = files.exec(e._html))) {
					const img = el("img");
					img.dataset.file = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
					e._files.push(img);
				}
				// An HTML block the model wrote gets a preview button, appended to its <pre>.
				e._pres = [];
				const pres = /<pre class="code" data-lang="html"><code>([\s\S]*?)<\/code><\/pre>/g;
				while ((m = pres.exec(e._html))) {
					const pre = el("pre");
					pre.textContent = m[1];
					e._pres.push(pre);
				}
			},
			get innerHTML() { return e._html ?? ""; },
			querySelector: () => el(),
			querySelectorAll: (sel: string) => (sel.includes("details[data-key]") || sel === "[data-key]" ? e._details : sel === "[data-loopx]" || sel === "[data-rulelook]" ? (e._slots ?? []).filter((x: any) => sel.slice(6, -1) in x.dataset) : sel === "img[data-file]" ? (e._files ?? []) : sel === 'pre.code[data-lang="html"]' ? (e._pres ?? []) : []),
			addEventListener(type: string, fn: any) { (e._on ??= {})[type] = fn; },
			removeAttribute() {},
			// What a browser does with Enter in a form, and the page's only way to send a line
			// without a click: it asks the form to submit itself.
			requestSubmit() {
				return e.onsubmit?.({ preventDefault() {} });
			},
			removeEventListener() {}, focus() {}, click() {}, setAttribute() {},
			// A browser sets `open` on both; the page reads it back to decide whether a click landed
			// on a dialog that is actually on the screen.
			showModal() { e.open = true; },
			// The page scrolls a card to the top of the box once it is drawn; the stub keeps the ask.
			scrollIntoView(o: unknown) { e._scrolledTo = o; },
			// A browser fires "close" when an open dialog is closed by script, as it does for a click.
			close() {
				const was = e.open;
				e.open = false;
				if (was) e._on?.close?.();
			},
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
	for (const id of ["ask", "detail", "pairdlg", "menu", "sessdlg", "watch"]) {
		const d = el("dialog");
		d.id = id;
		byId.set(id, d);
	}
	const g = globalThis as any;
	g.document = {
		getElementById: (id: string) => {
			if (!byId.has(id)) byId.set(id, el());
			return byId.get(id);
		},
		createElement: (t: string) => el(t),
		visibilityState: "visible",
		_on: {} as Record<string, (e?: unknown) => void>,
		addEventListener(type: string, fn: (e?: unknown) => void) { (this as any)._on[type] = fn; },
		// The theme is written on the root element, and the panel state is read back from storage.
		documentElement: el("html"),
		body: el("body"),
		// The page reaches for groups of elements too — every dialog, the composer's buttons — and
		// gets back something it iterates. An empty list is a fine answer; not being a function is not.
		querySelectorAll: (sel: string) => (sel === "dialog" ? [byId.get("ask"), byId.get("detail"), byId.get("pairdlg"), byId.get("menu"), byId.get("sessdlg"), byId.get("watch")].filter(Boolean) : []),
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
	// A separate store, because what the composer holds belongs to one tab: a test that reloads the
	// page hands the same map back in, and a test that opens a second tab does not.
	g.sessionStorage = {
		getItem: (k: string) => session.get(k) ?? null,
		setItem: (k: string, v: string) => void session.set(k, v),
		removeItem: (k: string) => void session.delete(k),
	};
	g.matchMedia = () => ({ matches: false, addEventListener() {} });
	g.Option = function (t: string, v: string) {
		const o = el("option");
		o.textContent = t;
		o.value = v;
		return o;
	};
	g.fetch = async (url: unknown, opts?: { body?: string; headers?: Record<string, string> }) => {
		calls.push({ url: String(url), body: opts?.body === undefined ? undefined : JSON.parse(opts.body), headers: opts?.headers });
		const answered = Object.keys(answers).find((p) => String(url).includes(p));
		// An answer may carry its own status: `{ __status: 409, __body: {...} }`.
		const given = answered !== undefined ? (answers[answered] as any) : undefined;
		const withStatus = given && typeof given === "object" && "__status" in given;
		return {
			status: withStatus ? given.__status : 200,
			json: async () =>
				answered !== undefined
					? withStatus ? given.__body : answers[answered]
					: String(url).includes("/state")
						? state
						: String(url).includes("/history")
							? history
							: String(url).includes("/pair")
								? { success: true, code: "123456", addresses: [] }
								: String(url).includes("/key")
									? { key: "test-key" }
									: { success: true },
		};
	};
	// The page asks where it is, to decide which address a phone should be pointed at.
	g.location = { origin: "https://box.tailnet.ts.net", port: "", pathname: `/c/${SESSION_UNDER_TEST}/` };
	/** Every address the page put in the location bar without loading it. */
	const replaced: string[] = [];
	g.history = { replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url) };
	let source: any;
	g.EventSource = class {
		constructor(url: string) {
			source = this;
			(this as any).url = url;
		}
		close() {
			(this as any).closed = true;
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
		calls,
		// Both, because the feed writes text nodes and the sidebar writes markup.
		rendered: () => made.map((m) => `${m._text ?? ""}\n${(m as any)._html ?? ""}`).join("\n"),
		source: () => source,
		replaced,
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

/**
 * The browser rules the composer's height depends on. A box sized to its content measures that
 * content; a box with a height of its own measures itself — so `scrollHeight` assigned straight back
 * leaves a box that can only ever grow. And `scrollHeight` leaves the border out, which a
 * border-box has to add back or the text overflows by exactly the border. Both are the difference
 * between a box that fits what is in it and one that shows a scrollbar over it.
 */
function modelComposerHeight(input: any, lineHeight = 20, border = 2) {
	let height: number | "auto" = "auto";
	const boxHeight = () => {
		const content = lineHeight * String(input.value).split("\n").length;
		return height === "auto" ? content : Math.max(content, height);
	};
	Object.defineProperty(input.style, "height", {
		get: () => (height === "auto" ? "" : height + "px"),
		set: (v: string) => { height = v === "auto" ? "auto" : parseFloat(v); },
	});
	Object.defineProperty(input, "scrollHeight", { get: boxHeight });
	Object.defineProperty(input, "clientHeight", { get: boxHeight });
	Object.defineProperty(input, "offsetHeight", { get: () => boxHeight() + border });
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

test("a page moved to another conversation asks for that one's routes, at that one's address", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.ok(dom.source().url.startsWith(`/c/${SESSION_UNDER_TEST}/events`), `the stream is the conversation's own; got ${dom.source().url}`);
	assert.ok(dom.calls.some((c) => c.url === `/c/${SESSION_UNDER_TEST}/state`), "and so is its state");

	dom.source().onmessage({ data: JSON.stringify({ type: "page_moved", sessionId: "01b0-moved", seq: 1, epoch: "e1" }) });
	assert.deepEqual(dom.replaced, ["/c/01b0-moved/"], "the address in the location bar follows pi");
	const before = dom.calls.length;
	await dom.poll();
	const after = dom.calls.slice(before).map((c) => c.url);
	assert.ok(after.includes("/c/01b0-moved/state"), `the next request goes to the new conversation; got ${after.join(", ")}`);
	assert.ok(!after.some((u) => u.startsWith(`/c/${SESSION_UNDER_TEST}/`)), "and none to the old one");
	dom.dispose();
});

test("the page takes the open key and the pairing code out of the address it was loaded at", { timeout: 20_000 }, async () => {
	// Both are spent by the load that carried them, so a bookmark or a reload of that address is a
	// dead credential at best, and the history list keeps it for anyone who looks.
	const dom = stubDom(STATE, { messages: [] });
	(globalThis as any).location = { ...(globalThis as any).location, search: "?open=k1&pair=123456" };
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.deepEqual(dom.replaced, [`/c/${SESSION_UNDER_TEST}/`]);
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

test("a capped result counts characters, not the units a string is counted in", { timeout: 20_000 }, async () => {
	/**
	 * The one helper behind a tool result, an extension's message and pi's dying words counted and
	 * cut in UTF-16 code units, so an astral character was two of them and a cut at 8000 could land
	 * between the two halves of one — which a browser draws as a replacement character where the
	 * output should have carried on. `capChars` in src/protocol.ts and `previewText` in
	 * src/session-head.ts have always counted characters, and docs/web-ui-parity.md promises the
	 * same number from this one.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	const rocket = "\u{1F680}"; // one character, two code units
	// 9000 characters, 17999 code units — over the 8000 cap counted either way, so what is checked
	// is where the cut landed and what it said, not whether there was one.
	send({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "a" + rocket.repeat(8999) }] } });

	const cut = dom.made.filter((el: any) => el.tag === "pre" && String(el._text).includes(" chars)")).map((el: any) => String(el._text))[0] ?? "";
	assert.equal(cut.length, "a".length + rocket.repeat(7999).length + "\n… (9000 chars)".length, `cut at 8000 characters, not 8000 code units; got:\n${cut.slice(-40)}`);
	// The count used to be 17999: the code units, not the characters the document promises.
	assert.match(cut, /\(9000 chars\)$/, `and says how many characters there were; got: ${JSON.stringify(cut.slice(-30))}`);
	// A string cut between the halves of a character is drawn as a replacement glyph, and copied out
	// with the rest of it.
	assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no cut left half of a character behind");
	dom.dispose();
});

test("the thinking-level picker offers every level pi knows, not a list of its own", { timeout: 20_000 }, async () => {
	/**
	 * The levels a model has are asked of pi per model; when that list is unknown — the RPC
	 * failed, or the model reports none — the picker falls back to a list. That list has to be
	 * the whole menu pi accepts (THINKING_LEVELS), not a copy kept by hand: the copy in src/web.mjs
	 * drifted and lost `max`, which pi-loops accepts, and no test named for it. This pins it.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	// The picker is the one element that remembers the level list it was drawn from.
	const picker = dom.made.find((e: any) => e.dataset && typeof e.dataset.levels === "string");
	assert.ok(picker, "the thinking picker was drawn");
	const offered = (picker.children as any[]).map((c) => c.value);
	assert.deepEqual(offered, [...THINKING_LEVELS], "the fallback offers every level pi knows, in the order pi names them");
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

test("a job's whole prompt is one click away, and stays open across a redraw", { timeout: 20_000 }, async () => {
	// The prompt used to be sliced to 90 characters with no way to see the rest. The card now holds
	// the whole of it, and the open/closed choice must survive the eight-second redraw of the panel.
	const prompt = "THE_WHOLE_PROMPT_" + "z".repeat(300) + "_END";
	const automation = {
		installed: true, dir: "/loops", inboxNew: 0, rules: [],
		jobs: [{ id: "cron-long", name: "long-prompt", schedule: "every 5m", enabled: true, prompt, runCount: 1, cwd: "/work/api" }],
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const box = (globalThis as any).document.getElementById("auto");
	assert.ok(dom.rendered().includes(prompt), "the whole prompt is on the page, not a 90-character slice");

	box.querySelectorAll("details[data-key]")[0].open = true;
	await dom.poll(); // the eight-second timer's refresh, which rebuilds the panel
	assert.equal(box.querySelectorAll("details[data-key]")[0].open, true, "the card is still open after the panel redraws");
	dom.dispose();
});

test("a job's skipped overlaps are shown when there are any, and not when there are none", { timeout: 20_000 }, async () => {
	// The terminal side panel and `/cron` both print `skipped overlaps N`; this card is the browser's
	// only place for a job's own numbers, and it did not. The count is the last evidence a loop is
	// losing cadence — the `lastError` a skip writes is cleared by the next run, and this is not.
	const automation = {
		installed: true, dir: "/loops", inboxNew: 0, rules: [],
		jobs: [
			{ id: "cron-behind", name: "behind", schedule: "every 5m", enabled: true, prompt: "p", runCount: 9, cwd: "/work/api", skippedOverlap: 3 },
			{ id: "cron-caught-up", name: "caught-up", schedule: "every 5m", enabled: true, prompt: "p", runCount: 9, cwd: "/work/api" },
		],
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const shown = dom.rendered();
	assert.match(shown, /skipped overlaps 3/, `the count is on the card; got:\n${shown.slice(0, 800)}`);
	assert.equal((shown.match(/skipped overlaps/g) || []).length, 1, "and a job with none stays silent, like both terminal surfaces");
	dom.dispose();
});

test("a rule's condition and action are shown in full", { timeout: 20_000 }, async () => {
	// A rule's condition and action used to be sliced to 80 characters each; a condition you cannot
	// read in full is one you cannot judge, so the card holds both whole now.
	const condition = "WHEN_" + "c".repeat(200) + "_END";
	const action = "THEN_" + "a".repeat(200) + "_DONE";
	const automation = {
		installed: true, dir: "/loops", inboxNew: 0, jobs: [],
		rules: [{ id: "rule-a", condition, action, enabled: true, fireOnce: false }],
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const shown = dom.rendered();
	assert.ok(shown.includes(condition), "the whole condition is on the page");
	assert.ok(shown.includes(action), "and the whole action");
	dom.dispose();
});

test("a job with a last error says so before it is opened", { timeout: 20_000 }, async () => {
	// The error line moved into the open body when the card became a <details>, which made a closed
	// card go quiet about a failing job. A one-line hint in the summary puts that back.
	const automation = {
		installed: true, dir: "/loops", inboxNew: 0, rules: [],
		jobs: [{ id: "cron-err", name: "failing", schedule: "every 5m", enabled: true, prompt: "p", runCount: 1, lastError: "boom" }],
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const box = (globalThis as any).document.getElementById("auto");
	assert.match(box.innerHTML, /peek failing">boom<\/span>/, `the error hint is in the summary; got:\n${box.innerHTML.slice(0, 800)}`);
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

test("an update while you are reading back does not yank the page, and the pill is the way back", { timeout: 20_000 }, async () => {
	/**
	 * A reply that lands while you are scrolled up must not move the page under you — a transcript
	 * you were reading is the one thing this page exists to show, and the terminal never did. The
	 * price of not following is silence, so the pill says something arrived and takes you down when
	 * you ask. The stub has no layout, so the feed's geometry — all the guard reads — is given to it,
	 * the way modelComposerHeight gives the composer its height.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;
	const feed = doc.getElementById("feed");
	const newer = doc.getElementById("newer");
	feed.scrollHeight = 2000;
	feed.clientHeight = 600;
	const land = (text: string) => {
		dom.source().onmessage({ data: JSON.stringify({ type: "message_start" }) });
		dom.source().onmessage({ data: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } }) });
	};

	// At the bottom an update follows the newest, which is what makes the guard a guard rather than
	// a page that never moves.
	feed.scrollTop = 1400;
	feed._on.scroll();
	assert.equal(newer.hidden, true, "at the bottom there is nothing to go back to");
	land("first");
	assert.equal(feed.scrollTop, 2000, "and the newest is followed");

	// Scrolled up, the same update leaves the page where it is — and says that it happened.
	feed.scrollTop = 100;
	feed._on.scroll();
	land("second");
	assert.equal(feed.scrollTop, 100, "the page did not move under the reader");
	assert.equal(newer.hidden, false, "and the pill says something is waiting");

	// The pill is the way back, and puts the reader at the newest.
	newer.onclick();
	assert.equal(feed.scrollTop, 2000, "the pill goes to the newest");
	assert.equal(newer.hidden, true, "and then it is out of the way");
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

test("prompt history recalls what was sent, and steps aside on a middle line", { timeout: 20_000 }, async () => {
	// The parity list promises ArrowUp and ArrowDown recall what was sent, while the caret is on the
	// first or last line, so the same keys still move through a multi-line draft. Nothing pinned it:
	// the whole block could be deleted with the suite still green.
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const input = doc.getElementById("input");

	// Two prompts go out, oldest first.
	for (const text of ["first thing", "second thing"]) {
		input.value = text;
		input.selectionStart = text.length;
		input.oninput();
		doc.getElementById("composer").requestSubmit();
		await new Promise((r) => setTimeout(r, 40));
	}

	// A draft that is not empty must come back when you walk forward past the newest prompt.
	input.value = "half-written";
	input.selectionStart = input.value.length;
	input.onkeydown({ key: "ArrowUp", preventDefault() {} });
	assert.equal(input.value, "second thing", "ArrowUp brings back the most recent prompt");
	input.onkeydown({ key: "ArrowUp", preventDefault() {} });
	assert.equal(input.value, "first thing", "and again the one before it");
	input.onkeydown({ key: "ArrowUp", preventDefault() {} });
	assert.equal(input.value, "first thing", "and stops at the oldest");

	input.onkeydown({ key: "ArrowDown", preventDefault() {} });
	assert.equal(input.value, "second thing", "ArrowDown walks forward again");
	input.onkeydown({ key: "ArrowDown", preventDefault() {} });
	assert.equal(input.value, "half-written", "and past the newest restores the draft");

	// On a middle line the arrows belong to the caret: recalling there would make a multi-line
	// prompt impossible to edit with the keyboard.
	input.value = "one\ntwo\nthree";
	input.selectionStart = 5; // inside "two", line two
	input.onkeydown({ key: "ArrowUp", preventDefault() {} });
	assert.equal(input.value, "one\ntwo\nthree", "ArrowUp on a middle line leaves the draft alone");
	input.onkeydown({ key: "ArrowDown", preventDefault() {} });
	assert.equal(input.value, "one\ntwo\nthree", "and so does ArrowDown");

	// On the first line there is nowhere for the caret to go, so the same key recalls history and
	// remembers the whole draft — the half a refactor is most likely to break.
	input.selectionStart = 2; // still on the first line
	input.onkeydown({ key: "ArrowUp", preventDefault() {} });
	assert.equal(input.value, "second thing", "ArrowUp on the first line recalls history");
	input.onkeydown({ key: "ArrowDown", preventDefault() {} });
	assert.equal(input.value, "one\ntwo\nthree", "and coming back restores the whole draft");

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

test("a question pi times out closes itself, says it was refused, and a late approve is not reported", { timeout: 20_000 }, async () => {
	// pi refuses a dialog with a `timeout` on its own when it elapses and tells the page nothing. The
	// dialog stayed open, the next question waited behind it, and "approve" printed "approved" for an
	// answer pi had already dropped.
	const shown: any = { ...STATE, pendingAsks: [] };
	const dom = stubDom(shown, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;
	const ask = doc.getElementById("ask");
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const answers = () => dom.calls.filter((c) => c.url.includes("/ui-response")).map((c) => c.body);

	send({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Allow rm?", message: "rm -rf /tmp/x", timeout: 150 });
	assert.equal(ask.open, true, "the question is on the screen");
	send({ type: "extension_ui_request", id: "q2", method: "confirm", title: "Allow push?", message: "git push", timeout: 60_000 });
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(ask.open, false, "it closes when its time is up");
	assert.match(dom.rendered(), /Allow rm\? → timed out with no answer: refused/);
	assert.deepEqual(answers(), [], "nothing is posted for a question pi has already answered");
	// The next question was asked meanwhile; the server still holds it, and the poll draws it.
	shown.pendingAsks = [{ type: "extension_ui_request", id: "q2", method: "confirm", title: "Allow push?", message: "git push", timeout: 59_000 }];
	await dom.poll();
	assert.equal(ask.open, true, "the next question gets the dialog");
	assert.equal(doc.getElementById("askTitle").textContent, "Allow push?");

	// A tab in the background has its timers held back: the time can be up before the timer runs.
	const realNow = Date.now;
	Date.now = () => realNow() + 120_000;
	try {
		ask.returnValue = "ok";
		ask._on.close();
	} finally {
		Date.now = realNow;
	}
	assert.deepEqual(answers(), [], "an approve after the time is up is not sent");
	assert.doesNotMatch(dom.rendered(), /approved/, "and not reported as approved");
	assert.match(dom.rendered(), /Allow push\? → timed out with no answer: refused/);
	dom.dispose();
});

test("Enter in a confirmation dialog hits cancel, not approve", () => {
	/**
	 * A `<form method="dialog">` submits on Enter with whichever button holds the focus, and that is
	 * the whole of what stands between a person and a dangerous command waved through with one key:
	 * the focus starts on cancel, and for `menu button` to select it, cancel is written first. A stub
	 * cannot see either — `querySelector` returns a detached element and `focus()` does nothing — so
	 * this is asserted on the source, the way the soft-keyboard rule below is.
	 */
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(src, /dlg\.querySelector\("menu button"\)\?\.focus\(\)/, "the dialog focuses the first menu button");

	const at = src.indexOf('<dialog id="ask"');
	assert.notEqual(at, -1, "found the ask dialog in the page");
	const ask = src.slice(at, src.indexOf("</dialog>", at));
	const cancel = ask.indexOf('value="cancel"');
	assert.notEqual(cancel, -1, `the ask dialog has a cancel button; got:\n${ask}`);
	assert.ok(cancel < ask.indexOf('value="ok"'), `cancel is written before approve, so the first menu button is cancel; got:\n${ask}`);
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

test("an MCP server's last error is shown whole, not cut at 120 characters", { timeout: 20_000 }, async () => {
	// The Runtime box sliced the field to 120 UTF-16 units with no ellipsis. The snapshot the page is
	// handed already carries it redacted, one line, and capped at 160 with `…` (src/pi-loops.ts:607,
	// src/redact.ts:58), so the slice only deleted the ellipsis and the tail — a truncated error that
	// read as a complete one, which is what docs/web-ui-parity.md:152 rules out for a last error. A
	// server that gave up prints `reconnect attempts exhausted (3); last error: ` before the real
	// error even starts.
	const long = "reconnect attempts exhausted (3); last error: " + "x".repeat(160) + "…";
	const runtime = { ...STATE.runtime, mcp: [{ name: "hub", state: "down", kind: "stdio", tools: [], lastError: long }] };
	const dom = stubDom({ ...STATE, runtime }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const panel = (globalThis as any).document.getElementById("runtime");
	assert.ok(panel.innerHTML.includes(long), `the whole error is in the Runtime box, ellipsis and all; got:\n${panel.innerHTML}`);
	dom.dispose();
});

test("the host line follows the host file the server reads, not the snapshot the session last wrote", { timeout: 20_000 }, async () => {
	// The snapshot is written when something changes, at most once a minute, and the host coming up
	// is a change pi-loops may not write for a while. The panel said "pi-loops is not running" beside a running process
	// running beside it.
	const runtime = { ...STATE.runtime, scheduler: { running: true, host: { running: false } }, counts: { jobs: 1, jobsEnabled: 1, rules: 0, rulesEnabled: 0 } };
	const dom = stubDom({ ...STATE, runtime, automation: { ...STATE.automation, hostPid: 4242 } }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const panel = (globalThis as any).document.getElementById("runtime");
	assert.match(panel.innerHTML, /pi-loops running in the background \(pid 4242\)/, `got:\n${panel.innerHTML}`);
	dom.dispose();

	const down = stubDom({ ...STATE, runtime: { ...runtime, scheduler: { running: true, host: { running: true, pid: 7 } } }, automation: { ...STATE.automation, hostPid: undefined, paused: "pi-loops is stopped — /pi-loops start" } }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.match((globalThis as any).document.getElementById("runtime").innerHTML, /loops and checks are paused: pi-loops is stopped/, "and a host that went away is gone from the panel too, with the reason");
	assert.doesNotMatch((globalThis as any).document.getElementById("runtime").innerHTML, /\/pi-loops start — \/pi-loops start/, "the command is said once");
	down.dispose();
});

test("the panel shows the project's last rule check and last loop run, which run in the background now", { timeout: 20_000 }, async () => {
	// The "last check" line read only this session's entries, which a check in the background never
	// writes: it was simply gone. The server reads both from the stores now.
	const automation = { ...STATE.automation, lastCheck: { state: "completed", at: "2026-10-30T10:00:00Z" }, lastRun: { label: "nightly", ok: false, findings: 0, at: "2026-10-30T10:05:00Z" } };
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const html = (globalThis as any).document.getElementById("auto").innerHTML;
	assert.match(html, /last check: completed/, `got:\n${html}`);
	assert.match(html, /last run: nightly · failed · 0 finding\(s\)/);
	dom.dispose();
	// A run a person stopped is not a failure, here as everywhere else.
	const stopped = stubDom({ ...STATE, automation: { ...automation, lastRun: { ...automation.lastRun, stopped: true } } }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.match((globalThis as any).document.getElementById("auto").innerHTML, /last run: nightly · stopped · 0 finding\(s\)/);
	stopped.dispose();
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
	assert.match(doc.getElementById("pairWhere").textContent, /set \[page\] host = "0\.0\.0\.0" in config\.toml and run {2}pi-loops restart\./, "the address is set in config.toml now");
	assert.doesNotMatch(doc.getElementById("pairWhere").textContent, /--host/, "pi-loops has no --host flag to start with");
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

/** The page's stylesheet, and the token block in it (between its markers). */
function pageStyle(): { css: string; tokens: string; rest: string } {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const html = /const PAGE = String\.raw`([\s\S]*)`;\s*$/.exec(src)?.[1] ?? "";
	const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
	const from = css.indexOf("/* tokens: */");
	const to = css.indexOf("/* :tokens */");
	assert.ok(from >= 0 && to > from, "the token block is marked");
	return { css, tokens: css.slice(from, to), rest: css.slice(0, from) + css.slice(to) };
}

test("the stylesheet carries Inspire's paper and amber in both schemes, and no colour outside its tokens", () => {
	const { tokens, rest } = pageStyle();
	const block = (start: string) => {
		const at = tokens.indexOf(start);
		assert.ok(at >= 0, `a block starting ${start}`);
		return tokens.slice(at, tokens.indexOf("}", at));
	};
	const light = block(":root{");
	for (const [name, value] of [["--bg", "#f2f2f7"], ["--panel", "#ffffff"], ["--panel2", "#efeff4"], ["--brand", "#9a5500"], ["--brand-ink", "#ffffff"], ["--fg", "#111111"]]) assert.ok(light.includes(`${name}:${value};`), `light ${name} is ${value}`);
	for (const dark of [block("html:not([data-theme=light]){"), block("html[data-theme=dark]{")]) {
		for (const [name, value] of [["--bg", "#000000"], ["--panel", "#1c1c1e"], ["--panel2", "#2c2c2e"], ["--brand", "#ffb340"], ["--brand-ink", "#1c1200"], ["--fg", "#f2f2f7"]]) assert.ok(dark.includes(`${name}:${value};`), `dark ${name} is ${value}`);
	}
	// A colour written into a rule is a colour that does not change with the scheme. Read off the
	// declarations, not the selectors: #feed is an id, and spelled in hex digits.
	const stray: string[] = [];
	for (const rule of rest.split("}")) {
		const open = rule.lastIndexOf("{");
		if (open < 0) continue;
		const selector = rule.slice(0, open).trim();
		const declarations = rule.slice(open + 1);
		// A QR code is black on white in either scheme: a scanner needs it.
		if (/#[0-9a-fA-F]{3,8}\b/.test(declarations) && !selector.endsWith(".qr svg")) stray.push(`${selector}{${declarations.trim()}}`);
	}
	assert.deepEqual(stray, [], "no colour outside the tokens");
	assert.doesNotMatch(rest, /--accent/, "the old accent is split: amber to act, a state colour for a dot");
	assert.match(rest, /:focus-visible\{outline:2px solid var\(--brand\)/, "focus is shown, in amber");
	assert.doesNotMatch(rest, /outline:none/, "and no rule hides it");
	assert.match(rest, /button\.primary\{background:var\(--brand\);[^}]*color:var\(--brand-ink\)/, "the primary button is amber");
	assert.match(rest, /#stale\{[^}]*color:var\(--brand-ink\)/, "the stale banner's text is the ink for amber, which white on light amber is not");
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.doesNotMatch(src, /style="color:#/, "a state colour in the panel is a class, not an inline colour");
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

test("a run of tool calls is one row, and the reply shares it", { timeout: 20_000 }, async () => {
	/**
	 * A turn that reads four files and runs two commands used to spend six rows of the conversation
	 * saying so, and the conversation is the thing being read. Consecutive calls collect; a reply
	 * does not cut the run — it shares the row, and the next call joins it.
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

	// The reply shares the row: its label joins the summary, and the next call joins the run.
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "and here is what I found" } });
	const tag = summary.children.find((c: any) => String(c.className) === "tag");
	assert.equal(tag?._text, "assistant", "the reply's label is in the run's row");
	send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 4, toolCallId: "c9", toolName: "write" } });
	assert.equal(groups().length, 1, "a call after the reply joins the same row");
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
	assert.match(html, /<img data-file="out\/chart\.png" alt="chart">/, "the picture is a picture");
	assert.match(html, /<a data-file="out\/report\.html" href="#" class="file">/, "the file is something to open");
	// And the token is not in either of them: a page the model wrote can read its own address.
	assert.doesNotMatch(html, /token=/, "no credential in a URL a preview can read");
	assert.match(html, /<a href="https:\/\/example\.com\/x"/, "and a web link is still a web link");
	assert.doesNotMatch(html, /href="javascript:/, "while a scheme of its own is not made into one");

	// The picture's address is made once a key is minted for that one path; the key is spent by the load.
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(dom.calls.some((c) => c.url === "/c/test-session/key" && JSON.stringify(c.body) === JSON.stringify({ for: "file", path: "out/chart.png" })), "a key for out/chart.png");
	const img = dom.made.find((m: any) => m.tag === "img" && m.dataset.file === "out/chart.png") as any;
	assert.equal(img?.src, "/c/test-session/file?path=out%2Fchart.png&key=test-key", "and the picture is fetched with it");

	// A file link mints its key when it is clicked, and opens with it.
	const g = globalThis as any;
	const opened: string[] = [];
	g.open = (u: string) => void opened.push(u);
	const link = { dataset: { file: "out/report.html" } };
	let prevented = false;
	g.document.getElementById("feed")._on.click({ target: { closest: (sel: string) => (sel === "a[data-file]" ? link : null) }, preventDefault: () => { prevented = true; } });
	await new Promise((r) => setTimeout(r, 50));
	assert.ok(prevented, "the link has no address of its own to follow");
	assert.deepEqual(opened, ["/c/test-session/file?path=out%2Freport.html&key=test-key"], "it opens with a key for that file");
	delete g.open;
	dom.dispose();
});

test("a page served without the token trades the device secret for it, and a first visit keeps the secret", { timeout: 20_000 }, async () => {
	// A reload: no token and no secret in the page, the secret this origin kept, and /token answering.
	const dom = stubDom(STATE, { messages: [] }, new Map(), { "/token": { token: "traded-token" } });
	(globalThis as any).localStorage.setItem("pi-loops-device", "s".repeat(64));
	await new Function(pageScript({ token: "", secret: "" }))();
	await new Promise((r) => setTimeout(r, 400));
	const trade = dom.calls.find((c) => c.url === "/c/test-session/token");
	assert.ok(trade, "the page asked for the token");
	assert.equal(trade?.headers?.["x-pi-web-device-secret"], "s".repeat(64), "with the secret it kept");
	const state = dom.calls.find((c) => c.url === "/c/test-session/state");
	assert.equal(state?.headers?.["x-pi-web-token"], "traded-token", "and every request after carries the token it got");
	assert.ok(dom.calls.indexOf(trade as any) < dom.calls.indexOf(state as any), "and none went before it");
	dom.dispose();

	// A first visit: the token is in the page, and the secret it was handed is kept for next time.
	const first = stubDom(STATE, { messages: [] });
	await new Function(pageScript({ secret: "e".repeat(64) }))();
	await new Promise((r) => setTimeout(r, 400));
	assert.equal((globalThis as any).localStorage.getItem("pi-loops-device"), "e".repeat(64), "the secret is kept");
	assert.equal(first.calls.some((c) => c.url.endsWith("/token")), false, "and nothing is traded");
	first.dispose();
});

test("the event stream opens with a key minted for it, and a refused stream starts again with a new one", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.ok(dom.calls.some((c) => c.url === "/c/test-session/key" && JSON.stringify(c.body) === JSON.stringify({ for: "events" })), "a key for the stream");
	const first = dom.source();
	assert.equal(first.url, "/c/test-session/events?key=test-key", "and the stream carries it");
	first.readyState = 0;
	first.onerror();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(dom.source(), first, "a stream the browser is still retrying is left to it");
	first.readyState = 2;
	first.onerror();
	await new Promise((r) => setTimeout(r, 3300));
	assert.notEqual(dom.source(), first, "one it gave up on is opened again");
	assert.equal(dom.calls.filter((c) => c.url === "/c/test-session/key").length, 2, "with a key of its own");
	dom.dispose();
});

test("a preview opens with a key minted for it", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] }, new Map(), { "/preview": { success: true, id: "p1" } });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const reply = ["```html", "<p>hi</p>", "```"].join("\n");
	dom.source().onmessage({ data: JSON.stringify({ type: "message_start" }) });
	dom.source().onmessage({ data: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } }) });
	dom.source().onmessage({ data: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }] } }) });
	const pre = dom.made.find((m: any) => m.tag === "pre" && m.children.some((c: any) => c.className === "preview")) as any;
	assert.ok(pre, "the block has a preview button");
	const g = globalThis as any;
	const opened: string[] = [];
	g.open = (u: string) => void opened.push(u);
	await pre.children.find((c: any) => c.className === "preview").onclick();
	assert.ok(dom.calls.some((c) => c.url === "/c/test-session/key" && JSON.stringify(c.body) === JSON.stringify({ for: "preview", path: "p1" })), "a key for that preview");
	assert.deepEqual(opened, ["/preview/p1?key=test-key"], "and the preview opens with it");
	delete g.open;
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

	// The answer shares the row: its label and copy button sit in the summary, so "ASSISTANT" and
	// the step line are one line, not two — and it does not cut the stretch; the next step joins it.
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 4, delta: "here is the answer" } });
	assert.equal(summary.children.find((c: any) => String(c.className) === "tag")?._text, "assistant", "which says who is answering");
	assert.ok(summary.children.some((c: any) => typeof c.onclick === "function"), "and its copy button is there too");
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 5, delta: "more" } });
	assert.equal(work().length, 1, "a step after the answer joins the same row");

	// One button for all of them, remembered.
	doc.getElementById("expand").onclick();
	assert.match(doc.getElementById("expand").textContent, /▾/, "the button says what it will do next");
	dom.dispose();
});

test("a reply without work keeps its own label row", { timeout: 20_000 }, async () => {
	/**
	 * Sharing the row is only where there is a row to share: a turn that is nothing but a reply
	 * has no work, so its label and copy button stay a row of their own.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "just a reply" } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "just a reply" }] } });

	assert.equal(dom.made.filter((el: any) => String(el.className) === "row work").length, 0, "no work row was made for it");
	const roleRows = dom.made.filter((el: any) => String(el.className) === "row " && el.children.some((c: any) => String(c.className) === "role"));
	assert.equal(roleRows.length, 1, "the label row is still there on its own");
	dom.dispose();
});

test("the work row's live line is cut in characters, not the units a string is counted in", { timeout: 20_000 }, async () => {
	/**
	 * The live line says what is happening while it happens, and every other cut in the page counts
	 * characters (docs/web-ui-parity.md, the line on capped tool results). This one used `String.slice`, which counts UTF-16
	 * code units: `"a" + "🚀".repeat(120) + "done"` is 125 characters and 245 code units, so the
	 * preview kept 45 characters of thought and ended on the high half of an emoji, which a browser
	 * draws as a replacement glyph where the line should have carried on.
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });

	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "a" + "🚀".repeat(120) + "done" } });

	const peek = dom.made.find((el: any) => String(el.className) === "peek" && String(el._text).startsWith(" · a"));
	assert.ok(peek, `the thinking preview is on the row; got ${JSON.stringify(dom.made.map((el: any) => String(el._text)).filter(Boolean).slice(-5))}`);
	const thought = String((peek as any)._text).replace(/^ · /, "");
	assert.equal(Array.from(thought).length, 91, `90 characters of the thought and the ellipsis, not the 45 code units kept; got ${Array.from(thought).length}`);
	assert.doesNotMatch(thought, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no cut left half a character behind");
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
	assert.match(html, /<a data-file="\/home\/you\/Downloads\/report\.html" href="#" class="file"/, "an absolute path after a full-width colon");
	assert.match(html, /<img data-file="~\/Downloads\/card\.png"/, "and a picture is shown, not linked");
	assert.doesNotMatch(html, /data-file="code/, "an ordinary code span is left as written");
	assert.doesNotMatch(html, /data-file="[^"]*x\.com/, "and a web address is not a file");

	// Backticks around a filename is how a model writes one, and leaving that alone was a rule
	// firing on exactly the case it was meant to serve.
	assert.match(html, /<a data-file="\/home\/you\/Downloads\/[^"]*" href="#" class="file"><code>/, "a code span that is only a path is a link");
	assert.match(html, /<img data-file="~\/Downloads\/card2\.png"/, "and one that is only a picture is the picture");
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


test("a name cannot reorder the line it is drawn on", { timeout: 20_000 }, async () => {
	// Found by putting one in a session directory and opening the picker: a session named
	// "delete<RLO> evil red" drew as "deleteder live" — a different conversation from the one that
	// would open, in the control that decides which one opens. Terminal escapes were already
	// stripped; these are invisible, and were not.
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	const realFetch = g.fetch;
	const sessions = [
		{ file: "/s/a.jsonl", id: "a", name: "delete\u202e evil \u001b[31mred\u001b[0m", messages: 1, mtimeMs: Date.now(), current: false },
		{ file: "/s/b.jsonl", id: "b", first: "\u2066flipped\u2069 and \u202bembedded\u202c", messages: 1, mtimeMs: Date.now() - 1000, current: false },
	];
	g.fetch = async (url: unknown, opts: any) =>
		String(url).includes("/sessions") ? { json: async () => ({ sessions }) } : realFetch(url, opts);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	await g.document.getElementById("resume").onclick();
	await new Promise((r) => setTimeout(r, 60));
	const titles = g.document.getElementById("sessBody").children.map((b: any) => b.children[0].textContent);
	assert.deepEqual(titles, ["delete evil red", "flipped and embedded"], "drawn in the order it is written in");
	for (const t of titles) assert.doesNotMatch(t, /[\u202a-\u202e\u2066-\u2069]/, "and with nothing left that could reorder it");
	g.fetch = realFetch;
	dom.dispose();
});


test("what the machine has that this project does not is counted, apart", { timeout: 20_000 }, async () => {
	const automation = {
		installed: true, dir: "/loops", inboxNew: 0, rules: [],
		jobs: [
			{ id: "cron-a", name: "nightly-report", ref: "nightly-report", schedule: "0 9 * * *", enabled: true, prompt: "check", runCount: 3 },
			{ id: "cron-b", name: "here", schedule: "every 5m", enabled: true, prompt: "ok", runCount: 1, next: Date.now() + 60_000 },
			// A plain job of another session: the server sends no `next` and says what would wake it.
			{ id: "cron-c", name: "theirs", schedule: "0 9 * * *", enabled: true, prompt: "digest", runCount: 4, asleep: "session 01a09f6d — resume it to run" },
		],
		// Everything the machine has that this project does not: counted, because a list that silently
		// drops things is worse than a longer list — and counted apart, because /cron counts jobs and
		// /triggers counts rules, so one number covering both agrees with neither command.
		elsewhere: { jobs: 4, rules: 1 },
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const shown = dom.rendered();
	assert.match(shown, /nightly-report/, "the job is on the screen at all");
	assert.match(shown, /theirs[\s\S]*session 01a09f6d — resume it to run/, "a plain job of another session says what would wake it");
	assert.doesNotMatch(shown.split("theirs")[1].split("card")[0], /next /, "and promises no time");
	assert.match(shown, /\+ 4 jobs in other projects — \/cron all/, "the jobs this project cannot see are counted, and named as jobs");
	assert.match(shown, /\+ 1 rule elsewhere — \/triggers rules --all/, "and the rules separately, pointing at the command that lists them");
	dom.dispose();
});


test("a next run in April does not render as a time of day", { timeout: 20_000 }, async () => {
	// The time alone was fine while the only jobs with a next run were the every-N-minutes ones,
	// which are always soon. Cron expressions have one now, and a cron expression can be next year:
	// "15:13:25" for next year is not a shorter way of saying it, it is a different thing.
	const g = globalThis as any;
	// Noon today, which is today by construction: `now + 45 minutes` is tomorrow for the last
	// three quarters of an hour of every day, and a test that fails nightly is a test nobody reads.
	const soon = new Date();
	soon.setHours(12, 0, 0, 0);
	const distant = new Date(Date.now() + 112 * 24 * 3600_000);
	const automation = {
		installed: true, dir: "/loops", inboxNew: 0, rules: [], elsewhere: 0,
		jobs: [
			{ id: "cron-soon", name: "in-an-hour", ref: "in-an-hour", schedule: "every 45m", enabled: true, prompt: "p", runCount: 1, next: soon.toISOString() },
			{ id: "cron-far", name: "new-year", ref: "new-year", schedule: "0 9 1 1 *", enabled: true, prompt: "p", runCount: 1, next: distant.toISOString() },
		],
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const shown = dom.rendered();
	assert.match(shown, new RegExp(`next ${soon.toLocaleTimeString()}`), "today keeps the time on its own");
	assert.match(shown, new RegExp(`next ${distant.toLocaleString().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`), "and anything else says which day");
	dom.dispose();
});


test("a job name and an approval title cannot reorder the lines they are drawn on", { timeout: 20_000 }, async () => {
	// esc() keeps a name out of the markup and does nothing about a bidi override, which is invisible
	// and reorders the line drawn around it. The session picker was stripping them and the panel was
	// not, so a job named "backup<RLO> live evil" drew as something else in the one place you look to
	// see what is scheduled — and so did the title of a dialog asking you to approve a command.
	const automation = {
		installed: true, dir: "/loops", inboxNew: 0, elsewhere: { jobs: 0, rules: 0 },
		jobs: [{ id: "cron-a", name: "backup‮ live evil", ref: "cron-a", schedule: "every 5m", enabled: true, prompt: "run it", runCount: 0 }],
		rules: [{ id: "dyn-a", condition: "build ⁦fails⁩", action: "tell me", enabled: true, fireOnce: false }],
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const panel = (globalThis as any).document.getElementById("auto").innerHTML;
	assert.match(panel, /backup live evil/, `the name is drawn in the order it is written in; got:\n${panel}`);
	assert.doesNotMatch(panel, /[‪-‮⁦-⁩]/, "with nothing left in it that could reorder the card");
	assert.doesNotMatch(panel, /[ --]/, "and nothing a terminal would have eaten");

	// The same rule above the box a person is about to approve. A title is written by an extension.
	dom.source().onmessage({
		data: JSON.stringify({ type: "extension_ui_request", id: "u9", method: "confirm", title: "delete‮ evil red", message: "rm -rf /" }),
	});
	const title = (globalThis as any).document.getElementById("askTitle").textContent;
	assert.equal(title, "delete evil red", "the dialog says what it is asking about");
	dom.dispose();
});

test("undoing the only message shows the empty state", { timeout: 20_000 }, async () => {
	// Undo used to clear the feed and replay the transcript itself, and that second copy of resync()
	// never called showEmpty() — so undoing the first message of a session left a blank rectangle with
	// one grey sentence on it, which is the exact screen the empty state exists to replace.
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [{ role: "user", content: [{ type: "text", text: "the only thing said" }] }] });
	const realFetch = g.fetch;
	let undone = false;
	g.fetch = async (url: unknown, opts: any) => {
		if (String(url).includes("/undo")) {
			undone = true;
			return { json: async () => ({ success: true, data: { text: "the only thing said" } }) };
		}
		// After the fork there is nothing left on this branch, which is what pi would report.
		if (String(url).includes("/history") && undone) return { json: async () => ({ messages: [], seq: 9 }) };
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	assert.match(dom.rendered(), /the only thing said/, "the message was there to begin with");

	await doc.getElementById("undo").onclick();
	await new Promise((r) => setTimeout(r, 200));

	const onScreen = (el: any): string => [el._text ?? "", el._html ?? "", ...(el.children ?? []).map(onScreen)].join(" ");
	const feed = onScreen(doc.getElementById("feed"));
	assert.match(feed, /forked from your last message — it is back in the composer/, "it says what it did");
	assert.match(feed, /A pi session, in a browser/, "and an emptied conversation says what it is");
	assert.doesNotMatch(feed, /the only thing said/, "the message itself is gone from the feed");
	assert.equal(doc.getElementById("input").value, "the only thing said", "and is back in the composer");
	g.fetch = realFetch;
	dom.dispose();
});

test("a disabled job or rule says so in words, not only by being faint", { timeout: 20_000 }, async () => {
	/**
	 * `/cron` prints `disabled` and the terminal panel `[disabled]`; the browser card only dimmed,
	 * which reads as a drawing glitch as easily as a parked loop. An enabled card is unchanged.
	 */
	const automation = {
		...STATE.automation,
		jobs: [
			{ id: "cron-a", name: "nightly", schedule: "0 9 * * *", stateful: true, enabled: false, prompt: "check", runCount: 9, running: false },
			{ id: "cron-b", name: "hourly", schedule: "every 1h", stateful: false, enabled: true, prompt: "look", runCount: 2, running: false },
		],
		rules: [
			{ id: "dyn-1", enabled: false, fireOnce: true, condition: "a deploy fails", action: "tell me" },
			{ id: "dyn-2", enabled: true, fireOnce: false, condition: "a PR opens", action: "review it" },
		],
	};
	const dom = stubDom({ ...STATE, automation }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const html = dom.rendered();
	assert.match(html, /0 9 \* \* \* · loop · disabled</, "the disabled job's line says disabled");
	assert.match(html, />every 1h</, "the enabled job's line is as it was");
	assert.match(html, />disabled · once</, "the disabled rule says disabled");
	assert.match(html, />repeat</, "the enabled rule is as it was");
	assert.equal(html.match(/disabled/g)?.length, 2, "and nothing else is called disabled");
	dom.dispose();
});

test("every block keeps its time where a touch screen can show it, not only in a tooltip", { timeout: 20_000 }, async () => {
	/**
	 * `title` is a hover tooltip, and a phone has no hover. The time is also kept in `data-when`,
	 * which the stylesheet shows under the block on a coarse pointer; the stub cannot draw CSS, so
	 * the rule itself is checked by reading (and was checked once in a browser).
	 */
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	send({ type: "message_start" });
	send({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } });
	send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "done" } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "done" }] } });
	const stamped = dom.made.filter((el: any) => /^row\b/.test(String(el.className)) && el.title);
	assert.ok(stamped.some((el: any) => String(el.className) === "row work"), "the stretch of work is stamped");
	for (const el of stamped) {
		assert.match(el.dataset.when, /\d{1,2}:\d{2}:\d{2}/, `${el.className} keeps its time as data, not only as a tooltip`);
		assert.equal(el.dataset.when, el.title, "the same time in both");
	}
	assert.match(fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8"), /@media \(pointer:coarse\)\{\.row\[data-when\]::after\{content:attr\(data-when\)/, "and a coarse pointer shows it");
	dom.dispose();
});

test("the stop button asks the server to abort the turn", { timeout: 20_000 }, async () => {
	/**
	 * The only way to cancel a running turn from the page. `/rpc` refuses `abort` because it has a
	 * route of its own, and the test of that refusal passed whether or not the button used the route.
	 */
	const g = globalThis as any;
	const dom = stubDom({ ...STATE, busy: true }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const before = dom.calls.length;
	await g.document.getElementById("stop").onclick();
	const sent = dom.calls.slice(before).map((c) => c.url);
	assert.ok(sent.some((u) => new URL(u, "http://x").pathname === `/c/${SESSION_UNDER_TEST}/abort`), `the stop button posts /abort; got ${JSON.stringify(sent)}`);
	dom.dispose();
});

test("the queue badge shows what is queued and clears it", { timeout: 20_000 }, async () => {
	/**
	 * "queued N ✕" counts pi-loops' rows and pi's own queue together, and a click is the clear. With
	 * nothing queued the badge is not there at all.
	 */
	const g = globalThis as any;
	const quiet = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(g.document.getElementById("queue").hidden, true, "nothing queued, no badge");
	quiet.dispose();

	const dom = stubDom({ ...STATE, busy: true, queue: { steering: ["/compact"], followUp: ["/model"] }, requests: [{ id: "r1", text: "and then this" }] }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const badge = g.document.getElementById("queue");
	assert.equal(badge.hidden, false, "something queued, the badge is shown");
	assert.equal(badge.textContent, "queued 3 ✕", "one row of ours and two of pi's");
	const before = dom.calls.length;
	await badge.onclick();
	const sent = dom.calls.slice(before).map((c) => c.url);
	assert.ok(sent.some((u) => new URL(u, "http://x").pathname === `/c/${SESSION_UNDER_TEST}/queue/clear`), `a click clears the queue; got ${JSON.stringify(sent)}`);
	dom.dispose();
});

test("a model that cannot see images has attach disabled and a pasted image refused", { timeout: 20_000 }, async () => {
	/**
	 * Without this, an image goes into a model that cannot read it and the person finds out from
	 * pi's error. The other side is pinned too, so the check cannot pass by refusing everyone.
	 */
	const g = globalThis as any;
	const onScreen = (el: any): string => [el._text ?? "", el._html ?? "", ...(el.children ?? []).map(onScreen)].join(" ");
	const paste = { clipboardData: { items: [{ type: "image/png", getAsFile: () => ({ type: "image/png" }) }] } };
	g.FileReader = class {
		result = "";
		onload: (() => void) | undefined;
		readAsDataURL() {
			this.result = "data:image/png;base64,QUJD";
			this.onload?.();
		}
	};
	try {
		for (const images of [false, true]) {
			const dom = stubDom({ ...STATE, modelCatalog: [{ id: "m", provider: "p", name: "M", images }] }, { messages: [] });
			await new Function(pageScript())();
			await new Promise((r) => setTimeout(r, 400));
			const doc = g.document;
			const attach = doc.getElementById("attach");
			doc.getElementById("input")._on.paste(paste);
			const said = /does not take images; the paste was dropped/.test(onScreen(doc.getElementById("feed")));
			if (!images) {
				assert.equal(attach.disabled, true, "attach is disabled");
				assert.match(attach.title, /m does not take images/, "and says why");
				assert.ok(said, "a pasted image is refused, with the reason");
				assert.equal(doc.getElementById("thumbs").children.length, 0, "and nothing was attached");
			} else {
				assert.equal(attach.disabled, false, "a model that sees images can attach");
				assert.equal(said, false, "and a paste is not refused");
				assert.equal(doc.getElementById("thumbs").children.length, 1, "the pasted image is attached");
			}
			dom.dispose();
		}
	} finally {
		delete g.FileReader;
	}
});

test("an image type the page cannot render is refused rather than sent as a broken PNG", { timeout: 20_000 }, async () => {
	// A non-matching type was relabelled "image/png", so an SVG or a TIFF paste went out as PNG bytes
	// that nothing can decode — visible only as a broken thumbnail, with no notice anywhere.
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	g.FileReader = class {
		result = "";
		onload: (() => void) | undefined;
		readAsDataURL() {
			this.result = "data:image/png;base64,QUJD";
			this.onload?.();
		}
	};
	try {
		await new Function(pageScript())();
		await new Promise((r) => setTimeout(r, 400));
		const doc = g.document;
		const onScreen = (el: any): string => [el._text ?? "", el._html ?? "", ...(el.children ?? []).map(onScreen)].join(" ");

		doc.getElementById("file").onchange({ target: { files: [{ type: "image/svg+xml" }], value: "x" } });
		assert.match(onScreen(doc.getElementById("feed")), /image\/svg\+xml is not an image this can send/, "it says so, the way the ten-image cap does");
		assert.equal(doc.getElementById("thumbs").children.length, 0, "and nothing was attached");

		// The four the picker offers still attach, unchanged.
		doc.getElementById("file").onchange({ target: { files: [{ type: "image/webp" }], value: "x" } });
		assert.equal(doc.getElementById("thumbs").children.length, 1, "a WebP is attached");
	} finally {
		delete g.FileReader;
		dom.dispose();
	}
});

test("Enter on a command already typed in full sends it instead of completing it again", { timeout: 20_000 }, async () => {
	// Typing "/inbox" and pressing Enter turned the composer into "/inbox " and sent nothing: the
	// completion it was already equal to was accepted, and a second Enter was needed to run it. A
	// terminal runs it on the first. Found by typing it in Chrome.
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	const realFetch = g.fetch;
	const sent: Array<{ text?: string }> = [];
	g.fetch = async (url: unknown, opts: any) => {
		if (String(url).includes("/complete")) return { json: async () => ({ items: [{ value: "/inbox", hint: "what is waiting" }] }) };
		if (String(url).includes("/prompt")) {
			sent.push(JSON.parse(opts.body));
			return { json: async () => ({ success: true }) };
		}
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const input = doc.getElementById("input");

	input.value = "/inbox";
	input.selectionStart = 6;
	input.oninput();
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(doc.getElementById("pop").style.display, "block", "the list is open, as it is in a browser");

	input.onkeydown({ key: "Enter", shiftKey: false, preventDefault() {} });
	await new Promise((r) => setTimeout(r, 120));
	assert.deepEqual(sent.map((p) => p.text), ["/inbox"], `one Enter ran it; got ${JSON.stringify(sent)}`);
	assert.equal(input.value, "", "and the composer is empty, not holding a completion it accepted");
	assert.equal(doc.getElementById("pop").style.display, "none", "the list is gone with it");

	// The other half of the claim: a prefix that is genuinely shorter than the candidate still gets
	// completed by Enter, which is what it was always for.
	input.value = "/inb";
	input.selectionStart = 4;
	input.oninput();
	await new Promise((r) => setTimeout(r, 120));
	input.onkeydown({ key: "Enter", shiftKey: false, preventDefault() {} });
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(input.value, "/inbox ", "Enter on a partial word completes it");
	assert.equal(sent.length, 1, "and sends nothing yet");

	// And Tab still only ever inserts, exact match or not.
	input.value = "/inbox";
	input.selectionStart = 6;
	input.oninput();
	await new Promise((r) => setTimeout(r, 120));
	input.onkeydown({ key: "Tab", preventDefault() {} });
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(input.value, "/inbox ", "Tab accepts rather than sends");
	assert.equal(sent.length, 1);

	g.fetch = realFetch;
	dom.dispose();
});

test("a reload keeps what is in the composer, in that tab only", { timeout: 20_000 }, async () => {
	// The header's reload button, the banner that says the page is stale and a phone that discards a
	// backgrounded tab all load this page again. A prompt being written is the only copy of itself.
	const tab = new Map<string, string>();
	const first = stubDom(STATE, { messages: [] }, tab);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const box = (globalThis as any).document.getElementById("input");
	box.value = "half a thought, not sent";
	box.oninput();
	assert.equal(tab.get(`pi-web-draft:${SESSION_UNDER_TEST}`), "half a thought, not sent", "what was typed is kept while it is typed");

	// The same tab, loaded again.
	const second = stubDom(STATE, { messages: [] }, tab);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const back = (globalThis as any).document.getElementById("input");
	assert.equal(back.value, "half a thought, not sent", "and is back in the box afterwards");

	// Sending it clears the box and the stored draft with it, so the next load is empty.
	await (globalThis as any).document.getElementById("composer").requestSubmit();
	assert.equal(back.value, "", "sending empties the box");
	assert.equal(tab.get(`pi-web-draft:${SESSION_UNDER_TEST}`), undefined, "and drops the draft");
	second.dispose();
	first.dispose();

	// A second tab of the same address is a tab, not the same draft: its own box stays empty.
	const other = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.equal((globalThis as any).document.getElementById("input").value, "", "another tab is not handed this one's text");
	other.dispose();

	// A browser that blocks site data costs the draft, not the page — the same promise the theme makes.
	const denied = stubDom(STATE, { messages: [] });
	(globalThis as any).sessionStorage = {
		getItem() { throw new Error("denied"); },
		setItem() { throw new Error("denied"); },
		removeItem() { throw new Error("denied"); },
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const typed = (globalThis as any).document.getElementById("input");
	assert.ok(denied.source(), "the page still comes up");
	typed.value = "typed anyway";
	typed.oninput();
	assert.equal(typed.value, "typed anyway", "and the box still holds what is typed into it");
	denied.dispose();
});

test("a draft typed in another conversation of this tab stays with that conversation", { timeout: 20_000 }, async () => {
	// A row of the list loads another conversation in the same tab, and sessionStorage belongs to the
	// tab: one key for every conversation carried half a message from one into the next.
	const tab = new Map<string, string>([["pi-web-draft:another-session", "for that one"]]);
	const dom = stubDom(STATE, { messages: [] }, tab);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.equal((globalThis as any).document.getElementById("input").value, "", "this conversation's box starts empty");
	dom.dispose();
});

test("the composer grows with a multi-line prompt, and shrinks again", { timeout: 20_000 }, async () => {
	// Prompts here are routinely several lines — a loop prompt with its instructions, a pasted
	// error — and the box was 46px for all of them, so it was written and read through a slot.
	const dom = stubDom(STATE, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const input = (globalThis as any).document.getElementById("input");
	modelComposerHeight(input);

	input.value = ["one", "two", "three", "four", "five", "six"].join("\n");
	input.oninput();
	assert.equal(input.style.height, "122px", "six lines are six lines tall, border included");

	// It comes back down rather than staying at the tallest it has ever been — with a shorter
	// prompt, and with the empty box a send leaves behind.
	input.value = "one\ntwo";
	input.oninput();
	assert.equal(input.style.height, "42px", "a shorter prompt is shorter");
	await (globalThis as any).document.getElementById("composer").requestSubmit();
	assert.equal(input.style.height, "22px", "and the emptied box is back to its resting height");
	dom.dispose();

	// A draft restored at startup is a multi-line prompt in a box nothing has typed into yet, which
	// is where a one-line box is most visible: it is what you see after a reload.
	const tab = new Map<string, string>([[`pi-web-draft:${SESSION_UNDER_TEST}`, "one\ntwo\nthree"]]);
	const reloaded = stubDom(STATE, { messages: [] }, tab);
	modelComposerHeight((globalThis as any).document.getElementById("input"));
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.equal((globalThis as any).document.getElementById("input").style.height, "62px", "a restored draft comes back as tall as it is");
	reloaded.dispose();
});

test("the model in use is in the picker even when the catalog has never heard of it", { timeout: 20_000 }, async () => {
	// Seen live: a session resolved from --model deepseek onto a cloudflare-ai-gateway model this
	// machine has no credentials for. pi lists only the providers you are configured for, so nothing
	// in the catalog matched — and the picker, which selects by that match, showed an empty control
	// while the Session panel named the model. A blank picker reads as "no model".
	const g = globalThis as any;
	const state = {
		...STATE,
		model: { id: "deepseek-v4", provider: "cloudflare-ai-gateway", label: "cloudflare-ai-gateway/deepseek-v4" },
		modelCatalog: [{ id: "m", provider: "p", name: "M" }],
	};
	const dom = stubDom(state, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));

	const picker = g.document.getElementById("model");
	const options = picker.children.flatMap((c: any) => (c.tag === "optgroup" ? c.children : [c]));
	const mine = options.find((o: any) => o.value === "cloudflare-ai-gateway/deepseek-v4");
	assert.ok(mine, `the model in use is one of the options; got ${JSON.stringify(options.map((o: any) => o.value))}`);
	assert.match(mine.textContent, /not in the catalog/, "and says why it is not offered with the rest");
	assert.equal(picker.value, "cloudflare-ai-gateway/deepseek-v4", "and it is the one selected");
	// The provider it belongs to, not lumped in with one that does have credentials.
	const group = picker.children.find((c: any) => c.children.includes(mine));
	assert.equal(group.label, "cloudflare-ai-gateway");
	dom.dispose();
});

test("/sessions and /session export are typed here", { timeout: 20_000 }, async () => {
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	const calls: Array<{ url: string; body: unknown }> = [];
	const realFetch = g.fetch;
	g.fetch = async (url: unknown, opts: any) => {
		calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : undefined });
		if (String(url).includes("/sessions")) {
			return { json: async () => ({ sessions: [
				{ id: "01a08416-1111-2222-3333-444444444444", file: "/s/a.jsonl", startedAt: "2026-09-14T13:48:39.061Z", first: "check the\nlogin flow", messages: 3, current: true },
				{ id: "01a08416-5555-6666-7777-888888888888", file: "/s/b.jsonl", startedAt: "2026-09-13T09:00:00.000Z", name: "renamed one", first: "x", messages: 1, current: false },
			] }) };
		}
		if (String(url).includes("/prompt")) return { json: async () => ({ success: true }) };
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const submit = async (text: string) => {
		doc.getElementById("input").value = text;
		await doc.getElementById("composer").onsubmit({ preventDefault() {} });
		await new Promise((r) => setTimeout(r, 80));
	};
	const went = (part: string) => calls.filter((c) => c.url.includes(part));

	await submit("/sessions");
	assert.equal(went("/prompt").length, 0, "listing is the page's, not a message to the model");
	const shown = dom.rendered();
	// One line: the short id, when, what was first said — one line, newlines gone; the name wins when there is one.
	assert.match(shown, /01a08416-1111-22  2026-09-14T13:48  \[this one\]  check the login flow/);
	assert.match(shown, /01a08416-5555-66  2026-09-13T09:00  renamed one/);

	await submit("/session export /tmp/out.pisession");
	const sent = went("/prompt").pop()?.body as any;
	assert.equal(sent?.text, "/session-export /tmp/out.pisession", "pie's spelling is delivered as the extension's command");

	await submit("/session");
	assert.equal(went("/prompt").length, 1, "a bare /session is answered here, not sent");
	assert.match(dom.rendered(), /usage: \/session export \[path\]/);
	g.fetch = realFetch;
	dom.dispose();
});

test("a tab in the background gives its connection back, and takes a new one when looked at again", { timeout: 20_000 }, async () => {
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	const stateCalls: number[] = [];
	const realFetch = g.fetch;
	g.fetch = async (url: unknown, opts: any) => {
		if (String(url).includes("/state")) stateCalls.push(Date.now());
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const first = dom.source();
	assert.ok(first, "subscribed on load");
	const doc = g.document;
	assert.equal(typeof doc._on.visibilitychange, "function", "the page listens for the tab going into the background");

	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		doc.visibilityState = "hidden";
		doc._on.visibilitychange();
		mock.timers.tick(5_000);
		assert.ok(!first.closed, "a moment in the background is not a reason to reconnect later");
		mock.timers.tick(15_000);
		assert.ok(first.closed, "left in the background, the tab closes its stream");
		assert.equal(g.document.getElementById("status").textContent, "paused in background");

		// Back before the grace ran out: nothing happens.
		const before = stateCalls.length;
		doc.visibilityState = "visible";
		doc._on.visibilitychange();
		await new Promise((r) => setImmediate(r));
		assert.notEqual(dom.source(), first, "looked at again, it subscribes anew");
		assert.ok(stateCalls.length > before, "and polls at once, so the seq check can reload what it missed");
		const second = dom.source();
		doc.visibilityState = "hidden";
		doc._on.visibilitychange();
		mock.timers.tick(3_000);
		doc.visibilityState = "visible";
		doc._on.visibilitychange();
		mock.timers.tick(20_000);
		assert.ok(!second.closed, "a quick switch away and back keeps the stream");
		assert.equal(dom.source(), second);
	} finally {
		mock.timers.reset();
		g.fetch = realFetch;
		dom.dispose();
	}
});

test("a send that goes nowhere says so instead of looking alive", { timeout: 20_000 }, async () => {
	const g = globalThis as any;
	const dom = stubDom(STATE, { messages: [] });
	const realFetch = g.fetch;
	let settle: (v: unknown) => void = () => {};
	g.fetch = async (url: unknown, opts: any) => {
		if (String(url).includes("/prompt")) return new Promise((r) => { settle = r; });
		return realFetch(url, opts);
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		doc.getElementById("input").value = "hello?";
		const submitted = doc.getElementById("composer").onsubmit({ preventDefault() {} });
		mock.timers.tick(2_000);
		assert.notEqual(doc.getElementById("status").textContent, "still sending — if it never lands, close the other tabs of this address", "two seconds is a slow model, not a stuck browser");
		mock.timers.tick(5_000);
		assert.equal(doc.getElementById("status").textContent, "still sending — if it never lands, close the other tabs of this address");
		settle({ json: async () => ({ success: true }) });
		await submitted;
		assert.notEqual(doc.getElementById("status").textContent, "still sending — if it never lands, close the other tabs of this address", "delivered: the warning goes");
	} finally {
		mock.timers.reset();
		g.fetch = realFetch;
		dom.dispose();
	}
});

test("the queue lists requests from every source, in order", { timeout: 20_000 }, async () => {
	// docs/web-ui-parity.md: what pi-loops addressed to this conversation is in the same queue as your
	// own messages, with its source, cancellable one at a time. `/state` hands the rows over in the
	// order they run; the page must keep that order and put a ✕ on each.
	const g = globalThis as any;
	const requests = [
		{ id: "11111111-aaaa", source: "person", label: "you", text: "first thing", images: 0, created_at: "2026-06-01T12:00:00Z", mine: true, offered: false },
		{ id: "22222222-bbbb", source: "person", label: "you", text: "second thing", images: 1, created_at: "2026-06-01T12:00:01Z", mine: true, offered: false },
		{ id: "run-3333", source: "cron:cron-a", label: "cron nightly", text: "check", images: 0, created_at: "2026-06-01T11:59:00Z", mine: false, offered: false },
		{ id: "44444444-dddd", source: "person", label: "you", text: "from before", images: 0, created_at: "2026-06-01T11:00:00Z", mine: false, offered: true },
		// An offered row is shown whole: send vouches for every word of it.
		{ id: "55555555-eeee", source: "person", label: "you", text: "long ".repeat(100), images: 0, created_at: "2026-06-01T11:00:00Z", mine: false, offered: true },
	];
	// A slash command typed while busy sits in pi's own queue, not in the file: it is listed too.
	const shown = { ...STATE, busy: true, requests, queue: { steering: [], followUp: ["/inbox"] } };
	const dom = stubDom(shown, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const box = doc.getElementById("queued");
	assert.equal(box.hidden, false, "the queue is on the screen");
	assert.equal(doc.getElementById("queue").textContent, "queued 6 ✕", "the badge counts the rows and what pi itself holds");
	const lines = box.children.filter((c: any) => String(c.className).startsWith("qrow"));
	assert.deepEqual(lines.map((l: any) => l.children.map((c: any) => c._text).join(" | ")), [
		"you | first thing | ✕",
		"you | second thing [1 image(s)] | ✕",
		"cron nightly | check | ✕",
		"not sent before pi stopped | from before | send | discard",
		`not sent before pi stopped | ${"long ".repeat(100)} | send | discard`,
		"pi | /inbox",
	], "every source, in the order they run, each with its control; pi's own queue after them");
	assert.equal(lines[4].children[1]._text.length, 500, "an offered row is shown whole");
	assert.equal(lines[4].children[1].className, "qtext full", "wrapped, not ellipsized");
	assert.equal(lines[0].children[1].className, "qtext", "a queued row is still one line");
	// The ✕ on the second row cancels that row and no other.
	lines[1].children.at(-1).onclick();
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(dom.calls.filter((c) => c.url.includes("/queue/cancel")).map((c) => c.body), [{ id: "22222222-bbbb" }]);
	// A message a previous page left behind is sent only when you say so.
	lines[3].children[2].onclick();
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(dom.calls.filter((c) => c.url.includes("/queue/send")).map((c) => c.body), [{ id: "44444444-dddd" }]);
	assert.equal(box.children.some((c: any) => String(c._text).startsWith("send queued")), false, "while a turn runs there is nothing held to send");
	// After Stop, with pi idle and your messages still queued, nothing has to be sent by hand: the
	// holder hands the next row over on its own (owner decision 2026-11-02), and each row keeps its ✕.
	shown.busy = false;
	dom.source().onmessage({ data: JSON.stringify({ type: "agent_end" }) });
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(doc.getElementById("queued").children.some((c: any) => String(c._text).startsWith("send queued")), false, "no send-queued button: Stop stopped the turn, not the queue");
	dom.dispose();
});

test("a message nobody took says why and offers to send it here, unless this page's pi is the one standing aside", { timeout: 20_000 }, async () => {
	// docs/web-ui-parity.md: a message pi-loops cannot take says so after fifteen seconds, naming the
	// pid and the reason, with send-here; when the page's own pi stands aside there is no send-here,
	// since anything written then branches the conversation, and the reason says /resume.
	const g = globalThis as any;
	const requests = [
		{ id: "11111111-aaaa", source: "person", label: "you", text: "anyone?", images: 1, created_at: "2026-06-01T12:00:00Z", mine: true, offered: false, stuck: { pid: 4321, line: "not taken by pi 4321 (shows an older copy of this conversation)", button: "send it here instead" } },
		{ id: "22222222-bbbb", source: "person", label: "you", text: "hello?", images: 0, created_at: "2026-06-01T12:00:01Z", mine: true, offered: false, stuck: { pid: 777, line: "not taken by pi 777 (this page's pi shows an older copy of this conversation; /resume to see it)" } },
		{ id: "33333333-cccc", source: "person", label: "you", text: "fresh", images: 0, created_at: "2026-06-01T12:00:02Z", mine: true, offered: false },
		{ id: "44444444-dddd", source: "person", label: "you", text: "busy?", images: 0, created_at: "2026-06-01T12:00:03Z", mine: true, offered: false, stuck: { pid: 999, line: "pi 999 holds this conversation and has not taken it yet (it may be busy)", button: "answer here instead (a branch pi 999 will not see)" } },
	];
	const dom = stubDom({ ...STATE, busy: false, requests }, { messages: [] });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const lines = doc.getElementById("queued").children.filter((c: any) => String(c.className).startsWith("qrow"));
	assert.deepEqual(lines.map((l: any) => l.children.map((c: any) => c._text).join(" | ")), [
		"not taken by pi 4321 (shows an older copy of this conversation) | anyone? [1 image(s)] | send it here instead | ✕",
		"not taken by pi 777 (this page's pi shows an older copy of this conversation; /resume to see it) | hello? | ✕",
		"you | fresh | ✕",
		"pi 999 holds this conversation and has not taken it yet (it may be busy) | busy? | answer here instead (a branch pi 999 will not see) | ✕",
	], "the server's line and its offer, as given; no offer where sending here is unsafe");
	assert.equal(lines[0].className, "qrow stuck");
	lines[0].children[2].onclick();
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(dom.calls.filter((c) => c.url.includes("/queue/send-here")).map((c) => c.body), [{ id: "11111111-aaaa" }], "send-here names that row and no other");
	dom.dispose();
});

test("a send into a page whose own pi stands aside says so, and that pi reads it again", { timeout: 20_000 }, async () => {
	const g = globalThis as any;
	const dom = stubDom({ ...STATE, requests: [] }, { messages: [] }, new Map(), { "/prompt": { success: true, queued: "p1", aside: { pid: 777 } } });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	doc.getElementById("input").value = "hello there";
	await doc.getElementById("composer").onsubmit({ preventDefault() {} });
	await new Promise((r) => setTimeout(r, 40));
	assert.match(dom.rendered(), /this page's pi \(pid 777\) shows an older copy of this conversation[^\n]*pi reads it again once it is idle/, "the reason and the way out, on the page");
	dom.dispose();
});

test("a send answered elsewhere says so, and one pi refused comes back to the composer with the error", { timeout: 20_000 }, async () => {
	const g = globalThis as any;
	const dom = stubDom({ ...STATE, requests: [] }, { messages: [] }, new Map(), { "/prompt": { success: true, queued: "p1", elsewhere: { pid: 4321 } } });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const input = doc.getElementById("input");
	input.value = "hello there";
	await doc.getElementById("composer").onsubmit({ preventDefault() {} });
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(dom.calls.filter((c) => c.url.includes("/prompt")).map((c) => c.body), [{ text: "hello there", images: [] }], "chat text goes to /prompt as text, nothing else");
	const posted = dom.calls.find((c) => c.url.includes("/prompt"));
	assert.deepEqual(
		[posted?.headers?.["x-pi-web-token"], posted?.headers?.["content-type"], posted?.url.includes("token=")],
		["test-token", "application/json", false],
		"the token rides in a header on a post, never in its URL",
	);
	assert.match(dom.rendered(), /open in a terminal \(pid 4321\): answered there(?!;)/, "owner decision O2: the terminal answers, and the page says so");
	assert.doesNotMatch(dom.rendered(), /answered there; \/resume to see it/, "with nothing to type after it");
	// The holder found pi refused a message; the server took the row back and says so on the stream.
	input.value = "typed since";
	dom.source().onmessage({ data: JSON.stringify({ type: "send_failed", id: "p1", text: "hello there", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], error: "pi did not start a turn for it" }) });
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(input.value, "hello there\ntyped since", "the text is back in the composer, ahead of what was typed since");
	assert.equal(doc.getElementById("thumbs").children.length, 1, "with its image");
	assert.match(dom.rendered(), /pi did not start a turn for it/, "and the error is on the page");
	assert.match(dom.rendered(), /\nnot sent\n/, "under its own label");
	dom.dispose();
});

test("a message sent while others are queued is not drawn above them", { timeout: 20_000 }, async () => {
	const g = globalThis as any;
	const queued = [{ id: "r1", label: "you", text: "beta", source: "person" }];
	const dom = stubDom({ ...STATE, requests: queued }, { messages: [] }, new Map(), { "/prompt": { success: true, queued: "p2" } });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	doc.getElementById("input").value = "gamma";
	await doc.getElementById("composer").onsubmit({ preventDefault() {} });
	await new Promise((r) => setTimeout(r, 40));
	assert.doesNotMatch(dom.rendered(), /gamma/, "beta runs first: gamma is drawn when pi echoes it, not now");
	dom.dispose();
});

/* ------------------------------------------------------------------ the conversation list and the frame */

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** What GET /conversations answers, for the project the page is in. */
function listAnswer(rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
	return {
		cwd: "/work/api",
		more: 0,
		projects: [{ cwd: "/work/api", label: "/work/api", conversations: rows.length }, { cwd: "/work/web", label: "/work/web", conversations: 1 }],
		rows: rows.map((r) => ({ cwd: "/work/api", holder: "none", open: false, needsYou: 0, queued: 0, lastActivityAt: ago(60_000), ...r })),
		...extra,
	};
}
const ROWS = [
	{ sessionId: SESSION_UNDER_TEST, title: "fix the cache", holder: "page", open: true },
	{ sessionId: "held-one", title: "release notes", holder: "terminal" },
	{ sessionId: "loop-one", title: "issue triage", holder: "background", needsYou: 2, queued: 1, lastActivityAt: ago(3 * 86_400_000) },
];
/** The list's rows as drawn: every child of #convs that is a link. */
const rowsOf = () => ((globalThis as any).document.getElementById("convs").children as any[]).filter((c) => c.tag === "a");
/** The text of an element and everything in it. */
const textOf = (el: any): string => `${el._text ?? ""}${(el.children ?? []).map(textOf).join(" ")}`;

async function startPage(state: unknown, answers: Record<string, unknown>, store?: (s: Map<string, string>) => void) {
	const dom = stubDom(state, { messages: [] }, new Map(), answers);
	if (store) {
		const local = new Map<string, string>();
		store(local);
		(globalThis as any).localStorage = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v) };
	}
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	return dom;
}

test("the list shows this project's conversations, grouped Today and Earlier, with the open one marked, and each row is its address", { timeout: 20_000 }, async () => {
	const dom = await startPage(STATE, { "/conversations": listAnswer(ROWS) });
	const call = dom.calls.find((c) => c.url.startsWith("/conversations"));
	assert.ok(call, "the page asked for the list");
	assert.equal(call.url, `/conversations?session=${SESSION_UNDER_TEST}`, "for the project of the conversation it shows");
	assert.equal(call.headers?.["x-pi-web-token"], "test-token", "behind the token");
	const rows = rowsOf();
	assert.deepEqual(rows.map((r) => r.dataset.conv), [SESSION_UNDER_TEST, "held-one", "loop-one"]);
	assert.deepEqual(rows.map((r) => r.href), [`/c/${SESSION_UNDER_TEST}/`, "/c/held-one/", "/c/loop-one/"], "a row loads that conversation's own page");
	assert.match(rows[0].className, /\bon\b/, "the open conversation is marked");
	assert.doesNotMatch(rows[1].className, /\bon\b/);
	const groups = ((globalThis as any).document.getElementById("convs").children as any[]).filter((c) => c.className === "grp").map((c) => c._text);
	assert.deepEqual(groups, ["Today", "Earlier"]);
	assert.match(textOf(rows[2]), /⚑ 2/, "what needs you is counted on its row");
	assert.match(textOf(rows[2]), /queued 1/, "and what is queued for it");
	assert.equal((globalThis as any).document.getElementById("project").value, "/work/api", "the switcher is on this project");
	assert.equal((globalThis as any).document.getElementById("title")._text, "fix the cache", "the header says which conversation this is");
	dom.dispose();
});

test("a row says who holds it: terminal, open, pi-loops, or nothing at all", { timeout: 20_000 }, async () => {
	const dom = await startPage(STATE, {
		"/conversations": listAnswer([
			{ sessionId: "t", title: "a", holder: "terminal" },
			{ sessionId: "to", title: "b", holder: "terminal", open: true },
			{ sessionId: "p", title: "c", holder: "page", open: true },
			{ sessionId: "bg", title: "d", holder: "background" },
			{ sessionId: "n", title: "e", holder: "none" },
		]),
	});
	const tag = (row: any) => row.children[0].children.find((c: any) => c.className === "who")?._text;
	assert.deepEqual(rowsOf().map(tag), ["terminal", "terminal · open here", "open", "pi-loops", undefined]);
	assert.doesNotMatch(dom.rendered(), /\bhost\b/i, "nothing says host");
	dom.dispose();
});

test("a conversation a terminal holds shows the held line above the composer; one that stands aside, or this page's own, does not", { timeout: 20_000 }, async () => {
	const held = "Your terminal has this conversation. What you send here is answered there.";
	const terminal = { kind: "terminal", pid: 4242, mine: false, delivers: true, aside: false };
	let dom = await startPage({ ...STATE, holder: terminal }, { "/conversations": listAnswer(ROWS) });
	const line = (globalThis as any).document.getElementById("held");
	assert.equal(line.hidden, false);
	assert.match(textOf(line), new RegExp(held.replace(/\./g, "\\.")), "the owner's words, exactly");
	assert.equal((globalThis as any).document.getElementById("input").placeholder, "Message (answered in your terminal)…");
	dom.dispose();
	for (const holder of [{ ...terminal, delivers: false, aside: true }, { ...terminal, mine: true }, { kind: "none", mine: false, delivers: false, aside: false }, undefined]) {
		dom = await startPage({ ...STATE, holder }, { "/conversations": listAnswer(ROWS) });
		assert.equal((globalThis as any).document.getElementById("held").hidden, true, JSON.stringify(holder));
		dom.dispose();
	}
});

test("the held line comes from /state, so a list that fails still shows it, and the chat still works", { timeout: 20_000 }, async () => {
	const dom = await startPage({ ...STATE, holder: { kind: "terminal", pid: 1, mine: false, delivers: true, aside: false } }, { "/conversations": { error: "no such project" } });
	assert.equal((globalThis as any).document.getElementById("held").hidden, false);
	assert.match(dom.rendered(), /The conversation list is not available: no such project\. This conversation still works\./);
	assert.ok(dom.source(), "the conversation's stream is up");
	dom.dispose();
});

test("Needs you and Unread filter the list and count it; a terminal's conversation is never unread", { timeout: 20_000 }, async () => {
	const rows = [
		{ sessionId: SESSION_UNDER_TEST, title: "this one", lastActivityAt: ago(1000) },
		{ sessionId: "new-since", title: "written since", lastActivityAt: ago(1000) },
		{ sessionId: "read-since", title: "read since", lastActivityAt: ago(5000) },
		{ sessionId: "held-new", title: "held", holder: "terminal", lastActivityAt: ago(1000) },
		{ sessionId: "old", title: "older than this browser", needsYou: 1, lastActivityAt: ago(7_200_000) },
	];
	const dom = await startPage(STATE, { "/conversations": listAnswer(rows) }, (local) => {
		local.set("pi-loops-read-since", String(Date.now() - 3_600_000));
		local.set("pi-loops-read:read-since", String(Date.now()));
	});
	const doc = (globalThis as any).document;
	assert.deepEqual([doc.getElementById("nAll")._text, doc.getElementById("nNeeds")._text, doc.getElementById("nUnread")._text], ["5", "1", "1"]);
	assert.match(doc.getElementById("nNeeds").className, /\bhot\b/, "what needs you is amber");
	const dots = rowsOf().filter((r) => r.children[0].children.some((c: any) => c.className === "u")).map((r) => r.dataset.conv);
	assert.deepEqual(dots, ["new-since"], "only what changed since this browser last looked");
	doc.getElementById("segNeeds").onclick();
	assert.deepEqual(rowsOf().map((r) => r.dataset.conv), ["old"]);
	assert.match(doc.getElementById("segNeeds").className, /\bon\b/);
	doc.getElementById("segUnread").onclick();
	assert.deepEqual(rowsOf().map((r) => r.dataset.conv), ["new-since"]);
	assert.equal((globalThis as any).localStorage.getItem("pi-loops-segment"), "unread", "the choice is remembered");
	doc.getElementById("segAll").onclick();
	assert.equal(rowsOf().length, 5);
	dom.dispose();

	// The first load on a device: everything before it is read.
	const fresh = await startPage(STATE, { "/conversations": listAnswer(rows) }, () => {});
	assert.equal((globalThis as any).document.getElementById("nUnread")._text, "", "nothing is unread on a device's first look");
	fresh.dispose();
});

test("the keyboard moves through the list one row at a time, and Enter opens the row", { timeout: 20_000 }, async () => {
	const dom = await startPage(STATE, { "/conversations": listAnswer(ROWS) });
	const assigned: string[] = [];
	(globalThis as any).location.assign = (u: string) => void assigned.push(u);
	const rows = rowsOf();
	assert.deepEqual(rows.map((r) => r.tabIndex), [0, -1, -1], "one row is in the Tab order: the open one");
	const keydown = (globalThis as any).document.getElementById("convs")._on.keydown;
	let prevented = 0;
	const key = (k: string, target: any) => keydown({ key: k, target, preventDefault: () => prevented++ });
	key("ArrowDown", rows[0]);
	assert.deepEqual(rows.map((r) => r.tabIndex), [-1, 0, -1]);
	key("End", rows[1]);
	assert.deepEqual(rows.map((r) => r.tabIndex), [-1, -1, 0]);
	key("ArrowDown", rows[2]);
	assert.deepEqual(rows.map((r) => r.tabIndex), [-1, -1, 0], "the last row stays the last");
	key("Home", rows[2]);
	key("Enter", rows[0]);
	assert.deepEqual(assigned, [`/c/${SESSION_UNDER_TEST}/`]);
	assert.equal(prevented, 5);
	key("a", rows[0]);
	assert.equal(prevented, 5, "any other key is the browser's");
	dom.dispose();
});

test("showing the list asks for no other conversation, and rides on the page's own poll at most every fifteen seconds", { timeout: 20_000 }, async () => {
	const dom = await startPage(STATE, { "/conversations": listAnswer(ROWS) });
	await dom.poll();
	await dom.poll();
	const lists = dom.calls.filter((c) => c.url.startsWith("/conversations"));
	assert.equal(lists.length, 1, "one list for three polls within fifteen seconds");
	const others = dom.calls.filter((c) => c.url.startsWith("/c/") && !c.url.startsWith(`/c/${SESSION_UNDER_TEST}/`));
	assert.deepEqual(others, [], "no other conversation's route: listing starts no pi");
	// pi moving to another conversation (a new session, a resume) is marked at the next poll.
	dom.source().onmessage({ data: JSON.stringify({ type: "page_moved", sessionId: "01b0-moved", seq: 1, epoch: "e1" }) });
	await dom.poll();
	assert.equal(dom.calls.filter((c) => c.url.startsWith("/conversations")).at(-1)?.url, "/conversations?session=01b0-moved");
	dom.dispose();
});

test("choosing another project asks for that project's list by its cwd", { timeout: 20_000 }, async () => {
	const dom = await startPage(STATE, { "/conversations": listAnswer(ROWS) });
	const picker = (globalThis as any).document.getElementById("project");
	assert.deepEqual(picker.children.map((o: any) => o.value), ["/work/api", "/work/web"]);
	picker.value = "/work/web";
	picker.onchange();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(dom.calls.filter((c) => c.url.startsWith("/conversations")).at(-1)?.url, `/conversations?session=${SESSION_UNDER_TEST}&cwd=%2Fwork%2Fweb`);
	dom.dispose();
});

test("a title cannot carry markup or reorder its line", { timeout: 20_000 }, async () => {
	const dom = await startPage(STATE, { "/conversations": listAnswer([{ sessionId: "x1", title: '<img src=x onerror=alert(1)>‮evil' }]) });
	const b = rowsOf()[0].children[0].children.find((c: any) => c.tag === "b");
	assert.equal(b._text, "<img src=x onerror=alert(1)>evil", "drawn as text, the override taken out");
	assert.equal((globalThis as any).document.getElementById("convs").innerHTML, "", "and no markup was assigned");
	dom.dispose();
});

test("on a phone one pane shows at a time, picked by the Inbox, Chat and Loops tabs, and a row opens on Chat", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] }, new Map(), { "/conversations": listAnswer(ROWS) });
	const g = globalThis as any;
	g.matchMedia = (q: string) => ({ matches: /max-width:(760|900|1100)px/.test(q), addEventListener() {} });
	g.location.hash = "#loops";
	const pushed: string[] = [];
	g.history.pushState = (_s: unknown, _t: string, url: string) => void pushed.push(url);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(g.document.body.dataset.pane, "loops", "the address picks the pane");
	g.document.getElementById("tabInbox").onclick({ preventDefault() {} });
	assert.equal(g.document.body.dataset.pane, "inbox");
	assert.deepEqual(pushed, ["#inbox"], "Back returns to the pane before");
	assert.equal(g.document.getElementById("tabInbox").className, "on");
	assert.equal(rowsOf()[1].href, "/c/held-one/#chat", "a row opens that conversation on its Chat pane");
	dom.dispose();
});

test("the status bar says whether pi-loops runs, how many loops, and how many conversations a terminal holds", { timeout: 20_000 }, async () => {
	let dom = await startPage({ ...STATE, automation: { ...STATE.automation, hostPid: 77 } }, { "/conversations": listAnswer(ROWS) });
	const doc = () => (globalThis as any).document;
	assert.match(textOf(doc().getElementById("sbHost")), /pi-loops running in the background/);
	assert.equal(doc().getElementById("sbLoops")._text, "1 loop");
	assert.equal(doc().getElementById("sbHeld")._text, "terminal holds 1 conversation in /work/api", "and in which project");
	assert.equal(doc().getElementById("cardsSlot")._text, "", "no count line: the inbox has cards of its own there");
	dom.dispose();
	dom = await startPage(STATE, { "/conversations": listAnswer(ROWS) });
	assert.match(textOf(doc().getElementById("sbHost")), /pi-loops is not running/);
	dom.dispose();
});

test("the frame's class names are its own: nothing in it reuses a name the conversation or the panel styles", () => {
	const { rest } = pageStyle();
	for (const rule of rest.split("}")) {
		const selector = rule.slice(0, rule.lastIndexOf("{")).trim();
		if (!/#rail|#list|\.conv\b|\.seg\b|\.sbar|\.tabs|\.held|\.lhead|\.grp/.test(selector)) continue;
		assert.doesNotMatch(selector, /\.(card|row|dot|empty|t|m)\b/, `the frame's rule ${selector} styles one of the page's own names`);
	}
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(src, /<aside id="loops"/, "the loops rail is found by its id");
	assert.doesNotMatch(src, /querySelector\("aside"\)/, "not by its tag, which a second column would share");
});

/* ------------------------------------------------------------------ rework 1 */

test("a terminal's conversation in a page whose pi has no pi-loops says it is answered here, not there", { timeout: 20_000 }, async () => {
	const dom = await startPage({ ...STATE, holder: { kind: "terminal", pid: 4242, mine: false, delivers: true, aside: false, piLoops: false } }, { "/conversations": listAnswer(ROWS) });
	const line = (globalThis as any).document.getElementById("held");
	assert.equal(line.hidden, false);
	assert.doesNotMatch(textOf(line), /Your terminal has this conversation/, "no promise the page would not keep");
	assert.match(textOf(line), /answered here, beside the terminal/);
	assert.notEqual((globalThis as any).document.getElementById("input").placeholder, "Message (answered in your terminal)…");
	dom.dispose();
});

test("the conversation on the screen is read as of now, not as of the list's last draw", { timeout: 20_000 }, async () => {
	const before = Date.now();
	const dom = await startPage(STATE, { "/conversations": listAnswer([{ sessionId: SESSION_UNDER_TEST, title: "this", lastActivityAt: ago(3_600_000) }]) }, () => {});
	const mark = Number((globalThis as any).localStorage.getItem(`pi-loops-read:${SESSION_UNDER_TEST}`));
	assert.ok(mark >= before, `marked ${mark}, the test began at ${before}`);
	dom.dispose();
});

test("a draft kept under the key before 0.24 comes back once, in this conversation", { timeout: 20_000 }, async () => {
	const tab = new Map<string, string>([["pi-web-draft", "typed before the upgrade"]]);
	const dom = stubDom(STATE, { messages: [] }, tab);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.equal((globalThis as any).document.getElementById("input").value, "typed before the upgrade");
	assert.equal(tab.has("pi-web-draft"), false, "the old key is gone, so no other conversation is handed it");
	assert.equal(tab.get(`pi-web-draft:${SESSION_UNDER_TEST}`), "typed before the upgrade");
	dom.dispose();
});

test("a terminal that answers nothing is not said to answer", { timeout: 20_000 }, async () => {
	const dom = await startPage(STATE, { "/conversations": listAnswer([{ sessionId: "t1", title: "a", holder: "terminal", delivers: true }, { sessionId: "t2", title: "b", holder: "terminal", delivers: false }]) });
	const title = (row: any) => row.children[0].children.find((c: any) => c.className === "who")?.title;
	const [answers, silent] = rowsOf().map(title);
	assert.match(answers, /answers what is sent/);
	assert.match(silent, /answers nothing sent/);
	dom.dispose();
});

test("the Background view is one tap away in the Loops pane, which is what a phone has instead of the rail", () => {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const loops = src.slice(src.indexOf('<aside id="loops"'), src.indexOf("</aside>"));
	assert.match(loops, /<a href="\/background"/);
});

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
	};
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}
/** `rgb(r g b / a)` laid over `#rrggbb`. */
function over(rgba: string, hex: string): string {
	const [r, g, b, a] = /rgb\((\d+) (\d+) (\d+) \/ ([.\d]+)\)/.exec(rgba)!.slice(1).map(Number);
	const base = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
	return `#${[r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a)).toString(16).padStart(2, "0")).join("")}`;
}

test("the placeholder and the count pills are readable in both schemes", () => {
	const { tokens, rest } = pageStyle();
	const value = (block: string, name: string) => new RegExp(`${name}:([^;]+);`).exec(block)![1].trim();
	const light = tokens.slice(tokens.indexOf(":root{"));
	const dark = tokens.slice(tokens.indexOf("html[data-theme=dark]{"));
	assert.match(rest, /::placeholder\{color:var\(--dim\)/, "the placeholder is themed, not the browser's grey");
	const pill = /\.pill\{[^}]*color:var\((--[a-z0-9-]+)\)/.exec(rest)![1];
	for (const scheme of [light, dark]) {
		for (const paper of ["--panel", "--panel2"]) {
			assert.ok(contrast(value(scheme, "--dim"), value(scheme, paper)) >= 4.5, `placeholder on ${paper}`);
			const bg = over(value(scheme, "--hover"), value(scheme, paper));
			const ratio = contrast(value(scheme, pill), bg);
			assert.ok(ratio >= 4.5, `a count pill on ${paper} is ${ratio.toFixed(2)}:1`);
		}
	}
});

test("on a phone the conversation's title has a row of its own in the header", () => {
	const { rest } = pageStyle();
	assert.doesNotMatch(rest, /header>b\{display:none\}/, "the title is never hidden");
});

test("the open conversation keeps its title while the list shows another project", { timeout: 20_000 }, async () => {
	const answers: Record<string, unknown> = { "/conversations": listAnswer(ROWS) };
	const dom = await startPage(STATE, answers);
	const doc = (globalThis as any).document;
	assert.equal(doc.getElementById("title")._text, "fix the cache");
	answers["/conversations"] = listAnswer([{ sessionId: "w1", title: "landing page" }], { cwd: "/work/web" });
	doc.getElementById("project").value = "/work/web";
	doc.getElementById("project").onchange();
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(rowsOf().map((r) => r.dataset.conv), ["w1"]);
	assert.equal(doc.getElementById("title")._text, "fix the cache", "still its title, not its id");
	assert.equal(doc.getElementById("sbHeld")._text, "", "and the terminal count is of the project shown");
	dom.dispose();
});

test("a conversation opened from far down the list is scrolled into view, once", { timeout: 20_000 }, async () => {
	const dom = stubDom(STATE, { messages: [] }, new Map(), { "/conversations": listAnswer([...Array.from({ length: 40 }, (_, i) => ({ sessionId: `x${i}`, title: `x${i}` })), { sessionId: SESSION_UNDER_TEST, title: "far down" }]) });
	const g = globalThis as any;
	const make = g.document.createElement;
	const scrolled: string[] = [];
	g.document.createElement = (t: string) => {
		const e = make(t);
		e.scrollIntoView = () => void scrolled.push(e.dataset.conv);
		return e;
	};
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	assert.deepEqual(scrolled, [SESSION_UNDER_TEST]);
	g.document.getElementById("segAll").onclick();
	assert.deepEqual(scrolled, [SESSION_UNDER_TEST], "a later draw leaves the scroll you chose");
	dom.dispose();
});

test("the composer's footer shows the end of the id, which tells one day's conversations apart", { timeout: 20_000 }, async () => {
	const dom = await startPage({ ...STATE, sessionId: "01a1a1ee-5090-730c-8474-cfd9d591868b" }, { "/conversations": listAnswer(ROWS) });
	assert.equal((globalThis as any).document.getElementById("sid")._text, "d591868b");
	dom.dispose();
});

/* ------------------------------------------------------------------ the inbox as cards */

const DECISION_CARD = { id: "inb-" + "a".repeat(32), kind: "decision", status: "new", headline: "Close #412 as fixed?", waits: "the release branch", verified: true, origin: "loop", loop: { id: "cron-1", name: "issue-triage" }, source: "cron:issue-triage", cwd: "/work/api", createdAt: new Date().toISOString(), runId: "run-1", sessionId: "01a0", hasTranscript: true, fromThisConversation: true, claiming: false, owner: { holder: "terminal" } };
const NEWS_CARD = { id: "inb-" + "b".repeat(32), kind: "news", status: "new", headline: "<img src=x onerror=alert(1)>", body: "<b>bold</b> stays text", verified: false, origin: "loop", source: "cron:ci-watch", cwd: "/work/api", createdAt: new Date().toISOString(), runId: "run-2", hasTranscript: false, fromThisConversation: false, claiming: false, owner: { holder: "none" } };
const INBOX = { cwd: "/work/api", cards: [DECISION_CARD, NEWS_CARD], more: 0, handled: [], elsewhere: 0, chips: ["Not a bug", "Already fixed", "Duplicate", "Too noisy", "Not now"] };

async function inboxPage(answers: Record<string, unknown> = {}) {
	const all: Record<string, unknown> = { "/inbox?": INBOX, ...answers };
	const dom = stubDom(STATE, { messages: [] }, new Map(), all);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const cards = () => dom.made.filter((m: any) => m.tag === "article" && m.dataset.inb);
	const texts = (el: any): string[] => [el._text, ...el.children.flatMap((c: any) => (c && typeof c === "object" ? texts(c) : []))];
	const button = (card: any, label: string): any => {
		const walk = (el: any): any => (el.tag === "button" && el._text === label ? el : el.children.map((c: any) => (c && typeof c === "object" ? walk(c) : undefined)).find(Boolean));
		return walk(card);
	};
	const click = async (card: any, label: string) => {
		const b = button(card, label);
		assert.ok(b, `a "${label}" button on the card`);
		card._on.click({ target: b });
		await new Promise((r) => setTimeout(r, 60));
	};
	return { dom, cards, texts, button, click, answers: all };
}

test("the inbox shows decisions before news, with what waits on a decision and what happens if nobody acts", { timeout: 20_000 }, async () => {
	const { dom, cards, texts, button } = await inboxPage();
	const [decision, news] = cards();
	assert.deepEqual([decision.dataset.inb, news.dataset.inb], [DECISION_CARD.id, NEWS_CARD.id], "decisions first; each card carries its finding's id");
	const shown = texts(decision).join("|");
	assert.match(shown, /Needs you|Close #412 as fixed\?/);
	for (const label of ["Waiting on", "the release branch", "If you don't", "not said", "issue-triage", "from this conversation", "runs in your terminal"]) assert.ok(shown.includes(label), `${label} in ${shown}`);
	for (const label of ["Yes, do it", "No\u2026", "See the run"]) assert.ok(button(decision, label), label);
	for (const label of ["Look into it", "Dismiss\u2026", "See the run"]) assert.ok(button(news, label), label);
	assert.equal(button(news, "See the run").disabled, true, "no transcript: See the run says why instead");
	assert.ok(dom.calls.some((c) => c.url.startsWith("/inbox?session=")), "asked of the global route, not this conversation's");
	dom.dispose();
});

test("a finding's HTML is shown as text and creates no element", { timeout: 20_000 }, async () => {
	const { dom, cards, texts } = await inboxPage();
	const news = cards()[1];
	assert.ok(texts(news).includes("<img src=x onerror=alert(1)>"));
	assert.ok(texts(news).includes("<b>bold</b> stays text"));
	assert.ok(!dom.made.some((m: any) => m.tag === "img" || m.tag === "b" && m._text === "bold"), "no element from the finding's markup");
	assert.ok(!cards().some((c: any) => String(c._html ?? "").includes("onerror")), "and nothing went through innerHTML");
	dom.dispose();
});

test("Yes posts the finding's id and this conversation, nothing else, and shows where it runs", { timeout: 20_000 }, async () => {
	const { dom, cards, texts, click } = await inboxPage({ "/inbox/claim": { ok: true, id: DECISION_CARD.id, delivery: "terminal", conversation: "01a0", line: "Queued for your terminal." } });
	await click(cards()[0], "Yes, do it");
	const post = dom.calls.find((c) => c.url === "/inbox/claim");
	assert.deepEqual(post?.body, { id: DECISION_CARD.id, from: SESSION_UNDER_TEST });
	assert.equal(post?.headers?.["x-pi-web-token"], "test-token");
	assert.ok(cards().some((c: any) => c.dataset.inb === DECISION_CARD.id && texts(c).includes("Queued for your terminal.")), "the card says where it runs");
	dom.dispose();
});

test("No then Not a bug posts that reason and says it goes to the loop's next run", { timeout: 20_000 }, async () => {
	const { dom, cards, texts, click } = await inboxPage({ "/inbox/dismiss": { ok: true, id: DECISION_CARD.id, told: { told: "loop", loop: "issue-triage" }, line: "Dismissed. Your reason goes to issue-triage's next run." } });
	const decision = cards()[0];
	const why = decision.children.find((c: any) => c.className === "why");
	assert.equal(why.hidden, true, "the reasons wait behind No\u2026");
	await click(decision, "No\u2026");
	assert.equal(why.hidden, false);
	await click(decision, "Not a bug");
	assert.deepEqual(dom.calls.find((c) => c.url === "/inbox/dismiss")?.body, { id: DECISION_CARD.id, reason: "Not a bug" });
	assert.ok(cards().some((c: any) => texts(c).some((t) => /goes to issue-triage's next run/.test(t))));
	dom.dispose();
});

test("a typed reason is sent as typed, and the field holds at most 500 characters", { timeout: 20_000 }, async () => {
	const { dom, cards, click } = await inboxPage({ "/inbox/dismiss": { ok: true, line: "Dismissed." } });
	const news = cards()[1];
	const field = news.children.find((c: any) => c.className === "why").children.find((c: any) => c.tag === "input");
	assert.equal(field.maxLength, 500);
	field.value = "  generated file, ignore it ";
	await click(news, "Send");
	assert.deepEqual(dom.calls.find((c) => c.url === "/inbox/dismiss")?.body, { id: NEWS_CARD.id, reason: "generated file, ignore it" });
	dom.dispose();
});

test("a finding another page already handled says so; a failed post keeps the buttons", { timeout: 20_000 }, async () => {
	const taken = await inboxPage({ "/inbox/claim": { __status: 409, __body: { error: "already claimed", status: "claimed" } } });
	await taken.click(taken.cards()[0], "Yes, do it");
	assert.ok(taken.cards().some((c: any) => taken.texts(c).includes("Already claimed.")), "not 'elsewhere': the claim that won may be this very conversation's");
	taken.dom.dispose();
	const down = await inboxPage({ "/inbox/claim": { __status: 503, __body: { error: "pi-loops is restarting" } } });
	const card = down.cards()[0];
	await down.click(card, "Yes, do it");
	assert.ok(down.texts(card).includes("Not sent: pi-loops is restarting. Try again."));
	assert.equal(down.button(card, "Yes, do it").disabled, false, "and Yes can be pressed again");
	down.dom.dispose();
});

test("See the run opens the run's lines read-only, as text", { timeout: 20_000 }, async () => {
	const { dom, cards, click } = await inboxPage({ "/inbox/run": { id: DECISION_CARD.id, runId: "run-1", lines: [{ kind: "assistant", text: "found <script>x</script> in the log" }] } });
	await click(cards()[0], "See the run");
	assert.ok(dom.calls.some((c) => c.url === `/inbox/run?id=${DECISION_CARD.id}`));
	const detail = (globalThis as any).document.getElementById("detail");
	assert.equal(detail.open, true);
	const body = (globalThis as any).document.getElementById("detailBody");
	assert.deepEqual(body.children.map((c: any) => c._text), ["assistant: found <script>x</script> in the log"]);
	assert.ok(!dom.calls.some((c) => c.body !== undefined && c.url.includes("/inbox/run")), "nothing is posted");
	const close = (globalThis as any).document.getElementById("detailClose");
	assert.equal(typeof close.onclick, "function", "the dialog's close button is wired: it sits in no form that would close it");
	close.onclick();
	assert.equal(detail.open, false, "and closes the dialog");
	dom.dispose();
});

test("inbox card buttons are at least 32 px tall and the card wraps rather than scroll sideways", () => {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(src, /\.icard button\{min-height:32px/);
	assert.match(src, /@media \(pointer:coarse\)\{button,select,\.icard button\{min-height:40px\}\}/, "a touch screen gets the 40 px every button there gets");
	assert.match(src, /\.icard\{[^}]*overflow-wrap:anywhere/);
	assert.match(src, /\.icard \.acts,\.icard \.why\{display:flex;flex-wrap:wrap/);
	assert.match(src, /\.icard \.why\[hidden\]\{display:none\}/, "the reasons stay hidden until No: a display rule would otherwise beat the hidden attribute");
});

test("a claim's card follows the server: queued while its row waits, then says it was handed over; the counts are asked for again at once", { timeout: 20_000 }, async () => {
	const { dom, cards, texts, click, answers } = await inboxPage({ "/inbox/claim": { ok: true, id: DECISION_CARD.id, delivery: "page", conversation: "01a0", line: "Running in its conversation." } });
	const before = dom.calls.length;
	// The server now lists it as handled, with the line of where it waits.
	answers["/inbox?"] = { ...INBOX, cards: [NEWS_CARD], handled: [{ ...DECISION_CARD, status: "claimed", line: "Queued for your terminal." }] };
	await click(cards()[0], "Yes, do it");
	await new Promise((r) => setTimeout(r, 200));
	const after = dom.calls.slice(before).map((c) => c.url);
	assert.ok(after.some((u) => u.startsWith("/conversations?")), `the list's counts are asked for again with the cards; got ${after.join(", ")}`);
	assert.ok(after.some((u) => u.endsWith("/state")), "and the panel's");
	// The card on the screen now: the newest one drawn for it (a redraw makes new elements).
	const card = () => cards().filter((c: any) => c.dataset.inb === DECISION_CARD.id).at(-1);
	assert.ok(texts(card()).includes("Queued for your terminal."), "the server's handled line, not the answer's");
	// The turn ran: the row is gone, the finding is no longer handled.
	answers["/inbox?"] = { ...INBOX, cards: [NEWS_CARD], handled: [] };
	await (globalThis as any).document.getElementById("project").onchange();
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(card() && texts(card()).includes("Handed to that conversation."), "not 'Running in' until a reload");
	dom.dispose();
});

test("a disabled See the run looks disabled, and a disabled button does not change on hover", () => {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(src, /\.icard button:disabled\{[^}]*opacity:\.45[^}]*cursor:default/);
	assert.doesNotMatch(src, /\.icard button:disabled:hover\{background:transparent/, "a transparent hover outranks button.primary: a disabled Yes would lose its amber");
	assert.match(src, /\.icard button:disabled:not\(\.primary\):hover\{background:transparent;color:var\(--muted\)\}/, "an ordinary one keeps its resting look");
	assert.match(src, /\.icard button\.primary:disabled:hover\{background:var\(--brand\);color:var\(--brand-ink\);filter:none\}/, "and the amber one keeps its amber");
});

test("a claim whose row is taken before the page looks again says it was handed over, at once", { timeout: 20_000 }, async () => {
	const { dom, cards, texts, click, answers } = await inboxPage({ "/inbox/claim": { ok: true, id: DECISION_CARD.id, delivery: "terminal", conversation: "01a0", line: "Queued for your terminal." } });
	// The terminal takes the row within a second: the first refresh after the claim no longer lists it.
	answers["/inbox?"] = { ...INBOX, cards: [NEWS_CARD], handled: [] };
	await click(cards()[0], "Yes, do it");
	await new Promise((r) => setTimeout(r, 200));
	const card = cards().filter((c: any) => c.dataset.inb === DECISION_CARD.id).at(-1);
	assert.ok(texts(card).includes("Handed to that conversation."), texts(card).filter(Boolean).join(" | "));
	dom.dispose();
});

/* ---------------- Watch for…: a watch from one sentence ---------------- */

const WATCH_EXAMPLE = "When ~/build.done appears, run cargo test and show me the result";
const soon = () => new Date(Date.now() + 5000).toISOString();
function rulePlan(over: Record<string, unknown> = {}) {
	return {
		id: "wp-0123456789abcdef", sessionId: "01a0", createdAt: new Date().toISOString(), expiresAt: soon(),
		plan: { kind: "rule", rule: { condition: "~/build.done appears", action: "run cargo test and show me the result", cwd: "/work/api" }, where: "chat", once: true },
		card: { kind: "rule", when: "~/build.done appears", looksEverySecs: 600, does: "run cargo test and show me the result", command: "/new-trigger when ~/build.done appears, run cargo test and show me the result" },
		...over,
	};
}
function schedulePlan(over: Record<string, unknown> = {}) {
	return {
		id: "wp-fedcba9876543210", sessionId: "01a0", createdAt: new Date().toISOString(), expiresAt: soon(),
		plan: { kind: "schedule", job: { schedule: { kind: "cron", expr: "0 9 * * *" }, prompt: "read TODO.md and tell me about new unchecked items", cwd: "/work/api" }, where: "inbox" },
		card: { kind: "schedule", when: "every day at 09:00", next: "2026-11-06 09:00", does: "read TODO.md and tell me about new unchecked items", command: '/cron add --stateful "0 9 * * *" read TODO.md and tell me about new unchecked items' },
		...over,
	};
}
/** Every text node under an element, in order: what a person reads on the card. */
function treeText(el: any): string {
	return [el._text ?? "", ...(el.children ?? []).map(treeText)].filter(Boolean).join(" ");
}
/** The parts of a plan card the tests act on, found from the card element itself. */
function cardParts(card: any) {
	const buttons = (el: any): any[] => (el.children ?? []).flatMap((c: any) => (c.tag === "button" ? [c, ...buttons(c)] : buttons(c)));
	const all = buttons(card);
	const chip = (key: string) => all.find((b) => b.dataset?.key === key);
	const foot = card.children.find((c: any) => c.className === "foot");
	const acts = foot?.children.find((c: any) => c.className === "acts");
	assert.ok(foot && acts, "the card ends in a footer that holds the hint, the status and the buttons");
	assert.ok(foot.children.some((c: any) => /Not right\?/.test(c._text)), "the hint is in the footer, so it stays in view with the buttons");
	return {
		text: treeText(card),
		chip,
		on: all.filter((b) => b.className === "on").map((b) => b._text),
		set: acts.children.find((b: any) => b._text === "Set it up"),
		cancel: acts.children.find((b: any) => b._text === "Cancel"),
		again: acts.children.find((b: any) => b._text === "Read it again"),
		status: foot.children.find((c: any) => c.className === "cstat")?._text ?? "",
	};
}
async function watchPage(answers: Record<string, unknown> = {}) {
	const dom = stubDom({ ...STATE, cwd: "/work/api" }, { messages: [] }, new Map(), answers);
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = (globalThis as any).document;
	const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
	const cards = (where: "modal" | "feed") => dom.made.filter((m: any) => m.className === "plan" && (where === "modal") === (m._parent === doc.getElementById("watchCards")));
	const read = async (sentence: string) => {
		doc.getElementById("watchText").value = sentence;
		doc.getElementById("watchRead").onclick();
		await new Promise((r) => setTimeout(r, 50));
	};
	const toolResult = (watch: unknown) => send({ type: "message_end", message: { role: "toolResult", toolName: "new_trigger", toolCallId: "c1", content: [{ type: "text", text: "drafted, not created" }], details: { watch } } });
	const note = (watch: unknown) => send({ type: "message_end", message: { role: "custom", customType: "pi-loops:watch", content: "pi-loops: watch plan …", display: true, details: { watch } } });
	return { dom, doc, send, cards, read, toolResult, note };
}

test("the Watch for… box opens with six examples, and an example fills it", { timeout: 20_000 }, async () => {
	const { dom, doc } = await watchPage();
	doc.getElementById("watchFor").onclick();
	const dlg = doc.getElementById("watch");
	assert.equal(dlg.open, true, "the box opened");
	assert.equal(doc.getElementById("watchTitle").textContent, "Watch for something in api");
	const ex = doc.getElementById("watchEx").children;
	assert.equal(ex.filter((e: any) => e.tag === "button").length, 6, "six examples");
	const texts = ex.filter((e: any) => e.tag === "button").map((e: any) => e._text);
	assert.ok(texts.includes(WATCH_EXAMPLE) && texts.includes("每 30 分钟看一下 CI，红了告诉我"), `English and Chinese: ${texts.join(" | ")}`);
	ex.find((e: any) => e._text === WATCH_EXAMPLE).onclick();
	assert.equal(doc.getElementById("watchText").value, WATCH_EXAMPLE, "the example is in the box");
	dom.dispose();
});

test("a sentence with no time and nothing to wait for gets the now card, and nothing is sent", { timeout: 20_000 }, async () => {
	const { dom, doc, read, send, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read("run the tests");
	assert.match(treeText(doc.getElementById("watchCards")), /This reads like something to do now, not something to watch\./);
	assert.ok(!dom.calls.some((c) => c.url.endsWith("/prompt")), "no message was sent");
	assert.equal(doc.getElementById("watchText").value, "run the tests", "and the box keeps the sentence");
	// Weekdays, nightly, noon and midnight are times too; a bare "now" or "fix" is not.
	for (const sentence of ["Nightly, back up the database", "At noon check CI", "Ping me on Friday about the release", "remind me at noon", "On Mondays, summarise merged PRs", "Weekly digest of open issues", "在周一提醒我", "Saturdays, run the backup", "Sundays, send me the digest", "Mondays and Thursdays, summarise merged PRs", "at 9am read the inbox", "at 7pm summarise the day", "in an hour check the deploy", "in 20 minutes ping me", "twice a day look at CI", "weeknights, back up the notes", "later today remind me about the release"]) {
		await read(sentence);
		assert.deepEqual(dom.calls.filter((c) => c.url.endsWith("/prompt")).at(-1)?.body, { text: `Watch for: ${sentence}`, images: [] }, `${sentence} goes to the model`);
		send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: `Watch for: ${sentence}` }] } });
		send({ type: "agent_end" });
	}
	const prompts = () => dom.calls.filter((c) => c.url.endsWith("/prompt")).length;
	for (const sentence of ["run the tests now", "fix the failing test", "Run the tests"]) {
		const before = prompts();
		await read(sentence);
		assert.equal(prompts(), before, `${sentence} is a thing to do now`);
	}
	// Every example reaches the model as the chat message `Watch for: <sentence>`.
	const examples = doc.getElementById("watchEx").children.filter((e: any) => e.tag === "button").map((e: any) => e._text);
	for (const sentence of examples) {
		await read(sentence);
		const sent = dom.calls.filter((c) => c.url.endsWith("/prompt")).at(-1);
		assert.deepEqual(sent?.body, { text: `Watch for: ${sentence}`, images: [] }, sentence);
		send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: `Watch for: ${sentence}` }] } });
		send({ type: "agent_end" });
	}
	assert.equal(cards("modal").filter((c: any) => c.className === "plan").length, 0, "no plan card: these were not answered with one");
	dom.dispose();
});

test("a plan in a tool result draws the card with its defaults, in the modal and in the transcript", { timeout: 20_000 }, async () => {
	const { dom, doc, read, toolResult, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	assert.equal(doc.getElementById("watchStatus").textContent, "pi is reading it…");
	toolResult(rulePlan());
	assert.equal(cards("modal").length, 1, "one card in the box");
	assert.equal(cards("feed").length, 1, "and one in the transcript");
	const card = cardParts(cards("modal")[0]);
	assert.match(card.text, /When something happens/);
	assert.match(card.text, /~\/build\.done appears/);
	assert.match(card.text, /every 10 minutes while this is on/);
	assert.match(card.text, /Each look is one model check\. It can be up to 10 minutes late\./);
	assert.match(card.text, /run cargo test and show me the result/);
	assert.match(card.text, /\/new-trigger when ~\/build\.done appears/);
	assert.deepEqual(card.on, ["Show it in this conversation", "Once, then turn itself off"], "the defaults: this conversation, once");
	assert.match(card.text, /Put it in my inbox/, "the rule's other chip: a matched rule's result reaches the inbox and the strip");
	assert.doesNotMatch(card.text, /Keep it out of this conversation|activity and audit/, "the wording from before rule results reached the inbox is gone");
	assert.equal(doc.getElementById("watchStatus").hidden, true, "the reading line is gone");
	assert.ok(card.cancel && card.set, "Cancel and Set it up");
	assert.deepEqual(cards("modal")[0]._scrolledTo, { block: "start" }, "the card is scrolled to the top of the box, so what it says comes before its buttons");
	assert.equal(card.cancel._parent.children.indexOf(card.cancel) < card.cancel._parent.children.indexOf(card.set), true, "Cancel first, so Enter hits it");

	// A schedule: the inbox by default, with what the inbox means.
	await read("Every morning at 9, read TODO.md and tell me about new unchecked items");
	toolResult(schedulePlan());
	const daily = cardParts(cards("modal").at(-1));
	assert.match(daily.text, /On a schedule/);
	assert.match(daily.text, /every day at 09:00 · next 2026-11-06 09:00/);
	assert.deepEqual(daily.on, ["Put it in my inbox"]);
	assert.match(daily.text, /Keeps notes between runs, so it reports only what changed/);
	assert.doesNotMatch(daily.text, /Repeats/, "a schedule has no Repeats row");
	assert.doesNotMatch(daily.text, /independent checker/, "no checker unless asked for");
	await read("Every morning at 9, read TODO.md and tell me about new unchecked items, double-checked");
	toolResult(schedulePlan({ id: "wp-00000000000000ee", card: { ...schedulePlan().card, verify: true } }));
	assert.match(cardParts(cards("modal").at(-1)).text, /Checks:.*an independent checker reviews each finding before it enters the inbox/, "verify is on the card");
	// A dangerous action is named on the card.
	await read("When the build lands, rm -rf ~/build and tell me");
	toolResult(rulePlan({ id: "wp-00000000000000aa", card: { ...rulePlan().card, does: "rm -rf ~/build", danger: "rm recursive+force on $HOME or ~" } }));
	assert.match(cardParts(cards("modal").at(-1)).text, /nobody is asked: pi-loops refuses rm recursive\+force on \$HOME or ~/);
	dom.dispose();
});

test("the card's chips change what Set it up posts, and Cancel posts cancel", { timeout: 20_000 }, async () => {
	const { dom, doc, read, toolResult, note, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	toolResult(rulePlan());
	const card = cardParts(cards("modal")[0]);
	card.chip("inbox").onclick();
	card.chip("every").onclick();
	assert.deepEqual(cardParts(cards("modal")[0]).on, ["Put it in my inbox", "Every time it happens"]);
	card.set.onclick();
	await new Promise((r) => setTimeout(r, 50));
	const posted = dom.calls.filter((c) => c.url.endsWith("/watch"));
	assert.deepEqual(posted.map((c) => c.body), [{ planId: "wp-0123456789abcdef", verdict: "set", where: "inbox", once: false }], "only the id, the verdict and the two choices");
	assert.equal(card.set.disabled, true, "not clickable twice");
	assert.equal(cardParts(cards("modal")[0]).status, "setting it up…");
	note({ kind: "created", planId: "wp-0123456789abcdef", id: `dyn-${"c".repeat(32)}`, plan: rulePlan().plan });

	await read("When $HOME/helloworld exists, print its contents");
	toolResult(rulePlan({ id: "wp-00000000000000bb" }));
	cardParts(cards("modal").at(-1)).cancel.onclick();
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(dom.calls.filter((c) => c.url.endsWith("/watch")).at(-1)?.body, { planId: "wp-00000000000000bb", verdict: "cancel", where: "chat", once: true });
	note({ kind: "cancelled", planId: "wp-00000000000000bb" });
	// A schedule's chip flipped to this conversation.
	await read("Every morning at 9, read TODO.md and tell me about new unchecked items");
	toolResult(schedulePlan());
	const daily = cardParts(cards("modal").at(-1));
	daily.chip("chat").onclick();
	daily.set.onclick();
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(dom.calls.filter((c) => c.url.endsWith("/watch")).at(-1)?.body, { planId: "wp-fedcba9876543210", verdict: "set", where: "chat", once: true });
	note({ kind: "created", planId: "wp-fedcba9876543210", id: `cron-${"d".repeat(32)}`, plan: schedulePlan().plan });
	dom.dispose();
});

test("a pi-loops:watch note turns the card into a receipt", { timeout: 20_000 }, async () => {
	const { dom, doc, read, toolResult, note, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	toolResult(rulePlan());
	note({ kind: "created", planId: "wp-0123456789abcdef", id: `dyn-${"c".repeat(32)}`, plan: rulePlan().plan });
	for (const where of ["modal", "feed"] as const) {
		const card = cardParts(cards(where)[0]);
		assert.equal(card.status, "Set up dyn-cccccccc · shows here · once", where);
		assert.equal(card.set.disabled, true, `${where}: settled`);
	}
	// The note's own line is drawn too, as any note is.
	assert.match(dom.rendered(), /pi-loops: watch plan …/);
	await read("Every morning at 9, read TODO.md and tell me about new unchecked items");
	toolResult(schedulePlan());
	note({ kind: "created", planId: "wp-fedcba9876543210", id: `cron-${"d".repeat(32)}`, plan: schedulePlan().plan });
	assert.equal(cardParts(cards("modal").at(-1)).status, "Set up cron-ddddddd · inbox");
	await read("When $HOME/helloworld exists, print its contents");
	toolResult(rulePlan({ id: "wp-00000000000000bb" }));
	note({ kind: "cancelled", planId: "wp-00000000000000bb" });
	assert.equal(cardParts(cards("modal").at(-1)).status, "Not set up");
	await read("When a PR of mine gets a review asking for changes, tell me");
	toolResult(rulePlan({ id: "wp-00000000000000cc" }));
	note({ kind: "failed", planId: "wp-00000000000000cc", error: 'a cron job named "nightly" already exists' });
	const failed = cardParts(cards("modal").at(-1));
	assert.equal(failed.status, 'Not set up: a cron job named "nightly" already exists');
	assert.ok(failed.again, "and offers to read it again");
	// A note that arrives before its card (a reload replays them in order; a live one may not) still settles it.
	note({ kind: "created", planId: "wp-00000000000000dd", id: `dyn-${"e".repeat(32)}`, plan: rulePlan().plan });
	toolResult(rulePlan({ id: "wp-00000000000000dd" }));
	assert.equal(cardParts(cards("feed").at(-1)).status, "Set up dyn-eeeeeeee · shows here · once");
	dom.dispose();
});

test("an expired card cannot be clicked, and a gone answer says to read the sentence again", { timeout: 20_000 }, async () => {
	const { dom, doc, read, toolResult, note, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	toolResult(rulePlan({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
	const stale = cardParts(cards("modal")[0]);
	assert.equal(stale.status, "This draft is gone. Read the sentence again.");
	assert.equal(stale.set.disabled, true);
	assert.equal(stale.cancel.disabled, true);
	await read("When $HOME/helloworld exists, print its contents");
	toolResult(rulePlan({ id: "wp-00000000000000bb" }));
	note({ kind: "gone", planId: "wp-00000000000000bb" });
	const gone = cardParts(cards("modal").at(-1));
	assert.equal(gone.status, "This draft is gone. Read the sentence again.");
	assert.ok(gone.again);
	assert.ok(!dom.calls.some((c) => c.url.endsWith("/watch")), "nothing was posted");
	dom.dispose();
});

test("a turn that ends with no plan shows pi's reply and keeps the box", { timeout: 20_000 }, async () => {
	const { dom, doc, read, send } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read("When the build is done, tell me");
	send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Watch for: When the build is done, tell me" }] } });
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Which file says the build is done?" }] } });
	send({ type: "agent_end" });
	const cards = doc.getElementById("watchCards");
	assert.match(treeText(cards), /pi needs more before it can set this up/);
	assert.match(treeText(cards), /Which file says the build is done\?/);
	assert.match(treeText(cards), /Edit the sentence above and read it again\./);
	assert.equal(doc.getElementById("watchText").value, "When the build is done, tell me");
	assert.equal(doc.getElementById("watch").open, true, "the box is still open");
	dom.dispose();
});

test("a terminal that holds the conversation answers the sentence there", { timeout: 20_000 }, async () => {
	const { dom, doc, read } = await watchPage({ "/prompt": { success: true, queued: "r1", elsewhere: { pid: 4242 } } });
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	// What a terminal does with it, and no more: new_trigger asks there; cron_create creates there at once.
	assert.equal(doc.getElementById("watchStatus").textContent, "Your terminal has this conversation (pid 4242) and answers what you send: a rule asks you there first; a schedule is set up there without a question.");
	assert.equal(doc.getElementById("watchStatus").hidden, false);
	assert.ok(!dom.calls.some((c) => c.url.endsWith("/watch")));
	dom.dispose();
});

test("a sentence queued behind a busy turn waits for its own turn's plan, not the earlier turn's reply", { timeout: 20_000 }, async () => {
	const { dom, doc, read, send, toolResult, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	send({ type: "agent_start" });
	await read(WATCH_EXAMPLE);
	// The earlier turn ends first: its reply is not this sentence's answer.
	send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done with the earlier thing" }] } });
	send({ type: "agent_end" });
	assert.doesNotMatch(treeText(doc.getElementById("watchCards")), /pi needs more/, "no false 'needs more'");
	assert.equal(doc.getElementById("watchStatus").textContent, "pi is reading it…", "still waiting");
	// Then the sentence's own turn: pi echoes it, and the plan lands in the box.
	send({ type: "agent_start" });
	send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: `Watch for: ${WATCH_EXAMPLE}` }] } });
	toolResult(rulePlan());
	assert.equal(cards("modal").length, 1, "the card is in the box");
	send({ type: "agent_end" });
	assert.doesNotMatch(treeText(doc.getElementById("watchCards")), /pi needs more/);
	dom.dispose();
});

test("closing the box keeps a waiting card; it is there when you reopen it", { timeout: 20_000 }, async () => {
	// The layout rule, pinned in the page's own stylesheet: the body scrolls, the menu does not, the
	// card's buttons stick to the bottom of what is in view.
	const page = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(page, /#watch\{[^}]*max-height:90dvh;overflow:hidden\}/);
	assert.match(page, /#watch\[open\]\{display:flex;flex-direction:column\}/, "a closed dialog stays closed: the flex layout applies only while it is open");
	assert.match(page, /#watchBody\{overflow:auto;min-height:0;flex:1 1 auto\}/);
	assert.match(page, /#watchCards \.plan \.foot\{position:sticky;bottom:0/, "the hint, the status and the buttons stick together, so the hint is never under the bar");
	const { dom, doc, read, toolResult, note, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	toolResult(rulePlan());
	const dlg = doc.getElementById("watch");
	const waiting = cards("modal")[0];
	// Closed by any means (the close button, a click outside, the browser's own Escape): the box
	// closes, and the card that waits for its click is there again when the box reopens.
	waiting._scrolledTo = undefined;
	doc.getElementById("watchClose").onclick();
	assert.equal(dlg.open, false, "the box closes");
	doc.getElementById("watchFor").onclick();
	assert.equal(dlg.open, true);
	assert.ok(doc.getElementById("watchCards").children.includes(waiting), "the waiting card is still in the box, the same one");
	assert.deepEqual(waiting._scrolledTo, { block: "start" }, "and is scrolled to the top of the box again, so its body is in view before its buttons");
	assert.ok(!cardParts(waiting).set.disabled, "and still clickable");
	assert.equal(dlg._on.cancel, undefined, "nothing is designed around Escape");
	note({ kind: "created", planId: "wp-0123456789abcdef", id: `dyn-${"c".repeat(32)}`, plan: rulePlan().plan });
	doc.getElementById("watchClose").onclick();
	doc.getElementById("watchFor").onclick();
	assert.ok(!doc.getElementById("watchCards").children.includes(waiting), "a settled card goes when the box reopens");
	dom.dispose();
});

test("a Set it up nobody answers in a minute gives the buttons back", { timeout: 20_000 }, async () => {
	const realSetTimeout = globalThis.setTimeout;
	const timers: Array<{ fn: () => void; ms: number }> = [];
	const { dom, doc, read, toolResult, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	toolResult(rulePlan());
	const card = cardParts(cards("modal")[0]);
	// Only the click's own wait is caught: the minute is run by hand, not waited for.
	(globalThis as any).setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return realSetTimeout(() => {}, 0); };
	try {
		card.set.onclick();
		await new Promise((r) => realSetTimeout(r, 50));
		assert.equal(card.set.disabled, true);
		const minute = timers.filter((t) => t.ms === 60000);
		assert.equal(minute.length, 1, "one minute-long wait was started");
		minute[0].fn();
		assert.equal(card.set.disabled, false, "Set it up is back");
		assert.equal(card.cancel.disabled, false);
		assert.equal(cardParts(cards("modal")[0]).status, "It did not go through: no answer in a minute. Try again.");
		dom.dispose();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});

test("a late answer after the give-back changes nothing, and a late note still settles the card", { timeout: 20_000 }, async () => {
	// The server's own rpc wait is a minute too: its "timed out" answer lands just after the page gave
	// the buttons back and used to overwrite the sentence; and once pi runs again the note arrives.
	const realSetTimeout = globalThis.setTimeout;
	const { dom, doc, read, toolResult, note, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	toolResult(rulePlan());
	const card = cardParts(cards("modal")[0]);
	const timers: Array<{ fn: () => void; ms: number }> = [];
	const realFetch = globalThis.fetch;
	let answer: (v: unknown) => void = () => undefined;
	const late = new Promise((resolve) => { answer = resolve; });
	(globalThis as any).fetch = async (url: unknown, opts?: unknown) => (String(url).endsWith("/watch") ? { status: 200, json: () => late } : realFetch(url as string, opts as RequestInit));
	(globalThis as any).setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return realSetTimeout(() => {}, 0); };
	try {
		card.set.onclick();
		await new Promise((r) => realSetTimeout(r, 20));
		timers.find((t) => t.ms === 60000)!.fn();
		assert.equal(cardParts(cards("modal")[0]).status, "It did not go through: no answer in a minute. Try again.");
		answer({ success: false, error: "timed out after 60000ms" });
		await new Promise((r) => realSetTimeout(r, 20));
		assert.equal(cardParts(cards("modal")[0]).status, "It did not go through: no answer in a minute. Try again.", "the late error does not overwrite the sentence");
		assert.equal(card.set.disabled, false, "and the buttons stay back");
		note({ kind: "created", planId: "wp-0123456789abcdef", id: `dyn-${"c".repeat(32)}`, plan: rulePlan().plan });
		assert.equal(cardParts(cards("modal")[0]).status, "Set up dyn-cccccccc · shows here · once", "the note that comes once pi runs again is the receipt");
		assert.equal(card.set.disabled, true);
		dom.dispose();
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.fetch = realFetch;
	}
});

test("a stale gone note does not overwrite a receipt", { timeout: 20_000 }, async () => {
	const { dom, doc, read, toolResult, note, cards } = await watchPage();
	doc.getElementById("watchFor").onclick();
	await read(WATCH_EXAMPLE);
	toolResult(rulePlan());
	note({ kind: "created", planId: "wp-0123456789abcdef", id: `dyn-${"c".repeat(32)}`, plan: rulePlan().plan });
	note({ kind: "gone", planId: "wp-0123456789abcdef" });
	for (const where of ["modal", "feed"] as const) assert.equal(cardParts(cards(where)[0]).status, "Set up dyn-cccccccc · shows here · once", where);
	await read("When $HOME/helloworld exists, print its contents");
	toolResult(rulePlan({ id: "wp-00000000000000bb" }));
	note({ kind: "cancelled", planId: "wp-00000000000000bb" });
	note({ kind: "gone", planId: "wp-00000000000000bb" });
	assert.equal(cardParts(cards("modal").at(-1)).status, "Not set up");
	dom.dispose();
});

/* ---------------- loop activity, the tab title and notifications (GET /activity) ---------------- */

const minAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
function activityAnswer(): any {
	const runs = [1, 2, 3, 4, 5].map((n) => ({ id: `run-${n}`, kind: "run", source: { id: "cron-1", name: "issue-triage", gone: false }, finishedAt: minAgo(6 - n), ok: true, stopped: false, findings: n === 2 ? 1 : 0, seconds: 5, carded: n <= 3, inboxIds: [], inChat: false, fromThisConversation: true }));
	const rule = { id: "t-1", kind: "rule", source: { id: "dyn-1", name: "~/build.done appears", gone: false }, finishedAt: minAgo(0), ok: true, stopped: false, findings: 1, seconds: 3, text: "hello, world <img src=x>", carded: false, inboxIds: [`inb-${"c".repeat(32)}`], inChat: false, fromThisConversation: true };
	return { cwd: "/work/api", items: [rule, ...runs.reverse()], more: 0, failed: 0, attention: { decisions: 1, news: 2, newDecisions: [{ id: "inb-d1", cwd: "/work/api", headline: "Ship it?" }], failing: [] } };
}

async function activityPage(answer: any, opts: { secure?: boolean; permission?: string } = {}) {
	const g = globalThis as any;
	const fired: Array<{ title: string; body: string; tag: string }> = [];
	let asked = 0;
	g.isSecureContext = opts.secure ?? true;
	g.Notification = class {
		static permission = opts.permission ?? "granted";
		static async requestPermission() {
			asked++;
			g.Notification.permission = "granted"; // as a browser does once the person says yes
			return "granted";
		}
		onclick: unknown;
		constructor(title: string, o: { body: string; tag: string }) {
			fired.push({ title, body: o.body, tag: o.tag });
		}
		close() {}
	};
	const dom = stubDom(STATE, { messages: [] }, new Map(), { "/activity": answer });
	await new Function(pageScript())();
	await new Promise((r) => setTimeout(r, 400));
	const doc = g.document;
	const slot = () => doc.getElementById("activitySlot");
	const texts = (el: any): string[] => [el._text, ...el.children.flatMap((c: any) => (c && typeof c === "object" ? texts(c) : []))];
	const done = () => {
		dom.dispose();
		delete g.Notification;
		delete g.isSecureContext;
	};
	return { dom, doc, slot, texts, fired, asked: () => asked, done };
}

test("the activity strip is one line until opened, then lists every run and rule result as text", { timeout: 20_000 }, async () => {
	const answer = activityAnswer();
	answer.items.push({ id: "odd", kind: "run", source: { id: 7, name: { evil: "<b>x</b>" }, gone: true }, finishedAt: minAgo(30), ok: false, stopped: false, error: 42, findings: "lots", seconds: "x", carded: true, inboxIds: "no" });
	const { dom, slot, texts, done } = await activityPage(answer);
	try {
		assert.ok(dom.calls.some((c) => c.url.startsWith("/activity?session=")), "asked of the global route");
		const closed = slot();
		assert.equal(closed.children.length, 1, "closed, the strip is its one line");
		const head = closed.children[0];
		assert.match(texts(head).join(" "), /loop activity · 6 runs today .*· 1 failed .*· 1 rule result/);
		head._on.click();
		const list = slot().children[1];
		assert.equal(list.children.length, 7, "open, a row for each item");
		const rows = list.children.map((li: any) => texts(li).join("|"));
		assert.match(rows[0], /rule ~\/build\.done appears · matched · in inbox · hello, world <img src=x>/);
		assert.equal(rows.filter((r: string) => r.includes("in chat")).length, 3, "the carded runs of this conversation say they are in it too; a row with no conversation does not");
		assert.equal(list.children[0].dataset.inb, `inb-${"c".repeat(32)}`, "a rule result points at its card");
		assert.match(rows[6], /\[object Object\] \(removed\) · 42/, "a field of any JSON type is drawn as text");
		assert.ok(!dom.made.some((m: any) => m.tag === "img" || m.tag === "b"), "and creates no element");
		head._on.click();
		assert.equal(slot().children.length, 1, "and closes again");
	} finally {
		done();
	}
});

test("the strip draws 96 items open within 200 ms", { timeout: 20_000 }, async () => {
	const answer = activityAnswer();
	answer.items = Array.from({ length: 96 }, (_, i) => ({ ...answer.items[1], id: `run-${i}`, finishedAt: minAgo(i * 15) }));
	const { slot, done } = await activityPage(answer);
	try {
		const t0 = performance.now();
		slot().children[0]._on.click();
		const ms = performance.now() - t0;
		assert.equal(slot().children[1].children.length, 96);
		assert.ok(ms < 200, `drawn in ${ms.toFixed(1)} ms`);
	} finally {
		done();
	}
});

test("the tab title counts this project's new decisions, then its news, each left out at zero", { timeout: 20_000 }, async () => {
	const answer = activityAnswer();
	const { dom, doc, done } = await activityPage(answer);
	try {
		assert.equal(doc.title, "(1⚑ 2) pi-loops");
		answer.attention = { ...answer.attention, decisions: 0 };
		await dom.poll();
		assert.equal(doc.title, "(2) pi-loops");
		answer.attention = { ...answer.attention, news: 0 };
		await dom.poll();
		assert.equal(doc.title, "pi-loops");
	} finally {
		done();
	}
});

test("a notification fires only while the tab is hidden, only once switched on, and never for news or what was there at load", { timeout: 20_000 }, async () => {
	const answer = activityAnswer();
	const { dom, doc, fired, asked, done } = await activityPage(answer, { permission: "default" });
	try {
		assert.equal(asked(), 0, "permission is asked only from the click");
		const toggle = doc.getElementById("notifyMe");
		assert.match(toggle._text, /: off$/);
		await toggle._on.click();
		assert.equal(asked(), 1);
		assert.match(toggle._text, /: on$/);
		answer.attention = { ...answer.attention, newDecisions: [{ id: "inb-d2", cwd: "/work/web", headline: "Merge it?" }, ...answer.attention.newDecisions] };
		await dom.poll();
		assert.equal(fired.length, 0, "a visible tab is not interrupted");
		doc.visibilityState = "hidden";
		answer.attention = { ...answer.attention, news: 9 };
		await dom.poll();
		assert.equal(fired.length, 0, "news never interrupts");
		answer.attention = { ...answer.attention, newDecisions: [{ id: "inb-d3", cwd: "/work/web", headline: "Deploy now?" }, ...answer.attention.newDecisions] };
		await dom.poll();
		assert.deepEqual(fired, [{ title: "A decision needs you", body: "Deploy now?", tag: "d:inb-d3" }], "a decision anywhere on the machine");
		answer.attention = { ...answer.attention, failing: [{ jobId: "cron-1", name: "issue-triage", streak: 3, key: "cron-1:7" }] };
		await dom.poll();
		await dom.poll();
		assert.equal(fired.length, 2, "a streak of three, once");
		assert.match(fired[1].body, /issue-triage has failed 3 times in a row/);
		answer.attention = { ...answer.attention, budget: { day: "2026-11-05", spent: 5.5, cap: 5 } };
		await dom.poll();
		assert.match(fired[2].body, /reached its \$5\.00 budget/);
		doc.visibilityState = "visible";
	} finally {
		done();
	}
});

test("on plain http the notification switch says it needs https or localhost and does nothing", { timeout: 20_000 }, async () => {
	const { doc, asked, done } = await activityPage(activityAnswer(), { secure: false });
	try {
		const toggle = doc.getElementById("notifyMe");
		assert.equal(toggle._text, "notifications need https or localhost");
		assert.equal(toggle.disabled, true);
		await toggle._on.click();
		assert.equal(asked(), 0);
	} finally {
		done();
	}
});

test("the strip stays one line on a phone and nothing in it scrolls sideways", () => {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(src, /#activitySlot \.strip-head\{[^}]*white-space:nowrap;overflow:hidden/);
	assert.match(src, /#activitySlot li \.t\{overflow:hidden;text-overflow:ellipsis/);
	assert.match(src, /#activitySlot ul\{[^}]*overflow-y:auto;overflow-x:hidden/);
	assert.match(src, /@media \(max-width:760px\)\{[\s\S]*?#activitySlot ul\{max-height:50vh\}/, "open on a phone, a sheet that scrolls inside itself");
	assert.match(src, /<title>pi-loops<\/title>/);
});

test("a rule result's card names its rule's condition on the origin line", { timeout: 20_000 }, async () => {
	const RULE_CARD = { ...NEWS_CARD, id: "inb-" + "c".repeat(32), headline: "hello, world.", body: "test result: ok", origin: "rule", source: "trigger:local:dynamic", rule: { id: "dyn-1", condition: "when ~/build.done appears" } };
	const { dom, cards, texts } = await inboxPage({ "/inbox?": { ...INBOX, cards: [RULE_CARD] } });
	assert.ok(texts(cards()[0]).some((t) => t.startsWith("rule when ~/build.done appears")), texts(cards()[0]).join("|"));
	dom.dispose();
});

/* ---------------- a terminal-held conversation read again, and a reload during a reload ---------------- */

const feedText = () => {
	const walk = (el: any): string => [el._text ?? "", el._html ?? "", ...(el.children ?? []).map(walk)].join(" ");
	return walk((globalThis as any).document.getElementById("feed"));
};

test("a reload that starts while another replays what it held draws each message once, in order", { timeout: 20_000 }, async () => {
	// The shape that drew the conversation twice: a gap starts a reload, and while its /history is
	// out the server's epoch changes, so the events held for the replay carry the new one. Replaying
	// the first starts a second reload, which clears the feed; the replay must not go on drawing the
	// rest into it, or the second reload's history draws them again.
	const state: any = { ...STATE, seq: 5, epoch: "aaa" };
	const history: any = { messages: [{ role: "assistant", content: [{ type: "text", text: "LATE" }] }], seq: 5, epoch: "aaa" };
	const dom = stubDom(state, history);
	const g = globalThis as any;
	const realFetch = g.fetch;
	const answers: any[] = [];
	g.fetch = async (url: unknown, opts?: any) => {
		const r = await realFetch(url, opts);
		if (!String(url).includes("/history") || !answers.length) return r;
		const snap = answers.length > 1 ? answers.shift() : answers[0];
		return { status: 200, json: async () => snap };
	};
	try {
		await new Function(pageScript())();
		await new Promise((r) => setTimeout(r, 400));
		const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
		const before = dom.calls.length;
		answers.push({ ...history, seq: 5, epoch: "aaa" }, { messages: [...history.messages, { role: "user", content: [{ type: "text", text: "LATEQ" }] }], seq: 2, epoch: "bbb" });
		send({ type: "agent_end", seq: 7, epoch: "aaa" });
		state.seq = 2;
		state.epoch = "bbb";
		send({ type: "agent_start", seq: 1, epoch: "bbb" });
		send({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "LATEQ" }] }, seq: 2, epoch: "bbb" });
		await new Promise((r) => setTimeout(r, 300));
		const text = feedText();
		assert.equal((text.match(/LATEQ/g) ?? []).length, 1, `the held message is drawn once; the feed: ${text.replace(/\s+/g, " ").trim()}`);
		assert.match(text, /LATE(?!Q)[\s\S]*LATEQ/, "and after the message before it");
		assert.equal(dom.calls.slice(before).filter((c) => c.url.includes("/history")).length, 2, "the second reload still happens: it is what brings the new epoch's messages");
	} finally {
		dom.dispose();
	}
});

test("the terminal's answer arrives as one numbered reread: one reload, with its reason, and no gap after it", { timeout: 20_000 }, async () => {
	const state: any = { ...STATE, seq: 3, epoch: "aaa" };
	const history: any = { messages: [{ role: "user", content: [{ type: "text", text: "QUESTION" }] }], seq: 3, epoch: "aaa" };
	const dom = stubDom(state, history);
	try {
		await new Function(pageScript())();
		await new Promise((r) => setTimeout(r, 400));
		const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
		const before = dom.calls.length;
		history.messages = [...history.messages, { role: "assistant", content: [{ type: "text", text: "ANSWER" }] }];
		history.seq = 4;
		send({ type: "reread", why: "your terminal answered — the conversation above was read again", seq: 4, epoch: "aaa" });
		await new Promise((r) => setTimeout(r, 200));
		send({ type: "message_start", seq: 5, epoch: "aaa" });
		await new Promise((r) => setTimeout(r, 200));
		const text = feedText();
		assert.equal(dom.calls.slice(before).filter((c) => c.url.includes("/history")).length, 1, "one reload, and the next event is no gap");
		assert.match(text, /your terminal answered/);
		assert.doesNotMatch(text, /reconnected|session restarted/, "the reason is the reread's, not a guess");
		assert.equal((text.match(/ANSWER/g) ?? []).length, 1);
	} finally {
		dom.dispose();
	}
});

test("while the terminal answers, the held line says since when", { timeout: 20_000 }, async () => {
	const since = new Date(Date.now() - 60_000).toISOString();
	const dom = stubDom({ ...STATE, holder: { kind: "terminal", pid: 9, mine: false, delivers: true, aside: false, piLoops: true, turnSince: since } }, { messages: [] });
	try {
		await new Function(pageScript())();
		await new Promise((r) => setTimeout(r, 400));
		const held = (globalThis as any).document.getElementById("held");
		const words = [held._text, ...held.children.map((c: any) => c._text)].join(" ");
		assert.match(words, /answering since \d/);
	} finally {
		dom.dispose();
	}
});

test("a day of rule results and no runs does not lead with 0 runs", { timeout: 20_000 }, async () => {
	const answer = activityAnswer();
	answer.items = answer.items.filter((i: any) => i.kind === "rule");
	const { slot, texts, done } = await activityPage(answer);
	try {
		assert.equal(texts(slot().children[0]).join(" ").replace(/\s+/g, " ").trim(), "loop activity · 1 rule result ▸");
	} finally {
		done();
	}
});

test("a held conversation read again shows its three run cards, and a card saved while the page looks is drawn as it lands", { timeout: 20_000 }, async () => {
	const card = (title: string) => ({ role: "pi-loops:view", title, lines: [] });
	const state: any = { ...STATE, seq: 3, epoch: "aaa" };
	const history: any = { messages: [{ role: "user", content: [{ type: "text", text: "start a loop" }] }, card("cron todo · 5s · 0 findings"), card("cron todo · 4s · 1 finding"), card("cron todo FAILED · 2s · <b>500</b>")], seq: 3, epoch: "aaa" };
	const dom = stubDom(state, history);
	try {
		await new Function(pageScript())();
		await new Promise((r) => setTimeout(r, 400));
		const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
		history.seq = 4;
		send({ type: "reread", why: "your terminal answered — the conversation above was read again", seq: 4, epoch: "aaa" });
		await new Promise((r) => setTimeout(r, 200));
		const text = feedText();
		assert.equal((text.match(/cron todo/g) ?? []).length, 3, `three cards after the reload; the feed: ${text.replace(/\s+/g, " ").trim()}`);
		assert.match(text, /start a loop[\s\S]*5s · 0 findings[\s\S]*4s · 1 finding[\s\S]*FAILED · 2s · <b>500<\/b>/, "in file order, as text");
		assert.ok(!dom.made.some((m: any) => m.tag === "b"), "a card's text creates no element");
		send({ type: "entry_appended", entry: { type: "custom", customType: "pi-loops:view", data: { title: "cron todo · 3s · 2 findings", lines: [] } }, seq: 5, epoch: "aaa" });
		send({ type: "entry_appended", entry: { type: "custom", customType: "trigger_result", data: { state: "completed" } }, seq: 6, epoch: "aaa" });
		await new Promise((r) => setTimeout(r, 100));
		assert.equal((feedText().match(/cron todo/g) ?? []).length, 4, "the card saved by the page's pi is drawn once; another entry is not");
	} finally {
		dom.dispose();
	}
});

test("the strip says in chat only for a carded run of the conversation on the screen", { timeout: 20_000 }, async () => {
	const answer = activityAnswer();
	answer.items = answer.items.filter((i: any) => i.kind === "run" && i.carded).map((i: any, n: number) => ({ ...i, fromThisConversation: n === 0 }));
	const { slot, texts, done } = await activityPage(answer);
	try {
		slot().children[0]._on.click();
		const rows = slot().children[1].children.map((li: any) => texts(li).join("|"));
		assert.deepEqual(rows.map((r: string) => r.includes("in chat")), [true, false, false], "a card another conversation got, or none, is no chat marker");
	} finally {
		done();
	}
});

test("a run card in the transcript and replayed as it landed is drawn once, by its entry id", { timeout: 20_000 }, async () => {
	const state: any = { ...STATE, seq: 3, epoch: "aaa" };
	const history: any = { messages: [{ role: "user", content: [{ type: "text", text: "start a loop" }] }, { role: "pi-loops:view", id: "c9", title: "cron todo · 5s · 0 findings", lines: [] }], seq: 3, epoch: "aaa" };
	const dom = stubDom(state, history);
	try {
		await new Function(pageScript())();
		await new Promise((r) => setTimeout(r, 400));
		const send = (ev: unknown) => dom.source().onmessage({ data: JSON.stringify(ev) });
		send({ type: "entry_appended", entry: { type: "custom", customType: "pi-loops:view", id: "c9", data: { title: "cron todo · 5s · 0 findings", lines: [] } }, seq: 4, epoch: "aaa" });
		send({ type: "entry_appended", entry: { type: "custom", customType: "pi-loops:view", id: "c10", data: { title: "cron todo · 4s · 1 finding", lines: [] } }, seq: 5, epoch: "aaa" });
		await new Promise((r) => setTimeout(r, 100));
		const text = feedText();
		assert.equal((text.match(/5s · 0 findings/g) ?? []).length, 1, "the card already in the transcript is not drawn again");
		assert.equal((text.match(/4s · 1 finding/g) ?? []).length, 1, "a new card is drawn");
		history.messages = [...history.messages, { role: "pi-loops:view", id: "c10", title: "cron todo · 4s · 1 finding", lines: [] }];
		history.seq = 6;
		send({ type: "reread", why: "your terminal answered — the conversation above was read again", seq: 6, epoch: "aaa" });
		await new Promise((r) => setTimeout(r, 200));
		assert.equal((feedText().match(/cron todo/g) ?? []).length, 2, "a reload draws each card once again");
	} finally {
		dom.dispose();
	}
});

test("opening the strip keeps the end of the conversation in view", { timeout: 20_000 }, async () => {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	assert.match(src, /#activitySlot\{[^}]*flex:none/, "the strip takes its own room below the feed, never over it");
	const { doc, slot, done } = await activityPage(activityAnswer());
	try {
		const feed = doc.getElementById("feed");
		feed.scrollHeight = 2000;
		feed.clientHeight = 600;
		feed.scrollTop = 1400;
		feed._on.scroll();
		feed.clientHeight = 380; // the open strip takes room from the feed
		slot().children[0]._on.click();
		assert.equal(feed.scrollTop, 2000, "the last row is still in view");
		feed.scrollTop = 100;
		feed._on.scroll();
		slot().children[0]._on.click();
		assert.equal(feed.scrollTop, 100, "a reader scrolled back is left where they are");
	} finally {
		done();
	}
});

/* ------------------------------------------------ loop rows: Stop this run, the signal, the suggestion */

const LOOP_RUN = `run-${"c".repeat(32)}`;
/** Every element under `root` (the stub's children), depth first. */
const allUnder = (root: any): any[] => [root, ...(root.children ?? []).flatMap((c: any) => (c && typeof c === "object" ? allUnder(c) : []))];
const loopSlot = () => (globalThis as any).document.getElementById("auto").querySelectorAll("[data-loopx]")[0];
const buttonIn = (root: any, label: string) => allUnder(root).find((e) => e.tag === "button" && e._text === label);
const press = (b: any) => b.onclick({ preventDefault() {}, stopPropagation() {} });
const loopState = (job: Record<string, unknown>, rules: unknown[] = []) => ({ ...STATE, automation: { ...STATE.automation, jobs: [{ id: "cron-aaaaaaaa", name: "pr-watch", schedule: "every 15m", stateful: true, enabled: true, prompt: "watch", runCount: 12, ...job }], rules } });

test("a running loop row has Stop this run; the confirm opens inline, survives a redraw, and Keep running closes it with nothing sent", { timeout: 20_000 }, async () => {
	const state = loopState({ running: true, run: { runId: LOOP_RUN, since: new Date(Date.now() - 120_000).toISOString() } });
	const dom = await startPage(state, { "/loops/stop": { ok: true, stopping: "run" } });
	try {
		assert.match(textOf(loopSlot()), /running 2m/);
		press(buttonIn(loopSlot(), "Stop this run"));
		assert.match(textOf(loopSlot()), /Stop this run of pr-watch\? Its notes are not updated\. The next run happens on schedule\./);
		assert.equal(buttonIn(loopSlot(), "Stop this run"), undefined, "the confirm takes the button's place");
		await dom.poll();
		assert.ok(buttonIn(loopSlot(), "Stop it"), "the 8-second redraw keeps the confirm open");
		press(buttonIn(loopSlot(), "Keep running"));
		assert.ok(buttonIn(loopSlot(), "Stop this run"));
		assert.doesNotMatch(textOf(loopSlot()), /Stop this run of/);
		assert.equal(dom.calls.filter((c) => c.url.includes("/loops/stop")).length, 0, "Keep running sends nothing");
	} finally {
		dom.dispose();
	}
});

test("Stop it posts the whole run id to /loops/stop; the row says stopping, then stopped by you once the run is gone", { timeout: 20_000 }, async () => {
	const state: any = loopState({ running: true, run: { runId: LOOP_RUN, since: new Date().toISOString() } });
	const dom = await startPage(state, { "/loops/stop": { ok: true, stopping: "run" } });
	try {
		press(buttonIn(loopSlot(), "Stop this run"));
		press(buttonIn(loopSlot(), "Stop it"));
		await new Promise((r) => setTimeout(r, 50));
		const sent = dom.calls.filter((c) => c.url.includes("/loops/stop"));
		assert.deepEqual(sent.map((c) => [c.url, c.body, c.headers?.["x-pi-web-token"]]), [["/loops/stop", { runId: LOOP_RUN }, "test-token"]], "not under /c/<session>/: it starts no pi");
		assert.match(textOf(loopSlot()), /stopping…/);
		state.automation.jobs[0] = { ...state.automation.jobs[0], running: false, run: undefined };
		await dom.poll();
		assert.match(textOf(loopSlot()), /Stopped by you\./);
		press(buttonIn(loopSlot(), "OK"));
		assert.doesNotMatch(textOf(loopSlot()), /Stopped by you/);
	} finally {
		dom.dispose();
	}
});

test("a run that ends while its confirm is open says so; a stop that came too late says the run finished first", { timeout: 20_000 }, async () => {
	const state: any = loopState({ running: true, schedule: "once at 09:00", run: { runId: LOOP_RUN, since: new Date().toISOString() } });
	const dom = await startPage(state, { "/loops/stop": { ok: false, finished: true } });
	try {
		press(buttonIn(loopSlot(), "Stop this run"));
		assert.match(textOf(loopSlot()), /It will not run again by itself\./, "a one-shot's confirm");
		state.automation.jobs[0] = { ...state.automation.jobs[0], running: false, run: undefined };
		await dom.poll();
		assert.match(textOf(loopSlot()), /This run has finished\./);
		assert.equal(buttonIn(loopSlot(), "Stop it"), undefined);
		press(buttonIn(loopSlot(), "OK"));
		state.automation.jobs[0] = { ...state.automation.jobs[0], running: true, run: { runId: `run-${"d".repeat(32)}`, since: new Date().toISOString() } };
		await dom.poll();
		press(buttonIn(loopSlot(), "Stop this run"));
		press(buttonIn(loopSlot(), "Stop it"));
		await new Promise((r) => setTimeout(r, 50));
		assert.match(textOf(loopSlot()), /It finished before the stop reached it\./);
	} finally {
		dom.dispose();
	}
});

test("a loop row shows its 30-day signal and one suggestion; Keep and the suggestion post only the job, the key and the choice", { timeout: 20_000 }, async () => {
	const suggestion = { kind: "slower", key: "slower:cron-aaaaaaaa:every 15m", label: "Run hourly instead" };
	const dom = await startPage(loopState({ signal: { findings30d: 6, claimed30d: 0, dismissed30d: 6, quietStreak: 12 }, suggestion }), { "/loops/tune": { ok: true, kept: true } });
	try {
		assert.match(textOf(loopSlot()), /30d: 6 findings · 0 claimed · 6 dismissed · quiet ×12/);
		assert.ok(buttonIn(loopSlot(), "Run hourly instead"));
		press(buttonIn(loopSlot(), "Keep"));
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(dom.calls.filter((c) => c.url === "/loops/tune").map((c) => c.body), [{ jobId: "cron-aaaaaaaa", key: suggestion.key, choice: "keep" }]);
	} finally {
		dom.dispose();
	}
});

test("a suggestion that changed under the page says so instead of acting; nothing applies itself", { timeout: 20_000 }, async () => {
	const suggestion = { kind: "pause", key: "pause:cron-aaaaaaaa:every 15m", label: "Pause" };
	const dom = await startPage(loopState({ signal: { findings30d: 6, claimed30d: 0, dismissed30d: 6, quietStreak: 0 }, suggestion }), { "/loops/tune": { __status: 409, __body: { error: "the suggestion changed" } } });
	try {
		await dom.poll();
		assert.equal(dom.calls.filter((c) => c.url === "/loops/tune").length, 0, "drawing a suggestion sends nothing");
		press(buttonIn(loopSlot(), "Pause"));
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(dom.calls.filter((c) => c.url === "/loops/tune").map((c) => c.body), [{ jobId: "cron-aaaaaaaa", key: suggestion.key, choice: "apply" }]);
		assert.match(textOf(loopSlot()), /The suggestion changed/);
	} finally {
		dom.dispose();
	}
});

test("a rule that waits for a path says what it waits for and when it looks next", { timeout: 20_000 }, async () => {
	const rule = { id: "dyn-1", condition: "~/build.done appears", action: "tell me", enabled: true, fireOnce: true, waitsFor: "~/build.done", look: "next look 09:22 · no model call until the file exists" };
	const dom = await startPage({ ...STATE, automation: { ...STATE.automation, rules: [rule, { id: "dyn-2", condition: "the build is green", action: "x", enabled: true }] } }, {});
	try {
		const looks = (globalThis as any).document.getElementById("auto").querySelectorAll("[data-rulelook]");
		assert.equal(looks.length, 1, "only the rule that waits for a path");
		assert.equal(looks[0]._text, "waits for ~/build.done · next look 09:22 · no model call until the file exists");
	} finally {
		dom.dispose();
	}
});

test("the loop row's confirm is built around clicks only, and at 390 px its buttons stack at full width and at least 32 px tall", () => {
	const src = fs.readFileSync(path.join(process.cwd(), "src", "web.mjs"), "utf8");
	const row = src.slice(src.indexOf("function drawLoopRow"), src.indexOf("function drawLoopRow") + 4000);
	assert.doesNotMatch(row, /keydown|Escape|key ===/, "no key handler: closing by any means loses nothing");
	const { rest } = pageStyle();
	assert.match(rest, /@media \(max-width:420px\)\{\.loopx \.acts button,\.loopx \.runline button,\.loopx \.confirm>button\{flex:1 1 100%;min-height:36px\}\}/);
	assert.match(rest, /\.loopx \.confirm\{[^}]*overflow-wrap:anywhere/, "long names wrap instead of pushing the panel sideways");
});

test("the strip says a run a person stopped was stopped by you, and any other stop just stopped", { timeout: 20_000 }, async () => {
	const answer = activityAnswer();
	answer.items = [
		{ id: "mine", kind: "run", source: { id: "cron-1", name: "pr-watch", gone: false }, finishedAt: minAgo(1), ok: false, stopped: true, stoppedBy: "person", findings: 0, seconds: 8, carded: false, inboxIds: [] },
		{ id: "quit", kind: "run", source: { id: "cron-1", name: "pr-watch", gone: false }, finishedAt: minAgo(2), ok: false, stopped: true, findings: 0, seconds: 8, carded: false, inboxIds: [] },
	];
	const { slot, texts, done } = await activityPage(answer);
	try {
		slot().children[0]._on.click();
		const rows = slot().children[1].children.map((li: any) => texts(li).join("|"));
		assert.match(rows[0], /pr-watch · stopped by you · 8s/);
		assert.match(rows[1], /pr-watch · stopped · 8s/);
		assert.doesNotMatch(rows[1], /by you/);
	} finally {
		done();
	}
});
