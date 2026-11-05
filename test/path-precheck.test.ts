import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmp } from "./tmp.ts";
import { PathLooks, lookAt, lookLine, pathOnlyCondition, watchOf, type PathWatch } from "../src/path-precheck.ts";
import { TriggerStore } from "../src/triggers.ts";

const at = { cwd: "/work/proj", home: "/home/me" };
const watched = (condition: string) => {
	const r = pathOnlyCondition(condition, at);
	assert.ok("watch" in r, `${condition}: refused (${"why" in r ? r.why : ""})`);
	return r.watch;
};
const refused = (condition: string) => {
	const r = pathOnlyCondition(condition, at);
	assert.ok("why" in r, `${condition}: accepted as ${JSON.stringify(r)}`);
	return r.why;
};

test("path-only conditions: ~, $HOME, ${HOME}, absolute, relative, a quoted space, English and Chinese", () => {
	assert.deepEqual(watched("~/build.done appears"), { v: 1, of: "~/build.done appears", raw: "~/build.done", resolved: "/home/me/build.done" });
	assert.equal(watched("when ~/build.done exists").resolved, "/home/me/build.done");
	assert.equal(watched("$HOME/helloworld exists").resolved, "/home/me/helloworld");
	assert.equal(watched("${HOME}/out/x.txt is created").resolved, "/home/me/out/x.txt");
	assert.equal(watched("$HOME/helloworld 存在").resolved, "/home/me/helloworld");
	assert.equal(watched("当 $HOME/helloworld 存在的时候").resolved, "/home/me/helloworld");
	assert.equal(watched("~/x 文件存在").resolved, "/home/me/x", "a noun set apart by a space is the noun");
	// A noun at the end of the path is part of its name.
	assert.equal(watched("~/备份文件 存在").resolved, "/home/me/备份文件");
	assert.equal(watched("~/data/备份目录 存在").resolved, "/home/me/data/备份目录");
	assert.equal(watched("/tmp/目录 存在").resolved, "/tmp/目录");
	assert.equal(watched("~/x文件存在").resolved, "/home/me/x文件");
	assert.equal(watched("./dist/app.js is created").resolved, "/work/proj/dist/app.js");
	assert.equal(watched("dist/app.js appears").resolved, "/work/proj/dist/app.js");
	assert.equal(watched("../other/ready shows up").resolved, "/work/other/ready");
	assert.equal(watched("build.done appears.").resolved, "/work/proj/build.done");
	assert.equal(watched('"~/My Files/done.txt" exists').resolved, "/home/me/My Files/done.txt");
	assert.equal(watched("the file `/tmp/ready` is there").resolved, "/tmp/ready");
	assert.equal(watched("/tmp/ready appears").raw, "/tmp/ready");
	assert.equal(watched("如果 ~/a/b 出现").resolved, "/home/me/a/b");
});

test("refused as path-only, each with why: a glob, an extra clause, two paths, not exists, a bare word, other variables, ~user, a URL", () => {
	assert.match(refused("~/logs/*.log appears"), /glob/);
	assert.match(refused("~/logs/{a,b} appears"), /glob/);
	assert.match(refused("~/x appears and it contains ERROR"), /extra clause/);
	assert.match(refused("when ~/x appears and it contains ERROR"), /extra clause/);
	assert.match(refused("~/x exists or ~/y exists"), /extra clause/);
	assert.match(refused("~/x 存在并且非空"), /extra clause/);
	assert.match(refused("~/a is newer than ~/b"), /not only that the path exists or appears/);
	assert.match(refused("~/a is deleted"), /not only/);
	assert.match(refused("README exists"), /not clearly a path/);
	assert.match(refused("$TMPDIR/x exists"), /only \$HOME/);
	assert.match(refused("/tmp/$USER/x exists"), /only \$HOME/);
	assert.match(refused("~bob/x exists"), /your own home/);
	assert.match(refused("https://example.com/x appears"), /URL/);
	for (const p of ["//server/share/x", "/net/box/x", "/Network/Servers/x"]) assert.equal(refused(`${p} exists`), "a network path needs the model");
	assert.match(refused('"~/x exists'), /quote/);
	assert.match(refused("~/x"), /no verb/);
	assert.match(refused(""), /empty/);
	assert.match(refused(`/${"a".repeat(1100)} exists`), /longer than/);
	assert.match(refused("a PR of mine gets a review asking for changes"), /not/);
});

test("watchOf: only while the condition is the one the watch was read from", () => {
	const w = watched("~/build.done appears");
	assert.deepEqual(watchOf({ condition: "~/build.done appears", precheck: w }), w);
	assert.equal(watchOf({ condition: "~/build.done appears and is not empty", precheck: w }), undefined, "a hand edit is model-checked");
	assert.equal(watchOf({ condition: "~/build.done appears" }), undefined, "a rule from before the pre-check");
	assert.equal(watchOf({ condition: "~/build.done appears", precheck: { ...w, v: 2 } }), undefined);
	assert.equal(watchOf({ condition: "~/build.done appears", precheck: { ...w, resolved: "rel/x" } }), undefined);
});

test("lookAt: present, absent, a dangling symlink, an error and a hang are unknown", async () => {
	const dir = tmp("pi-loops-precheck-");
	const w = (p: string): PathWatch => ({ v: 1, of: "x", raw: p, resolved: p });
	const file = path.join(dir, "here");
	fs.writeFileSync(file, "");
	assert.equal(await lookAt(w(file)), "present");
	assert.equal(await lookAt(w(path.join(dir, "gone"))), "absent");
	assert.equal(await lookAt(w(path.join(file, "under-a-file"))), "absent", "ENOTDIR");
	fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "link"));
	assert.equal(await lookAt(w(path.join(dir, "link"))), "absent", "a dangling link");
	fs.writeFileSync(path.join(dir, "nowhere"), "");
	assert.equal(await lookAt(w(path.join(dir, "link"))), "present", "the link's target exists now");
	assert.equal(await lookAt(w(file), { stat: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) }), "unknown");
	const t0 = Date.now();
	assert.equal(await lookAt(w(file), { stat: () => new Promise(() => {}), timeoutMs: 50 }), "unknown");
	assert.ok(Date.now() - t0 < 1000);
});

test("PathLooks: one stat in flight per rule; a second look while it hangs is unknown and starts nothing", async () => {
	let calls = 0;
	let settle: () => void = () => {};
	const looks = new PathLooks({ timeoutMs: 30, stat: () => { calls++; return new Promise<void>((resolve) => { settle = resolve; }); } });
	const w: PathWatch = { v: 1, of: "x", raw: "/x", resolved: "/x" };
	assert.equal(await looks.look("dyn-a", w), "unknown", "timed out");
	assert.equal(await looks.look("dyn-a", w), "unknown");
	assert.equal(calls, 1, "no second stat while the first is out");
	settle();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(await looks.look("dyn-a", w), "unknown");
	assert.equal(calls, 2, "a new stat once the first settled");
});

test("PathLooks: at most two stats out in the whole process, and one per path; past the cap a look is unknown and starts nothing", async () => {
	let calls = 0;
	const hang = () => { calls++; return new Promise<void>(() => {}); };
	const looks = new PathLooks({ timeoutMs: 20, stat: hang });
	const w = (p: string): PathWatch => ({ v: 1, of: "x", raw: p, resolved: p });
	assert.equal(await looks.look("dyn-a", w("/a")), "unknown");
	assert.equal(await looks.look("dyn-b", w("/a")), "unknown", "the same path under another rule");
	assert.equal(calls, 1);
	assert.equal(await looks.look("dyn-c", w("/c")), "unknown");
	assert.equal(calls, 2);
	assert.equal(await looks.look("dyn-d", w("/d")), "unknown", "the third is past the cap");
	assert.equal(calls, 2, "and started nothing");
});

test("lookLine: the three things the rule row says", () => {
	const clock = () => "09:22";
	assert.equal(lookLine("absent", 1, clock), "next look 09:22 · no model call until the file exists");
	assert.equal(lookLine(undefined, undefined, clock), "no model call until the file exists");
	assert.equal(lookLine("present", 1, clock), "the file is there · the next look asks the model");
	assert.equal(lookLine("unknown", 1, clock), "could not look at the path · checked by the model");
});

test("TriggerStore.add records the pre-check with ~ resolved in the creating process; setEnabled keeps it", async () => {
	const dir = tmp("pi-loops-precheck-store-");
	const home = path.join(dir, "home");
	const saved = process.env.HOME;
	process.env.HOME = home;
	try {
		const store = new TriggerStore(dir);
		const rule = await store.add({ condition: "~/build.done appears", action: "tell me", cwd: dir });
		assert.deepEqual(rule.precheck, { v: 1, of: "~/build.done appears", raw: "~/build.done", resolved: path.join(home, "build.done") });
		const rel = await store.add({ condition: "out/ready exists", action: "tell me", cwd: dir });
		assert.equal(rel.precheck?.resolved, path.join(dir, "out/ready"));
		const not = await store.add({ condition: "~/x appears and it contains ERROR", action: "tell me", cwd: dir });
		assert.equal(not.precheck, undefined);
		await store.setEnabled(rule.id, false);
		await store.setEnabled(rule.id, true);
		assert.deepEqual(store.load().find((r) => r.id === rule.id)?.precheck, rule.precheck, "survives a rewrite of the file");
	} finally {
		if (saved === undefined) delete process.env.HOME;
		else process.env.HOME = saved;
	}
});
