// A stand-in for a model, on loopback: an OpenAI-compatible chat endpoint that streams the way pi
// reads it. It is what lets a loop run end to end with no provider and no network. Not this
// package's code, and it imports none of it.
//
//   node fake-model.mjs <port-file>     writes the port it listens on to <port-file>, then serves
//
// FAKE_MODEL_REPLY is what it says. With FAKE_MODEL_TOOL_COMMAND set, a conversation that has no
// tool result yet is answered with one `bash` call running that command, and the conversation that
// comes back with the result gets FAKE_MODEL_REPLY — one tool call, then the reply, the shape of a
// run that does one thing and reports it.
import * as fs from "node:fs";
import * as http from "node:http";

const reply = process.env.FAKE_MODEL_REPLY ?? "nothing to report";
const toolCommand = process.env.FAKE_MODEL_TOOL_COMMAND;
const portFile = process.argv[2];
if (!portFile) {
	process.stderr.write("fake-model: give the file to write the port to\n");
	process.exit(2);
}

const chunk = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const sse = (res, delta, finish) => res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })}\n\n`);

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
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
		if (toolCommand && !messages.some((m) => m.role === "tool")) {
			sse(res, { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: toolCommand }) } }] }, null);
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
