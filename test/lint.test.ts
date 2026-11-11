import { test } from "node:test";
import assert from "node:assert/strict";
import { tmp } from "./tmp.ts";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LINT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lint.mjs");

function lint(source: string, page?: string): { code: number; out: string } {
	const dir = tmp("pi-loops-lint-");
	fs.mkdirSync(path.join(dir, "src", "web"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src", "probe.ts"), source);
	if (page !== undefined) fs.writeFileSync(path.join(dir, "src", "web", "page.js"), page);
	const r = spawnSync("node", [LINT], { cwd: dir, encoding: "utf8" });
	return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

// The rule exists because pi installs no unhandledRejection handler: a rejection nobody awaits
// ends the whole session, not just the call. Three incidents in this project came from that.
test("the linter finds a floating promise and leaves a handled one alone", { timeout: 120_000 }, () => {
	const { code, out } = lint(`async function work(): Promise<void> {}
export function bad(): void {
	work();
}
export function badVoid(): void {
	void work();
}
export function badTimer(): void {
	setInterval(() => void work(), 1000);
}
export function okReturned(): Promise<void> {
	return work();
}
export function okCaught(): void {
	void work().catch(() => undefined);
}
export function okThenWithRejection(): void {
	void work().then(
		() => undefined,
		() => undefined,
	);
}
export async function okAwaited(): Promise<void> {
	await work();
}
export function okTimer(): void {
	setInterval(() => void work().catch(() => undefined), 1000);
}
`);
	assert.equal(code, 1, out);
	const flagged = [...out.matchAll(/probe\.ts:(\d+):\d+\s+floating-promise/g)].map((m) => Number(m[1]));
	assert.deepEqual(flagged, [3, 6, 9], `exactly the three unhandled ones, got:\n${out}`);
});

test("an empty catch needs a reason, and a commented one is left alone", { timeout: 120_000 }, () => {
	const { code, out } = lint(`export function bad(): void {
	try {
		JSON.parse("x");
	} catch {}
}
export function ok(): void {
	try {
		JSON.parse("x");
	} catch {
		/* a bad line is skipped on purpose */
	}
}
`);
	assert.equal(code, 1, out);
	assert.equal([...out.matchAll(/silent-catch/g)].length, 1, out);
	assert.match(out, /probe\.ts:4:\d+\s+silent-catch/);
});

test("a clean file passes", { timeout: 120_000 }, () => {
	const { code, out } = lint(`export async function fine(): Promise<number> {
	await Promise.resolve();
	return 1;
}
`);
	assert.equal(code, 0, out);
	assert.match(out, /no problems/);
});

// The page is browser JavaScript that nothing type-checks: `num is not defined` shipped in four
// releases. A rejection there does not end pi, so floating-promise is not asked of it.
test("in the page script, a name never declared and an empty catch are found; a floating promise is not", { timeout: 120_000 }, () => {
	const { code, out } = lint("export const fine = 1;\n", `const num = (v) => Number(v) || 0;
num("1");
numm("1");
fetch("/state");
try { JSON.parse("x"); } catch {}
try { JSON.parse("x"); } catch { /* a bad line is skipped on purpose */ }
`);
	assert.equal(code, 1, out);
	assert.deepEqual([...out.matchAll(/page\.js:(\d+):\d+\s+(\S+)/g)].map((m) => `${m[1]} ${m[2]}`), ["3 undefined-name", "5 silent-catch"], out);
});
