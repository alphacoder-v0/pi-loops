// The repository's own side of CONTRACT.md §2.6, one rule per subcommand, so 3-cross-check.sh
// can hold each against an implementation that shares nothing with this package (tomllib, grep,
// awk, jq). Run with `node --import src/register-pi.mjs` like the tests, so pi's packages resolve.
//
//   impl-a.mjs toml <file>     the parsed file as one JSON line
//   impl-a.mjs kind            one line of stdin → "checkpoint" | "news" per line
//   impl-a.mjs level <file>    the playbook's level, or "-" when it has none
import * as fs from "node:fs";

const [sub, file] = process.argv.slice(2);
const src = (name) => new URL(`../../src/${name}`, import.meta.url).href;

if (sub === "toml") {
	const { parseToml } = await import(src("toml.ts"));
	process.stdout.write(`${JSON.stringify(parseToml(fs.readFileSync(file, "utf8")))}\n`);
} else if (sub === "kind") {
	const { findingKind } = await import(src("protocol.ts"));
	for (const line of fs.readFileSync(0, "utf8").split("\n")) if (line) console.log(findingKind(line));
} else if (sub === "level") {
	const { readLevelLine } = await import(src("recipe.ts"));
	console.log(readLevelLine(fs.readFileSync(file, "utf8")) ?? "-");
} else {
	console.error("impl-a.mjs toml <file> | kind (stdin) | level <file>");
	process.exit(2);
}
