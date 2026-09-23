import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFileWrite } from "../policy.ts";
import { ctx, expectAll, HOME } from "./test-helpers.ts";

describe("protected paths via bash", () => {
	it("allows read-only access", () =>
		expectAll("allow", [
			"cat ~/.aws/config",
			`cat ${HOME}/.aws/config`,
			"cat $HOME/.aws/config",
			"grep -n profile ~/.aws/config",
			"rg 'sso_role_name' ~/.aws/config",
			"less ~/.kube/config",
			"ls -la ~/.aws/",
			"yq '.contexts[].name' ~/.kube/config",
			"sed -n 's/x/y/p' ~/.aws/config",
			"awk '/profile/' ~/.aws/config",
			"diff ~/.aws/config ~/.aws/config.bak",
			"cat $AWS_CONFIG_FILE",
			"cat $KUBECONFIG",
			"cat ~/.aws/config > /tmp/copy",
			"ls ~/.aws 2>/dev/null",
			"cat ~/.pi/agent/settings.json",
			"cat /ext/pi-extensions/extensions/command-guard/index.ts",
		]));

	it("denies writes, moves, deletions and in-place edits", () =>
		expectAll("deny", [
			"echo '[profile x]' >> ~/.aws/config",
			"echo x > ~/.aws/credentials",
			`echo x > ${HOME}/.aws/config`,
			"echo x > $HOME/.aws/config",
			"echo x >$HOME/.aws/config",
			"cat new.cfg > ~/.aws/config",
			"printf 'x' | tee ~/.aws/config",
			"printf 'x' | tee -a ~/.kube/config",
			"cp new.cfg ~/.aws/config",
			"mv ~/.aws/config ~/.aws/config.old",
			"rm ~/.aws/config",
			"rm -rf ~/.kube",
			"ln -s /tmp/x ~/.aws/config",
			"chmod 777 ~/.aws/config",
			"touch ~/.aws/credentials",
			"sed -i 's/admin/dev/' ~/.aws/config",
			"sed -i.bak 's/a/b/' ~/.kube/config",
			"yq -i '.x=1' ~/.kube/config",
			"perl -pi -e 's/a/b/' ~/.aws/config",
			"python3 write.py ~/.aws/config",
			"vim ~/.aws/config",
			"echo x > $AWS_CONFIG_FILE",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax
			"echo x >> ${KUBECONFIG}",
			"cp x $AWS_CONFIG_FILE",
			"echo x > ~/.pi/agent/settings.json",
			"echo x > ~/.pi/agent/command-guard/aws-config",
			"echo x > /ext/pi-extensions/extensions/command-guard/rules/aws.ts",
			"rm -rf /ext/pi-extensions",
			"cd ~/.aws && rm config",
			"cd ~/.aws; echo x > config",
			"bash -c 'echo x > ~/.aws/config'",
			"sudo rm ~/.kube/config",
		]));

	it("does not trip on unrelated paths", () =>
		expectAll("allow", [
			"echo x > ~/.awsome/config",
			"rm -rf node_modules",
			"echo x > /tmp/.aws/config",
			"cp a b",
			"echo x > ./config",
		]));
});

describe("protected paths via edit/write tools", () => {
	it("denies protected paths and allows others", () => {
		for (const path of [
			`${HOME}/.aws/config`,
			"~/.kube/config",
			`${HOME}/.pi/agent/settings.json`,
			"/ext/pi-extensions/extensions/command-guard/index.ts",
		]) {
			assert.equal(checkFileWrite(path, ctx).verdict, "deny", path);
		}
		for (const path of ["/repo/src/index.ts", `${HOME}/.awsome/x`, "/tmp/.aws/config", "relative/file.ts"]) {
			assert.equal(checkFileWrite(path, ctx).verdict, "allow", path);
		}
	});
});
