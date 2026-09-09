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
import { HOST_LOG, clearHostRecord, hostProcessMatches, readHost, writeHostRecord } from "./host-control.ts";
import { withFileLock } from "./lock.ts";
import { createHostRuntime } from "./host-runtime.ts";
import { McpSource, droppedNotificationMessage, loadMcpConfigFiles, mapNotification, mcpToolDefinitions } from "./mcp.ts";
import { previewRedacted, redact } from "./redact.ts";
import { parentRuntimeFlags } from "./runner.ts";
import type { SessionSnapshot } from "./scheduler.ts";
import { createInProcessRunner } from "./sdk-runner.ts";
import { defaultLoopsDir } from "./store.ts";
import { PI_LOOPS_VERSION } from "./version.ts";

const agentDir = getAgentDir();
const dir = process.env.PI_LOOPS_DIR || defaultLoopsDir(agentDir);
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(dir, { recursive: true });
const logFile = path.join(dir, HOST_LOG);
const log = (msg: string) => {
	const line = `${new Date().toISOString()} ${redact(msg)}\n`;
	try {
		fs.appendFileSync(logFile, line);
	} catch {
		process.stderr.write(line);
	}
};

let config = loadConfig(dir);
for (const e of config.errors) log(`config: ${e}`);

// The session the host "is": no chat, no project; for unpinned work, the model and thinking level
// of the pi that handed off (env), else the settings' defaults. Never "some available model".
const settings = SettingsManager.create(os.homedir(), agentDir, { projectTrusted: false });
const settingsModel = settings.getDefaultProvider() && settings.getDefaultModel() ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}` : undefined;
const session: SessionSnapshot = { cwd: "", model: process.env.PI_LOOPS_HOST_MODEL || settingsModel, thinking: (process.env.PI_LOOPS_HOST_THINKING as SessionSnapshot["thinking"]) || settings.getDefaultThinkingLevel(), trusted: false };
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
	const fromEnv = process.env[ref];
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
	isTrusted: (cwd) => new ProjectTrustStore(agentDir).get(cwd) === true,
	ownDir: PACKAGE_DIR,
	log: (m) => log(`sub-agent: ${m}`),
});
const host = createHostRuntime({
	dir,
	config: () => config,
	session: () => session,
	runner,
	mcpTools: () => [...mcpToolDefs.values()].flat(),
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
		await Promise.all(mcpSources.map((s) => s.stop()));
	} catch (err: any) {
		log(`shutdown: ${err?.message ?? err}`);
	}
	// A clean exit removes the record; a crash leaves it so the next pi can say the host died.
	if (code === 0) clearHostRecord(dir, process.pid);
	log(`host stopped (exit ${code})`);
	process.exit(code);
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("uncaughtException", (err) => {
	log(`uncaught: ${redact(String(err?.stack ?? err))}`);
	void shutdown(1);
});
process.on("unhandledRejection", (err: any) => log(`unhandled rejection: ${redact(String(err?.stack ?? err))}`));

// One host per machine: two pis quitting together may both spawn one; the second to get here
// leaves without touching the first's record (host.json names the survivor, so /cron host and
// crash detection keep working).
const claimed = await withFileLock(path.join(dir, "host.lock"), () => {
	const other = readHost(dir);
	if (other && other.pid !== process.pid && other.host === os.hostname() && hostProcessMatches(other)) return false;
	writeHostRecord(dir, { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), node: process.execPath, entry: process.argv[1] });
	return true;
});
if (!claimed) {
	log(`another host is already running (pid ${readHost(dir)?.pid}); exiting`);
	process.exit(0);
}
log(`pi-loops ${PI_LOOPS_VERSION} headless host started (pid ${process.pid}, dir ${dir})`);
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
	host.triggers.pollIntervalSecs = config.triggerPollIntervalSecs;
	host.triggers.runTimeoutMs = config.triggerRunTimeoutMs;
}, 60_000);
