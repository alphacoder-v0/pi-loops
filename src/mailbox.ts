/**
 * Promotions decided in one process for a session another process holds. The holder drains them
 * into its conversation. Delivery is at least once; the `[Trigger <id>]` prefix already in the
 * conversation is what makes a second delivery a no-op.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionFileName } from "./lease.ts";
import { withFileLockSync, writeFileAtomic } from "./lock.ts";

export interface Delivery {
	id: string;
	kind: "message" | "turn";
	text: string;
	cwd: string;
	ruleIds: string[];
	createdAt: string;
}

export function conversationHas(entries: readonly unknown[], id: string): boolean {
	const prefix = `[Trigger ${id}] `;
	const textOf = (content: unknown): string | undefined => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return undefined;
		const first = content.find((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text");
		return first && typeof (first as { text?: unknown }).text === "string" ? (first as { text: string }).text : undefined;
	};
	return entries.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const value = entry as { type?: unknown; message?: { role?: unknown; content?: unknown }; content?: unknown };
		if (value.type === "message" && value.message?.role === "user") return textOf(value.message.content)?.startsWith(prefix) ?? false;
		if (value.type === "custom_message") return textOf(value.content)?.startsWith(prefix) ?? false;
		return false;
	});
}

export class Mailbox {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	file(sessionId: string): string {
		return path.join(this.dir, "deliveries", `${sessionFileName(sessionId)}.jsonl`);
	}

	enqueue(sessionId: string, d: Delivery): void {
		const file = this.file(sessionId);
		withFileLockSync(path.join(this.dir, "deliveries.lock"), () => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${JSON.stringify(d)}\n`, "utf8");
		});
	}

	pending(sessionId: string): Delivery[] {
		let data: string;
		try {
			data = fs.readFileSync(this.file(sessionId), "utf8");
		} catch {
			return []; // A missing mailbox has no pending deliveries.
		}
		const out: Delivery[] = [];
		for (const line of data.split("\n")) {
			if (!line) continue;
			try {
				out.push(JSON.parse(line) as Delivery);
			} catch {
				// A crash during append can leave one torn JSONL line; retain other deliveries.
			}
		}
		return out;
	}

	drain(sessionId: string, opts: { holds: () => boolean; alreadyDelivered: (id: string) => boolean; deliver: (d: Delivery) => void }): { delivered: string[]; skipped: string[] } {
		const result = { delivered: [] as string[], skipped: [] as string[] };
		if (!opts.holds()) return result;
		for (const delivery of this.pending(sessionId)) {
			if (opts.alreadyDelivered(delivery.id)) {
				result.skipped.push(delivery.id);
				continue;
			}
			try {
				opts.deliver(delivery);
				result.delivered.push(delivery.id);
			} catch {
				// The chat refused it (pi shutting down): this entry and the ones after it wait for the next drain, in order.
				break;
			}
		}
		const removed = new Set([...result.delivered, ...result.skipped]);
		const file = this.file(sessionId);
		withFileLockSync(path.join(this.dir, "deliveries.lock"), () => {
			const remaining = this.pending(sessionId).filter((delivery) => !removed.has(delivery.id));
			if (remaining.length) writeFileAtomic(file, `${remaining.map((delivery) => JSON.stringify(delivery)).join("\n")}\n`);
			else fs.rmSync(file, { force: true });
		});
		return result;
	}
}

export type PromotionRoute = { to: "chat" } | { to: "mailbox"; sessionId: string } | { to: "inbox"; sessionId: string };

/**
 * Where a rule's promotion goes: into the conversation that created the rule, wherever that is open.
 * `forSession` undefined (a rule made from a shell, or rules of several sessions at once) leaves the
 * caller's own project rule in charge.
 */
export function routePromotion(forSession: string | undefined, here: { sessionId?: string; holds: boolean }, holderOf: (sessionId: string) => number | undefined): PromotionRoute {
	if (!forSession) return { to: "chat" };
	if (forSession === here.sessionId && here.holds) return { to: "chat" };
	return holderOf(forSession) === undefined ? { to: "inbox", sessionId: forSession } : { to: "mailbox", sessionId: forSession };
}
