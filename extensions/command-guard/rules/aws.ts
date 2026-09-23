/**
 * aws CLI: only *-dev profiles; read operations run silently, sensitive reads
 * ask, mutations are denied, unknown operations ask.
 */

import { hasFlag, positionals } from "../shell.ts";
import { ask, type Command, deny, type Finding, type RuleContext } from "../types.ts";
import { checkAwsIdentity } from "./aws-profile.ts";

const AWS_GLOBAL_VALUE_FLAGS = new Set([
	"--profile",
	"--region",
	"--output",
	"--query",
	"--endpoint-url",
	"--cli-connect-timeout",
	"--cli-read-timeout",
	"--ca-bundle",
	"--color",
	"--cli-binary-format",
]);

/** Commands that need no credentials and are safe without a profile. */
const NO_CREDENTIAL = [/^sso (login|logout)$/, /^configure (list|get|list-profiles)$/, /^(help|--version)$/];

const READ_PREFIXES = [
	"describe-",
	"get-",
	"list-",
	"head-",
	"search-",
	"lookup-",
	"batch-get-",
	"check-",
	"estimate-",
	"preview-",
	"validate-",
	"simulate-",
	"filter-",
	"select-",
	"count-",
	"query",
	"scan",
	"wait",
	"help",
];

const WRITE_PREFIXES = [
	"create-",
	"delete-",
	"put-",
	"update-",
	"modify-",
	"start-",
	"stop-",
	"terminate-",
	"reboot-",
	"run-",
	"attach-",
	"detach-",
	"associate-",
	"disassociate-",
	"register-",
	"deregister-",
	"enable-",
	"disable-",
	"add-",
	"remove-",
	"set-",
	"tag-",
	"untag-",
	"restore-",
	"reset-",
	"revoke-",
	"authorize-",
	"cancel-",
	"invoke",
	"publish",
	"send-",
	"import-",
	"copy-",
	"upload-",
	"complete-",
	"abort-",
	"accept-",
	"reject-",
	"promote-",
	"replace-",
	"release-",
	"allocate-",
	"purchase-",
	"request-",
	"apply-",
	"execute-",
	"rotate-",
	"assume-",
	"admin-",
	"batch-delete-",
	"batch-write-",
	"batch-put-",
	"batch-update-",
	"deploy",
	"submit-",
	"signal-",
	"resume-",
	"suspend-",
	"activate-",
	"deactivate-",
	"increase-",
	"decrease-",
	"merge-",
	"move-",
	"rename-",
	"initiate-",
	"issue-",
	"schedule-",
	"unlock-",
	"lock-",
	"grant-",
	"retire-",
	"encrypt",
	"re-encrypt",
	"generate-data-key",
	"change-",
	"confirm-",
	"continue-",
	"disable",
	"enable",
	"flush-",
	"invalidate-",
	"kill-",
	"notify-",
	"open-",
	"close-",
	"pause-",
	"post-",
	"provision-",
	"purge-",
	"push-",
	"reboot",
	"redact-",
	"refresh-",
	"reindex-",
	"remove",
	"renew-",
	"resend-",
	"retry-",
	"transfer-",
	"unassign-",
	"assign-",
	"unsubscribe",
	"subscribe",
	"verify-",
	"wipe",
];

/** Reads that expose credentials or secret material. */
const SENSITIVE_READS: Array<[RegExp, string]> = [
	[/^secretsmanager (get-secret-value|batch-get-secret-value)$/, "reads secret values"],
	[/^kms decrypt$/, "decrypts data"],
	[/^sts (get-session-token|get-federation-token)$/, "mints credentials"],
	[/^ecr get-login-password$/, "returns a registry credential"],
	[/^rds generate-db-auth-token$/, "returns a database credential"],
	[/^cognito-idp admin-/, "administers user pool accounts"],
	[/^iam get-(login-profile|access-key-last-used)$/, "inspects credentials"],
];

const DENIED: Array<[RegExp, string]> = [
	[/^configure(?! (list|get|list-profiles)$)/, "aws configure writes credentials/config"],
	[/^sso (get-role-credentials|logout)$/, "manipulates SSO credentials"],
	[/^sso-oidc /, "manipulates SSO tokens"],
	[/^sts assume-role/, "changes identity"],
	[/^eks update-kubeconfig$/, "writes the kubeconfig; contexts are managed outside the agent"],
];

function classifyS3(operation: string, args: string[], fragment: string): Finding | null {
	const rest = positionals(
		args,
		new Set(["--exclude", "--include", "--sse", "--sse-kms-key-id", "--storage-class", "--acl"]),
	);
	switch (operation) {
		case "ls":
		case "presign":
			return null;
		case "cp":
		case "sync":
		case "mv": {
			const destination = rest[rest.length - 1] ?? "";
			if (operation === "mv") return deny("aws s3 mv deletes the source object", fragment);
			return destination.startsWith("s3://") ? deny(`aws s3 ${operation} writes to S3`, fragment) : null;
		}
		case "rm":
		case "rb":
		case "mb":
		case "website":
			return deny(`aws s3 ${operation} mutates S3`, fragment);
		default:
			return ask(`aws s3 ${operation} is not a recognised read operation`, fragment);
	}
}

export function classifyAws(command: Command, fragment: string, ctx: RuleContext): Finding | null {
	if (command.name !== "aws") return null;
	const args = command.args;
	if (hasFlag(args, ["--version"]) || args.length === 0) return null;

	const rest = positionals(args, AWS_GLOBAL_VALUE_FLAGS);
	const [service, operation, ...operands] = rest;
	if (!service) return null;
	const path = [service, operation].filter(Boolean).join(" ");

	const credentialFree = NO_CREDENTIAL.some((pattern) => pattern.test(path));
	const identity = checkAwsIdentity(command, fragment, ctx, !credentialFree);
	if (identity) return identity;
	if (credentialFree) return null;
	if (service === "help" || operation === "help" || hasFlag(args, ["--help", "-h"])) return null;

	for (const [pattern, reason] of DENIED) if (pattern.test(path)) return deny(`aws ${path} ${reason}`, fragment);
	for (const [pattern, reason] of SENSITIVE_READS)
		if (pattern.test(path)) return ask(`aws ${path} ${reason}`, fragment);
	if (!operation) return null;

	if (service === "s3") return classifyS3(operation, args.slice(args.indexOf(operation) + 1), fragment);
	if (service === "ssm" && /^get-parameters?(-by-path)?$/.test(operation) && hasFlag(args, ["--with-decryption"])) {
		return ask(`aws ${path} --with-decryption reads secret values`, fragment);
	}
	if (service === "logs" && (operation === "tail" || operation === "start-live-tail")) return null;
	if (service === "sts" && operation === "get-caller-identity") return null;
	if (service === "ecr" && operation === "get-login-password")
		return ask("aws ecr get-login-password returns a credential", fragment);
	if (service === "s3api" && /^(put|delete|create|abort|complete|upload|copy|restore|write)-/.test(operation)) {
		return deny(`aws ${path} mutates S3`, fragment);
	}

	if (WRITE_PREFIXES.some((prefix) => operation.startsWith(prefix)))
		return deny(`aws ${path} is a mutation`, fragment);
	if (READ_PREFIXES.some((prefix) => operation.startsWith(prefix))) return null;
	if (operands.includes("help")) return null;
	return ask(`aws ${path} is not a recognised read operation`, fragment);
}
