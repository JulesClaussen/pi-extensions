/**
 * Walks every command position of a bash command line, tracks `cd`, `asp`
 * and `export AWS_PROFILE=` across segments, runs the per-tool rules and
 * aggregates their findings (deny > ask > allow).
 */

import { resolve } from "node:path";
import { classifyAws } from "./rules/aws.ts";
import { classifyDocker } from "./rules/docker.ts";
import { classifyGit } from "./rules/git.ts";
import { classifyGh } from "./rules/github.ts";
import { classifyHelm } from "./rules/helm.ts";
import { classifyKubectl } from "./rules/kubectl.ts";
import { classifyProtectedPaths, isProtected } from "./rules/protected.ts";
import { classifyScripts } from "./rules/scripts.ts";
import { classifyTerraform, classifyTerragrunt } from "./rules/terragrunt.ts";
import { ENV_ASSIGNMENT, expandHome, parseCommand, SHELLS, splitSegments } from "./shell.ts";
import {
	ask,
	type Command,
	type Decision,
	deny,
	type Finding,
	isDevProfile,
	type RuleContext,
	type Verdict,
} from "./types.ts";

const MAX_DEPTH = 3;
const GUARDED_TOOLS = /(^|[^\w./-])(gh|git|aws|terragrunt|terraform|tofu|kubectl|helm|docker|asp)([^\w./-]|$)/;
const VARIABLE_HINTS_GUARDED = /^\$\{?[A-Za-z_]*(gh|git|aws|tg|terragrunt|tf|terraform|kube|k8s|helm|docker)/i;

async function classifySegment(segment: string, ctx: RuleContext, depth: number): Promise<Finding[]> {
	const command = parseCommand(segment);
	if (!command) return [];
	const fragment = segment.trim();

	const protectedFinding = classifyProtectedPaths(command, segment, ctx);
	if (protectedFinding) return [protectedFinding];

	if (SHELLS.has(command.name)) {
		const index = command.args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
		const inner = index >= 0 ? command.args[index + 1] : undefined;
		if (inner !== undefined) {
			if (depth >= MAX_DEPTH) return [ask("nested shell too deep to inspect", fragment)];
			return classifyCommand(inner, ctx, depth + 1);
		}
	}

	const indirect = command.name === "eval" || command.name.startsWith("$");
	if (indirect && (GUARDED_TOOLS.test(segment) || VARIABLE_HINTS_GUARDED.test(command.name))) {
		return [ask("indirect invocation of a guarded tool cannot be inspected", fragment)];
	}

	const finding =
		classifyGh(command, fragment) ??
		(await classifyGit(command, fragment, ctx)) ??
		classifyAws(command, fragment, ctx) ??
		classifyTerragrunt(command, fragment, ctx) ??
		classifyTerraform(command, fragment) ??
		classifyKubectl(command, fragment) ??
		classifyHelm(command, fragment) ??
		classifyDocker(command, fragment) ??
		classifyScripts(command, segment, ctx);
	return finding ? [finding] : [];
}

/** `asp <profile>` and `export AWS_PROFILE=<profile>` select the profile for later segments. */
function selectedProfile(command: Command): string | undefined {
	if (command.name === "asp") return command.args.find((arg) => !arg.startsWith("-"));
	if (command.name === "export") {
		for (const arg of command.args) {
			const match = ENV_ASSIGNMENT.exec(arg);
			if (match && (match[1] === "AWS_PROFILE" || match[1] === "AWS_DEFAULT_PROFILE")) return match[2];
		}
	}
	return undefined;
}

async function classifyCommand(command: string, ctx: RuleContext, depth: number): Promise<Finding[]> {
	const findings: Finding[] = [];
	let cwd = ctx.cwd;
	let awsProfile = ctx.awsProfile;
	for (const segment of splitSegments(command)) {
		const parsed = parseCommand(segment);
		if (parsed?.name === "cd") {
			const target = parsed.args.find((arg) => !arg.startsWith("-"));
			cwd = target ? resolve(cwd, expandHome(target, ctx.home)) : ctx.home;
			continue;
		}
		const profile = parsed ? selectedProfile(parsed) : undefined;
		if (profile !== undefined) {
			if (!isDevProfile(profile))
				findings.push(deny(`AWS profile '${profile}' is not a *-dev (DeveloperAccess) profile`, segment.trim()));
			awsProfile = profile;
			continue;
		}
		findings.push(...(await classifySegment(segment, { ...ctx, cwd, awsProfile }, depth)));
	}
	return findings;
}

function aggregate(findings: Finding[]): Decision {
	const verdict: Verdict = findings.some((f) => f.verdict === "deny") ? "deny" : findings.length > 0 ? "ask" : "allow";
	return { verdict, findings };
}

export async function checkCommand(command: string, ctx: RuleContext): Promise<Decision> {
	return aggregate(await classifyCommand(command, ctx, 0));
}

/** Decision for the `edit`/`write` tools. */
export function checkFileWrite(path: string, ctx: RuleContext): Decision {
	return aggregate(isProtected(path, ctx) ? [deny(`${path} is a protected path`, path)] : []);
}

export function describeDecision(decision: Decision): string {
	return decision.findings.map((finding) => `${finding.reason} (${finding.fragment})`).join("; ");
}
