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
	text: string;
	cwd: string;
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

	/**
	 * Deliver what is queued for `sessionId`, in order. An entry leaves the file only once its
	 * `[Trigger <id>]` is in the conversation (`alreadyDelivered`), not when pi accepted it: a result
	 * handed to a busy agent waits in pi's memory as a follow-up, and a window that quits before that
	 * turn would otherwise lose it. `handedOver` remembers what this process already gave pi, so a
	 * second drain before pi writes it does not hand it over twice.
	 */
	drain(sessionId: string, opts: { holds: () => boolean; alreadyDelivered: (id: string) => boolean; deliver: (d: Delivery) => void; handedOver?: Set<string> }): { delivered: string[]; skipped: string[] } {
		const result = { delivered: [] as string[], skipped: [] as string[] };
		if (!opts.holds()) return result;
		for (const delivery of this.pending(sessionId)) {
			if (opts.alreadyDelivered(delivery.id)) {
				result.skipped.push(delivery.id);
				continue;
			}
			if (opts.handedOver?.has(delivery.id)) continue; // with pi, not yet in the file: wait
			try {
				opts.deliver(delivery);
				result.delivered.push(delivery.id);
				opts.handedOver?.add(delivery.id);
			} catch {
				// The chat refused it (pi shutting down): this entry and the ones after it wait for the next drain, in order.
				break;
			}
		}
		const removed = new Set([...result.skipped, ...result.delivered.filter((id) => opts.alreadyDelivered(id))]);
		if (!removed.size) return result;
		const file = this.file(sessionId);
		withFileLockSync(path.join(this.dir, "deliveries.lock"), () => {
			const remaining = this.pending(sessionId).filter((delivery) => !removed.has(delivery.id));
			if (remaining.length) writeFileAtomic(file, `${remaining.map((delivery) => JSON.stringify(delivery)).join("\n")}\n`);
			else fs.rmSync(file, { force: true });
		});
		for (const id of removed) opts.handedOver?.delete(id);
		return result;
	}

	/** The conversations with something queued. */
	sessions(): string[] {
		try {
			return fs
				.readdirSync(path.join(this.dir, "deliveries"))
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => f.slice(0, -".jsonl".length));
		} catch {
			return []; // no deliveries directory yet
		}
	}
}

export type PromotionRoute = { to: "chat" } | { to: "mailbox"; sessionId: string } | { to: "append"; sessionId: string } | { to: "inbox"; sessionId?: string };

/**
 * Where a rule's result goes, decided the same way by a window and by the host: into the conversation
 * that created the rule, wherever that is.
 *
 * - This process holds it: the chat.
 * - Another process holds it: that holder's mailbox.
 * - It is closed and the host may take it (`closedConversation`): the host appends it; a window
 *   queues it in the mailbox, which the host delivers on its next tick.
 * - Otherwise (its file unknown or gone, open in a 0.22 window): the inbox, marked for it.
 *
 * With no creating conversation (a rule made from a shell) a window keeps it in its own chat and the
 * host files it in the inbox.
 */
export function routePromotion(forSession: string | undefined, here: { sessionId?: string; holds: boolean; isHost?: boolean }, view: { holderOf: (sessionId: string) => number | undefined; closed: (sessionId: string) => boolean }): PromotionRoute {
	if (!forSession) return here.isHost ? { to: "inbox" } : { to: "chat" };
	if (forSession === here.sessionId && here.holds) return { to: "chat" };
	if (view.holderOf(forSession) !== undefined) return { to: "mailbox", sessionId: forSession };
	if (!view.closed(forSession)) return { to: "inbox", sessionId: forSession };
	return here.isHost ? { to: "append", sessionId: forSession } : { to: "mailbox", sessionId: forSession };
}
