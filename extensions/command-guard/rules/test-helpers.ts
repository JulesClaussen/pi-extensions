import assert from "node:assert/strict";
import { checkCommand } from "../policy.ts";
import type { RuleContext, Verdict } from "../types.ts";

export const HOME = "/Users/test";

const branches: Record<string, string | null> = {
	"/repo": "feat/guard",
	"/repo-on-main": "main",
	"/repo/sub": "feat/nested",
	"/detached": null,
};

export const files: Record<string, string> = {
	"/repo/scripts/clean.sh": "#!/bin/bash\nrm -rf dist\nnpm run build\n",
	"/repo/scripts/deploy.sh": "#!/bin/bash\naws s3 sync dist s3://bucket\n",
	"/repo/scripts/sneaky.sh": "#!/bin/bash\nexport AWS_PROFILE=stoik-x-admin\n",
	"/repo/tool.py": "import boto3\n",
};

export function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
	return {
		cwd: "/repo",
		home: HOME,
		env: {},
		protectedPaths: [
			`${HOME}/.aws`,
			`${HOME}/.kube`,
			`${HOME}/.pi/agent/command-guard`,
			"/ext/pi-extensions",
			`${HOME}/.pi/agent/settings.json`,
		],
		currentBranch: async (cwd) => branches[cwd] ?? null,
		readFile: (path) => files[path] ?? null,
		...overrides,
	};
}

export const ctx = makeContext();

export async function verdict(command: string, context: RuleContext = ctx): Promise<Verdict> {
	return (await checkCommand(command, context)).verdict;
}

export async function expectAll(expected: Verdict, commands: string[], context: RuleContext = ctx) {
	for (const command of commands) {
		const decision = await checkCommand(command, context);
		const detail = decision.findings.map((f) => f.reason).join("; ");
		assert.equal(decision.verdict, expected, `${command} should be ${expected} (got ${decision.verdict}: ${detail})`);
	}
}
