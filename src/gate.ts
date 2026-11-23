/**
 * A gate: a cheap look taken before a wake costs a model call (design 3.3). A look either opens the
 * wake or holds it. A held wake writes no row and no run; a reading that opens one is stored raw in
 * `events.jsonl` first (src/events.ts), and only its look count is in `clock.json`.
 *
 * Two kinds of look. A path gate `stat`s one path: a rule whose condition is only "<path> exists /
 * appears" (docs/triggers.md, "Rules that wait for a path"). A command gate runs one shell command
 * and compares a digest of what it printed with the last one a gated run saw (`seen`). A loop's
 * gate is always a command; a rule's is a command when a proposal set one.
 *
 * Whether a condition is path-only is decided once, when the rule is created, and recorded on the
 * rule (`gate`, and `precheck` for 0.24.2): the creating process is the person's own window or page,
 * so `~` is their home even when the background process was started with another one. The grammar
 * matches whole strings and knows a fixed list of verbs. A refused condition is safe — the model
 * checks it as it always did — so every doubt (a glob, a second clause, an unknown variable) is a
 * refusal, and each refusal says why.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dangerousCommandReason } from "./danger.ts";
import { BoundedText } from "./hooks.ts";
import { plainLine, redact } from "./redact.ts";
import { defaultLoopsDir } from "./store.ts";

/** A path gate. `of` is the condition it was read from; `raw` the path as typed; `resolved` the absolute path. */
export interface PathGate {
	kind: "path";
	of: string;
	raw: string;
	resolved: string;
}

/** A command gate: what a person set with `--gate`, a recipe's `gate` key, or a proposal the person said yes to. */
export interface CommandGate {
	kind: "command";
	command: string;
}

/** A gate command longer than this is not one line a person reads on a card. */
export const GATE_COMMAND_MAX = 1000;

/**
 * What a gate's command is judged by, as an unattended run's command is (src/guard.ts `policyNeed`):
 * the dangerous-command policy with the loops directory (and `[danger] allow` where the look runs). A command a
 * run would be asked about is refused: a gate runs with nobody there to ask.
 */
export interface GatePolicy {
	loopsDir: string;
	allowCommands?: readonly string[];
}

/** The policy of this process's loops directory, with no allowlist: where a gate is set without the config at hand, the stricter reading. */
export function defaultGatePolicy(): GatePolicy {
	return { loopsDir: defaultLoopsDir() };
}

/** Why the policy refuses `command` as a gate, or undefined. */
export function gateRefusal(command: string, policy: GatePolicy = defaultGatePolicy()): string | undefined {
	return dangerousCommandReason(command, undefined, policy.allowCommands ?? [], policy.loopsDir);
}

/**
 * The one way a surface shows a gate command (the watch card and the terminal's question, the page's
 * loop row, `/cron`, `cron_list`, an archive's confirm and notes, the `[gate]` block), and the text
 * shown beside one (a job's name): on one line, each character a screen would not draw as itself a
 * space, and redacted. A command is a gate only when this leaves it as it is (`gateCommandWhy`), so
 * what a person sees is what runs.
 */
export function gateShown(text: string): string {
	return redact(plainLine(text));
}

/**
 * Why `command` cannot be a gate, or undefined: it is empty, too long, it does not show as itself
 * (`gateShown`), or the policy refuses it. Asked wherever a gate is set (a person's command, a
 * recipe, a proposal, an archive); every look asks the policy again.
 */
export function gateCommandWhy(command: string, policy: GatePolicy = defaultGatePolicy()): string | undefined {
	if (!command.trim()) return "a gate needs a command";
	if (command.length > GATE_COMMAND_MAX) return `a gate command is at most ${GATE_COMMAND_MAX} characters`;
	if (gateShown(command) !== command) {
		// A line break, a terminal escape, a bidi override or a zero-width character shows the command
		// as other than it runs; a secret shows redacted. Either way a person would say yes to part of it,
		// and a secret would also be stored in events.jsonl with every reading.
		return plainLine(command) !== command
			? "a gate is one line a person can read: it holds a line break, a control character or an invisible one"
			: "a gate cannot hold a secret: part of this command reads as one, and pi-loops would hide it wherever it shows the gate, so nobody could see all of what runs";
	}
	const refused = gateRefusal(command, policy);
	return refused ? `the gate would be refused when it runs: ${refused}` : undefined;
}

/** A job's or a rule's `gate` field when it is a command gate this build reads, else undefined. */
export function commandGateOf(value: unknown): CommandGate | undefined {
	const g = value as Partial<CommandGate> | undefined;
	return g?.kind === "command" && typeof g.command === "string" && g.command.trim() ? { kind: "command", command: g.command } : undefined;
}

/** What `lookCommand` stored for one reading (`events.jsonl`'s `raw`), read back for the `[gate]` block and `seen`. */
export interface CommandReading {
	command: string;
	exit?: number | null;
	stdout?: string;
	why?: string;
	refused?: string;
}

export function commandReadingOf(raw: string): CommandReading | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined; // not a reading this build stored
	}
	const r = parsed as Partial<CommandReading> | null;
	return r && typeof r.command === "string" ? (r as CommandReading) : undefined;
}

/** The digest a reading gives, as `gateDecision` compares it; undefined for a reading that failed. */
export function readingDigest(r: CommandReading): string | undefined {
	return typeof r.exit === "number" && r.why === undefined && r.refused === undefined && typeof r.stdout === "string" ? commandDigest(r.exit, r.stdout) : undefined;
}

/** How often one job's or rule's command gate is looked at, at most (design 3.3). */
export const GATE_LOOK_EVERY_MS = 60_000;

/** The same path as 0.24.2 reads it from a rule (`precheck`), so a 0.24.2 process still pre-checks the rule. */
export interface Precheck {
	v: 1;
	of: string;
	raw: string;
	resolved: string;
}

export type PathState = "present" | "absent" | "unknown";

export type Look = { kind: "path"; state: PathState } | { kind: "command"; digest: string; output: string } | { kind: "failed"; why: string };

/**
 * Whether a look opens the wake. A path wakes unless it is absent; a command wakes when its digest
 * differs from `seen`, the digest the last gated run that did not fail saw; a look that failed
 * wakes, which is what a wake without a gate does.
 */
export function gateDecision(seen: string | undefined, look: Look): "wake" | "hold" {
	if (look.kind === "path") return look.state === "absent" ? "hold" : "wake";
	if (look.kind === "command") return look.digest === seen ? "hold" : "wake";
	return "wake";
}

/** A look and its reading as it was taken: `raw` is what `events.jsonl` stores when the look opens a wake. */
export interface Reading {
	look: Look;
	raw: string;
}

export function pathReading(gate: PathGate, state: PathState): Reading {
	return { look: { kind: "path", state }, raw: JSON.stringify({ path: gate.raw, resolved: gate.resolved, state }) };
}

export function precheckOf(gate: PathGate): Precheck {
	return { v: 1, of: gate.of, raw: gate.raw, resolved: gate.resolved };
}

export type PathOnly = { gate: PathGate } | { why: string };

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
 * Whether `condition` is only "<path> exists / appears", and the path gate it gives. `at.cwd` is the
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
	const rest = token.rest.trim();
	// No aside in parentheses is dropped: "exists (or ~/b appears)" is true while this path is absent,
	// and no word list can tell such an aside from "(a build finished)". The model reads those.
	const verbWhy = verbOnly(rest);
	if (verbWhy) return { why: verbWhy };
	const bad = badPath(token.path);
	if (bad) return { why: bad };
	const resolved = resolvePath(token.path, at);
	// Again on the resolved path: `/./net/h/x` and `../../net/h/x` are network paths too.
	if (NETWORK.test(resolved)) return { why: NETWORK_WHY };
	return { gate: { kind: "path", of: condition, raw: token.path, resolved } };
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

/**
 * The path gate of a rule that still applies: its `gate`, else its `precheck` (a rule 0.24.2 made).
 * Undefined when `of` is no longer the rule's condition (a hand edit) or the record is not one this
 * build or 0.24.2 wrote.
 */
export function gateOf(rule: { condition: string; gate?: unknown; precheck?: unknown }): PathGate | CommandGate | undefined {
	if (rule.gate !== undefined) {
		const command = commandGateOf(rule.gate);
		if (command) return command;
		const g = rule.gate as Partial<PathGate>;
		return g?.kind === "path" && applies(g, rule.condition) ? { kind: "path", of: g.of!, raw: g.raw!, resolved: g.resolved! } : undefined;
	}
	const w = rule.precheck as Partial<Precheck> | undefined;
	return w?.v === 1 && applies(w, rule.condition) ? { kind: "path", of: w.of!, raw: w.raw!, resolved: w.resolved! } : undefined;
}

function applies(w: { of?: unknown; raw?: unknown; resolved?: unknown }, condition: string): boolean {
	return w.of === condition && typeof w.raw === "string" && typeof w.resolved === "string" && path.isAbsolute(w.resolved);
}

/**
 * One `stat` that follows symlinks: the path, or what a dangling link points at. `ENOENT` and
 * `ENOTDIR` are absent; any other error, or no answer within `timeoutMs`, is `unknown`, which the
 * caller treats as "ask the model", as it did before there was a pre-check.
 */
export async function lookAt(g: PathGate, opts: { timeoutMs?: number; stat?: (p: string) => Promise<unknown> } = {}): Promise<PathState> {
	const stat = opts.stat ?? ((p: string) => fs.promises.stat(p));
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<PathState>((resolve) => {
		timer = setTimeout(() => resolve("unknown"), opts.timeoutMs ?? LOOK_TIMEOUT_MS);
	});
	const looked = stat(g.resolved).then(
		(): PathState => "present",
		(err: any): PathState => (err?.code === "ENOENT" || err?.code === "ENOTDIR" ? "absent" : "unknown"),
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

	look(ruleId: string, g: PathGate): Promise<PathState> {
		if (this.rules.has(ruleId) || this.paths.has(g.resolved) || this.paths.size >= (this.opts.max ?? LOOKS_IN_FLIGHT_MAX)) return Promise.resolve("unknown");
		this.rules.add(ruleId);
		this.paths.add(g.resolved);
		const stat = this.opts.stat ?? ((p: string) => fs.promises.stat(p));
		// Cleared when the stat itself settles, not when the timeout answers.
		const settled = () => {
			this.rules.delete(ruleId);
			this.paths.delete(g.resolved);
		};
		const tracked = (p: string) => {
			const pending = stat(p);
			pending.then(settled, settled);
			return pending;
		};
		return lookAt(g, { timeoutMs: this.opts.timeoutMs, stat: tracked });
	}
}

/** What the rule's row on the page says about its path: "next look 09:22 · no model call until the file exists", and the other two states. */
export function lookLine(look: PathState | undefined, nextLookAt: number | undefined, clock: (ms: number) => string): string {
	if (look === "present") return "the file is there · the next look asks the model";
	if (look === "unknown") return "could not look at the path · checked by the model";
	const wait = "no model call until the file exists";
	return nextLookAt === undefined ? wait : `next look ${clock(nextLookAt)} · ${wait}`;
}

/** The numbers a hook's command has (CONTRACT.md section 3). */
export const COMMAND_TIMEOUT_MS = 5000;
export const COMMAND_OUTPUT_CHARS = 4000;

export function commandDigest(exitCode: number, stdout: string): string {
	return createHash("sha256").update(`${exitCode}\n${stdout}`).digest("hex");
}

export interface CommandLookOptions {
	cwd: string;
	timeoutMs?: number;
	/** The policy the command is judged by: the loops directory and the allowlist of the process that looks. */
	policy?: GatePolicy;
	/** A test's own refusal in place of the policy. */
	refuse?: (command: string) => string | undefined;
}

/**
 * One run of a command gate: the policy and the rest of `gateCommandWhy` first, then `sh -c` in `cwd` with stdin closed, its own
 * process group, and at most `COMMAND_OUTPUT_CHARS` of stdout. The group is killed when the look
 * ends, whatever ended it (an exit, the timeout, an error), so a child the shell left running in the
 * background does not outlive the look. A refusal, a timeout, a command that could not start, a
 * signal and an exit code of 126 or more are a `failed` look; any other exit is a reading whose
 * digest is of the exit code and stdout.
 */
export async function lookCommand(command: string, opts: CommandLookOptions): Promise<Reading> {
	// The whole check a gate gets where it is set, again here: a gate written into jobs.json or
	// triggers.json by hand that does not show as itself (src/gate.ts gateShown) is never run, and
	// the stored reading names it only as it shows, so no secret it holds reaches events.jsonl.
	const refusal = opts.refuse ? opts.refuse(command) : (gateRefusal(command, opts.policy) ?? gateCommandWhy(command, opts.policy));
	if (refusal) return { look: { kind: "failed", why: `refused: ${refusal}` }, raw: JSON.stringify({ command: gateShown(command), refused: refusal }) };
	const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
	const isWin = process.platform === "win32";
	return new Promise<Reading>((resolve) => {
		const stdout = new BoundedText(COMMAND_OUTPUT_CHARS);
		let done = false;
		let timer: NodeJS.Timeout | undefined;
		const failed = (why: string, exit: number | null) => finish({ look: { kind: "failed", why }, raw: JSON.stringify({ command, exit, stdout: stdout.text(), why }) });
		let proc: ReturnType<typeof spawn> | undefined;
		const killGroup = () => {
			try {
				if (!isWin && proc?.pid) process.kill(-proc.pid, "SIGKILL");
				else proc?.kill("SIGKILL");
			} catch {
				/* the group is gone already: nothing is left to kill */
			}
		};
		const finish = (reading: Reading) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			killGroup();
			resolve(reading);
		};
		try {
			proc = spawn(isWin ? "cmd" : "sh", [isWin ? "/C" : "-c", command], { cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"], detached: !isWin });
		} catch (err: any) {
			failed(`could not start: ${err?.message ?? err}`, null);
			return;
		}
		proc.stdout?.on("data", (d: Buffer) => stdout.push(d));
		timer = setTimeout(() => failed(`timed out after ${timeoutMs / 1000}s`, null), timeoutMs);
		proc.on("error", (err) => failed(`could not start: ${err.message}`, null));
		proc.on("close", (code) => {
			if (code === null) return failed("ended by a signal", null);
			if (code >= 126) return failed(`exited ${code}`, code);
			const out = Array.from(stdout.text()).slice(0, COMMAND_OUTPUT_CHARS).join("");
			finish({ look: { kind: "command", digest: commandDigest(code, out), output: out }, raw: JSON.stringify({ command, exit: code, stdout: out }) });
		});
	});
}
