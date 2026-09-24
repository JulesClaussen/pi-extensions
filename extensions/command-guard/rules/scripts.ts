/**
 * Scripts and inline interpreters: the env layer already pins every process
 * to the *-dev identity, so a script calling aws/kubectl/terragrunt is not a
 * concern by itself. What is: code that redirects the credential chain away
 * from the env layer (AWS_CONFIG_FILE, static keys, KUBECONFIG) or reads
 * ~/.aws, ~/.kube or the SSO cache directly. Directly executed local scripts
 * and inline `python -c` / `node -e` code are scanned for those and ask,
 * naming the offending token and line.
 */

import { isAbsolute, resolve } from "node:path";
import { expandHome, SHELLS } from "../shell.ts";
import { ask, type Command, type Finding, type RuleContext } from "../types.ts";
import { CREDENTIAL_OVERRIDES } from "./aws-profile.ts";

const BYPASS = new RegExp(`${CREDENTIAL_OVERRIDES.join("|")}|KUBECONFIG|\\.aws/|\\.kube/|sso/cache`);

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

function findBypass(text: string): { token: string; line: number } | undefined {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = BYPASS.exec(lines[i]);
		if (match) return { token: match[0], line: i + 1 };
	}
	return undefined;
}

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
		const hit = code ? findBypass(code) : undefined;
		if (hit)
			return ask(
				`inline ${command.name} code references ${hit.token}, which can bypass the *-dev env layer`,
				fragment,
			);
		if (index >= 0) return null;
	}

	const script = scriptPath(command);
	if (!script) return null;
	const expanded = expandHome(script, ctx.home);
	const path = isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
	const content = ctx.readFile(path);
	if (content === null) return null;
	if (content.length > MAX_SCRIPT_BYTES) return ask(`script ${script} is too large to inspect`, fragment);
	const hit = findBypass(content);
	if (hit)
		return ask(
			`script ${script} references ${hit.token} at line ${hit.line}, which can bypass the *-dev env layer`,
			fragment,
		);
	return null;
}
