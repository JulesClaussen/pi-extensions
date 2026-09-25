/**
 * Protected paths: ~/.aws, ~/.kube, the generated guard configs, the guard's
 * own sources and pi settings must never be written by the agent. Pure readers
 * may look at them; anything else that references them is denied.
 */

import { isAbsolute, resolve } from "node:path";
import { expandHome, redirectionTargets } from "../shell.ts";
import { type Command, deny, type Finding, type RuleContext } from "../types.ts";

const READERS = new Set([
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"grep",
	"rg",
	"ag",
	"ls",
	"diff",
	"wc",
	"bat",
	"file",
	"stat",
	"find",
	"tree",
	"jq",
	"yq",
	"awk",
	"cut",
	"sort",
	"uniq",
	"md5",
	"shasum",
	"sha256sum",
	"od",
	"xxd",
	"strings",
	"column",
	"du",
	"realpath",
	"readlink",
	"test",
	"[",
]);
const INPLACE_FLAGS: Record<string, RegExp> = {
	yq: /^-i$|^--inplace$/,
	sed: /^-[a-zA-Z]*i|^--in-place/,
	perl: /^-[a-zA-Z]*i/,
};
const PATH_VARIABLES = /\$\{?(AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|KUBECONFIG)\}?/;

export function isProtected(path: string, ctx: RuleContext): boolean {
	const expanded = expandHome(path, ctx.home);
	const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.cwd, expanded);
	return ctx.protectedPaths.some((root) => absolute === root || absolute.startsWith(`${root}/`));
}

function referencesProtected(tokens: string[], ctx: RuleContext): string | undefined {
	for (const token of tokens) {
		if (PATH_VARIABLES.test(token)) return token;
		const candidates = token.includes("=") ? [token, token.slice(token.indexOf("=") + 1)] : [token];
		for (const candidate of candidates) {
			if (/^[~$/.]/.test(candidate) && isProtected(candidate.replace(/^\$\{?HOME\}?/, "~"), ctx)) return token;
		}
	}
	return undefined;
}

export function classifyProtectedPaths(command: Command, segment: string, ctx: RuleContext): Finding | null {
	const fragment = segment.trim();
	const redirected = referencesProtected(redirectionTargets(segment), ctx);
	if (redirected) return deny(`redirection into protected path ${redirected}`, fragment);

	const insideProtected = isProtected(ctx.cwd, ctx);
	const referenced =
		referencesProtected([command.raw, ...command.args, ...Object.values(command.assignments)], ctx) ??
		(insideProtected ? ctx.cwd : undefined);
	if (!referenced) return null;

	const inplace = INPLACE_FLAGS[command.name];
	if (inplace && command.args.some((arg) => inplace.test(arg)))
		return deny(`${command.name} edits protected path ${referenced} in place`, fragment);
	if (READERS.has(command.name) || command.name === "sed" || command.name === "perl") return null;
	return deny(`${command.name} touches protected path ${referenced}; only read-only access is allowed`, fragment);
}
