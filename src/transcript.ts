/**
 * Compact, redacted view of a sub-agent session file (pi's JSONL session format),
 * so a loop run can be inspected from the parent session without opening the file:
 * what it was asked, which tools it called, what came back, what it said.
 */
import * as fs from "node:fs";
import { jobTextOf, stripProtocolTags } from "./protocol.ts";
import { previewRedacted } from "./redact.ts";

export interface TranscriptLine {
	kind: "user" | "assistant" | "tool" | "result" | "meta";
	text: string;
}

function describeToolCall(name: string, args: Record<string, unknown>): string {
	const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
	switch (name) {
		case "bash":
			return `$ ${str(args.command)}`;
		case "read":
			return `read ${str(args.path ?? args.file_path)}`;
		case "write":
			return `write ${str(args.path ?? args.file_path)}`;
		case "edit":
			return `edit ${str(args.path ?? args.file_path)}`;
		case "ls":
			return `ls ${str(args.path ?? ".")}`;
		case "find":
			return `find ${str(args.pattern)} in ${str(args.path ?? ".")}`;
		case "grep":
			return `grep /${str(args.pattern)}/ in ${str(args.path ?? ".")}`;
		default:
			return `${name} ${JSON.stringify(args)}`;
	}
}

/** Parse a session JSONL into display lines. Unparseable lines are skipped. Never throws on content. */
export function summarizeSessionFile(file: string, opts: { maxLines?: number; width?: number } = {}): TranscriptLine[] {
	const width = opts.width ?? 160;
	const maxLines = opts.maxLines ?? 80;
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err: any) {
		return [{ kind: "meta", text: `(transcript unavailable: ${err?.message ?? err})` }];
	}
	const lines: TranscriptLine[] = [];
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		if (entry?.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role === "user") {
			const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join(" ") : "";
			// The loop prompt is long and known; show only the job text, which protocol.ts knows how to find.
			const body = jobTextOf(content);
			lines.push({ kind: "user", text: `› ${previewRedacted(body, width)}` });
		} else if (msg.role === "assistant") {
			for (const part of Array.isArray(msg.content) ? msg.content : []) {
				if (part?.type === "text" && part.text?.trim()) {
					const shown = stripProtocolTags(part.text) || part.text;
					lines.push({ kind: "assistant", text: previewRedacted(shown, width * 2) });
				} else if (part?.type === "toolCall") {
					lines.push({ kind: "tool", text: previewRedacted(describeToolCall(part.name, part.arguments ?? {}), width) });
				}
			}
		} else if (msg.role === "toolResult") {
			const out = Array.isArray(msg.content) ? msg.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
			const first = out.split("\n").find((l: string) => l.trim()) ?? "";
			const total = out.split("\n").filter((l: string) => l.trim()).length;
			lines.push({ kind: "result", text: `  ${msg.isError ? "✗" : "→"} ${previewRedacted(first, width)}${total > 1 ? `  (+${total - 1} lines)` : ""}` });
		}
	}
	if (lines.length > maxLines) {
		const dropped = lines.length - maxLines;
		return [{ kind: "meta", text: `(… ${dropped} earlier lines omitted)` }, ...lines.slice(-maxLines)];
	}
	return lines;
}
