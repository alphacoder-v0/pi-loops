#!/usr/bin/env node
// `pi-loops` — the session launcher and its subcommands (see src/cli.ts and docs/cli.md). Resolves
// pi's packages the way the headless host does (src/pi-resolver.mjs) and loads the TypeScript the
// way both entry points have to (src/ts-entry.mjs), so it runs outside pi with no build step and no
// dependencies — from a checkout, a `git:` package, or an npm package under node_modules.
import { register } from "node:module";
import { importTs } from "./ts-entry.mjs";

register("./pi-resolver.mjs", import.meta.url);
// `pi-loops status | head` closes the pipe early: the reader has what it wanted, which is not an error.
process.stdout.on("error", (err) => {
	if (err?.code === "EPIPE") process.exit(process.exitCode ?? 0);
	process.stderr.write(`pi-loops: ${err?.message ?? err}\n`);
	process.exit(1);
});
let cli;
try {
	cli = await importTs(import.meta.url, "./cli.ts");
} catch (err) {
	// Nothing has loaded yet, so there is no usage text to print underneath: the message is all of it.
	process.stderr.write(`pi-loops: ${err?.message ?? err}\n`);
	process.exit(1);
}
const argv = process.argv.slice(2);
try {
	process.exitCode = await cli.runCli(argv);
} catch (err) {
	// Only a command typed wrong is answered with its usage; a missing file or a lock is not fixed by reading one.
	const usage = err instanceof cli.UsageError;
	process.stderr.write(`pi-loops: ${err?.message ?? err}\n${usage ? `\n${cli.usageFor(argv[0])}\n` : ""}`);
	process.exitCode = usage ? 2 : 1;
}
