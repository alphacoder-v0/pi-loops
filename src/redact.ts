/**
 * Secret redaction for anything that reaches a screen or a log, ported from pie's
 * bug_report::redact. Loop prompts and sub-agent output routinely contain tokens
 * ("check the API with key sk-…"); previews must never echo them.
 */
const REDACTORS: Array<[string, RegExp]> = [
	["openai_anthropic_key", /sk-[A-Za-z0-9_-]{20,}/g],
	["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	["github_token", /\bgh[ousp]_[A-Za-z0-9]{30,}\b/g],
	["github_fine_grained", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
	["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
	["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
	["bearer_token", /Bearer\s+[A-Za-z0-9._\-]{16,}/g],
	// Browser login and loopback OAuth callback URLs carry auth state or one-time codes (pie).
	["login_url", /https?:\/\/[^\s]+\/login\?[^\s]+/g],
	["callback_url", /http:\/\/127\.0\.0\.1:[0-9]+\/callback(?:\?[^\s]+)?/g],
	["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
	["url_credentials", /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g],
	["env_assignment", /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*)=(['"]?)[^\s'"]{8,}\2/g],
];

export function redact(input: string): string {
	let out = input;
	for (const [label, re] of REDACTORS) {
		re.lastIndex = 0;
		out = out.replace(re, (match, ...groups) => {
			if (label === "url_credentials") return `${groups[0]}[REDACTED:${label}]@`;
			if (label === "env_assignment") return `${groups[0]}=[REDACTED:${label}]`;
			return `[REDACTED:${label}]`;
		});
	}
	return out;
}

/** Redacted, whitespace-collapsed, capped preview for lists and notifications. */
/** Redacted and capped, but with the text's own line structure intact (pie caps, never reflows). */
export function capRedacted(input: string, maxChars: number): string {
	const chars = Array.from(redact(input));
	return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : chars.join("");
}

/** Redacted, collapsed to one line and capped: for the one-line previews a TUI row shows. */
export function previewRedacted(input: string, maxChars: number): string {
	const chars = Array.from(redact(input).replace(/\s+/g, " ").trim());
	return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : chars.join("");
}
