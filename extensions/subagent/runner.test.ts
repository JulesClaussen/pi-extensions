import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { runChild } from "./runner.ts";

const node = (script: string) => ({ command: process.execPath, args: ["-e", script] });

describe("runChild", () => {
	it("parses LF-framed JSONL across chunk boundaries and skips noise", async () => {
		const script = `
			const w = (s) => process.stdout.write(s);
			w('{"type":"a","text":"h\u00e9');
			setTimeout(() => { w('llo"}\\r\\nnot json\\n\\n{"type":"b","sep":"x\u2028y"}\\n{"type":"c"}'); }, 20);
			console.error("warn");
		`;
		const events: unknown[] = [];
		const result = await runChild(node(script), { cwd: tmpdir(), env: process.env, onEvent: (e) => events.push(e) });
		assert.equal(result.exitCode, 0);
		assert.equal(result.aborted, false);
		assert.match(result.stderr, /warn/);
		assert.deepEqual(events, [{ type: "a", text: "héllo" }, { type: "b", sep: "x\u2028y" }, { type: "c" }]);
	});

	it("passes cwd and env to the child", async () => {
		const events: unknown[] = [];
		await runChild(node("console.log(JSON.stringify({ cwd: process.cwd(), flag: process.env.PI_SUBAGENT_DEPTH }))"), {
			cwd: "/",
			env: { ...process.env, PI_SUBAGENT_DEPTH: "1" },
			onEvent: (e) => events.push(e),
		});
		assert.deepEqual(events, [{ cwd: "/", flag: "1" }]);
	});

	it("reports non-zero exits", async () => {
		const result = await runChild(node("process.exit(3)"), { cwd: tmpdir(), env: process.env, onEvent: () => {} });
		assert.equal(result.exitCode, 3);
	});

	it("reports spawn failures", async () => {
		const result = await runChild(
			{ command: "/nonexistent/pi", args: [] },
			{ cwd: tmpdir(), env: process.env, onEvent: () => {} },
		);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /ENOENT/);
	});

	it("kills the child on abort", async () => {
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 50);
		const result = await runChild(node("setInterval(() => {}, 1000)"), {
			cwd: tmpdir(),
			env: process.env,
			signal: controller.signal,
			onEvent: () => {},
		});
		assert.equal(result.aborted, true);
		assert.ok(Date.now() - started < 3000);
	});

	it("does not spawn when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runChild(node("console.log('{}')"), {
			cwd: tmpdir(),
			env: process.env,
			signal: controller.signal,
			onEvent: () => assert.fail("should not run"),
		});
		assert.equal(result.aborted, true);
	});
});
