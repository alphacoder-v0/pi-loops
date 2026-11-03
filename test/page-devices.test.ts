import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { DEVICE_CAP, DeviceStore, deviceVerdict, KEYS_CAP, keyOpens, parseDeviceFile, UrlKeys } from "../src/page-devices.ts";

const NOW = 1_000_000;

test("a key opens only the kind, conversation and path it was minted for, until it expires", () => {
	const file = { sessionId: "s1", kind: "file" as const, path: "a.png", expires: NOW + 60_000 };
	assert.equal(keyOpens(file, { kind: "file", sessionId: "s1", path: "a.png" }, NOW), true);
	assert.equal(keyOpens(file, { kind: "file", sessionId: "s1", path: "b.png" }, NOW), false, "another path");
	assert.equal(keyOpens(file, { kind: "file", sessionId: "s2", path: "a.png" }, NOW), false, "another conversation");
	assert.equal(keyOpens(file, { kind: "events", sessionId: "s1" }, NOW), false, "another kind");
	assert.equal(keyOpens(file, { kind: "file", sessionId: "s1", path: "a.png" }, NOW + 60_000), false, "late");
	const preview = { sessionId: "s1", kind: "preview" as const, path: "p1", expires: NOW + 60_000 };
	assert.equal(keyOpens(preview, { kind: "preview", path: "p1" }, NOW), true, "a preview is bound by its id alone");
	assert.equal(keyOpens(preview, { kind: "preview", path: "p2" }, NOW), false);
	const events = { sessionId: "s1", kind: "events" as const, expires: NOW + 600_000 };
	assert.equal(keyOpens(events, { kind: "events", sessionId: "s1" }, NOW + 599_000), true, "the stream's key lasts ten minutes");
	assert.equal(keyOpens(undefined, { kind: "events", sessionId: "s1" }, NOW), false);
});

test("a file or preview key is spent by being shown; the stream's key is not; past the cap the oldest goes", () => {
	const keys = new UrlKeys();
	const f = keys.mint("s1", "file", "a.png", NOW);
	assert.equal(keys.spend(f, { kind: "file", sessionId: "s1", path: "b.png" }, NOW), false, "the wrong path");
	assert.equal(keys.spend(f, { kind: "file", sessionId: "s1", path: "a.png" }, NOW), false, "spent by the wrong use too");
	const e = keys.mint("s1", "events", undefined, NOW);
	assert.equal(keys.spend(e, { kind: "events", sessionId: "s1" }, NOW), true);
	assert.equal(keys.spend(e, { kind: "events", sessionId: "s1" }, NOW + 1), true, "a reconnect");
	assert.equal(keys.spend(e, { kind: "events", sessionId: "s1" }, NOW + 600_000), false, "not after ten minutes");
	const first = keys.mint("s1", "events", undefined, NOW);
	for (let i = 0; i < KEYS_CAP; i++) keys.mint("s1", "events", undefined, NOW);
	assert.equal(keys.spend(first, { kind: "events", sessionId: "s1" }, NOW), false, "the oldest key past the cap is gone");
	assert.equal(keys.spend(null, { kind: "events", sessionId: "s1" }, NOW), false);
});

test("a device secret is checked against its hash; no device is unknown, a missing secret is bad", () => {
	const dir = tmp("pi-loops-devices-");
	const store = new DeviceStore(dir, "t".repeat(32), () => {});
	const { id, secret } = store.enroll(undefined);
	const record = JSON.parse(fs.readFileSync(path.join(dir, "web-devices.json"), "utf8")).devices[id];
	assert.equal(deviceVerdict(record, secret), "ok");
	assert.equal(deviceVerdict(record, "0".repeat(64)), "bad");
	assert.equal(deviceVerdict(record, undefined), "bad");
	assert.equal(deviceVerdict(undefined, secret), "unknown");
});

test("a browser that pairs again keeps its id with a new secret; the oldest devices past the cap go", () => {
	const dir = tmp("pi-loops-devices-");
	const store = new DeviceStore(dir, "t".repeat(32), () => {});
	const one = store.enroll(undefined);
	const again = store.enroll(one.id);
	assert.equal(again.id, one.id, "the same browser");
	assert.notEqual(again.secret, one.secret, "with a new secret");
	assert.deepEqual(store.trade(one.id, one.secret), { status: 403, why: "bad device secret" }, "the old one is no good");
	assert.deepEqual(store.trade(one.id, again.secret), { ok: true });
	assert.notEqual(store.enroll("f".repeat(32)).id, "f".repeat(32), "an id nobody was given is not taken on");
	let last = "";
	for (let i = 0; i < DEVICE_CAP + 5; i++) last = store.enroll(undefined).id;
	const kept = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "web-devices.json"), "utf8")).devices);
	assert.equal(kept.length, DEVICE_CAP);
	assert.ok(kept.includes(last), "and the browser that just paired is one of them");
});

test("a new token starts with no devices: the file made for another token is not read", () => {
	const dir = tmp("pi-loops-devices-");
	const { id, secret } = new DeviceStore(dir, "a".repeat(32), () => {}).enroll(undefined);
	assert.equal(new DeviceStore(dir, "a".repeat(32), () => {}).known(id), true, "the same token keeps it");
	const rotated = new DeviceStore(dir, "b".repeat(32), () => {});
	assert.equal(rotated.known(id), false, "a new token does not");
	assert.deepEqual(rotated.trade(id, secret), { status: 401, why: "no device" });
	assert.deepEqual(parseDeviceFile("{torn", "x").devices, {}, "and a torn file is no devices");
});

test("a cookie naming an inherited property is no device, not a crash", () => {
	const store = new DeviceStore(tmp("pi-loops-devices-"), "t".repeat(32), () => {});
	for (const id of ["constructor", "__proto__", "toString"]) {
		assert.equal(store.known(id), false, id);
		assert.deepEqual(store.trade(id, "x"), { status: 401, why: "no device" }, id);
	}
});
