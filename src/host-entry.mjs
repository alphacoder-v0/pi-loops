#!/usr/bin/env node
// The headless host's entry point (see src/host.ts), spawned by src/host-control.ts as
// `node --import <pkg>/src/register-pi.mjs <pkg>/src/host-entry.mjs`. host.ts cannot be the entry
// itself: under an npm install it sits below node_modules, where Node refuses to strip types, so the
// same dual load the CLI uses has to happen here too (src/ts-entry.mjs).
import { importTs } from "./ts-entry.mjs";

try {
	await importTs(import.meta.url, "./host.ts");
} catch (err) {
	// stdout and stderr are the host log; a line there is what `pi-loops host start` points a person at.
	process.stderr.write(`pi-loops host: ${err?.message ?? err}\n`);
	// 78 (EX_CONFIG): this host cannot run here — the package or pi is not where it was. A login unit
	// does not restart it (RestartPreventExitStatus), where a crash (1) would be restarted.
	// launchd restarts any non-zero exit (KeepAlive SuccessfulExit=false), so under it the same news is 0.
	process.exit(process.env.PI_LOOPS_HOST_MANAGED === "launchd" ? 0 : 78);
}
