/**
 * Session archives — a portable `.pisession`, carrying the loop-state files
 * One uncompressed ustar tar, owner-only, never overwritten:
 *
 *   manifest.json
 *   session.jsonl                 pi's session file, verbatim
 *   sidecars/cron.json            this project's cron jobs   (optional)
 *   sidecars/triggers.json        this project's trigger rules (optional; --exclude-triggers)
 *   loops/<job-id>.md             loop state per stateful job (optional)
 *
 * Import rewrites only what must be local: a fresh session id and the target cwd in the
 * session header, and sidecar bookkeeping (automation disabled unless activated, running
 * markers / errors / overlap counters cleared). Importing the same archive twice adds nothing
 * the second time; a `.piesession` archive gives up its transcript but not its sidecars.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOOP_STATE_MAX_CHARS, capChars } from "./protocol.ts";
import { previewRedacted } from "./redact.ts";
import { formatSchedule, isValidSchedule, parseSchedule, stamp, type Schedule } from "./schedule.ts";
import { newId, type LoopJob } from "./store.ts";
import { parseToml, type TomlTable, type TomlValue } from "./toml.ts";
import { type DynamicTriggerRule, newRuleId } from "./triggers.ts";

export const ARCHIVE_SCHEMA = "pi-loops.session_export.v1";
export const ARCHIVE_EXT = ".pisession";
/** The other archive format `import` accepts: a `.piesession`. Its transcript is unreadable here; its sidecars are not. */
export const PIESESSION_SCHEMA = "pie.session_export.v1";
const MANIFEST_PATH = "manifest.json";
const SESSION_PATH = "session.jsonl";
const CRON_PATH = "sidecars/cron.json";
/** A `.piesession` writes its cron sidecar as TOML; a `.pisession` writes JSON. */
const PIESESSION_CRON_PATH = "sidecars/cron.toml";
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

/**
 * Parse and structurally validate a pi session transcript.
 *
 * Beyond "every line is JSON", three things make a transcript unopenable rather than merely odd,
 * and they are checked at parse time so a broken archive is refused here instead of silently
 * truncating history the first time the session is opened: duplicate entry ids, a `parentId` no
 * earlier entry declared, and an entry pointing at a target that does not exist (pi's `label` and
 * `leaf` entries carry `targetId`).
 */
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
	const seen = new Set<string>();
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		let entry: { id?: unknown; parentId?: unknown; targetId?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			throw new Error("session.jsonl contains a line that is not JSON");
		}
		if (typeof entry?.id !== "string") throw new Error("session.jsonl contains an entry without an id");
		if (seen.has(entry.id)) throw new Error("session.jsonl contains a duplicate entry id");
		if (typeof entry.parentId === "string" && !seen.has(entry.parentId)) throw new Error("session.jsonl contains a dangling parentId");
		if (typeof entry.targetId === "string" && !seen.has(entry.targetId)) throw new Error("session.jsonl contains a dangling entry target");
		seen.add(entry.id);
		entryCount++;
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
	// --exclude-triggers drops every automation sidecar (trigger rules and cron jobs); loop
	// state follows the jobs.
	const rules = input.excludeTriggers ? [] : input.rules;
	const jobs = input.excludeTriggers ? [] : input.jobs;
	const states = Object.entries(input.states).filter(([id, text]) => jobs.some((j) => j.id === id && j.stateful) && text.trim());
	const manifest: Manifest = {
		schema: ARCHIVE_SCHEMA,
		created_at: stamp(),
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
	// Owner-only, and never truncate an existing file.
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
	/** --activate-triggers: automation stays disabled unless true. */
	activate: boolean;
	existingJobIds: Set<string>;
	existingRuleIds: Set<string>;
	/**
	 * What the store already holds. With them, a job/rule this archive was already imported from is
	 * recognised by provenance + payload, so re-importing adds nothing and importing the same archive
	 * into a second project still works; without them only a taken id can be recognised, which covers
	 * the plain re-import but treats a `--cwd` copy as a duplicate too.
	 */
	existingJobs?: LoopJob[];
	existingRules?: DynamicTriggerRule[];
	now?: () => Date;
}

/**
 * What makes two imported jobs "the same job": the session that first created it (provenance that
 * travels with the archive), the project it runs in, and what it runs. Ids alone are not enough —
 * an older pi-loops regenerated them on collision, so a second copy carries a different id.
 */
function jobKey(job: { createdBy?: { sessionId?: string }; cwd: string; prompt: string }): string {
	return [job.createdBy?.sessionId ?? "", job.cwd, job.prompt].join("\u0000");
}

function ruleKey(rule: { createdBy?: { sessionId?: string }; cwd: string; condition: string; action: string }): string {
	return [rule.createdBy?.sessionId ?? "", rule.cwd, rule.condition, rule.action].join("\u0000");
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
	/** Already present in the store and therefore not imported again (a second import of one archive). */
	skippedJobs: number;
	skippedRules: number;
	/** False for a `.piesession`: its automation was salvaged but its transcript was not (see `notes`). */
	transcriptImported: boolean;
	/** What the import did that the caller should say out loud. */
	notes: string[];
}

/** Ids become file and directory names (`state/<id>.md`, `sessions/<id>/`): plain tokens only. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * What an archive holds, without writing anything. A backup format you cannot look inside is one
 * you have to trust blindly at exactly the moment you are least able to (restoring on a new
 * machine); a summary is printed before importing, which makes it available on its own.
 */
export function inspectArchive(archivePath: string): { schema: string; createdAt: string; sourceCwd: string; entryCount: number; loopStateCount: number; jobs: Array<{ schedule: string; prompt: string; enabled: boolean }>; rules: Array<{ condition: string; action: string; enabled: boolean }> } {
	const files = readTar(fs.readFileSync(archivePath));
	for (const name of files.keys()) validateArchivePath(name);
	const manifestBytes = files.get(MANIFEST_PATH);
	if (!manifestBytes) throw new Error("archive has no manifest.json");
	const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
	const jobs: Array<{ schedule: string; prompt: string; enabled: boolean }> = [];
	const rules: Array<{ condition: string; action: string; enabled: boolean }> = [];
	const cron = files.get(CRON_PATH);
	if (cron) {
		for (const j of (JSON.parse(cron.toString("utf8"))?.jobs ?? []) as LoopJob[]) {
			jobs.push({ schedule: isValidSchedule(j.schedule) ? formatSchedule(j.schedule) : "(invalid)", prompt: previewRedacted(j.prompt ?? "", 100), enabled: !!j.enabled });
		}
	}
	const trig = files.get(TRIGGERS_PATH);
	if (trig) {
		for (const r of (JSON.parse(trig.toString("utf8"))?.rules ?? []) as DynamicTriggerRule[]) {
			rules.push({ condition: previewRedacted(r.condition ?? "", 80), action: previewRedacted(r.action ?? "", 80), enabled: !!r.enabled });
		}
	}
	return {
		schema: manifest?.schema ?? "(unknown)",
		createdAt: manifest?.created_at ?? "(unknown)",
		sourceCwd: manifest?.source?.cwd ?? "(unknown)",
		entryCount: manifest?.content?.entry_count ?? 0,
		loopStateCount: manifest?.content?.loop_state_count ?? 0,
		jobs,
		rules,
	};
}

export function importSession(input: ImportInput): ImportSummary {
	const files = readTar(fs.readFileSync(input.archivePath));
	for (const name of files.keys()) validateArchivePath(name);
	const manifestBytes = files.get(MANIFEST_PATH);
	if (!manifestBytes) throw new Error("archive has no manifest.json");
	if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("manifest.json exceeds cap");
	const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
	if (manifest?.schema === PIESESSION_SCHEMA) return importPiesessionArchive(files, manifest, input);
	if (manifest?.schema !== ARCHIVE_SCHEMA) throw new Error(`unsupported archive schema ${JSON.stringify(manifest?.schema)} (expected ${ARCHIVE_SCHEMA})`);
	const sessionBytes = files.get(SESSION_PATH);
	if (!sessionBytes) throw new Error("archive has no session.jsonl");
	if (sessionBytes.length > MAX_SESSION_BYTES) throw new Error("session.jsonl exceeds the 50 MiB cap");
	if (sha256(sessionBytes) !== manifest.content?.session_jsonl_sha256) throw new Error("session.jsonl does not match the manifest checksum");
	const parsed = parseSessionJsonl(sessionBytes.toString("utf8"));

	// Fresh id + local cwd; provenance kept in the header as `importedFrom`.
	const now = (input.now ?? (() => new Date()))();
	const sessionId = randomUUID();
	// UTC here, against the rule everywhere else: this goes into pi's own session header and into
	// the file name beside it. The header's format is pi's to decide, and a file name cannot hold
	// the `+` and `:` an offset brings.
	const timestamp = now.toISOString();
	const { parentSession: _parent, parentSessionPath: _parentPath, ...headerRest } = parsed.header as Record<string, unknown>;
	const header = { ...headerRest, id: sessionId, cwd: input.targetCwd, timestamp, importedFrom: { session_id: parsed.header.id, cwd: manifest.source?.cwd, exported_at: manifest.created_at, pi_version: manifest.pi_version, pi_loops_version: manifest.pi_loops_version } };
	const sessionPath = path.join(input.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);

	// Every sidecar is staged and validated before anything is committed: a rejected archive
	// must not leave an orphan session file behind.
	const dedup = new Dedup(input);
	const idMap = new Map<string, string>();
	const jobs: LoopJob[] = [];
	const originallyEnabledJobs: string[] = [];
	const cronBytes = files.get(CRON_PATH);
	if (cronBytes) {
		if (cronBytes.length > MAX_SIDECAR_BYTES) throw new Error("cron sidecar exceeds cap");
		const file = JSON.parse(cronBytes.toString("utf8"));
		if (!Array.isArray(file?.jobs)) throw new Error("cron sidecar has no jobs array");
		for (const raw of file.jobs as LoopJob[]) {
			if (!raw || typeof raw.id !== "string" || typeof raw.prompt !== "string") throw new Error("cron sidecar contains an invalid job");
			// The schedule drives `computeDue` on every tick in every pi: a malformed one from a
			// hand-made archive would throw there, and the tick has no per-job recovery upstream.
			if (!isValidSchedule(raw.schedule)) throw new Error(`cron sidecar contains an invalid schedule for job ${raw.id}`);
			if (!SAFE_ID.test(raw.id)) throw new Error("cron sidecar contains an invalid job id");
			// Automation off unless activated, stale run bookkeeping cleared.
			// `host` is a hard run-time filter (scheduler.ts), so an archive restored on another
			// machine must be re-stamped or every job would look enabled and never fire.
			// `createdBy` is left as the archive carries it: it names the session that created the job,
			// which is what lets a second import of the same archive recognise itself. Re-stamping it
			// with the fresh import session would make every import look new and double the automation.
			const job: LoopJob = {
				...raw,
				cwd: input.targetCwd,
				host: os.hostname(),
				enabled: raw.enabled && input.activate,
				running: undefined,
				lastDueAt: undefined,
				lastError: undefined,
				skippedOverlap: 0,
				sessionId: raw.stateful ? undefined : sessionId,
				createdBy: raw.createdBy ?? { sessionId: parsed.header.id, cwd: manifest.source?.cwd ?? input.targetCwd },
			};
			if (dedup.hasJob(job)) continue;
			if (input.existingJobIds.has(job.id)) job.id = newId("cron");
			idMap.set(raw.id, job.id);
			if (raw.enabled) originallyEnabledJobs.push(job.id);
			jobs.push(job);
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
			const rule: DynamicTriggerRule = { ...raw, cwd: input.targetCwd, host: os.hostname(), enabled: raw.enabled && input.activate, createdBy: raw.createdBy ?? { sessionId: parsed.header.id } };
			if (dedup.hasRule(rule)) continue;
			if (input.existingRuleIds.has(rule.id)) rule.id = newRuleId();
			if (raw.enabled) originallyEnabledRules.push(rule.id);
			rules.push(rule);
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
	return {
		sessionId,
		sessionPath,
		originalSessionId: parsed.header.id,
		entryCount: parsed.entryCount,
		jobs,
		rules,
		states,
		originallyEnabledJobs,
		originallyEnabledRules,
		automationEnabled: input.activate,
		manifest,
		skippedJobs: dedup.jobs,
		skippedRules: dedup.rules,
		transcriptImported: true,
		notes: dedup.notes(),
	};
}

/**
 * Recognises automation this store already imported from the same archive. Without it, importing an
 * archive twice leaves two live copies of every job and rule, each running and each billing.
 */
class Dedup {
	jobs = 0;
	rules = 0;
	private readonly input: ImportInput;
	private readonly jobKeys?: Set<string>;
	private readonly ruleKeys?: Set<string>;
	constructor(input: ImportInput) {
		this.input = input;
		if (input.existingJobs) this.jobKeys = new Set(input.existingJobs.map(jobKey));
		if (input.existingRules) this.ruleKeys = new Set(input.existingRules.map(ruleKey));
	}

	hasJob(job: LoopJob): boolean {
		// Without the store's jobs, a taken id is the only evidence available — and an id in an archive
		// is stable, so a taken one does mean "imported already".
		const dup = this.jobKeys ? this.jobKeys.has(jobKey(job)) : this.input.existingJobIds.has(job.id);
		if (dup) this.jobs++;
		return dup;
	}

	hasRule(rule: DynamicTriggerRule): boolean {
		const dup = this.ruleKeys ? this.ruleKeys.has(ruleKey(rule)) : this.input.existingRuleIds.has(rule.id);
		if (dup) this.rules++;
		return dup;
	}

	notes(): string[] {
		const out: string[] = [];
		if (this.jobs) out.push(`${this.jobs} cron job(s) already imported from this archive were skipped`);
		if (this.rules) out.push(`${this.rules} trigger rule(s) already imported from this archive were skipped`);
		return out;
	}
}

/* --------------------------------------------------- .piesession import */

interface PiesessionCronJob {
	id: string;
	schedule: string;
	action: string;
	enabled: boolean;
	stateful?: boolean;
	created_at?: string;
}

interface PiesessionTriggerRule {
	id: string;
	condition: string;
	action: string;
	enabled: boolean;
	fire_once?: boolean;
	fired_at?: string;
	promote_to_chat?: boolean;
	created_at?: string;
}

const tomlString = (table: TomlTable, key: string): string | undefined => (typeof table[key] === "string" ? (table[key] as string) : undefined);

/**
 * A `.piesession`, salvaged as far as it goes.
 *
 * Its transcript is a tree format pi cannot open, so it is skipped. The automation sidecars are
 * plain data and do translate: `sidecars/cron.toml` and `sidecars/triggers.json`. Inject-mode cron
 * jobs are dropped along with the transcript — they deliver into the session that owns them, and
 * that session is exactly what cannot come across; loops are machine-global and survive the trip.
 */
function importPiesessionArchive(files: Map<string, Buffer>, manifest: Manifest, input: ImportInput): ImportSummary {
	const sessionBytes = files.get(SESSION_PATH);
	if (sessionBytes && sha256(sessionBytes) !== manifest.content?.session_jsonl_sha256) throw new Error("session.jsonl does not match the manifest checksum");
	const sourceSessionId = manifest.source?.session_id ?? "";
	const dedup = new Dedup(input);
	const notes = [".piesession archive: pi cannot open its transcript format, so only the automation sidecars were imported (no session file was written)"];

	const jobs: LoopJob[] = [];
	const originallyEnabledJobs: string[] = [];
	let injectSkipped = 0;
	const cronBytes = files.get(PIESESSION_CRON_PATH);
	if (cronBytes) {
		if (cronBytes.length > MAX_SIDECAR_BYTES) throw new Error("cron sidecar exceeds cap");
		let table: TomlTable;
		try {
			table = parseToml(cronBytes.toString("utf8"));
		} catch (err: any) {
			throw new Error(`the archive's cron sidecar is not valid TOML: ${err?.message ?? err}`);
		}
		const raws: TomlValue[] = Array.isArray(table.jobs) ? table.jobs : [];
		for (const entry of raws) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("the archive's cron sidecar contains an invalid job");
			const raw = entry as unknown as PiesessionCronJob;
			const id = tomlString(entry, "id");
			const schedule = tomlString(entry, "schedule");
			const action = tomlString(entry, "action");
			if (!id || !schedule || !action) throw new Error("the archive's cron sidecar contains an invalid job");
			if (!SAFE_ID.test(id)) throw new Error("the archive's cron sidecar contains an invalid job id");
			if (!raw.stateful) {
				injectSkipped++;
				continue;
			}
			let parsedSchedule: Schedule;
			try {
				parsedSchedule = parseSchedule(schedule);
			} catch (err: any) {
				throw new Error(`the archive's cron sidecar job ${id} has a schedule pi-loops cannot read: ${err?.message ?? err}`);
			}
			const job: LoopJob = {
				id,
				schedule: parsedSchedule,
				stateful: true,
				prompt: action,
				cwd: input.targetCwd,
				enabled: !!raw.enabled && input.activate,
				catchUp: true,
				createdAt: tomlString(entry, "created_at") ?? stamp(),
				runCount: 0,
				skippedOverlap: 0,
				host: os.hostname(),
				createdBy: { sessionId: sourceSessionId, cwd: manifest.source?.cwd ?? input.targetCwd },
			};
			if (dedup.hasJob(job)) continue;
			if (input.existingJobIds.has(job.id)) job.id = newId("cron");
			if (raw.enabled) originallyEnabledJobs.push(job.id);
			jobs.push(job);
		}
	}

	const rules: DynamicTriggerRule[] = [];
	const originallyEnabledRules: string[] = [];
	const triggerBytes = files.get(TRIGGERS_PATH);
	if (triggerBytes) {
		if (triggerBytes.length > MAX_SIDECAR_BYTES) throw new Error("trigger sidecar exceeds cap");
		const file = JSON.parse(triggerBytes.toString("utf8"));
		if (!Array.isArray(file?.rules)) throw new Error("the archive's trigger sidecar has no rules array");
		for (const raw of file.rules as PiesessionTriggerRule[]) {
			if (!raw || typeof raw.id !== "string" || typeof raw.condition !== "string" || typeof raw.action !== "string") throw new Error("the archive's trigger sidecar contains an invalid rule");
			if (!SAFE_ID.test(raw.id)) throw new Error("the archive's trigger sidecar contains an invalid rule id");
			const rule: DynamicTriggerRule = {
				id: raw.id,
				condition: raw.condition,
				action: raw.action,
				enabled: !!raw.enabled && input.activate,
				fireOnce: raw.fire_once ?? true, // a rule with no explicit setting fires once
				firedAt: raw.fired_at,
				promoteToChat: !!raw.promote_to_chat,
				createdAt: raw.created_at ?? stamp(),
				cwd: input.targetCwd,
				host: os.hostname(),
				createdBy: { sessionId: sourceSessionId },
			};
			if (dedup.hasRule(rule)) continue;
			if (input.existingRuleIds.has(rule.id)) rule.id = newRuleId();
			if (raw.enabled) originallyEnabledRules.push(rule.id);
			rules.push(rule);
		}
	}
	if (injectSkipped) notes.push(`${injectSkipped} inject-mode cron job(s) were skipped: they deliver into the session that owns them, which did not come across`);
	notes.push(...dedup.notes());

	return {
		sessionId: sourceSessionId,
		sessionPath: "",
		originalSessionId: sourceSessionId,
		entryCount: 0,
		jobs,
		rules,
		states: {},
		originallyEnabledJobs,
		originallyEnabledRules,
		automationEnabled: input.activate,
		manifest,
		skippedJobs: dedup.jobs,
		skippedRules: dedup.rules,
		transcriptImported: false,
		notes,
	};
}
