/**
 * Session archives — pie's `session_archive.rs` (`.piesession`), plus the loop-state files
 * pie's issue 23 left for later. One uncompressed ustar tar, owner-only, never overwritten:
 *
 *   manifest.json
 *   session.jsonl                 pi's session file, verbatim
 *   sidecars/cron.json            this project's cron jobs   (optional)
 *   sidecars/triggers.json        this project's trigger rules (optional; --exclude-triggers)
 *   loops/<job-id>.md             loop state per stateful job (optional)
 *
 * Import rewrites only what must be local: a fresh session id and the target cwd in the
 * session header, and sidecar bookkeeping (automation disabled unless activated, running
 * markers / errors / overlap counters cleared, ids regenerated on collision).
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LOOP_STATE_MAX_CHARS, capChars } from "./protocol.ts";
import { newId, type LoopJob } from "./store.ts";
import { type DynamicTriggerRule, newRuleId } from "./triggers.ts";

export const ARCHIVE_SCHEMA = "pi-loops.session_export.v1";
export const ARCHIVE_EXT = ".pisession";
const MANIFEST_PATH = "manifest.json";
const SESSION_PATH = "session.jsonl";
const CRON_PATH = "sidecars/cron.json";
const TRIGGERS_PATH = "sidecars/triggers.json";
const LOOPS_DIR = "loops/";
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ tar */

function padOctal(n: number, len: number): string {
	return n.toString(8).padStart(len - 1, "0") + "\0";
}

function header(name: string, size: number, mode: number, mtime: number): Buffer {
	const buf = Buffer.alloc(512);
	buf.write(name, 0, 100, "utf8");
	buf.write(padOctal(mode, 8), 100);
	buf.write(padOctal(0, 8), 108);
	buf.write(padOctal(0, 8), 116);
	buf.write(padOctal(size, 12), 124);
	buf.write(padOctal(mtime, 12), 136);
	buf.write("        ", 148); // checksum placeholder
	buf.write("0", 156);
	buf.write("ustar\0", 257);
	buf.write("00", 263);
	let sum = 0;
	for (const b of buf) sum += b;
	buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return buf;
}

export function writeTar(entries: Array<{ name: string; data: Buffer; mode?: number }>, mtime = Math.floor(Date.now() / 1000)): Buffer {
	const parts: Buffer[] = [];
	for (const e of entries) {
		if (Buffer.byteLength(e.name) > 100) throw new Error(`tar entry name too long: ${e.name}`);
		parts.push(header(e.name, e.data.length, e.mode ?? 0o600, mtime), e.data);
		const pad = (512 - (e.data.length % 512)) % 512;
		if (pad) parts.push(Buffer.alloc(pad));
	}
	parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

export function readTar(buf: Buffer): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	let off = 0;
	while (off + 512 <= buf.length) {
		const block = buf.subarray(off, off + 512);
		if (block.every((b) => b === 0)) break;
		const name = block.toString("utf8", 0, 100).replace(/\0.*$/, "");
		const size = parseInt(block.toString("utf8", 124, 136).replace(/\0.*$/, "").trim() || "0", 8);
		const type = block.toString("utf8", 156, 157);
		off += 512;
		if (Number.isNaN(size) || off + size > buf.length) throw new Error("corrupt tar archive");
		if (type === "0" || type === "\0" || type === "") out.set(name, Buffer.from(buf.subarray(off, off + size)));
		off += size + ((512 - (size % 512)) % 512);
	}
	return out;
}

function validateArchivePath(name: string): void {
	if (path.isAbsolute(name) || name.split("/").some((seg) => seg === ".." || seg === "") || name.includes("\\")) {
		throw new Error(`archive contains an unsafe path: ${name}`);
	}
}

/* ------------------------------------------------------------- manifest */

export interface Manifest {
	schema: string;
	created_at: string;
	pi_version: string;
	pi_loops_version: string;
	source: { session_id: string; cwd: string; session_path: string };
	content: { session_jsonl_sha256: string; entry_count: number; has_triggers: boolean; has_cron: boolean; loop_state_count: number };
	sensitivity: { session_transcript_preserved: true; separate_auth_stores_included: false; provider_credentials_included: false; mcp_config_included: false; inbox_included: false };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface SessionHeader {
	type: "session";
	id: string;
	cwd?: string;
	[k: string]: unknown;
}

function parseSessionJsonl(text: string): { header: SessionHeader; headerLine: string; rest: string[]; entryCount: number } {
	const lines = text.split("\n");
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	if (!lines.length) throw new Error("session.jsonl is empty");
	let header: SessionHeader;
	try {
		header = JSON.parse(lines[0]);
	} catch {
		throw new Error("session.jsonl header is not JSON");
	}
	if (header?.type !== "session" || typeof header.id !== "string") throw new Error("session.jsonl does not start with a pi session header");
	let entryCount = 0;
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		try {
			JSON.parse(line);
			entryCount++;
		} catch {
			throw new Error("session.jsonl contains a line that is not JSON");
		}
	}
	return { header, headerLine: lines[0], rest: lines.slice(1), entryCount };
}

/* --------------------------------------------------------------- export */

export interface ExportInput {
	sessionFile: string;
	cwd: string;
	jobs: LoopJob[];
	rules: DynamicTriggerRule[];
	/** loop state per job id */
	states: Record<string, string>;
	excludeTriggers?: boolean;
	outputPath: string;
	piVersion: string;
	piLoopsVersion: string;
}

export interface ExportSummary {
	outputPath: string;
	sessionId: string;
	entryCount: number;
	hasTriggers: boolean;
	hasCron: boolean;
	loopStateCount: number;
}

export function defaultExportPath(cwd: string, sessionId: string): string {
	return path.join(cwd, `pi-session-${sessionId.slice(0, 16)}${ARCHIVE_EXT}`);
}

export function exportSession(input: ExportInput): ExportSummary {
	const sessionBytes = fs.readFileSync(input.sessionFile);
	if (sessionBytes.length > MAX_SESSION_BYTES) throw new Error("session file exceeds the 50 MiB archive cap");
	const parsed = parseSessionJsonl(sessionBytes.toString("utf8"));
	// pie's --exclude-triggers drops every automation sidecar (trigger rules and cron jobs); loop
	// state follows the jobs.
	const rules = input.excludeTriggers ? [] : input.rules;
	const jobs = input.excludeTriggers ? [] : input.jobs;
	const states = Object.entries(input.states).filter(([id, text]) => jobs.some((j) => j.id === id && j.stateful) && text.trim());
	const manifest: Manifest = {
		schema: ARCHIVE_SCHEMA,
		created_at: new Date().toISOString(),
		pi_version: input.piVersion,
		pi_loops_version: input.piLoopsVersion,
		source: { session_id: parsed.header.id, cwd: input.cwd, session_path: input.sessionFile },
		content: { session_jsonl_sha256: sha256(sessionBytes), entry_count: parsed.entryCount, has_triggers: rules.length > 0, has_cron: jobs.length > 0, loop_state_count: states.length },
		sensitivity: { session_transcript_preserved: true, separate_auth_stores_included: false, provider_credentials_included: false, mcp_config_included: false, inbox_included: false },
	};
	const entries: Array<{ name: string; data: Buffer }> = [
		{ name: MANIFEST_PATH, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
		{ name: SESSION_PATH, data: sessionBytes },
	];
	if (jobs.length) entries.push({ name: CRON_PATH, data: Buffer.from(`${JSON.stringify({ version: 1, jobs }, null, 2)}\n`) });
	if (rules.length) entries.push({ name: TRIGGERS_PATH, data: Buffer.from(`${JSON.stringify({ version: 1, rules }, null, 2)}\n`) });
	for (const [id, text] of states) entries.push({ name: `${LOOPS_DIR}${id}.md`, data: Buffer.from(`${capChars(text, LOOP_STATE_MAX_CHARS)}\n`) });
	for (const e of entries) if (e.name !== SESSION_PATH && e.data.length > MAX_SIDECAR_BYTES) throw new Error(`${e.name} exceeds the 2 MiB sidecar cap`);
	// pie: owner-only, never truncate an existing file.
	const fd = fs.openSync(input.outputPath, "wx", 0o600);
	try {
		fs.writeFileSync(fd, writeTar(entries));
	} finally {
		fs.closeSync(fd);
	}
	return { outputPath: input.outputPath, sessionId: parsed.header.id, entryCount: parsed.entryCount, hasTriggers: rules.length > 0, hasCron: jobs.length > 0, loopStateCount: states.length };
}

/* --------------------------------------------------------------- import */

export interface ImportInput {
	archivePath: string;
	/** Directory pi keeps this project's sessions in (`ctx.sessionManager.getSessionDir()`). */
	sessionDir: string;
	targetCwd: string;
	/** pie's --activate-triggers: automation stays disabled unless true. */
	activate: boolean;
	existingJobIds: Set<string>;
	existingRuleIds: Set<string>;
	now?: () => Date;
}

export interface ImportSummary {
	sessionId: string;
	sessionPath: string;
	originalSessionId: string;
	entryCount: number;
	jobs: LoopJob[];
	rules: DynamicTriggerRule[];
	/** loop state per (possibly regenerated) job id */
	states: Record<string, string>;
	originallyEnabledJobs: string[];
	originallyEnabledRules: string[];
	automationEnabled: boolean;
	manifest: Manifest;
}

/** Ids become file and directory names (`state/<id>.md`, `sessions/<id>/`): plain tokens only. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function importSession(input: ImportInput): ImportSummary {
	const files = readTar(fs.readFileSync(input.archivePath));
	for (const name of files.keys()) validateArchivePath(name);
	const manifestBytes = files.get(MANIFEST_PATH);
	if (!manifestBytes) throw new Error("archive has no manifest.json");
	if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("manifest.json exceeds cap");
	const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
	if (manifest?.schema !== ARCHIVE_SCHEMA) throw new Error(`unsupported archive schema ${JSON.stringify(manifest?.schema)} (expected ${ARCHIVE_SCHEMA})`);
	const sessionBytes = files.get(SESSION_PATH);
	if (!sessionBytes) throw new Error("archive has no session.jsonl");
	if (sessionBytes.length > MAX_SESSION_BYTES) throw new Error("session.jsonl exceeds the 50 MiB cap");
	if (sha256(sessionBytes) !== manifest.content?.session_jsonl_sha256) throw new Error("session.jsonl does not match the manifest checksum");
	const parsed = parseSessionJsonl(sessionBytes.toString("utf8"));

	// Fresh id + local cwd; provenance kept in the header like pie's `imported_from`.
	const now = (input.now ?? (() => new Date()))();
	const sessionId = randomUUID();
	const timestamp = now.toISOString();
	const { parentSession: _parent, parentSessionPath: _parentPath, ...headerRest } = parsed.header as Record<string, unknown>;
	const header = { ...headerRest, id: sessionId, cwd: input.targetCwd, timestamp, importedFrom: { session_id: parsed.header.id, cwd: manifest.source?.cwd, exported_at: manifest.created_at, pi_version: manifest.pi_version, pi_loops_version: manifest.pi_loops_version } };
	const sessionPath = path.join(input.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);

	// pie stages and validates every sidecar before anything is committed: a rejected archive
	// must not leave an orphan session file behind.
	const idMap = new Map<string, string>();
	const jobs: LoopJob[] = [];
	const originallyEnabledJobs: string[] = [];
	const cronBytes = files.get(CRON_PATH);
	if (cronBytes) {
		if (cronBytes.length > MAX_SIDECAR_BYTES) throw new Error("cron sidecar exceeds cap");
		const file = JSON.parse(cronBytes.toString("utf8"));
		if (!Array.isArray(file?.jobs)) throw new Error("cron sidecar has no jobs array");
		for (const raw of file.jobs as LoopJob[]) {
			if (!raw || typeof raw.id !== "string" || typeof raw.prompt !== "string" || !raw.schedule) throw new Error("cron sidecar contains an invalid job");
			if (!SAFE_ID.test(raw.id)) throw new Error("cron sidecar contains an invalid job id");
			const id = input.existingJobIds.has(raw.id) ? newId("cron") : raw.id;
			idMap.set(raw.id, id);
			if (raw.enabled) originallyEnabledJobs.push(id);
			// pie's rewrite_cron_sidecar: automation off unless activated, stale run bookkeeping cleared.
			jobs.push({ ...raw, id, cwd: input.targetCwd, enabled: raw.enabled && input.activate, running: undefined, lastDueAt: undefined, lastError: undefined, skippedOverlap: 0, sessionId: raw.stateful ? undefined : sessionId, createdBy: { sessionId, cwd: input.targetCwd } });
		}
	}
	const rules: DynamicTriggerRule[] = [];
	const originallyEnabledRules: string[] = [];
	const trigBytes = files.get(TRIGGERS_PATH);
	if (trigBytes) {
		if (trigBytes.length > MAX_SIDECAR_BYTES) throw new Error("trigger sidecar exceeds cap");
		const file = JSON.parse(trigBytes.toString("utf8"));
		if (!Array.isArray(file?.rules)) throw new Error("trigger sidecar has no rules array");
		for (const raw of file.rules as DynamicTriggerRule[]) {
			if (!raw || typeof raw.id !== "string" || typeof raw.condition !== "string" || typeof raw.action !== "string") throw new Error("trigger sidecar contains an invalid rule");
			if (!SAFE_ID.test(raw.id)) throw new Error("trigger sidecar contains an invalid rule id");
			const id = input.existingRuleIds.has(raw.id) ? newRuleId() : raw.id;
			if (raw.enabled) originallyEnabledRules.push(id);
			rules.push({ ...raw, id, cwd: input.targetCwd, enabled: raw.enabled && input.activate, createdBy: { sessionId } });
		}
	}
	const states: Record<string, string> = {};
	for (const [name, data] of files) {
		if (!name.startsWith(LOOPS_DIR) || !name.endsWith(".md")) continue;
		if (data.length > MAX_SIDECAR_BYTES) throw new Error(`${name} exceeds cap`);
		const original = name.slice(LOOPS_DIR.length, -".md".length);
		const id = idMap.get(original);
		if (id) states[id] = capChars(data.toString("utf8"), LOOP_STATE_MAX_CHARS);
	}

	fs.mkdirSync(input.sessionDir, { recursive: true });
	const fd = fs.openSync(sessionPath, "wx", 0o600);
	try {
		fs.writeFileSync(fd, `${[JSON.stringify(header), ...parsed.rest].join("\n")}\n`);
	} finally {
		fs.closeSync(fd);
	}
	return { sessionId, sessionPath, originalSessionId: parsed.header.id, entryCount: parsed.entryCount, jobs, rules, states, originallyEnabledJobs, originallyEnabledRules, automationEnabled: input.activate, manifest };
}
