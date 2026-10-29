/**
 * Project-level MCP servers for runs outside this process's own project.
 *
 * A pi process loads `<its cwd>/.pi/mcp.toml` once and shares those clients. But a loop belongs to
 * a project, not to whichever pi owns the clock: a job in project B run by a pi open in project A
 * used to get A's servers and never B's, and the headless host (no project at all) got none. A
 * single-project process never has this problem — one process, one cwd, one project; this pool is
 * what gives a run its own project's servers when the two differ. It connects a project's servers
 * lazily, keyed by directory, and hands their tools to runs in that directory.
 *
 * User-level servers are not pooled: those are shared and already connected by the process.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpSource, loadProjectMcpConfig, mcpToolDefinitions, type McpNotification, type McpServerConfig } from "./mcp.ts";
import { realpathish } from "./paths.ts";
import { previewRedacted } from "./redact.ts";

export interface McpPoolOptions {
	/** Whether project-local config in `cwd` may be loaded at all (pi's saved trust decisions). */
	isTrusted: (cwd: string) => boolean;
	/** Where an untrusted project or a failed connection is reported (one line, not one per run). */
	log?: (message: string) => void;
	resolveToken?: (ref: string) => string | undefined;
	/**
	 * A push from a project's server. The host passes this: a project's rules are evaluated by the
	 * host alone, so a project-level push server has to reach it (a window drops rule-evaluated
	 * pushes). Without it the pool only lends tools.
	 */
	onNotification?: (cwd: string, cfg: McpServerConfig, notification: McpNotification, source: McpSource) => void;
}

interface Entry {
	sources: McpSource[];
	defs: Array<{ name: string; def: ToolDefinition<any, any>; server: string }>;
	ready: Promise<void>;
	lastUsed: number;
	/** Kept connected for its pushes by `watch`, not only lent to a run. */
	watched?: boolean;
}

/** Projects kept connected at once; the least recently used is dropped past this. */
const MAX_POOLED_PROJECTS = 8;

export class McpPool {
	private readonly entries = new Map<string, Entry>();
	/** Projects we already said were untrusted: say it once, not once per run. */
	private readonly warned = new Set<string>();
	private warnedOverCap = false;
	private readonly opts: McpPoolOptions;
	constructor(opts: McpPoolOptions) {
		this.opts = opts;
	}

	/**
	 * The project-level MCP tools for a run in `cwd`, connecting that project's servers on first use.
	 * `taken` is the tool names already in use for that run (built-ins, user-level MCP tools, the
	 * automation tools), so a project's server cannot shadow one of them.
	 */
	async toolsFor(cwd: string, taken: Set<string>): Promise<ToolDefinition<any, any>[]> {
		if (!cwd) return [];
		// Trust is re-checked every time: a decision the user revoked must stop lending servers,
		// not keep the ones an earlier run happened to connect.
		if (!this.opts.isTrusted(cwd)) {
			const stale = this.entries.get(cwd);
			if (stale) {
				this.entries.delete(cwd);
				void Promise.all(stale.sources.map((s) => s.stop())).catch(() => undefined);
			}
			if (!this.warned.has(cwd)) {
				this.warned.add(cwd);
				this.opts.log?.(`project MCP config in ${cwd} ignored: project is not trusted`);
			}
			return [];
		}
		const entry = this.entries.get(cwd) ?? this.connect(cwd);
		entry.lastUsed = Date.now();
		await entry.ready;
		// Names are settled per run: a project tool that collides with a built-in or a user-level
		// server's tool is offered under `<server>_<tool>` rather than dropped, exactly as the
		// interactive path does — a project exposing `read` used to silently lose it here.
		const out: ToolDefinition<any, any>[] = [];
		for (const { name, def, server } of entry.defs) {
			const unique = taken.has(name) ? `${server}_${name}` : name;
			if (taken.has(unique)) {
				this.opts.log?.(`tool ${name} from ${server} (${cwd}) is not available: both ${name} and ${unique} are taken`);
				continue;
			}
			taken.add(unique);
			out.push(unique === name ? def : { ...def, name: unique });
		}
		return out;
	}

	private connect(cwd: string): Entry {
		const entry: Entry = { sources: [], defs: [], ready: Promise.resolve(), lastUsed: Date.now() };
		this.warned.delete(cwd);
		this.evictIfFull();
		this.entries.set(cwd, entry);
		const loaded = loadProjectMcpConfig(cwd);
		for (const d of loaded.diagnostics) this.opts.log?.(d);
		if (!loaded.servers.length) return entry;
		const waits: Promise<void>[] = [];
		for (const cfg of loaded.servers) {
			let settle!: () => void;
			waits.push(new Promise<void>((r) => (settle = r)));
			const source = new McpSource(cfg, {
				onConnected: async (src) => {
					try {
						const tools = await src.listTools();
						const taken = new Set(entry.defs.map((d) => d.name));
						entry.defs.push(...mcpToolDefinitions(src, tools, taken, []).map((d) => ({ ...d, server: cfg.name })));
						this.opts.log?.(`mcp ${cfg.name} (${cwd}): ${tools.length} tool(s)`);
					} catch (err: any) {
						src.status.lastError = `tools/list failed: ${err?.message ?? err}`;
					} finally {
						settle();
					}
				},
				onNotification: (n) => {
					if (this.accepts(cwd)) this.opts.onNotification?.(cwd, cfg, n, source);
				},
				resolveToken: this.opts.resolveToken,
				log: (msg) => this.opts.log?.(`mcp ${cfg.name} (${cwd}): ${previewRedacted(msg, 200)}`),
			});
			entry.sources.push(source);
			source.start();
			// Never hold a run hostage to a server that will not come up.
			const timer = setTimeout(settle, 10_000);
			timer.unref?.();
		}
		entry.ready = Promise.all(waits).then(() => undefined);
		return entry;
	}

	/**
	 * Keep these projects' servers connected for their pushes: the projects with enabled rules. Each
	 * one is re-checked against trust here, the way a run's lookup is; one already connected is only
	 * marked as recently used, and the pool's bound still applies.
	 */
	watch(cwds: readonly string[]): void {
		if (!this.opts.onNotification) return;
		// One spelling per project (a trailing slash, a symlink): otherwise each got its own servers.
		const wanted = [...new Set(cwds.filter(Boolean).map((cwd) => realpathish(cwd)))].filter((cwd) => this.opts.isTrusted(cwd)).sort();
		if (wanted.length > MAX_POOLED_PROJECTS && !this.warnedOverCap) {
			this.warnedOverCap = true;
			this.opts.log?.(`${wanted.length} projects have rules and push servers; only the first ${MAX_POOLED_PROJECTS} are kept connected`);
		}
		const keep = new Set(wanted.slice(0, MAX_POOLED_PROJECTS));
		// What `watch` opened and is no longer wanted (trust revoked, rules removed) is stopped: a
		// project's server must not keep running in the host, pushing into rule checks, once nothing asks for it.
		for (const [cwd, entry] of [...this.entries]) {
			if (!entry.watched || keep.has(cwd)) continue;
			this.entries.delete(cwd);
			void Promise.all(entry.sources.map((s) => s.stop())).catch(() => undefined);
		}
		for (const cwd of keep) {
			const entry = this.entries.get(cwd) ?? this.connect(cwd);
			entry.watched = true;
			entry.lastUsed = Date.now();
		}
	}

	/** Whether a push from `cwd`'s servers should still be acted on: trust is checked again at arrival. */
	accepts(cwd: string): boolean {
		return this.opts.isTrusted(cwd);
	}

	/** Keep the pool bounded: one loop per project on a busy machine must not pin every project. */
	private evictIfFull(): void {
		while (this.entries.size >= MAX_POOLED_PROJECTS) {
			// Lent-only connections go first: dropping a watched one only for `watch` to reconnect it a
			// minute later churned every project's servers once the pool was full.
			const oldest = [...this.entries.entries()].sort((a, b) => Number(!!a[1].watched) - Number(!!b[1].watched) || a[1].lastUsed - b[1].lastUsed)[0];
			if (!oldest) return;
			this.entries.delete(oldest[0]);
			this.opts.log?.(`disconnected ${oldest[0]}'s MCP servers (pool limit ${MAX_POOLED_PROJECTS})`);
			void Promise.all(oldest[1].sources.map((s) => s.stop())).catch(() => undefined);
		}
	}

	async stopAll(): Promise<void> {
		const sources = [...this.entries.values()].flatMap((e) => e.sources);
		this.entries.clear();
		await Promise.all(sources.map((s) => s.stop()));
	}
}
