/**
 * modes
 *
 * Three ways of working, switched with `/mode [apply|chat|plan]` or Ctrl+Alt+M:
 *
 *   apply — pi as-is; only command-guard applies
 *   chat  — every side effect asks first: `edit`, `write`, and `bash` unless read-only.
 *           MCP and other tools are untouched.
 *   plan  — Plannotator planning mode. Approving a plan switches to apply; leaving
 *           Plannotator without approval falls back to chat.
 *
 * command-guard runs independently on every call; this extension only adds gates,
 * it never loosens one. Sessions start in apply; the mode is persisted per session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MODE,
	type GateInput,
	isMode,
	MODES,
	type Mode,
	needsConfirmation,
	nextMode,
	previewEdits,
} from "./rules.ts";

const ENTRY_TYPE = "modes";
const STATUS_KEY = "modes";
const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session (this exact command/path)";
const DENY = "Deny";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";
const PLANNOTATOR_PLAN_APPROVED_CHANNEL = "plannotator:plan-approved";
const PLANNOTATOR_TIMEOUT_MS = 2_000;

type PlannotatorPhase = "idle" | "planning" | "executing";
type PlannotatorPlanModeMode = "enter" | "exit" | "status";
type PlannotatorResponse =
	| { status: "handled"; result: { phase: PlannotatorPhase } }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };

const CHAT_NOTE = `[CHAT MODE]
The user is in chat mode: they want to discuss, not have you act. Every edit, write and non-read-only shell command will interrupt them with a confirmation prompt. Prefer explaining, answering, and showing proposed changes as snippets. Only call mutating tools when the user clearly asked for that action.`;

export default function (pi: ExtensionAPI) {
	let mode: Mode = DEFAULT_MODE;
	const sessionGrants = new Set<string>();

	// ── Plannotator bridge ───────────────────────────────────────────────

	function plannotatorPlanMode(action: PlannotatorPlanModeMode): Promise<PlannotatorPhase | undefined> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(undefined), PLANNOTATOR_TIMEOUT_MS);
			pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
				requestId: `modes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				action: "plan-mode",
				payload: { mode: action },
				respond: (response: PlannotatorResponse) => {
					clearTimeout(timer);
					resolve(response.status === "handled" ? response.result.phase : undefined);
				},
			});
		});
	}

	/** In plan mode Plannotator owns the workflow; mirror its phase into ours. */
	async function syncWithPlannotator(ctx: ExtensionContext): Promise<void> {
		if (mode !== "plan") return;
		const phase = await plannotatorPlanMode("status");
		if (phase === "planning") return;
		if (phase === "executing") {
			await setMode("apply", ctx, "Plannotator: plan approved");
		} else {
			await setMode("chat", ctx, "Plannotator: planning ended without approval");
		}
	}

	pi.events.on(PLANNOTATOR_PLAN_APPROVED_CHANNEL, () => {
		if (mode === "plan") mode = "apply";
	});

	// ── Mode state ───────────────────────────────────────────────────────

	function statusLabel(ctx: ExtensionContext): string {
		const theme = ctx.ui.theme;
		switch (mode) {
			case "apply":
				return theme.fg("success", "⏵ apply");
			case "chat":
				return theme.fg("warning", "💬 chat");
			case "plan":
				return theme.fg("accent", "📋 plan");
		}
	}

	function render(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, statusLabel(ctx));
	}

	function persist(): void {
		pi.appendEntry(ENTRY_TYPE, { mode });
	}

	async function setMode(next: Mode, ctx: ExtensionContext, why?: string): Promise<void> {
		const previous = mode;
		if (previous === "plan" && next !== "plan") {
			const phase = await plannotatorPlanMode("status");
			if (phase === "planning") await plannotatorPlanMode("exit");
		}
		if (next === "plan") {
			const phase = await plannotatorPlanMode("enter");
			if (phase !== "planning" && phase !== "executing") {
				mode = "chat";
				render(ctx);
				persist();
				ctx.ui.notify("modes: Plannotator is unavailable — using chat mode (edits ask) instead.", "warning");
				return;
			}
		}
		mode = next;
		render(ctx);
		persist();
		if (previous !== next || why) ctx.ui.notify(`modes: ${why ? `${why} → ` : ""}${next}`, "info");
	}

	function restore(ctx: ExtensionContext): void {
		let restored: Mode = DEFAULT_MODE;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as { mode?: string } | undefined;
				if (data?.mode && isMode(data.mode)) restored = data.mode;
			}
		}
		mode = restored;
		render(ctx);
	}

	// ── Hooks ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		if (mode === "plan") await syncWithPlannotator(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await syncWithPlannotator(ctx);
		if (mode !== "chat") return undefined;
		return { message: { customType: "modes-chat-note", content: CHAT_NOTE, display: false } };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode !== "chat") return undefined;

		let input: GateInput;
		let preview = "";
		if (isToolCallEventType("bash", event)) {
			input = { tool: "bash", subject: event.input.command };
		} else if (isToolCallEventType("edit", event)) {
			input = { tool: "edit", subject: event.input.path };
			preview = previewEdits(event.input.edits);
		} else if (isToolCallEventType("write", event)) {
			input = { tool: "write", subject: event.input.path };
			preview = `${event.input.content.split("\n").length} line(s)`;
		} else return undefined;

		if (!needsConfirmation(mode, input)) return undefined;
		const grantKey = `${input.tool}:${input.subject}`;
		if (sessionGrants.has(grantKey)) return undefined;
		if (!ctx.hasUI) return { block: true, reason: "modes: chat mode requires approval but no UI is available." };

		const body = preview ? `\n\n${preview}` : "";
		const choice = await ctx.ui.select(`chat mode: ${input.tool}\n\n  ${input.subject}${body}\n\nAllow?`, [
			ALLOW_ONCE,
			ALLOW_SESSION,
			DENY,
		]);
		if (choice === ALLOW_SESSION) sessionGrants.add(grantKey);
		if (choice === ALLOW_ONCE || choice === ALLOW_SESSION) return undefined;
		return {
			block: true,
			reason:
				"modes: denied by user (chat mode). Do not retry; explain what you would do instead or ask how to proceed.",
		};
	});

	// ── Commands & shortcuts ─────────────────────────────────────────────

	pi.registerCommand("mode", {
		description: `Switch mode: /mode [${MODES.join("|")}] (no argument cycles)`,
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (!arg) {
				await setMode(nextMode(mode), ctx);
				return;
			}
			if (!isMode(arg)) {
				ctx.ui.notify(`modes: unknown mode "${arg}" — use ${MODES.join(", ")}`, "warning");
				return;
			}
			await setMode(arg, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+m", {
		description: "Cycle mode (apply → chat → plan)",
		handler: async (ctx) => {
			await setMode(nextMode(mode), ctx);
		},
	});
}
