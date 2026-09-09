/**
 * pie's dangerous-command policy (`crates/agent/src/harness/permission.rs`), ported for runs nobody
 * is watching. pie installs `PermissionPolicy::default_for_coding_agent()` as the parent's
 * `before_tool_call` and clones it into every trigger/loop sub-agent; pi has no built-in denylist,
 * so an unattended loop would otherwise run `rm -rf /` or `git push --force main` unchallenged.
 */
import * as os from "node:os";

/**
 * Regex rules from pie's `default_danger_patterns`, widened where pie's are trivially evaded.
 * They run against a *dequoted* copy of the command (see `dequote`), because `su''do` and
 * `sh""utdown` are the same program to a shell and none of pie's word-boundary rules survive them.
 */
const PATTERNS: Array<[label: string, re: RegExp]> = [
	["sudo invocation", /\b(sudo|doas|pkexec)\b/],
	// pie stops at the first pipe; a command can reach a shell through any number of them.
	["curl/wget piped into a shell", /\b(curl|wget)\b[\s\S]*\|\s*\S*\b(bash|sh|zsh|fish|dash|ksh)\b/],
	["dd writing to a block device", /\bdd\b[^\n]*\bof=\/dev\/(disk|sd[a-z]|nvme|hd[a-z])/],
	["mkfs / format command", /\bmkfs(\.|\s)/],
	// pie requires 777 immediately after chmod, so any flag (-R) walks past it.
	["chmod 777 on an absolute path", /\bchmod\b(\s+-\S+)*\s+0?777\s+\//],
	["shutdown / reboot / halt", /\b(shutdown|reboot|halt|poweroff)\b/],
	// pie matches only `--force`/`-f`; `+main` is the same thing through a refspec.
	["git push --force on main/master", /\bgit\s+push\b[^\n]*(--force|--force-with-lease|\s-f\b|\s\+)[^\n]*\b(main|master)\b/],
	["piping or substituting into eval", /(\|\s*eval\b|\beval\s+["'`]?\$\()/],
	[":(){:|:&};: forkbomb", /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/],
];

/**
 * Remove quoting that changes nothing for the shell but hides a word from a regex: `su''do`,
 * `sh""utdown`, `rm -rf "/"`. Quotes inside an operand still matter to `normalizeOperand`, so the
 * dequoted copy is only used for the pattern scan.
 */
function dequote(command: string): string {
	return command.replace(/''|""/g, "").replace(/\\(?=[a-zA-Z])/g, "");
}

/** Strip one layer of quoting and expand $HOME / ${HOME} / ~ (pie's `normalize_operand`). */
function normalizeOperand(token: string, home: string | undefined): string {
	let t = token.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) t = t.slice(1, -1);
	if (!home) return t;
	t = t.replace(/\$\{HOME\}|\$HOME/g, home);
	if (t === "~") return home;
	if (t.startsWith("~/")) return home + t.slice(1);
	return t;
}

const RECURSIVE = /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const FORCE = /^(-[a-zA-Z]*f[a-zA-Z]*|--force)$/;

/**
 * An `rm` bearing both a recursive and a force flag, aimed at `/`, any absolute path, or $HOME.
 * Every command cluster reachable through `;`, `&&`, `||`, `|` is checked, like pie's predicate.
 */
function rmRecursiveForceOnDangerousTarget(command: string, home: string | undefined): string | undefined {
	for (const cluster of command.split(/;|&&|\|\||\||\n/)) {
		const tokens = cluster.trim().split(/\s+/).filter(Boolean);
		const rmAt = tokens.findIndex((t) => t === "rm" || t.endsWith("/rm"));
		if (rmAt < 0) continue;
		const args = tokens.slice(rmAt + 1);
		let recursive = false;
		let force = false;
		for (const a of args) {
			if (RECURSIVE.test(a)) recursive = true;
			if (FORCE.test(a)) force = true;
		}
		if (!recursive || !force) continue;
		for (const a of args) {
			if (a.startsWith("-")) continue;
			// With no known home the `~`/$HOME rules cannot fire, but `/` and absolute paths still do.
			const target = normalizeOperand(a, home);
			if (target === "/") return "rm recursive+force on /";
			if (home && (target === home || target.startsWith(`${home}/`) || target === "~" || target.startsWith("~/"))) return "rm recursive+force on $HOME or ~";
			if (target.startsWith("/")) return "rm recursive+force on absolute path";
			// `X=/; rm -rf $X` reads as a relative path here, and the guard cannot know what the
			// variable holds. An unattended `rm -r -f` at an unknown target is refused on that basis.
			if (/[$`]/.test(target)) return "rm recursive+force on an unresolved target";
		}
	}
	return undefined;
}

/** The reason this shell command is refused for an unattended run, or undefined when it is fine. */
export function dangerousCommandReason(command: string, home: string = process.env.HOME || os.homedir()): string | undefined {
	if (!command) return undefined;
	const scanned = dequote(command);
	for (const [label, re] of PATTERNS) if (re.test(scanned)) return label;
	return rmRecursiveForceOnDangerousTarget(scanned, home || undefined);
}
