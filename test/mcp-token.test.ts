import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { McpSource, MCP_TOKEN_ENV_PREFIX, type McpServerConfig, loadMcpConfigFiles, loadProjectMcpConfig, mcpTokenResolver } from "../src/mcp.ts";
import { tmp } from "./tmp.ts";

const cfg = (ref: string) => ({ name: "s", transport: "streamable_http" as const, endpoint: "https://example.com/mcp", auth: { kind: "bearer" as const, tokenKeychainRef: ref } });

test("an MCP config file cannot name an arbitrary environment variable as its credential", () => {
	process.env.ANTHROPIC_API_KEY_TEST_ONLY = "sk-should-never-be-sent";
	process.env[`${MCP_TOKEN_ENV_PREFIX}DEMO`] = "mcp-token";
	try {
		const bad = new McpSource(cfg("ANTHROPIC_API_KEY_TEST_ONLY") as any, {});
		assert.throws(() => (bad as any).bearerToken(), /credential was not found/, "an unrelated secret is not readable");
		const good = new McpSource(cfg(`${MCP_TOKEN_ENV_PREFIX}DEMO`) as any, {});
		assert.equal((good as any).bearerToken(), "mcp-token", "the prefixed variable is");
		// The person's own mcp.toml may name an entry of pi's credential store.
		const stored = new McpSource({ ...cfg("ANTHROPIC_API_KEY_TEST_ONLY"), source: "user" } as any, { resolveToken: (r) => (r === "ANTHROPIC_API_KEY_TEST_ONLY" ? "from-store" : undefined) });
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

test("a project's mcp.toml cannot name an entry of pi's credential store: a model's key stays out of its bearer header", () => {
	// pi's real store, keyed by provider id as pi writes it, and real files read by the real loaders.
	const dir = tmp("pi-loops-mcp-token-");
	const auth = path.join(dir, "auth.json");
	fs.writeFileSync(auth, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-FAKE-NOT-A-KEY" }, hub: { type: "api_key", key: "hub-token" } }));
	const resolveToken = mcpTokenResolver((ref) => readStoredCredential(ref, auth));
	assert.equal(resolveToken("anthropic"), "sk-ant-FAKE-NOT-A-KEY", "the control: the store answers this ref");
	const server = (name: string, ref: string) => `[[server]]\nname = "${name}"\nkind = "streamable_http"\nendpoint = "https://example.com/mcp"\nauth = { kind = "bearer", token_keychain_ref = "${ref}" }\n`;
	const loops = path.join(dir, "loops");
	const project = path.join(dir, "project");
	fs.mkdirSync(loops);
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(loops, "mcp.toml"), server("mine", "hub") + server("both", "hub"));
	fs.writeFileSync(path.join(project, ".pi", "mcp.toml"), server("model", "anthropic") + server("stored", "hub") + server("var", `${MCP_TOKEN_ENV_PREFIX}PROJ`) + server("both", "anthropic"));
	process.env[`${MCP_TOKEN_ENV_PREFIX}PROJ`] = "project-token";
	try {
		const token = (servers: McpServerConfig[], name: string) => (new McpSource(servers.find((s) => s.name === name)!, { resolveToken }) as any).bearerToken();
		// Both ways a project's file is read: a window in the project, and a run lent the project's servers.
		for (const servers of [loadMcpConfigFiles({ dir: loops, cwd: project, projectTrusted: true }).servers, loadProjectMcpConfig(project).servers]) {
			assert.throws(() => token(servers, "model"), /credential was not found/, "a project file does not reach a model's key");
			assert.throws(() => token(servers, "stored"), /credential was not found/, "nor any other entry of the store");
			assert.throws(() => token(servers, "both"), /credential was not found/, "a project entry that replaces the person's own is still the project's");
			assert.equal(token(servers, "var"), "project-token", "a project file names a PI_MCP_TOKEN_ variable");
		}
		assert.equal(token(loadMcpConfigFiles({ dir: loops, cwd: project, projectTrusted: true }).servers, "mine"), "hub-token", "the person's own file reaches the store");
		// A source this code does not know is not the person's own file.
		assert.throws(() => (new McpSource({ ...cfg("hub"), source: "other" } as any, { resolveToken }) as any).bearerToken(), /credential was not found/);
	} finally {
		delete process.env[`${MCP_TOKEN_ENV_PREFIX}PROJ`];
	}
});
