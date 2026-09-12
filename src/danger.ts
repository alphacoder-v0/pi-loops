/**
 * The dangerous-command policy for runs nobody is watching.
 *
 * pi has no built-in denylist — it asks the person at the keyboard instead, which is the right
 * answer while there is one. A scheduled run has nobody to ask, so an unattended loop would
 * otherwise be free to run `rm -rf /` or `git push --force main`. This module is the whole policy
 * as one function; `src/subagent-guard.ts` is what applies it inside every sub-session.
 */
import * as os from "node:os";

/**
 * The patterns, widened where the obvious ones are trivially evaded.
 * They run against a *dequoted* copy of the command (see `dequote`), because `su''do` and
 * `sh""utdown` are the same program to a shell and no word-boundary rule survives them.
 */
const PATTERNS: Array<[label: string, re: RegExp]> = [
	["sudo invocation", /\b(sudo|doas|pkexec)\b/],
	// Stopping at the first pipe is not enough; a command can reach a shell through any number of them.
	["curl/wget piped into a shell", /\b(curl|wget)\b[\s\S]*\|\s*\S*\b(bash|sh|zsh|fish|dash|ksh)\b/],
	["dd writing to a block device", /\bdd\b[^\n]*\bof=\/dev\/(disk|sd[a-z]|nvme|hd[a-z])/],
	["mkfs / format command", /\bmkfs(\.|\s)/],
	// Requiring 777 immediately after chmod misses any flag (-R) walks past it.
	["chmod 777 on an absolute path", /\bchmod\b(\s+-\S+)*\s+0?777\s+\//],
	["shutdown / reboot / halt", /\b(shutdown|reboot|halt|poweroff)\b/],
	// Matching only `--force`/`-f` misses `+main`, which is the same thing through a refspec.
	["git push --force on main/master", /\bgit\s+push\b[^\n]*(--force|--force-with-lease|\s-f\b|\s\+)[^\n]*\b(main|master)\b/],
	["piping or substituting into eval", /(\|\s*eval\b|\beval\s+["'`]?\$\()/],
	[":(){:|:&};: forkbomb", /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/],
];

/** Shell syntax that starts a second command; an allowlist entry must not carry one along. */
const CHAINS = /[;&|\n\r`$(){}<>]/;

/**
 * Does allowlist entry `entry` cover `command`? An entry means that command and nothing else.
 * "Arguments may follow" cannot be made safe: `rm -rf /var/cache/x /` needs no metacharacter at
 * all, and an allowed wrapper (`ssh host`, `docker run`, `timeout 5`) would carry a whole second
 * program as its arguments. The only latitude is a path strictly inside the one the entry ends
 * with, which is narrower than what the entry already permits.
 */
function allows(entry: string, command: string): boolean {
	const a = entry.trim();
	if (!a) return false;
	if (command === a) return true;
	if (!command.startsWith(`${a}/`)) return false;
	const rest = command.slice(a.length);
	// `/var/cache/mybuild/../..` starts inside the allowed path and ends somewhere else; whitespace
	// would mean a second operand rather than a deeper path.
	return !rest.includes("..") && !/\s/.test(rest) && !CHAINS.test(rest);
}

/**
 * Remove quoting that changes nothing for the shell but hides a word from a regex: `su''do`,
 * `sh""utdown`, `rm -rf "/"`. Quotes inside an operand still matter to `normalizeOperand`, so the
 * dequoted copy is only used for the pattern scan.
 */
function dequote(command: string): string {
	return command.replace(/''|""/g, "").replace(/\\(?=[a-zA-Z])/g, "");
}

/** Strip one layer of quoting and expand $HOME / ${HOME} / ~. */
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
 * Every command cluster reachable through `;`, `&&`, `||`, `|` is checked,
 * plus the ones a substitution opens — `echo $(rm -rf /)` runs the `rm` just as surely.
 */
function rmRecursiveForceOnDangerousTarget(command: string, home: string | undefined): string | undefined {
	for (const cluster of command.split(/;|&&|\|\||\||\n|`|\$\(|\)/)) {
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
export function dangerousCommandReason(command: string, home: string = process.env.HOME || os.homedir(), allow: readonly string[] = []): string | undefined {
	if (!command) return undefined;
	// An allowlist entry permits that command and arguments after it — but nothing chained onto it.
	// A bare prefix match would make `allow = ["rm -rf /var/cache/mybuild"]` also mean
	// `rm -rf /var/cache/mybuild; rm -rf /`, handing arbitrary shell to the one actor this gate
	// exists to stop. Deliberately not a regex: this is a list a person writes in a config file,
	// and a wrong regex there fails open.
	const trimmed = command.trim();
	if (allow.some((a) => allows(a, trimmed))) return undefined;
	const scanned = dequote(command);
	for (const [label, re] of PATTERNS) if (re.test(scanned)) return label;
	return rmRecursiveForceOnDangerousTarget(scanned, home || undefined);
}
