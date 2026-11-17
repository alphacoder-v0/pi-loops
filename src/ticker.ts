export const DEFAULT_TICK_MS = 30_000;

export const HOST_RIDERS = ["still-named", "auto-leave", "conversation-sweep", "page-sweep", "page-bind", "heartbeat", "channel-heal"] as const;
export const RUNTIME_RIDERS = ["stray-leases", "closed-conversations", "rule-checks"] as const;
export const BACKGROUND_RIDERS_AT_M4B_2 = [...HOST_RIDERS, ...RUNTIME_RIDERS, "scheduler"] as const;
export const WINDOW_RIDERS_AT_M4B_2 = ["lease", "finished-runs", "snapshot", "background", "scheduler"] as const;

export interface TickFacts {
	readonly startedAt: number;
	readonly tickMs: number;
}
export type Rider = (now: number, facts: TickFacts) => void | Promise<void>;
export type Riders<Name extends string> = { readonly [K in Name]: Rider };
export interface TickerOptions<Name extends string> {
	readonly names: readonly Name[];
	readonly riders: Riders<Name>;
	readonly tickMs?: number;
	readonly now?: () => number;
	readonly log: (message: string) => void;
}

export class Ticker<Name extends string> {
	readonly tickMs: number;
	private readonly names: readonly Name[];
	private readonly riders: Riders<Name>;
	private readonly now: () => number;
	private readonly log: (message: string) => void;
	private timer?: NodeJS.Timeout;
	private startedAt = 0;
	private ticking = false;
	private stopped = false;
	private inFlight?: Promise<void>;

	constructor(opts: TickerOptions<Name>) {
		this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
		this.names = opts.names;
		this.riders = opts.riders;
		this.now = opts.now ?? Date.now;
		this.log = opts.log;
	}

	start(): void {
		if (this.timer) return;
		this.stopped = false;
		this.startedAt = this.now();
		this.timer = setInterval(() => { void this.tick().catch((error) => this.report(`tick failed: ${error instanceof Error ? error.message : String(error)}`)); }, this.tickMs);
		this.timer.unref();
		void this.tick().catch((error) => this.report(`tick failed: ${error instanceof Error ? error.message : String(error)}`));
	}

	private report(message: string): void {
		try { this.log(message); }
		catch { /* a broken logger must not reject the tick */ }
	}

	tick(): Promise<void> {
		if (this.ticking || this.stopped) return this.inFlight ?? Promise.resolve();
		this.ticking = true;
		const facts = { startedAt: this.startedAt || this.now(), tickMs: this.tickMs };
		const run = async () => {
			try {
				const now = this.now();
				for (const name of this.names) {
					if (this.stopped) break;
					try { await this.riders[name](now, facts); }
					catch (error) { this.report(`tick: ${name} failed: ${error instanceof Error ? error.message : String(error)}`); }
				}
			} catch (error) {
				this.report(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				this.ticking = false;
				this.inFlight = undefined;
			}
		};
		this.inFlight = run();
		return this.inFlight;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.inFlight;
	}
}

// @ts-expect-error heartbeat must have a rider
const MISSING_RIDER_FAILS: Riders<(typeof HOST_RIDERS)[number]> = { "still-named": () => {}, "auto-leave": () => {}, "conversation-sweep": () => {}, "page-sweep": () => {}, "page-bind": () => {}, "channel-heal": () => {} };
void MISSING_RIDER_FAILS;
