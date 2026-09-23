/**
 * docker: normal local workflows run silently; resource removal, pruning,
 * privileged/host-escaping containers, registry writes and remote endpoints
 * ask.
 */

import { flagValue, hasFlag, positionals } from "../shell.ts";
import { ask, type Command, type Finding } from "../types.ts";

const GLOBAL_VALUE_FLAGS = new Set([
	"--context",
	"-c",
	"--host",
	"-H",
	"--config",
	"--log-level",
	"-l",
	"--tlscacert",
	"--tlscert",
	"--tlskey",
]);

const REMOVAL = new Set(["rm", "rmi", "prune"]);
const REMOVAL_SUBCOMMANDS: Record<string, Set<string>> = {
	container: new Set(["rm", "prune", "kill"]),
	image: new Set(["rm", "prune"]),
	volume: new Set(["rm", "prune"]),
	network: new Set(["rm", "prune"]),
	system: new Set(["prune"]),
	builder: new Set(["prune"]),
	buildx: new Set(["prune", "rm"]),
	context: new Set(["rm", "create", "use", "update"]),
	compose: new Set(["rm", "exec", "run"]),
};
const REGISTRY = new Set(["push", "login", "logout"]);
const CONTROL_PLANE = new Set(["swarm", "node", "service", "stack", "secret", "config", "plugin"]);

const HOST_ESCAPE_FLAGS = ["--privileged", "--pid", "--userns", "--cap-add", "--device", "--security-opt"];

function mountsSensitive(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		let value: string | undefined;
		if (arg === "-v" || arg === "--volume" || arg === "--mount") value = args[i + 1];
		else if (arg.startsWith("-v") && arg.length > 2 && !arg.startsWith("--")) value = arg.slice(2);
		else if (arg.startsWith("--volume=") || arg.startsWith("--mount=")) value = arg.split("=", 2)[1];
		if (!value) continue;
		if (value.includes("docker.sock")) return "mounts the Docker socket";
		if (/^\/:|(^|,)(src|source)=\/(,|$)/.test(value)) return "mounts the host root filesystem";
	}
	return null;
}

export function classifyDocker(command: Command, fragment: string): Finding | null {
	const legacyCompose = command.name === "docker-compose";
	if (command.name !== "docker" && !legacyCompose) return null;
	const args = command.args;
	if (hasFlag(args, ["--help", "-h", "--version"]) || args.length === 0 || (args.length === 1 && args[0] === "-v"))
		return null;

	const remote =
		flagValue(args, ["--context", "-c", "--host", "-H"]) ??
		command.assignments.DOCKER_HOST ??
		command.assignments.DOCKER_CONTEXT;
	const rest = positionals(args, GLOBAL_VALUE_FLAGS);
	const [cmd, sub] = legacyCompose ? ["compose", ...rest] : rest;
	if (!cmd) return null;

	const mutating = ![
		"ps",
		"images",
		"logs",
		"inspect",
		"version",
		"info",
		"stats",
		"top",
		"port",
		"diff",
		"history",
		"events",
		"search",
	].includes(cmd);
	if (remote && mutating) return ask(`docker command targets remote endpoint ${remote}`, fragment);

	if (REMOVAL.has(cmd)) return ask(`docker ${cmd} removes resources`, fragment);
	if (REGISTRY.has(cmd)) return ask(`docker ${cmd} touches a registry`, fragment);
	if (CONTROL_PLANE.has(cmd)) return ask(`docker ${cmd} changes control-plane state`, fragment);
	if (cmd === "exec") return ask("docker exec runs a command in a container", fragment);

	const subs = REMOVAL_SUBCOMMANDS[cmd];
	if (subs && sub && subs.has(sub))
		return ask(`docker ${cmd} ${sub} removes resources or executes in containers`, fragment);
	if (cmd === "compose" && sub === "down" && hasFlag(args, ["-v", "--volumes", "--rmi"]))
		return ask("docker compose down removes volumes/images", fragment);
	if (cmd === "compose" && hasFlag(args, ["--remove-orphans"]))
		return ask("docker compose removes orphan containers", fragment);
	if (cmd === "compose" && sub === "push") return ask("docker compose push touches a registry", fragment);

	if (
		cmd === "run" ||
		cmd === "create" ||
		(cmd === "compose" && (sub === "run" || sub === "up")) ||
		cmd === "container"
	) {
		for (const flag of HOST_ESCAPE_FLAGS)
			if (hasFlag(args, [flag])) return ask(`docker ${cmd} uses ${flag}`, fragment);
		const mount = mountsSensitive(args);
		if (mount) return ask(`docker ${cmd} ${mount}`, fragment);
	}
	return null;
}
