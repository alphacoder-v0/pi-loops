import { test } from "node:test";
import assert from "node:assert/strict";
import { Ticker, BACKGROUND_RIDERS, HOST_RIDERS, RUNTIME_RIDERS, WINDOW_RIDERS } from "../src/ticker.ts";

test("[ticker-riders] Every background and window rider is required and runs in order.", async () => {
	assert.deepEqual(BACKGROUND_RIDERS, [...HOST_RIDERS, ...RUNTIME_RIDERS]);
	assert.equal(BACKGROUND_RIDERS.includes("loop-lanes" as never), true);
	assert.deepEqual(WINDOW_RIDERS, ["lease", "finished-runs", "snapshot", "background", "clock"]);
	const seen: string[] = [];
	const ticker = new Ticker({ names: ["a", "b", "c"] as const, riders: { a: () => { seen.push("a"); }, b: async () => { seen.push("b"); }, c: () => { seen.push("c"); } }, now: () => 10, log: () => undefined });
	await ticker.tick();
	assert.deepEqual(seen, ["a", "b", "c"]);
});

test("stop prevents the next rider and waits for the rider already running.", async () => {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const seen: string[] = [];
	const ticker = new Ticker({ names: ["active", "next"] as const, riders: {
		active: async () => { seen.push("active"); enter(); await gate; },
		next: () => { seen.push("next"); },
	}, log: () => undefined });
	const tick = ticker.tick();
	await entered;
	let stopped = false;
	const stop = ticker.stop().then(() => { stopped = true; });
	await Promise.resolve();
	assert.equal(stopped, false);
	release();
	await Promise.all([tick, stop]);
	assert.equal(stopped, true);
	assert.deepEqual(seen, ["active"]);
});

test("[ticker-riders] The host's riders keep main's order, and a process that leaves writes no heartbeat after it", async () => {
	// The order of main's everyTick (src/host.ts): still named, auto-leave, the two sweeps, the page's bind, the heartbeat, the channel's heal.
	assert.deepEqual(HOST_RIDERS, ["still-named", "auto-leave", "conversation-sweep", "page-sweep", "page-bind", "heartbeat", "channel-heal"]);
	assert.deepEqual(RUNTIME_RIDERS, ["stray-leases", "closed-conversations", "rule-checks", "removed-jobs", "dead-sessions", "clock", "answers", "check-lanes", "loop-lanes", "notices"]);
	const seen: string[] = [];
	const ticker: Ticker<(typeof HOST_RIDERS)[number]> = new Ticker({
		names: HOST_RIDERS,
		riders: {
			// The record names another process: the background leaves, and its shutdown stops the ticker first.
			"still-named": () => { seen.push("still-named"); void ticker.stop(); },
			"auto-leave": () => { seen.push("auto-leave"); },
			"conversation-sweep": () => { seen.push("conversation-sweep"); },
			"page-sweep": () => { seen.push("page-sweep"); },
			"page-bind": () => { seen.push("page-bind"); },
			heartbeat: () => { seen.push("heartbeat"); },
			"channel-heal": () => { seen.push("channel-heal"); },
		},
		log: () => undefined,
	});
	await ticker.tick();
	assert.deepEqual(seen, ["still-named"], "no heartbeat for a process that is leaving: a window would read it as alive");
});
