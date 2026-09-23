/**
 * Minimal shell parsing shared by every rule.
 *
 * Token-based, not a real shell parse. It is deliberately conservative: a
 * false positive costs one confirmation prompt.
 */

import { basename } from "node:path";
import type { Command } from "./types.ts";

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

/** Unquoted redirection targets (`> file`, `>>file`, `2>file`, `&> file`). `/dev/null` is skipped. */
export function redirectionTargets(segment: string): string[] {
	const masked = maskLiterals(segment);
	const targets: string[] = [];
	for (const match of masked.matchAll(/(?:\d*&?>{1,2}\|?|<>)\s*/g)) {
		const start = match.index + match[0].length;
		const rest = segment.slice(start);
		const token = tokenize(rest)[0];
		if (token && !token.startsWith("&") && token !== "/dev/null") targets.push(token);
	}
	return targets;
}

const KEYWORDS = new Set(["then", "do", "else", "elif", "!", "if", "while", "until"]);
export const WRAPPERS = new Set([
	"builtin",
	"command",
	"env",
	"exec",
	"nice",
	"nohup",
	"sudo",
	"time",
	"timeout",
	"xargs",
	"caffeinate",
]);
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-n", "-I", "-L", "-P", "-d", "-s", "-k", "-C"]);
const WRAPPER_POSITIONALS: Record<string, number> = { timeout: 1 };
export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
export const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/** Resolve the effective command of a segment, looking through keywords, env assignments and wrappers. */
export function parseCommand(segment: string): Command | null {
	const tokens = tokenize(segment);
	const assignments: Record<string, string> = {};
	const wrappers: string[] = [];
	let i = 0;
	for (;;) {
		if (i >= tokens.length) return null;
		const token = tokens[i].replace(/^[({]+/, "");
		if (!token || KEYWORDS.has(token)) {
			i++;
			continue;
		}
		const assignment = ENV_ASSIGNMENT.exec(token);
		if (assignment) {
			assignments[assignment[1]] = assignment[2];
			i++;
			continue;
		}
		const name = basename(token);
		if (!WRAPPERS.has(name)) return { name, raw: token, args: tokens.slice(i + 1), assignments, wrappers };

		wrappers.push(name);
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
				const assignment = ENV_ASSIGNMENT.exec(next);
				if (assignment) assignments[assignment[1]] = assignment[2];
				i++;
			} else if (positionals > 0) {
				positionals--;
				i++;
			} else break;
		}
	}
}

/** Split `--flag=value` into `[flag, value]`; `[arg, undefined]` when there is no `=`. */
export function splitFlag(arg: string): [string, string | undefined] {
	const eq = arg.indexOf("=");
	return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/** Positional arguments, skipping flags and the values of the given value-taking flags. */
export function positionals(args: string[], valueFlags: Set<string>): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			out.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("-")) {
			const [flag, inline] = splitFlag(arg);
			if (inline === undefined && valueFlags.has(flag)) i++;
			continue;
		}
		out.push(arg);
	}
	return out;
}

/** Value of a flag given as `--flag value`, `--flag=value` or `-Xvalue` (for single-letter short flags). */
export function flagValue(args: string[], flags: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return undefined;
		for (const flag of flags) {
			if (arg === flag) return args[i + 1];
			if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
			if (flag.length === 2 && !flag.startsWith("--") && arg.startsWith(flag) && arg.length > 2) return arg.slice(2);
		}
	}
	return undefined;
}

export function hasFlag(args: string[], flags: string[]): boolean {
	return args.some((arg) => arg !== "--" && flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

/** Expand `~`, `$HOME` and `${HOME}` at the start of a path. */
export function expandHome(path: string, home: string): string {
	return path.replace(/^(~|\$HOME|\$\{HOME\})(?=$|\/)/, home);
}
