import { test } from "node:test";
import assert from "node:assert/strict";
import { jobNameFrom } from "../src/job-name.ts";
import { checkJobName } from "../src/tools.ts";

test("a loop made without a name is named by the first words of what it does", () => {
	assert.equal(jobNameFrom("Check for new issues and report only what changed", []), "check-new-issues");
	assert.equal(jobNameFrom("List src/*.ts; report each file as a finding", []), "list-src-ts");
	assert.equal(jobNameFrom("Tell me when the CI on main goes red", []), "tell-ci-main");
});

test("a name made from a prompt is one /cron add --name would accept", () => {
	for (const prompt of ["read TODO.md", "每天检查 issue 列表", "!!!", "a".repeat(200), "Überprüfe die Änderungen"]) {
		const name = jobNameFrom(prompt, []);
		assert.doesNotThrow(() => checkJobName(name, []), `${JSON.stringify(prompt)} -> ${name}`);
		assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `lowercase words joined by hyphens: ${name}`);
	}
});

test("a prompt with no word in Latin letters is named loop", () => {
	assert.equal(jobNameFrom("每天早上检查一下", []), "loop");
});

test("a name another loop has is not reused: a number goes on the end", () => {
	const taken = [{ name: "check-new-issues" }, { name: "check-new-issues-2" }, { name: undefined }];
	assert.equal(jobNameFrom("check new issues", taken), "check-new-issues-3");
	assert.equal(jobNameFrom("check new issues", [{ name: "other" }]), "check-new-issues");
});
