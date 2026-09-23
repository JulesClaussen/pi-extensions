/**
 * Scripts and inline interpreters: the guard cannot classify what a script
 * does, so directly executed local scripts and inline `python -c` / `node -e`
 * code are scanned for infra tooling and credential handling and ask when they
 * mention any.
 */

import { isAbsolute, resolve } from "node:path";
import { expandHome, SHELLS } from "../shell.ts";
import { ask, type Command, type Finding, type RuleContext } from "../types.ts";

const SUSPICIOUS =
	/-admin\b|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|AWS_ACCESS_KEY_ID|AWS_PROFILE|KUBECONFIG|\.aws\/|\.kube\/|sso\/cache|\b(aws|kubectl|helm|terragrunt|terraform|tofu)\b/;
const SDK = /\bboto3\b|\bbotocore\b|aws-sdk|@aws-sdk|aws_sdk|\bkubernetes\b|\bk8s\b|\beks\b/i;

const INTERPRETERS: Record<string, string[]> = {
	python: ["-c"],
	python3: ["-c"],
	node: ["-e", "--eval", "-p", "--print"],
	ruby: ["-e"],
	perl: ["-e", "-E"],
	deno: ["eval"],
	bun: ["-e"],
};

const MAX_SCRIPT_BYTES = 512 * 1024;

function scriptPath(command: Command): string | undefined {
	if (SHELLS.has(command.name) || command.name === "source" || command.name === "." || command.name in INTERPRETERS) {
		if (command.args.some((arg) => /^-[a-zA-Z]*c/.test(arg))) return undefined;
		return command.args.find((arg) => !arg.startsWith("-"));
	}
	if (command.raw.includes("/") || /\.(sh|bash|zsh|py|rb|pl|js|mjs|ts)$/.test(command.raw)) return command.raw;
	return undefined;
}

export function classifyScripts(command: Command, segment: string, ctx: RuleContext): Finding | null {
	const fragment = segment.trim();

	const interpreterFlags = INTERPRETERS[command.name];
	if (interpreterFlags) {
		const index = command.args.findIndex((arg) => interpreterFlags.includes(arg));
		const code = index >= 0 ? command.args[index + 1] : undefined;
		if (code && (SUSPICIOUS.test(code) || SDK.test(code)))
			return ask(`inline ${command.name} code touches infra tooling or credentials`, fragment);
		if (index >= 0) return null;
	}

	const script = scriptPath(command);
	if (!script) return null;
	const expanded = expandHome(script, ctx.home);
	const path = isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
	const content = ctx.readFile(path);
	if (content === null) return null;
	if (content.length > MAX_SCRIPT_BYTES) return ask(`script ${script} is too large to inspect`, fragment);
	if (SUSPICIOUS.test(content) || SDK.test(content))
		return ask(`script ${script} mentions infra tooling or credentials`, fragment);
	return null;
}
