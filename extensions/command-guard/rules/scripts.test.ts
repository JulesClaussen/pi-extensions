import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCommand } from "../policy.ts";
import { ctx, expectAll } from "./test-helpers.ts";

describe("scripts and inline interpreters", () => {
	it("allows scripts and code that only use infra tooling (env layer pins the identity)", () =>
		expectAll("allow", [
			"bash scripts/clean.sh",
			"./scripts/clean.sh",
			"sh /repo/scripts/clean.sh",
			"source scripts/clean.sh",
			"bash scripts/missing.sh",
			"bash scripts/deploy.sh",
			"python3 tool.py",
			"python3 scripts/import-blocks.py",
			"python3 -c 'print(1+1)'",
			"python3 -c 'import boto3; boto3.client(\"s3\").list_buckets()'",
			"node -e 'console.log(process.version)'",
			"node -e 'require(\"@aws-sdk/client-s3\")'",
			"node -e 'process.env.AWS_PROFILE=\"acme-x-admin\"'",
			'python3 -c \'import subprocess; subprocess.run(["terragrunt","plan"])\'',
			"python3 tool_that_does_not_exist.py",
			"npm run build",
			"make test",
		]));

	it("asks when scripts or inline code can bypass the env layer", () =>
		expectAll("ask", [
			"sh scripts/sneaky.sh",
			"source scripts/sneaky.sh",
			". scripts/sneaky.sh",
			"/repo/scripts/sneaky.sh",
			"python3 scripts/keys.py",
			'python3 -c \'import os; os.environ["AWS_CONFIG_FILE"]="/Users/x/.aws/config"\'',
			"node -e 'process.env.KUBECONFIG=\"/Users/x/.kube/config\"'",
			"python3 -c 'open(\"/Users/x/.aws/sso/cache/x.json\")'",
		]));

	it("names the offending token and line", async () => {
		const decision = await checkCommand("python3 scripts/keys.py", ctx);
		assert.equal(
			decision.findings[0]?.reason,
			"script scripts/keys.py references AWS_ACCESS_KEY_ID at line 3, which can bypass the *-dev env layer",
		);
	});
});
