/**
 * The in-process sub-agent runner: pie's `SubAgent` on top of pi's SDK. A run is a new
 * `AgentSession` created inside the interactive pi process — fresh context, its own transcript
 * file, the job's cwd — that shares what the parent has live: the same MCP client instances (a
 * browser tab or database session opened here is the one the loop sees), the parent's `-e`
 * extensions, system prompt and skills, the parent's model unless the job pins one, and the
 * project's trust when the run is in the same project (or one the user trusted before). No child
 * process, nothing re-spawned.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { type ParentRuntimeFlags, type RunnerResult, type SubagentRequest, type SubagentRunner, failedRun } from "./runner.ts";

export interface InProcessRunnerDeps {
	agentDir: string;
	parentFlags: ParentRuntimeFlags;
	/** The interactive session's current model (used when the job pins none). */
	getParentModel: () => Model<any> | undefined;
	getParentThinking: () => string | undefined;
	/** The parent's live tools for this run: every MCP server's tools plus the automation tools at hop 1. */
	customTools: (req: SubagentRequest) => ToolDefinition<any, any>[];
	/** Whether project-local resources in `cwd` may be loaded (the user trusted that project). */
	isTrusted: (cwd: string) => boolean;
	/** pi-loops' own package directory: the sub-session must not load a second copy of this extension. */
	ownDir: string;
	log?: (message: string) => void;
}

type Thinking = Parameters<typeof createAgentSession>[0] extends { thinkingLevel?: infer T } | undefined ? T : never;

/** True when `p` lives under `dir` (both resolved through symlinks); never matches a sibling like `dir2/`. */
export function isInsideDir(dir: string, p: string): boolean {
	const real = (x: string) => {
		try {
			return fs.realpathSync(x);
		} catch {
			return path.resolve(x);
		}
	};
	const rel = path.relative(real(dir), real(p));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The settings and resource loader of one sub-session. Trust is decided here and only here:
 * `SettingsManager.create` defaults a project to trusted (pi's CLI passes false explicitly), so
 * an untrusted cwd must be pinned to false or its `.pi/extensions` would run. pi-loops itself is
 * filtered out of the extension set; the sub-session gets the automation tools as customTools.
 */
export function subSessionResources(req: Pick<SubagentRequest, "cwd">, deps: Pick<InProcessRunnerDeps, "agentDir" | "parentFlags" | "isTrusted" | "ownDir">): { settingsManager: SettingsManager; loader: DefaultResourceLoader; trusted: boolean } {
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
		extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((e) => !isInsideDir(ownDir, e.resolvedPath) && !isInsideDir(ownDir, e.path)) }),
	});
	return { settingsManager, loader, trusted };
}

/** A finished (or failed) sub-session, reduced to what the schedulers record. */
export function collect(
	session: { messages: unknown[]; sessionId: string; sessionFile: string | undefined; getSessionStats(): { tokens: { input: number; output: number }; cost: number; assistantMessages: number }; agent: { state: { errorMessage?: string } } },
	req: Pick<SubagentRequest, "signal" | "timeoutMs">,
	timedOut: boolean,
	thrown?: string,
): RunnerResult {
	const messages = session.messages as any[];
	const assistant = [...messages].reverse().find((m) => m?.role === "assistant");
	const text = assistant ? (assistant.content as any[]).filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
	const stopReason: string | undefined = assistant?.stopReason;
	const stats = session.getSessionStats();
	const aborted = req.signal?.aborted ?? false;
	const errorMessage = thrown ?? (timedOut ? `timed out after ${Math.round(req.timeoutMs / 1000)}s` : aborted ? "aborted" : stopReason === "error" ? (assistant?.errorMessage ?? session.agent.state.errorMessage ?? "model error") : undefined);
	const ok = !timedOut && !aborted && !thrown && stopReason !== "error" && stopReason !== "aborted" && !!assistant;
	return {
		ok,
		exitCode: ok ? 0 : 1,
		timedOut,
		text,
		errorMessage: ok ? undefined : (errorMessage ?? "the sub-agent produced no reply"),
		stopReason,
		model: assistant ? `${assistant.provider}/${assistant.model}` : undefined,
		usage: { input: stats.tokens.input, output: stats.tokens.output, cost: stats.cost, turns: stats.assistantMessages },
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
	};
}

export function createInProcessRunner(deps: InProcessRunnerDeps): SubagentRunner {
	let runtime: Promise<ModelRuntime> | undefined;
	const modelRuntime = () =>
		(runtime ??= ModelRuntime.create().catch((err) => {
			runtime = undefined; // a failed creation must not be cached forever
			throw err;
		}));

	return async (req: SubagentRequest): Promise<RunnerResult> => {
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let timedOut = false;
		const onAbort = () => void session?.abort();
		// The deadline covers resource loading and session creation too, not just the prompt.
		const timer = setTimeout(() => {
			timedOut = true;
			void session?.abort();
		}, req.timeoutMs);
		timer.unref();
		req.signal?.addEventListener("abort", onAbort, { once: true });
		const stoppedEarly = () => (timedOut ? failedRun(`timed out after ${Math.round(req.timeoutMs / 1000)}s`, { timedOut: true }) : req.signal?.aborted ? failedRun("aborted", { stopReason: "aborted" }) : undefined);
		try {
			let model: Model<any> | undefined;
			try {
				model = deps.getParentModel();
				if (req.model) {
					const [provider, ...rest] = req.model.split("/");
					model = (await modelRuntime()).getModel(provider, rest.join("/")) ?? undefined;
					if (!model) return failedRun(`model ${req.model} is not available (check /model or /login)`);
				}
				if (!model) return failedRun("no model is available for the sub-agent (the session has none and the job pins none)");
			} catch (err: any) {
				return failedRun(`model runtime: ${err?.message ?? err}`);
			}

			const { settingsManager, loader } = subSessionResources(req, deps);
			await loader.reload();
			for (const e of loader.getExtensions().errors) deps.log?.(`sub-agent extension ${e.path}: ${e.error}`);
			const early = stoppedEarly();
			if (early) return early;
			const created = await createAgentSession({
				cwd: req.cwd,
				agentDir: deps.agentDir,
				model,
				thinkingLevel: (req.thinking ?? deps.getParentThinking()) as Thinking,
				tools: req.tools,
				customTools: deps.customTools(req),
				resourceLoader: loader,
				sessionManager: req.sessionDir ? SessionManager.create(req.cwd, req.sessionDir) : SessionManager.inMemory(req.cwd),
				settingsManager,
				modelRuntime: await modelRuntime(),
				sessionStartEvent: { type: "session_start", reason: "new" },
			});
			session = created.session;
			for (const e of created.extensionsResult.errors) deps.log?.(`sub-agent extension ${e.path}: ${e.error}`);
			// The parent's extensions get their session_start (they may register tools or state there),
			// exactly as pi's own headless modes bind them.
			await session.bindExtensions({ mode: "print", onError: (e) => deps.log?.(`sub-agent extension ${e.extensionPath} ${e.event}: ${e.error}`) });
			const late = stoppedEarly();
			if (late) return late;
			await session.prompt(req.prompt);
			return collect(session, req, timedOut);
		} catch (err: any) {
			const message = err?.message ?? String(err);
			if (session) return collect(session, req, timedOut, message);
			return failedRun(message);
		} finally {
			clearTimeout(timer);
			req.signal?.removeEventListener("abort", onAbort);
			if (session) {
				// …and their session_shutdown, so nothing an extension started for this run leaks.
				try {
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} catch {
					/* best effort */
				}
				try {
					session.dispose();
				} catch {
					/* best effort */
				}
			}
		}
	};
}
