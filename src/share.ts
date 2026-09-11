/**
 * `/share`: this session as a Markdown transcript, uploaded as a GitHub gist through `gh`
 * (pie's `ShareCommand`, commands.rs).
 *
 * pie renders the transcript and shells straight out to `gh gist create`. The rendering here is
 * the same idea, with one difference that matters: everything goes through `redact` first, and the
 * command shows what it is about to upload — how many messages, how many tool results, how many
 * secrets it masked — before anything leaves the machine. A transcript contains every file the
 * agent read and every command it ran; pie's version does not redact at all, and this project
 * redacts everything else it puts on a screen, so the two could not both be right.
 */
import { redact } from "./redact.ts";
import { stamp } from "./schedule.ts";

export interface ShareMessage {
	role?: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
}

export interface RenderedShare {
	markdown: string;
	messages: number;
	toolResults: number;
	/** How many secrets `redact` masked, so the confirmation can say so. */
	redactions: number;
	bytes: number;
}

const REDACTED = /\[REDACTED:[a-z_]+\]/g;

function countRedactions(text: string): number {
	return (text.match(REDACTED) ?? []).length;
}

/** One content block, whatever shape the provider used. */
function blockText(block: any): string {
	if (typeof block === "string") return block;
	if (!block || typeof block !== "object") return "";
	if (block.type === "text") return String(block.text ?? "");
	if (block.type === "thinking") return String(block.thinking ?? "");
	if (block.type === "image") return "`[image]`";
	return "";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join("\n\n");
	return "";
}

/**
 * Render the messages of a session as Markdown. Pure: the caller decides where it goes, which is
 * what makes the redaction counting testable without a session, a model or a network.
 */
export function renderShare(messages: ShareMessage[], meta: { model?: string; sessionId?: string; cwd?: string; when?: Date } = {}): RenderedShare {
	const when = meta.when ?? new Date();
	const out: string[] = ["# Session transcript", ""];
	if (meta.model) out.push(`- Model: \`${meta.model}\``);
	if (meta.sessionId) out.push(`- Session: \`${meta.sessionId}\``);
	out.push(`- Messages: ${messages.length}`, `- Exported: ${stamp(when.getTime())}`, "", "> Redacted by pi-loops before upload. Review it anyway: a transcript carries whatever the agent read.", "");

	let toolResults = 0;
	let i = 0;
	for (const m of messages) {
		const role = m.role ?? "unknown";
		if (role === "user") {
			out.push(`## ${i}. User`, "", contentText(m.content), "");
		} else if (role === "assistant") {
			out.push(`## ${i}. Assistant`, "");
			const blocks = Array.isArray(m.content) ? m.content : [m.content];
			for (const b of blocks as any[]) {
				if (b?.type === "thinking" && b.thinking) {
					out.push("<details><summary>thinking</summary>", "", "```", String(b.thinking), "```", "", "</details>", "");
				} else if (b?.type === "toolCall") {
					out.push(`**tool call** \`${b.name}\``, "", "```json", JSON.stringify(b.arguments ?? {}, null, 2), "```", "");
				} else {
					const text = blockText(b);
					if (text) out.push(text, "");
				}
			}
		} else if (role === "toolResult") {
			toolResults++;
			out.push(`## ${i}. Tool result \`${m.toolName ?? ""}\`${m.isError ? " (error)" : ""}`, "", "```", contentText(m.content), "```", "");
		} else if (role === "custom") {
			out.push(`## ${i}. ${role}`, "", contentText(m.content) || "`(no displayable content)`", "");
		} else {
			continue; // nothing a reader would recognise; skip rather than print a shape
		}
		i++;
	}

	const markdown = redact(out.join("\n"));
	return {
		markdown,
		messages: i,
		toolResults,
		redactions: countRedactions(markdown),
		bytes: Buffer.byteLength(markdown, "utf8"),
	};
}

/**
 * What the confirmation says before anything leaves the machine. The redaction count is reported,
 * but never on its own: a count of zero reads as "nothing sensitive in here", and what it actually
 * means is that no *known shape* matched. The redactor does not know your employer's key format,
 * and a secret wrapped across two lines of tool output is two strings as far as it is concerned.
 */
export function shareSummary(rendered: RenderedShare, opts: { public: boolean }): string[] {
	return [
		`  ${rendered.messages} message(s), ${rendered.toolResults} tool result(s), ${(rendered.bytes / 1024).toFixed(1)} KB`,
		`  ${rendered.redactions} secret(s) masked — the redactor knows common shapes, not every shape`,
		opts.public ? "  visibility: PUBLIC — anyone can find it" : "  visibility: secret gist — unlisted, but anyone with the link can read it",
		"  it contains every file the agent read and every command it ran in this session",
	];
}
