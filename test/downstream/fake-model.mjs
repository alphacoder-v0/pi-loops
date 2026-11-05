// A stand-in for a model, on loopback: an OpenAI-compatible chat endpoint that streams the way pi
// reads it. It is what lets a loop run end to end with no provider and no network. Not this
// package's code, and it imports none of it.
//
//   node fake-model.mjs <port-file>     writes the port it listens on to <port-file>, then serves
//
// FAKE_MODEL_REPLY is what it says. FAKE_MODEL_LOG=<file> appends each raw request body as one JSON line.
// With FAKE_MODEL_TOOL_COMMAND set, a conversation that has no tool result yet is answered with one
// `bash` call running that command, and the conversation that
// comes back with the result gets FAKE_MODEL_REPLY — one tool call, then the reply, the shape of a
// run that does one thing and reports it.
// With FAKE_MODEL_TOOL_SCRIPT set to a JSON list of {match, tool, args}, a conversation whose last
// user message contains `match` and has no tool result after it is answered with that one tool
// call; with the result back, FAKE_MODEL_REPLY. The first entry that matches wins.
// With FAKE_MODEL_RULE_PATHS set, a rule check (a prompt with "Dynamic trigger rules:") is answered
// as a model that looked would answer it: `matched <ids>` for the rules whose condition names a
// ~/ or $HOME/ path that exists under $HOME, else the no-match sentence.
import * as fs from "node:fs";
import * as http from "node:http";

const reply = process.env.FAKE_MODEL_REPLY ?? "nothing to report";
const toolCommand = process.env.FAKE_MODEL_TOOL_COMMAND;
const toolScript = process.env.FAKE_MODEL_TOOL_SCRIPT ? JSON.parse(process.env.FAKE_MODEL_TOOL_SCRIPT) : [];
const portFile = process.argv[2];
if (!portFile) {
	process.stderr.write("fake-model: give the file to write the port to\n");
	process.exit(2);
}

const chunk = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const sse = (res, delta, finish) => res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`);
const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => (typeof c === "string" ? c : c?.text ?? "")).join(""));

/** The scripted call for this conversation, or undefined: the last user message's text picks it, unless a tool result already followed it. */
function scripted(messages) {
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { last = i; break; }
	if (last === -1 || messages.slice(last).some((m) => m.role === "tool")) return undefined;
	const text = textOf(messages[last]);
	return toolScript.find((s) => text.includes(s.match));
}

/** The answer to a rule check, from the paths its rules name; undefined for any other conversation. */
function ruleCheckReply(messages) {
	const user = [...messages].reverse().find((m) => m.role === "user");
	const listed = user && /Dynamic trigger rules:\n(\[[\s\S]*?\n\])/.exec(textOf(user));
	if (!listed) return undefined;
	let rules = [];
	try {
		rules = JSON.parse(listed[1]);
	} catch {
		return undefined; // not the list a check carries: answered as any other conversation
	}
	const hits = rules.filter((r) => {
		const p = /(?:~|\$HOME)\/(\S+)/.exec(String(r.condition ?? ""));
		return p && fs.existsSync(`${process.env.HOME}/${p[1]}`);
	});
	return hits.length ? `matched ${hits.map((r) => r.id).join(" ")}. it is there` : "no dynamic trigger rule matched";
}

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (process.env.FAKE_MODEL_LOG) fs.appendFileSync(process.env.FAKE_MODEL_LOG, `${body}\n`);
		if (!req.url.endsWith("/chat/completions")) {
			res.writeHead(404);
			res.end();
			return;
		}
		let messages = [];
		try {
			messages = JSON.parse(body).messages ?? [];
		} catch {
			/* not JSON: answered like an empty conversation */
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const call = toolCommand && !messages.some((m) => m.role === "tool") ? { tool: "bash", args: { command: toolCommand } } : scripted(messages);
		const looked = !call && process.env.FAKE_MODEL_RULE_PATHS ? ruleCheckReply(messages) : undefined;
		if (looked !== undefined) {
			sse(res, { role: "assistant", content: looked }, null);
			sse(res, {}, "stop");
		} else if (call) {
			sse(res, { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args ?? {}) } }] }, null);
			sse(res, {}, "tool_calls");
		} else {
			sse(res, { role: "assistant", content: reply }, null);
			sse(res, {}, "stop");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, `${server.address().port}\n`));
