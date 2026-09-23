/**
 * terragrunt: only *-dev profiles; a strict allowlist of read/plan commands
 * runs silently; everything else is denied. `terraform`/`tofu` are always
 * denied in favour of terragrunt.
 */

import { type Command, deny, type Finding, type RuleContext } from "../types.ts";
import { checkAwsIdentity } from "./aws-profile.ts";

const READ_COMMANDS = new Set([
	"plan",
	"init",
	"validate",
	"validate-inputs",
	"output",
	"show",
	"providers",
	"graph",
	"graph-dependencies",
	"hcl",
	"hclfmt",
	"hclvalidate",
	"fmt",
	"render",
	"render-json",
	"version",
	"info",
	"dag",
	"list",
	"find",
	"catalog",
	"scaffold",
	"get",
	"metadata",
	"modules",
]);

const READ_SUBCOMMANDS: Record<string, Set<string>> = {
	state: new Set(["list", "show", "pull"]),
	workspace: new Set(["list", "show"]),
	providers: new Set(["lock", "mirror", "schema"]),
};

const NO_CREDENTIAL = new Set([
	"hcl",
	"hclfmt",
	"hclvalidate",
	"fmt",
	"version",
	"--version",
	"-version",
	"--help",
	"-help",
	"help",
	"info",
	"render",
	"render-json",
	"dag",
	"list",
	"find",
	"catalog",
	"scaffold",
	"validate-inputs",
]);

/** First non-flag token, then the next one; `run-all`/`run --all` are skipped so the real command is inspected. */
function resolveCommand(args: string[]): { command?: string; sub?: string; all: boolean } {
	const rest = args.filter(
		(arg) => !arg.startsWith("-") || arg === "--version" || arg === "-version" || arg === "--help",
	);
	let all = false;
	if (rest[0] === "run-all") {
		all = true;
		rest.shift();
	} else if (rest[0] === "run") {
		all = args.includes("--all") || args.includes("-a");
		rest.shift();
	}
	if (rest[0] === "--") rest.shift();
	return { command: rest[0], sub: rest[1], all };
}

export function classifyTerragrunt(command: Command, fragment: string, ctx: RuleContext): Finding | null {
	if (command.name !== "terragrunt") return null;
	const { command: tg, sub } = resolveCommand(command.args);
	if (!tg) return null;

	const identity = checkAwsIdentity(command, fragment, ctx, !NO_CREDENTIAL.has(tg));
	if (identity) return identity;

	if (tg === "--version" || tg === "-version" || tg === "--help" || tg === "-help") return null;
	if (tg === "exec") return deny("terragrunt exec runs an arbitrary command with module credentials", fragment);
	if (tg === "stack") return deny("terragrunt stack commands are not allowed", fragment);

	const subs = READ_SUBCOMMANDS[tg];
	if (subs) {
		if ((sub && subs.has(sub)) || (!sub && READ_COMMANDS.has(tg))) return null;
		return deny(`terragrunt ${tg} ${sub ?? ""} mutates state`.trim(), fragment);
	}
	if (READ_COMMANDS.has(tg)) return null;
	return deny(`terragrunt ${tg} is a mutation; only plan/read commands are allowed`, fragment);
}

export function classifyTerraform(command: Command, fragment: string): Finding | null {
	if (command.name !== "terraform" && command.name !== "tofu") return null;
	const args = command.args.join(" ");
	return deny(
		`${command.name} is never run directly here; use terragrunt from the module's terragrunt directory (e.g. \`terragrunt ${args}\`, or \`terragrunt run-all ${args}\` for multiple modules)`,
		fragment,
	);
}
