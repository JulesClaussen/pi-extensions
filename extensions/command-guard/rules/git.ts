/**
 * git: pushes to feature branches run silently; pushes to protected branches,
 * deletions and bulk pushes ask; force pushes are denied. Destructive local
 * operations (reset --hard, clean -f, discarding checkouts, branch -D, stash
 * drop/clear) ask.
 */

import { resolve } from "node:path";
import { hasFlag, splitFlag } from "../shell.ts";
import { ask, type Command, deny, type Finding, type RuleContext } from "../types.ts";

export const PROTECTED_BRANCHES: RegExp[] = [/^main$/, /^master$/, /^prod/, /^release\//];

export function isProtectedBranch(branch: string): boolean {
	return PROTECTED_BRANCHES.some((pattern) => pattern.test(branch));
}

const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

interface GitInvocation {
	subcommand: string;
	args: string[];
	cwd: string;
	aliasOverride: boolean;
}

export function parseGit(args: string[], cwd: string): GitInvocation | null {
	let dir = cwd;
	let aliasOverride = false;
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (!arg.startsWith("-")) return { subcommand: arg, args: args.slice(i + 1), cwd: dir, aliasOverride };
		const [flag, inlineValue] = splitFlag(arg);
		if (GIT_GLOBAL_VALUE_FLAGS.has(flag)) {
			const value = inlineValue ?? args[i + 1] ?? "";
			if (flag === "-C") dir = resolve(dir, value);
			if (flag === "-c" && value.startsWith("alias.")) aliasOverride = true;
			i += inlineValue === undefined ? 2 : 1;
		} else i++;
	}
	return null;
}

// --- push -------------------------------------------------------------------

const PUSH_FORCE_LONG = new Set(["--force", "--force-with-lease", "--force-if-includes"]);
const PUSH_BULK_LONG = new Set(["--all", "--branches", "--mirror", "--tags", "--prune", "--delete"]);
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

interface PushSpec {
	refspecs: string[];
	force: boolean;
	bulk: string[];
	exec: boolean;
}

function parsePush(args: string[]): PushSpec {
	const spec: PushSpec = { refspecs: [], force: false, bulk: [], exec: false };
	const positionals: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "--") {
			positionals.push(...args.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-")) {
			positionals.push(arg);
			i++;
			continue;
		}
		const [flag] = splitFlag(arg);
		if (arg.startsWith("--")) {
			if (PUSH_FORCE_LONG.has(flag)) spec.force = true;
			if (PUSH_BULK_LONG.has(flag)) spec.bulk.push(flag);
			if (flag === "--exec" || flag === "--receive-pack") spec.exec = true;
			i += PUSH_VALUE_FLAGS.has(flag) && !arg.includes("=") ? 2 : 1;
			continue;
		}
		if (arg.includes("f")) spec.force = true;
		if (arg.includes("d")) spec.bulk.push("--delete");
		i += PUSH_VALUE_FLAGS.has(arg) ? 2 : 1;
	}
	spec.refspecs = positionals.slice(1);
	return spec;
}

async function classifyPush(invocation: GitInvocation, fragment: string, ctx: RuleContext): Promise<Finding | null> {
	const spec = parsePush(invocation.args);
	if (spec.force || spec.refspecs.some((refspec) => refspec.startsWith("+"))) {
		return deny("force push is not allowed", fragment);
	}
	if (spec.exec) return ask("git push runs an external program", fragment);
	if (spec.bulk.length > 0) return ask(`git push ${spec.bulk.join(" ")} affects multiple refs`, fragment);

	const targets: string[] = [];
	for (const refspec of spec.refspecs) {
		const [src, dst] = refspec.includes(":") ? refspec.split(":", 2) : [refspec, refspec];
		if (src === "") return ask(`git push deletes remote ref ${dst}`, fragment);
		if (dst.includes("*")) return ask(`git push with wildcard refspec ${refspec}`, fragment);
		if (dst.startsWith("refs/tags/")) continue;
		targets.push(dst.replace(/^refs\/heads\//, ""));
	}
	if (spec.refspecs.length === 0) targets.push("HEAD");

	for (const target of targets) {
		let branch = target;
		if (target === "HEAD" || target === "@") {
			const current = await ctx.currentBranch(invocation.cwd);
			if (!current) return ask("cannot determine the current branch", fragment);
			branch = current;
		}
		if (isProtectedBranch(branch)) return ask(`git push to protected branch ${branch}`, fragment);
	}
	return null;
}

// --- local destructive operations ---------------------------------------------

function shortFlagHas(args: string[], letter: string): boolean {
	return args.some((arg) => /^-[a-zA-Z]+$/.test(arg) && arg.includes(letter));
}

function classifyLocal(invocation: GitInvocation, fragment: string): Finding | null {
	const { subcommand, args } = invocation;
	switch (subcommand) {
		case "reset":
			return hasFlag(args, ["--hard"]) ? ask("git reset --hard discards working tree changes", fragment) : null;
		case "clean": {
			if (hasFlag(args, ["-n", "--dry-run"]) || shortFlagHas(args, "n")) return null;
			const forced = hasFlag(args, ["--force"]) || shortFlagHas(args, "f");
			return forced ? ask("git clean removes untracked files", fragment) : null;
		}
		case "checkout": {
			if (hasFlag(args, ["-f", "--force"])) return ask("git checkout --force discards local changes", fragment);
			return args.includes("--") ? ask("git checkout -- <path> discards local changes", fragment) : null;
		}
		case "restore": {
			const staged = hasFlag(args, ["--staged", "-S"]);
			const worktree = hasFlag(args, ["--worktree", "-W"]);
			return staged && !worktree ? null : ask("git restore discards working tree changes", fragment);
		}
		case "branch":
			return hasFlag(args, ["-D", "--delete"]) && (hasFlag(args, ["-D"]) || hasFlag(args, ["--force", "-f"]))
				? ask("git branch -D force-deletes a branch", fragment)
				: null;
		case "stash":
			return args[0] === "drop" || args[0] === "clear"
				? ask(`git stash ${args[0]} discards stashed changes`, fragment)
				: null;
		default:
			return null;
	}
}

export async function classifyGit(command: Command, fragment: string, ctx: RuleContext): Promise<Finding | null> {
	if (command.name !== "git") return null;
	const invocation = parseGit(command.args, ctx.cwd);
	if (!invocation) return null;
	if (invocation.aliasOverride) return ask("git invoked with an alias override", fragment);
	if (invocation.subcommand === "push") return classifyPush(invocation, fragment, ctx);
	return classifyLocal(invocation, fragment);
}
