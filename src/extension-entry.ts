/**
 * What pi loads (`pi.extensions` in package.json): a version check, then the extension.
 *
 * The check cannot sit in `src/pi-loops.ts`. That file and the modules under it import names pi
 * did not always export (`ModelRuntime`, `readStoredCredential`, `createSyntheticSourceInfo`) and
 * subscribe to events it did not always emit. ESM links a whole import graph before running a line
 * of it, so on an older pi the failure is a link error naming one export — "does not provide an
 * export named ModelRuntime" — and nothing in it says "your pi is too old". This file imports only
 * what every pi has exported for a long time, reads the version, and imports the rest afterwards,
 * so what an old pi prints is the sentence that says which pi it needs.
 *
 * A namespace import on purpose: a name missing from an old pi is then `undefined` rather than a
 * link error, which is exactly the case the check exists for.
 */
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piTooOld } from "./pi-floor.ts";

export default async function (pi: ExtensionAPI) {
	const refusal = piTooOld(sdk.VERSION);
	if (refusal) throw new Error(refusal);
	const { default: piLoops } = await import("./pi-loops.ts");
	return piLoops(pi);
}
