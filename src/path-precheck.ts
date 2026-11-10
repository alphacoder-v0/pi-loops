/**
 * The local pre-check: a rule whose condition is only "<path> exists / appears" is looked at with
 * `stat` before any model is asked about it (docs/triggers.md, "Rules that wait for a path").
 *
 * Whether a condition is path-only is decided once, when the rule is created, and recorded on the
 * rule (`precheck`): the creating process is the person's own window or page, so `~` is their home
 * even when the background process was started with another one. The grammar matches whole
 * strings and knows a fixed list of verbs. A refused condition is safe — the model checks it as it
 * always did — so every doubt (a glob, a second clause, an unknown variable) is a refusal, and each
 * refusal says why.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Recorded on a rule when it is created. `of` is the condition it was read from; `raw` the path as typed; `resolved` the absolute path. */
export interface PathWatch {
	v: 1;
	of: string;
	raw: string;
	resolved: string;
}

export type PathOnly = { watch: PathWatch } | { why: string };

/** Paths a `stat` would send over the network: an SMB/UNC share, an automount, a macOS server. */
const NETWORK = /^(?:\/\/|\/net\/|\/Network\/)/;
const NETWORK_WHY = "a network path needs the model";

/** A path longer than this is not something a person typed as a path. */
export const PATH_MAX_BYTES = 1024;
/** How long one look may take before it counts as `unknown` (a hung network mount). */
export const LOOK_TIMEOUT_MS = 2000;

const EN_VERBS = ["exists", "appears", "is created", "shows up", "is there", "is present"];
const ZH_VERBS = ["存在", "出现", "被创建", "生成"];
const ZH_NOUNS = ["文件", "目录"];
const EN_LEADS = ["when ", "if ", "once "];
const ZH_LEADS = ["当", "如果", "一旦"];
const ZH_TAILS = ["的时候", "时", "后"];
const EN_NOUN = /^(?:the\s+)?(?:(?:file|directory|folder|path)\s+)?/i;

/**
 * Whether `condition` is only "<path> exists / appears", and the path it waits for. `at.cwd` is the
 * rule's project (a relative path resolves there); `at.home` is the creating process's home.
 */
export function pathOnlyCondition(condition: string, at: { cwd: string; home: string }): PathOnly {
	let s = condition.trim().replace(/\s+/g, " ");
	if (!s) return { why: "the condition is empty" };
	s = s.replace(/[.。!！]$/, "").trim();
	const lower = s.toLowerCase();
	const enLead = EN_LEADS.find((w) => lower.startsWith(w));
	if (enLead) s = s.slice(enLead.length).trim();
	else {
		const zhLead = ZH_LEADS.find((w) => s.startsWith(w));
		if (zhLead) s = s.slice(zhLead.length).trim();
	}
	const zhTail = ZH_TAILS.find((w) => s.endsWith(w));
	if (zhTail) s = s.slice(0, -zhTail.length).trim();
	// "the file ~/x exists": the noun is only allowed in front of the path.
	s = s.replace(EN_NOUN, "");

	const token = pathToken(s);
	if ("why" in token) return token;
	let rest = token.rest.trim();
	// "exists (a build finished)": a person or a model appends one aside in parentheses after the
	// verb. Drop one trailing parenthetical before the verb check: while the path is absent the
	// condition is false either way, and once it is present the model still reads the whole thing.
	const aside = /^(.+) ?[(（](.*)[)）]$/.exec(rest);
	if (aside) rest = aside[1].trim();
	const verbWhy = verbOnly(rest);
	if (verbWhy) return { why: verbWhy };
	const bad = badPath(token.path);
	if (bad) return { why: bad };
	const resolved = resolvePath(token.path, at);
	// Again on the resolved path: `/./net/h/x` and `../../net/h/x` are network paths too.
	if (NETWORK.test(resolved)) return { why: NETWORK_WHY };
	return { watch: { v: 1, of: condition, raw: token.path, resolved } };
}

/** The path at the start of `s` (quoted, backticked, or one run without spaces) and what follows it. */
function pathToken(s: string): { path: string; rest: string } | { why: string } {
	const q = s[0];
	if (q === '"' || q === "'" || q === "`") {
		const end = s.indexOf(q, 1);
		if (end < 0) return { why: "a quote is not closed" };
		const p = s.slice(1, end);
		if (!p.trim()) return { why: "the quotes hold no path" };
		return { path: p, rest: s.slice(end + 1) };
	}
	const m = /^[^\s"'`]+/.exec(s);
	if (!m) return { why: "no path at the start of the condition" };
	let p = m[0];
	let rest = s.slice(p.length);
	// Chinese needs no space before the verb: "$HOME/x存在".
	for (const verb of ZH_VERBS) {
		const i = p.indexOf(verb);
		if (i > 0) {
			rest = p.slice(i) + rest;
			p = p.slice(0, i);
			break;
		}
	}
	// A noun at the end of the token is part of the path ("~/备份文件"): the noun before the verb is
	// only read off when a space sets it apart ("~/x 文件存在"), in verbOnly.
	return { path: p, rest };
}

/** Undefined when `rest` is exactly one verb of the list; otherwise why it is not. */
function verbOnly(rest: string): string | undefined {
	if (!rest) return "no verb: say that the path exists or appears";
	const lower = rest.toLowerCase();
	for (const verb of EN_VERBS) {
		if (lower === verb) return undefined;
		if (lower.startsWith(`${verb} `)) return `an extra clause after "${verb}" needs the model`;
	}
	let zh = rest;
	const noun = ZH_NOUNS.find((n) => zh.startsWith(n));
	if (noun) zh = zh.slice(noun.length).trim();
	for (const verb of ZH_VERBS) {
		if (zh === verb) return undefined;
		if (zh.startsWith(verb)) return `an extra clause after "${verb}" needs the model`;
	}
	return "not only that the path exists or appears";
}

/** Why `p` is not clearly one path, or undefined. */
function badPath(p: string): string | undefined {
	if (Buffer.byteLength(p, "utf8") > PATH_MAX_BYTES) return `the path is longer than ${PATH_MAX_BYTES} bytes`;
	if (/[\u0000-\u001f\u007f]/.test(p)) return "the path holds a control character";
	if (p.includes("://")) return "a URL is not a local path";
	if (NETWORK.test(p)) return NETWORK_WHY;
	if (/[*?[\]{}]/.test(p.replace(/^\$\{HOME\}/, ""))) return "a glob matches many paths, not one";
	if (/\$(?!HOME\/|\{HOME\}\/)/.test(p) || /.\$/.test(p)) return "only $HOME is expanded; another variable needs the model";
	if (/^~[^/]/.test(p)) return "only your own home (~/) is expanded";
	if (/^(?:~\/|\$HOME\/|\$\{HOME\}\/|\/|\.\.?\/)/.test(p)) return undefined;
	if (p.includes("/")) return undefined;
	if (/^[^/]+\.[A-Za-z0-9]{1,10}$/.test(p)) return undefined;
	return "not clearly a path: give it a /, a ~/ or a file extension";
}

function resolvePath(p: string, at: { cwd: string; home: string }): string {
	const home = /^(?:~|\$HOME|\$\{HOME\})\//.exec(p);
	if (home) return path.join(at.home, p.slice(home[0].length));
	return path.resolve(at.cwd, p);
}

/** The watch that still applies: undefined when `of` is no longer the rule's condition (a hand edit) or the record is not one this build wrote. */
export function watchOf(rule: { condition: string; precheck?: unknown }): PathWatch | undefined {
	const w = rule.precheck as Partial<PathWatch> | undefined;
	if (!w || w.v !== 1 || w.of !== rule.condition || typeof w.raw !== "string" || typeof w.resolved !== "string" || !path.isAbsolute(w.resolved)) return undefined;
	return w as PathWatch;
}

export type Look = "present" | "absent" | "unknown";

/**
 * One `stat` that follows symlinks: the path, or what a dangling link points at. `ENOENT` and
 * `ENOTDIR` are absent; any other error, or no answer within `timeoutMs`, is `unknown`, which the
 * caller treats as "ask the model", as it did before there was a pre-check.
 */
export async function lookAt(w: PathWatch, opts: { timeoutMs?: number; stat?: (p: string) => Promise<unknown> } = {}): Promise<Look> {
	const stat = opts.stat ?? ((p: string) => fs.promises.stat(p));
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<Look>((resolve) => {
		timer = setTimeout(() => resolve("unknown"), opts.timeoutMs ?? LOOK_TIMEOUT_MS);
	});
	const looked = stat(w.resolved).then(
		(): Look => "present",
		(err: any): Look => (err?.code === "ENOENT" || err?.code === "ENOTDIR" ? "absent" : "unknown"),
	);
	try {
		return await Promise.race([looked, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Stats one process has out at once, across every rule: two hung ones still leave libuv two threads. */
export const LOOKS_IN_FLIGHT_MAX = 2;

/**
 * Looks, with few in flight. A `stat` on a dead network mount can hang past its timeout and hold
 * one of libuv's four threads, so a look starts nothing and answers `unknown` while the same rule or
 * the same path has one out, or while `LOOKS_IN_FLIGHT_MAX` are out. The process has one of these:
 * its trigger runtime's.
 */
export class PathLooks {
	private readonly rules = new Set<string>();
	private readonly paths = new Set<string>();
	private readonly opts: { timeoutMs?: number; stat?: (p: string) => Promise<unknown>; max?: number };
	constructor(opts: { timeoutMs?: number; stat?: (p: string) => Promise<unknown>; max?: number } = {}) {
		this.opts = opts;
	}

	look(ruleId: string, w: PathWatch): Promise<Look> {
		if (this.rules.has(ruleId) || this.paths.has(w.resolved) || this.paths.size >= (this.opts.max ?? LOOKS_IN_FLIGHT_MAX)) return Promise.resolve("unknown");
		this.rules.add(ruleId);
		this.paths.add(w.resolved);
		const stat = this.opts.stat ?? ((p: string) => fs.promises.stat(p));
		// Cleared when the stat itself settles, not when the timeout answers.
		const settled = () => {
			this.rules.delete(ruleId);
			this.paths.delete(w.resolved);
		};
		const tracked = (p: string) => {
			const pending = stat(p);
			pending.then(settled, settled);
			return pending;
		};
		return lookAt(w, { timeoutMs: this.opts.timeoutMs, stat: tracked });
	}
}

/** What the rule's row on the page says about its path: "next look 09:22 · no model call until the file exists", and the other two states. */
export function lookLine(look: Look | undefined, nextLookAt: number | undefined, clock: (ms: number) => string): string {
	if (look === "present") return "the file is there · the next look asks the model";
	if (look === "unknown") return "could not look at the path · checked by the model";
	const wait = "no model call until the file exists";
	return nextLookAt === undefined ? wait : `next look ${clock(nextLookAt)} · ${wait}`;
}
