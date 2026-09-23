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

/** One shell command position after keywords, env assignments and wrappers are stripped. */
export interface Command {
	/** Command name with any directory prefix stripped (`/usr/bin/aws` -> `aws`). */
	name: string;
	/** Raw command token before basename stripping (`./deploy.sh`). */
	raw: string;
	/** Everything after the command name. */
	args: string[];
	/** Leading `KEY=value` assignments (`AWS_PROFILE=x aws ...`). */
	assignments: Record<string, string>;
	/** Wrapper commands that were looked through (`sudo`, `xargs`, ...). */
	wrappers: string[];
}

export interface RuleContext {
	/** Directory the segment runs in (tracks `cd` and `git -C`). */
	cwd: string;
	home: string;
	/** Environment the bash tool inherits. */
	env: Record<string, string | undefined>;
	/** AWS profile selected earlier in the same command line (`asp x` / `export AWS_PROFILE=x`). */
	awsProfile?: string;
	/** Absolute paths (already `~`-expanded) that must never be written by the agent. */
	protectedPaths: string[];
	currentBranch: (cwd: string) => Promise<string | null>;
	readFile: (path: string) => string | null;
}

export type Rule = (command: Command, segment: string, ctx: RuleContext) => Finding | null | Promise<Finding | null>;

export function ask(reason: string, fragment: string): Finding {
	return { verdict: "ask", reason, fragment };
}

export function deny(reason: string, fragment: string): Finding {
	return { verdict: "deny", reason, fragment };
}

export const DEV_PROFILE = /-dev(-euw3)?$/;

export function isDevProfile(profile: string): boolean {
	return DEV_PROFILE.test(profile);
}
