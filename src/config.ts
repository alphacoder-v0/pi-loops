/**
 * `~/.pi/agent/loops/config.toml` (pie: `~/.pie/config.toml`):
 *
 *   allow_project_hooks = false
 *   [triggers]
 *   poll_interval_secs = 600      # pie
 *   run_timeout_secs = 900        # pi-loops: cap on a check/action sub-agent (pie: unbounded)
 *   [cron]
 *   catch_up = true               # pi-loops: fire the tick a loop missed while no pi was open (false wins over --catchup)
 *   max_concurrent_runs = 3       # pi-loops: loop runs in flight at once
 *   [hooks]
 *   mode = "sync"                 # sync = awaited inline like pie; async = queued off the turn
 *   [host]
 *   auto = true                   # pi-loops: when the last pi quits, a headless host keeps loops and triggers running
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
	errors: string[];
}

export const DEFAULT_TRIGGER_RUN_TIMEOUT_SECS = 15 * 60;
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

export function loadConfig(dir: string): LoopsConfig {
	const cfg: LoopsConfig = { allowProjectHooks: false, triggerPollIntervalSecs: DEFAULT_TRIGGER_POLL_INTERVAL_SECS, triggerRunTimeoutMs: DEFAULT_TRIGGER_RUN_TIMEOUT_SECS * 1000, cronCatchUp: true, maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS, hooksMode: "sync", hostAuto: true, errors: [] };
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
