/**
 * Secret redaction for anything that reaches a screen, a log or a gist.
 *
 * Loop prompts and sub-agent output routinely carry tokens ("check the API with key sk-…"), and
 * what this project prints is read hours later by whoever opens the inbox or the audit. Every
 * preview goes through here, so a token cannot be echoed back out of a place that outlives the run.
 */
const REDACTORS: Array<[string, RegExp]> = [
	["openai_anthropic_key", /sk-[A-Za-z0-9_-]{20,}/g],
	["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	["github_token", /\bgh[ousp]_[A-Za-z0-9]{30,}\b/g],
	["github_fine_grained", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
	["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
	["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
	["bearer_token", /Bearer\s+[A-Za-z0-9._\-]{16,}/g],
	// Browser login and loopback OAuth callback URLs carry auth state or one-time codes.
	["login_url", /https?:\/\/[^\s]+\/login\?[^\s]+/g],
	["callback_url", /http:\/\/127\.0\.0\.1:[0-9]+\/callback(?:\?[^\s]+)?/g],
	["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
	["url_credentials", /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g],
	["env_assignment", /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*)=(['"]?)[^\s'"]{8,}\2/g],
	// A whole transcript can be uploaded now (`/session-share`), so the net covers the shapes a secret takes
	// in a file rather than only in a prompt: config and JSON pairs, PEM blocks, and the vendors
	// whose keys use `_` where the older patterns expected `-`.
	["stripe_key", /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
	["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
	["keyed_value", /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|credential)[A-Za-z0-9_.-]*)("|')?(\s*[:=]\s*)("|')?(?!\[REDACTED:)([^\s"',]{8,})\4?/gi],
];

export function redact(input: string): string {
	let out = input;
	for (const [label, re] of REDACTORS) {
		re.lastIndex = 0;
		out = out.replace(re, (match, ...groups) => {
			if (label === "url_credentials") return `${groups[0]}[REDACTED:${label}]@`;
			if (label === "env_assignment") return `${groups[0]}=[REDACTED:${label}]`;
			// Keep the name, mask the value: "which key was it" is the useful half of the line.
			if (label === "keyed_value") {
				// The name, its closing quote and the separator are the reader's half of the line; only
				// the value is replaced, so `"api_key": "…"` stays valid JSON and `X=…` stays a shell line.
				const [name, nameQuote, separator, valueQuote] = groups as [string, string | undefined, string, string | undefined];
				const q = valueQuote ?? "";
				return `${name}${nameQuote ?? ""}${separator}${q}[REDACTED:${label}]${q}`;
			}
			return `[REDACTED:${label}]`;
		});
	}
	return out;
}

/**
 * Every character a screen does not draw as itself on one line: the controls (C0, DEL, C1, so a
 * terminal's escape sequences too), the format characters (Unicode Cf: the bidi marks, overrides and
 * isolates that reorder a line, the zero-width and invisible ones) and the line and paragraph
 * separators. Text from somewhere else that carries one can clear a screen, repaint earlier lines,
 * hide part of itself or forge a second row.
 */
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Text someone else wrote, on one line as a screen may show it: each character the screen would not
 * draw as itself (`UNSHOWN`) is a space. An archive is a file someone sent you, and `pi-loops
 * inspect` is the command you run before trusting it; a gate is a command that runs with nobody
 * watching. Neither reaches a screen with such a character intact.
 */
export function plainLine(text: string): string {
	return text.replace(UNSHOWN, " ");
}

/** Redacted and capped, but with the text's own line structure intact: capped, never reflowed. */
export function capRedacted(input: string, maxChars: number): string {
	const chars = Array.from(redact(input));
	return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : chars.join("");
}

/** Redacted, collapsed to one line and capped: for the one-line previews a TUI row shows. */
export function previewRedacted(input: string, maxChars: number): string {
	const chars = Array.from(redact(input).replace(/\s+/g, " ").trim());
	return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : chars.join("");
}

/**
 * A finding's text as a screen may show it: a terminal's escape sequences (colour, clear, title),
 * other control characters, the bidi marks and overrides that reorder a line, and the characters no
 * surface draws are taken out: the zero-width space and invisible operators (U+200B, U+2060-2064,
 * U+FEFF), the soft hyphen, U+034F, the Hangul and Mongolian fillers, the tags U+E0000-E007F and the
 * variation selectors U+FE00-FE0D, which can carry bytes no one sees. What ordinary text needs stays:
 * the joiners U+200C and U+200D (emoji sequences, Persian, Devanagari), U+FE0E and U+FE0F (how an
 * emoji is drawn) and the ideographic variation selectors U+E0100-E01EF. So `/inbox` cannot repaint the terminal it prints in, and every
 * surface, and the claim's prompt, carries the same words.
 */
export function screenText(text: string): string {
	return text
		// Only a terminated string: an introducer with no BEL or ST would otherwise take the rest of
		// the finding with it, and the card would hide what a claim then sends.
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
		.replace(/\u001b[@-_]?/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufe00-\ufe0d\ufeff\uffa0\u{e0000}-\u{e007f}]/gu, "");
}

/**
 * Text as a card shows it: screened, redacted, and on one line with single spaces. A command that
 * this changes is not shown as written, so nobody is asked about it (src/guard.ts).
 */
export function cardText(text: string): string {
	return redact(screenText(text)).replace(/\s+/g, " ");
}
