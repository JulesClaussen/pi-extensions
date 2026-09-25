import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Env } from "./rules.ts";

export interface Invocation {
	command: string;
	args: string[];
}

export interface ChildResult {
	exitCode: number;
	stderr: string;
	aborted: boolean;
}

const KILL_GRACE_MS = 5_000;

/** Re-invokes the running pi the same way it was started (node script, compiled binary, or `pi` on PATH). */
export function piInvocation(args: string[]): Invocation {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** Runs a JSONL-emitting child, calling `onEvent` for every parsed record on stdout. */
export function runChild(
	invocation: Invocation,
	options: { cwd: string; env: Env; signal?: AbortSignal; onEvent: (event: unknown) => void },
): Promise<ChildResult> {
	return new Promise((resolve) => {
		const { signal, onEvent } = options;
		if (signal?.aborted) {
			resolve({ exitCode: 1, stderr: "", aborted: true });
			return;
		}

		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		let stderr = "";
		let aborted = false;
		let settled = false;

		const processLine = (line: string) => {
			const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (!trimmed.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(trimmed);
			} catch {
				return;
			}
			onEvent(event);
		};

		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				processLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});

		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		const kill = () => {
			aborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}, KILL_GRACE_MS).unref();
		};
		signal?.addEventListener("abort", kill, { once: true });

		const finish = (exitCode: number, extraError?: string) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", kill);
			if (buffer) processLine(buffer);
			resolve({ exitCode, stderr: extraError ? `${stderr}${extraError}` : stderr, aborted });
		};

		proc.on("close", (code) => finish(code ?? 1));
		proc.on("error", (error) => finish(1, error.message));
	});
}
