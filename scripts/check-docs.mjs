/**
 * Check the claims the documents make about *this project's own identity* against `package.json`.
 *
 * 0.17.0 shipped with the first instruction in both READMEs unable to work: the install block led
 * with `pi install npm:@alphacoder-v0/pi-loops` because the package was about to be published, the
 * publish did not happen, and the tag was cut green because nothing in `npm run ci` reads a README.
 * A reader following line one got a 404. The same class has bitten twice more, smaller: the pinned
 * tag in those blocks is maintained by hand in two files and has to move in lockstep with
 * `version`, and the host/owner/repo is typed out by hand in several documents while
 * `repository.url` already declares it.
 *
 * What the three have in common is that the document asserts something checkable and nothing
 * checked it. So:
 *
 *   install-route  a document may only advertise an install route this project actually offers.
 *                  `npm:` is gated on `piLoops.publishedToNpm` in `package.json` — the one place
 *                  that fact lives, because nothing offline can go and ask npm.
 *   pinned-tag     a tag pinned in a command matches `version` (`git:…@v0.17.1` ⇔ `0.17.1`);
 *                  an npm spec's version matches it the way npm spells a release, without the `v`.
 *   repository     the host/owner/repo and the package name in a command match `repository.url`
 *                  and `name`.
 *
 * **Instruction, not description.** Only lines inside a fenced block are read — that is the text a
 * reader copies. Prose is left alone, and deliberately: `docs/cli.md` explains where pi puts a
 * `pi install npm:` package versus a `pi install git:` one, which is a true statement about pi's
 * own layout, and `CHANGELOG.md` is a record of what the install line used to be. Neither is
 * telling anyone to run anything. A generic placeholder — `@<tag>`, `@<version>` — is not a claim
 * either, and is how the changelog and prose name a version without naming one.
 *
 * File set: every Markdown file tracked by git. Not a list to maintain, nowhere for the same
 * mistake to hide, and no exemption for `CHANGELOG.md` — it names old versions freely and passes
 * because it states them in prose, which is the same rule that protects `docs/cli.md`.
 *
 * No dependency, no network: two files read and some string comparisons. `npm run check:docs`.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/* ---------------------------------------------------------------- what package.json declares */

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/** `git+https://github.com/alphacoder-v0/pi-loops.git` → `github.com/alphacoder-v0/pi-loops`. */
function repoPath(url) {
	const m = /(?:^|@|\/\/)([^/@\s]+\.[a-z]{2,})[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(String(url ?? ""));
	return m ? { host: m[1], owner: m[2], repo: m[3], full: `${m[1]}/${m[2]}/${m[3]}` } : undefined;
}

const repo = repoPath(pkg.repository?.url);
if (!repo) {
	console.error(`package.json: repository.url is ${JSON.stringify(pkg.repository?.url)}, which is not a host/owner/repo URL this check can read`);
	process.exit(1);
}
const version = pkg.version;
const name = pkg.name;
const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;
const bare = name.slice(name.indexOf("/") + 1);

/**
 * Is this published to npm? Nothing offline can find out, so it is declared, once, here — and
 * flipping it is the whole of the change on the day the publish happens.
 */
const publishedToNpm = pkg.piLoops?.publishedToNpm;
if (typeof publishedToNpm !== "boolean") {
	console.error(
		`package.json: piLoops.publishedToNpm is ${JSON.stringify(publishedToNpm)}, expected true or false — it is what says whether \`pi install npm:\` is a route a document may offer a reader`,
	);
	process.exit(1);
}
/**
 * Which routes a document may tell someone to use. `git:` is always one of them — the repository is
 * public and the tags are cut there. A local path and `pi -e` claim nothing about this project's
 * identity, so they are not gated at all.
 */
const routeOffered = { git: true, npm: publishedToNpm };
/** Why a route is not on offer, in the words the person reading the failure needs. */
const routeRefusal = {
	npm: `package.json says piLoops.publishedToNpm is false, so nothing is on npm and this command answers 404. Write \`git:${repo.full}@v${version}\` instead, or — on the day the publish actually happens — set piLoops.publishedToNpm to true`,
};

/* ---------------------------------------------------------------- the files */

let files;
try {
	// Filter in here rather than with a pathspec: a glob on the command line is the shell's to expand
	// before git ever sees it, and `**/*.md` through `sh` quietly means `*/*.md` — one level, so a
	// document one directory deeper (`skills/pi-loops/SKILL.md`) was never read.
	files = execSync("git ls-files -z", { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter((f) => f.endsWith(".md"))
		.sort();
} catch (e) {
	console.error(`could not list the tracked Markdown files (git ls-files failed: ${e.message})`);
	process.exit(1);
}

/* ---------------------------------------------------------------- rules */

const problems = [];
let claims = 0;
let installs = 0;

function report(file, line, column, rule, message) {
	problems.push({ file, line, column, rule, message });
}

/** A placeholder is the author declining to name a version, which is not a claim about one. */
const isPlaceholder = (s) => /[<>]|\.\.\.|…|^TAG$|^VERSION$/.test(s);

/** `@alphacoder-v0/pi-loops@0.17.1` → name and version; a leading `@` is the scope, not a separator. */
function splitAtVersion(spec) {
	const at = spec.lastIndexOf("@");
	return at > 0 ? { head: spec.slice(0, at), tail: spec.slice(at + 1) } : { head: spec, tail: undefined };
}

/** `pi install npm:…` / `pi install git:…`, and the same two for `pi remove`. */
const INSTALL_RE = /\bpi\s+(?:install|remove|update)\s+(npm|git):([^\s`'",]+)/g;
/** A host/owner/repo written out somewhere other than an install spec — a `cd` into pi's git root. */
const REPO_REF_RE = /([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)/g;
/** A scoped package name written out somewhere other than an install spec — an npm layout path. */
const PKG_REF_RE = /@[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*/g;

/** The tag a `git:` ref must carry, and the version an `npm:` spec must carry. */
function checkPin(file, lineNo, column, rule, read, expected, what) {
	claims++;
	if (read === expected) return;
	report(file, lineNo, column, rule, `${what} ${read}, expected ${expected} (package.json says version is ${version})`);
}

function checkLine(file, lineNo, text) {
	/** Ranges an install spec already accounts for, so one wrong string is reported once. */
	const consumed = [];
	const inConsumed = (i) => consumed.some(([a, b]) => i >= a && i < b);

	for (const m of text.matchAll(INSTALL_RE)) {
		const [all, route, spec] = m;
		const column = m.index + 1;
		consumed.push([m.index, m.index + all.length]);

		installs++;
		claims++;
		if (!routeOffered[route]) {
			report(
				file,
				lineNo,
				column,
				"install-route",
				`this line tells a reader to install from ${route} (\`${route}:${spec}\`), a route this project does not offer: ${routeRefusal[route] ?? "it is not in the offered set"}`,
			);
			continue;
		}

		if (route === "npm") {
			const { head, tail } = splitAtVersion(spec);
			claims++;
			if (head !== name) report(file, lineNo, column, "repository", `install command names the package ${head}, expected ${name} (package.json name)`);
			if (tail !== undefined && !isPlaceholder(tail)) checkPin(file, lineNo, column, "pinned-tag", tail, version, "npm spec pins version");
		} else {
			const { head, tail } = splitAtVersion(spec);
			claims++;
			if (head !== repo.full)
				report(file, lineNo, column, "repository", `install command names the repository ${head}, expected ${repo.full} (package.json repository.url)`);
			if (tail !== undefined && !isPlaceholder(tail)) checkPin(file, lineNo, column, "pinned-tag", tail, `v${version}`, "install command pins tag");
		}
	}

	for (const m of text.matchAll(REPO_REF_RE)) {
		if (inConsumed(m.index)) continue;
		const [all, host, owner, name3] = m;
		// Only a reference to *this* repository is a claim: one of the three parts has to land, or it
		// is somebody else's URL and none of our business.
		if (host !== repo.host && owner !== repo.owner && name3 !== repo.repo) continue;
		claims++;
		if (all !== repo.full) report(file, lineNo, m.index + 1, "repository", `names the repository ${all}, expected ${repo.full} (package.json repository.url)`);
		// `…/owner/repo@v0.17.1` written by hand outside an install command pins a tag just the same.
		const after = text.slice(m.index + all.length);
		const pin = /^@([^\s`'",]+)/.exec(after);
		if (pin && !isPlaceholder(pin[1])) checkPin(file, lineNo, m.index + 1, "pinned-tag", pin[1], `v${version}`, "pinned tag");
	}

	if (scope) {
		for (const m of text.matchAll(PKG_REF_RE)) {
			if (inConsumed(m.index)) continue;
			const [all] = m;
			const [refScope, refBare] = [all.slice(0, all.indexOf("/")), all.slice(all.indexOf("/") + 1)];
			if (refScope !== scope && refBare !== bare) continue;
			claims++;
			if (all !== name) report(file, lineNo, m.index + 1, "repository", `names the package ${all}, expected ${name} (package.json name)`);
		}
	}
}

/* ---------------------------------------------------------------- the scan */

for (const file of files) {
	const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		if (/^\s*(```+|~~~+)/.test(text)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) checkLine(file, i + 1, text);
	}
}

// A check with nothing to check is not a check. If the install blocks moved, or were reworded past
// what this recognises, that is the failure — not a green run over zero claims.
if (!installs) {
	console.error(
		`check:docs: read ${files.length} Markdown file(s) and found no install command in any fenced block. Either the install instructions are gone or this check no longer recognises them; both need a person.`,
	);
	process.exit(1);
}

/* ---------------------------------------------------------------- output */

if (!problems.length) {
	console.log(`check:docs: ${files.length} file(s), ${claims} claim(s) about ${name}@${version}, no problems`);
	process.exit(0);
}
for (const p of problems) console.error(`${p.file}:${p.line}:${p.column}  ${p.rule}  ${p.message}`);
console.error(`\ncheck:docs: ${problems.length} problem(s) in ${new Set(problems.map((p) => p.file)).size} file(s)`);
process.exit(1);
