#!/usr/bin/env node
// `pi-loops export|import` — see src/cli.ts. Resolves pi's packages the way the headless host does
// (src/pi-resolver.mjs), so the CLI runs outside pi with no build step and no dependencies.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./pi-resolver.mjs", import.meta.url);
const { runCli, CLI_USAGE } = await import("./cli.ts");
try {
	process.exitCode = await runCli(process.argv.slice(2));
} catch (err) {
	process.stderr.write(`pi-loops: ${err?.message ?? err}\n\n${CLI_USAGE}\n`);
	process.exitCode = 1;
}
