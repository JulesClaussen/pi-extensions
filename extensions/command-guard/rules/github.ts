/**
 * gh: read/list commands run silently; everything else (and anything
 * unrecognised) asks for approval.
 */

import { ask, type Command, type Finding } from "../types.ts";

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

export function classifyGh(command: Command, fragment: string): Finding | null {
	if (command.name !== "gh") return null;
	const args = command.args;
	if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version")) return null;

	const positionals = args.filter((arg) => !arg.startsWith("-"));
	const [cmd, sub] = positionals;
	if (!cmd) return null;

	if (cmd === "api") {
		return ghApiIsRead(args) ? null : ask("gh api call with a body or non-GET method", fragment);
	}

	const allowed = GH_READ[cmd];
	if (allowed === "*") return null;
	if (allowed && sub && allowed.has(sub)) return null;

	return ask(`gh ${[cmd, sub].filter(Boolean).join(" ")} is not a read-only command`, fragment);
}
