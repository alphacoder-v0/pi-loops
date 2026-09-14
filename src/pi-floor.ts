/**
 * The oldest pi this extension loads into. `src/extension-entry.ts` reads it before anything else
 * is imported, both READMEs state it, and `test/pi-floor.test.ts` keeps the three the same.
 *
 * 0.84.3 is where the API this code is written against became complete: `session_compact_failed`
 * arrived there, `ModelRuntime` and `readStoredCredential` in 0.80.8, `ctx.thinkingLevel` in
 * between. It was found by type-checking `src/` against older releases rather than by reading
 * changelogs — 0.80.8 fails on the two newest names, 0.84.3 passes clean — and it is the version
 * to re-check the same way when a newer name is used. Nothing enforces it at install time: pi
 * installs packages with `--legacy-peer-deps`, so `peerDependencies` stays `*` as pi's docs ask
 * and the range there would not be read anyway.
 */
export const PI_MIN_VERSION = "0.84.3";

/** `[major, minor, patch]`, or undefined for anything that does not start `N.N.N` (a `v` in front is fine). */
function parse(version: string): [number, number, number] | undefined {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * Why this pi cannot load pi-loops, as the one sentence pi prints after "Failed to load extension",
 * or undefined when it can. A pi that reports no version is refused as well: every pi new enough
 * to load this exports `VERSION`, so a missing one is an old one, not an unknown one.
 */
export function piTooOld(version: string | undefined, min: string = PI_MIN_VERSION): string | undefined {
	const have = version === undefined ? undefined : parse(version);
	const need = parse(min);
	if (!need) throw new Error(`PI_MIN_VERSION is not a version: ${JSON.stringify(min)}`);
	const upgrade = "upgrade pi (`pi update`, or `npm i -g @earendil-works/pi-coding-agent`)";
	if (!have) return `pi-loops needs pi ${min} or newer and this pi reports ${version === undefined ? "no version" : `version ${JSON.stringify(version)}`}: ${upgrade}`;
	for (let i = 0; i < 3; i++) {
		if (have[i] > need[i]) return undefined;
		if (have[i] < need[i]) return `pi-loops needs pi ${min} or newer and this is pi ${version}: ${upgrade}`;
	}
	return undefined;
}
