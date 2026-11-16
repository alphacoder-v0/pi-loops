/** How a terminal draws a turn row's custom message (`pi-loops:turn`): as it draws a message the person typed, its images counted. */
import { UserMessageComponent, type MessageRenderOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export function turnText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const text = content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
	const images = content.filter((part: any) => part?.type === "image").length;
	return images ? `${text}${text ? "\n" : ""}[${images} image${images === 1 ? "" : "s"}]` : text;
}

export function renderTurn(message: { content: unknown }, options: MessageRenderOptions): Component {
	return new UserMessageComponent(turnText(message.content), undefined, options.outputPad);
}
