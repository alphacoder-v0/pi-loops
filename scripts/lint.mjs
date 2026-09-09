/**
 * Lint `src/` for the mistakes that are fatal *here* rather than merely untidy.
 *
 * The one that matters is a floating promise. pi installs no `unhandledRejection` handler, so a
 * rejection nobody is waiting for does not print a warning — it takes the whole editor down, and
 * with it every loop, trigger and MCP connection the session was running. That class has cost this
 * project three separate incidents (`void this.tick()`, `void triggers.handle()`, the goal
 * continuation), each found by a human reading code. A compiler knows the type of every
 * expression; it can find them all in a second.
 *
 * No dependency: TypeScript is borrowed the way `typecheck.mjs` borrows `tsc` — through npx, from
 * the cache, with the type definitions of the globally installed pi. Run it with `npm run lint`.
 */
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Inside npx, the package is unpacked next to the `.bin` directory it put on PATH. */
function typescriptFromPath() {
	const bin = (process.env.PATH ?? "").split(path.delimiter).find((p) => p.endsWith(path.join("node_modules", ".bin")));
	if (!bin) return undefined;
	const lib = path.join(bin, "..", "typescript", "lib", "typescript.js");
	return fs.existsSync(lib) ? lib : undefined;
}

const libPath = typescriptFromPath();
if (!libPath) {
	// First pass: re-run under npx so the compiler is on hand, exactly as typecheck.mjs does.
	const self = fileURLToPath(import.meta.url);
	const r = spawnSync("npx", ["-y", "-p", "typescript@5", "node", self, ...process.argv.slice(2)], { stdio: "inherit" });
	process.exit(r.status ?? 1);
}

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ts = require(libPath);

/* ---------------------------------------------------------------- the program */

const root = execSync("npm root -g", { encoding: "utf8" }).trim();
const pkg = path.join(root, "@earendil-works", "pi-coding-agent");
if (!fs.existsSync(pkg)) {
	console.error(`pi is not installed globally (looked in ${pkg}); npm i -g @earendil-works/pi-coding-agent`);
	process.exit(1);
}
const nm = path.join(pkg, "node_modules");
const files = fs
	.readdirSync(path.join(process.cwd(), "src"))
	.filter((f) => f.endsWith(".ts"))
	.map((f) => path.join(process.cwd(), "src", f));

const program = ts.createProgram(files, {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	strict: true,
	noEmit: true,
	skipLibCheck: true,
	allowImportingTsExtensions: true,
	types: ["node"],
	typeRoots: [path.join(nm, "@types")],
	baseUrl: ".",
	paths: {
		"@earendil-works/pi-coding-agent": [path.join(pkg, "dist/index.d.ts")],
		"@earendil-works/pi-tui": [path.join(nm, "@earendil-works/pi-tui/dist/index.d.ts")],
		"@earendil-works/pi-ai": [path.join(nm, "@earendil-works/pi-ai/dist/index.d.ts")],
		"@earendil-works/pi-agent-core": [path.join(nm, "@earendil-works/pi-agent-core/dist/index.d.ts")],
		typebox: [path.join(nm, "typebox/build/index.d.mts")],
	},
});
const checker = program.getTypeChecker();

/* ---------------------------------------------------------------- rules */

const problems = [];

function report(node, rule, message) {
	const file = node.getSourceFile();
	const { line, character } = file.getLineAndCharacterOfPosition(node.getStart());
	problems.push({ file: path.relative(process.cwd(), file.fileName), line: line + 1, column: character + 1, rule, message });
}

function isThenable(type) {
	if (!type) return false;
	if (type.isUnionOrIntersection()) return type.types.some(isThenable);
	const then = type.getProperty("then");
	if (!then) return false;
	const thenType = checker.getTypeOfSymbolAtLocation(then, then.valueDeclaration ?? then.declarations?.[0]);
	return !!thenType?.getCallSignatures().length;
}

/**
 * A promise is "handled" when its value is used: awaited, returned, stored, passed on, or
 * deliberately discarded with `void`. What is left — an expression statement whose value is a
 * promise — is the one nobody is waiting for.
 */
function checkFloatingPromise(node) {
	// A statement, or an arrow whose body *is* the call (`() => void this.tick()`): the value is
	// discarded either way, and the second form is how a timer callback usually looks.
	const isConciseArrow = ts.isArrowFunction(node) && !ts.isBlock(node.body);
	if (!ts.isExpressionStatement(node) && !isConciseArrow) return;
	let expr = isConciseArrow ? node.body : node.expression;
	// An arrow that returns its promise to a caller who awaits it is fine; only a discarded one
	// (declared `void`, or passed where the return value is ignored) is floating.
	if (isConciseArrow && !ts.isVoidExpression(expr)) return;
	// `void promise` is the explicit "I know, and I handled the failure elsewhere" marker. It is
	// only honest when a rejection really is handled, so it must carry a `.catch`.
	const isVoided = ts.isVoidExpression(expr);
	if (isVoided) expr = expr.expression;
	if (!ts.isCallExpression(expr) && !ts.isAwaitExpression(expr) && !ts.isPropertyAccessExpression(expr)) return;
	if (ts.isAwaitExpression(expr)) return;
	if (!isThenable(checker.getTypeAtLocation(expr))) return;
	// `.catch(...)` / `.then(..., onRejected)` at the end means the rejection has an owner.
	const tail = ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name.text : undefined;
	if (tail === "catch") return;
	if (tail === "then" && expr.arguments.length >= 2) return;
	report(
		node,
		"floating-promise",
		isVoided
			? "`void` on a promise with no .catch(): pi installs no unhandledRejection handler, so a rejection here kills the session"
			: "promise is never awaited and has no .catch(): pi installs no unhandledRejection handler, so a rejection here kills the session",
	);
}

/** `catch {}` with nothing in it, and no comment saying why, is a swallowed error. */
function checkSilentCatch(node) {
	if (!ts.isCatchClause(node)) return;
	if (node.block.statements.length) return;
	const text = node.block.getFullText();
	if (/\/\/|\/\*/.test(text)) return; // a comment is the author saying they meant it
	report(node, "silent-catch", "empty catch with no comment: say why the error is safe to drop");
}

for (const file of program.getSourceFiles()) {
	if (!files.includes(file.fileName)) continue;
	const visit = (node) => {
		checkFloatingPromise(node);
		checkSilentCatch(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
}

/* ---------------------------------------------------------------- output */

if (!problems.length) {
	console.log(`lint: ${files.length} file(s), no problems`);
	process.exit(0);
}
for (const p of problems) console.error(`${p.file}:${p.line}:${p.column}  ${p.rule}  ${p.message}`);
console.error(`\nlint: ${problems.length} problem(s) in ${new Set(problems.map((p) => p.file)).size} file(s)`);
process.exit(1);
