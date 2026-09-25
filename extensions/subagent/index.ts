/**
 * subagent
 *
 * `subagent` tool: fans self-contained tasks out to worker processes. Each worker is a
 * headless `pi --mode json -p` child, so it loads the same settings, packages and
 * extensions (command-guard included) as the parent, plus the AGENTS.md of its cwd.
 * Without a UI, anything a guard would ask about is blocked in the worker.
 *
 * Workers default to DEFAULT_MODEL / DEFAULT_THINKING; each task can override both.
 * Workers never get the tool themselves (DEPTH_ENV), so fan-out is one level deep.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	applyEvent,
	buildArgs,
	childEnv,
	DEFAULT_MODEL,
	DEFAULT_THINKING,
	failRun,
	finishRun,
	formatUsage,
	isSubagentProcess,
	labelsFor,
	MAX_TASKS,
	mapWithConcurrency,
	newRun,
	resolveConcurrency,
	resolveCwd,
	summarize,
	THINKING_LEVELS,
	totalUsage,
	type WorkerRun,
} from "./rules.ts";
import { piInvocation, runChild } from "./runner.ts";

interface Details {
	runs: WorkerRun[];
}

const COLLAPSED_ITEMS = 4;

const TaskSchema = Type.Object({
	task: Type.String({
		description:
			"Complete, self-contained instructions: goal, constraints, relevant files, how to validate, and whether to commit/push. The worker cannot see this conversation.",
	}),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory (absolute, ~/…, or relative to the current cwd). Default: current cwd.",
		}),
	),
	model: Type.Optional(Type.String({ description: `Model as provider/id. Default: ${DEFAULT_MODEL}.` })),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVELS, { description: `Thinking level. Default: ${DEFAULT_THINKING}.` }),
	),
});

const Params = Type.Object({
	tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS, description: "Tasks to run in parallel." }),
	concurrency: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_TASKS, description: "Max workers running at once. Default: 6." }),
	),
});

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function statusIcon(run: WorkerRun, theme: Theme): string {
	switch (run.status) {
		case "pending":
			return theme.fg("muted", "○");
		case "running":
			return theme.fg("warning", "⏳");
		case "done":
			return theme.fg("success", "✓");
		default:
			return theme.fg("error", "✗");
	}
}

function runHeader(run: WorkerRun, theme: Theme): string {
	let header = `${statusIcon(run, theme)} ${theme.fg("accent", theme.bold(run.label))}`;
	if (run.model !== DEFAULT_MODEL || run.thinking !== DEFAULT_THINKING) {
		header += theme.fg("muted", ` ${run.model}:${run.thinking}`);
	}
	const usage = formatUsage(run.usage, run.turns, run.contextTokens);
	if (usage) header += theme.fg("dim", ` ${usage}`);
	return header;
}

export default function (pi: ExtensionAPI) {
	if (isSubagentProcess(process.env)) return;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate self-contained tasks to worker subagents running in parallel.",
			"Each task runs in a separate headless pi process with the same extensions and guards, the AGENTS.md of its cwd, and an isolated context: it cannot see this conversation, so each task must stand alone.",
			`Up to ${MAX_TASKS} tasks per call. Default model ${DEFAULT_MODEL} with ${DEFAULT_THINKING} thinking; set model/thinking per task for lighter work.`,
			"Workers can commit and push feature branches but cannot open PRs or run other actions needing approval: open PRs yourself from their reports.",
		].join(" "),
		promptSnippet: "Delegate self-contained tasks (e.g. one per repository) to parallel worker subagents",
		parameters: Params,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const home = homedir();
			const cwds = params.tasks.map((t) => resolveCwd(ctx.cwd, t.cwd, home));
			const labels = labelsFor(cwds);
			const runs = params.tasks.map((t, i) =>
				newRun(t.task, cwds[i], t.model ?? DEFAULT_MODEL, t.thinking ?? DEFAULT_THINKING, labels[i]),
			);

			const emit = () => {
				const done = runs.filter((r) => r.status !== "pending" && r.status !== "running").length;
				onUpdate?.({
					content: [{ type: "text", text: `Workers: ${done}/${runs.length} finished` }],
					details: { runs: structuredClone(runs) },
				});
			};

			const env = childEnv(process.env);
			await mapWithConcurrency(runs, resolveConcurrency(params.concurrency, runs.length), async (run) => {
				if (signal?.aborted) {
					run.status = "aborted";
					return;
				}
				if (!isDirectory(run.cwd)) {
					failRun(run, `Working directory does not exist: ${run.cwd}`);
					emit();
					return;
				}
				run.status = "running";
				emit();
				const result = await runChild(piInvocation(buildArgs(run.task, run.model, run.thinking)), {
					cwd: run.cwd,
					env,
					signal,
					onEvent: (event) => {
						if (applyEvent(run, event)) emit();
					},
				});
				finishRun(run, result.exitCode, result.stderr, result.aborted);
				emit();
			});

			if (signal?.aborted) throw new Error("Subagent run aborted");
			return {
				content: [{ type: "text", text: summarize(runs) }],
				details: { runs } satisfies Details,
				usage: totalUsage(runs),
			};
		},

		renderCall(args, theme) {
			const tasks = args.tasks ?? [];
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `${tasks.length} task(s)`);
			for (const t of tasks.slice(0, 5)) {
				const preview = t.task?.length > 60 ? `${t.task.slice(0, 60)}…` : (t.task ?? "");
				text += `\n  ${theme.fg("accent", t.cwd ?? ".")} ${theme.fg("dim", preview)}`;
			}
			if (tasks.length > 5) text += `\n  ${theme.fg("muted", `… +${tasks.length - 5} more`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as Details | undefined;
			if (!details?.runs.length) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			const { runs } = details;
			const finished = runs.filter((r) => r.status !== "pending" && r.status !== "running");
			const ok = runs.filter((r) => r.status === "done").length;
			const total = formatUsage(totalUsage(runs));
			const summary = isPartial
				? `${finished.length}/${runs.length} finished`
				: `${ok}/${runs.length} succeeded${total ? ` · ${total}` : ""}`;

			if (expanded && !isPartial) {
				const container = new Container();
				container.addChild(
					new Text(theme.fg("toolTitle", theme.bold("workers ")) + theme.fg("accent", summary), 0, 0),
				);
				for (const run of runs) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${runHeader(run, theme)}\n${theme.fg("dim", run.cwd)}`, 0, 0));
					if (run.error) container.addChild(new Text(theme.fg("error", run.error), 0, 0));
					if (run.output) container.addChild(new Markdown(run.output.trim(), 0, 0, getMarkdownTheme()));
				}
				return container;
			}

			let text = theme.fg("toolTitle", theme.bold("workers ")) + theme.fg("accent", summary);
			for (const run of runs) {
				text += `\n${runHeader(run, theme)}`;
				if (run.status === "failed" && run.error) text += `\n  ${theme.fg("error", run.error.split("\n")[0])}`;
				for (const item of run.items.slice(-COLLAPSED_ITEMS)) {
					text += `\n  ${theme.fg(item.type === "tool" ? "muted" : "toolOutput", item.text)}`;
				}
			}
			if (!isPartial) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
