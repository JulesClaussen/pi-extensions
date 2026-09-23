/**
 * kubectl: reads run silently, secret reads ask, every write is denied.
 * kubeconfig/identity overrides are denied (the generated kubeconfig pins the
 * *-dev role).
 */

import { flagValue, hasFlag, positionals } from "../shell.ts";
import { ask, type Command, deny, type Finding } from "../types.ts";

const VALUE_FLAGS = new Set([
	"-n",
	"--namespace",
	"--context",
	"-o",
	"--output",
	"-l",
	"--selector",
	"-f",
	"--filename",
	"-c",
	"--container",
	"--field-selector",
	"--sort-by",
	"--template",
	"--since",
	"--tail",
	"--timeout",
	"--for",
	"--address",
	"--cluster",
	"--user",
	"-k",
	"--kustomize",
	"--type",
	"-p",
	"--patch",
	"--replicas",
	"--image",
	"--port",
	"--from-literal",
	"--from-file",
	"--dry-run",
	"--field-manager",
	"--grace-period",
	"--revision",
	"--to-revision",
	"--chunk-size",
	"--raw",
	"--sort-by",
	"--filename",
	"-L",
	"--label-columns",
	"--namespaces",
]);

const DENIED_FLAGS: Array<[string[], string]> = [
	[["--kubeconfig"], "kubeconfig override is not allowed"],
	[["--as", "--as-group", "--as-uid"], "impersonation is not allowed"],
	[
		["--token", "--server", "-s", "--username", "--password", "--client-certificate", "--client-key"],
		"credential override is not allowed",
	],
];

const READ_VERBS = new Set([
	"get",
	"describe",
	"logs",
	"log",
	"top",
	"explain",
	"api-resources",
	"api-versions",
	"version",
	"cluster-info",
	"diff",
	"wait",
	"port-forward",
	"events",
	"kustomize",
	"options",
	"completion",
	"help",
	"convert",
]);

const READ_SUBVERBS: Record<string, Set<string>> = {
	auth: new Set(["can-i", "whoami"]),
	rollout: new Set(["status", "history"]),
	config: new Set(["get-contexts", "current-context", "view", "use-context", "get-clusters", "get-users"]),
	plugin: new Set(["list"]),
};

const DRY_RUN_VERBS = new Set([
	"apply",
	"create",
	"delete",
	"patch",
	"replace",
	"label",
	"annotate",
	"scale",
	"set",
	"run",
	"expose",
]);

const WRITE_VERBS = new Set([
	...DRY_RUN_VERBS,
	"edit",
	"autoscale",
	"drain",
	"cordon",
	"uncordon",
	"taint",
	"certificate",
	"exec",
	"attach",
	"cp",
	"debug",
	"proxy",
]);

function targetsSecrets(rest: string[]): boolean {
	return rest.some((arg) => /^secrets?(\.|\/|$)/.test(arg));
}

export function classifyKubectl(command: Command, fragment: string): Finding | null {
	if (command.name !== "kubectl" && command.name !== "k") return null;
	const args = command.args;
	if (hasFlag(args, ["--help", "-h"]) || args.length === 0) return null;

	for (const [flags, reason] of DENIED_FLAGS) if (hasFlag(args, flags)) return deny(`kubectl ${reason}`, fragment);
	if ("KUBECONFIG" in command.assignments) return deny("KUBECONFIG override is not allowed", fragment);

	const [verb, sub, ...rest] = positionals(args, VALUE_FLAGS);
	if (!verb) return null;

	const subverbs = READ_SUBVERBS[verb];
	if (subverbs) {
		if (sub && subverbs.has(sub)) {
			if (verb === "config" && sub === "view" && hasFlag(args, ["--raw"]))
				return ask("kubectl config view --raw exposes credentials", fragment);
			return null;
		}
		return deny(`kubectl ${verb} ${sub ?? ""} is a write operation`.trim(), fragment);
	}

	if (READ_VERBS.has(verb)) {
		if ((verb === "get" || verb === "describe") && targetsSecrets([sub ?? "", ...rest]))
			return ask("kubectl reads Secret objects", fragment);
		if (verb === "get" && hasFlag(args, ["--raw"]))
			return ask("kubectl get --raw performs an arbitrary API request", fragment);
		return null;
	}

	const dryRun = flagValue(args, ["--dry-run"]);
	if (DRY_RUN_VERBS.has(verb) && (dryRun === "client" || dryRun === "server")) return null;
	if (WRITE_VERBS.has(verb)) return deny(`kubectl ${verb} is a write operation`, fragment);
	return ask(`kubectl ${verb} is not a recognised read verb`, fragment);
}
