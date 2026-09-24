/**
 * AWS identity checks shared by the aws and terragrunt rules.
 *
 * The env layer already hides non `-dev` profiles from the process tree; these
 * checks make the failure explicit and block attempts to point the SDK at a
 * different config or static credentials.
 */

import { flagValue } from "../shell.ts";
import { type Command, deny, type Finding, isDevProfile, type RuleContext } from "../types.ts";

export const CREDENTIAL_OVERRIDES = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_ROLE_ARN",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT",
	"AWS_SDK_LOAD_CONFIG",
];

/** Profile selected for this command: inline assignment, `--profile`, earlier `asp`/`export`, or inherited env. */
export function resolveProfile(command: Command, ctx: RuleContext): string | undefined {
	return (
		command.assignments.AWS_PROFILE ??
		command.assignments.AWS_DEFAULT_PROFILE ??
		flagValue(command.args, ["--profile"]) ??
		ctx.awsProfile ??
		ctx.env.AWS_PROFILE ??
		ctx.env.AWS_DEFAULT_PROFILE
	);
}

export function checkAwsIdentity(
	command: Command,
	fragment: string,
	ctx: RuleContext,
	requireProfile: boolean,
): Finding | null {
	const override = CREDENTIAL_OVERRIDES.find((name) => name in command.assignments);
	if (override) return deny(`${override} override is not allowed; use a *-dev SSO profile`, fragment);

	const profile = resolveProfile(command, ctx);
	if (profile === undefined) {
		return requireProfile
			? deny("no AWS profile set; run with AWS_PROFILE=<account>-dev or --profile <account>-dev", fragment)
			: null;
	}
	if (!isDevProfile(profile))
		return deny(`AWS profile '${profile}' is not a *-dev (DeveloperAccess) profile`, fragment);
	return null;
}
