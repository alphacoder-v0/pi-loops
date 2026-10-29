/**
 * The login unit: a systemd user unit (Linux) or a LaunchAgent (macOS) that starts the host when
 * the person logs in, so loops run after a reboot before any pi opens. It is the second file
 * pi-loops writes outside its loops directory (AGENTS.md, Non-invasive), and it follows the
 * launcher's rules (`launcherState` / `refreshLauncher` in src/cli.ts): written only after a yes,
 * rewritten afterwards only where a unit of ours already is and the node or the copy it names has
 * gone, and a file without our marker is somebody else's and never touched. This module renders
 * and decides; the caller writes, and runs the `systemctl` / `launchctl` lines it returns, so all of
 * it is testable on a machine with neither.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type UnitKind = "systemd" | "launchd";
export const SYSTEMD_UNIT = "pi-loops-host.service";
export const LAUNCHD_LABEL = "dev.pi-loops.host";
const MARKER = "pi-loops host unit, written by `pi-loops host install`.";
const RECORD = "pi-loops-host: ";

export interface UnitSpec {
	node: string;
	args: string[];
	env: Record<string, string>;
	logFile: string;
	home: string;
}

export type UnitState = "absent" | "current" | "stale" | "other" | "foreign";
export type UnitAction = "install" | "uninstall" | "start" | "reload";

/** Selects the login manager available on this machine before an install is offered. */
export function unitKind(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): UnitKind | undefined {
	if (platform === "darwin") return "launchd";
	if (platform === "linux" && exists("/run/systemd/system")) return "systemd";
	return undefined;
}

/** Returns the one per-user file a confirmed install may write. */
export function unitFile(kind: UnitKind, home: string): string {
	return kind === "systemd" ? path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT) : path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function validate(spec: UnitSpec): void {
	const values: Array<[string, string]> = [["node", spec.node], ...spec.args.map((arg) => ["argument", arg] as [string, string]), ...Object.entries(spec.env).flatMap(([key, value]) => [["environment name", key], ["environment value", value]] as [string, string][]), ["logFile", spec.logFile], ["home", spec.home]];
	for (const [what, value] of values) if (/[\n\r]/.test(value)) throw new Error(`cannot write the host unit: ${what} contains a line break`);
	for (const key of Object.keys(spec.env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`cannot write the host unit: bad environment name ${key}`);
}

function systemdQuote(value: string, exec = false): string {
	const quoted = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
	return `"${exec ? quoted.replace(/\$/g, () => "$$") : quoted}"`;
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Renders a login unit from its exact executable and environment, after rejecting unsafe text. */
export function renderUnit(kind: UnitKind, spec: UnitSpec): string {
	validate(spec);
	const entry = spec.args[spec.args.length - 1];
	const record = JSON.stringify({ node: spec.node, entry }).replace(/-/g, "\\u002d");
	if (kind === "systemd") {
		return [
			`# ${MARKER}`,
			`# ${RECORD}${record}`,
			"[Unit]",
			"Description=pi-loops host: loops, rule checks and MCP pushes",
			"",
			"[Service]",
			// exec, not simple: `systemctl start` then fails when the node it names cannot be run.
			"Type=exec",
			`WorkingDirectory=${spec.home.replace(/%/g, "%%")}`,
			`ExecStart=${[spec.node, ...spec.args].map((arg) => systemdQuote(arg, true)).join(" ")}`,
			...Object.keys(spec.env).sort().map((key) => `Environment=${systemdQuote(`${key}=${spec.env[key]}`)}`),
			"Restart=on-failure",
			"RestartSec=30",
			// The host's exit for "cannot run here" (src/host-entry.mjs): restarting it cannot help.
			"RestartPreventExitStatus=78",
			`StandardOutput=append:${spec.logFile.replace(/%/g, "%%")}`,
			`StandardError=append:${spec.logFile.replace(/%/g, "%%")}`,
			"",
			"[Install]",
			"WantedBy=default.target",
			"",
		].join("\n");
	}
	const strings = (values: string[]) => values.map((value) => `<string>${xml(value)}</string>`).join("\n");
	const env = Object.keys(spec.env).sort().map((key) => `<key>${xml(key)}</key><string>${xml(spec.env[key])}</string>`).join("\n");
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		`<!-- ${MARKER} -->`,
		`<!-- ${RECORD}${record} -->`,
		"<plist version=\"1.0\"><dict>",
		`<key>Label</key><string>${LAUNCHD_LABEL}</string>`,
		`<key>ProgramArguments</key><array>${strings([spec.node, ...spec.args])}</array>`,
		`<key>EnvironmentVariables</key><dict>${env}</dict>`,
		`<key>WorkingDirectory</key><string>${xml(spec.home)}</string>`,
		"<key>RunAtLoad</key><true/>",
		"<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
		`<key>StandardOutPath</key><string>${xml(spec.logFile)}</string>`,
		`<key>StandardErrorPath</key><string>${xml(spec.logFile)}</string>`,
		"</dict></plist>",
		"",
	].join("\n");
}

function readUnit(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		// Missing, a directory, unreadable: in all three there is no unit of ours to read.
		return undefined;
	}
}

function recordFrom(text: string): { node?: string; entry?: string } | undefined {
	const line = text.split(/\r?\n/).find((item) => item.includes(RECORD));
	if (!line) return undefined;
	const raw = line.slice(line.indexOf(RECORD) + RECORD.length).replace(/\s+-->/, "");
	try {
		const value = JSON.parse(raw);
		return value && typeof value === "object" ? value : undefined;
	} catch {
		// A record nobody can read is treated as stale: it carries our marker, so it is ours to fix.
		return undefined;
	}
}

/** Distinguishes our unit from a person's file and from a still-installed copy of the package. */
export function unitState(kind: UnitKind, file: string, spec: UnitSpec, exists: (p: string) => boolean = fs.existsSync): { file: string; state: UnitState } {
	if (!exists(file)) return { file, state: "absent" };
	const text = readUnit(file);
	if (text === undefined) return { file, state: "absent" };
	if (!text.split(/\r?\n/).some((line) => line.includes(MARKER))) return { file, state: "foreign" };
	const record = recordFrom(text);
	if (!record || typeof record.node !== "string" || typeof record.entry !== "string") return { file, state: "stale" };
	const entry = spec.args[spec.args.length - 1];
	if (record.node === spec.node && record.entry === entry) return { file, state: "current" };
	if (!exists(record.node) || !exists(record.entry) || record.entry === entry) return { file, state: "stale" };
	return { file, state: "other" };
}

/** Refreshes only a stale unit that carries this module's marker. */
export function refreshUnit(kind: UnitKind, file: string, spec: UnitSpec, exists: (p: string) => boolean = fs.existsSync): { ok: boolean; message: string } | undefined {
	if (unitState(kind, file, spec, exists).state !== "stale") return undefined;
	const old = readUnit(file) ?? "";
	const record = recordFrom(old);
	const entry = spec.args[spec.args.length - 1];
	const why = record?.entry !== entry ? "the package moved" : record?.node !== spec.node ? "the node it runs changed" : "this version of pi-loops writes it differently";
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, renderUnit(kind, spec));
		return { ok: true, message: `refreshed the pi-loops host unit at ${file}: ${why}` };
	} catch (err: any) {
		return { ok: false, message: `could not refresh the pi-loops host unit at ${file}: ${err?.message ?? err}` };
	}
}

/** Gives the caller argv arrays for the chosen login manager; this module never runs them. */
export function unitCommands(kind: UnitKind, action: UnitAction, ctx: { uid: number; file: string }): string[][] {
	if (kind === "systemd") {
		switch (action) {
			case "install": return [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", SYSTEMD_UNIT]];
			case "uninstall": return [["systemctl", "--user", "disable", SYSTEMD_UNIT]];
			case "start": return [["systemctl", "--user", "start", SYSTEMD_UNIT]];
			case "reload": return [["systemctl", "--user", "daemon-reload"]];
		}
	}
	const domain = `gui/${ctx.uid}`;
	const service = `${domain}/${LAUNCHD_LABEL}`;
	switch (action) {
		case "install": return [["launchctl", "bootstrap", domain, ctx.file]];
		case "uninstall": return [["launchctl", "bootout", service]];
		case "start": return [["launchctl", "kickstart", service]];
		case "reload": return [["launchctl", "bootout", service], ["launchctl", "bootstrap", domain, ctx.file]];
	}
}
