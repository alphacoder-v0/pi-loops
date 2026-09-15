/**
 * Recipes: a packaged way of running a project on loops (`CONTEXT.md` has the vocabulary,
 * `docs/design.md` §15–18 the decisions).
 *
 * Everything `/recipe` decides is here, as functions that take state and return the change; the
 * command handler in `pi-loops.ts` reads arguments, asks the person, writes the store and prints.
 * Nothing in this module touches `jobs.json` or the UI. The one rule that matters most: a
 * manifest's `[[job]]` is checked by building the `/cron add` line it stands for and handing that
 * to `parseAddArgs` — the same parser, the same refusals — so a recipe can never create a job a
 * person could not have typed.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAddArgs, type AddArgs } from "./args.ts";
import { parseToml, type TomlTable, type TomlValue } from "./toml.ts";
import { computeNext, formatSchedule, stamp } from "./schedule.ts";
import { PI_LOOPS_VERSION as VERSION } from "./version.ts";

export const AUTONOMY_LEVELS = ["report", "propose", "act"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export interface RecipeJob {
	name: string;
	/** The schedule text exactly as `/cron add` would take it. */
	schedule: string;
	/** The playbook this job's runs read, relative to the recipe directory. */
	playbook: string;
	/** Optional `/cron add` flags. Absent = the flag is not passed. */
	verify?: boolean;
	timeout?: string;
	thinking?: string;
	tools?: string[];
	/** Prompt override; the default is the pointer sentence built by `promptFor`. */
	prompt?: string;
}

export interface RecipeManifest {
	name: string;
	summary: string;
	needsTracker: boolean;
	levels: AutonomyLevel[];
	/**
	 * Where the recipe sits in `/recipe list`: a `starter` reads and files findings and is the
	 * one to install first; an `advanced` one writes somewhere — a worktree, a pull request, a
	 * tracker — and wants the playbooks read before the level question is answered.
	 */
	tier: RecipeTier;
	/** One sentence each, for `/recipe show`: the situations this recipe is for. */
	usefulWhen: string[];
	/** A script run once per project, with confirmation, before the jobs exist. */
	setup?: string;
	/** Files copied beside the playbooks (templates a playbook tells the run to create from). */
	files: string[];
	budgetHintUsd?: number;
	jobs: RecipeJob[];
}

export interface Recipe {
	manifest: RecipeManifest;
	/** Absolute path of the directory `recipe.toml` was read from. */
	dir: string;
}

/** What `/recipe add` leaves beside the playbooks so `list`, `remove` and `update` know what happened. */
export interface InstallRecord {
	recipe: string;
	/** The pi-loops version whose packaged files were installed. */
	version: string;
	level: AutonomyLevel;
	installedAt: string;
	/** Relative names of every file written (playbooks and extra files), for `update`. */
	files: string[];
	/** Where the files came from: a packaged recipe by name, or a path. */
	source: string;
}

export const RECIPE_TIERS = ["starter", "advanced"] as const;
export type RecipeTier = (typeof RECIPE_TIERS)[number];

export const MANIFEST_FILE = "recipe.toml";
export const RECORD_FILE = ".recipe.json";
/** Where a recipe's files land in a project, relative to the project root. */
export const INSTALL_ROOT = path.join(".agents", "skills");
/** A setup script longer than this cannot be shown whole in a confirmation, so it is not run at all. */
export const MAX_SETUP_SHOWN = 6000;

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** A packaged recipe name, and the only thing `/recipe update|remove <name>` accept as a name. */
export function isRecipeName(s: string): boolean {
	return NAME_RE.test(s);
}

/* ---------------------------------------------------------------------------- the manifest */

function str(t: TomlTable, key: string, where: string): string | undefined {
	const v = t[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") throw new Error(`${where}: ${key} must be a string`);
	return v;
}
function requireStr(t: TomlTable, key: string, where: string): string {
	const v = str(t, key, where);
	if (v === undefined || !v.trim()) throw new Error(`${where}: ${key} is required`);
	return v;
}
function bool(t: TomlTable, key: string, where: string): boolean | undefined {
	const v = t[key];
	if (v === undefined) return undefined;
	if (typeof v !== "boolean") throw new Error(`${where}: ${key} must be true or false`);
	return v;
}
function strList(t: TomlTable, key: string, where: string): string[] | undefined {
	const v = t[key];
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || !v.every((x: TomlValue) => typeof x === "string")) throw new Error(`${where}: ${key} must be a list of strings`);
	return v as string[];
}

/** The sentence a recipe job's prompt is, unless the manifest says otherwise. */
export function promptFor(job: RecipeJob, installDir: string): string {
	return job.prompt ?? `Read ${path.join(installDir, job.playbook)} and do what it says for this repository.`;
}

/**
 * The `/cron add` line a recipe job stands for. Building the text and parsing it back is not
 * indirection for its own sake: it is what makes "a recipe can only do what a person could type"
 * true, and it is the line `/recipe add` shows before asking for a yes.
 */
export function addLineFor(job: RecipeJob, installDir: string): string {
	const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
	const parts = ["--stateful", "--name", q(job.name)];
	if (job.verify) parts.push("--verify");
	if (job.timeout) parts.push("--timeout", q(job.timeout));
	if (job.thinking) parts.push("--thinking", q(job.thinking));
	if (job.tools?.length) parts.push("--tools", q(job.tools.join(",")));
	parts.push(q(job.schedule), promptFor(job, installDir));
	return parts.join(" ");
}

/** The arguments `/cron add` would have parsed from that line; throws exactly what it would. */
export function addArgsFor(job: RecipeJob, installDir: string, now: number = Date.now()): AddArgs {
	return parseAddArgs(addLineFor(job, installDir), now);
}

export function parseManifest(text: string, opts: { now?: number } = {}): RecipeManifest {
	const doc = parseToml(text);
	const where = MANIFEST_FILE;
	const name = requireStr(doc, "name", where);
	if (!NAME_RE.test(name)) throw new Error(`${where}: name must be lowercase letters, digits and dashes (got "${name}")`);
	const summary = requireStr(doc, "summary", where);
	const levelsRaw = strList(doc, "levels", where);
	if (!levelsRaw?.length) throw new Error(`${where}: levels must list at least one of ${AUTONOMY_LEVELS.join(", ")}`);
	const levels: AutonomyLevel[] = [];
	for (const l of levelsRaw) {
		if (!(AUTONOMY_LEVELS as readonly string[]).includes(l)) throw new Error(`${where}: unknown level "${l}" (levels are ${AUTONOMY_LEVELS.join(", ")})`);
		levels.push(l as AutonomyLevel);
	}
	// Declared order is not trusted: the wizard defaults to the lowest, and "lowest" is a fact
	// about the vocabulary, not about how someone typed the list.
	levels.sort((a, b) => AUTONOMY_LEVELS.indexOf(a) - AUTONOMY_LEVELS.indexOf(b));
	const setup = str(doc, "setup", where);
	if (setup !== undefined && !safeRelative(setup)) throw new Error(`${where}: setup must be a file inside the recipe directory`);
	const files = strList(doc, "files", where) ?? [];
	for (const f of files) if (!safeRelative(f)) throw new Error(`${where}: files entry "${f}" must be inside the recipe directory`);
	const budget = doc.budget_hint_usd;
	if (budget !== undefined && (typeof budget !== "number" || budget < 0)) throw new Error(`${where}: budget_hint_usd must be a non-negative number`);
	const tierRaw = str(doc, "tier", where) ?? "advanced";
	if (!(RECIPE_TIERS as readonly string[]).includes(tierRaw)) throw new Error(`${where}: tier must be ${RECIPE_TIERS.join(" or ")} (got "${tierRaw}")`);
	const usefulWhen = strList(doc, "useful_when", where) ?? [];
	const jobsRaw = doc.job;
	if (!Array.isArray(jobsRaw) || jobsRaw.length === 0) throw new Error(`${where}: at least one [[job]] is required`);
	const jobs: RecipeJob[] = [];
	const seen = new Set<string>();
	for (const [i, raw] of jobsRaw.entries()) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}: [[job]] #${i + 1} is not a table`);
		const t = raw as TomlTable;
		const jw = `${where} [[job]] #${i + 1}`;
		const job: RecipeJob = {
			name: requireStr(t, "name", jw),
			schedule: requireStr(t, "schedule", jw),
			playbook: requireStr(t, "playbook", jw),
			verify: bool(t, "verify", jw),
			timeout: str(t, "timeout", jw),
			thinking: str(t, "thinking", jw),
			tools: strList(t, "tools", jw),
			prompt: str(t, "prompt", jw),
		};
		if (seen.has(job.name)) throw new Error(`${jw}: job name "${job.name}" is used twice`);
		seen.add(job.name);
		if (!safeRelative(job.playbook) || !job.playbook.endsWith(".md")) throw new Error(`${jw}: playbook must be a .md file inside the recipe directory`);
		// The one validation that matters: what /cron add would say.
		try {
			const parsed = addArgsFor(job, path.join(INSTALL_ROOT, name), opts.now);
			if (parsed.schedule.kind === "once") throw new Error("a recipe job must recur (`in`/`at` schedules fire once and are then removed)");
			// What createLoopJob refuses at creation, refused here, so a manifest is bad before it is installed.
			const t = opts.now ?? Date.now();
			if (parsed.schedule.kind === "cron" && computeNext({ schedule: parsed.schedule, createdAt: t }, t) === undefined) throw new Error(`${formatSchedule(parsed.schedule)} has no next run`);
		} catch (e) {
			throw new Error(`${jw} (${job.name}): ${(e as Error).message}`);
		}
		jobs.push(job);
	}
	return { name, summary, needsTracker: bool(doc, "needs_tracker", where) ?? false, levels, tier: tierRaw as RecipeTier, usefulWhen, setup, files, budgetHintUsd: budget as number | undefined, jobs };
}

/** Relative, inside the directory, and a single file: no `..`, no absolute path, no trailing slash. */
function safeRelative(p: string): boolean {
	if (!p || path.isAbsolute(p) || p.endsWith("/")) return false;
	const norm = path.posix.normalize(p);
	return !norm.startsWith("../") && norm !== ".." && !norm.startsWith("/");
}

/** `/recipe add <ref> [--level <l>]` and `pi-loops recipe add`: which word is the recipe, which the level. */
export function parseAddWords(words: string[]): { ref?: string; level?: string } {
	let ref: string | undefined;
	let level: string | undefined;
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (w === "--level") {
			level = words[++i];
			continue;
		}
		if (w.startsWith("--level=")) {
			level = w.slice("--level=".length);
			continue;
		}
		if (!w.startsWith("--") && ref === undefined) ref = w;
	}
	return { ref, level };
}

/* ------------------------------------------------------------------------ finding recipes */

/** The recipes shipped with this package. */
export function packagedRecipesDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "recipes");
}

export function loadRecipe(dir: string, now?: number): Recipe {
	const file = path.join(dir, MANIFEST_FILE);
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		throw new Error(`no ${MANIFEST_FILE} in ${dir}`);
	}
	const manifest = parseManifest(text, { now });
	for (const f of playbookFiles(manifest)) {
		if (!fs.existsSync(path.join(dir, f))) throw new Error(`${manifest.name}: ${f} is named in ${MANIFEST_FILE} but is not in ${dir}`);
	}
	if (manifest.setup && !fs.existsSync(path.join(dir, manifest.setup))) throw new Error(`${manifest.name}: setup script ${manifest.setup} is not in ${dir}`);
	return { manifest, dir: path.resolve(dir) };
}

/** Every file `install` writes: each job's playbook once, then the extra files. */
export function playbookFiles(manifest: RecipeManifest): string[] {
	const out: string[] = [];
	for (const j of manifest.jobs) if (!out.includes(j.playbook)) out.push(j.playbook);
	for (const f of manifest.files) if (!out.includes(f)) out.push(f);
	return out;
}

/**
 * `/recipe add <ref>`: a name is looked up among the packaged recipes; anything with a slash or
 * a dot is a directory. A directory is taken as typed (relative to `cwd`), never searched for.
 */
export function resolveRecipeRef(ref: string, opts: { packaged?: string; cwd: string }): { dir: string; source: string } {
	const packaged = opts.packaged ?? packagedRecipesDir();
	if (NAME_RE.test(ref)) {
		const dir = path.join(packaged, ref);
		if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return { dir, source: ref };
		const known = listRecipes(packaged).map((r) => r.manifest.name);
		throw new Error(`no packaged recipe named "${ref}"${known.length ? ` (have: ${known.join(", ")})` : ""}; a directory works too: /recipe add ./path/to/recipe`);
	}
	const dir = path.resolve(opts.cwd, ref);
	if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) throw new Error(`no ${MANIFEST_FILE} in ${dir}`);
	return { dir, source: dir };
}

export function listRecipes(packaged: string = packagedRecipesDir()): Recipe[] {
	let names: string[];
	try {
		names = fs.readdirSync(packaged).filter((n) => !n.startsWith("_") && !n.startsWith("."));
	} catch {
		return [];
	}
	const out: Recipe[] = [];
	for (const n of names.sort()) {
		const dir = path.join(packaged, n);
		if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) continue;
		out.push(loadRecipe(dir));
	}
	return out;
}

/* --------------------------------------------------------------------- the autonomy line */

// Spaces and tabs only: `\s` would swallow the newlines after the line and drag the next line up.
const LEVEL_LINE = /^Autonomy:[ \t]*(\S+)[ \t]*$/m;

/**
 * The installed level is the first line of the playbook body: `Autonomy: propose`. Text the
 * model reads and a person edits; the wizard writes it, and `update` keeps it.
 */
export function setLevelLine(text: string, level: AutonomyLevel): string {
	if (LEVEL_LINE.test(text)) return text.replace(LEVEL_LINE, `Autonomy: ${level}`);
	// No line yet: after the frontmatter if there is one, else at the top.
	const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
	if (fm) return `${fm[0]}\nAutonomy: ${level}\n${text.slice(fm[0].length).replace(/^\r?\n/, "")}`;
	return `Autonomy: ${level}\n\n${text}`;
}

export function readLevelLine(text: string): AutonomyLevel | undefined {
	const m = text.match(LEVEL_LINE);
	const l = m?.[1];
	return l && (AUTONOMY_LEVELS as readonly string[]).includes(l) ? (l as AutonomyLevel) : undefined;
}

/**
 * What a playbook forbids, for `/recipe show` and the install confirmation: the non-empty lines
 * under every `## Never…` heading (`## Never`, `## Never bump`), up to the next `## ` heading.
 * The section is the packaged recipes' convention for the safety envelope of a run, and the one
 * place a person can read it before the playbook is installed and followed unattended.
 */
export function neverSection(text: string): string[] {
	const out: string[] = [];
	let inside = false;
	for (const line of text.split("\n")) {
		if (/^## /.test(line)) {
			inside = /^## Never\b/.test(line);
			continue;
		}
		if (inside && line.trim()) out.push(line.trimEnd());
	}
	return out;
}

/* ------------------------------------------------------------------------------ installing */

export interface InstallPlan {
	/** Absolute path the files go to. */
	targetDir: string;
	/** Files that would be written, relative to targetDir. */
	files: string[];
	/** Files at targetDir that already exist and differ from what would be written. */
	changed: string[];
	/** The `/cron add` line per job, with the project-relative playbook path. */
	addLines: string[];
	record?: InstallRecord;
}

export function installDirFor(projectDir: string, recipeName: string): string {
	return path.join(projectDir, INSTALL_ROOT, recipeName);
}

/** What would be written and created, computed without writing anything. */
export function planInstall(recipe: Recipe, projectDir: string, level: AutonomyLevel): InstallPlan {
	const targetDir = installDirFor(projectDir, recipe.manifest.name);
	const files = playbookFiles(recipe.manifest);
	const changed: string[] = [];
	for (const f of files) {
		const dest = path.join(targetDir, f);
		if (fs.existsSync(dest) && editedBeyondLevel(fs.readFileSync(dest, "utf8"), renderFile(recipe, f, level), level, isPlaybook(recipe, f))) changed.push(f);
	}
	const rel = path.join(INSTALL_ROOT, recipe.manifest.name);
	return { targetDir, files, changed, addLines: recipe.manifest.jobs.map((j) => addLineFor(j, rel)), record: readRecord(targetDir) };
}

/** The packaged file as it is installed: playbooks get the level line, other files are copied as they are. */
function renderFile(recipe: Recipe, f: string, level: AutonomyLevel): string {
	const text = fs.readFileSync(path.join(recipe.dir, f), "utf8");
	return isPlaybook(recipe, f) ? setLevelLine(text, level) : text;
}

/**
 * Does the installed copy differ from what would be written, other than in the level line? The
 * level line is the wizard's, not the person's: reinstalling at another level is not an edit.
 */
function editedBeyondLevel(existing: string, rendered: string, level: AutonomyLevel, isPlaybook: boolean): boolean {
	return (isPlaybook ? setLevelLine(existing, level) : existing) !== rendered;
}

function isPlaybook(recipe: Recipe, f: string): boolean {
	return f.endsWith(".md") && recipe.manifest.jobs.some((j) => j.playbook === f);
}

/** The untouched copy `update` merges against: under `.orig/`, so `cp -r` of a subdirectory carries no debris. */
function origPath(targetDir: string, f: string): string {
	const p = path.join(targetDir, ".orig", f);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	return p;
}

/**
 * Refuse to write through a symlink. `.agents/skills/` is a committed directory in many
 * repositories, so a clone can ship `.agents/skills/<name>` — or one of the files inside — as a
 * link to anywhere; every write here must land inside the project's own tree.
 */
function refuseSymlinks(projectDir: string, targetDir: string, files: string[]): void {
	const root = fs.realpathSync(projectDir);
	const check = (p: string) => {
		try {
			if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a symbolic link; refusing to write through it`);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
			throw e;
		}
	};
	// Every existing ancestor from the project down to the install directory, then every destination.
	const rel = path.relative(projectDir, targetDir).split(path.sep);
	for (let i = 1; i <= rel.length; i++) check(path.join(projectDir, ...rel.slice(0, i)));
	const dests = files.flatMap((f) => [path.join(targetDir, f), path.join(targetDir, ".orig", f), ...f.split("/").slice(0, -1).map((_, i, parts) => path.join(targetDir, ...parts.slice(0, i + 1)))]);
	for (const d of [path.join(targetDir, ".orig"), path.join(targetDir, RECORD_FILE), ...dests]) check(d);
	if (fs.existsSync(targetDir)) {
		const real = fs.realpathSync(targetDir);
		if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`${targetDir} resolves outside the project (${real}); refusing to write there`);
	}
}

/**
 * Write the files and the untouched copies `update` merges against. Existing files are
 * overwritten only when `overwrite` says so — `planInstall().changed` is what the wizard shows
 * before asking.
 */
export function installFiles(recipe: Recipe, projectDir: string, level: AutonomyLevel, opts: { overwrite: boolean; source: string }): InstallRecord {
	const targetDir = installDirFor(projectDir, recipe.manifest.name);
	const files = playbookFiles(recipe.manifest);
	refuseSymlinks(projectDir, targetDir, [...files, ...(recipe.manifest.setup ? [recipe.manifest.setup] : [])]);
	fs.mkdirSync(targetDir, { recursive: true });
	for (const f of files) {
		const dest = path.join(targetDir, f);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		const content = renderFile(recipe, f, level);
		if (fs.existsSync(dest) && !opts.overwrite) {
			const existing = fs.readFileSync(dest, "utf8");
			if (editedBeyondLevel(existing, content, level, isPlaybook(recipe, f))) {
				// Kept as edited — but the level line is the wizard's, so it still moves, in the copy and
				// in the base the next update merges against.
				if (isPlaybook(recipe, f)) {
					const relevelled = setLevelLine(existing, level);
					if (relevelled !== existing) fs.writeFileSync(dest, relevelled);
					const orig = origPath(targetDir, f);
					if (fs.existsSync(orig)) fs.writeFileSync(orig, setLevelLine(fs.readFileSync(orig, "utf8"), level));
				}
				continue;
			}
		}
		fs.writeFileSync(dest, content);
		fs.writeFileSync(origPath(targetDir, f), content);
	}
	if (recipe.manifest.setup) {
		// The setup script is copied too, so what ran is what is there to read afterwards.
		const dest = path.join(targetDir, recipe.manifest.setup);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(path.join(recipe.dir, recipe.manifest.setup), dest);
	}
	const record: InstallRecord = { recipe: recipe.manifest.name, version: VERSION, level, installedAt: stamp(), files, source: opts.source };
	fs.writeFileSync(path.join(targetDir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
	return record;
}

/**
 * The record is a file in a directory a clone can ship, so nothing in it is trusted: the name must
 * be a recipe name, the level one of ours, the source a packaged name or an absolute path.
 */
export function readRecord(targetDir: string): InstallRecord | undefined {
	try {
		const r = JSON.parse(fs.readFileSync(path.join(targetDir, RECORD_FILE), "utf8")) as Partial<InstallRecord>;
		if (typeof r?.recipe !== "string" || !NAME_RE.test(r.recipe)) return undefined;
		if (typeof r.level !== "string" || !(AUTONOMY_LEVELS as readonly string[]).includes(r.level)) return undefined;
		if (typeof r.source !== "string" || !(NAME_RE.test(r.source) || path.isAbsolute(r.source))) return undefined;
		if (!Array.isArray(r.files) || !r.files.every((f) => typeof f === "string" && safeRelative(f))) return undefined;
		return { recipe: r.recipe, level: r.level as AutonomyLevel, source: r.source, files: r.files, version: typeof r.version === "string" ? r.version : "?", installedAt: typeof r.installedAt === "string" ? r.installedAt : "?" };
	} catch {
		return undefined;
	}
}

/** `update` and `remove` name a recipe; anything else is a path, and paths do not go under `.agents/skills`. */
export function requireRecipeName(name: string): string {
	if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a recipe name (lowercase letters, digits, dashes)`);
	return name;
}

/**
 * `--purge`: only what the install wrote — the recorded files, their untouched copies, the setup
 * script and the record — then the directory if that emptied it. `.agents/skills/<name>/` may also
 * hold a project's own files, and those are not ours to delete.
 */
export function purgeInstall(targetDir: string, record: InstallRecord, setup?: string): void {
	for (const f of [...record.files, ...(setup ? [setup] : [])]) {
		fs.rmSync(path.join(targetDir, f), { force: true });
	}
	fs.rmSync(path.join(targetDir, ".orig"), { recursive: true, force: true });
	fs.rmSync(path.join(targetDir, RECORD_FILE), { force: true });
	// Empty subdirectories the files lived in, deepest first, then the directory itself.
	const dirs = [...new Set([...record.files, ...(setup ? [setup] : [])].map((f) => path.dirname(f)).filter((d) => d !== "."))].sort((a, b) => b.length - a.length);
	for (const d of dirs) {
		try {
			fs.rmdirSync(path.join(targetDir, d));
		} catch {
			// not empty, or already gone: either way, not ours
		}
	}
	try {
		fs.rmdirSync(targetDir);
	} catch {
		// something else lives here; leave it
	}
}

/** Every recipe installed in a project: the directories under `.agents/skills/` that carry a record. */
export function installedRecipes(projectDir: string): InstallRecord[] {
	const root = path.join(projectDir, INSTALL_ROOT);
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: InstallRecord[] = [];
	for (const n of names.sort()) {
		const r = readRecord(path.join(root, n));
		if (r) out.push(r);
	}
	return out;
}

/** The project's tracker description: written with the person by `/recipe add`, and kept out of the repository too. */
export const TRACKER_FILE = path.join("docs", "agents", "issue-tracker.md");

/**
 * Keep the install out of the project's history without touching its `.gitignore`:
 * `.git/info/exclude` is git's own place for a rule that belongs to this clone. Returns what it
 * did, so the wizard can say it. Not a repository → nothing to exclude from.
 */
export function ensureExcluded(projectDir: string, rel: string, kind: "dir" | "file" = "dir"): "added" | "present" | "no-git" {
	const gitDir = resolveGitDir(projectDir);
	if (!gitDir) return "no-git";
	const file = path.join(gitDir, "info", "exclude");
	const line = `/${rel.split(path.sep).join("/").replace(/\/+$/, "")}${kind === "dir" ? "/" : ""}`;
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		// absent: git does not create it until something writes it
	}
	if (text.split(/\r?\n/).some((l) => l.trim() === line)) return "present";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${text.length && !text.endsWith("\n") ? "\n" : ""}# pi-loops recipes (installed copies; not part of the repository)\n${line}\n`);
	return "added";
}

/** `.git` may be a directory or, in a worktree, a file pointing at one. */
function resolveGitDir(projectDir: string): string | undefined {
	const dot = path.join(projectDir, ".git");
	try {
		const st = fs.statSync(dot);
		if (st.isDirectory()) return dot;
		const m = fs.readFileSync(dot, "utf8").match(/^gitdir:\s*(.+)$/m);
		if (!m) return undefined;
		const target = path.resolve(projectDir, m[1].trim());
		if (!fs.existsSync(target)) return undefined;
		// A linked worktree's gitdir is <main>/.git/worktrees/<name>, and git reads info/exclude
		// through the *common* dir, never from there: a rule written beside the worktree is ignored.
		try {
			const common = fs.readFileSync(path.join(target, "commondir"), "utf8").trim();
			if (common) return path.resolve(target, common);
		} catch {
			// no commondir: an ordinary gitdir file (a submodule), which is its own common dir
		}
		return target;
	} catch {
		return undefined;
	}
}

/* --------------------------------------------------------------------------------- update */

export interface UpdateResult {
	/** Files identical to what is installed: nothing to do. */
	unchanged: string[];
	/** Files the person had not edited, or whose edits merged cleanly: written. */
	updated: string[];
	/** Files with overlapping edits: the installed copy is not written; the merge with markers is at `mergePath`. */
	conflicts: Array<{ file: string; mergePath: string; basePath: string; packagedPath: string }>;
	/** Files without an `.orig` (installed by hand, or by an older build): left alone. */
	noBase: string[];
}

/**
 * Three-way merge of the installed copy against the packaged one, with the untouched copy from
 * install time as the base. Silent when the person changed nothing; a file with conflicts is not
 * written — the caller hands it to the session, because markers in a playbook are text the next
 * run would follow.
 */
export function updateFiles(recipe: Recipe, projectDir: string, level: AutonomyLevel, opts: { git?: string } = {}): UpdateResult {
	const targetDir = installDirFor(projectDir, recipe.manifest.name);
	const out: UpdateResult = { unchanged: [], updated: [], conflicts: [], noBase: [] };
	refuseSymlinks(projectDir, targetDir, playbookFiles(recipe.manifest));
	for (const f of playbookFiles(recipe.manifest)) {
		const theirs = renderFile(recipe, f, level);
		const dest = path.join(targetDir, f);
		if (!fs.existsSync(dest)) {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, theirs);
			fs.writeFileSync(origPath(targetDir, f), theirs);
			out.updated.push(f);
			continue;
		}
		const ours = fs.readFileSync(dest, "utf8");
		if (ours === theirs) {
			fs.writeFileSync(origPath(targetDir, f), theirs);
			out.unchanged.push(f);
			continue;
		}
		let base: string;
		try {
			base = fs.readFileSync(origPath(targetDir, f), "utf8");
		} catch {
			out.noBase.push(f);
			continue;
		}
		if (ours === base) {
			// Not edited by hand: take the new version outright.
			fs.writeFileSync(dest, theirs);
			fs.writeFileSync(origPath(targetDir, f), theirs);
			out.updated.push(f);
			continue;
		}
		if (base === theirs) {
			// Edited by hand, package unchanged: nothing to merge.
			out.unchanged.push(f);
			continue;
		}
		const merged = mergeThreeWay(base, ours, theirs, opts.git);
		if (merged.conflicts) {
			// Written beside the untouched copy, never over the playbook: markers in a playbook are
			// text the next run would follow, and a prompt is not a place to keep a file.
			const mergePath = `${origPath(targetDir, f)}.merge`;
			fs.writeFileSync(mergePath, merged.text);
			out.conflicts.push({ file: f, mergePath, basePath: origPath(targetDir, f), packagedPath: path.join(recipe.dir, f) });
			continue;
		}
		fs.writeFileSync(dest, merged.text);
		fs.writeFileSync(origPath(targetDir, f), theirs);
		out.updated.push(f);
	}
	const record = readRecord(targetDir);
	if (record) {
		record.version = VERSION;
		record.files = playbookFiles(recipe.manifest);
		fs.writeFileSync(path.join(targetDir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
	}
	return out;
}

/** `git merge-file -p`: exit status is the number of conflicts, 0 for a clean merge. */
export function mergeThreeWay(base: string, ours: string, theirs: string, git = "git"): { text: string; conflicts: boolean } {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-merge-"));
	try {
		const b = path.join(tmp, "base");
		const o = path.join(tmp, "ours");
		const t = path.join(tmp, "theirs");
		fs.writeFileSync(b, base);
		fs.writeFileSync(o, ours);
		fs.writeFileSync(t, theirs);
		try {
			const text = execFileSync(git, ["merge-file", "-p", "-L", "yours", "-L", "installed", "-L", "packaged", o, b, t], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			return { text, conflicts: false };
		} catch (e) {
			const err = e as { status?: number | null; stdout?: string; message?: string };
			// A positive status is a conflict count and stdout still holds the merged text with markers.
			if (typeof err.status === "number" && err.status > 0 && typeof err.stdout === "string") return { text: err.stdout, conflicts: true };
			throw new Error(`git merge-file failed: ${err.message ?? String(e)}`);
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
