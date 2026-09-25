import { basename, isAbsolute, resolve } from "node:path";

export const DEFAULT_MODEL = "anthropic/claude-opus-5-5";
export const DEFAULT_THINKING = "medium";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const MAX_TASKS = 12;
export const DEFAULT_CONCURRENCY = 6;
export const OUTPUT_CAP_BYTES = 50 * 1024;

/** Set on every worker process so a worker never registers the tool itself (no recursive fan-out). */
export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";

export const WORKER_PROMPT = `You are a worker subagent. A parent agent delegated one self-contained task to you. You cannot see its conversation and cannot ask it questions while you run: work autonomously in your current working directory.

- Follow the repository's own instructions (AGENTS.md / CLAUDE.md); they are loaded as project context.
- Keep changes minimal and scoped to the task. Run the repository's lint, typecheck and tests when they exist and are reasonably fast.
- Git: when the task asks for a commit, push or PR, work on a feature branch (create one if you are on the default branch), commit with a Conventional Commits message and push with \`git push -u origin HEAD\`. Never force-push and never push to main/master.
- Do not run \`gh pr create\` or any other mutating \`gh\` command: there is no UI to approve them. The parent opens PRs from your report.
- If a guard blocks a command, do not work around it. Stop and report it.
- If the task is ambiguous or needs a decision you are not authorised to make, do the safe part and report the open question instead of guessing.

Finish with exactly this report:

## Status
done | partial | blocked — one line why.

## Changes
- \`path\` — what changed

## Git
Branch, commit SHA(s), pushed yes/no.

## PR
Title and body to use. Omit this section if no PR was requested.

## Notes
Validation run and results, blockers, open questions.`;

export type Env = Record<string, string | undefined>;

export function isSubagentProcess(env: Env): boolean {
	return Boolean(env[DEPTH_ENV]);
}

export function childEnv(env: Env): Env {
	return { ...env, [DEPTH_ENV]: "1" };
}

export function buildArgs(task: string, model: string, thinking: ThinkingLevel): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		model,
		"--thinking",
		thinking,
		"--append-system-prompt",
		WORKER_PROMPT,
		`Task: ${task}`,
	];
}

export function resolveCwd(base: string, cwd: string | undefined, home: string): string {
	if (!cwd) return base;
	const expanded = cwd === "~" ? home : cwd.startsWith("~/") ? `${home}${cwd.slice(1)}` : cwd;
	return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function resolveConcurrency(requested: number | undefined, taskCount: number): number {
	const wanted = requested ?? DEFAULT_CONCURRENCY;
	return Math.max(1, Math.min(Math.floor(wanted), MAX_TASKS, taskCount));
}

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results: TOut[] = new Array(items.length);
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(lanes);
	return results;
}

// ── Worker run state ─────────────────────────────────────────────────────

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface DisplayItem {
	type: "text" | "tool";
	text: string;
}

const MAX_ITEMS = 30;
const PREVIEW_CHARS = 80;

export type RunStatus = "pending" | "running" | "done" | "failed" | "aborted";

export interface WorkerRun {
	label: string;
	task: string;
	cwd: string;
	model: string;
	thinking: ThinkingLevel;
	status: RunStatus;
	items: DisplayItem[];
	output: string;
	turns: number;
	contextTokens: number;
	usage: Usage;
	stopReason?: string;
	error?: string;
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(target: Usage, delta: Partial<Usage> | undefined): void {
	if (!delta) return;
	target.input += delta.input ?? 0;
	target.output += delta.output ?? 0;
	target.cacheRead += delta.cacheRead ?? 0;
	target.cacheWrite += delta.cacheWrite ?? 0;
	target.totalTokens += delta.totalTokens ?? 0;
	target.cost.input += delta.cost?.input ?? 0;
	target.cost.output += delta.cost?.output ?? 0;
	target.cost.cacheRead += delta.cost?.cacheRead ?? 0;
	target.cost.cacheWrite += delta.cost?.cacheWrite ?? 0;
	target.cost.total += delta.cost?.total ?? 0;
}

export function newRun(task: string, cwd: string, model: string, thinking: ThinkingLevel, label: string): WorkerRun {
	return {
		label,
		task,
		cwd,
		model,
		thinking,
		status: "pending",
		items: [],
		output: "",
		turns: 0,
		contextTokens: 0,
		usage: emptyUsage(),
	};
}

interface AssistantEventMessage {
	role: "assistant";
	content?: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
	usage?: Partial<Usage>;
	stopReason?: string;
	errorMessage?: string;
}

function isAssistantMessageEnd(event: unknown): event is { type: "message_end"; message: AssistantEventMessage } {
	if (typeof event !== "object" || event === null) return false;
	const e = event as { type?: unknown; message?: { role?: unknown } };
	return e.type === "message_end" && e.message?.role === "assistant";
}

/** Folds one JSON-mode event into the run. Returns true when the run changed. */
export function applyEvent(run: WorkerRun, event: unknown): boolean {
	if (!isAssistantMessageEnd(event)) return false;
	const message = event.message;
	run.turns++;
	addUsage(run.usage, message.usage);
	run.contextTokens = message.usage?.totalTokens ?? run.contextTokens;
	if (message.stopReason) run.stopReason = message.stopReason;
	if (message.errorMessage) run.error = message.errorMessage;
	const texts: string[] = [];
	for (const part of message.content ?? []) {
		if (part.type === "text" && part.text) {
			run.items.push({ type: "text", text: clip(part.text.trim().split("\n")[0] ?? "") });
			texts.push(part.text);
		} else if (part.type === "toolCall" && part.name) {
			run.items.push({ type: "tool", text: toolPreview(part.name, part.arguments ?? {}) });
		}
	}
	if (run.items.length > MAX_ITEMS) run.items.splice(0, run.items.length - MAX_ITEMS);
	if (texts.length) run.output = texts.join("\n\n");
	return true;
}

function clip(text: string): string {
	return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

export function toolPreview(name: string, args: Record<string, unknown>): string {
	const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	switch (name) {
		case "bash":
			return `$ ${clip(str("command") ?? "…")}`;
		case "read":
		case "write":
		case "edit":
		case "ls":
			return `${name} ${clip(str("path") ?? str("file_path") ?? ".")}`;
		default:
			return `${name} ${clip(JSON.stringify(args))}`;
	}
}

/** Short display names for tasks: the cwd basename, suffixed when two tasks share it. */
export function labelsFor(cwds: string[]): string[] {
	const names = cwds.map((cwd) => basename(cwd) || cwd);
	const seen = new Map<string, number>();
	return names.map((name) => {
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return names.filter((n) => n === name).length > 1 ? `${name}#${count}` : name;
	});
}

export function finishRun(run: WorkerRun, exitCode: number, stderr: string, aborted: boolean): void {
	if (aborted) {
		run.status = "aborted";
	} else if (exitCode !== 0 || run.stopReason === "error" || run.stopReason === "aborted") {
		run.status = "failed";
		run.error ||= stderr.trim() || `pi exited with code ${exitCode}`;
	} else {
		run.status = "done";
	}
}

export function failRun(run: WorkerRun, error: string): void {
	run.status = "failed";
	run.error = error;
}

export function truncateBytes(text: string, cap = OUTPUT_CAP_BYTES): string {
	const size = Buffer.byteLength(text, "utf8");
	if (size <= cap) return text;
	const kept = Buffer.from(text, "utf8")
		.subarray(0, cap)
		.toString("utf8")
		.replace(/\uFFFD$/, "");
	return `${kept}\n\n[Output truncated: ${size - Buffer.byteLength(kept, "utf8")} bytes omitted.]`;
}

export function totalUsage(runs: WorkerRun[]): Usage {
	const total = emptyUsage();
	for (const run of runs) addUsage(total, run.usage);
	return total;
}

/** Model-facing tool result text. */
export function summarize(runs: WorkerRun[]): string {
	const ok = runs.filter((r) => r.status === "done").length;
	const sections = runs.map((r) => {
		const body = r.status === "done" ? r.output || "(no output)" : r.error || r.output || "(no output)";
		return `### [${r.label}] ${r.status} — ${r.cwd}\n\n${truncateBytes(body)}`;
	});
	return `Workers: ${ok}/${runs.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: Usage, turns?: number, contextTokens?: number): string {
	const parts: string[] = [];
	if (turns) parts.push(`${turns} turn${turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	if (contextTokens) parts.push(`ctx:${formatTokens(contextTokens)}`);
	return parts.join(" ");
}
