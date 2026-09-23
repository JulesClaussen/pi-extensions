import { describe, it } from "node:test";
import { expectAll } from "./test-helpers.ts";

describe("scripts and inline interpreters", () => {
	it("allows harmless scripts and code", () =>
		expectAll("allow", [
			"bash scripts/clean.sh",
			"./scripts/clean.sh",
			"sh /repo/scripts/clean.sh",
			"source scripts/clean.sh",
			"bash scripts/missing.sh",
			"python3 -c 'print(1+1)'",
			"node -e 'console.log(process.version)'",
			"python3 tool_that_does_not_exist.py",
			"npm run build",
			"make test",
		]));

	it("asks when scripts or inline code touch infra tooling or credentials", () =>
		expectAll("ask", [
			"bash scripts/deploy.sh",
			"./scripts/deploy.sh",
			"bash -x scripts/deploy.sh --dry-run",
			"sh scripts/sneaky.sh",
			"source scripts/sneaky.sh",
			". scripts/sneaky.sh",
			"/repo/scripts/sneaky.sh",
			"python3 tool.py",
			'python3 -c \'import boto3; boto3.client("s3").delete_bucket(Bucket="x")\'',
			'python3 -c \'import os; os.environ["AWS_CONFIG_FILE"]="/Users/x/.aws/config"\'',
			"node -e 'require(\"@aws-sdk/client-s3\")'",
			"node -e 'process.env.AWS_PROFILE=\"acme-x-admin\"'",
			"ruby -e 'system(\"kubectl delete ns x\")'",
			'python3 -c \'import subprocess; subprocess.run(["terragrunt","apply"])\'',
		]));
});
