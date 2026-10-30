/**
 * The in-process sub-agent runner, on top of pi's SDK. A run is a new
 * `AgentSession` created inside the interactive pi process — fresh context, its own transcript
 * file, the job's cwd — that shares what the parent has live: the same MCP client instances (a
 * browser tab or database session opened here is the one the loop sees), the parent's `-e`
 * extensions, system prompt and skills, the parent's model unless the job pins one, and the
 * project's trust when the run is in the same project (or one the user trusted before). No child
 * process, nothing re-spawned.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DefaultResourceLoader, type ModelRegistry, ModelRuntime, SessionManager, SettingsManager, createAgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { envFlag } from "./config.ts";
import { realpathish } from "./paths.ts";
import { previewRedacted } from "./redact.ts";
import { type ParentRuntimeFlags, type RunnerResult, type SubagentRequest, type SubagentRunner, failedRun } from "./runner.ts";
import { subagentGuardExtension } from "./subagent-guard.ts";

export interface InProcessRunnerDeps {
	agentDir: string;
	parentFlags: ParentRuntimeFlags;
	/** The interactive session's current model (used when the job pins none, or when a pin stopped resolving). */
	getParentModel: () => Model<any> | undefined;
	/**
	 * The parent session's live model/auth runtime — an extension has it as `ctx.modelRegistry`.
	 * pi applies `--api-key` to that instance (`dist/main.js:642-651`) and `/login` mutates it, so a
	 * run that borrows it authenticates by the exact path the parent authenticated with, and a
	 * credential rotated in the chat is visible on the next tick. Without it the runner builds its
	 * own from `agentDir`, which is the same credentials by a longer route and one that misses both.
	 */
	getParentModelRuntime?: () => ModelRuntime | ModelRegistry | undefined;
	/**
	 * The parent session's active tool names, handed to the sub-agent as its tool list. Without them
	 * pi falls back to its four-tool default, which both drops what the session has (grep, find,
	 * web_fetch…) and keeps what the session took away (`-xt`).
	 */
	/** A warning about a project's runs that a window of that project should show (the host's notices). */
	notice?: (text: string, cwd: string) => void;
	getParentTools?: () => string[] | undefined;
	getParentThinking: () => string | undefined;
	/** The parent's live tools for this run: every MCP server's tools plus the automation tools at hop 1. */
	customTools: (req: SubagentRequest) => ToolDefinition<any, any>[] | Promise<ToolDefinition<any, any>[]>;
	/** Whether project-local resources in `cwd` may be loaded (the user trusted that project). */
	isTrusted: (cwd: string) => boolean;
	/** pi-loops' own package directory: the sub-session must not load a second copy of this extension. */
	ownDir: string;
	/** Command prefixes the dangerous-command gate lets through (`[danger] allow`). */
	allowCommands?: () => readonly string[];
	/**
	 * Today's automation spend and the cap it must stay under — `scheduler.budgetState()`, read
	 * *while* a run is in flight rather than only before it is dispatched. A callback, not the
	 * scheduler itself: the scheduler owns the runner, and the runner must not own the scheduler
	 * back. Omitted (a test, a caller with no scheduler) → runs are not measured against a cap.
	 */
	budget?: () => DailyBudget;
	log?: (message: string) => void;
}

/** What `[limits] daily_budget_usd` has been spent against today, and the cap itself (0 = no cap). */
export interface DailyBudget {
	spent: number;
	cap: number;
}

type Thinking = Parameters<typeof createAgentSession>[0] extends { thinkingLevel?: infer T } | undefined ? T : never;

/**
 * True when `p` lives under `dir` (both resolved through symlinks); never matches a sibling like
 * `dir2/`. Both sides go through `realpathish` because a symlink anywhere above either one makes a
 * textual comparison answer the wrong question, and on macOS that is *every* path under a temporary
 * directory, since /var is a link to /private/var. Here it means our own extension is not
 * recognised as ours, and the sub-session loads a second copy of pi-loops — which pi refuses to
 * start with.
 */
export function isInsideDir(dir: string, p: string): boolean {
	const rel = path.relative(realpathish(dir), realpathish(p));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The settings and resource loader of one sub-session. Trust is decided here and only here:
 * `SettingsManager.create` defaults a project to trusted (pi's CLI passes false explicitly), so
 * an untrusted cwd must be pinned to false or its `.pi/extensions` would run. pi-loops itself is
 * filtered out of the extension set; the sub-session gets the automation tools as customTools.
 */
export function subSessionResources(req: Pick<SubagentRequest, "cwd">, deps: Pick<InProcessRunnerDeps, "agentDir" | "parentFlags" | "isTrusted" | "ownDir" | "log" | "allowCommands">): SubSessionResources {
	const trusted = deps.isTrusted(req.cwd);
	const settingsManager = SettingsManager.create(req.cwd, deps.agentDir, { projectTrusted: trusted });
	const f = deps.parentFlags;
	const ownDir = deps.ownDir;
	const loader = new DefaultResourceLoader({
		cwd: req.cwd,
		agentDir: deps.agentDir,
		settingsManager,
		additionalExtensionPaths: f.extensionPaths,
		additionalSkillPaths: f.skillPaths,
		additionalPromptTemplatePaths: f.promptTemplatePaths,
		noExtensions: f.noExtensions,
		noSkills: f.noSkills,
		noContextFiles: f.noContextFiles,
		noPromptTemplates: f.noPromptTemplates,
		noThemes: true,
		systemPrompt: f.systemPrompt,
		appendSystemPrompt: f.appendSystemPrompt,
		// pi-loops itself must not load a second time; the dangerous-command gate is added in its
		// place, because a sub-session is the one place where no user is watching the tool calls.
		extensionsOverride: (base) => {
			// One loaded set is shared by every run in this cwd (`sharedSubSessionResources`), so a
			// finished run's `session.dispose()` — which invalidates its ExtensionRunner and, through
			// it, the runtime the extensions captured at load time (`dist/core/extensions/loader.js:166-176`)
			// — must not make the next run's `pi.*` calls throw "stale ctx" for good. Per-runner
			// staleness, which is what that message is really about, is untouched. The cost is that
			// a `pi.*` action between runs reaches the most recently created session instead of
			// throwing; pi rebinds those to the live session on the next run (`runner.js:160-175`).
			// pi keeps the runtime's stale flag in a closure (`createExtensionRuntime`'s `state`, dist/core/extensions/
			// loader.js), not on the runtime object, so it cannot be read back and restored after `invalidate()`.
			// And `invalidate()` also unsubscribes every event-bus listener the shared extensions made when they
			// loaded, which the next run needs (pi-mcp-adapter's runtime tool calls, say). The shared runtime lives
			// as long as this loaded set, so it is never invalidated; each run's own ExtensionRunner still is.
			base.runtime.invalidate = () => {};
			return { ...base, extensions: [...base.extensions.filter((e) => !isInsideDir(ownDir, e.resolvedPath) && !isInsideDir(ownDir, e.path)), subagentGuardExtension(deps.log, deps.allowCommands?.() ?? [])] };
		},
	});
	return { settingsManager, loader, trusted };
}

export interface SubSessionResources {
	settingsManager: SettingsManager;
	loader: DefaultResourceLoader;
	trusted: boolean;
}

/** One loaded extension set per (cwd, trust, agent dir, parent flags). */
const loadedResources = new Map<string, Promise<SubSessionResources>>();
/** Projects we have already said are untrusted: say it once, not once per run. */
const untrustedWarned = new Set<string>();

/**
 * The loaded resources for one run, loaded once and then shared. pi re-invokes every extension
 * factory on each `reload()` and keys its module cache by a single process-global cwd
 * (`dist/core/extensions/loader.js:115-129`), so loading per run both re-instantiates the parent's
 * extensions — `pi -e ./browser.ts` opens a browser every tick, and that run's `session_shutdown`
 * closes the one the interactive session is still using, since the module (and whatever it holds)
 * is shared — and wipes that cache whenever a run's cwd differs from this process's. Sharing one
 * loaded set per cwd is the trade, and this is its cost: runs that overlap in one cwd share
 * extension instances, and an extension file edited on disk needs a pi restart to take effect.
 *
 * The trust decision is part of the key, so a loader built for a trusted project can never be
 * handed to an untrusted cwd.
 */
export async function sharedSubSessionResources(req: Pick<SubagentRequest, "cwd">, deps: Pick<InProcessRunnerDeps, "agentDir" | "parentFlags" | "isTrusted" | "ownDir" | "log" | "notice" | "allowCommands">): Promise<SubSessionResources> {
	const trusted = deps.isTrusted(req.cwd);
	// Worth saying out loud once per project: pi's trust prompt offers "trust the parent folder",
	// which records the parent and deletes the child entry, and "this session only", which records
	// nothing — so a run can silently lose the project's AGENTS.md, skills, extensions and settings.
	if (!trusted && !untrustedWarned.has(req.cwd)) {
		untrustedWarned.add(req.cwd);
		const message = `${req.cwd} is not trusted, so runs there get no project settings, skills or extensions (open pi in that directory and run /trust to change it)`;
		deps.log?.(message);
		deps.notice?.(message, req.cwd);
	}
	const key = JSON.stringify([req.cwd, trusted, deps.agentDir, deps.ownDir, deps.parentFlags]);
	let loading = loadedResources.get(key);
	if (!loading) {
		loading = (async () => {
			const resources = subSessionResources(req, { ...deps, isTrusted: () => trusted });
			await resources.loader.reload();
			// Once per load, not once per run: the errors are a property of the extension set.
			for (const e of resources.loader.getExtensions().errors) {
				deps.log?.(`sub-agent extension ${e.path}: ${e.error}`);
				deps.notice?.(`a loop's extension ${e.path} did not load: ${e.error}`, req.cwd);
			}
			return resources;
		})().catch((err) => {
			loadedResources.delete(key); // a failed load (a package install, say) must not be cached
			throw err;
		});
		loadedResources.set(key, loading);
	}
	return loading;
}

/** A conversation's held-turn resources are released after this long without a turn. */
export const HELD_IDLE_MS = 60 * 60 * 1000;
/** At most this many conversations keep their held-turn resources at once. */
export const HELD_RESOURCES_MAX = 8;
/** How long a release may take to send `session_shutdown` before it gives up waiting. */
const HELD_SHUTDOWN_MS = 10_000;

interface HeldEntry {
	loading: Promise<SubSessionResources>;
	lastUsed: number;
	inUse: number;
	release: () => Promise<void>;
}
const heldResources = new Map<string, HeldEntry>();

/**
 * A held turn's resources, loaded once per conversation and kept for that conversation's later
 * turns, rather than once per turn.
 * Loading per turn re-ran every extension factory each time and never shut the instances down, so
 * the long-lived host gained a set of timers, sockets and listeners per turn. One set per
 * conversation, not per cwd: a `pi.*` action from an extension between turns can then only reach
 * another turn of the same conversation, never a loop's throwaway session or someone else's chat.
 * Released after an hour idle, past `HELD_RESOURCES_MAX`, and when the host stops.
 */
export async function heldSubSessionResources(req: Pick<SubagentRequest, "cwd" | "sessionFile">, deps: Pick<InProcessRunnerDeps, "agentDir" | "parentFlags" | "isTrusted" | "ownDir" | "log" | "allowCommands">): Promise<{ resources: SubSessionResources; done: () => void }> {
	const trusted = deps.isTrusted(req.cwd);
	const key = JSON.stringify([req.sessionFile, req.cwd, trusted, deps.agentDir, deps.ownDir, deps.parentFlags]);
	let entry = heldResources.get(key);
	if (!entry) {
		await releaseHeldResources({ keep: HELD_RESOURCES_MAX - 1 });
		const loading = (async () => {
			const resources = subSessionResources(req, { ...deps, isTrusted: () => trusted });
			await resources.loader.reload();
			for (const e of resources.loader.getExtensions().errors) deps.log?.(`held-turn extension ${e.path}: ${e.error}`);
			return resources;
		})();
		const created: HeldEntry = { loading, lastUsed: Date.now(), inUse: 0, release: async () => shutdownResources(await loading.catch(() => undefined), req.cwd, deps) };
		heldResources.set(key, created);
		loading.catch(() => {
			if (heldResources.get(key) === created) heldResources.delete(key); // a failed load is not cached
		});
		entry = created;
	}
	const held = entry;
	held.inUse++;
	const done = () => {
		held.inUse = Math.max(0, held.inUse - 1);
		held.lastUsed = Date.now();
	};
	try {
		return { resources: await held.loading, done };
	} catch (err) {
		done();
		throw err;
	}
}

/**
 * Release cached held-turn resources that no turn is using: those idle for `idleMs`, then the least
 * recently used until at most `keep` remain. `{ idleMs: 0, keep: 0 }` releases everything idle (the
 * host stopping). Returns how many were released.
 */
export async function releaseHeldResources(opts: { now?: number; idleMs?: number; keep?: number } = {}): Promise<number> {
	const now = opts.now ?? Date.now();
	const idleMs = opts.idleMs ?? HELD_IDLE_MS;
	const keep = opts.keep ?? HELD_RESOURCES_MAX;
	const idle = [...heldResources.entries()].filter(([, e]) => e.inUse === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
	const victims = idle.filter(([, e]) => now - e.lastUsed >= idleMs);
	for (const candidate of idle) {
		if (heldResources.size - victims.length <= keep) break;
		if (!victims.includes(candidate)) victims.push(candidate);
	}
	for (const [key] of victims) heldResources.delete(key);
	// In parallel: each release is bounded on its own, and the host stopping waits on all of them.
	await Promise.all(victims.map(([, e]) => e.release()));
	return victims.length;
}

/**
 * Tell a released set's extensions to shut down, then drop it: a throwaway in-memory session built on
 * that set sends `session_shutdown`, and is disposed whatever happens. Bounded, because an extension
 * that never answers must not hold up the host.
 */
async function shutdownResources(resources: SubSessionResources | undefined, cwd: string, deps: Pick<InProcessRunnerDeps, "agentDir" | "log">): Promise<void> {
	if (!resources) return;
	let session: { extensionRunner: { emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> }; dispose(): void } | undefined;
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), HELD_SHUTDOWN_MS);
		timer.unref();
	});
	try {
		const created = await Promise.race([createAgentSession({ cwd, agentDir: deps.agentDir, resourceLoader: resources.loader, settingsManager: resources.settingsManager, sessionManager: SessionManager.inMemory(cwd) }), deadline]);
		if (created === "timeout") return;
		session = created.session as unknown as typeof session;
		const sent = await Promise.race([session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), deadline]);
		if (sent === "timeout") deps.log?.(`held-turn extensions in ${cwd} did not finish session_shutdown within ${HELD_SHUTDOWN_MS / 1000}s`);
	} catch (err: any) {
		deps.log?.(`held-turn extensions in ${cwd}: shutdown failed: ${err?.message ?? err}`);
	} finally {
		if (timer) clearTimeout(timer);
		if (session) disposeSubSession(session, deps.log);
	}
}

/**
 * The parent's `ctx.modelRegistry` is only a synchronous facade over the session's `ModelRuntime`
 * (`dist/core/model-registry.d.ts`), and `createAgentSession` needs the runtime itself — unwrap it
 * here so the caller can hand over whichever it has.
 */
export function unwrapModelRuntime(source: ModelRuntime | ModelRegistry | undefined): ModelRuntime | undefined {
	if (!source) return undefined;
	if (typeof (source as ModelRuntime).getModel === "function") return source as ModelRuntime;
	const inner = (source as unknown as { runtime?: ModelRuntime }).runtime;
	return typeof inner?.getModel === "function" ? inner : undefined;
}

/**
 * The model for one run. A job that pins no model reads the parent's live model when it fires, so
 * a loop follows the session it was set up in. A job may pin one, but a pin that stopped resolving
 * — provider removed, credential deleted, model renamed — must not fail this tick and every tick
 * after it forever; it falls back to the session's model and says so. `getModel` alone is not
 * enough: pi's own restore path pairs it with `hasConfiguredAuth` (`dist/core/sdk.js:89`), or a
 * model still in the catalogue with no credential blows up inside `session.prompt()`.
 */
export function resolveRunModel(
	pinned: string | undefined,
	parentModel: Model<any> | undefined,
	runtime: { getModel(provider: string, modelId: string): Model<any> | undefined; hasConfiguredAuth(provider: string): boolean },
): { model?: Model<any>; warning?: string; error?: string } {
	if (!pinned) return { model: parentModel };
	const [provider, ...rest] = pinned.split("/");
	const model = runtime.getModel(provider, rest.join("/"));
	if (model && runtime.hasConfiguredAuth(model.provider)) return { model };
	const reason = model ? "no auth configured" : "model no longer exists"; // pi's own wording (`dist/core/model-resolver.js:547`)
	if (parentModel) return { model: parentModel, warning: `pinned model ${pinned} is unavailable (${reason}); using ${parentModel.provider}/${parentModel.id}` };
	return { error: `model ${pinned} is not available (${reason}) and the session has none (check /model or /login)` };
}

/**
 * The tool allowlist for one run. A job's own `--tools` is an allowlist over what the parent has
 * (never a way to gain a tool the session gave up); with no `--tools` the run inherits the
 * parent's active set. Custom tools (this run's MCP servers and the automation tools) are always
 * added, because pi's allowlist filters those too and they are the sub-agent's whole point.
 */
export function subSessionTools(req: Pick<SubagentRequest, "tools">, parentTools: string[] | undefined, customTools: Array<{ name: string }>): string[] | undefined {
	const custom = customTools.map((t) => t.name);
	if (req.tools) return [...new Set(req.tools.filter((t) => !parentTools || parentTools.includes(t) || custom.includes(t)))];
	if (!parentTools) return undefined; // no parent session (the headless host): pi's own default
	return [...new Set([...parentTools, ...custom])];
}

/**
 * Why a run in flight has to stop, or undefined while it may go on. `[limits] daily_budget_usd` is
 * a *daily total*, so a run is measured against what today has already cost plus everything this
 * process has in flight, its own cost included: consulted only at the entrance, the cap would bound
 * the rate of dispatch rather than the bill. `cap <= 0` is "no cap", which is the default.
 */
export function budgetStopReason(budget: DailyBudget | undefined, inFlightCost: number): string | undefined {
	if (!budget || !(budget.cap > 0)) return undefined;
	if (budget.spent + inFlightCost < budget.cap) return undefined;
	const money = (n: number) => `$${n.toFixed(2)}`;
	// The first 80 characters are all `/cron runs` shows, so the cap and the word budget come first:
	// a run stopped on purpose must not be read as a run that broke.
	return `stopped by today's ${money(budget.cap)} daily budget (${money(budget.spent)} already spent, ${money(inFlightCost)} in flight); raise [limits] daily_budget_usd or wait for midnight`;
}

/**
 * What this process has spent that the run log does not know about yet. The cap is measured against
 * the run log, and a record only lands there when the run finishes: without this every run in
 * flight would be measured as if the ones beside it were free, and three runs admitted in the same
 * tick could each spend the whole cap.
 */
export interface InFlightCosts {
	/** Register a run's live cost. The returned function retires it once the run is over. */
	enter(runId: string | undefined, cost: () => number): () => void;
	/** Uncommitted spend as this run must see it: every live run, plus this run's finished siblings. */
	total(runId: string | undefined): number;
}

export function createInFlightCosts(remember = 64): InFlightCosts {
	const live = new Set<() => number>();
	// A run's own finished sub-agents: `--verify` makes the checker a second sub-agent of the same
	// run (same `runId`), and it must not be measured as though the maker before it had been free.
	// Read only by a request carrying that id, which cannot double-count: the run's record — the
	// thing that would count the maker a second time — is not written until its checker is done.
	// Nothing tells the runner when that happens, so the map is simply bounded instead of cleared.
	const finished = new Map<string, number>();
	return {
		enter(runId, cost) {
			live.add(cost);
			return () => {
				if (!live.delete(cost)) return;
				if (!runId) return;
				finished.set(runId, (finished.get(runId) ?? 0) + cost());
				const oldest = finished.keys().next();
				if (finished.size > remember && !oldest.done) finished.delete(oldest.value);
			};
		},
		total(runId) {
			let sum = runId ? (finished.get(runId) ?? 0) : 0;
			for (const cost of live) sum += cost();
			return sum;
		},
	};
}

/** What a run had to do to get through, counted off the session's events (nobody else sees them). */
export interface RunTelemetry {
	warning?: string;
	retries: number;
	compactions: number;
}

type SessionStats = { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number; assistantMessages: number };

/**
 * Where a held turn started: the conversation it opened already had messages and a cost, and pi's
 * stats add up the whole file. Everything this run reports is measured from here.
 */
export interface RunBaseline {
	messages: number;
	stats: SessionStats;
}

/** This run's share of a session's stats: everything, or what was added since `base`. */
export function usageSince(stats: SessionStats, base?: SessionStats): RunnerResult["usage"] {
	const less = (a: number, b = 0) => Math.max(0, a - b);
	return {
		input: less(stats.tokens.input, base?.tokens.input),
		output: less(stats.tokens.output, base?.tokens.output),
		cacheRead: less(stats.tokens.cacheRead, base?.tokens.cacheRead),
		cacheWrite: less(stats.tokens.cacheWrite, base?.tokens.cacheWrite),
		cost: less(stats.cost, base?.cost),
		turns: less(stats.assistantMessages, base?.assistantMessages),
	};
}

/** A finished (or failed) sub-session, reduced to what the schedulers record. */
export function collect(
	session: { messages: unknown[]; sessionId: string; sessionFile: string | undefined; getSessionStats(): SessionStats; agent: { state: { errorMessage?: string } } },
	req: Pick<SubagentRequest, "signal" | "timeoutMs">,
	timedOut: boolean,
	thrown?: string,
	telemetry?: RunTelemetry,
	/** Set when the daily budget stopped this run: it outranks the abort it had to use to do it. */
	budgetStopMessage?: string,
	baseline?: RunBaseline,
): RunnerResult {
	// Only this run's messages: in a conversation that already had answers, the last one before this
	// turn is not this turn's reply, and a turn that produced none must not borrow it.
	const messages = (session.messages as any[]).slice(baseline?.messages ?? 0);
	const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
	const text = assistant ? (assistant.content as any[]).filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
	const stopReason: string | undefined = assistant?.stopReason;
	const stats = session.getSessionStats();
	const aborted = req.signal?.aborted ?? false;
	const errorMessage = budgetStopMessage ?? thrown ?? (timedOut ? `timed out after ${Math.round(req.timeoutMs / 1000)}s` : aborted ? "aborted" : stopReason === "error" ? (assistant?.errorMessage ?? session.agent.state.errorMessage ?? "model error") : undefined);
	const ok = !budgetStopMessage && !timedOut && !aborted && !thrown && stopReason !== "error" && stopReason !== "aborted" && !!assistant;
	return {
		ok,
		exitCode: ok ? 0 : 1,
		timedOut,
		text,
		errorMessage: ok ? undefined : (errorMessage ?? "the sub-agent produced no reply"),
		// A budget stop is deliberate, so it reports the abort it performed rather than whatever the
		// model was in the middle of: the schedulers read `aborted` as "this was not the job failing"
		// — the slot goes back, the failure streak is untouched and a one-shot is not retired — which
		// is exactly right for a run the cap ended, and is what an abort mid-call reports anyway.
		stopReason: budgetStopMessage ? "aborted" : stopReason,
		warning: telemetry?.warning,
		model: assistant ? `${assistant.provider}/${assistant.model}` : undefined,
		// A run that silently retried five times or compacted twice must not look like a clean one.
		retries: telemetry?.retries,
		compactions: telemetry?.compactions,
		usage: usageSince(stats, baseline?.stats),
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
	};
}

/** Resolved when the run's deadline or its abort signal fires; raced against every setup step. */
const STOPPED = Symbol("stopped");

/**
 * End of one run. No `session_shutdown`: the extension instances are shared with the runs that
 * follow and, through pi's process-global module cache, with the parent's own instances — a
 * sub-run's shutdown would close the browser the interactive session is still using, and a run is
 * a guest in this process rather than its owner. `dispose()` stays: it is per-session (abort,
 * listeners, that session's own resources).
 */
export function disposeSubSession(session: { dispose(): void }, log?: (message: string) => void): void {
	try {
		session.dispose();
	} catch (err: any) {
		log?.(`sub-agent dispose: ${err?.message ?? err}`);
	}
}

export function createInProcessRunner(deps: InProcessRunnerDeps): SubagentRunner {
	// Conversations whose held turns stopped coming give their extensions back within the idle window.
	const sweep = setInterval(() => void releaseHeldResources().catch((err: any) => deps.log?.(`held-turn resources: ${err?.message ?? err}`)), 10 * 60 * 1000);
	sweep.unref();
	// Only a fallback for the headless host, which has no interactive session to borrow from. It
	// reads the credentials of *this* agent dir, and is rebuilt when they change on disk, so a
	// rotated key or a fresh `pi login` is picked up without restarting the host.
	const authPath = path.join(deps.agentDir, "auth.json");
	const modelsPath = path.join(deps.agentDir, "models.json");
	const authStamp = () => {
		try {
			const s = fs.statSync(authPath);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return "none";
		}
	};
	let own: { stamp: string; runtime: Promise<ModelRuntime> } | undefined;
	const ownRuntime = () => {
		const stamp = authStamp();
		if (own?.stamp !== stamp) {
			const entry: { stamp: string; runtime: Promise<ModelRuntime> } = {
				stamp,
				runtime: ModelRuntime.create({ authPath, modelsPath }).catch((err) => {
					if (own === entry) own = undefined; // a failed creation must not be cached forever
					throw err;
				}),
			};
			own = entry;
		}
		return own.runtime;
	};
	const modelRuntime = async (): Promise<ModelRuntime> => unwrapModelRuntime(deps.getParentModelRuntime?.()) ?? (await ownRuntime());
	// Shared by every run this runner starts, so each one is measured against what the others are
	// spending right now and not only against what the run log has already been told.
	const inFlight = createInFlightCosts();

	return async (req: SubagentRequest): Promise<RunnerResult> => {
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let unsubscribe: (() => void) | undefined;
		let releaseHeld: (() => void) | undefined;
		let timedOut = false;
		let takenBack = false;
		let budgetStopMessage: string | undefined;
		let stop = () => {};
		const stopped = new Promise<typeof STOPPED>((resolve) => {
			stop = () => resolve(STOPPED);
		});
		const onAbort = () => {
			stop();
			// pi's abort can reject (a provider connection already torn down); the run is over either
			// way, and an unhandled rejection here would end the parent session, not just the run.
			void session?.abort().catch(() => undefined);
		};
		// The deadline covers resource loading and session creation too, not just the prompt.
		const timer = setTimeout(() => {
			timedOut = true;
			onAbort();
		}, req.timeoutMs);
		timer.unref();
		req.signal?.addEventListener("abort", onAbort, { once: true });
		// This run's own live cost, and its place in what the process has in flight. Retired in the
		// `finally` below, before the session is disposed, so its final cost is still readable there.
		let baseline: RunBaseline | undefined;
		const runCost = () => {
			try {
				return Math.max(0, (session?.getSessionStats().cost ?? 0) - (baseline?.stats.cost ?? 0));
			} catch {
				return 0; // a half-built or already disposed session has nothing to report
			}
		};
		const retireCost = inFlight.enter(req.runId, runCost);
		/**
		 * Whether the daily budget has to stop this run — and if so, stops it. The abort is the
		 * timeout's: pi's `session.abort()`, the same `stopped` race, the same `collect()` at the end,
		 * so the run is recorded with its cost, the slot is handed back and the schedule keeps its
		 * next appointment. Only the reason differs, and it has to: `/cron runs` would otherwise show
		 * a deliberate stop exactly like a job that broke.
		 */
		const overBudget = (): boolean => {
			if (budgetStopMessage) return true;
			let budget: DailyBudget | undefined;
			try {
				budget = deps.budget?.();
			} catch {
				return false; // an unreadable run log must not fail the run (`budgetState` reads it too)
			}
			const reason = budgetStopReason(budget, inFlight.total(req.runId));
			if (!reason) return false;
			budgetStopMessage = reason;
			deps.log?.(reason);
			onAbort();
			return true;
		};
		const stoppedEarly = () => (takenBack ? failedRun("taken back: a window opened this conversation", { stopReason: "aborted" }) : budgetStopMessage ? failedRun(budgetStopMessage, { stopReason: "aborted" }) : timedOut ? failedRun(`timed out after ${Math.round(req.timeoutMs / 1000)}s`, { timedOut: true }) : req.signal?.aborted ? failedRun("aborted", { stopReason: "aborted" }) : undefined);
		const stoppedResult = () => stoppedEarly() ?? failedRun("aborted", { stopReason: "aborted" });
		// Until the session exists there is nothing for `abort()` to reach, and setup is not quick:
		// `loader.reload()` shells out to npm/git for a project's `settings.json` packages, so a
		// stalled clone would hold the job's running claim and a concurrency slot forever. So every
		// setup step is raced against the run's own deadline, not only the model call after them.
		// The step itself keeps running detached — an npm install cannot be cancelled — but the run
		// gives its slot back on time and the finished load still lands in the shared cache.
		const untilStopped = async <T>(work: T | Promise<T>): Promise<T | typeof STOPPED> => Promise.race([work, stopped]);
		const telemetry: RunTelemetry = { retries: 0, compactions: 0 };
		try {
			// Before anything is bought: the day can go over between the dispatcher admitting this run
			// and the run reaching here, because the runs admitted with it are spending in parallel.
			// Setting up is not free either — loading a project's packages shells out to npm/git.
			if (overBudget()) return stoppedResult();
			let model: Model<any> | undefined;
			try {
				const parent = deps.getParentModel();
				// Only a pinned model needs the catalogue; the parent's model is already resolved.
				let resolved: ReturnType<typeof resolveRunModel> = { model: parent };
				if (req.model) resolved = resolveRunModel(req.model, parent, await modelRuntime());
				else if (req.sessionFile) resolved = { model: undefined }; // a conversation keeps the model it was using
				if (resolved.error) return failedRun(resolved.error);
				model = resolved.model;
				if (resolved.warning) {
					telemetry.warning = resolved.warning;
					deps.log?.(resolved.warning);
				}
				if (!model && !req.sessionFile) return failedRun("no model is available for the sub-agent (the session has none and the job pins none)");
			} catch (err: any) {
				return failedRun(`model runtime: ${err?.message ?? err}`);
			}

			const customTools = await untilStopped(deps.customTools(req));
			if (customTools === STOPPED) return stoppedResult();
			// A held turn runs in someone's conversation, so it gets a loader of its own: the shared one
			// stubs `invalidate`, which is fine for a throwaway sub-session and wrong for that.
			// A held turn borrows its conversation's cached set and hands it back however the run ends.
			const heldLoad = req.sessionFile ? heldSubSessionResources(req, deps) : undefined;
			releaseHeld = heldLoad ? () => void heldLoad.then((h) => h.done()).catch(() => undefined) : undefined;
			const resources = await untilStopped(heldLoad ? heldLoad.then((h) => h.resources) : sharedSubSessionResources(req, deps));
			if (resources === STOPPED) return stoppedResult();
			const created = await untilStopped(
				createAgentSession({
					cwd: req.cwd,
					agentDir: deps.agentDir,
					model,
					thinkingLevel: (req.thinking ?? (req.sessionFile ? undefined : deps.getParentThinking())) as Thinking,
					tools: subSessionTools(req, deps.getParentTools?.(), customTools),
					customTools,
					resourceLoader: resources.loader,
					sessionManager: req.sessionFile ? SessionManager.open(req.sessionFile) : req.sessionDir ? SessionManager.create(req.cwd, req.sessionDir) : SessionManager.inMemory(req.cwd),
					settingsManager: resources.settingsManager,
					modelRuntime: await modelRuntime(),
					sessionStartEvent: { type: "session_start", reason: "new" },
				}),
			);
			if (created === STOPPED) return stoppedResult();
			session = created.session;
			// A held turn opens a conversation that already has a history and a cost: measure from here.
			if (req.sessionFile) baseline = { messages: session.messages.length, stats: session.getSessionStats() };
			if (session.sessionFile) req.onSessionFile?.(session.sessionFile);

			// Nobody else watches this session, so what the run had to do to get through is only
			// visible here: silent provider retries and context compactions.
			// PI_LOOPS_DEBUG=1 traces what the run actually did:
			// enough to recognise a retry storm, a tool loop or a run that produced nothing, without
			// opening the transcript. It goes to the same log the rest of the diagnostics do.
			const debug = envFlag("LOOPS_DEBUG");
			const label = `${req.kind}/${(req.jobId ?? req.traceId ?? "?").slice(0, 12)}`;
			unsubscribe = session.subscribe((e: any) => {
				// The per-event lease check of a held turn. pi persists at message and tool boundaries, so
				// stopping at the first event after a window took the conversation bounds what is written
				// after it to one entry.
				if (req.stillHolds && e.type !== "message_update" && !takenBack && !req.stillHolds()) {
					takenBack = true;
					onAbort();
					return;
				}
				if (e.type === "auto_retry_start") {
					telemetry.retries++;
					if (debug) deps.log?.(`debug ${label}: provider retry`);
				} else if (e.type === "compaction_end" && !e.aborted) {
					telemetry.compactions++;
					if (debug) deps.log?.(`debug ${label}: context compacted`);
				} else if (e.type === "turn_end") {
					// Once per turn, not per event: a completed turn is the smallest step whose cost has
					// actually landed in the session's stats (`getSessionStats` adds up its entries), and
					// the point where stopping wastes nothing that was already paid for. Checking on every
					// event would re-read the whole session for deltas that cannot have changed.
					overBudget();
				} else if (debug && e.type === "tool_execution_start") deps.log?.(`debug ${label}: ${e.toolName} ${previewRedacted(JSON.stringify(e.args ?? {}), 160)}`);
				else if (debug && e.type === "tool_execution_end") deps.log?.(`debug ${label}: ${e.toolName} ${e.isError ? "FAILED" : "ok"}`);
			});
			if (debug) deps.log?.(`debug ${label}: started in ${req.cwd} on ${model?.provider}/${model?.id}`);
			// The parent's extensions get their session_start (they may register tools or state there),
			// exactly as pi's own headless modes bind them.
			const bound = await untilStopped(session.bindExtensions({ mode: "print", onError: (e) => deps.log?.(`sub-agent extension ${e.extensionPath} ${e.event}: ${e.error}`) }));
			if (bound === STOPPED) return stoppedResult();
			// Setup can take seconds; the runs beside this one were spending throughout. Check with the
			// session in hand, before the first token is bought, then once per turn from the subscriber.
			if (overBudget()) return collect(session, req, timedOut, undefined, telemetry, budgetStopMessage, baseline);
			await session.prompt(req.prompt);
			return collect(session, req, timedOut, undefined, telemetry, budgetStopMessage, baseline);
		} catch (err: any) {
			const message = err?.message ?? String(err);
			if (session) return collect(session, req, timedOut, message, telemetry, budgetStopMessage, baseline);
			return failedRun(budgetStopMessage ?? message, { warning: telemetry.warning });
		} finally {
			clearTimeout(timer);
			stop();
			retireCost();
			unsubscribe?.();
			req.signal?.removeEventListener("abort", onAbort);
			if (session) disposeSubSession(session, deps.log);
			releaseHeld?.();
		}
	};
}
