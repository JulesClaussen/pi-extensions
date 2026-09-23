/**
 * Pure decision logic for the mode switcher. No pi imports.
 *
 *   apply — nothing gated (pi's default behaviour)
 *   chat  — every side effect asks: `edit`, `write`, and any `bash` segment that is not read-only
 *   plan  — delegated to Plannotator; nothing gated here
 */

import { ENV_ASSIGNMENT, parseCommand, redirectionTargets, splitSegments, tokenize } from "../command-guard/shell.ts";

export const MODES = ["apply", "chat", "plan"] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = "apply";

export function isMode(value: string): value is Mode {
	return (MODES as readonly string[]).includes(value);
}

export function nextMode(mode: Mode): Mode {
	return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

const READ_ONLY = new Set([
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ls",
	"diff",
	"wc",
	"bat",
	"file",
	"stat",
	"find",
	"fd",
	"tree",
	"jq",
	"yq",
	"awk",
	"cut",
	"sort",
	"uniq",
	"tr",
	"column",
	"md5",
	"shasum",
	"sha256sum",
	"od",
	"xxd",
	"strings",
	"du",
	"df",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"test",
	"[",
	"true",
	"false",
	":",
	"cd",
	"pwd",
	"echo",
	"printf",
	"env",
	"printenv",
	"export",
	"which",
	"type",
	"whoami",
	"id",
	"date",
	"uname",
	"hostname",
	"ps",
	"pgrep",
	"sleep",
]);

/** Readers that become writers with an in-place flag. */
const INPLACE_FLAG: Record<string, RegExp> = {
	sed: /^-[a-zA-Z]*i|^--in-place/,
	perl: /^-[a-zA-Z]*i/,
};

/** Returns whether the arguments after a subcommand keep it read-only. */
type SubcommandRule = (args: string[]) => boolean;

const positionalsOf = (args: string[]) => args.filter((arg) => !arg.startsWith("-"));
const always: SubcommandRule = () => true;
const noneOf =
	(pattern: RegExp): SubcommandRule =>
	(args) =>
		!args.some((arg) => pattern.test(arg));
const firstPositionalIn =
	(pattern: RegExp): SubcommandRule =>
	(args) =>
		pattern.test(positionalsOf(args)[0] ?? "");
/** `git branch x` / `git tag x` create; listing forms have no positional or an explicit list flag. */
const listOnly =
	(listFlags: RegExp, mutatingFlags: RegExp): SubcommandRule =>
	(args) =>
		!args.some((arg) => mutatingFlags.test(arg)) &&
		(positionalsOf(args).length === 0 || args.some((arg) => listFlags.test(arg)));

const READ_ONLY_SUBCOMMANDS: Record<string, Record<string, SubcommandRule>> = {
	git: {
		status: always,
		log: always,
		diff: always,
		show: always,
		blame: always,
		"rev-parse": always,
		"ls-files": always,
		"ls-tree": always,
		"ls-remote": always,
		"cat-file": always,
		describe: always,
		shortlog: always,
		grep: always,
		"name-rev": always,
		"merge-base": always,
		"symbolic-ref": (args) => positionalsOf(args).length <= 1,
		branch: listOnly(
			/^(-[arlv]+|--(all|remotes|list|show-current|contains|no-contains|merged|no-merged|points-at|verbose))$/,
			/^-[dDmMcCu]$|^--(delete|move|copy|set-upstream-to|unset-upstream|edit-description|force)$/,
		),
		tag: listOnly(
			/^(-[ln]+|--(list|contains|no-contains|merged|no-merged|points-at|sort))$/,
			/^-[dfas]$|^--(delete|force|annotate|sign)$/,
		),
		remote: firstPositionalIn(/^(|show|get-url)$/),
		stash: firstPositionalIn(/^(list|show)$/),
		config: (args) =>
			noneOf(/^--(unset|unset-all|add|replace-all|edit|remove-section|rename-section)$|^-e$/)(args) &&
			(positionalsOf(args).length <= 1 || args.some((arg) => /^(--get.*|-l|--list)$/.test(arg))),
		worktree: firstPositionalIn(/^list$/),
		reflog: firstPositionalIn(/^(|show)$/),
	},
	gh: {
		pr: firstPositionalIn(/^(list|view|diff|checks|status)$/),
		issue: firstPositionalIn(/^(list|view|status)$/),
		run: firstPositionalIn(/^(list|view|download)$/),
		repo: firstPositionalIn(/^(list|view)$/),
		release: firstPositionalIn(/^(list|view|download)$/),
		workflow: firstPositionalIn(/^(list|view)$/),
		search: always,
		auth: firstPositionalIn(/^status$/),
		api: noneOf(/^(-X|--method|-F|--field|-f|--raw-field|--input)$/),
	},
	npm: {
		ls: always,
		list: always,
		view: always,
		info: always,
		outdated: always,
		explain: always,
		why: always,
		root: always,
		prefix: always,
		config: firstPositionalIn(/^(get|list|ls)$/),
	},
	pnpm: { ls: always, list: always, view: always, why: always, outdated: always },
	yarn: { list: always, info: always, why: always },
	go: {
		version: always,
		env: (args) => positionalsOf(args).length <= 1 && noneOf(/^-[wu]$/)(args),
		list: always,
		doc: always,
	},
	cargo: { metadata: always, tree: always },
	docker: {
		ps: always,
		images: always,
		inspect: always,
		logs: always,
		version: always,
		info: always,
		top: always,
		stats: always,
	},
	kubectl: {
		get: always,
		describe: always,
		logs: always,
		top: always,
		explain: always,
		events: always,
		version: always,
		auth: firstPositionalIn(/^(can-i|whoami)$/),
		config: firstPositionalIn(/^(view|get-contexts|current-context|get-clusters|get-users)$/),
	},
	aws: { sts: firstPositionalIn(/^get-caller-identity$/) },
	terragrunt: { output: always, show: always, providers: always, "render-json": always, info: always },
	brew: { list: always, info: always, deps: always, outdated: always, search: always },
};

/** Global flags that take a value and may precede the subcommand. */
const GLOBAL_VALUE_FLAGS: Record<string, Set<string>> = {
	git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]),
	gh: new Set(["-R", "--repo"]),
	kubectl: new Set(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server"]),
	aws: new Set(["--profile", "--region", "--output", "--endpoint-url"]),
	docker: new Set(["--context", "-H", "--host", "-c"]),
	terragrunt: new Set(["--working-dir", "--terragrunt-working-dir"]),
};

/** Index of the first positional argument, skipping flags and the values of known value flags. */
function subcommandIndex(name: string, args: string[]): number {
	const valueFlags = GLOBAL_VALUE_FLAGS[name];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("-")) return i;
		if (valueFlags?.has(arg)) i++;
	}
	return -1;
}

/** `FOO=bar env`, `env -i`, `env | grep X`: the shared parser treats `env` as a wrapper with no command. */
function isBareEnv(segment: string): boolean {
	const tokens = tokenize(segment).filter((token) => !ENV_ASSIGNMENT.test(token));
	return tokens.length > 0 && tokens[0] === "env" && tokens.slice(1).every((token) => token.startsWith("-"));
}

/** Whether a single command position only reads. Unknown or unparseable commands are not read-only. */
export function isReadOnlySegment(segment: string): boolean {
	if (redirectionTargets(segment).length > 0) return false;
	const command = parseCommand(segment);
	if (!command) return isBareEnv(segment);
	if (command.wrappers.includes("sudo")) return false;

	const inplace = INPLACE_FLAG[command.name];
	if (inplace) return !command.args.some((arg) => inplace.test(arg));
	if (READ_ONLY.has(command.name)) return true;

	const subcommands = READ_ONLY_SUBCOMMANDS[command.name];
	if (!subcommands) return false;
	const index = subcommandIndex(command.name, command.args);
	if (index === -1) return false;
	const rule = subcommands[command.args[index]];
	return rule ? rule(command.args.slice(index + 1)) : false;
}

/** Whether a whole bash command line only reads. */
export function isReadOnlyCommand(command: string): boolean {
	return splitSegments(command).every(isReadOnlySegment);
}

export type GatedTool = "bash" | "edit" | "write";

export interface GateInput {
	tool: GatedTool;
	/** `bash` command line, or the `edit`/`write` path. */
	subject: string;
}

/** Whether the current mode wants a confirmation for this call. */
export function needsConfirmation(mode: Mode, input: GateInput): boolean {
	if (mode !== "chat") return false;
	if (input.tool === "bash") return !isReadOnlyCommand(input.subject);
	return true;
}

/** Compact preview of an edit for the confirmation prompt. */
export function previewEdits(edits: { oldText: string; newText: string }[], maxLines = 6): string {
	const clip = (text: string) => {
		const lines = text.split("\n");
		return lines.length > maxLines ? [...lines.slice(0, maxLines), `… (+${lines.length - maxLines} lines)`] : lines;
	};
	const blocks = edits
		.slice(0, 2)
		.map((edit) =>
			[...clip(edit.oldText).map((l) => `- ${l}`), ...clip(edit.newText).map((l) => `+ ${l}`)].join("\n"),
		);
	if (edits.length > 2) blocks.push(`… ${edits.length - 2} more edit(s)`);
	return blocks.join("\n\n");
}
