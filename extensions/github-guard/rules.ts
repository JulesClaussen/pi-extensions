/**
 * Classification rules for the github-guard extension.
 *
 * Pure functions, no pi imports, so they can be unit tested directly.
 *
 * Policy:
 *   - `gh` read/list commands run silently; everything else (and anything
 *     unrecognised) asks for approval.
 *   - `git push` to a non-protected branch runs silently; pushes to protected
 *     branches, deletions and bulk pushes ask; force pushes are denied outright.
 *
 * Matching is token-based, not a real shell parse. It is deliberately
 * conservative: a false positive costs one confirmation prompt.
 */

import { basename, resolve } from "node:path";

export type Verdict = "allow" | "ask" | "deny";

export interface Finding {
	verdict: "ask" | "deny";
	reason: string;
	fragment: string;
}

export interface Decision {
	verdict: Verdict;
	findings: Finding[];
}

export interface RuleContext {
	/** Directory the bash tool runs in. */
	cwd: string;
	/** Resolve the checked-out branch of a repository, or null when unknown/detached. */
	currentBranch: (cwd: string) => Promise<string | null>;
}

export const PROTECTED_BRANCHES: RegExp[] = [/^main$/, /^master$/, /^prod/, /^release\//];

export function isProtectedBranch(branch: string): boolean {
	return PROTECTED_BRANCHES.some((pattern) => pattern.test(branch));
}

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

const SHELL_OPERATORS = /&&|\|\||[|;&\n]|\$\(|`/g;

/** Blank out quoted spans, escapes and comments while preserving indices. */
export function maskLiterals(command: string): string {
	const out = command.split("");
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			out[i] = " ";
			if (ch === "\\" && quote === '"' && i + 1 < command.length) out[++i] = " ";
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out[i] = " ";
		} else if (ch === "\\") {
			out[i] = " ";
			i++;
		} else if (ch === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
			while (i < command.length && command[i] !== "\n") out[i++] = " ";
			i--;
		}
	}
	return out.join("");
}

/** Split a command line into one segment per command position. */
export function splitSegments(command: string): string[] {
	const masked = maskLiterals(command);
	const segments: string[] = [];
	let last = 0;
	for (const match of masked.matchAll(SHELL_OPERATORS)) {
		segments.push(command.slice(last, match.index));
		last = match.index + match[0].length;
	}
	segments.push(command.slice(last));
	return segments.filter((segment) => segment.trim().length > 0);
}

/** Tokenize a segment, honouring single/double quotes and backslash escapes. */
export function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < segment.length) current += segment[++i];
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (ch === "\\" && i + 1 < segment.length) {
			current += segment[++i];
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
		} else {
			current += ch;
			started = true;
		}
	}
	if (started) tokens.push(current);
	return tokens;
}

const KEYWORDS = new Set(["then", "do", "else", "elif", "!"]);
const WRAPPERS = new Set(["builtin", "command", "env", "exec", "nice", "nohup", "sudo", "time", "timeout", "xargs"]);
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-n", "-I", "-L", "-P", "-d", "-s", "-k", "-C"]);
const WRAPPER_POSITIONALS: Record<string, number> = { timeout: 1 };
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 3;

interface Command {
	name: string;
	args: string[];
}

/** Resolve the effective command of a segment, looking through keywords, env assignments and wrappers. */
export function parseCommand(segment: string): Command | null {
	const tokens = tokenize(segment);
	let i = 0;
	for (;;) {
		if (i >= tokens.length) return null;
		const token = tokens[i].replace(/^[({]+/, "");
		if (!token || KEYWORDS.has(token) || ENV_ASSIGNMENT.test(token)) {
			i++;
			continue;
		}
		const name = basename(token);
		if (!WRAPPERS.has(name)) return { name, args: tokens.slice(i + 1) };

		i++;
		let positionals = WRAPPER_POSITIONALS[name] ?? 0;
		while (i < tokens.length) {
			const next = tokens[i];
			if (next === "--") {
				i++;
				break;
			}
			if (next.startsWith("-")) {
				i += WRAPPER_VALUE_FLAGS.has(next) ? 2 : 1;
			} else if (ENV_ASSIGNMENT.test(next)) {
				i++;
			} else if (positionals > 0) {
				positionals--;
				i++;
			} else break;
		}
	}
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

const GH_READ: Record<string, Set<string> | "*"> = {
	pr: new Set(["list", "view", "diff", "checks", "status", "checkout"]),
	issue: new Set(["list", "view", "status"]),
	run: new Set(["list", "view", "watch", "download"]),
	repo: new Set(["view", "list", "clone"]),
	release: new Set(["list", "view", "download"]),
	workflow: new Set(["list", "view"]),
	label: new Set(["list"]),
	cache: new Set(["list"]),
	gist: new Set(["list", "view"]),
	project: new Set(["list", "view"]),
	ruleset: new Set(["list", "view", "check"]),
	secret: new Set(["list"]),
	variable: new Set(["list"]),
	"ssh-key": new Set(["list"]),
	"gpg-key": new Set(["list"]),
	codespace: new Set(["list"]),
	extension: new Set(["list"]),
	alias: new Set(["list"]),
	config: new Set(["get", "list"]),
	auth: new Set(["status"]),
	search: "*",
	browse: "*",
	status: "*",
	help: "*",
	version: "*",
};

const GH_API_BODY_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

function ghApiIsRead(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (GH_API_BODY_FLAGS.has(arg)) return false;
		if (/^(-f|-F|--field=|--raw-field=|--input=)/.test(arg) && arg.length > 2) return false;
		if (arg === "-X" || arg === "--method") {
			if ((args[i + 1] ?? "").toUpperCase() !== "GET") return false;
			i++;
		} else if (/^(-X|--method=)/.test(arg)) {
			if (arg.replace(/^(-X|--method=)/, "").toUpperCase() !== "GET") return false;
		}
	}
	return true;
}

function classifyGh(args: string[], fragment: string): Finding | null {
	if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version")) return null;

	const positionals = args.filter((arg) => !arg.startsWith("-"));
	const [command, sub] = positionals;
	if (!command) return null;

	if (command === "api") {
		return ghApiIsRead(args)
			? null
			: { verdict: "ask", reason: "gh api call with a body or non-GET method", fragment };
	}

	const allowed = GH_READ[command];
	if (allowed === "*") return null;
	if (allowed && sub && allowed.has(sub)) return null;

	return {
		verdict: "ask",
		reason: `gh ${[command, sub].filter(Boolean).join(" ")} is not a read-only command`,
		fragment,
	};
}

// ---------------------------------------------------------------------------
// git push
// ---------------------------------------------------------------------------

const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const PUSH_FORCE_LONG = new Set(["--force", "--force-with-lease", "--force-if-includes"]);
const PUSH_BULK_LONG = new Set(["--all", "--branches", "--mirror", "--tags", "--prune", "--delete"]);
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

interface GitInvocation {
	subcommand: string;
	args: string[];
	cwd: string;
	aliasOverride: boolean;
}

function parseGit(args: string[], cwd: string): GitInvocation | null {
	let dir = cwd;
	let aliasOverride = false;
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (!arg.startsWith("-")) return { subcommand: arg, args: args.slice(i + 1), cwd: dir, aliasOverride };
		const [flag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
		if (GIT_GLOBAL_VALUE_FLAGS.has(flag)) {
			const value = inlineValue ?? args[i + 1] ?? "";
			if (flag === "-C") dir = resolve(dir, value);
			if (flag === "-c" && value.startsWith("alias.")) aliasOverride = true;
			i += inlineValue === undefined ? 2 : 1;
		} else i++;
	}
	return null;
}

interface PushSpec {
	remote?: string;
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
		const [flag] = arg.split("=", 1);
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
	[spec.remote, ...spec.refspecs] = positionals;
	return spec;
}

async function classifyGitPush(invocation: GitInvocation, fragment: string, ctx: RuleContext): Promise<Finding | null> {
	if (invocation.aliasOverride) return { verdict: "ask", reason: "git invoked with an alias override", fragment };

	const spec = parsePush(invocation.args);
	if (spec.force || spec.refspecs.some((refspec) => refspec.startsWith("+"))) {
		return { verdict: "deny", reason: "force push is not allowed", fragment };
	}
	if (spec.exec) return { verdict: "ask", reason: "git push runs an external program", fragment };
	if (spec.bulk.length > 0)
		return { verdict: "ask", reason: `git push ${spec.bulk.join(" ")} affects multiple refs`, fragment };

	const targets: string[] = [];
	for (const refspec of spec.refspecs) {
		const [src, dst] = refspec.includes(":") ? refspec.split(":", 2) : [refspec, refspec];
		if (src === "") return { verdict: "ask", reason: `git push deletes remote ref ${dst}`, fragment };
		if (dst.includes("*")) return { verdict: "ask", reason: `git push with wildcard refspec ${refspec}`, fragment };
		if (dst.startsWith("refs/tags/")) continue;
		targets.push(dst.replace(/^refs\/heads\//, ""));
	}
	if (spec.refspecs.length === 0) targets.push("HEAD");

	for (const target of targets) {
		let branch = target;
		if (target === "HEAD" || target === "@") {
			const current = await ctx.currentBranch(invocation.cwd);
			if (!current) return { verdict: "ask", reason: "cannot determine the current branch", fragment };
			branch = current;
		}
		if (isProtectedBranch(branch))
			return { verdict: "ask", reason: `git push to protected branch ${branch}`, fragment };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const MENTIONS_GUARDED = /(^|[^\w./-])(gh|git)([^\w./-]|$)/;
const VARIABLE_HINTS_GUARDED = /^\$\{?[A-Za-z_]*(gh|git)/i;

async function classifySegment(segment: string, ctx: RuleContext, depth: number): Promise<Finding[]> {
	const command = parseCommand(segment);
	if (!command) return [];
	const fragment = segment.trim();

	if (command.name === "gh") {
		const finding = classifyGh(command.args, fragment);
		return finding ? [finding] : [];
	}
	if (command.name === "git") {
		const invocation = parseGit(command.args, ctx.cwd);
		if (invocation?.subcommand !== "push") return [];
		const finding = await classifyGitPush(invocation, fragment, ctx);
		return finding ? [finding] : [];
	}
	if (SHELLS.has(command.name)) {
		const index = command.args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
		const inner = index >= 0 ? command.args[index + 1] : undefined;
		if (inner === undefined || !MENTIONS_GUARDED.test(inner)) return [];
		if (depth >= MAX_DEPTH) return [{ verdict: "ask", reason: "nested shell too deep to inspect", fragment }];
		return classifyCommand(inner, ctx, depth + 1);
	}
	const indirect = command.name === "eval" || command.name.startsWith("$");
	if (indirect && (MENTIONS_GUARDED.test(segment) || VARIABLE_HINTS_GUARDED.test(command.name))) {
		return [{ verdict: "ask", reason: "indirect invocation of gh/git cannot be inspected", fragment }];
	}
	return [];
}

async function classifyCommand(command: string, ctx: RuleContext, depth: number): Promise<Finding[]> {
	const findings: Finding[] = [];
	let cwd = ctx.cwd;
	for (const segment of splitSegments(command)) {
		const parsed = parseCommand(segment);
		if (parsed?.name === "cd") {
			const target = parsed.args.find((arg) => !arg.startsWith("-"));
			cwd = target ? resolve(cwd, target.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : cwd;
			continue;
		}
		findings.push(...(await classifySegment(segment, { ...ctx, cwd }, depth)));
	}
	return findings;
}

export async function checkCommand(command: string, ctx: RuleContext): Promise<Decision> {
	const findings = await classifyCommand(command, ctx, 0);
	const verdict: Verdict = findings.some((f) => f.verdict === "deny") ? "deny" : findings.length > 0 ? "ask" : "allow";
	return { verdict, findings };
}
