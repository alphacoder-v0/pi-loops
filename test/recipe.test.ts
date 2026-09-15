import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AUTONOMY_LEVELS,
	INSTALL_ROOT,
	MAX_SETUP_SHOWN,
	RECORD_FILE,
	addArgsFor,
	addLineFor,
	ensureExcluded,
	installFiles,
	installedRecipes,
	listRecipes,
	loadRecipe,
	mergeThreeWay,
	neverSection,
	packagedRecipesDir,
	parseAddWords,
	parseManifest,
	planInstall,
	purgeInstall,
	readLevelLine,
	readRecord,
	requireRecipeName,
	resolveRecipeRef,
	setLevelLine,
	updateFiles,
	type Recipe,
} from "../src/recipe.ts";

const GOOD = `
name = "demo"
summary = "A demo recipe."
needs_tracker = false
levels = ["act", "report"]
files = ["TEMPLATE.md"]

[[job]]
name = "demo-watch"
schedule = "*/30 * * * *"
playbook = "watch.md"
timeout = "20m"
verify = true

[[job]]
name = "demo-nightly"
schedule = "0 2 * * *"
playbook = "nightly.md"
`;

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-loops-recipe-"));
}

/** A recipe directory on disk from a manifest and playbook texts. */
function makeRecipe(dir: string, manifest: string, files: Record<string, string>): Recipe {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "recipe.toml"), manifest);
	for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
	return loadRecipe(dir);
}

const PLAYBOOK = "---\nname: demo-watch\ndescription: x\n---\n\n# Watch\n\nLine one.\nLine two.\nLine three.\n";

test("parseManifest: a good manifest, levels sorted lowest first", () => {
	const m = parseManifest(GOOD);
	assert.equal(m.name, "demo");
	assert.deepEqual(m.levels, ["report", "act"]);
	assert.equal(m.needsTracker, false);
	assert.deepEqual(m.files, ["TEMPLATE.md"]);
	assert.equal(m.jobs.length, 2);
	assert.equal(m.jobs[0].timeout, "20m");
	assert.equal(m.jobs[0].verify, true);
});

test("parseManifest: every [[job]] is checked the way /cron add checks it", () => {
	assert.throws(() => parseManifest(GOOD.replace('schedule = "0 2 * * *"', 'schedule = "0 2 30 2 *"')), /demo-nightly.*no next run/);
	assert.throws(() => parseManifest(GOOD.replace('schedule = "0 2 * * *"', 'schedule = "in 10m"')), /must recur/);
	assert.throws(() => parseManifest(GOOD.replace('timeout = "20m"', 'timeout = "soon"')), /demo-watch/);
	assert.throws(() => parseManifest(GOOD.replace('levels = ["act", "report"]', 'levels = ["yolo"]')), /unknown level "yolo"/);
	assert.throws(() => parseManifest(GOOD.replace('playbook = "watch.md"', 'playbook = "../watch.md"')), /inside the recipe directory/);
	assert.throws(() => parseManifest(GOOD.replace('name = "demo-nightly"', 'name = "demo-watch"')), /used twice/);
	assert.throws(() => parseManifest(GOOD.replace('name = "demo"', 'name = "Demo Recipe"')), /lowercase/);
	assert.throws(() => parseManifest("name = 'x'\nsummary = 'y'\nlevels = ['report']\n"), /\[\[job\]\] is required/);
});

test("addLineFor round-trips through parseAddArgs", () => {
	const m = parseManifest(GOOD);
	const line = addLineFor(m.jobs[0], path.join(INSTALL_ROOT, "demo"));
	assert.match(line, /^--stateful --name demo-watch --verify --timeout 20m "\*\/30 \* \* \* \*" Read \.agents\/skills\/demo\/watch\.md and do what it says/);
	const parsed = addArgsFor(m.jobs[0], path.join(INSTALL_ROOT, "demo"));
	assert.equal(parsed.name, "demo-watch");
	assert.equal(parsed.stateful, true);
	assert.equal(parsed.verify, true);
	assert.equal(parsed.timeoutMs, 20 * 60_000);
	assert.equal(parsed.schedule.kind, "cron");
});

test("setLevelLine: after the frontmatter, replaced in place, readable back", () => {
	const withFm = setLevelLine(PLAYBOOK, "propose");
	assert.match(withFm, /^---\n[\s\S]*?---\n\nAutonomy: propose\n# Watch/);
	assert.equal(readLevelLine(withFm), "propose");
	assert.equal(readLevelLine(setLevelLine(withFm, "act")), "act");
	assert.equal(setLevelLine(withFm, "act").split("Autonomy:").length, 2);
	assert.equal(setLevelLine(withFm, "act"), withFm.replace("Autonomy: propose", "Autonomy: act"), "only the level word changes; the blank line after it stays");
	const noFm = setLevelLine("# Plain\n", "report");
	assert.equal(noFm, "Autonomy: report\n\n# Plain\n");
	assert.equal(readLevelLine("nothing here"), undefined);
	for (const l of AUTONOMY_LEVELS) assert.equal(readLevelLine(setLevelLine("x", l)), l);
});

test("install writes the files, the .orig copies, the setup script and the record", () => {
	const t = tmp();
	const recipe = makeRecipe(path.join(t, "recipes", "demo"), GOOD.replace("files = [", 'setup = "labels.sh"\nfiles = ['), { "watch.md": PLAYBOOK, "nightly.md": "# Nightly\n", "TEMPLATE.md": "template\n", "labels.sh": "#!/bin/sh\necho hi\n" });
	const project = path.join(t, "project");
	fs.mkdirSync(project);
	const plan = planInstall(recipe, project, "report");
	assert.deepEqual(plan.files, ["watch.md", "nightly.md", "TEMPLATE.md"]);
	assert.deepEqual(plan.changed, []);
	assert.equal(plan.addLines.length, 2);
	assert.equal(plan.record, undefined);
	const record = installFiles(recipe, project, "report", { overwrite: false, source: "demo" });
	const dir = path.join(project, INSTALL_ROOT, "demo");
	assert.equal(readLevelLine(fs.readFileSync(path.join(dir, "watch.md"), "utf8")), "report");
	assert.equal(fs.readFileSync(path.join(dir, "TEMPLATE.md"), "utf8"), "template\n", "extra files are copied as they are");
	assert.ok(fs.existsSync(path.join(dir, ".orig", "watch.md")));
	assert.ok(fs.existsSync(path.join(dir, "labels.sh")));
	assert.equal(readRecord(dir)?.level, "report");
	assert.equal(record.files.length, 3);
	assert.deepEqual(installedRecipes(project).map((r) => r.recipe), ["demo"]);
	// A second plan sees no changes; an edited file shows up as changed and is not overwritten.
	fs.appendFileSync(path.join(dir, "watch.md"), "my line\n");
	assert.deepEqual(planInstall(recipe, project, "report").changed, ["watch.md"]);
	installFiles(recipe, project, "report", { overwrite: false, source: "demo" });
	assert.match(fs.readFileSync(path.join(dir, "watch.md"), "utf8"), /my line/);
	installFiles(recipe, project, "report", { overwrite: true, source: "demo" });
	assert.doesNotMatch(fs.readFileSync(path.join(dir, "watch.md"), "utf8"), /my line/);
	// Reinstalling at another level is not an edit: no file is "changed", the level line moves.
	assert.deepEqual(planInstall(recipe, project, "act").changed, []);
	installFiles(recipe, project, "act", { overwrite: false, source: "demo" });
	assert.equal(readLevelLine(fs.readFileSync(path.join(dir, "watch.md"), "utf8")), "act");
	// An edited copy keeps its edit and still takes the new level, in the copy and in the base.
	fs.appendFileSync(path.join(dir, "watch.md"), "my line\n");
	installFiles(recipe, project, "propose", { overwrite: false, source: "demo" });
	const kept = fs.readFileSync(path.join(dir, "watch.md"), "utf8");
	assert.match(kept, /my line/);
	assert.equal(readLevelLine(kept), "propose");
	assert.equal(readLevelLine(fs.readFileSync(path.join(dir, ".orig", "watch.md"), "utf8")), "propose");
});

test("ensureExcluded: once per clone, in .git/info/exclude, never in .gitignore", () => {
	const t = tmp();
	const project = path.join(t, "project");
	fs.mkdirSync(project);
	assert.equal(ensureExcluded(project, path.join(INSTALL_ROOT, "demo")), "no-git");
	execFileSync("git", ["init", "-q", project]);
	assert.equal(ensureExcluded(project, path.join(INSTALL_ROOT, "demo")), "added");
	assert.equal(ensureExcluded(project, path.join(INSTALL_ROOT, "demo")), "present");
	const exclude = fs.readFileSync(path.join(project, ".git", "info", "exclude"), "utf8");
	assert.equal(exclude.split("\n").filter((l) => l === "/.agents/skills/demo/").length, 1);
	// A file, not a directory: no trailing slash, and git agrees once it exists.
	assert.equal(ensureExcluded(project, path.join("docs", "agents", "issue-tracker.md"), "file"), "added");
	assert.equal(ensureExcluded(project, path.join("docs", "agents", "issue-tracker.md"), "file"), "present");
	fs.mkdirSync(path.join(project, "docs", "agents"), { recursive: true });
	fs.writeFileSync(path.join(project, "docs", "agents", "issue-tracker.md"), "x");
	assert.doesNotThrow(() => execFileSync("git", ["-C", project, "check-ignore", "-q", "docs/agents/issue-tracker.md"]));
	assert.ok(!fs.existsSync(path.join(project, ".gitignore")));
	// git agrees: the installed directory is ignored.
	fs.mkdirSync(path.join(project, INSTALL_ROOT, "demo"), { recursive: true });
	fs.writeFileSync(path.join(project, INSTALL_ROOT, "demo", "x.md"), "x");
	const ignored = execFileSync("git", ["-C", project, "check-ignore", "-v", ".agents/skills/demo/x.md"], { encoding: "utf8" });
	assert.match(ignored, /\.git\/info\/exclude:\d+:\/\.agents\/skills\/demo\/\t\.agents\/skills\/demo\/x\.md/);
});

test("mergeThreeWay: clean merge and a conflict", () => {
	// Edits on adjacent lines are a conflict to git; keep the clean case's edits apart.
	const base = "a\nb\nc\nd\ne\nf\ng\n";
	const clean = mergeThreeWay(base, "a\nB\nc\nd\ne\nf\ng\n", "a\nb\nc\nd\ne\nF\ng\n");
	assert.equal(clean.conflicts, false);
	assert.equal(clean.text, "a\nB\nc\nd\ne\nF\ng\n");
	const conflict = mergeThreeWay(base, "a\nMINE\nc\nd\ne\nf\ng\n", "a\nTHEIRS\nc\nd\ne\nf\ng\n");
	assert.equal(conflict.conflicts, true);
	assert.match(conflict.text, /<<<<<<< yours[\s\S]*MINE[\s\S]*=======[\s\S]*THEIRS[\s\S]*>>>>>>> packaged/);
});

test("updateFiles: untouched, edited-and-mergeable, conflicting, and hand-installed files", () => {
	const t = tmp();
	const recipeDir = path.join(t, "recipes", "demo");
	const v1 = makeRecipe(recipeDir, GOOD, { "watch.md": PLAYBOOK, "nightly.md": "# Nightly\nold\n", "TEMPLATE.md": "t1\n" });
	const project = path.join(t, "project");
	fs.mkdirSync(project);
	installFiles(v1, project, "propose", { overwrite: false, source: "demo" });
	const dir = path.join(project, INSTALL_ROOT, "demo");
	// The person edits line three of watch.md and rewrites nightly.md entirely; TEMPLATE.md untouched.
	fs.writeFileSync(path.join(dir, "watch.md"), fs.readFileSync(path.join(dir, "watch.md"), "utf8").replace("Line three.", "Line three, mine."));
	fs.writeFileSync(path.join(dir, "nightly.md"), "# Nightly\nMINE\n");
	fs.rmSync(path.join(dir, ".orig", "TEMPLATE.md"));
	// The package moves on: watch.md changes line one, nightly.md changes the same line, TEMPLATE.md changes.
	const v2 = makeRecipe(recipeDir, GOOD, { "watch.md": PLAYBOOK.replace("Line one.", "Line one, v2."), "nightly.md": "# Nightly\nTHEIRS\n", "TEMPLATE.md": "t2\n" });
	const result = updateFiles(v2, project, "propose");
	assert.deepEqual(result.updated, ["watch.md"]);
	assert.deepEqual(result.conflicts.map((c) => c.file), ["nightly.md"]);
	assert.deepEqual(result.noBase, ["TEMPLATE.md"]);
	const merged = fs.readFileSync(path.join(dir, "watch.md"), "utf8");
	assert.match(merged, /Line one, v2\./);
	assert.match(merged, /Line three, mine\./);
	assert.equal(readLevelLine(merged), "propose");
	assert.equal(fs.readFileSync(path.join(dir, "nightly.md"), "utf8"), "# Nightly\nMINE\n", "a conflicting file is not written");
	assert.equal(result.conflicts[0].mergePath, path.join(dir, ".orig", "nightly.md.merge"));
	assert.match(fs.readFileSync(result.conflicts[0].mergePath, "utf8"), /<<<<<<<[\s\S]*MINE[\s\S]*THEIRS/);
	assert.equal(result.conflicts[0].packagedPath, path.join(recipeDir, "nightly.md"));
	assert.equal(fs.readFileSync(path.join(dir, "TEMPLATE.md"), "utf8"), "t1\n", "no base, no touch");
	// Running again with nothing new: everything unchanged except the still-conflicting file.
	const again = updateFiles(v2, project, "propose");
	assert.deepEqual(again.updated, []);
	assert.ok(again.unchanged.includes("watch.md"));
	assert.deepEqual(again.conflicts.map((c) => c.file), ["nightly.md"]);
});

test("resolveRecipeRef: a name looks in the packaged directory, a path is taken as typed", () => {
	const t = tmp();
	makeRecipe(path.join(t, "packaged", "demo"), GOOD, { "watch.md": PLAYBOOK, "nightly.md": "n\n", "TEMPLATE.md": "t\n" });
	assert.equal(resolveRecipeRef("demo", { packaged: path.join(t, "packaged"), cwd: t }).source, "demo");
	assert.throws(() => resolveRecipeRef("nope", { packaged: path.join(t, "packaged"), cwd: t }), /no packaged recipe named "nope" \(have: demo\)/);
	const byPath = resolveRecipeRef("./packaged/demo", { packaged: path.join(t, "empty"), cwd: t });
	assert.equal(byPath.dir, path.join(t, "packaged", "demo"));
	assert.throws(() => resolveRecipeRef("./missing", { packaged: t, cwd: t }), /no recipe\.toml/);
	assert.throws(() => loadRecipe(path.join(t, "nowhere")), /no recipe\.toml/);
});

test("every packaged recipe loads, and its playbooks carry a level line", () => {
	const recipes = listRecipes(packagedRecipesDir());
	assert.ok(recipes.length >= 2, `found ${recipes.length}`);
	for (const r of recipes) {
		for (const j of r.manifest.jobs) {
			const text = fs.readFileSync(path.join(r.dir, j.playbook), "utf8");
			assert.ok(readLevelLine(text), `${r.manifest.name}/${j.playbook} has no "Autonomy:" line`);
			assert.ok(r.manifest.levels.includes(readLevelLine(text)!), `${r.manifest.name}/${j.playbook} carries a level the manifest does not offer`);
			assert.ok(neverSection(text).length, `${r.manifest.name}/${j.playbook} has no "## Never" section for /recipe show to print`);
		}
		assert.ok(r.manifest.usefulWhen.length, `${r.manifest.name} says nothing about when it is useful`);
	}
});

test("parseManifest: tier and useful_when are optional, and a tier is one of two words", () => {
	const plain = parseManifest(GOOD);
	assert.equal(plain.tier, "advanced", "a recipe that does not say is not a starter");
	assert.deepEqual(plain.usefulWhen, []);
	const starter = parseManifest(GOOD.replace('summary = "A demo recipe."', 'summary = "A demo recipe."\ntier = "starter"\nuseful_when = ["You want a demo.", "You have a repo."]'));
	assert.equal(starter.tier, "starter");
	assert.deepEqual(starter.usefulWhen, ["You want a demo.", "You have a repo."]);
	assert.throws(() => parseManifest(GOOD.replace('summary = "A demo recipe."', 'summary = "A demo recipe."\ntier = "beginner"')), /tier must be starter or advanced/);
	assert.throws(() => parseManifest(GOOD.replace('summary = "A demo recipe."', 'summary = "A demo recipe."\nuseful_when = "one string"')), /useful_when must be a list of strings/);
});

test("neverSection: the lines under a heading that starts with Never, up to the next heading", () => {
	assert.deepEqual(neverSection("# T\n\nbody\n\n## Never\n\nNever push.\nNever merge.\n\n## Notes\n\nx\n"), ["Never push.", "Never merge."]);
	assert.deepEqual(neverSection("# T\n\n## Never bump\n\n- react\n"), ["- react"], "a longer heading still counts");
	assert.deepEqual(neverSection("# T\n\nNever in the body is not a section.\n"), []);
	assert.deepEqual(neverSection("## Never\n\nfirst\n\n## Never\n\nsecond\n"), ["first", "second"], "two sections are read in order");
});

test("parseAddWords: the recipe is the first bare word, whatever --level does", () => {
	assert.deepEqual(parseAddWords(["autoresearch"]), { ref: "autoresearch", level: undefined });
	assert.deepEqual(parseAddWords(["autoresearch", "--level", "act"]), { ref: "autoresearch", level: "act" });
	assert.deepEqual(parseAddWords(["--level", "act", "autoresearch"]), { ref: "autoresearch", level: "act" });
	assert.deepEqual(parseAddWords(["--level=report", "./my/recipe"]), { ref: "./my/recipe", level: "report" });
	assert.deepEqual(parseAddWords(["--level"]), { ref: undefined, level: undefined });
	assert.deepEqual(parseAddWords([]), { ref: undefined, level: undefined });
});

test("ensureExcluded in a linked worktree writes where git reads: the common dir", () => {
	const t = tmp();
	const main = path.join(t, "main");
	execFileSync("git", ["init", "-q", main]);
	execFileSync("git", ["-C", main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
	const linked = path.join(t, "linked");
	execFileSync("git", ["-C", main, "worktree", "add", "-q", linked]);
	assert.equal(ensureExcluded(linked, path.join(INSTALL_ROOT, "demo")), "added");
	assert.match(fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8"), /^\/\.agents\/skills\/demo\/$/m);
	fs.mkdirSync(path.join(linked, INSTALL_ROOT, "demo"), { recursive: true });
	fs.writeFileSync(path.join(linked, INSTALL_ROOT, "demo", "x.md"), "x");
	assert.doesNotThrow(() => execFileSync("git", ["-C", linked, "check-ignore", "-q", ".agents/skills/demo/x.md"]), "git in the worktree ignores the installed directory");
});

test("install refuses to write through a symlink, in the directory or a file", () => {
	const t = tmp();
	const recipe = makeRecipe(path.join(t, "recipes", "demo"), GOOD, { "watch.md": PLAYBOOK, "nightly.md": "n\n", "TEMPLATE.md": "t\n" });
	const project = path.join(t, "project");
	const elsewhere = path.join(t, "elsewhere");
	fs.mkdirSync(path.join(project, INSTALL_ROOT), { recursive: true });
	fs.mkdirSync(elsewhere);
	fs.symlinkSync(elsewhere, path.join(project, INSTALL_ROOT, "demo"));
	assert.throws(() => installFiles(recipe, project, "report", { overwrite: false, source: "demo" }), /symbolic link/);
	assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing landed at the link's target");
	fs.unlinkSync(path.join(project, INSTALL_ROOT, "demo"));
	fs.mkdirSync(path.join(project, INSTALL_ROOT, "demo"));
	fs.symlinkSync(path.join(elsewhere, "watch.md"), path.join(project, INSTALL_ROOT, "demo", "watch.md"));
	assert.throws(() => installFiles(recipe, project, "report", { overwrite: true, source: "demo" }), /watch\.md is a symbolic link/);
	assert.throws(() => updateFiles(recipe, project, "report"), /symbolic link/);
});

test("the record is not trusted: a bad name, level, source or file list reads as no record", () => {
	const t = tmp();
	const dir = path.join(t, "d");
	fs.mkdirSync(dir);
	const write = (r: unknown) => fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify(r));
	const good = { recipe: "demo", level: "report", source: "demo", files: ["a.md"], version: "1", installedAt: "now" };
	write(good);
	assert.equal(readRecord(dir)?.recipe, "demo");
	write({ ...good, recipe: "../x" });
	assert.equal(readRecord(dir), undefined);
	write({ ...good, level: "yolo" });
	assert.equal(readRecord(dir), undefined);
	write({ ...good, source: "../../somewhere" });
	assert.equal(readRecord(dir), undefined);
	write({ ...good, source: "/abs/path" });
	assert.equal(readRecord(dir)?.source, "/abs/path");
	write({ ...good, files: ["../escape.md"] });
	assert.equal(readRecord(dir), undefined);
	assert.throws(() => requireRecipeName(".."), /not a recipe name/);
	assert.throws(() => requireRecipeName("a/b"), /not a recipe name/);
	assert.equal(requireRecipeName("issue-loop"), "issue-loop");
});

test("purge takes only what the install wrote, and a setup script in a subdirectory installs", () => {
	const t = tmp();
	fs.mkdirSync(path.join(t, "recipes", "demo", "scripts"), { recursive: true });
	fs.writeFileSync(path.join(t, "recipes", "demo", "scripts", "setup.sh"), "#!/bin/sh\n");
	const reloaded = makeRecipe(path.join(t, "recipes", "demo"), GOOD.replace("files = [", 'setup = "scripts/setup.sh"\nfiles = ['), { "watch.md": PLAYBOOK, "nightly.md": "n\n", "TEMPLATE.md": "t\n" });
	const project = path.join(t, "project");
	fs.mkdirSync(project);
	const record = installFiles(reloaded, project, "report", { overwrite: false, source: "demo" });
	const dir = path.join(project, INSTALL_ROOT, "demo");
	assert.ok(fs.existsSync(path.join(dir, "scripts", "setup.sh")));
	fs.writeFileSync(path.join(dir, "MINE.md"), "a project's own skill file\n");
	purgeInstall(dir, record, "scripts/setup.sh");
	assert.deepEqual(fs.readdirSync(dir).sort(), ["MINE.md"], "only the install's files are gone");
	fs.rmSync(path.join(dir, "MINE.md"));
	purgeInstall(dir, record, "scripts/setup.sh");
	assert.ok(!fs.existsSync(dir), "an emptied directory goes too");
});

test("every packaged setup script fits in the confirmation that shows it whole", () => {
	for (const r of listRecipes(packagedRecipesDir())) {
		if (!r.manifest.setup) continue;
		const size = fs.readFileSync(path.join(r.dir, r.manifest.setup), "utf8").length;
		assert.ok(size <= MAX_SETUP_SHOWN, `${r.manifest.name}/${r.manifest.setup} is ${size} chars; the wizard refuses to run a script it cannot show whole (${MAX_SETUP_SHOWN})`);
	}
});

test("issue-loop's setup script is a no-op on a local Markdown tracker, and without gh", () => {
	const t = tmp();
	const script = path.join(packagedRecipesDir(), "issue-loop", "labels.sh");
	const noGh = { ...process.env, PATH: "/usr/bin:/bin" };
	// The local tracker has no labels to create: the script says so and lets the install go on.
	fs.mkdirSync(path.join(t, "docs", "agents"), { recursive: true });
	fs.copyFileSync(path.join(packagedRecipesDir(), "_tracker", "issue-tracker-local.md"), path.join(t, "docs", "agents", "issue-tracker.md"));
	const local = execFileSync("/bin/sh", [script], { cwd: t, env: noGh, encoding: "utf8" });
	assert.match(local, /no labels to create/);
	// A GitHub tracker without `gh` on the PATH: labels are GitHub's to make, and the first run
	// reports the missing CLI as a finding — the install is not the place to stop.
	fs.copyFileSync(path.join(packagedRecipesDir(), "_tracker", "issue-tracker-github.md"), path.join(t, "docs", "agents", "issue-tracker.md"));
	// A PATH with the tools the script itself needs and no gh on it.
	fs.mkdirSync(path.join(t, "bin"));
	for (const tool of ["grep"]) fs.symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(t, "bin", tool));
	const withoutGh = execFileSync("/bin/sh", [script], { cwd: t, env: { ...noGh, PATH: path.join(t, "bin") }, encoding: "utf8" });
	assert.match(withoutGh, /gh/);
});
