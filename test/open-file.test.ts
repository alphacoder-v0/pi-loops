import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { openFileDir, openFileHtml, removeOpenFile, sweepOpenFiles, writeOpenFile } from "../src/open-file.ts";
import { tmp } from "./tmp.ts";

test("an open file sends the browser to its address and nowhere else, whatever the address holds", () => {
	const html = openFileHtml(`http://127.0.0.1:4173/c/s1/?open=k&x="</script><b>`);
	assert.ok(html.includes(`content="0;url=http://127.0.0.1:4173/c/s1/?open=k&amp;x=&quot;&lt;/script&gt;&lt;b&gt;"`), "the attribute is escaped");
	assert.ok(html.includes(`location.replace("http://127.0.0.1:4173/c/s1/?open=k&x=\\"\\u003c/script>\\u003cb>")`), "the script cannot be ended from the address");
	assert.equal(html.match(/<script>/g)?.length, 1);
	assert.match(html, /<noscript><meta http-equiv="refresh"/, "the refresh only where no script runs, so the key is not asked for twice");
});

test("open files are written 0600 in a 0700 directory under the loops dir, removed one by one, and swept", () => {
	const dir = tmp("pi-loops-open-file-");
	fs.mkdirSync(path.join(dir, "pages", "open"), { recursive: true, mode: 0o755 });
	const file = writeOpenFile(dir, "http://127.0.0.1:4173/c/s1/?open=k1");
	assert.equal(path.dirname(file), openFileDir(dir));
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.statSync(openFileDir(dir)).mode & 0o777, 0o700, "a directory that was there with a looser mode is closed");
	assert.notEqual(writeOpenFile(dir, "http://x/"), file, "each file has a name of its own");
	removeOpenFile(file);
	removeOpenFile(file);
	assert.equal(fs.existsSync(file), false, "and removing it twice is fine");
	sweepOpenFiles(dir);
	assert.equal(fs.existsSync(openFileDir(dir)), false);
	sweepOpenFiles(dir);
});
