/** pi-loops' own version, read from package.json once (pie: CARGO_PKG_VERSION). */
import * as fs from "node:fs";
import * as path from "node:path";

export const PI_LOOPS_VERSION: string = (() => {
	try {
		return String(JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8")).version ?? "0.0.0");
	} catch {
		return "0.0.0";
	}
})();
