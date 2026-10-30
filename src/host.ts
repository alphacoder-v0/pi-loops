/**
 * The always-on host — pi-loops with no pi window, one per loops directory. A pi window starts it
 * when there is automation to run (`ensure` in src/pi-loops.ts) and it never yields to one: it runs
 * every loop, checks every rule and evaluates MCP pushes, with the same stores, the same in-process
 * sub-agent runner (pi's SDK) and its own MCP client instances. A rule's result goes to the window
 * holding the conversation that created the rule, or to the inbox marked for it. After a reboot it
 * starts again when a pi opens, or when a service manager the person set up runs
 * `pi-loops start --foreground`. It serves a read-only status page on loopback (src/host-page.ts).
 *
 *   node --import <pkg>/src/register-pi.mjs <pkg>/src/host-entry.mjs   (env: PI_LOOPS_DIR, PI_LOOPS_PI_PACKAGE)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, ProjectTrustStore, SettingsManager, VERSION as PI_VERSION, getAgentDir, readStoredCredential, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.ts";
import { computeNext, stamp } from "./schedule.ts";
import { hostSocketPath, serveHostChannel } from "./host-control-channel.ts";
import { HOST_LOG, claimHostService, crashPaused, crashPauseText, hostServiceNames, readSpawnLog, recordCrash, removeHostService, updateHostService, type HostServiceRecord } from "./host-control.ts";
import { HOST_PAGE_PORT, pageToken, serveHostPage, sessionRows, type HostStatus } from "./host-page.ts";
import { Mailbox } from "./mailbox.ts";
import { pruneSeen, readSeen, sinceYouLooked } from "./seen.ts";
import { LeaseStore, holderAlive, procStart } from "./lease.ts";
import { writeFileAtomic } from "./lock.ts";
import { THINKING_LEVELS, thinkingLevelOrUndefined } from "./thinking.ts";
import { rotateInPlace } from "./log.ts";
import { createHostRuntime } from "./host-runtime.ts";
import { McpPool } from "./mcp-pool.ts";
import { McpSource, droppedNotificationMessage, loadMcpConfigFiles, mapNotification, mcpToolDefinitions, mcpTokenFromEnv, type McpNotification, type McpServerConfig } from "./mcp.ts";
import { previewRedacted, redact } from "./redact.ts";
import { parentRuntimeFlags, type RunnerResult, type SubagentRunner } from "./runner.ts";
import type { SessionSnapshot } from "./scheduler.ts";
import type { HostSnapshot } from "./host-control-channel.ts";
import { createInProcessRunner, releaseHeldResources } from "./sdk-runner.ts";
import { defaultLoopsDir, homeLoopsDir, sessionExists } from "./store.ts";
import { sameProject } from "./paths.ts";
import { isExactlyTrusted, isTrustedByPi } from "./trust.ts";
import { PI_LOOPS_VERSION } from "./version.ts";
import { readUiPrefs } from "./ui-prefs.ts";

const agentDir = getAgentDir();
const dir = process.env.PI_LOOPS_DIR || defaultLoopsDir(agentDir);
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(dir, { recursive: true });
const logFile = path.join(dir, HOST_LOG);
// Run with `pi-loops start --foreground`, a line also goes to the terminal, or the service manager's journal.
const logToStdout = process.env.PI_LOOPS_HOST_MANAGED === "foreground";
const log = (msg: string) => {
	const line = `${stamp()} ${redact(msg)}\n`;
	if (logToStdout) process.stdout.write(line);
	try {
		fs.appendFileSync(logFile, line);
		// The process's own stdout and stderr are this file too (host-control.ts): what an extension
		// prints there arrives as written, not through this function's redaction. MCP servers' stderr
		// does not (src/mcp.ts pipes it). It is the one file a user is told to read; keep it readable,
		// by the same rule as every other log in this project, which lives in src/log.ts.
		rotateInPlace(logFile);
	} catch {
		process.stderr.write(line);
	}
};

let config = loadConfig(dir);
/**
 * Every config error this host has already said, so the 60-second re-read below can say a *new* one
 * without repeating the old ones every minute. An error introduced by editing `config.toml` while
 * the host is up was silently ignored for the rest of its life: the setting fell back to its
 * default, and the only record of why was in a file nobody re-read.
 */
const saidConfigErrors = new Set<string>();
function logConfigErrors(): void {
	for (const e of config.errors) {
		if (saidConfigErrors.has(e)) continue;
		saidConfigErrors.add(e);
		log(`config: ${e}`);
	}
}
logConfigErrors();

// The session the host "is": no chat, no project; for unpinned work, `PI_LOOPS_HOST_MODEL` and
// `PI_LOOPS_HOST_THINKING` when set, else the settings' defaults. Never "some available model".
const settings = SettingsManager.create(os.homedir(), agentDir, { projectTrusted: false });
const settingsModel = settings.getDefaultProvider() && settings.getDefaultModel() ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}` : undefined;
// The environment is a boundary: `PI_LOOPS_HOST_THINKING` is whatever the process that spawned this
// one had, and it goes straight into every model call. An unknown level is dropped out loud rather
// than cast to one, so a provider rejecting "hgih" is not the first anyone hears of it.
const envThinking = process.env.PI_LOOPS_HOST_THINKING;
const handedThinking = thinkingLevelOrUndefined(envThinking);
if (envThinking && !handedThinking) log(`ignoring PI_LOOPS_HOST_THINKING=${envThinking}: not a thinking level (${THINKING_LEVELS.join(", ")})`);
const session: SessionSnapshot = { cwd: "", model: process.env.PI_LOOPS_HOST_MODEL || settingsModel, thinking: handedThinking || settings.getDefaultThinkingLevel(), trusted: false };
async function defaultModel(): Promise<Model<any> | undefined> {
	if (!session.model) return undefined;
	const rt = await ModelRuntime.create();
	const [provider, ...rest] = session.model.split("/");
	return rt.getModel(provider, rest.join("/")) ?? undefined;
}
let parentModel: Model<any> | undefined;

/* ---------------------------------------------------------------- MCP */

let mcpLoaded = loadMcpConfigFiles({ dir, projectTrusted: false });
for (const d of mcpLoaded.diagnostics) log(`mcp: ${d}`);
/** mcp.toml's modification time when it was last read; "" when there is none. */
const mcpConfigStamp = (): string => {
	try {
		return String(fs.statSync(path.join(dir, "mcp.toml")).mtimeMs);
	} catch {
		return ""; // no mcp.toml: no servers of the user's own
	}
};
let mcpReadAt = mcpConfigStamp();
const mcpSources: McpSource[] = [];
const mcpToolDefs = new Map<string, ToolDefinition<any, any>[]>();
const mcpToolNames = new Map<string, string[]>();
const resolveMcpToken = (ref: string): string | undefined => {
	const fromEnv = mcpTokenFromEnv(ref);
	if (fromEnv) return fromEnv;
	try {
		const cred: any = readStoredCredential(ref);
		if (cred && typeof cred === "object") return cred.key ?? cred.access ?? cred.token;
		if (typeof cred === "string") return cred;
	} catch {
		/* no store */
	}
	return undefined;
};

/* ------------------------------------------------------------ runtime */

const leases = new LeaseStore(dir);
const mailboxes = new Mailbox(dir);
/**
 * An injecting push is the holder's to put in its chat; the host files it only when no window has
 * that server. A project's server is that project's: a window elsewhere with a server of the same name
 * does not count.
 */
const someWindowInjects = (server: string, cwd?: string): boolean => leases.list().some((l) => !!l.holder && l.holder.pushServers.includes(server) && holderAlive(l.holder) && (!cwd || (!!l.cwd && sameProject(l.cwd, cwd))));

/**
 * A host started by a service manager has its environment, not a shell's: a provider key that is
 * only exported in `.bashrc` is not there. When a run fails on authentication, the error says so, so
 * the failure in `/cron` points at its cause instead of at the job.
 */
const AUTH_FAILURE = /\b(401|403|unauthori[sz]ed|authentication|api[ _-]?key|invalid[ _-]?key|no credentials|not logged in)\b/i;
function explainAuthFailure(result: RunnerResult): RunnerResult {
	if (result.ok || !AUTH_FAILURE.test(result.errorMessage ?? "")) return result;
	// Started by a window, it has that window's environment, for days: a key exported in another shell
	// since, or in the window's shell after it started, never reached it.
	const whose = managed === "foreground" ? "pi-loops was started with --foreground by a service manager, so keys exported only in your shell do not reach it" : `pi-loops in the background has the environment of ${process.env.PI_LOOPS_STARTED_BY || "the window that started it"}; pi-loops restart from a shell gives it that shell's`;
	return { ...result, errorMessage: `${result.errorMessage} (${whose}; keys saved with pi's /login always reach it)` };
}

const inProcessRunner = createInProcessRunner({
	agentDir,
	parentFlags: parentRuntimeFlags([]),
	getParentModel: () => parentModel,
	getParentThinking: () => session.thinking,
	customTools: (req) => host.customTools(req),
	// Only projects the user trusted before (pi's saved decisions); the host never trusts on its own.
	// Exact trust only (src/trust.ts): nobody is watching what a job's cwd points at.
	isTrusted: (cwd) => isExactlyTrusted(agentDir, cwd),
	ownDir: PACKAGE_DIR,
	allowCommands: () => config.allowCommands,
	// The daily cap, read while a run is in flight and not only before it is dispatched. Lazy: the
	// host owns the scheduler and is built with this runner, so it can only be asked at run time.
	budget: () => host.scheduler.budgetState(),
	log: (msg) => log(`sub-agent: ${msg}`),
	notice: (text, cwd) => host.notice(text, cwd),
});
const runner: SubagentRunner = async (req) => explainAuthFailure(await inProcessRunner(req));
/** Project-level MCP servers, connected on demand: the host itself has no project. */
const mcpPool = new McpPool({ isTrusted: (cwd) => isExactlyTrusted(agentDir, cwd), resolveToken: resolveMcpToken, log: (msg) => log(`mcp pool: ${msg}`), onNotification: (cwd, cfg, n, source) => onPush(cfg, n, source, cwd) });
const host = createHostRuntime({
	dir,
	config: () => config,
	session: () => session,
	runner,
	mcpTools: () => [...mcpToolDefs.values()].flat(),
	projectMcpTools: (cwd, taken, trusted) => mcpPool.toolsFor(cwd, taken, trusted),
	// Project-local hooks.toml: the same exact-trust rule as a project's MCP servers and tools.
	isProjectTrusted: (cwd) => isExactlyTrusted(agentDir, cwd),
	ownerTrusts: (cwd) => isTrustedByPi(agentDir, cwd),
	log,
	// A conversation a window holds is alive whatever the disk says (--session-dir, another root).
	// Its file where a window last saw it counts too: `--session-dir` keeps conversations elsewhere.
	sessionExists: (id) => {
		const lease = leases.read(id);
		if (lease?.holder && holderAlive(lease.holder)) return true;
		if (lease?.sessionFile && fs.existsSync(lease.sessionFile)) return true;
		return sessionExists(path.join(agentDir, "sessions"), id);
	},
	onTick: (now) => everyTick(now),
});

/**
 * One push, from a user-level server or a project's (then `cwd` is that project, and only its rules
 * are evaluated). An injecting push is the holder's to put in its chat; the host files it only when no
 * window has that server.
 */
function onPush(cfg: McpServerConfig, n: McpNotification, source: McpSource, cwd?: string): void {
	const trigger = mapNotification(cfg.name, n);
	if (!trigger) {
		source.status.droppedCount++;
		source.status.lastError = droppedNotificationMessage(n.method);
		return;
	}
	if (cwd) trigger.cwd = cwd;
	const delivery = cfg.injectAndRun ? "inject_and_run" : cfg.injectSummary ? "inject_summary" : "sub_agent";
	if (delivery !== "sub_agent" && someWindowInjects(cfg.name, cwd)) return;
	void host.triggers.handle(trigger, delivery).catch((err) => log(`trigger: ${err?.message ?? err}`));
}

/** Every minute: the trusted projects with enabled rules keep their push servers connected. */
function watchProjectPushServers(): void {
	const cwds = [...new Set(host.triggers.store.load().filter((r) => r.enabled).map((r) => r.cwd))];
	mcpPool.watch(cwds);
}

function startMcpSources(): void {
	for (const cfg of mcpLoaded.servers) startMcpSource(cfg);
}

/**
 * This process lives for days, and mcp.toml is edited meanwhile: a window reads it at every start,
 * and so must this, or a server added there never reaches a loop until a restart. Only the servers
 * that changed are stopped or started.
 */
function reloadMcpIfChanged(): void {
	const at = mcpConfigStamp();
	if (at === mcpReadAt) return;
	mcpReadAt = at;
	const next = loadMcpConfigFiles({ dir, projectTrusted: false });
	for (const d of next.diagnostics) log(`mcp: ${d}`);
	const same = (a: McpServerConfig, b: McpServerConfig) => JSON.stringify(a) === JSON.stringify(b);
	let stopped = 0;
	for (const source of [...mcpSources]) {
		if (next.servers.some((cfg) => same(cfg, source.config))) continue;
		mcpSources.splice(mcpSources.indexOf(source), 1);
		mcpToolDefs.delete(source.config.name);
		mcpToolNames.delete(source.config.name);
		source.stop().catch((err: any) => log(`mcp ${source.config.name}: stop failed: ${err?.message ?? err}`));
		stopped++;
	}
	const fresh = next.servers.filter((cfg) => !mcpSources.some((source) => same(cfg, source.config)));
	mcpLoaded = next;
	for (const cfg of fresh) startMcpSource(cfg);
	log(`mcp.toml changed: ${fresh.length} server(s) started, ${stopped} stopped`);
}

function startMcpSource(cfg: McpServerConfig): void {
	const source = new McpSource(cfg, {
		onConnected: async (src) => {
			let tools;
			try {
				tools = await src.listTools();
			} catch (err: any) {
				src.status.lastError = `tools/list failed: ${err?.message ?? err}`;
				return;
			}
			const already = mcpToolNames.get(cfg.name) ?? [];
			const defs = mcpToolDefs.get(cfg.name) ?? [];
			const taken = new Set([...mcpToolDefs.values()].flat().map((d) => d.name));
			for (const { def } of mcpToolDefinitions(src, tools, taken, already)) defs.push(def);
			mcpToolNames.set(cfg.name, already);
			mcpToolDefs.set(cfg.name, defs);
			log(`mcp ${cfg.name}: connected, ${already.length} tool(s)`);
		},
		onNotification: (n) => onPush(cfg, n, source),
		resolveToken: resolveMcpToken,
		log: (msg) => log(`mcp ${cfg.name}: ${previewRedacted(msg, 200)}`),
	});
	mcpSources.push(source);
	source.start();
}

/* ------------------------------------------------------------ lifecycle */

let stopping = false;
async function shutdown(code: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	// Whatever hangs (a lock, an MCP server that will not die), the process leaves.
	setTimeout(() => {
		// A clean stop that ran out of time is still a clean stop: its record goes, so the next window
		// does not count it as a crash.
		if (code === 0) {
			try {
				removeHostService(dir, process.pid);
			} catch (err: any) {
				log(`could not remove the pi-loops record: ${err?.message ?? err}`);
			}
		}
		process.exit(code);
	}, 10_000).unref();
	try {
		await host.stop();
		// Held turns' extensions get their session_shutdown before the process goes.
		await Promise.race([releaseHeldResources({ idleMs: 0, keep: 0 }), new Promise((r) => setTimeout(r, 3000).unref())]);
		await mcpPool.stopAll();
		await Promise.all(mcpSources.map((s) => s.stop()));
	} catch (err: any) {
		log(`shutdown: ${err?.message ?? err}`);
	}
	try {
		page?.close();
		channel?.close();
		fs.rmSync(hostSocketPath(dir), { force: true });
	} catch {
		/* going away anyway */
	}
	// A clean exit removes the record; a crash leaves it so the next pi can say the host died. Only a
	// record that still names this process: a host that lost its claim must not remove the winner's.
	if (code === 0) {
		try {
			removeHostService(dir, process.pid);
			removeLegacyFence();
		} catch (err: any) {
			log(`could not remove the pi-loops record: ${err?.message ?? err}`);
		}
	}
	log(`pi-loops stopped (exit ${code})`);
	process.exit(code);
}
// `shutdown` stops stores, MCP servers and the scheduler; any of them can reject, and the process
// is on its way out — so the exit does not depend on the shutdown succeeding.
const leave = (code: number) => void shutdown(code).catch((err: any) => {
	log(`shutdown failed: ${err?.message ?? err}`);
	process.exit(code);
});
process.on("SIGTERM", () => leave(0));
process.on("SIGINT", () => leave(0));
// The terminal `pi-loops start --foreground` runs in was closed: a stop like any other, not a crash.
process.on("SIGHUP", () => leave(0));
// No catch-and-continue inside the process: its state after an uncaught error cannot be trusted.
// The log lands first (the error, its stack and what was in flight), then the crash is counted
// (three within five minutes pause the host instead of a restart loop) and the record cleared, and
// the process exits for whatever started it to judge.
process.on("uncaughtException", (err) => {
	// Already leaving: an error thrown on the way out is logged, not counted as another crash.
	if (stopping) {
		log(`uncaught while stopping: ${redact(String(err?.stack ?? err))}`);
		return;
	}
	const inFlight = [...host.scheduler.runningRuns().map((r) => `${r.label} (${r.runId.slice(0, 12)})`), ...host.triggers.runningList().map((c) => `check ${c.traceId.slice(0, 8)}`)];
	log(`uncaught: ${redact(String(err?.stack ?? err))}${inFlight.length ? `\n  in flight: ${inFlight.join(", ")}` : ""}`);
	try {
		recordCrash(dir, `pi-loops crashed: ${previewRedacted(String(err?.message ?? err), 160)}; see ${HOST_LOG}`);
		removeHostService(dir, process.pid);
	} catch (e: any) {
		log(`could not record the crash: ${e?.message ?? e}`);
	}
	leave(1);
});
process.on("unhandledRejection", (err: any) => log(`unhandled rejection: ${redact(String(err?.stack ?? err))}`));

// Run by `pi-loops start --foreground` (a service manager the person set up), or spawned by a pi window.
const managed: HostServiceRecord["managed"] = process.env.PI_LOOPS_HOST_MANAGED === "foreground" ? "foreground" : "spawned";
// After the crash budget paused it, a service manager would restart it at once after each failure:
// it waits the pause out instead, as a window does, and goes on early when /pi-loops start ends it.
// A stop while it waits is a clean stop (the signal handlers above).
if (managed === "foreground" && crashPaused(readSpawnLog(dir), Date.now())) {
	log(`paused: ${crashPauseText(readSpawnLog(dir))}`);
	await new Promise<void>((resolve) => {
		const wait = setInterval(() => {
			if (crashPaused(readSpawnLog(dir), Date.now())) return;
			clearInterval(wait);
			resolve();
		}, 15_000);
	});
}

// One host per loops directory: two windows opening together may both spawn one, and the second
// to get here leaves before it opens the socket or any MCP connection. The claim, not the socket,
// is the single-instance argument (src/host-control.ts).
const startedAt = stamp();
const claimToken = pageToken(dir, log);
const claim = claimHostService(dir, {
	v: 1,
	pid: process.pid,
	procStart: procStart(process.pid),
	startedAt,
	version: PI_LOOPS_VERSION,
	piVersion: PI_VERSION,
	entry: process.argv[1] ?? "",
	node: process.execPath,
	dir,
	socket: hostSocketPath(dir),
	token: claimToken,
	managed,
});
if (!claim.claimed) {
	log(`pi-loops is already running (pid ${claim.other.pid}); exiting`);
	process.exit(0);
}
// A `pi-loops stop` that landed while a window was starting this process: every start by a person
// clears the mark first, so a mark here is the stop, said after the window looked.
if (readUiPrefs(dir).host === "stopped") {
	log("pi-loops was stopped by hand while it started; leaving");
	removeHostService(dir, process.pid);
	process.exit(0);
}
log(`pi-loops ${PI_LOOPS_VERSION} started (pid ${process.pid}, dir ${dir})`);

/**
 * The fence that keeps a pi-loops 0.22 window from running loops beside this host during an
 * upgrade. Such a window elects a leader through `scheduler.json`, preempts only a record of kind
 * "host", and stands by while a fresh record with a live pid names someone else; so this writes one
 * every tick. Removed once 0.22 windows are gone (release 6 of the design).
 */
const LEGACY_FENCE = path.join(dir, "scheduler.json");
function writeLegacyFence(now: number): void {
	writeFileAtomic(LEGACY_FENCE, `${JSON.stringify({ pid: process.pid, host: os.hostname(), instance: "service", kind: "service", startedAt, heartbeatAt: stamp(now) }, null, 2)}\n`);
}
function removeLegacyFence(): void {
	try {
		const rec = JSON.parse(fs.readFileSync(LEGACY_FENCE, "utf8"));
		if (rec?.pid === process.pid) fs.rmSync(LEGACY_FENCE, { force: true });
	} catch {
		/* no fence, or not ours to remove */
	}
}

/** Every tick: am I still the host the record names (a stale lock break can let two claim), and the fence. */
/**
 * Every ten minutes: forget conversations nothing refers to any more. A lease is written for every
 * conversation a window opens; one that nobody holds and that has no plain job, rule or queued result
 * is deleted (a window opening it again writes it again), and so is its since-you-looked cursor.
 */
let sweptAt = 0;
function sweepConversations(now: number): void {
	if (now - sweptAt < 10 * 60_000) return;
	sweptAt = now;
	// A loop's runs count for the conversation that created it (since-you-looked), so that one stays too.
	const working = new Set<string>([...host.scheduler.store.load().flatMap((j) => [j.sessionId, j.createdBy?.sessionId].filter((id): id is string => !!id)), ...host.triggers.store.load().flatMap((r) => (r.createdBy?.sessionId ? [r.createdBy.sessionId] : [])), ...mailboxes.sessions()]);
	let removed = 0;
	for (const lease of leases.list()) if (!working.has(lease.sessionId) && leases.removeIfFree(lease.sessionId)) removed++;
	const pruned = pruneSeen(dir, (id) => working.has(id) || !!leases.read(id));
	if (removed || pruned) log(`swept ${removed} idle conversation lease(s) and ${pruned} since-you-looked cursor(s)`);
}

function everyTick(now: number): void {
	if (!hostServiceNames(dir, process.pid, startedAt)) {
		log("host-service.json no longer names this process; leaving");
		leave(0);
		return;
	}
	try {
		writeLegacyFence(now);
	} catch (err: any) {
		log(`legacy fence: ${err?.message ?? err}`);
	}
	try {
		sweepConversations(now);
	} catch (err: any) {
		log(`conversation sweep: ${err?.message ?? err}`);
	}
	// The heartbeat windows read before they evict: a socket that does not answer while this is fresh
	// is a broken control channel, not a wedged host (src/host-control.ts decideEviction).
	try {
		updateHostService(dir, process.pid, { tickAt: stamp(now) });
	} catch (err: any) {
		log(`heartbeat: ${err?.message ?? err}`);
	}
}

/**
 * A control channel that cannot be opened is a degraded host, not a dead one: `pi-loops host
 * status` falls back to the recorded pid, and the loops keep running. This is the top level of the
 * process, so a throw here would take the host down at startup instead.
 */
function serveHostChannelSafely(...args: Parameters<typeof serveHostChannel>): ReturnType<typeof serveHostChannel> | undefined {
	try {
		return serveHostChannel(...args);
	} catch (err: any) {
		log(`control channel unavailable: ${err?.message ?? err}`);
		return undefined;
	}
}

/** The rules, or none when triggers.json cannot be read: a status must not fail with the file it reports on. */
function rulesOrNone(): ReturnType<typeof host.triggers.store.load> {
	try {
		return host.triggers.store.load();
	} catch (err: any) {
		log(`rules: ${err?.message ?? err}`);
		return [];
	}
}

function snapshot(): HostSnapshot {
	// One read of each store for the whole snapshot. jobs.json was read four times and
	// triggers.json twice, so a tick landing in between could have `enabled` counted against
	// one version of the file and `total` against another — a status line contradicting itself.
	const jobs = host.scheduler.store.load();
	const rules = rulesOrNone();
	return {
		pid: process.pid,
		host: os.hostname(),
		startedAt,
		startedBy: process.env.PI_LOOPS_STARTED_BY || undefined,
		model: session.model,
		version: PI_LOOPS_VERSION,
		sessions: leases.list().flatMap((l) => (l.holder && holderAlive(l.holder) ? [{ sessionId: l.sessionId, pid: l.holder.pid, mode: l.holder.mode }] : [])),
		runs: host.scheduler.runningRuns(),
		checks: host.triggers.runningList().map((r) => ({ traceId: r.traceId, sourceLabel: r.sourceLabel, eventLabel: r.eventLabel, startedAt: r.startedAt, cwd: r.cwd })),
		jobs: { enabled: jobs.filter((j) => j.enabled).length, total: jobs.length },
		rules: { enabled: rules.filter((r) => r.enabled).length, total: rules.length },
		inboxNew: host.scheduler.inbox.newCount(),
		// Without these a host that has failed every run for six hours reads exactly like one
		// that succeeded an hour ago: "nothing running right now".
		recent: host.scheduler.store
			.listRuns(undefined, 5)
			.reverse()
			.map((r) => ({ job: r.jobName ?? r.jobId, at: r.finishedAt, ok: r.ok, error: r.error ? previewRedacted(r.error, 100) : undefined, cost: r.usage?.cost })),
		failing: jobs.filter((j) => j.enabled && j.lastError).map((j) => ({ job: j.name ?? j.id, error: previewRedacted(j.lastError ?? "", 120) })),
		nextDue: (() => {
			const next = jobs
				.filter((j) => j.enabled && j.stateful)
				.map((j) => computeNext({ schedule: j.schedule, createdAt: Date.parse(j.createdAt), lastFiredAt: j.lastFiredAt ? Date.parse(j.lastFiredAt) : undefined }, Date.now()))
				.filter((n): n is number => n !== undefined)
				.sort((a, b) => a - b)[0];
			return next ? stamp(next) : undefined;
		})(),
		budget: (() => {
			const b = host.scheduler.budgetState();
			return b.cap > 0 ? { spent: b.spent, cap: b.cap } : undefined;
		})(),
		mcp: mcpSources.map((s) => ({ name: s.config.name, state: s.status.state, lastError: s.status.lastError ? previewRedacted(s.status.lastError, 120) : undefined })),
		page: pageUrl,
		lastPolls: [...host.triggers.lastPolls.values()],
		notices: host.notices(),
	};
}


/**
 * What the status page shows: the snapshot, and every conversation that has a lease, a plain job, a
 * rule or a mailbox entry, with who holds it. Built per request; the page refreshes every 15 s.
 */
function hostStatus(): HostStatus {
	const jobs = host.scheduler.store.load().filter((j) => j.enabled && !j.stateful && j.sessionId);
	const rules = rulesOrNone().filter((r) => r.enabled && r.createdBy?.sessionId);
	// Only conversations someone holds or that have work: one lease per conversation ever opened
	// would otherwise make the page a list of every closed chat, each reading "nobody".
	const working = new Set([...jobs.map((j) => j.sessionId!), ...rules.map((r) => r.createdBy!.sessionId!), ...mailboxes.sessions()]);
	const leaseList = leases.list().filter((l) => working.has(l.sessionId) || (l.holder && holderAlive(l.holder)));
	const legacy = host.scheduler.presenceList().flatMap((e) => (e.sessionId && !e.leases && e.kind !== "host" ? [{ sessionId: e.sessionId, pid: e.pid }] : []));
	const ids = new Set([...leaseList.map((l) => l.sessionId), ...jobs.map((j) => j.sessionId!), ...rules.map((r) => r.createdBy!.sessionId!), ...legacy.map((l) => l.sessionId)]);
	const mailbox = new Map<string, number>();
	for (const id of ids) {
		const n = mailboxes.pending(id).length;
		if (n) mailbox.set(id, n);
	}
	const seen = readSeen(dir).seen;
	const runs = host.scheduler.store.listRuns(undefined, 1000);
	const findings = host.scheduler.inbox.list();
	const appended = host.triggers.store.listAudit(500, (r) => r.state === "appended");
	return {
		snapshot: snapshot(),
		managed,
		sessions: sessionRows({
			leases: leaseList,
			plainJobSessions: jobs.map((j) => j.sessionId!),
			ruleSessions: rules.map((r) => r.createdBy!.sessionId!),
			mailbox,
			legacy,
			alive: (h) => holderAlive(h),
			since: (id) => sinceYouLooked(runs, findings, id, seen[id], { appended }),
		}),
	};
}

const channel = serveHostChannelSafely(
	dir,
	{
		status: () => snapshot(),
		// The status lines show shortened ids, so that is what a watcher types back.
		abortRun: (runId) => {
			const match = host.scheduler.runningRuns().find((r) => r.runId === runId || r.runId.startsWith(runId));
			return match ? host.scheduler.abortRun(match.runId) : false;
		},
		abortCheck: (traceId) => {
			const match = host.triggers.runningList().find((r) => r.traceId === traceId || r.traceId.startsWith(traceId));
			return match ? host.triggers.abort(match.traceId) : false;
		},
		stop: (reason) => {
			log(reason === "upgrade" ? "a newer pi-loops asked this process to make way; leaving" : "asked to stop; leaving");
			leave(0);
		},
		run: (jobId) => host.scheduler.runNow(jobId),
	},
	log,
);
/**
 * The status page. The default loops directory gets the fixed port a bookmark can rely on; any
 * other directory (a test run, a second setup) takes whatever port is free, so two never fight
 * over one. A taken port costs the page, never the host: it runs on, and `url` is left out.
 */
let pageUrl: string | undefined;
const pagePort = path.resolve(dir) === path.resolve(homeLoopsDir(agentDir)) ? HOST_PAGE_PORT : 0;
const page = await serveHostPage({ port: pagePort, token: claimToken, status: hostStatus, log });
if (page.url) {
	pageUrl = page.url;
	try {
		updateHostService(dir, process.pid, { url: page.url });
	} catch (err: any) {
		log(`could not record the status page: ${err?.message ?? err}`);
	}
	log(`status page: ${page.url}`);
}
parentModel = await defaultModel().catch((err) => {
	log(`default model: ${err?.message ?? err}`);
	return undefined;
});
log(`default model: ${parentModel ? `${parentModel.provider}/${parentModel.id}` : "none (jobs must pin one)"}`);
startMcpSources();
host.start();
// As in the minute timer below: a rules file that cannot be read must cost its rules, not every loop.
try {
	watchProjectPushServers();
} catch (err: any) {
	log(`project push servers: ${err?.message ?? err}`);
}
// The scheduler's timer is unref'd (an extension must never keep pi alive); the host wants to live,
// and re-reads config.toml so edits take effect without a restart.
setInterval(() => {
	try {
		watchProjectPushServers();
	} catch (err: any) {
		log(`project push servers: ${err?.message ?? err}`);
	}
	config = loadConfig(dir);
	logConfigErrors();
	try {
		reloadMcpIfChanged();
	} catch (err: any) {
		log(`mcp.toml: ${err?.message ?? err}`);
	}
	host.triggers.pollIntervalSecs = config.triggerPollIntervalSecs;
	host.triggers.runTimeoutMs = config.triggerRunTimeoutMs;
	// And the model, on the same minute. This process can live for days: a credential added with
	// `/login` in a pi that opened after this host started, or a provider that started resolving, would
	// otherwise never reach it — `parentModel` was resolved once, at startup. Only an improvement is
	// taken: a model that stops resolving leaves the one the host already has in place.
	void defaultModel()
		.then((model) => {
			if (!model || (parentModel && parentModel.provider === model.provider && parentModel.id === model.id)) return;
			parentModel = model;
			log(`default model: ${model.provider}/${model.id}`);
		})
		.catch((err: any) => log(`default model: ${err?.message ?? err}`));
}, 60_000);
