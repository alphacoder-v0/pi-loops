/**
 * `~/.pi/agent/loops/config.toml`:
 *
 *   allow_project_hooks = false
 *   [triggers]
 *   poll_interval_secs = 600
 *   run_timeout_secs = 900        # cap on a check/action sub-agent
 *   [cron]
 *   catch_up = true               # pi-loops: fire the tick a loop missed while no pi was open (false wins over --catchup)
 *   max_concurrent_runs = 3       # pi-loops: sub-agents in flight at once — loop runs and trigger checks share it
 *   [hooks]
 *   mode = "sync"                 # sync = awaited inline; async = queued off the turn
 *   [host]
 *   auto = true                   # pi-loops: when the last pi quits, a headless host keeps loops and triggers running
 *   [limits]
 *   daily_budget_usd = 5.0        # pi-loops: stop dispatching once today's automation has cost this much (0 = no cap)
 *   [danger]
 *   allow = ["rm -rf /var/cache/x"]  # pi-loops: command prefixes an unattended run may use anyway
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseToml } from "./toml.ts";
import { DEFAULT_TRIGGER_POLL_INTERVAL_SECS } from "./triggers.ts";

export interface LoopsConfig {
	allowProjectHooks: boolean;
	triggerPollIntervalSecs: number;
	triggerRunTimeoutMs: number;
	cronCatchUp: boolean;
	maxConcurrentRuns: number;
	hooksMode: "sync" | "async";
	/** Start the headless host when the last interactive pi quits with automation configured. */
	hostAuto: boolean;
	/** Stop dispatching once automation has spent this much today (local time). 0 = no cap. */
	dailyBudgetUsd: number;
	/** Command prefixes an unattended run may use despite the dangerous-command gate. */
	allowCommands: string[];
	errors: string[];
}

export const DEFAULT_TRIGGER_RUN_TIMEOUT_SECS = 15 * 60;
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

export function loadConfig(dir: string): LoopsConfig {
	const cfg: LoopsConfig = { allowProjectHooks: false, triggerPollIntervalSecs: DEFAULT_TRIGGER_POLL_INTERVAL_SECS, triggerRunTimeoutMs: DEFAULT_TRIGGER_RUN_TIMEOUT_SECS * 1000, cronCatchUp: true, maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS, hooksMode: "sync", hostAuto: true, dailyBudgetUsd: 0, allowCommands: [], errors: [] };
	const file = path.join(dir, "config.toml");
	const positiveInt = (section: string, key: string, v: unknown, apply: (n: number) => void) => {
		if (v === undefined) return;
		if (typeof v === "number" && v >= 1) apply(Math.floor(v));
		else cfg.errors.push(`${section}: ignoring invalid ${key} in ${file}: \`[${section}] ${key}\` must be at least 1`);
	};
	try {
		const doc = parseToml(fs.readFileSync(file, "utf8"));
		if (doc.allow_project_hooks === true) cfg.allowProjectHooks = true;
		const t = doc.triggers as any;
		if (t && t.poll_interval_secs !== undefined) {
			if (typeof t.poll_interval_secs === "number" && t.poll_interval_secs >= 1) cfg.triggerPollIntervalSecs = Math.floor(t.poll_interval_secs);
			else cfg.errors.push(`triggers: ignoring invalid poll interval in ${file}: \`[triggers] poll_interval_secs\` must be at least 1`);
		}
		positiveInt("triggers", "run_timeout_secs", t?.run_timeout_secs, (n) => (cfg.triggerRunTimeoutMs = n * 1000));
		const c = doc.cron as any;
		if (c && c.catch_up !== undefined) {
			if (typeof c.catch_up === "boolean") cfg.cronCatchUp = c.catch_up;
			else cfg.errors.push(`cron: ignoring invalid catch_up in ${file}: must be true or false`);
		}
		positiveInt("cron", "max_concurrent_runs", c?.max_concurrent_runs, (n) => (cfg.maxConcurrentRuns = n));
		const dg = doc.danger as any;
		if (dg && dg.allow !== undefined) {
			if (Array.isArray(dg.allow) && dg.allow.every((x: unknown) => typeof x === "string")) cfg.allowCommands = dg.allow as string[];
			else cfg.errors.push(`danger: ignoring invalid allow in ${file}: [danger] allow must be a list of command prefixes`);
		}
		const lim = doc.limits as any;
		if (lim && lim.daily_budget_usd !== undefined) {
			const n = lim.daily_budget_usd;
			if (typeof n === "number" && Number.isFinite(n) && n >= 0) cfg.dailyBudgetUsd = n;
			else cfg.errors.push(`limits: ignoring invalid daily_budget_usd in ${file}: must be a number of dollars ≥ 0 (0 = no cap)`);
		}
		const ho = doc.host as any;
		if (ho && ho.auto !== undefined) {
			if (typeof ho.auto === "boolean") cfg.hostAuto = ho.auto;
			else cfg.errors.push(`host: ignoring invalid auto in ${file}: must be true or false`);
		}
		const h = doc.hooks as any;
		if (h && h.mode !== undefined) {
			if (h.mode === "sync" || h.mode === "async") cfg.hooksMode = h.mode;
			else cfg.errors.push(`hooks: ignoring invalid mode in ${file}: \`[hooks] mode\` must be "sync" or "async"`);
		}
	} catch (err: any) {
		if (err?.code !== "ENOENT") cfg.errors.push(`${file}: ${err?.message ?? err}`);
	}
	if (process.env.PI_ALLOW_PROJECT_HOOKS === "1" || process.env.PIE_ALLOW_PROJECT_HOOKS === "1") cfg.allowProjectHooks = true;
	return cfg;
}
