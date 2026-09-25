import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyEvent,
	buildArgs,
	childEnv,
	DEFAULT_CONCURRENCY,
	DEPTH_ENV,
	finishRun,
	isSubagentProcess,
	labelsFor,
	MAX_TASKS,
	mapWithConcurrency,
	newRun,
	resolveConcurrency,
	resolveCwd,
	summarize,
	toolPreview,
	totalUsage,
	truncateBytes,
	WORKER_PROMPT,
} from "./rules.ts";

const run = () => newRun("do it", "/repo", "anthropic/claude-opus-5-5", "medium", "repo");

const assistant = (message: Record<string, unknown>) => ({
	type: "message_end",
	message: { role: "assistant", content: [], ...message },
});

describe("recursion guard", () => {
	it("marks children and recognises them", () => {
		assert.equal(isSubagentProcess({}), false);
		const env = childEnv({ PATH: "/bin" });
		assert.equal(env.PATH, "/bin");
		assert.equal(env[DEPTH_ENV], "1");
		assert.equal(isSubagentProcess(env), true);
	});
});

describe("buildArgs", () => {
	it("runs headless, ephemeral, with the given model and thinking", () => {
		const args = buildArgs("fix the bug", "anthropic/claude-haiku-4-5", "low");
		assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
		assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-haiku-4-5");
		assert.equal(args[args.indexOf("--thinking") + 1], "low");
		assert.equal(args[args.indexOf("--append-system-prompt") + 1], WORKER_PROMPT);
		assert.equal(args.at(-1), "Task: fix the bug");
	});

	it("never passes flags that would drop extensions", () => {
		const args = buildArgs("x", "m", "medium");
		assert.ok(!args.includes("--no-extensions") && !args.includes("-ne"));
		assert.ok(!args.includes("--tools"));
	});
});

describe("resolveCwd", () => {
	const cases: Array<[string | undefined, string]> = [
		[undefined, "/base"],
		["", "/base"],
		["/abs/repo", "/abs/repo"],
		["sub/repo", "/base/sub/repo"],
		["../other", "/other"],
		["~", "/home/u"],
		["~/code/repo", "/home/u/code/repo"],
	];
	for (const [input, expected] of cases) {
		it(`${input} → ${expected}`, () => assert.equal(resolveCwd("/base", input, "/home/u"), expected));
	}
});

describe("resolveConcurrency", () => {
	it("defaults, clamps to task count and MAX_TASKS", () => {
		assert.equal(resolveConcurrency(undefined, 20), DEFAULT_CONCURRENCY);
		assert.equal(resolveConcurrency(undefined, 2), 2);
		assert.equal(resolveConcurrency(100, 100), MAX_TASKS);
		assert.equal(resolveConcurrency(0, 5), 1);
	});
});

describe("mapWithConcurrency", () => {
	it("keeps order and never exceeds the limit", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapWithConcurrency([30, 10, 20, 5, 15], 2, async (ms, i) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, ms));
			active--;
			return i;
		});
		assert.deepEqual(out, [0, 1, 2, 3, 4]);
		assert.equal(peak, 2);
	});
});

describe("labelsFor", () => {
	it("uses basenames and disambiguates duplicates", () => {
		assert.deepEqual(labelsFor(["/c/a", "/c/b", "/x/a"]), ["a#1", "b", "a#2"]);
	});
});

describe("applyEvent", () => {
	it("ignores non-assistant events", () => {
		const r = run();
		assert.equal(applyEvent(r, { type: "message_end", message: { role: "user", content: "hi" } }), false);
		assert.equal(applyEvent(r, { type: "tool_execution_end" }), false);
		assert.equal(applyEvent(r, null), false);
		assert.equal(r.turns, 0);
	});

	it("accumulates usage, turns, tool previews and the final text", () => {
		const r = run();
		applyEvent(
			r,
			assistant({
				content: [{ type: "toolCall", name: "bash", arguments: { command: "git status" } }],
				usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.01 } },
				stopReason: "toolUse",
			}),
		);
		applyEvent(
			r,
			assistant({
				content: [{ type: "text", text: "## Status\ndone" }],
				usage: { input: 200, output: 20, totalTokens: 330, cost: { total: 0.02 } },
				stopReason: "stop",
			}),
		);
		assert.equal(r.turns, 2);
		assert.equal(r.usage.input, 300);
		assert.equal(r.usage.output, 30);
		assert.ok(Math.abs(r.usage.cost.total - 0.03) < 1e-9);
		assert.equal(r.contextTokens, 330);
		assert.equal(r.output, "## Status\ndone");
		assert.deepEqual(r.items, [
			{ type: "tool", text: "$ git status" },
			{ type: "text", text: "## Status" },
		]);
	});

	it("joins every text block of the last assistant message", () => {
		const r = run();
		applyEvent(
			r,
			assistant({
				content: [
					{ type: "text", text: "checking" },
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "## Status\ndone" },
				],
			}),
		);
		assert.equal(r.output, "checking\n\n## Status\ndone");
		applyEvent(r, assistant({ content: [{ type: "toolCall", name: "ls", arguments: {} }] }));
		assert.equal(r.output, "checking\n\n## Status\ndone");
	});

	it("keeps only the latest display items", () => {
		const r = run();
		for (let i = 0; i < 40; i++) {
			applyEvent(r, assistant({ content: [{ type: "toolCall", name: "read", arguments: { path: `f${i}` } }] }));
		}
		assert.equal(r.items.length, 30);
		assert.equal(r.items.at(-1)?.text, "read f39");
	});
});

describe("toolPreview", () => {
	it("summarises without storing payloads", () => {
		assert.equal(toolPreview("write", { path: "a.ts", content: "x".repeat(10_000) }), "write a.ts");
		assert.ok(toolPreview("bash", { command: "y".repeat(500) }).length < 100);
	});
});

describe("finishRun", () => {
	it("done on clean exit", () => {
		const r = run();
		r.stopReason = "stop";
		finishRun(r, 0, "", false);
		assert.equal(r.status, "done");
	});

	it("failed on non-zero exit, with stderr as the error", () => {
		const r = run();
		finishRun(r, 1, "boom\n", false);
		assert.equal(r.status, "failed");
		assert.equal(r.error, "boom");
	});

	it("failed on an error stop reason even with exit 0", () => {
		const r = run();
		applyEvent(r, assistant({ stopReason: "error", errorMessage: "rate limited" }));
		finishRun(r, 0, "", false);
		assert.equal(r.status, "failed");
		assert.equal(r.error, "rate limited");
	});

	it("aborted wins", () => {
		const r = run();
		finishRun(r, 1, "killed", true);
		assert.equal(r.status, "aborted");
	});
});

describe("summarize / usage", () => {
	it("reports every task with its status and cwd", () => {
		const a = run();
		applyEvent(a, assistant({ content: [{ type: "text", text: "all good" }], usage: { input: 5 } }));
		finishRun(a, 0, "", false);
		const b = newRun("t", "/other", "m", "low", "other");
		finishRun(b, 2, "no auth", false);
		const text = summarize([a, b]);
		assert.match(text, /^Workers: 1\/2 succeeded/);
		assert.match(text, /### \[repo\] done — \/repo\n\nall good/);
		assert.match(text, /### \[other\] failed — \/other\n\nno auth/);
		assert.equal(totalUsage([a, b]).input, 5);
	});

	it("truncates on a byte budget without splitting characters", () => {
		const out = truncateBytes("é".repeat(100), 51);
		assert.ok(!out.includes("\uFFFD"));
		assert.match(out, /Output truncated: \d+ bytes omitted/);
		assert.equal(truncateBytes("short", 51), "short");
	});
});
