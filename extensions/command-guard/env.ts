/**
 * Environment layer: makes the *-dev (DeveloperAccess) role the only identity
 * the agent's process tree can resolve.
 *
 *   - AWS_CONFIG_FILE -> generated copy of ~/.aws/config with only *-dev profiles
 *   - AWS_SHARED_CREDENTIALS_FILE -> non-existent file (no static keys)
 *   - KUBECONFIG -> generated copy of the kubeconfig with -admin profiles rewritten to -dev
 *   - inherited AWS_PROFILE dropped unless it is a *-dev profile
 *
 * Everything that honours the standard AWS credential chain (CLI, SDKs,
 * terraform providers under terragrunt, kubectl exec plugins) inherits this.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDevProfile } from "./types.ts";

export interface EnvReport {
	dir: string;
	awsConfigFile?: string;
	awsProfiles: number;
	kubeconfig?: string;
	kubeUsers: number;
	droppedProfile?: string;
	warnings: string[];
}

/** Keep sso-session/services sections and *-dev profiles; drop everything else. */
export function filterAwsConfig(config: string): { text: string; profiles: number } {
	const out: string[] = [];
	let keep = false;
	let profiles = 0;
	for (const line of config.split("\n")) {
		const header = /^\s*\[\s*(.+?)\s*\]\s*$/.exec(line);
		if (header) {
			const section = header[1];
			const profile = /^profile\s+(.+)$/.exec(section);
			keep = profile
				? isDevProfile(profile[1])
				: /^(sso-session|services|plugins)\s/.test(section) || section === "plugins";
			if (profile && keep) profiles++;
		}
		if (keep) out.push(line);
	}
	return { text: `${out.join("\n").trim()}\n`, profiles };
}

interface KubeExec {
	command?: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
}
interface Kubeconfig {
	users?: Array<{ name: string; user?: { exec?: KubeExec } }>;
}

/** Rewrite exec-plugin profiles so every context authenticates with the *-dev role. */
export function rewriteKubeconfig(config: Kubeconfig): { config: Kubeconfig; users: number } {
	let users = 0;
	for (const entry of config.users ?? []) {
		const exec = entry.user?.exec;
		if (!exec) continue;
		users++;
		for (const variable of exec.env ?? []) {
			if (variable.name === "AWS_PROFILE" && !isDevProfile(variable.value))
				variable.value = variable.value.replace(/-admin$/, "-dev");
		}
		const args = exec.args ?? [];
		const index = args.indexOf("--profile");
		if (index >= 0 && args[index + 1] && !isDevProfile(args[index + 1]))
			args[index + 1] = args[index + 1].replace(/-admin$/, "-dev");
	}
	return { config, users };
}

function writePrivate(path: string, content: string) {
	writeFileSync(path, content, { mode: 0o600 });
	chmodSync(path, 0o600);
}

export function applyEnv(home: string, dir: string, env: NodeJS.ProcessEnv = process.env): EnvReport {
	const report: EnvReport = { dir, awsProfiles: 0, kubeUsers: 0, warnings: [] };
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const awsConfigPath = join(home, ".aws", "config");
	if (existsSync(awsConfigPath)) {
		const filtered = filterAwsConfig(readFileSync(awsConfigPath, "utf-8"));
		report.awsConfigFile = join(dir, "aws-config");
		writePrivate(report.awsConfigFile, filtered.text);
		report.awsProfiles = filtered.profiles;
		env.AWS_CONFIG_FILE = report.awsConfigFile;
		env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "no-credentials");
	} else report.warnings.push(`${awsConfigPath} not found; AWS_CONFIG_FILE left untouched`);

	for (const name of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE"]) {
		const value = env[name];
		if (value && !isDevProfile(value)) {
			report.droppedProfile = value;
			delete env[name];
		}
	}
	for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
		if (env[name]) {
			report.warnings.push(`dropped inherited ${name}`);
			delete env[name];
		}
	}

	const sourceKubeconfig = env.KUBECONFIG?.split(":")[0] ?? join(home, ".kube", "config");
	if (existsSync(sourceKubeconfig)) {
		try {
			const raw = execFileSync(
				"kubectl",
				["config", "view", "--raw", "-o", "json", "--kubeconfig", sourceKubeconfig],
				{
					encoding: "utf-8",
					timeout: 10_000,
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			const rewritten = rewriteKubeconfig(JSON.parse(raw) as Kubeconfig);
			report.kubeconfig = join(dir, "kubeconfig");
			writePrivate(report.kubeconfig, JSON.stringify(rewritten.config, null, 2));
			report.kubeUsers = rewritten.users;
			env.KUBECONFIG = report.kubeconfig;
		} catch (error) {
			report.warnings.push(
				`kubeconfig rewrite failed (${error instanceof Error ? error.message : String(error)}); KUBECONFIG left untouched`,
			);
		}
	}
	return report;
}
