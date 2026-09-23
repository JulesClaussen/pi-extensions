/**
 * github-guard
 *
 * Gates GitHub-affecting shell commands run by the agent:
 *   - `gh` read/list commands run silently; everything else asks for approval
 *     (`gh pr merge`, `gh run rerun`, `gh pr create`, `gh api -X POST`, ...).
 *   - `git push` to a feature branch runs silently; pushes to protected
 *     branches (main, master, prod*, release/*), deletions and bulk pushes ask;
 *     force pushes are denied.
 *
 * Without a UI (headless runs) anything that would ask is blocked instead.
 *
 * `/github-guard` shows the state, `/github-guard off|on` toggles it for the
 * session, `/github-guard <command>` dry-runs the classifier.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeDecision, evaluateBashCall } from "./policy.ts";
import { checkCommand, type RuleContext } from "./rules.ts";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session (this exact command)";
const DENY = "Deny";

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_GITHUB_GUARD !== "off";
	const sessionGrants = new Set<string>();

	const ruleContext = (): RuleContext => ({
		cwd: process.cwd(),
		currentBranch: async (cwd) => {
			try {
				const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 });
				const branch = result.stdout.trim();
				return result.code === 0 && branch && branch !== "HEAD" ? branch : null;
			} catch {
				return null;
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		const decision = await evaluateBashCall(event, ruleContext());
		if (!decision || decision.verdict === "allow") return undefined;

		const command = (event.input as { command: string }).command;
		const summary = describeDecision(decision);

		if (decision.verdict === "deny") {
			return {
				block: true,
				reason: `github-guard blocked this command: ${summary}. Ask the user to run it themselves if it is really intended.`,
			};
		}

		if (sessionGrants.has(command)) return undefined;
		if (!ctx.hasUI) {
			return { block: true, reason: `github-guard: approval required but no UI is available (${summary}).` };
		}

		const choice = await ctx.ui.select(`github-guard: ${summary}\n\n  ${command}\n\nAllow?`, [
			ALLOW_ONCE,
			ALLOW_SESSION,
			DENY,
		]);
		if (choice === ALLOW_SESSION) sessionGrants.add(command);
		if (choice === ALLOW_ONCE || choice === ALLOW_SESSION) return undefined;

		return { block: true, reason: "github-guard: denied by user. Do not retry; ask the user how to proceed." };
	});

	pi.registerCommand("github-guard", {
		description: "Show, toggle (on|off) or dry-run (<command>) the GitHub command guard",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			const verb = arg.toLowerCase();
			if (verb === "off" || verb === "disable") {
				enabled = false;
				ctx.ui.notify("github-guard: disabled for this session", "warning");
				return;
			}
			if (verb === "on" || verb === "enable") {
				enabled = true;
				ctx.ui.notify("github-guard: enabled", "info");
				return;
			}
			if (arg) {
				const decision = await checkCommand(arg, ruleContext());
				const detail = decision.verdict === "allow" ? "" : ` — ${describeDecision(decision)}`;
				ctx.ui.notify(
					`github-guard: ${decision.verdict}${detail}`,
					decision.verdict === "allow" ? "info" : "warning",
				);
				return;
			}
			const state = enabled ? "enabled" : "disabled";
			const grants = sessionGrants.size ? `, ${sessionGrants.size} session grant(s)` : "";
			ctx.ui.notify(
				`github-guard: ${state}${grants} (use /github-guard on|off, or /github-guard <command> to test)`,
				"info",
			);
		},
	});
}
