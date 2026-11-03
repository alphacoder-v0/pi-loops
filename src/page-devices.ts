/**
 * What lets a browser back in without the token ever riding in a cookie.
 *
 * A cookie ignores ports, so `pi_web_token=<token>` went to every server on 127.0.0.1: anything that
 * bound a loopback port and got one request from the browser held the token for good. Two things
 * replace it. The device cookie names a browser and opens nothing alone: the page trades it for
 * the token only together with a secret it keeps in `localStorage`, which belongs to this origin
 * (port included) and which no server on another port can read. And the three addresses a browser
 * fetches without our header (the event stream, a file, a preview) take a key minted for that one
 * address over the header-authenticated API.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./lock.ts";
import { stamp } from "./schedule.ts";

export const DEVICE_COOKIE = "pi_web_device";
/** Where the page keeps the device secret. Shared by the page and the plain pages that hand it over. */
export const DEVICE_STORAGE_KEY = "pi-loops-device";
/** Wrong secrets one device takes before it is forgotten: a typo is not a thing a script makes twenty times. */
export const DEVICE_MAX_TRIES = 20;
/** Devices kept; the one seen least recently goes first. A browser that comes back keeps its id. */
export const DEVICE_CAP = 64;

export interface DeviceRecord {
	since: string;
	lastSeen: string;
	secretHash: string;
}

/** `<loops>/web-devices.json`. `tokenHash` ties it to one token: a new token starts with no devices. */
export interface DeviceFile {
	v: 1;
	tokenHash: string;
	devices: Record<string, DeviceRecord>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const DEVICE_ID = /^[0-9a-f]{32}$/;

/**
 * Whether `secret` is the one this device was given. Undefined `record`: no such device, which is
 * 401 rather than 403 because there is nothing to count a try against.
 */
export function deviceVerdict(record: DeviceRecord | undefined, secret: string | undefined): "ok" | "unknown" | "bad" {
	if (!record) return "unknown";
	if (!secret) return "bad";
	const given = Buffer.from(sha256(secret));
	const kept = Buffer.from(record.secretHash);
	return given.length === kept.length && timingSafeEqual(given, kept) ? "ok" : "bad";
}

/** The file as read, or an empty one when it is missing, malformed, or was made for another token. */
export function parseDeviceFile(text: string | undefined, tokenHash: string): DeviceFile {
	const empty: DeviceFile = { v: 1, tokenHash, devices: {} };
	if (text === undefined) return empty;
	let raw: any;
	try {
		raw = JSON.parse(text);
	} catch {
		return empty; // a torn or hand-edited file: every browser pairs again, which is the safe side
	}
	if (raw?.v !== 1 || raw.tokenHash !== tokenHash || typeof raw.devices !== "object" || raw.devices === null) return empty;
	const devices: Record<string, DeviceRecord> = {};
	for (const [id, r] of Object.entries<any>(raw.devices)) {
		if (DEVICE_ID.test(id) && typeof r?.secretHash === "string" && typeof r.since === "string" && typeof r.lastSeen === "string") devices[id] = { since: r.since, lastSeen: r.lastSeen, secretHash: r.secretHash };
	}
	return { v: 1, tokenHash, devices };
}

/** The browsers that paired with this token. Read once; every change is written through, 0600. */
export class DeviceStore {
	private readonly file: string;
	private data: DeviceFile;
	private readonly tries = new Map<string, number>();
	private readonly log: (line: string) => void;

	constructor(dir: string, token: string, log: (line: string) => void) {
		this.log = log;
		this.file = path.join(dir, "web-devices.json");
		let text: string | undefined;
		try {
			text = fs.readFileSync(this.file, "utf8");
		} catch {
			text = undefined; // no file yet: no devices
		}
		this.data = parseDeviceFile(text, sha256(token));
	}

	known(id: string | undefined): boolean {
		return id !== undefined && Object.hasOwn(this.data.devices, id);
	}

	/**
	 * A device for a browser that just proved itself with the open key, the pairing code or the token.
	 * A browser that already has a device keeps its id and gets a new secret; any other gets a new id.
	 */
	enroll(id: string | undefined): { id: string; secret: string } {
		const now = stamp();
		const keep = this.known(id) ? (id as string) : randomBytes(16).toString("hex");
		const secret = randomBytes(32).toString("hex");
		this.data.devices[keep] = { since: this.data.devices[keep]?.since ?? now, lastSeen: now, secretHash: sha256(secret) };
		this.tries.delete(keep);
		const others = Object.keys(this.data.devices)
			.filter((other) => other !== keep)
			.sort((a, b) => Date.parse(this.data.devices[b].lastSeen) - Date.parse(this.data.devices[a].lastSeen));
		for (const old of others.slice(DEVICE_CAP - 1)) delete this.data.devices[old];
		this.save();
		return { id: keep, secret };
	}

	/** The cookie and the secret together, for the token. A wrong secret spends one of twenty tries. */
	trade(id: string | undefined, secret: string | undefined): { ok: true } | { status: 401 | 403; why: string } {
		const record = this.known(id) ? this.data.devices[id as string] : undefined;
		const verdict = deviceVerdict(record, secret);
		if (verdict === "unknown") return { status: 401, why: "no device" };
		const device = id as string;
		if (verdict === "bad") {
			const n = (this.tries.get(device) ?? 0) + 1;
			this.tries.set(device, n);
			if (n >= DEVICE_MAX_TRIES) {
				delete this.data.devices[device];
				this.tries.delete(device);
				this.save();
				this.log("pi-loops page: a browser gave the wrong device secret twenty times; it pairs again from now on");
			}
			return { status: 403, why: "bad device secret" };
		}
		this.tries.delete(device);
		this.data.devices[device].lastSeen = stamp();
		this.save();
		return { ok: true };
	}

	private save() {
		try {
			writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 0o600);
		} catch (err: any) {
			// The device still works until pi-loops restarts; after that the browser pairs again.
			this.log(`pi-loops page: could not write ${this.file}: ${err?.message ?? err}`);
		}
	}
}

/* ------------------------------------------------------------------ keys for one address */

export type KeyKind = "events" | "file" | "preview";
export const KEY_KINDS: readonly KeyKind[] = ["events", "file", "preview"];

export interface UrlKey {
	sessionId: string;
	kind: KeyKind;
	/** The exact `path` a `file` key opens, or the id a `preview` key opens. */
	path?: string;
	expires: number;
}

/**
 * An EventSource reconnects on its own with the address it was given, so an `events` key is good
 * for every reconnect within ten minutes. A file and a preview are one load each.
 */
export const KEY_TTL_MS: Readonly<Record<KeyKind, number>> = { events: 10 * 60_000, file: 60_000, preview: 60_000 };
export const KEYS_CAP = 256;

/** Whether `key` opens what is asked. A preview is not under a conversation, so only its id binds it. */
export function keyOpens(key: UrlKey | undefined, ask: { kind: KeyKind; sessionId?: string; path?: string }, now: number): boolean {
	if (!key || key.kind !== ask.kind || key.expires <= now) return false;
	if (ask.kind !== "preview" && key.sessionId !== ask.sessionId) return false;
	return ask.kind === "events" || key.path === ask.path;
}

/** Keys in memory, capped: past the cap the oldest one goes. */
export class UrlKeys {
	private readonly keys = new Map<string, UrlKey>();

	mint(sessionId: string, kind: KeyKind, keyPath?: string, now = Date.now()): string {
		for (const [k, v] of this.keys) if (v.expires <= now) this.keys.delete(k);
		const key = randomBytes(16).toString("hex");
		this.keys.set(key, { sessionId, kind, path: keyPath, expires: now + KEY_TTL_MS[kind] });
		while (this.keys.size > KEYS_CAP) this.keys.delete(this.keys.keys().next().value as string);
		return key;
	}

	/** Whether `key` opens what is asked. A file or preview key is spent by being shown, right or wrong. */
	spend(key: string | null, ask: { kind: KeyKind; sessionId?: string; path?: string }, now = Date.now()): boolean {
		if (!key) return false;
		const found = this.keys.get(key);
		if (found && found.kind !== "events") this.keys.delete(key);
		return keyOpens(found, ask, now);
	}
}
