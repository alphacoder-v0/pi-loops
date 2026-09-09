/**
 * Project-level MCP servers for runs outside this process's own project.
 *
 * A pi process loads `<its cwd>/.pi/mcp.toml` once and shares those clients. But a loop belongs to
 * a project, not to whichever pi owns the clock: a job in project B run by a pi open in project A
 * used to get A's servers and never B's, and the headless host (no project at all) got none. pie
 * never has this problem — one process, one cwd, one project. The pool connects a project's own
 * servers lazily, keyed by directory, and hands their tools to runs in that directory.
 *
 * User-level servers are not pooled: those are shared and already connected by the process.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpSource, loadProjectMcpConfig, mcpToolDefinitions } from "./mcp.ts";
import { previewRedacted } from "./redact.ts";

export interface McpPoolOptions {
	/** Whether project-local config in `cwd` may be loaded at all (pi's saved trust decisions). */
	isTrusted: (cwd: string) => boolean;
	/** Tool names already in use for a run (built-ins, user-level MCP tools, automation tools). */
	log?: (message: string) => void;
	resolveToken?: (ref: string) => string | undefined;
}

interface Entry {
	sources: McpSource[];
	defs: Array<{ name: string; def: ToolDefinition<any, any>; server: string }>;
	ready: Promise<void>;
	lastUsed: number;
}

/** Projects kept connected at once; the least recently used is dropped past this. */
const MAX_POOLED_PROJECTS = 8;

export class McpPool {
	private readonly entries = new Map<string, Entry>();
	/** Projects we already said were untrusted: say it once, not once per run. */
	private readonly warned = new Set<string>();
	private readonly opts: McpPoolOptions;
	constructor(opts: McpPoolOptions) {
		this.opts = opts;
	}

	/** The project-level MCP tools for a run in `cwd`, connecting that project's servers on first use. */
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
				// A project server's pushes belong to the process that owns that project's rules;
				// the pool exists to lend tools to a run, not to open a second notification path.
				onNotification: () => undefined,
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

	/** Keep the pool bounded: one loop per project on a busy machine must not pin every project. */
	private evictIfFull(): void {
		while (this.entries.size >= MAX_POOLED_PROJECTS) {
			const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
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
