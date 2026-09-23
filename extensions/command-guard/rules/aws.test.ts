import { describe, it } from "node:test";
import { expectAll, makeContext } from "./test-helpers.ts";

const dev = makeContext({ env: { AWS_PROFILE: "stoik-product-prod-dev" } });
const none = makeContext({ env: {} });

describe("aws profile", () => {
	it("allows *-dev profiles from any source", () =>
		expectAll(
			"allow",
			[
				"aws sts get-caller-identity",
				"AWS_PROFILE=stoik-cert-staging-dev aws s3 ls",
				"aws --profile stoik-cyber-infra-dev-dev-euw3 ec2 describe-instances",
				"aws ec2 describe-instances --profile=stoik-data-prod-dev",
				"asp stoik-product-prod-dev && aws s3 ls",
				"export AWS_PROFILE=stoik-product-prod-dev; aws s3 ls",
			],
			dev,
		));

	it("denies non-dev profiles", () =>
		expectAll(
			"deny",
			[
				"AWS_PROFILE=stoik-product-prod-admin aws s3 ls",
				"aws --profile stoik-root-admin sts get-caller-identity",
				"aws s3 ls --profile stoik-ops-prod-admin",
				"asp stoik-product-prod-admin",
				"asp stoik-product-prod-admin && aws s3 ls",
				"export AWS_PROFILE=stoik-x-admin && aws s3 ls",
				"aws s3 ls",
			],
			makeContext({ env: { AWS_PROFILE: "stoik-product-prod-admin" } }),
		));

	it("denies credential and config overrides", () =>
		expectAll(
			"deny",
			[
				"AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=y aws s3 ls",
				"AWS_CONFIG_FILE=~/.aws/config aws s3 ls",
				"AWS_SHARED_CREDENTIALS_FILE=/tmp/creds aws s3 ls",
				"aws configure set aws_access_key_id x",
				"aws configure",
				"aws configure export-credentials",
				"aws sso get-role-credentials --role-name AdministratorAccess",
				"aws sts assume-role --role-arn arn:x",
				"aws eks update-kubeconfig --name prod",
			],
			dev,
		));

	it("denies when no profile is set, except credential-free commands", async () => {
		await expectAll("deny", ["aws s3 ls", "aws ec2 describe-instances"], none);
		await expectAll(
			"allow",
			[
				"aws sso login --sso-session stoik",
				"aws configure list",
				"aws configure list-profiles",
				"aws --version",
				"aws help",
			],
			none,
		);
	});
});

describe("aws operations", () => {
	it("allows reads", () =>
		expectAll(
			"allow",
			[
				"aws ec2 describe-instances --region eu-west-1",
				"aws s3 ls s3://bucket/prefix/",
				"aws s3 cp s3://bucket/key ./local",
				"aws s3 sync s3://bucket ./local",
				"aws s3api list-objects-v2 --bucket b",
				"aws s3api get-object --bucket b --key k out.txt",
				"aws logs tail /aws/lambda/fn --follow",
				"aws logs filter-log-events --log-group-name g",
				"aws cloudwatch get-metric-statistics --namespace x",
				"aws iam list-roles --query 'Roles[].RoleName' --output text",
				"aws iam simulate-principal-policy --policy-source-arn x",
				"aws ssm get-parameter --name /x",
				"aws dynamodb scan --table-name t",
				"aws dynamodb query --table-name t",
				"aws eks describe-cluster --name c",
				"aws eks list-clusters",
				"aws rds describe-db-instances",
				"aws ecr describe-repositories",
				"aws ec2 wait instance-running --instance-ids i-1",
				"aws ec2 describe-instances help",
				"aws lambda get-function --function-name f",
				"aws sts get-caller-identity --no-cli-pager",
			],
			dev,
		));

	it("asks for sensitive reads and unknown operations", () =>
		expectAll(
			"ask",
			[
				"aws secretsmanager get-secret-value --secret-id s",
				"aws ssm get-parameter --name /x --with-decryption",
				"aws ssm get-parameters-by-path --path / --with-decryption",
				"aws kms decrypt --ciphertext-blob x",
				"aws ecr get-login-password",
				"aws sts get-session-token",
				"aws rds generate-db-auth-token --hostname h",
				"aws ec2 some-new-operation",
				"aws s3 something-odd",
			],
			dev,
		));

	it("denies mutations", () =>
		expectAll(
			"deny",
			[
				"aws ec2 terminate-instances --instance-ids i-1",
				"aws ec2 run-instances --image-id ami",
				"aws ec2 stop-instances --instance-ids i-1",
				"aws s3 cp ./local s3://bucket/key",
				"aws s3 sync ./dist s3://bucket",
				"aws s3 rm s3://bucket/key",
				"aws s3 mv s3://a s3://b",
				"aws s3 rb s3://bucket",
				"aws s3api put-object --bucket b --key k",
				"aws s3api delete-object --bucket b --key k",
				"aws iam create-user --user-name u",
				"aws iam attach-role-policy --role-name r",
				"aws lambda invoke --function-name f out.json",
				"aws lambda update-function-code --function-name f",
				"aws ssm put-parameter --name /x --value v",
				"aws secretsmanager put-secret-value --secret-id s",
				"aws rds modify-db-instance --db-instance-identifier d",
				"aws eks update-nodegroup-config --cluster-name c",
				"aws sns publish --topic-arn t",
				"aws sqs send-message --queue-url q",
				"aws kms encrypt --key-id k",
				"aws ses verify-email-identity --email-address e",
				"aws ec2 describe-instances && aws ec2 terminate-instances --instance-ids i-1",
			],
			dev,
		));
});
