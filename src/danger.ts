/**
 * The dangerous-command policy for runs nobody is watching.
 *
 * pi has no built-in denylist — it asks the person at the keyboard instead, which is the right
 * answer while there is one. A scheduled run has nobody to ask, so an unattended loop would
 * otherwise be free to run `rm -rf /` or `git push --force main`. This module is the whole policy
 * as one function; `src/subagent-guard.ts` is what applies it inside every sub-session.
 */
import * as os from "node:os";

const SHELL_WORD = /\b(bash|sh|zsh|fish|dash|ksh)\b/;

/**
 * `/\b(curl|wget)\b[\s\S]*\|\s*\S*\b(bash|sh|zsh|fish|dash|ksh)\b/`, in one pass: that regex
 * backtracks over every `|` for every curl, and 200 KB of `curl |` took ten seconds. After the first
 * curl or wget, a `|` reaches a shell named later in its own run of non-space characters, or in the
 * next run when the `|` ends its run.
 */
function curlIntoShell(command: string): boolean {
	const at = command.search(/\b(curl|wget)\b/);
	if (at === -1) return false;
	let pipeEnded = false;
	for (const [run] of command.slice(at).matchAll(/\S+/g)) {
		const from = pipeEnded ? 0 : run.indexOf("|") + 1;
		if ((pipeEnded || from > 0) && SHELL_WORD.test(run.slice(from))) return true;
		pipeEnded = run.endsWith("|");
	}
	return false;
}

/** Whether `re` (global) matches in `text` at or after `from`, reading the characters before `from` for `\b`. */
function matchesFrom(re: RegExp, text: string, from: number): RegExpExecArray | null {
	re.lastIndex = from;
	return re.exec(text);
}

/**
 * `/\bdd\b[^\n]*\bof=\/dev\/(disk|sd[a-z]|nvme|hd[a-z])/`, in one pass: per line, the first `dd`
 * and then the target after it, where the regex tried every `dd` against the rest of the line.
 */
function ddToBlockDevice(command: string): boolean {
	return command.split("\n").some((line) => {
		const dd = /\bdd\b/g.exec(line);
		return !!dd && !!matchesFrom(/\bof=\/dev\/(disk|sd[a-z]|nvme|hd[a-z])/g, line, dd.index + 2);
	});
}

/**
 * `/\bchmod\b(\s+-\S+)*\s+0?777\s+\//`, in one pass over the words: a word ending in `chmod`, any
 * words that are flags, then `777` or `0777`, then a word that starts with `/`.
 */
function chmod777Absolute(command: string): boolean {
	const words = command.split(/\s+/);
	let afterChmod = false; // a chmod word, then only flags since
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (afterChmod && /^0?777$/.test(w) && i + 1 < words.length && words[i + 1].startsWith("/")) return true;
		afterChmod = (afterChmod && /^-\S/.test(w)) || /\bchmod$/.test(w);
	}
	return false;
}

/**
 * `/\bgit\s+push\b[^\n]*(--force|--force-with-lease|\s-f\b|\s\+)[^\n]*\b(main|master)\b/`, in one
 * pass: for the first `git push` that ends on each line (its `\s+` may cross lines), the first force
 * after it on that line (`\s-f` may start at the newline), then a branch on the line the force ends.
 * Each search also stops at a newline, so no line is read twice.
 */
function forcePushMain(command: string): boolean {
	const push = /\bgit\s+push\b/g;
	let tried = -1; // where the line of the last push tried ends
	for (let p = push.exec(command); p; p = push.exec(command)) {
		const from = p.index + p[0].length;
		if (from <= tried) continue; // a push before it on this line reached at least as far
		tried = command.indexOf("\n", from) === -1 ? command.length : command.indexOf("\n", from);
		const force = matchesFrom(/--force|--force-with-lease|\s-f\b|\s\+|\n/g, command, from);
		if (!force || force[0] === "\n") continue;
		const branch = matchesFrom(/\b(main|master)\b|\n/g, command, force.index + force[0].length);
		if (branch && branch[0] !== "\n") return true;
	}
	return false;
}

/**
 * The patterns, widened where the obvious ones are trivially evaded.
 * They run against a *dequoted* copy of the command (see `dequote`), because `su''do` and
 * `sh""utdown` are the same program to a shell and no word-boundary rule survives them.
 */
const PATTERNS: Array<[label: string, re: RegExp | ((scanned: string, command: string) => boolean)]> = [
	["sudo invocation", /\b(sudo|doas|pkexec)\b/],
	// Stopping at the first pipe is not enough; a command can reach a shell through any number of them.
	["curl/wget piped into a shell", curlIntoShell],
	["dd writing to a block device", ddToBlockDevice],
	["mkfs / format command", /\bmkfs(\.|\s)/],
	// Requiring 777 immediately after chmod misses any flag (-R) walks past it.
	["chmod 777 on an absolute path", chmod777Absolute],
	["shutdown / reboot / halt", powersOff],
	// Matching only `--force`/`-f` misses `+main`, which is the same thing through a refspec.
	["git push --force on main/master", forcePushMain],
	["piping or substituting into eval", /(\|\s*eval\b|\beval\s+["'`]?\$\()/],
	[":(){:|:&};: forkbomb", /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/],
];

const POWER_OFF = /\b(shutdown|reboot|halt|poweroff)\b/;
/** The only programs a search may start a command with. None of them runs a program or writes a file, whatever its arguments, but for `SEARCH_RUNS`. */
const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg", "cat", "wc", "head", "tail", "cut", "tr", "cd", "ls"]);
/** The options that make `rg` run a program it is handed: `--pre` (not `--pretty`) and `--hostname-bin`. */
const SEARCH_RUNS = /--pre(?![a-z])|--hostname-bin/;
/** Shell syntax a search does not need: grouping, a function, an expansion, a redirection, an escape, a second line. */
const NOT_A_SEARCH = /[(){}`$<>\\\n\r]/;

/**
 * Whether `shutdown`, `reboot`, `halt` or `poweroff` is in a place where the shell may run it. Fail
 * closed: the word is refused wherever it appears, since a parse for the command position misses a
 * wrapper (`timeout 5 reboot`, `xargs reboot`, `ssh host reboot`, `sh -c reboot`). The one exception
 * is a search (`isSearch`), such as `grep -rn shutdown src/ | wc -l`.
 * Known gap, as before this exception: a word the shell builds (`re"boot"`).
 */
function powersOff(scanned: string, command: string): boolean {
	return POWER_OFF.test(scanned) && !isSearch(command);
}

/**
 * Whether `command` is one line of `SEARCH_PROGRAMS` commands joined by `|`, `&&`, `||` or `;`, and
 * nothing else. It shares no helper with the other rules, so that this argument is the whole of it:
 *
 * 1. Without the words `2>/dev/null` and `2>&1`, the command has no character of `NOT_A_SEARCH`. So
 *    the shell substitutes nothing, groups nothing, defines no function, writes no file, and a quote
 *    is `'…'` or `"…"` with a body that is only text.
 * 2. Each quote is closed and its body is set aside. Only `|`, `&&`, `||` and `;` are left to start a
 *    command, and a `&` that is left is refused.
 * 3. The first word of each command, cut at a space or a tab as the shell cuts it, is the bare name
 *    of a `SEARCH_PROGRAMS` program: no path, no `VAR=` before it, no quote in it. Every other word
 *    is an argument to that program, and no option in `SEARCH_RUNS` is among them, quoted or not.
 *
 * A text after `#` is read as a command here and as a comment by the shell, which only refuses more.
 * A glob can become an option only through a file that has the name of the option (`--pre`), and a
 * run that can make that file can make a script and run it with no exception at all.
 */
function isSearch(command: string): boolean {
	const line = command.replace(/(^|[ \t])2>(\/dev\/null|&1)(?=[ \t]|$)/g, " ");
	if (NOT_A_SEARCH.test(line) || SEARCH_RUNS.test(line.replace(/["']/g, ""))) return false;
	let bare = ""; // the line with one quote character in place of each quoted string
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c !== "'" && c !== '"') {
			bare += c;
			continue;
		}
		const close = line.indexOf(c, i + 1);
		if (close === -1) return false;
		bare += c;
		i = close;
	}
	return bare.split(/&&|\|\||[|;]/).every((sub) => !sub.includes("&") && SEARCH_PROGRAMS.has(sub.replace(/^[ \t]+/, "").split(/[ \t]/)[0]));
}

/** A run stopping other runs, or every loop on the machine, is a person's call, not a loop's. */
const PI_LOOPS_STOP = "pi-loops abort / stop / restart";
/**
 * The program, by name: `pi-loops` anywhere in the word (a path, `$(which pi-loops)`, an npm
 * package spec, an option's value such as `-O'pi-loops stop'`), or the bin that loads it.
 */
const PI_LOOPS_NAME = /(?:pi-loops|cli-entry\.mjs)\b/;
/**
 * A stop verb after the program: separated by whitespace, a brace or comma (brace expansion), a
 * quote, or `$IFS`, which the shell turns into whitespace. Tested on what follows the first
 * `PI_LOOPS_NAME` only, so the search stays linear in the length of the command.
 */
const STOP_AFTER = /(?:[\s{,"']|\$\{?IFS\}?)(?:host\s+)?["']?(abort|stop|restart)\b/;
/** Where one command ends and the next starts, for this policy: a newline, `;`, `&&`, `||`, `|`, `&`. */
const SUBCOMMANDS = /;|&&|\|\||\||&|\n/;
/**
 * Programs whose quoted arguments are text (a message, a pattern, a path), not a command they run.
 * Quoted text is read as text only when every sub-command starts with one of them; anything else
 * (`ssh`, `python3 -c`, `$SHELL -c`, `env -S`, `tmux new`) may run what it is given, and a list of
 * those could never be complete. `git` counts only with a sub-command in `GIT_TEXT` and no option
 * that runs a program (`gitTakesText`), `gh` not for `codespace`, and `npm` only as `npm test` or
 * `npm run <name>` with no quote of its own, since npm hands its arguments to a script's shell.
 */
const TAKES_TEXT = new Set(["git", "grep", "egrep", "fgrep", "rg", "ag", "echo", "printf", "gh", "cat", "cd", "ls", "test", "[", "true", "false", "jq", "npm"]);
const GIT_TEXT = new Set(["commit", "tag", "stash", "notes", "add", "status", "fetch", "log"]);
/** git options that run a program they are handed: `--upload-pack`, `--receive-pack`, `--exec`. */
const GIT_RUNS = /^--(upload-pack|receive-pack|exec)/;
/** `git log` options that show a patch, which runs the diff drivers git is configured with. */
const GIT_LOG_PATCH = /^(-[a-zA-Z]*[puc]|--(patch|ext-diff|textconv|cc|output|function-context))/;
/** What `blankQuotedPhrases` leaves where a quoted phrase was. */
const BLANKED = "\u0001";

/** Whether a `git` sub-command takes its quoted text as text: past `-C <dir>`, `--git-dir` and `--work-tree`, a `GIT_TEXT` sub-command with no option that runs a program, and `log` without a patch. */
function gitTakesText(words: string[]): boolean {
	let i = 1;
	while (i < words.length) {
		if (words[i] === "-C" || words[i] === "--git-dir" || words[i] === "--work-tree") i += 2;
		else if (/^--(git-dir|work-tree)=/.test(words[i])) i++;
		else break;
	}
	const sub = words[i] ?? "";
	const rest = words.slice(i + 1);
	if (!GIT_TEXT.has(sub) || rest.some((w) => GIT_RUNS.test(w))) return false;
	return sub !== "log" || !rest.some((w) => GIT_LOG_PATCH.test(w));
}

/**
 * Whether the quoted text of `joined` is only text, so `blanked` (its copy from `blankQuotedPhrases`)
 * may be read in its place. Not when the command substitutes anything (a backtick, `$(`, `<(`, `>(`,
 * `${ `, `${|`), quoted or not, since the shell runs what that holds; not when it redirects output
 * (`>`), which can write a config that runs a program; and only when every sub-command starts with
 * a `TAKES_TEXT` program, with no `VAR=value` before it (`GIT_EXTERNAL_DIFF='…' git diff`).
 */
function quotesAreText(joined: string, blanked: string): boolean {
	if (/`|[$<>]\(|\$\{[\s|]|>/.test(joined)) return false;
	for (const sub of blanked.split(SUBCOMMANDS)) {
		const words = sub.trim().split(/\s+/).filter(Boolean);
		if (!words.length) continue;
		const name = words[0].split("/").pop() ?? "";
		const next = words[1] ?? "";
		if (!TAKES_TEXT.has(name) || words.some((w) => w.includes("alias"))) return false;
		if (name === "git" && !gitTakesText(words)) return false;
		if (name === "gh" && next === "codespace") return false;
		if (name === "npm" && !((next === "test" || (next === "run" && words.length > 2)) && !/["'\u0001]/.test(sub))) return false;
	}
	return true;
}

/**
 * Blank every quoted string (`'…'`, `"…"`, `$'…'`) that holds whitespace, so a message that
 * mentions pi-loops (`git commit -m "pi-loops: stop retrying"`) is not read as the command. A quoted
 * single word stays, since the shell joins `"st"op` back into the verb. A quoted string across lines
 * stays, and so does a double-quoted string that substitutes a command (`$(…)` or a backtick), since
 * the shell runs it. A blanked phrase becomes `BLANKED`, so a sub-command can tell it held one. A
 * backslash outside quotes escapes the next character. An unterminated quote leaves the rest as
 * written. One pass.
 */
function blankQuotedPhrases(s: string): string {
	let out = "";
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		if (c === "\\") {
			out += s.slice(i, i + 2);
			i += 2;
			continue;
		}
		const ansi = c === "$" && s[i + 1] === "'";
		if (c !== "'" && c !== '"' && !ansi) {
			out += c;
			i++;
			continue;
		}
		const open = ansi ? i + 1 : i;
		const q = s[open];
		let j = open + 1;
		if (q === "'" && !ansi) j = s.indexOf("'", j);
		else {
			while (j < s.length && s[j] !== q) j += s[j] === "\\" ? 2 : 1;
			if (j >= s.length) j = -1;
		}
		if (j === -1) return out + s.slice(i);
		const body = s.slice(open + 1, j);
		const substitutes = q === '"' && /`|\$\(/.test(body);
		out += /\s/.test(body) && !/[\n\r]/.test(body) && !substitutes ? BLANKED : s.slice(i, j + 1);
		i = j + 1;
	}
	return out;
}

/**
 * Whether `command` runs `pi-loops abort|stop|restart`. Fail closed: pi-loops anywhere in a
 * sub-command (cut at `;`, `&&`, `||`, `|`, `&` and newlines) followed by a stop verb counts, so
 * `echo pi-loops stop` is refused too; only another sub-command (`cd ~/code/pi-loops && npm stop`),
 * and a quoted phrase given to a program that takes it as text (`quotesAreText`), are not read as the command. A verb the shell
 * expands (`pi-loops $V`, `$(…)`, a backtick) is refused, since what it expands to is not known here.
 * This catches what an agent types to stop pi-loops; it is not a sandbox. Known gaps: a program name
 * the shell expands (`P=pi-loops; $P stop`), a verb read from input (`echo stop | xargs pi-loops`),
 * an alias or a function defined to run it, and stopping the process another way (`kill`).
 */
function stopsPiLoops(command: string): boolean {
	const joined = command.replace(/\\\r?\n/g, ""); // a line continuation is one line to the shell
	const blanked = blankQuotedPhrases(joined);
	const flat = dequote(quotesAreText(joined, blanked) ? blanked.replaceAll(BLANKED, " ") : joined).replace(/["']/g, "");
	for (const sub of flat.split(SUBCOMMANDS)) {
		const at = sub.search(PI_LOOPS_NAME);
		if (at === -1) continue;
		const rest = sub.slice(at);
		if (STOP_AFTER.test(rest)) return true;
		if (expandedVerb(rest.split(/\s+/))) return true;
	}
	return false;
}

/** Whether a pi-loops in these words takes a verb the shell expands: the first word after its flags (and `host`) starts with `$` or a backtick. */
function expandedVerb(words: string[]): boolean {
	for (let i = 0; i < words.length; i++) {
		if (!PI_LOOPS_NAME.test(words[i])) continue;
		let k = i + 1;
		while (k < words.length && words[k].startsWith("-")) k++;
		if (words[k] === "host") k++;
		if (/^[$`]/.test(words[k] ?? "")) return true;
		i = Math.max(i, k - 1); // a pi-loops among the flags skipped has the same verb: each word is read once
	}
	return false;
}

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
 * `sh""utdown`, `r''m -rf /`.
 *
 * The dequoted copy is what both halves of the policy see — the pattern scan and the `rm` walk — and
 * that is deliberate. It removes only empty quote pairs and backslashes before letters, neither of
 * which a shell would have kept, so `rm` is still found under `r""m` and `$HOME` under `\\$HOME`.
 * The quoting that decides an operand is still there for `normalizeOperand` to strip: `rm -rf "/"`
 * arrives here unchanged and is refused for the target it names. Where the two copies could differ
 * at all (`rm -rf "''/"`, a directory literally called `''`) the dequoted one refuses and the
 * original allows — and in an unattended run, refusing is the direction to be wrong in.
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
	for (const [label, re] of PATTERNS) if (typeof re === "function" ? re(scanned, command) : re.test(scanned)) return label;
	if (stopsPiLoops(command)) return PI_LOOPS_STOP;
	return rmRecursiveForceOnDangerousTarget(scanned, home || undefined);
}
