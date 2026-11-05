import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boot, cleanBrowserEnv, commandPath, DEFAULT_REPLY, reapStale, sweep } from "./boot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
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
const outRoot = path.resolve(process.env.PI_JOURNEY_OUT ?? "/tmp/journey-0240");
fs.mkdirSync(outRoot, { recursive: true });
await reapStale(outRoot);
const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
let againstSha;
if (options.against) {
	const ref = spawnSync("git", ["rev-parse", "--verify", `${options.against}^{commit}`], { cwd: repo, encoding: "utf8" });
	if (ref.status !== 0) usage();
	againstSha = ref.stdout.trim();
}
const runRoot = path.join(outRoot, options.against ? `${sha}-against-${againstSha}` : sha);
fs.mkdirSync(runRoot, { recursive: true });
const effectiveReply = options.reply ?? DEFAULT_REPLY;
let failed = false;
let missing = false;
let explicitlyPending = false;
let current;
let activeRun;
let activeJourney;
let activeStarted = 0;
let interrupting = false;
const results = [];
const resultFile = path.join(runRoot, "results.jsonl");
const invocation = new Date().toISOString();
const appendResult = (row) => fs.appendFileSync(resultFile, `${JSON.stringify({ invocation, ...row })}\n`);
fs.writeFileSync(resultFile, "", { flag: "a" });
let interruptPromise;
const interrupt = () => interruptPromise ??= (async () => {
	interrupting = true;
	if (activeRun) activeRun.controller.abort(new Error("interrupted"));
	try {
		let booted = current;
		if (activeRun?.bootPromise) {
			try { booted ??= await activeRun.bootPromise; }
			catch (error) { if (error?.message !== "interrupted") process.stderr.write(`boot cleanup on interrupt: ${error?.message ?? error}\n`); }
		}
		if (booted) {
			await booted.stop();
			booted.closeSession();
		} else if (activeRun) await sweep(activeRun.sandbox, activeRun.runId, activeRun.browserSession);
	} catch (error) {
		process.stderr.write(`cleanup on interrupt: ${error?.message ?? error}\n`);
	}
	if (activeJourney) {
		const row = { id: activeJourney.id, title: activeJourney.title, expect: activeJourney.expect, against: options.against, outcome: "INTERRUPTED", reason: "interrupted", ms: Date.now() - activeStarted, bootMs: 0, evidence: [], bystanders: [] };
		results.push(row);
		appendResult(row);
		console.log(`INTERRUPTED ${activeJourney.id}`);
	}
	process.exit(130);
})();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
for (const journey of selected) {
	if (interrupting) break;
	if (!journey.active) {
		console.log(`PENDING ${journey.id} (${journey.milestone})`);
		explicitlyPending ||= !all;
		const row = { id: journey.id, title: journey.title, expect: journey.expect, against: options.against, outcome: "PENDING", milestone: journey.milestone, ms: 0, evidence: [], bystanders: [] };
		results.push(row);
		appendResult(row);
		continue;
	}
	const absent = [...new Set(journey.needs ?? [])].filter((tool) => !commandPath(tool));
	if (absent.length) {
		for (const tool of absent) console.log(`MISSING ${tool}: ${installLine(tool)}`);
		missing = true;
		failed = true;
		const row = { id: journey.id, title: journey.title, expect: journey.expect, against: options.against, outcome: "MISSING", reason: absent.join(", "), ms: 0, evidence: [], bystanders: [] };
		results.push(row);
		appendResult(row);
		continue;
	}
	const dir = path.join(runRoot, journey.id);
	fs.mkdirSync(dir, { recursive: true });
	const sandbox = path.join(dir, "sandbox");
	fs.mkdirSync(sandbox, { recursive: true });
	const runId = randomUUID();
	const controller = new AbortController();
	activeRun = { sandbox, runId, controller };
	const started = Date.now();
	activeJourney = journey;
	activeStarted = started;
	const evidence = [];
	const bystanders = [];
	let pageOpen = false;
	let bootMs = 0;
	let outcome = "PASS";
	let reason;
	try {
		// A journey may carry its own stand-in answer (J5's check names its rule); --reply still wins.
		const reply = options.reply ?? journey.reply ?? effectiveReply;
		activeRun.bootPromise = boot({ out: sandbox, runId, against: options.against, page: journey.page, tui: journey.tui, reply, seed: journey.seed, signal: controller.signal });
		current = await activeRun.bootPromise;
		activeRun.bootPromise = undefined;
		activeRun.browserSession = current.browserSession;
		bootMs = current.bootMs;
		const ctx = {
			id: journey.id, dir, boot: current, reply,
			waitFor: async (what, probe, ms = 30000) => {
				const deadline = Date.now() + ms;
				let last;
				while (Date.now() < deadline) {
					const result = await probe();
					if (result && typeof result === "object" && Object.hasOwn(result, "ok")) {
						last = result.last;
						if (result.ok) return result.value ?? result.last;
					} else {
						last = result;
						if (result) return result;
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				const detail = typeof last === "string" ? last : JSON.stringify(last) ?? String(last);
				throw new Error(`timed out waiting for ${what}; last value: ${detail}`);
			},
			term: {
				send: (...keys) => tmux(current, ["send-keys", "-t", current.tmux.session, ...keys]),
				screen: () => tmux(current, ["capture-pane", "-p", "-t", current.tmux.session]),
			},
			browser: (...browserArgs) => {
				if (interrupting || controller.signal.aborted) throw new Error("interrupted");
				const result = browser(browserArgs, current.browserSession);
				if (interrupting || controller.signal.aborted) throw new Error("interrupted");
				if (browserArgs[0] === "open") pageOpen = true;
				if (browserArgs[0] === "close") pageOpen = false;
				return result;
			},
			addEvidence: (file) => addEvidence(journey.id, path.resolve(file), evidence),
		};
		await journey.run(ctx);
	} catch (error) {
		outcome = error?.missing ? "MISSING" : error?.message === "interrupted" ? "INTERRUPTED" : "FAIL";
		reason = error?.message ?? String(error);
		if (outcome === "MISSING") { missing = true; console.log(`MISSING ${error.missing}: ${installLine(error.missing)}`); }
		if (current && outcome === "FAIL" && !interrupting) captureFailure({ booted: current, journey, dir, evidence, pageOpen });
	} finally {
		if (current) {
			try {
				const stopped = await current.stop();
				if (interrupting) current.closeSession();
				bystanders.push(...stopped.diagnostic);
				for (const match of stopped.diagnostic) console.log(`NOTE ${journey.id} bystander pid ${match.pid} (${match.cmd})`);
				if (stopped.survivors.length) throw new Error(`surviving processes: ${stopped.survivors.join(",")}`);
			} catch (error) {
				if (interrupting || controller.signal.aborted || error?.message === "interrupted") outcome = "INTERRUPTED";
				else {
					outcome = "FAIL";
					reason = [reason, `cleanup: ${error?.message ?? error}`].filter(Boolean).join("; ");
					captureFailure({ booted: current, journey, dir, evidence, pageOpen: false });
				}
			}
			current = undefined;
		}
		activeRun = undefined;
	}
	if (outcome === "PASS") {
		fs.rmSync(sandbox, { recursive: true, force: true });
		console.log(`PASS ${journey.id}`);
	} else if (outcome === "INTERRUPTED") {
		reason = "interrupted";
		console.log(`INTERRUPTED ${journey.id}`);
	} else {
		failed = true;
		if (outcome === "FAIL") console.log(`FAIL ${journey.id}: ${reason}`);
	}
	const row = { id: journey.id, title: journey.title, expect: journey.expect, against: options.against, outcome, reason, ms: Date.now() - started, bootMs, evidence, bystanders };
	results.push(row);
	appendResult(row);
	activeJourney = undefined;
}
if (options.receipt) writeReceipt(options.receipt, { results, resultFile, all, failed, missing, explicitlyPending, against: options.against, producedBy: options.producedBy, sha, repo });
process.exitCode = missing || explicitlyPending ? 3 : failed ? 1 : 0;

function valueAt(index) {
	const value = process.argv[index + 2];
	if (!value || value.startsWith("--")) usage();
	return value;
}
function usage() {
	console.error("usage: npm run journey -- <J1..J10|all> [--against <ref>] [--reply <text>] [--receipt <file> --criterion journeys --produced-by <name>]");
	process.exit(2);
}
function installLine(tool) {
	if (tool === "agent-browser") return "npm install -g agent-browser && agent-browser install";
	if (tool === "agent-browser browser") return "agent-browser install (then make sure Chromium can launch)";
	return `install ${tool}`;
}
function tmux(booted, args) {
	const result = spawnSync("tmux", ["-L", booted.tmux.socket, ...args], { encoding: "utf8", env: booted.env, timeout: 10000 });
	if (result.error) throw new Error(`${result.error.message}${result.stderr ? `: ${result.stderr}` : ""}`);
	if (result.status !== 0) throw new Error(result.stderr || `tmux ${args[0]} failed`);
	return result.stdout;
}
function browser(args, session) {
	if (interrupting) throw new Error("interrupted");
	const env = cleanBrowserEnv();
	const result = spawnSync("agent-browser", ["--session", session, "--allowed-domains", "127.0.0.1", "--proxy-bypass", "127.0.0.1,localhost", ...args], { encoding: "utf8", timeout: 30000, env });
	const detail = `${result.error?.message ?? ""}\n${result.stderr ?? ""}`.trim();
	if (/chrome.*not found|browser.*not (?:found|installed)|could not (?:launch|find).*browser|failed to launch/i.test(detail)) {
		throw Object.assign(new Error(`MISSING agent-browser browser: ${detail}`), { missing: "agent-browser browser" });
	}
	if (result.error) throw new Error(`${result.error.message}${result.stderr ? `: ${result.stderr}` : ""}`);
	if (result.status !== 0) throw new Error(result.stderr || `agent-browser ${args[0]} failed`);
	return result.stdout;
}
function addEvidence(id, file, evidence) {
	if (evidence.includes(file)) return;
	evidence.push(file);
	console.log(`${file.toLowerCase().endsWith(".png") ? "SHOT" : "EVIDENCE"} ${id} ${file}`);
}
function captureFailure({ booted, journey, dir, evidence, pageOpen }) {
	if (interrupting) return;
	const pageLog = path.join(booted.root, "logs", "page.log");
	if (fs.existsSync(pageLog)) {
		const copy = path.join(dir, "failure-page.log");
		fs.copyFileSync(pageLog, copy);
		addEvidence(journey.id, copy, evidence);
	}
	if (booted.tmux) {
		try { const file = path.join(dir, "failure-terminal.txt"); fs.writeFileSync(file, tmux(booted, ["capture-pane", "-p", "-t", booted.tmux.session])); addEvidence(journey.id, file, evidence); } catch { /* terminal may have exited before failure capture */ }
	}
	if (pageOpen) {
		try { const file = path.join(dir, "failure-page.png"); browser(["screenshot", file], booted.browserSession); addEvidence(journey.id, file, evidence); } catch { /* page may have exited before failure capture */ }
	}
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
	const pass = state.all && !state.failed && !state.missing && !state.explicitlyPending && !state.results.some((result) => result.outcome === "PENDING" || result.outcome === "MISSING") && clean.status === 0 && !clean.stdout.trim() && main.status === 0 && state.sha === main.stdout.trim() && !state.against && !!state.producedBy && state.producedBy !== "implementer";
	fs.writeFileSync(receiptFile, `${JSON.stringify({ sha: state.sha, criterion: "journeys", pass, produced_by: state.producedBy, evidence, summary: `${state.results.filter((result) => result.outcome === "PASS").length} active journey(s) passed on ${process.platform} with ${process.version}`, results: state.results, platform: process.platform, node: process.version }, null, 2)}\n`);
}
