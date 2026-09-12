/**
 * The headless host — pi-loops with no pi window. Started by the last interactive pi to quit
 * (`host-control.ts`), it keeps the clock on this machine: stateful loops, dynamic trigger checks
 * for every project, MCP pushes, catch-up — with the same stores, the same in-process sub-agent
 * runner (pi's SDK) and its own MCP client instances. Chat-bound results go to the inbox. The
 * first interactive pi to open takes the clock back (its scheduler preempts a "host" leader) and
 * this process exits. Nothing restarts it after a reboot until a pi opens.
 *
 *   node --import <pkg>/src/register-pi.mjs <pkg>/src/host.ts     (env: PI_LOOPS_DIR, PI_LOOPS_PI_PACKAGE)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, ProjectTrustStore, SettingsManager, getAgentDir, readStoredCredential, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.ts";
import { computeNext, stamp } from "./schedule.ts";
import { hostSocketPath, serveHostChannel } from "./host-control-channel.ts";
import { HOST_LOG, clearHostRecord, hostProcessMatches, readHost, writeHostRecord } from "./host-control.ts";
import { THINKING_LEVELS, thinkingLevelOrUndefined } from "./thinking.ts";
import { withFileLock } from "./lock.ts";
import { rotateInPlace } from "./log.ts";
import { createHostRuntime } from "./host-runtime.ts";
import { McpPool } from "./mcp-pool.ts";
import { McpSource, droppedNotificationMessage, loadMcpConfigFiles, mapNotification, mcpToolDefinitions, mcpTokenFromEnv } from "./mcp.ts";
import { previewRedacted, redact } from "./redact.ts";
import { parentRuntimeFlags } from "./runner.ts";
import type { SessionSnapshot } from "./scheduler.ts";
import { createInProcessRunner } from "./sdk-runner.ts";
import { defaultLoopsDir } from "./store.ts";
import { isExactlyTrusted } from "./trust.ts";
import { PI_LOOPS_VERSION } from "./version.ts";

const agentDir = getAgentDir();
const dir = process.env.PI_LOOPS_DIR || defaultLoopsDir(agentDir);
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(dir, { recursive: true });
const logFile = path.join(dir, HOST_LOG);
const log = (msg: string) => {
	const line = `${stamp()} ${redact(msg)}\n`;
	try {
		fs.appendFileSync(logFile, line);
		// The host's stdout and stderr are this file too (host-control.ts), so a chatty MCP server
		// writes here as well. It is the one file a user is told to read; keep it readable — by the
		// same rule as every other log in this project, which lives in src/log.ts.
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

// The session the host "is": no chat, no project; for unpinned work, the model and thinking level
// of the pi that handed off (env), else the settings' defaults. Never "some available model".
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

const mcpLoaded = loadMcpConfigFiles({ dir, projectTrusted: false });
for (const d of mcpLoaded.diagnostics) log(`mcp: ${d}`);
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

const runner = createInProcessRunner({
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
});
/** Project-level MCP servers, connected on demand: the host itself has no project. */
const mcpPool = new McpPool({ isTrusted: (cwd) => isExactlyTrusted(agentDir, cwd), resolveToken: resolveMcpToken, log: (msg) => log(`mcp pool: ${msg}`) });
const host = createHostRuntime({
	dir,
	config: () => config,
	session: () => session,
	runner,
	mcpTools: () => [...mcpToolDefs.values()].flat(),
	projectMcpTools: (cwd, taken) => mcpPool.toolsFor(cwd, taken),
	// Project-local hooks.toml: the same exact-trust rule as a project's MCP servers and tools.
	isProjectTrusted: (cwd) => isExactlyTrusted(agentDir, cwd),
	log,
	exit: (code) => shutdown(code),
});

function startMcpSources(): void {
	for (const cfg of mcpLoaded.servers) {
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
			onNotification: (n) => {
				const trigger = mapNotification(cfg.name, n);
				if (!trigger) {
					source.status.droppedCount++;
					source.status.lastError = droppedNotificationMessage(n.method);
					return;
				}
				const delivery = cfg.injectAndRun ? "inject_and_run" : cfg.injectSummary ? "inject_summary" : "sub_agent";
				void host.triggers.handle(trigger, delivery).catch((err) => log(`trigger: ${err?.message ?? err}`));
			},
			resolveToken: resolveMcpToken,
			log: (msg) => log(`mcp ${cfg.name}: ${previewRedacted(msg, 200)}`),
		});
		mcpSources.push(source);
		source.start();
	}
}

/* ------------------------------------------------------------ lifecycle */

let stopping = false;
async function shutdown(code: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	// Whatever hangs (a lock, an MCP server that will not die), the process leaves.
	setTimeout(() => process.exit(code), 10_000).unref();
	try {
		await host.stop();
		await mcpPool.stopAll();
		await Promise.all(mcpSources.map((s) => s.stop()));
	} catch (err: any) {
		log(`shutdown: ${err?.message ?? err}`);
	}
	try {
		channel?.close();
		fs.rmSync(hostSocketPath(dir), { force: true });
	} catch {
		/* going away anyway */
	}
	// A clean exit removes the record; a crash leaves it so the next pi can say the host died.
	if (code === 0) clearHostRecord(dir, process.pid);
	log(`host stopped (exit ${code})`);
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
process.on("uncaughtException", (err) => {
	log(`uncaught: ${redact(String(err?.stack ?? err))}`);
	leave(1);
});
process.on("unhandledRejection", (err: any) => log(`unhandled rejection: ${redact(String(err?.stack ?? err))}`));

// One host per machine: two pis quitting together may both spawn one; the second to get here
// leaves without touching the first's record (host.json names the survivor, so /cron host and
// crash detection keep working).
const claimed = await withFileLock(path.join(dir, "host.lock"), () => {
	const other = readHost(dir);
	if (other && other.pid !== process.pid && other.host === os.hostname() && hostProcessMatches(other)) return false;
	writeHostRecord(dir, { pid: process.pid, host: os.hostname(), startedAt: stamp(), node: process.execPath, entry: process.argv[1] });
	return true;
});
if (!claimed) {
	log(`another host is already running (pid ${readHost(dir)?.pid}); exiting`);
	process.exit(0);
}
log(`pi-loops ${PI_LOOPS_VERSION} headless host started (pid ${process.pid}, dir ${dir})`);
// A window into a process with no chat: `/cron host` and `pi-loops host status` read this.
const startedAt = stamp();
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

const channel = serveHostChannelSafely(
	dir,
	{
		status: () => {
			// One read of each store for the whole snapshot. jobs.json was read four times and
			// triggers.json twice, so a tick landing in between could have `enabled` counted against
			// one version of the file and `total` against another — a status line contradicting itself.
			const jobs = host.scheduler.store.load();
			const rules = host.triggers.store.load();
			return {
				pid: process.pid,
				host: os.hostname(),
				startedAt,
				model: session.model,
				leader: host.scheduler.isLeader,
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
			};
		},
		// The status lines show shortened ids, so that is what a watcher types back.
		abortRun: (runId) => {
			const match = host.scheduler.runningRuns().find((r) => r.runId === runId || r.runId.startsWith(runId));
			return match ? host.scheduler.abortRun(match.runId) : false;
		},
		abortCheck: (traceId) => {
			const match = host.triggers.runningList().find((r) => r.traceId === traceId || r.traceId.startsWith(traceId));
			return match ? host.triggers.abort(match.traceId) : false;
		},
		stop: () => leave(0),
	},
	log,
);
parentModel = await defaultModel().catch((err) => {
	log(`default model: ${err?.message ?? err}`);
	return undefined;
});
log(`default model: ${parentModel ? `${parentModel.provider}/${parentModel.id}` : "none (jobs must pin one)"}`);
startMcpSources();
host.start();
// The scheduler's timer is unref'd (an extension must never keep pi alive); the host wants to live,
// and re-reads config.toml so edits take effect without a restart.
setInterval(() => {
	config = loadConfig(dir);
	logConfigErrors();
	host.triggers.pollIntervalSecs = config.triggerPollIntervalSecs;
	host.triggers.runTimeoutMs = config.triggerRunTimeoutMs;
	// And the model, on the same minute. This process can live for days: a credential added with
	// `/login` in a pi that opened after the hand-off, or a provider that started resolving, would
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
