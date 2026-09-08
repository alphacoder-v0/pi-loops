/**
 * `~/.pi/agent/loops/config.toml` (pie: `~/.pie/config.toml`):
 *
 *   allow_project_hooks = false
 *   [triggers]
 *   poll_interval_secs = 600
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseToml } from "./toml.ts";
import { DEFAULT_TRIGGER_POLL_INTERVAL_SECS } from "./triggers.ts";

export interface LoopsConfig {
	allowProjectHooks: boolean;
	triggerPollIntervalSecs: number;
	errors: string[];
}

export function loadConfig(dir: string): LoopsConfig {
	const cfg: LoopsConfig = { allowProjectHooks: false, triggerPollIntervalSecs: DEFAULT_TRIGGER_POLL_INTERVAL_SECS, errors: [] };
	const file = path.join(dir, "config.toml");
	try {
		const doc = parseToml(fs.readFileSync(file, "utf8"));
		if (doc.allow_project_hooks === true) cfg.allowProjectHooks = true;
		const t = doc.triggers as any;
		if (t && typeof t.poll_interval_secs === "number" && t.poll_interval_secs > 0) cfg.triggerPollIntervalSecs = Math.floor(t.poll_interval_secs);
	} catch (err: any) {
		if (err?.code !== "ENOENT") cfg.errors.push(`${file}: ${err?.message ?? err}`);
	}
	if (process.env.PI_ALLOW_PROJECT_HOOKS === "1" || process.env.PIE_ALLOW_PROJECT_HOOKS === "1") cfg.allowProjectHooks = true;
	return cfg;
}
