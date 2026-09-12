/** pi-loops' own version, read from package.json once. */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const PI_LOOPS_VERSION: string = (() => {
	try {
		// `fileURLToPath`, not `new URL(...).pathname`: a pathname is percent-encoded, so a checkout
		// under a directory with a space or a `#` in its name reads no package.json at all — and the
		// fallback below is silent, which put "0.0.0" in every manifest, log line and `/pi-loops`.
		return String(JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version ?? "0.0.0");
	} catch {
		return "0.0.0";
	}
})();
