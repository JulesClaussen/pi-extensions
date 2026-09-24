/**
 * command-guard
 *
 * One guard for everything the agent runs through `bash`, `edit` and `write`:
 *
 *   - gh: reads run, mutations ask
 *   - git: feature-branch pushes run, protected-branch pushes ask, force pushes denied,
 *          destructive local operations ask
 *   - aws / terragrunt: only *-dev (DeveloperAccess) profiles; reads run, secret reads ask,
 *          mutations denied; terraform/tofu always denied in favour of terragrunt
 *   - kubectl / helm: reads run, secret reads ask, writes denied
 *   - docker: removal, pruning, privileged/host-escaping containers, registry writes ask
 *   - ~/.aws, ~/.kube, generated configs, guard sources and pi settings: never written
 *   - local scripts and inline interpreter code that could bypass the env layer
 *     (credential env vars, KUBECONFIG, ~/.aws, ~/.kube, SSO cache): ask
 *
 * An environment layer pins the process tree to the *-dev role (see env.ts).
 * Without a UI (headless runs) anything that would ask is blocked instead.
 *
 * `/command-guard` shows the state, `/command-guard <command>` dry-runs the classifier.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { applyEnv, type EnvReport } from "./env.ts";
import { checkCommand, checkFileWrite, describeDecision } from "./policy.ts";
import type { Decision, RuleContext } from "./types.ts";

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for session (this exact command)";
const DENY = "Deny";

const HOME = homedir();
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".pi", "agent");
const GUARD_DIR = join(AGENT_DIR, "command-guard");
const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PROTECTED_PATHS = [
	join(HOME, ".aws"),
	join(HOME, ".kube"),
	GUARD_DIR,
	EXTENSION_ROOT,
	join(AGENT_DIR, "settings.json"),
];

export default function (pi: ExtensionAPI) {
	const sessionGrants = new Set<string>();
	let report: EnvReport;
	try {
		report = applyEnv(HOME, GUARD_DIR);
	} catch (error) {
		report = {
			dir: GUARD_DIR,
			awsProfiles: 0,
			kubeUsers: 0,
			warnings: [`env layer failed: ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	const ruleContext = (): RuleContext => ({
		cwd: process.cwd(),
		home: HOME,
		env: process.env,
		protectedPaths: PROTECTED_PATHS,
		currentBranch: async (cwd) => {
			try {
				const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 });
				const branch = result.stdout.trim();
				return result.code === 0 && branch && branch !== "HEAD" ? branch : null;
			} catch {
				return null;
			}
		},
		readFile: (path) => {
			try {
				return readFileSync(path, "utf-8");
			} catch {
				return null;
			}
		},
	});

	const summary = () => {
		const lines = [
			`AWS_CONFIG_FILE: ${report.awsConfigFile ?? "untouched"} (${report.awsProfiles} *-dev profiles)`,
			`KUBECONFIG: ${report.kubeconfig ?? "untouched"} (${report.kubeUsers} exec users rewritten to -dev)`,
		];
		if (report.droppedProfile) lines.push(`dropped inherited AWS_PROFILE=${report.droppedProfile}`);
		lines.push(...report.warnings.map((warning) => `warning: ${warning}`));
		return lines;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (report.warnings.length > 0 || report.droppedProfile)
			ctx.ui.notify(`command-guard: ${summary().slice(2).join("; ")}`, "warning");
	});

	pi.on("tool_call", async (event, ctx) => {
		let decision: Decision;
		let subject: string;
		if (isToolCallEventType("bash", event)) {
			subject = event.input.command;
			decision = await checkCommand(subject, ruleContext());
		} else if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			subject = event.input.path;
			decision = checkFileWrite(subject, ruleContext());
		} else return undefined;

		if (decision.verdict === "allow") return undefined;
		const detail = describeDecision(decision);

		if (decision.verdict === "deny") {
			return {
				block: true,
				reason: `command-guard blocked this: ${detail}. Do not work around it; if it is really intended, ask the user to run it themselves.`,
			};
		}

		if (sessionGrants.has(subject)) return undefined;
		if (!ctx.hasUI)
			return { block: true, reason: `command-guard: approval required but no UI is available (${detail}).` };

		const choice = await ctx.ui.select(`command-guard: ${detail}\n\n  ${subject}\n\nAllow?`, [
			ALLOW_ONCE,
			ALLOW_SESSION,
			DENY,
		]);
		if (choice === ALLOW_SESSION) sessionGrants.add(subject);
		if (choice === ALLOW_ONCE || choice === ALLOW_SESSION) return undefined;
		return { block: true, reason: "command-guard: denied by user. Do not retry; ask the user how to proceed." };
	});

	pi.registerCommand("command-guard", {
		description: "Show the command guard state, or dry-run a command: /command-guard <command>",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg) {
				const decision = await checkCommand(arg, ruleContext());
				const detail = decision.verdict === "allow" ? "" : ` — ${describeDecision(decision)}`;
				ctx.ui.notify(
					`command-guard: ${decision.verdict}${detail}`,
					decision.verdict === "allow" ? "info" : "warning",
				);
				return;
			}
			const grants = sessionGrants.size ? `${sessionGrants.size} session grant(s)` : "no session grants";
			ctx.ui.notify(`command-guard: active, ${grants}\n${summary().join("\n")}`, "info");
		},
	});
}
