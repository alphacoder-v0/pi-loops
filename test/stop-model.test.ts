import { test } from "node:test";
import assert from "node:assert/strict";
import { stoppedTogether, type RunRecordM4b } from "../src/loop-run.ts";
import type { ClaimedRow } from "../src/requests.ts";

const claim = (id: string): ClaimedRow["run"] => ({ id, pid: 42, procStart: "boot-42", started_at: new Date(1_700_000_000_000 + Number(id.slice(1)) * 1000).toISOString() });
const record = (id: string, stop?: RunRecordM4b["stop"]): RunRecordM4b => ({
	runId: id, row: id, jobId: `cron-${id}`, stateful: true, cwd: "/tmp", pid: 42,
	startedAt: claim(id).started_at, finishedAt: new Date().toISOString(), ok: false,
	error: "interrupted", interrupted: true, findings: 0, droppedFindings: 0, stateUpdated: false, stop,
});

function permutations<T>(values: readonly T[]): T[][] {
	if (values.length <= 1) return [[...values]];
	return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

test("[alone-from-stop] every closing order carries the same process stop set, even after a write", () => {
	for (let count = 1; count <= 3; count++) {
		const ids = Array.from({ length: count }, (_, index) => `r${index + 1}`);
		for (const order of permutations(ids)) {
			let claims = ids.map((id) => ({ id, run: claim(id) })) as unknown as ClaimedRow[];
			const records: RunRecordM4b[] = [];
			for (const id of order) {
				const stop = stoppedTogether(claim(id), claims, records);
				assert.deepEqual(stop.runs, ids);
				const ended = record(id, stop);
				assert.deepEqual(stoppedTogether(claim(id), claims, [...records, ended]).runs, ids, "retrying after the record write keeps the same stop set");
				records.push(ended);
				claims = claims.filter((row) => row.id !== id);
			}
		}
	}
});
