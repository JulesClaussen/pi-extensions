/**
 * helm: inspection and local chart work run silently, `helm get` asks (values
 * and manifests can expose secrets), releases are never mutated.
 */

import { hasFlag, positionals } from "../shell.ts";
import { ask, type Command, deny, type Finding } from "../types.ts";

const VALUE_FLAGS = new Set([
	"-n",
	"--namespace",
	"--kube-context",
	"-o",
	"--output",
	"-f",
	"--values",
	"--version",
	"--repo",
	"-l",
	"--selector",
	"--max",
	"--offset",
	"--time-format",
]);

const READ_COMMANDS = new Set([
	"version",
	"env",
	"help",
	"list",
	"ls",
	"status",
	"history",
	"hist",
	"search",
	"show",
	"inspect",
	"template",
	"lint",
	"verify",
	"pull",
	"fetch",
	"package",
	"create",
	"completion",
]);

const READ_SUBCOMMANDS: Record<string, Set<string>> = {
	repo: new Set(["list", "index", "add", "update"]),
	plugin: new Set(["list"]),
	dependency: new Set(["list", "build", "update"]),
	dep: new Set(["list", "build", "update"]),
	registry: new Set([]),
};

const WRITE_COMMANDS = new Set(["install", "upgrade", "uninstall", "delete", "del", "un", "rollback", "test", "push"]);

export function classifyHelm(command: Command, fragment: string): Finding | null {
	if (command.name !== "helm") return null;
	const args = command.args;
	if (hasFlag(args, ["--help", "-h"]) || args.length === 0) return null;

	if (hasFlag(args, ["--kubeconfig"])) return deny("helm kubeconfig override is not allowed", fragment);
	if ("KUBECONFIG" in command.assignments) return deny("KUBECONFIG override is not allowed", fragment);
	if (hasFlag(args, ["--kube-as-user", "--kube-as-group", "--kube-token", "--kube-apiserver"]))
		return deny("helm identity override is not allowed", fragment);
	if (hasFlag(args, ["--post-renderer"])) return deny("helm --post-renderer executes an external program", fragment);

	const [cmd, sub] = positionals(args, VALUE_FLAGS);
	if (!cmd) return null;

	if (cmd === "get") return ask("helm get can expose release values and manifests", fragment);
	const subs = READ_SUBCOMMANDS[cmd];
	if (subs)
		return sub && subs.has(sub) ? null : deny(`helm ${cmd} ${sub ?? ""} mutates configuration`.trim(), fragment);
	if (READ_COMMANDS.has(cmd)) return null;
	if (WRITE_COMMANDS.has(cmd)) return deny(`helm ${cmd} mutates a release`, fragment);
	return ask(`helm ${cmd} is not a recognised read command`, fragment);
}
