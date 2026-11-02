import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boot } from "./boot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const journeyFiles = fs.readdirSync(path.join(here, "journeys")).filter((name) => /^j\d\d-.+\.mjs$/.test(name)).sort();
const journeys = await Promise.all(journeyFiles.map(async (name) => import(pathToFileURL(path.join(here, "journeys", name)).href)));
const options = { ids: [] };
for (let i = 0; i < process.argv.length - 2; i++) {
	const arg = process.argv[i + 2];
	if (arg === "--against") options.against = valueAt(++i);
	else if (arg === "--reply") options.reply = valueAt(++i);
	else if (arg === "--receipt") options.receipt = valueAt(++i);
	else if (arg === "--criterion") options.criterion = valueAt(++i);
	else if (arg === "--produced-by") options.producedBy = valueAt(++i);
	else if (arg.startsWith("--")) usage();
	else options.ids.push(arg);
}
if (!options.ids.length || (options.ids.includes("all") && options.ids.length !== 1) || options.ids.some((id) => id !== "all" && !/^J(?:[1-9]|10)$/.test(id))) usage();
if (options.receipt && options.criterion !== "journeys") usage();
if (!options.receipt && (options.criterion || options.producedBy)) usage();
const all = options.ids[0] === "all";
const selected = all ? journeys : options.ids.map((id) => journeys.find((journey) => journey.id === id));
if (selected.some((journey) => !journey)) usage();
const missingTools = [...new Set(selected.filter((journey) => journey.active).flatMap((journey) => journey.needs ?? []).filter((tool) => !available(tool)))];
const outRoot = path.resolve(process.env.PI_JOURNEY_OUT ?? path.join(os.tmpdir(), "journey-0240"));
fs.mkdirSync(outRoot, { recursive: true });
const repo = path.resolve(here, "../..");
const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const runRoot = path.join(outRoot, sha);
fs.mkdirSync(runRoot, { recursive: true });
let failed = false;
let explicitlyPending = false;
let current;
const results = [];
const interrupt = async () => {
	if (current) await current.stop().catch(() => {});
	process.exit(130);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
for (const journey of selected) {
	if (!journey.active) {
		console.log(`PENDING ${journey.id} (${journey.milestone})`);
		explicitlyPending ||= !all;
		results.push({ id: journey.id, title: journey.title, expect: journey.expect, outcome: "PENDING", milestone: journey.milestone, ms: 0, evidence: [] });
		continue;
	}
	const absent = (journey.needs ?? []).filter((tool) => missingTools.includes(tool));
	if (absent.length) {
		for (const tool of absent) console.log(`MISSING ${tool}: ${installLine(tool)}`);
		results.push({ id: journey.id, title: journey.title, expect: journey.expect, outcome: "MISSING", reason: absent.join(", "), ms: 0, evidence: [] });
		failed = true;
		continue;
	}
	const dir = path.join(runRoot, journey.id);
	fs.mkdirSync(dir, { recursive: true });
	const sandbox = path.join(dir, "sandbox");
	fs.mkdirSync(sandbox, { recursive: true });
	const started = Date.now();
	const evidence = [];
	let bootMs = 0;
	let outcome = "PASS";
	let reason;
	try {
		current = await boot({ out: sandbox, against: options.against, page: journey.page, tui: journey.tui, reply: options.reply ?? "pong from the stand-in", seed: journey.seed });
		bootMs = current.bootMs;
		const ctx = {
			id: journey.id, dir, boot: current,
			waitFor: async (what, probe, ms = 30000) => {
				const end = Date.now() + ms;
				let last;
				while (Date.now() < end) { last = await probe(); if (last) return last; await new Promise((resolve) => setTimeout(resolve, 100)); }
				throw new Error(`timed out waiting for ${what}; last value: ${String(last)}`);
			},
			term: {
				send: (...keys) => tmux(current, ["send-keys", "-t", current.tmux.session, ...keys]),
				screen: () => tmux(current, ["capture-pane", "-p", "-t", current.tmux.session]),
			},
			browser: (...browserArgs) => browser(current, browserArgs),
			addEvidence: (file) => evidence.push(path.resolve(file)),
			fail: (message) => { throw new Error(message); },
		};
		await journey.run(ctx);
	} catch (error) {
		outcome = error?.missing ? "MISSING" : "FAIL";
		reason = error?.message ?? String(error);
		if (outcome === "MISSING") console.log(`MISSING ${error.missing}: ${installLine(error.missing)}`);
	} finally {
		if (current) {
			try {
				const stopped = await current.stop();
				if (stopped.survivors.length) throw new Error(`surviving processes: ${stopped.survivors.join(",")}`);
			} catch (error) {
				outcome = "FAIL";
				reason = [reason, `cleanup: ${error?.message ?? error}`].filter(Boolean).join("; ");
			}
			current = undefined;
		}
	}
	if (outcome === "PASS") {
		fs.rmSync(sandbox, { recursive: true, force: true });
		console.log(`PASS ${journey.id}`);
	} else {
		failed = true;
		if (outcome === "FAIL" && !reason?.startsWith("FAIL ")) console.log(`FAIL ${journey.id}: ${reason}`);
	}
	results.push({ id: journey.id, title: journey.title, expect: journey.expect, outcome, reason, ms: Date.now() - started, bootMs, evidence });
}
const resultFile = path.join(runRoot, "results.jsonl");
fs.writeFileSync(resultFile, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`);
if (options.receipt) writeReceipt(options.receipt, { results, resultFile, all, failed, explicitlyPending, against: options.against, producedBy: options.producedBy, sha, repo });
process.exitCode = explicitlyPending ? 3 : failed ? 1 : 0;

function valueAt(index) {
	const value = process.argv[index + 2];
	if (!value || value.startsWith("--")) usage();
	return value;
}
function usage() {
	console.error("usage: npm run journey -- <J1..J10|all> [--against <ref>] [--reply <text>] [--receipt <file> --criterion journeys --produced-by <name>]");
	process.exit(2);
}
function available(tool) {
	return spawnSync("sh", ["-c", "command -v \"$1\"", "sh", tool], { stdio: "ignore" }).status === 0;
}
function installLine(tool) {
	return tool === "agent-browser" ? "npm install -g agent-browser && agent-browser install" : `install ${tool}`;
}
function tmux(booted, args) {
	const result = spawnSync("tmux", ["-L", booted.tmux.socket, ...args], { encoding: "utf8", env: booted.env });
	if (result.status !== 0) throw new Error(result.stderr || `tmux ${args[0]} failed`);
	return result.stdout;
}
function browser(booted, args) {
	const result = spawnSync("agent-browser", ["--session", `journey-${process.pid}`, "--allowed-domains", "127.0.0.1", "--proxy-bypass", "127.0.0.1,localhost", ...args], { encoding: "utf8", timeout: 30000 });
	if (result.status !== 0) throw new Error(result.stderr || `agent-browser ${args[0]} failed`);
	return result.stdout;
}
function writeReceipt(file, state) {
	const receiptFile = path.resolve(file);
	const receiptDir = path.dirname(receiptFile);
	fs.mkdirSync(receiptDir, { recursive: true });
	const evidence = [];
	for (const result of state.results) for (const original of result.evidence ?? []) {
		const copy = path.join(receiptDir, `${result.id}-${path.basename(original)}`);
		fs.copyFileSync(original, copy);
		evidence.push(copy);
	}
	const resultsCopy = path.join(receiptDir, "journey-results.jsonl");
	fs.copyFileSync(state.resultFile, resultsCopy);
	evidence.push(resultsCopy);
	const main = spawnSync("git", ["rev-parse", "origin/main"], { cwd: state.repo, encoding: "utf8" });
	const clean = spawnSync("git", ["status", "--porcelain"], { cwd: state.repo, encoding: "utf8" });
	const pass = state.all && !state.failed && !state.explicitlyPending && !state.results.some((result) => result.outcome === "PENDING" || result.outcome === "MISSING") && clean.status === 0 && !clean.stdout.trim() && main.status === 0 && state.sha === main.stdout.trim() && !state.against && !!state.producedBy && state.producedBy !== "implementer";
	fs.writeFileSync(receiptFile, `${JSON.stringify({ sha: state.sha, criterion: "journeys", pass, produced_by: state.producedBy, evidence, summary: `${state.results.filter((result) => result.outcome === "PASS").length} active journey(s) passed on ${process.platform} with ${process.version}`, results: state.results, platform: process.platform, node: process.version }, null, 2)}\n`);
}
