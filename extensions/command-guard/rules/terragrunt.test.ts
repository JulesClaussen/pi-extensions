import { describe, it } from "node:test";
import { expectAll, makeContext } from "./test-helpers.ts";

const dev = makeContext({ env: { AWS_PROFILE: "stoik-cyber-infra-prod-dev" } });
const none = makeContext({ env: {} });

describe("terragrunt", () => {
	it("allows plan and read commands", () =>
		expectAll(
			"allow",
			[
				"terragrunt plan",
				"terragrunt plan -out=plan.tfplan",
				"terragrunt plan -destroy",
				"terragrunt init",
				"terragrunt init -upgrade",
				"terragrunt validate",
				"terragrunt validate-inputs",
				"terragrunt output -json",
				"terragrunt show plan.tfplan",
				"terragrunt providers",
				"terragrunt state list",
				"terragrunt state show aws_s3_bucket.b",
				"terragrunt state pull",
				"terragrunt workspace list",
				"terragrunt graph",
				"terragrunt hcl fmt",
				"terragrunt hcl validate",
				"terragrunt hclfmt --check",
				"terragrunt render-json",
				"terragrunt run-all plan",
				"terragrunt run-all init",
				"terragrunt run --all plan",
				"terragrunt run -- plan -out=x",
				"terragrunt --version",
				"terragrunt info",
				"terragrunt dag graph",
				"cd infrastructure/terraform/prod && terragrunt plan",
				"AWS_PROFILE=stoik-data-prod-dev terragrunt plan",
			],
			dev,
		));

	it("denies mutations", () =>
		expectAll(
			"deny",
			[
				"terragrunt apply",
				"terragrunt apply -auto-approve",
				"terragrunt apply plan.tfplan",
				"terragrunt destroy",
				"terragrunt import aws_s3_bucket.b bucket",
				"terragrunt state mv a b",
				"terragrunt state rm a",
				"terragrunt state push x",
				"terragrunt state replace-provider a b",
				"terragrunt taint a",
				"terragrunt untaint a",
				"terragrunt force-unlock id",
				"terragrunt refresh",
				"terragrunt workspace new x",
				"terragrunt workspace select x",
				"terragrunt run-all apply",
				"terragrunt run-all destroy --terragrunt-non-interactive",
				"terragrunt run --all apply",
				"terragrunt run -- apply",
				"terragrunt exec -- aws s3 ls",
				"terragrunt stack run apply",
				"terragrunt plan && terragrunt apply",
				"terragrunt something-new",
			],
			dev,
		));

	it("enforces the *-dev profile", async () => {
		await expectAll(
			"deny",
			[
				"terragrunt plan",
				"AWS_PROFILE=stoik-cyber-infra-prod-admin terragrunt plan",
				"asp stoik-x-admin && terragrunt plan",
			],
			none,
		);
		await expectAll("allow", ["terragrunt hcl fmt", "terragrunt --version", "terragrunt render-json"], none);
	});
});

describe("terraform", () => {
	it("is always denied in favour of terragrunt", () =>
		expectAll(
			"deny",
			[
				"terraform plan",
				"terraform init",
				"terraform apply",
				"terraform state list",
				"terraform fmt -recursive",
				"tofu plan",
				"cd infra && terraform plan",
				"sudo terraform apply",
				"bash -c 'terraform apply -auto-approve'",
			],
			dev,
		));

	it("does not trip on terraform inside strings or paths", () =>
		expectAll(
			"allow",
			["rg 'terraform' infrastructure/", "ls infrastructure/terraform", "cat infrastructure/terraform/main.tf"],
			dev,
		));
});
