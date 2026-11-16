import { test } from "node:test";
import assert from "node:assert/strict";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { renderTurn, turnText } from "../src/turn-render.ts";

test("turn text joins text blocks and ends with the page's image receipt", () => {
	assert.equal(turnText("plain prompt"), "plain prompt");
	assert.equal(
		turnText([
			{ type: "text", text: "inspect " },
			{ type: "image", data: "a" },
			{ type: "text", text: "this" },
			{ type: "image", data: "b" },
		]),
		"inspect this\n[2 images]",
	);
	assert.equal(turnText([{ type: "image", data: "a" }]), "[1 image]");
});

test("a turn uses pi's user message component and configured output padding", () => {
	const component = renderTurn({ content: "the prompt" }, { expanded: false, outputPad: 3 });
	assert.ok(component instanceof UserMessageComponent);
	assert.equal((component as any).outputPad, 3);
});
