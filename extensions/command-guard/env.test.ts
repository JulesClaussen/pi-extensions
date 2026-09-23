import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterAwsConfig, rewriteKubeconfig } from "./env.ts";

const AWS_CONFIG = `
[sso-session stoik]
sso_region = eu-west-1
sso_start_url = https://stoik.awsapps.com/start/#/

[default]
region = eu-west-1

[profile stoik-product-prod-admin]
sso_session = stoik
sso_role_name = AdministratorAccess

[profile stoik-product-prod-dev]
sso_session = stoik
sso_role_name = DeveloperAccess

[profile stoik-cyber-infra-dev-dev-euw3]
sso_session = stoik
region = eu-west-3

[profile stoik-root-admin]
sso_role_name = AdministratorAccess
`;

describe("filterAwsConfig", () => {
	it("keeps only *-dev profiles and sso-session blocks", () => {
		const { text, profiles } = filterAwsConfig(AWS_CONFIG);
		assert.equal(profiles, 2);
		assert.match(text, /\[sso-session stoik\]/);
		assert.match(text, /\[profile stoik-product-prod-dev\]/);
		assert.match(text, /\[profile stoik-cyber-infra-dev-dev-euw3\]/);
		assert.doesNotMatch(text, /admin/);
		assert.doesNotMatch(text, /\[default\]/);
		assert.doesNotMatch(text, /AdministratorAccess/);
	});
});

describe("rewriteKubeconfig", () => {
	it("rewrites -admin profiles in exec env and args to -dev", () => {
		const { config, users } = rewriteKubeconfig({
			users: [
				{
					name: "a",
					user: {
						exec: {
							command: "aws",
							args: ["eks", "get-token"],
							env: [{ name: "AWS_PROFILE", value: "stoik-product-prod-admin" }],
						},
					},
				},
				{
					name: "b",
					user: { exec: { command: "aws", args: ["--profile", "stoik-cert-prod-admin", "eks", "get-token"] } },
				},
				{
					name: "c",
					user: { exec: { command: "aws", env: [{ name: "AWS_PROFILE", value: "stoik-cert-prod-dev" }] } },
				},
				{ name: "orbstack", user: {} },
			],
		});
		assert.equal(users, 3);
		assert.equal(config.users?.[0].user?.exec?.env?.[0].value, "stoik-product-prod-dev");
		assert.equal(config.users?.[1].user?.exec?.args?.[1], "stoik-cert-prod-dev");
		assert.equal(config.users?.[2].user?.exec?.env?.[0].value, "stoik-cert-prod-dev");
	});
});
