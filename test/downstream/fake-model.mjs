// A stand-in for a model, on loopback: an OpenAI-compatible chat endpoint that answers every
// request with FAKE_MODEL_REPLY, streamed the way pi reads it. It is what lets a loop run end to end
// with no provider and no network. Not this package's code, and it imports none of it.
//
//   node fake-model.mjs <port-file>     writes the port it listens on to <port-file>, then serves
import * as fs from "node:fs";
import * as http from "node:http";

const reply = process.env.FAKE_MODEL_REPLY ?? "nothing to report";
const portFile = process.argv[2];
if (!portFile) {
	process.stderr.write("fake-model: give the file to write the port to\n");
	process.exit(2);
}

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		if (!req.url.endsWith("/chat/completions")) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
		res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, `${server.address().port}\n`));
