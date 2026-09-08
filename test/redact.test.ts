import { test } from "node:test";
import assert from "node:assert/strict";
import { previewRedacted, redact } from "../src/redact.ts";

test("redacts known secret shapes, leaves normal text alone", () => {
	const s = "key=sk-abcdefghij1234567890abcd aws=AKIAEXAMPLEEXAMPLE1A gh=ghp_abcdefghijklmnopqrstuvwxyz0123456789 slack=xoxb-1234567890-abcdef Authorization: Bearer eyJabc.defghijklmnopqr url=https://user:pass1234@host/x GITHUB_TOKEN=abcdefgh12345678";
	const r = redact(s);
	for (const leak of ["sk-abcdefghij", "AKIAEXAMPLE", "ghp_", "xoxb-", "eyJabc.defghijklmnopqr", "user:pass1234@", "abcdefgh12345678"]) {
		assert.ok(!r.includes(leak), `${leak} leaked: ${r}`);
	}
	assert.ok(r.includes("[REDACTED:openai_anthropic_key]"));
	assert.ok(r.includes("https://[REDACTED:url_credentials]@host/x"));
	assert.ok(r.includes("GITHUB_TOKEN=[REDACTED:env_assignment]"));
	assert.equal(redact("check the repo issues since last run"), "check the repo issues since last run");
	assert.equal(previewRedacted("  a  \n b ".repeat(50), 10), "a b a b a …");
});
