/**
 * The dangerous-command policy for runs nobody is watching.
 *
 * pi has no built-in denylist — it asks the person at the keyboard instead, which is the right
 * answer while there is one. A scheduled run has nobody to ask, so an unattended loop would
 * otherwise be free to run `rm -rf /` or `git push --force main`. This module is the whole policy
 * as one function; `judgeCall` in src/guard.ts applies it, inside every sub-session and in a window.
 */
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { notesDirOf } from "./notes.ts";
import { realpathish } from "./paths.ts";

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
 * that runs a program (`gitTakesText`), `gh` not for `codespace` (or its alias `cs`, or a sub-command
 * spelled any other way), and `npm` only as `npm test` or `npm run <name>` with no quote of its own,
 * since npm hands its arguments to a script's shell. Known gap: a gh alias or a gh extension set up
 * before the run (`gh alias set c codespace`) is read as a plain sub-command.
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
 * may be read in its place. Not when the command substitutes anything (a backtick, `$(`, `<(`, `>(`),
 * quoted or not, since the shell runs what that holds; not when it expands `${…}`, whose quotes nest
 * inside a double quote (`"${x:-'"'}"`) as `blankQuotedPhrases` does not read them; not when it redirects output
 * (`>`), which can write a config that runs a program; and only when every sub-command starts with
 * a `TAKES_TEXT` program, with no `VAR=value` before it (`GIT_EXTERNAL_DIFF='…' git diff`).
 */
function quotesAreText(joined: string, blanked: string): boolean {
	if (/`|[$<>]\(|\$\{|>/.test(joined)) return false;
	for (const sub of blanked.split(SUBCOMMANDS)) {
		const words = sub.trim().split(/\s+/).filter(Boolean);
		if (!words.length) continue;
		const name = words[0].split("/").pop() ?? "";
		const next = words[1] ?? "";
		if (!TAKES_TEXT.has(name) || words.some((w) => w.includes("alias"))) return false;
		if (name === "git" && !gitTakesText(words)) return false;
		// `gh` passes every sub-command but one, so a sub-command the shell spells another way (`"cs"`, `c\s`,
		// `$'cs'`, `{cs,}`) is not read: it may be `codespace`. `git` and `npm` pass only the ones they name.
		if (name === "gh" && (next === "codespace" || next === "cs" || !/^[\w-]+$/.test(next))) return false;
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
		// `$$` is the process id: in `$$'…'` the quote is a plain one, which a backslash does not escape.
		if (c === "$" && s[i + 1] === "$") {
			out += "$$";
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
 * Whether a quote of `command` is still open at the end of a line, or at its end (#231). It scans as
 * `blankQuotedPhrases` does: a backslash outside quotes escapes the next character (so a line
 * continuation joins its lines), `'…'` has no escapes, `"…"` and `$'…'` take a backslash escape, and
 * `$$` opens nothing. It does not know `#` comments, so an apostrophe in a comment counts: a comment's
 * quote that pairs with one on the next line is how a stop was hidden. Lines are not joined first: in
 * a comment a backslash does not continue the line, and bash runs the next one. The cost: a quoted string over
 * several lines (a commit message, a heredoc with an apostrophe) is asked about. One pass.
 */
function quoteLeftOpen(s: string): boolean {
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "$" && s[i + 1] === "$") {
			i += 2;
			continue;
		}
		const ansi = c === "$" && s[i + 1] === "'";
		if (c !== "'" && c !== '"' && !ansi) {
			i++;
			continue;
		}
		const open = ansi ? i + 1 : i;
		const q = s[open];
		const escapes = q === '"' || ansi;
		let j = open + 1;
		while (j < s.length && s[j] !== q) {
			if (s[j] === "\n" || s[j] === "\r") return true;
			j += escapes && s[j] === "\\" ? 2 : 1;
		}
		if (j >= s.length) return true;
		i = j + 1;
	}
	return false;
}

/**
 * `command` as the pi-loops rules read it: one line, a quoted phrase given to a program that takes it
 * as text (`quotesAreText`) set aside, and the quotes that are left removed, since the shell joins
 * `"st"op` back into the verb.
 */
function flatCommand(command: string): string {
	const joined = command.replace(/\\\r?\n/g, ""); // a line continuation is one line to the shell
	const blanked = blankQuotedPhrases(joined);
	return dequote(quotesAreText(joined, blanked) ? blanked.replaceAll(BLANKED, " ") : joined).replace(/["']/g, "");
}

/**
 * What follows the first `pi-loops` in each sub-command of `command` that names it anywhere, in a
 * path or a word of another program too: what `stopsPiLoops` reads. Sub-commands are cut at `;`,
 * `&&`, `||`, `|`, `&` and newlines.
 */
function piLoopsInvocations(command: string): string[] {
	const found: string[] = [];
	for (const sub of flatCommand(command).split(SUBCOMMANDS)) {
		const at = sub.search(PI_LOOPS_NAME);
		if (at !== -1) found.push(sub.slice(at));
	}
	return found;
}

/**
 * Whether `command` runs `pi-loops abort|stop|restart`. Fail closed: pi-loops anywhere in a
 * sub-command (cut at `;`, `&&`, `||`, `|`, `&` and newlines) followed by a stop verb counts, so
 * `echo pi-loops stop` and `npm --prefix ~/code/pi-loops stop` are refused too; only another
 * sub-command (`cd ~/code/pi-loops && npm stop`),
 * and a quoted phrase given to a program that takes it as text (`quotesAreText`), are not read as the command. A verb the shell
 * expands (`pi-loops $V`, `$(…)`, a backtick) is refused, since what it expands to is not known here.
 * This catches what an agent types to stop pi-loops; it is not a sandbox. Known gaps: a program name
 * the shell expands (`P=pi-loops; $P stop`), a verb read from input (`echo stop | xargs pi-loops`),
 * an alias or a function defined to run it, and stopping the process another way (`kill`).
 */
function stopsPiLoops(command: string): boolean {
	for (const rest of piLoopsInvocations(command)) {
		if (STOP_AFTER.test(rest)) return true;
		if (expandedVerb(rest.split(/\s+/))) return true;
	}
	return false;
}

/** Shell words before a program that are not one: an assignment, a redirection, a keyword. */
const BEFORE_PROGRAM = /^(?:[A-Za-z_]\w*=.*|\d*[<>].*|&>.*|then|do|else|!|\{|\()$/;
/** The last path segment of pi-loops' program: its name (an npm spec may add `@<version>`), or the bin that loads it. */
const PROGRAM_BASENAME = /^(?:pi-loops(?:@\S*)?|cli-entry\.mjs)$/;
/** Programs that run the program after their own options and arguments. `pnpm` and `npm` count before `exec` (and `pnpm dlx`). */
const WRAPPERS = new Set(["env", "timeout", "nice", "nohup", "exec", "command", "sudo", "doas", "npx", "bunx", "node", "xargs"]);
/** Options of a wrapper that take the next word as their value. */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-C", "-s", "-k", "-n", "-a", "-p", "-I", "-P", "-L", "-d", "-E", "--package", "--signal", "--kill-after", "--chdir", "--user", "--group"]);

/** pi's own program: `pi`, or its npm package by name (`npx @earendil-works/pi-coding-agent`). */
const PI_BASENAME = /^(?:pi|pi-coding-agent(?:@\S*)?)$/;

/** What follows a program in a sub-command, and whether the program is at the head of it, where the shell runs it. */
interface ProgramRun {
	rest: string;
	head: boolean;
}

/**
 * What follows a program in each sub-command of `command` that runs it. A word is the program when
 * `anywhere` names it with no directory before it (`pi-loops`, `$(which pi-loops)`, `echo pi-loops
 * inbox claim x | bash`); or when its last path segment matches `basename` (`~/tools/pi-loops`,
 * `src/cli-entry.mjs`, `/usr/local/bin/pi`) and it is the first word of the sub-command, or the first
 * word after a run of `WRAPPERS` with their options, `NAME=value` words and numbers (`timeout 5
 * ~/tools/pi-loops`, `sudo -u me /opt/pi-loops`, `node ~/code/piz/src/cli-entry.mjs`). A directory
 * that has the name, given to another program (`npm --prefix ~/code/pi-loops start`, `find
 * ~/code/pi-loops -name import`), is not the program. One pass over the words.
 */
function programRuns(command: string, anywhere: RegExp | undefined, basename: RegExp): ProgramRun[] {
	const found: ProgramRun[] = [];
	for (const sub of flatCommand(command).split(SUBCOMMANDS)) {
		const words = [...sub.matchAll(/\S+/g)];
		let head = true; // a program may start at this word
		let wrapped = false; // a wrapper's options and arguments may come before it
		for (let i = 0; i < words.length; i++) {
			const w = words[i][0];
			const at = anywhere ? w.search(anywhere) : -1;
			if (at !== -1 && !w.slice(0, at).includes("/")) {
				found.push({ rest: sub.slice(words[i].index + at), head });
				break;
			}
			if (!head) continue;
			const slash = w.lastIndexOf("/");
			if (basename.test(w.slice(slash + 1))) {
				found.push({ rest: sub.slice(words[i].index + slash + 1), head });
				break;
			}
			const next = words[i + 1]?.[0];
			if (BEFORE_PROGRAM.test(w)) continue;
			if (WRAPPERS.has(w.slice(slash + 1))) wrapped = true;
			else if ((w === "pnpm" && (next === "exec" || next === "dlx")) || (w === "npm" && next === "exec")) {
				wrapped = true;
				i++;
			} else if (wrapped && w.startsWith("-")) {
				if (WRAPPER_VALUE_FLAGS.has(w)) i++;
				// `command -v pi-loops` names the program and runs nothing.
				if ((w === "-v" || w === "-V") && words[i - 1]?.[0] === "command") head = false;
			} else if (!(wrapped && /^\d+(?:\.\d+)?[smhd]?$/.test(w))) head = false;
		}
	}
	return found;
}

/** pi-loops' program, as `answersForPerson` reads it. */
function piLoopsPrograms(command: string): ProgramRun[] {
	return programRuns(command, PI_LOOPS_NAME, PROGRAM_BASENAME);
}

/** A run answering a question, pairing a browser, installing jobs or bringing pi-loops up is a person's call, not a loop's. */
const ANSWERS = "answers for a person";
/**
 * Verbs of pi-loops that answer or change state on their own. `abort`, `stop` and `restart` are
 * `PI_LOOPS_STOP`'s. `open`, `web` and `tui` print a link with a one-use key that signs a browser in
 * to the page, or start a pi of the person's.
 */
const ANSWER_VERBS = new Set(["start", "import", "pair", "open", "web", "tui"]);
/** The first words after pi-loops that print and leave, where any other flag there opens the page (`cliRoute`). */
const NOT_A_LAUNCH = new Set(["--help", "-h", "--version", "-v"]);
/** The flags only a launch takes (`LAUNCH_FLAGS` of src/cli.ts): a launch wherever pi-loops is, the head of a sub-command or not. */
const LAUNCH_FLAG = /^--(?:web|tui|port|host|allow-host|no-open|no-auth|loops-dir)(?:=|$)/;
/** Verbs that answer or change state after a group: `inbox claim`, `recipe add` (the one install verb). */
const ANSWER_SUBVERBS = new Map<string, ReadonlySet<string>>([
	["inbox", new Set(["claim", "dismiss", "cancel", "clear"])],
	["recipe", new Set(["add"])],
]);
/** Where the shell cuts a word for this rule: whitespace, a brace or comma (brace expansion), `$IFS`. */
const ANSWER_WORDS = /\$\{?IFS\}?|[\s{},]+/;

/**
 * Whether a pi-loops of `piLoopsPrograms` runs a verb that answers for a person, changes state or
 * hands out what signs a browser in to the page: `start`, `import`, `pair`, `open`, `web`, `tui`, a
 * launch (pi-loops at the head of a sub-command with nothing after it or a first word that is a flag
 * other than `NOT_A_LAUNCH`, and anywhere with a `LAUNCH_FLAG` first), `status` with `--url` (the
 * page's address with its token), after `inbox` or `recipe` one of its `ANSWER_SUBVERBS`, or a word
 * the shell expands in that verb's place (`pi-loops inbox $V`). Fail closed as `stopsPiLoops` is:
 * the verb anywhere after the program counts, so `pi-loops recipe show start` is refused too. One
 * pass over the words.
 *
 * This stops a model from typing a call that answers for it through the channels known here: this
 * CLI, a pi of the person's (`runsPi`), the loops directory and the control socket's fallback
 * directory (`reachesLoopsDir`). It does not stop a run of the same user that sets out to forge a
 * yes another way, since every file and process of pi-loops is that user's: the person's own
 * sandbox is the boundary for that. Known gaps: a program name the shell expands (`P=pi-loops; $P
 * inbox claim x`), a verb read from input (`echo claim | xargs pi-loops inbox`), an alias or a
 * function defined to run it, a path to the program behind a program that is not in `WRAPPERS`
 * (`flock /tmp/l ~/tools/pi-loops start`, `ssh host ~/tools/pi-loops start`), a launch behind such a
 * program (`script -c pi-loops`), a wrapper option that takes a value this does not know, and a
 * program that is not this CLI and reads the token or talks to the page or the socket by a path it
 * builds.
 */
function answersForPerson(invocations: readonly ProgramRun[]): boolean {
	return invocations.some(({ rest, head }) => {
		const words = rest.split(ANSWER_WORDS).filter(Boolean);
		const first = words[1];
		if (first === undefined ? head : (head && first.startsWith("-") && !NOT_A_LAUNCH.has(first)) || LAUNCH_FLAG.test(first)) return true;
		if (words.includes("status") && words.some((w) => /^--url\b/.test(w))) return true;
		let after: ReadonlySet<string> = new Set(); // the verbs an `inbox` or `recipe` read so far opens
		for (let i = 0; i < words.length; i++) {
			const w = words[i];
			if (ANSWER_VERBS.has(w) || after.has(w)) return true;
			const verbs = ANSWER_SUBVERBS.get(w);
			if (!verbs) continue;
			after = new Set([...after, ...verbs]);
			let k = i + 1;
			while (k < words.length && words[k].startsWith("-")) k++;
			if (/^[$`]/.test(words[k] ?? "")) return true;
		}
		return false;
	});
}

/** What `pi` may be asked and still print and leave, with nothing else on its line. */
const PI_PRINTS_ONLY = new Set(["--version", "-v", "--help", "-h"]);

/**
 * Whether `command` runs pi itself (`PI_BASENAME`, by any path, behind `WRAPPERS`) with anything but
 * `PI_PRINTS_ONLY`. A pi started from a run is a session of the person's: it loads pi-loops, so its
 * `/inbox claim`, `/inbox dismiss` and `/pi-loops web` are the person's, whether they come as an
 * argument, on stdin or over `--mode rpc`; and its own model's tools are not judged by this policy.
 * So every such pi is refused, not only one whose words name a command. Known gaps: pi started by
 * its script's path (`node …/pi-coding-agent/dist/cli.js`), and a name the shell expands.
 */
function runsPi(command: string): boolean {
	return programRuns(command, undefined, PI_BASENAME).some(({ rest }) => {
		const words = rest.split(/\s+/).filter(Boolean).slice(1);
		return !(words.length > 0 && words.every((w) => PI_PRINTS_ONLY.has(w)));
	});
}

/**
 * Why a run may not reach the loops directory: a yes in its inbox lets a dangerous call through, the
 * page's token there answers as the page, and only a person may do either.
 */
export const OWN_FILES = "reads or writes pi-loops' own files";

/** Why a command with a quote left open at the end of a line is asked about (`quoteLeftOpen`): the rules above cannot read it with confidence. */
export const UNREADABLE = "a quote is left open at the end of a line, so the command cannot be read";

/** Why a write of a git setting that runs a program, or of a git setup file, is asked about or refused (#172). */
export const GIT_SETUP = "changes a git setting or hook that can run a program";

/**
 * The git settings that run a program (design 8.3, #172), as patterns of the key in lower case: the
 * design's list, and the settings of the same kind git documents (`sequence.editor`, `core.askPass`,
 * `core.gitProxy`, `core.alternateRefsCommand`, `init.templateDir`, a remote's
 * `uploadpack`/`receivepack`, `uploadpack.packObjectsHook`, `interactive.diffFilter`, a merge or diff
 * tool's `cmd`, `sendemail.sendmailCmd`, `credential.<url>.helper`, `gpg.<format>.program`,
 * `gpg.ssh.defaultKeyCommand`). An `alias.*` and a `submodule.*.update` run one only when the value
 * starts with `!`; `core.fsmonitor` does not when it is a boolean (the built-in monitor).
 */
const GIT_RUNS_PROGRAM: readonly RegExp[] = [
	/^diff\.external$/,
	/^diff\..+\.(?:textconv|command)$/,
	/^merge\..+\.driver$/,
	/^filter\..+\.(?:clean|smudge|process)$/,
	/^core\.(?:pager|editor|sshcommand|fsmonitor|hookspath|askpass|gitproxy|alternaterefscommand)$/,
	/^pager\..+$/,
	/^sequence\.editor$/,
	/^credential\.(?:.+\.)?helper$/,
	/^gpg\.(?:.+\.)?program$/,
	/^gpg\.ssh\.defaultkeycommand$/,
	/^include\.path$/,
	/^includeif\..+\.path$/,
	/^init\.templatedir$/,
	/^remote\..+\.(?:uploadpack|receivepack)$/,
	/^uploadpack\.packobjectshook$/,
	/^interactive\.difffilter$/,
	/^(?:merge|diff)tool\..+\.cmd$/,
	/^sendemail\.sendmailcmd$/,
];
const GIT_RUNS_WITH_BANG = /^(?:alias\..+|submodule\..+\.update)$/;
const GIT_BOOLEAN = /^(?:true|false|yes|no|on|off|1|0)$/;

/**
 * Whether the git setting `key` with `value` runs a program (`GIT_RUNS_PROGRAM`). A value not known
 * (`undefined`) is taken as one that does, and so is one with a space before its `!` (git does not run
 * that one: fail closed).
 */
export function gitSettingRunsProgram(key: string, value: string | undefined): boolean {
	const k = key.toLowerCase();
	const v = value?.trim();
	if (GIT_RUNS_WITH_BANG.test(k)) return v === undefined || v.startsWith("!");
	if (k === "core.fsmonitor" && v !== undefined && GIT_BOOLEAN.test(v.toLowerCase())) return false;
	return GIT_RUNS_PROGRAM.some((re) => re.test(k));
}

/** Whether a shell word runs git: `git` or a path to it, after a `$(`, a `(`, a backtick, a `{` or an assignment. */
function isGitWord(w: string): boolean {
	return (w.replace(/^.*[=(`{]/, "").split("/").pop() ?? "") === "git";
}

/**
 * A shell word that runs one of git's dashed programs (`/usr/lib/git-core/git-config`), read as the two
 * words git would run: the word with `git-<sub>` cut to `git`, and `<sub>`. What comes before it stays
 * (`X=git-log` becomes `X=git` and `log`), so an assignment is still skipped as one. Any other word is itself.
 */
function gitWords(w: string): string[] {
	const dashed = /^git-([a-z][\w-]*)$/.exec(w.replace(/^.*[=(`{]/, "").split("/").pop() ?? "");
	return dashed ? [w.replace(/git-[a-z][\w-]*$/, "git"), dashed[1]] : [w];
}

/**
 * The options this policy understands, each a set of exact words, with the ones that take the next
 * word as their value apart. git takes any unique prefix of a long option (`--templ` for
 * `--template`) and a short option's value in the same word (`-ccore.pager=x`), so a list of what to
 * refuse could not be complete: an option not in these sets is taken as one that may write (#172).
 */
const GIT_GLOBAL_FLAGS = new Set(["--no-pager", "-p", "--paginate", "-P", "--bare", "--no-replace-objects", "--no-lazy-fetch", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-advice", "--exec-path", "--html-path", "--man-path", "--info-path"]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source", "--exec-path"]);
const GIT_CONFIG_FLAGS = new Set(["--global", "--system", "--local", "--worktree", "--add", "--replace-all", "--all", "--bool", "--int", "--bool-or-int", "--path", "--expiry-date", "--no-type", "--null", "-z", "--name-only", "--show-origin", "--show-scope", "--includes", "--no-includes", "--fixed-value"]);
const GIT_CONFIG_WITH_VALUE = new Set(["-f", "--file", "--blob", "--type", "-t", "--default", "--comment", "--value"]);
const GIT_START_FLAGS = new Set(["-q", "--quiet", "-v", "--verbose", "--progress", "--no-progress", "-n", "--no-checkout", "--bare", "--mirror", "-l", "--local", "--no-local", "--no-hardlinks", "-s", "--shared", "--dissociate", "--single-branch", "--no-single-branch", "--tags", "--no-tags", "--recurse-submodules", "--recursive", "--shallow-submodules", "--no-shallow-submodules", "--remote-submodules", "--no-remote-submodules", "--sparse", "--reject-shallow", "--no-reject-shallow", "--also-filter-submodules"]);
const GIT_START_WITH_VALUE = new Set(["-b", "--branch", "--initial-branch", "-o", "--origin", "--depth", "--shallow-since", "--shallow-exclude", "--reference", "--reference-if-able", "-j", "--jobs", "--filter", "--separate-git-dir", "--bundle-uri", "--server-option", "--object-format", "--ref-format", "--revision"]);
/** `git config` options and sub-commands that only read, or remove a key (`get`/`list`/`unset` are git 2.46's). */
const GIT_CONFIG_READS = /^(?:--get(?:-all|-regexp|-urlmatch|-color|-colorbool)?|-l|--list|--unset(?:-all)?|--remove-section|get|list|get-color|get-colorbool|unset|remove-section)$/;
/** git sub-commands that read, or write only the index or the repository's objects, when no option has them write a file (`GIT_WRITES_FILE`). */
const GIT_READS = new Set(["add", "status", "log", "diff", "show", "commit", "rm", "ls-files", "blame", "grep", "check-attr", "check-ignore", "rev-parse"]);
/** Options that have a `GIT_READS` sub-command write a file it names: these and any prefix git would take for them. */
const GIT_WRITES_FILE = /^(?:--p(?:r(?:e(?:f(?:ix?)?)?)?)?|--o(?:u(?:t(?:p(?:ut?)?)?)?)?|-o)(?:=|$)/;

/** How an option word reads against a set of flags and a set of options with a value: known (and whether it takes the next word), or not known. */
function optionOf(w: string, flags: ReadonlySet<string>, withValue: ReadonlySet<string>): "flag" | "value" | "attached" | "unknown" {
	if (flags.has(w)) return "flag";
	if (withValue.has(w)) return "value";
	const eq = w.indexOf("=");
	if (eq > 0 && (withValue.has(w.slice(0, eq)) || flags.has(w.slice(0, eq)))) return "attached";
	return "unknown";
}

/**
 * Reads one `git` call at `words[at]`, up to the next git word, so a long run of git calls stays
 * linear. `writes`: it writes a setting that runs a program (`git config` in any scope, `git clone -c`
 * or `--config`), opens the config in an editor, renames a section, starts a repository from a
 * template (which copies its hooks), or has an option this policy does not know before what it is
 * judged on (fail closed). `reads`: it is a `GIT_READS` sub-command with no `GIT_WRITES_FILE` option,
 * so a git setup path it names is only read or staged.
 */
function readGitCall(words: string[], at: number): { writes: boolean; reads: boolean } {
	let end = at + 1;
	while (end < words.length && !isGitWord(words[end])) end++;
	let i = at + 1;
	for (; i < end && words[i].startsWith("-"); i++) {
		const kind = optionOf(words[i], GIT_GLOBAL_FLAGS, GIT_GLOBAL_WITH_VALUE);
		if (kind === "value") i++;
		// `-cKEY=VALUE`, a one-command setting, is a known form; anything else could take the next word.
		else if (kind === "unknown" && !/^-c./.test(words[i])) return { writes: words.slice(i + 1, end).some((w) => w === "config" || w === "init" || w === "clone"), reads: false };
	}
	const sub = words[i] ?? "";
	const rest = words.slice(i + 1, end);
	if (sub === "init" || sub === "clone") {
		for (let j = 0; j < rest.length; j++) {
			const w = rest[j];
			if (!w.startsWith("-")) continue;
			const pair = w === "-c" || w === "--config" ? rest[++j] : w.startsWith("--config=") ? w.slice(9) : /^-c./.test(w) ? w.slice(2) : undefined;
			if (pair !== undefined) {
				const eq = pair.indexOf("=");
				if (gitSettingRunsProgram(eq === -1 ? pair : pair.slice(0, eq), eq === -1 ? undefined : pair.slice(eq + 1))) return { writes: true, reads: false };
				continue;
			}
			const kind = optionOf(w, GIT_START_FLAGS, GIT_START_WITH_VALUE);
			if (kind === "unknown") return { writes: true, reads: false }; // `--template`, `--upload-pack`, any prefix of them
			if (kind === "value") j++;
		}
		return { writes: false, reads: false };
	}
	if (sub !== "config") return { writes: false, reads: GIT_READS.has(sub) && !rest.some((w) => GIT_WRITES_FILE.test(w)) };
	const positional: string[] = [];
	for (let j = 0; j < rest.length; j++) {
		const w = rest[j];
		if (w === "edit" || w === "rename-section") return { writes: true, reads: false };
		if (GIT_CONFIG_READS.test(w)) return { writes: false, reads: true };
		if (!w.startsWith("-")) {
			positional.push(w);
			continue;
		}
		const kind = optionOf(w, GIT_CONFIG_FLAGS, GIT_CONFIG_WITH_VALUE);
		if (kind === "unknown") return { writes: true, reads: false }; // `-e`, `--edit`, `--rename-section`, any prefix git takes
		if (kind === "value") j++;
	}
	if (positional[0] === "set") positional.shift();
	const [key] = positional;
	// The value is not read from these words: the shell may cut it at a `;` or substitute into it, so
	// `core.fsmonitor 'true;sh x'` is not the boolean it starts with. A value is judged only as git stores it.
	return { writes: key !== undefined && gitSettingRunsProgram(key, GIT_RUNS_WITH_BANG.test(key.toLowerCase()) ? positional[1] : undefined), reads: false };
}

/** A path of a git setup: a `.git` directory or anything in one, a `.gitattributes`, a `.gitconfig`, or git's directory under `.config`; any letter case. */
const GIT_SETUP_PATH = /(?<![\w.-])(?:\.git|\.gitattributes|\.gitconfig|\.config\/git)(?![\w.-])/i;
/** Programs that read the paths they are given, or only name them. `git` is judged by `readGitCall`. */
const GIT_SETUP_READERS = new Set(["cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "ls", "stat", "wc", "file", "test", "[", "diff", "cmp", "cd", "echo", "printf"]);

/**
 * Whether a shell command writes a git setting that runs a program, opens git's config in an editor,
 * starts a repository from a template, or names a git setup file (`GIT_SETUP_PATH`) with a redirect, a
 * substitution or a subshell, a first program that is not a reader, or a git call that is not `reads`
 * (#172). Read as the pi-loops rules
 * read a command (`flatCommand`), so a quoted message given to a program that takes it as text is not
 * read. Known gaps: a path the shell builds at run time or reaches after a `cd`, a program that writes
 * the file from a name it is handed another way, and a setting given for one command (git's global
 * `-c`, `GIT_*` variables), which runs a program the way the run could run it itself. The read of a
 * repository's setup before an unattended git call (`src/repo-setup.ts`) sees a setting or a hook
 * however it was written.
 */
function writesGitSetup(command: string): boolean {
	for (const sub of flatCommand(command).split(SUBCOMMANDS)) {
		const words = sub.trim().split(/\s+/).filter(Boolean).flatMap(gitWords);
		let gitReads = true;
		let sawGit = false;
		for (let i = 0; i < words.length; i++) {
			if (!isGitWord(words[i])) continue;
			sawGit = true;
			const call = readGitCall(words, i);
			if (call.writes) return true;
			if (!call.reads) gitReads = false;
		}
		if (!GIT_SETUP_PATH.test(sub)) continue;
		// A substitution or a subshell runs a program this does not place: fail closed.
		if (/[`(]/.test(sub)) return true;
		if (/>/.test(sub) && [...sub.matchAll(/>+\|?\s*([^\s;&|<>]+)/g)].some((m) => GIT_SETUP_PATH.test(m[1]))) return true;
		const program = (words.find((w) => !BEFORE_PROGRAM.test(w)) ?? "").split("/").pop() ?? "";
		if (!gitReads || !(GIT_SETUP_READERS.has(program) || (sawGit && program === "git"))) return true;
	}
	return false;
}

/**
 * The reason a `write` or an `edit` of a git setup file is refused for an unattended run, or undefined
 * (#172): a path in a `.git` directory, a `.gitattributes`, a `.gitconfig`, or under `.config/git`,
 * read as `pathToolReason` reads a path, by its resolved path and by its realpath (a link that leads to a
 * hook). A card cannot show what the write puts there, so it is refused, not asked (as for the loops
 * directory). Reading one is not refused.
 */
export function gitSetupPathReason(call: { toolName: string; input?: unknown }, cwd: string | undefined): string | undefined {
	if (call.toolName !== "write" && call.toolName !== "edit") return undefined;
	const given = (call.input as { path?: unknown } | undefined)?.path;
	if (typeof given !== "string" || !given) return undefined;
	let p = given.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	else if (/^file:\/\//.test(p)) {
		try {
			p = fileURLToPath(p);
		} catch {
			return GIT_SETUP; // a URL that pi's tool reads in a way this cannot: fail closed
		}
	}
	const resolved = path.resolve(cwd ?? "/", p);
	if (resolved.length > PATH_MAX) return undefined;
	const setup = (q: string) => GIT_SETUP_PATH.test(q.split(path.sep).join("/"));
	return setup(resolved) || setup(realpathish(resolved)) ? GIT_SETUP : undefined;
}

/** Whether the default file systems of `platform` ignore letter case (APFS, NTFS). */
function foldsCase(platform: NodeJS.Platform): boolean {
	return platform === "darwin" || platform === "win32";
}

/** `text` with every character a regular expression reads as syntax escaped. */
function literal(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `dir`, and `dir` under each of `homes` as `~/…`, `$HOME/…` and `${HOME}/…`. */
function spelt(dir: string, homes: ReadonlySet<string>): string[] {
	const out = [dir];
	for (const h of homes) {
		const rel = path.relative(h, dir);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
		for (const home of ["~", "$HOME", "${HOME}"]) out.push(`${home}/${rel}`);
	}
	return out;
}

/**
 * The ways a shell command can name the loops directory (`named`): its path, its realpath,
 * `~/.pi/agent/loops` (pi-loops' directory when nobody moved it), each of those under home
 * (`spelt`), `$PI_LOOPS_DIR` and `$PI_CODING_AGENT_DIR/loops`; and the control socket's fallback
 * directory, `pi-loops-<uid>` in the temporary directory, which takes the socket when the loops
 * directory's path is too long for one (src/host-control-channel.ts `hostSocketPath`): the socket
 * hands out a one-use key and a pairing code. And the directories that hold the loops directory
 * (`parents`): the same for the directory above each, and `$PI_CODING_AGENT_DIR`.
 */
function loopsDirSpellings(loopsDir: string, home: string | undefined): { named: string[]; parents: string[] } {
	const dirs = new Set([path.resolve(loopsDir), realpathish(loopsDir)]);
	const homes = home ? new Set([path.resolve(home), realpathish(home)]) : new Set<string>();
	for (const h of homes) dirs.add(path.join(h, ".pi", "agent", "loops"));
	const named = new Set(["$PI_LOOPS_DIR", "${PI_LOOPS_DIR}", "$PI_CODING_AGENT_DIR/loops", "${PI_CODING_AGENT_DIR}/loops"]);
	const parents = new Set(["$PI_CODING_AGENT_DIR", "${PI_CODING_AGENT_DIR}"]);
	for (const dir of dirs) {
		for (const s of spelt(dir, homes)) named.add(s);
		const parent = path.dirname(dir);
		if (parent !== path.dirname(parent)) for (const s of spelt(parent, homes)) parents.add(s);
	}
	const socketDir = `pi-loops-${process.getuid?.() ?? "u"}`;
	for (const tmp of new Set([os.tmpdir(), realpathish(os.tmpdir()), "/tmp", "$TMPDIR", "${TMPDIR}"])) named.add(`${tmp}/${socketDir}`);
	return { named: [...named], parents: [...parents] };
}

/** What `inertQuotes` puts in place of a `~` or a `$` the shell does not expand. */
const INERT = "\u0002";

/**
 * `s` with each `~` in quotes, and each `$` in single quotes or `$'…'`, replaced by `INERT`: the shell
 * expands neither. Quotes are read as `blankQuotedPhrases` reads them (`$$` opens nothing, `$'…'` takes a
 * backslash escape), so a path after them is not taken for quoted text. One pass.
 */
function inertQuotes(s: string): string {
	let out = "";
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		if (c === "\\") {
			out += s.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === "$" && s[i + 1] === "$") {
			out += "$$";
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
		out += s.slice(i, open + 1) + s.slice(open + 1, j).replace(q === "'" ? /[~$]/g : /~/g, INERT) + q;
		i = j + 1;
	}
	return out;
}

/**
 * `command` as `reachesLoopsDir` reads it: dequoted, quotes removed. When every quoted text is
 * text (`quotesAreText`), a `~` in quotes and a `$` in single quotes are made inert first, since the
 * shell expands neither: `grep -rn '~/.pi/agent/loops' docs` names no directory. When a quote may be
 * run (`bash -c '…'`), all of it counts.
 */
function pathText(command: string): string {
	const joined = command.replace(/\\\r?\n/g, "");
	const text = quotesAreText(joined, blankQuotedPhrases(joined)) ? inertQuotes(joined) : joined;
	// `$'…'` and `$"…"` are quotes: their `$` goes with them, or a path in them reads as `$/…`.
	return dequote(text.replace(/\$(?=['"])/g, "")).replace(/["']/g, "");
}

/** A run of characters that a shell word may hold, with no command separator in it. */
const PATH_RUN = /[^\s;&|<>()`]+/g;

/**
 * Whether the command (`pathText`) reaches the loops directory, a read too:
 *   - it names the directory in a spelling of `loopsDirSpellings` as a whole path component at its
 *     end (`/x/loops-old` is not `/x/loops`), after `.`, `..` and `//` in each path are normalised;
 *   - or it names a directory that holds it followed by a glob, a brace or `..`
 *     (`~/.pi/agent/loo*`, `~/.pi/agent/{loops,x}`, `~/.pi/agent/../agent/loops`).
 * On `darwin` and `win32` letter case is ignored, as their file systems do. Reading is not exempted:
 * a loop rarely reads pi-loops' own files, and a read cannot be told from a write reliably. This is a
 * guard, not a sandbox. Known gaps: a path the shell builds at run time (`D=~/.pi; cat
 * $D/agent/loops/x`, `cd ~/.pi/agent && cat loops/x`), a glob above the directory that holds it
 * (`~/.pi/*\/loops`), a `..` that climbs out of `~` or `$HOME`, a symlink to the directory made
 * elsewhere or earlier, and an interpreter or program that reaches the file from a name it is handed
 * another way.
 */
function reachesLoopsDir(text: string, loopsDir: string, home: string | undefined, platform: NodeJS.Platform): boolean {
	const { named, parents } = loopsDirSpellings(loopsDir, home);
	const flags = foldsCase(platform) ? "i" : "";
	const before = "(?<![\\w.~$-])";
	const seg = "[^\\s/;&|<>()`]";
	const names = new RegExp(`${before}(?:${named.map(literal).join("|")})(?![\\w.-])`, flags);
	const near = new RegExp(`${before}(?:${parents.map(literal).join("|")})(?:[*?[{]|/${seg}*[*?[{]|/\\.\\.(?!${seg}))`, flags);
	const normalised = text.replace(PATH_RUN, (run) => (/(?:^|\/)\.\.?(?:\/|$)|\/\//.test(run) ? path.posix.normalize(run) : run));
	return names.test(normalised) || near.test(text);
}

/** pi's built-in tools that read or write by a `path` input. */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
/** The ones whose `path` may be left out: the run's cwd, as pi's tools take it. */
const PATH_DEFAULTS_TO_CWD = new Set(["grep", "find", "ls"]);
/** The spaces pi's tools turn into a plain space in a path (pi's `normalizePath`). */
const UNICODE_SPACES = /[  -   　]/g;

/** Whether `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The longest path a file system takes (PATH_MAX on Linux; macOS and Windows take less). */
const PATH_MAX = 4096;

/**
 * The reason a call of a path tool (`PATH_TOOLS`) is refused for an unattended run, or undefined:
 * `OWN_FILES` when its path is the loops directory or inside it, or for `grep`, which reads every
 * file below its path, a directory that holds it. The path is read as pi's tools read it (pi's
 * spaces made plain, a leading `@` dropped, `~` and a `file://` URL expanded), resolved against
 * `cwd`, then through every symlink above it (`realpathish`), and compared with the loops
 * directory's realpath, ignoring letter case on `darwin` and `win32`. A `file://` URL that cannot be
 * read here is refused. This is a guard, not a sandbox. Known gaps: a symlink made after the call is
 * judged, a relative path of a call that comes with no cwd, a variant of the name that pi's `read`
 * tries when the file is not there (decomposed letters, a curly apostrophe), and a tool of an
 * extension or an MCP server that reads or writes by a path: only pi's built-in tools are judged.
 *
 * `ownJob` is the id of the loop whose run makes the call: a path inside its notes directory
 * (`<loops dir>/state/<id>/`, src/notes.ts `notesDirOf`) by realpath is not refused. The index
 * `state/<id>.md` is not inside it. A link inside it is judged where it leads, and a notes directory
 * that a link puts somewhere else gets no exception.
 */
export function pathToolReason(call: { toolName: string; input?: unknown }, cwd: string | undefined, loopsDir: string, platform: NodeJS.Platform = process.platform, ownJob?: string): string | undefined {
	if (!PATH_TOOLS.has(call.toolName)) return undefined;
	const given = (call.input as { path?: unknown } | undefined)?.path;
	let p = typeof given === "string" && given ? given : PATH_DEFAULTS_TO_CWD.has(call.toolName) ? "." : undefined;
	if (p === undefined) return undefined;
	p = p.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	else if (/^file:\/\//.test(p)) {
		try {
			p = fileURLToPath(p);
		} catch {
			return OWN_FILES; // a URL that pi's tool reads in a way this cannot: fail closed
		}
	}
	if (!path.isAbsolute(p) && cwd === undefined) return undefined;
	const fold = foldsCase(platform) ? (s: string) => s.toLowerCase() : (s: string) => s;
	const resolved = cwd === undefined ? path.resolve(p) : path.resolve(cwd, p);
	// A path longer than any file system takes is refused by the system before it is opened
	// (ENAMETOOLONG), and resolving it level by level costs time that grows with its square.
	if (resolved.length > PATH_MAX) return undefined;
	const real = realpathish(resolved);
	const target = fold(real);
	const root = fold(realpathish(loopsDir));
	if (ownJob !== undefined) {
		// The exception is compared without folding letter case: on a volume that tells `cron-AAAA` from
		// `cron-aaaa`, folding would let one loop into another's notes. A path written in another case
		// on a volume that ignores it is not the exception, and is refused below (fail closed).
		const notes = realpathish(notesDirOf(loopsDir, ownJob));
		// Only where the loops directory says it is: a link at `state` or at `state/<id>` could make it any directory.
		if (notes === path.join(realpathish(loopsDir), "state", ownJob) && within(real, notes)) return undefined;
	}
	return within(target, root) || (call.toolName === "grep" && within(root, target)) ? OWN_FILES : undefined;
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

/**
 * The reason this shell command is refused for an unattended run, or undefined when it is fine.
 * `loopsDir` is the loops directory of the process that runs it: with one, a command that reaches
 * it is refused (`reachesLoopsDir`, letter case ignored on a `platform` whose file systems do);
 * without one, that rule is off.
 */
export function dangerousCommandReason(command: string, home: string = process.env.HOME || os.homedir(), allow: readonly string[] = [], loopsDir?: string, platform: NodeJS.Platform = process.platform): string | undefined {
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
	if (answersForPerson(piLoopsPrograms(command)) || runsPi(command)) return ANSWERS;
	if (loopsDir !== undefined && reachesLoopsDir(pathText(command), loopsDir, home || undefined, platform)) return OWN_FILES;
	if (writesGitSetup(command)) return GIT_SETUP;
	return rmRecursiveForceOnDangerousTarget(scanned, home || undefined) ?? (quoteLeftOpen(command) ? UNREADABLE : undefined);
}
