import { test } from "node:test";
import assert from "node:assert/strict";
import { McpSource, MCP_TOKEN_ENV_PREFIX } from "../src/mcp.ts";

const cfg = (ref: string) => ({ name: "s", transport: "streamable_http" as const, endpoint: "https://example.com/mcp", auth: { kind: "bearer" as const, tokenKeychainRef: ref } });

test("an MCP config file cannot name an arbitrary environment variable as its credential", () => {
	process.env.ANTHROPIC_API_KEY_TEST_ONLY = "sk-should-never-be-sent";
	process.env[`${MCP_TOKEN_ENV_PREFIX}DEMO`] = "mcp-token";
	try {
		const bad = new McpSource(cfg("ANTHROPIC_API_KEY_TEST_ONLY") as any, {});
		assert.throws(() => (bad as any).bearerToken(), /credential was not found/, "an unrelated secret is not readable");
		const good = new McpSource(cfg(`${MCP_TOKEN_ENV_PREFIX}DEMO`) as any, {});
		assert.equal((good as any).bearerToken(), "mcp-token", "the prefixed variable is");
		// pi's credential store still wins for any ref.
		const stored = new McpSource(cfg("ANTHROPIC_API_KEY_TEST_ONLY") as any, { resolveToken: (r) => (r === "ANTHROPIC_API_KEY_TEST_ONLY" ? "from-store" : undefined) });
		assert.equal((stored as any).bearerToken(), "from-store");
	} finally {
		delete process.env.ANTHROPIC_API_KEY_TEST_ONLY;
		delete process.env[`${MCP_TOKEN_ENV_PREFIX}DEMO`];
	}
});

test("the error message does not echo the credential ref", () => {
	const bad = new McpSource(cfg("MY_SECRET_REF") as any, {});
	assert.throws(() => (bad as any).bearerToken(), (err: Error) => !err.message.includes("MY_SECRET_REF"));
});

test("the env fallback is prefix-bound wherever it is read, including the hosts' own resolver", async () => {
	const { mcpTokenFromEnv } = await import("../src/mcp.ts");
	process.env.SOME_OTHER_SECRET = "nope";
	process.env[`${MCP_TOKEN_ENV_PREFIX}OK`] = "yes";
	try {
		assert.equal(mcpTokenFromEnv("SOME_OTHER_SECRET"), undefined);
		assert.equal(mcpTokenFromEnv(`${MCP_TOKEN_ENV_PREFIX}OK`), "yes");
		// Both hosts must route their env lookup through it; a direct process.env read is the bug
		// this replaces, so the sources are checked for it.
		const fs = await import("node:fs");
		for (const f of ["src/pi-loops.ts", "src/host.ts"]) {
			const src = fs.readFileSync(f, "utf8");
			assert.equal(/process\.env\[ref\]/.test(src), false, `${f} must not read process.env[ref] directly`);
		}
	} finally {
		delete process.env.SOME_OTHER_SECRET;
		delete process.env[`${MCP_TOKEN_ENV_PREFIX}OK`];
	}
});
