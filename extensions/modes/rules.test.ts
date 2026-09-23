import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReadOnlyCommand, needsConfirmation, nextMode, previewEdits } from "./rules.ts";

const expectReadOnly = (expected: boolean, commands: string[]) => {
	for (const command of commands) {
		assert.equal(isReadOnlyCommand(command), expected, `${command} should be read-only=${expected}`);
	}
};

describe("read-only bash", () => {
	it("accepts plain readers and pipelines", () =>
		expectReadOnly(true, [
			"ls -la",
			"cat package.json",
			"rg -n foo src/ | head -20",
			"grep -r TODO . && wc -l README.md",
			"cd /repo && ls",
			"find . -name '*.ts' | xargs grep foo",
			"echo $(git rev-parse HEAD)",
			"FOO=bar env | sort",
			"env | grep AWS",
			"env -i",
			"sed -n '1,10p' file.ts",
			"awk '{print $1}' file",
			"echo hi > /dev/null",
			"timeout 5 cat big.log",
			"jq .name package.json",
			"diff a b",
			"pwd",
		]));

	it("accepts read-only subcommands", () =>
		expectReadOnly(true, [
			"git status",
			"git log --oneline -5",
			"git diff HEAD~1",
			"git -C /repo show HEAD",
			"git --no-pager branch -a",
			"git branch",
			"git branch -a",
			"git branch --show-current",
			"git branch --contains abc",
			"git tag",
			"git tag -l 'v*'",
			"git remote",
			"git remote get-url origin",
			"git stash show -p",
			"git config --list",
			"git config user.name",
			"git worktree list",
			"git reflog",
			"gh -R o/r pr list",
			"gh pr checks 12",
			"gh auth status",
			"kubectl -n x get pods",
			"kubectl auth can-i list pods",
			"aws --profile acme-dev sts get-caller-identity",
			"npm config get registry",
			"git remote -v",
			"git stash list",
			"git config --get user.name",
			"gh pr list",
			"gh pr view 12 --json title",
			"gh run list",
			"gh api repos/o/r/pulls",
			"npm ls",
			"npm view react version",
			"docker ps",
			"kubectl get pods -n x",
			"kubectl config current-context",
			"aws sts get-caller-identity",
			"terragrunt output",
			"go version",
		]));

	it("rejects writes, mutations and unknown commands", () =>
		expectReadOnly(false, [
			"echo hi > file",
			"cat a >> b",
			"ls | tee out.txt",
			"sed -i 's/a/b/' file",
			"perl -pi -e 's/a/b/' file",
			"rm -rf dist",
			"mkdir x",
			"touch x",
			"cp a b",
			"mv a b",
			"npm install",
			"npm test",
			"npm run build",
			"git commit -m x",
			"git add .",
			"git push",
			"git checkout -b x",
			"git branch -d x",
			"git branch -D x",
			"git tag v1",
			"git tag -a v1 -m x",
			"git tag -d v1",
			"git branch feat",
			"git branch -m a b",
			"git remote set-url origin x",
			"git symbolic-ref HEAD refs/heads/x",
			"git reflog expire --all",
			"git -C /repo commit -m x",
			"gh pr checkout 1",
			"gh workflow run ci.yml",
			"gh api --method DELETE repos/o/r",
			"kubectl -n x delete pod y",
			"kubectl auth reconcile -f x",
			"aws sts get-session-token",
			"go env -w GOFLAGS=x",
			"env rm x",
			"FOO=bar env npm install",
			"git remote add o url",
			"git stash",
			"git stash pop",
			"git config user.name x",
			"git config --unset user.name",
			"git worktree add ../x",
			"gh pr create",
			"gh pr merge 1",
			"gh api -X POST repos/o/r/issues",
			"gh run rerun 1",
			"gh auth login",
			"npm config set x y",
			"kubectl apply -f x",
			"kubectl config use-context x",
			"aws sts assume-role --role-arn x",
			"aws s3 ls",
			"terragrunt apply",
			"docker run x",
			"python x.py",
			"node -e 'x'",
			"bash script.sh",
			"./deploy.sh",
			"make",
			"sudo ls",
			"ls && rm x",
			"cat $(rm x)",
			"eval ls",
			"curl https://x",
		]));

	it("treats an empty command as read-only", () => expectReadOnly(true, ["", "   "]));
});

describe("needsConfirmation", () => {
	it("gates nothing outside chat", () => {
		for (const mode of ["apply", "plan"] as const) {
			assert.equal(needsConfirmation(mode, { tool: "edit", subject: "x.ts" }), false);
			assert.equal(needsConfirmation(mode, { tool: "write", subject: "x.ts" }), false);
			assert.equal(needsConfirmation(mode, { tool: "bash", subject: "rm -rf x" }), false);
		}
	});

	it("gates edits, writes and non-read-only bash in chat", () => {
		assert.equal(needsConfirmation("chat", { tool: "edit", subject: "x.ts" }), true);
		assert.equal(needsConfirmation("chat", { tool: "write", subject: "x.ts" }), true);
		assert.equal(needsConfirmation("chat", { tool: "bash", subject: "npm test" }), true);
		assert.equal(needsConfirmation("chat", { tool: "bash", subject: "git status" }), false);
	});
});

describe("mode helpers", () => {
	it("cycles apply -> chat -> plan -> apply", () => {
		assert.equal(nextMode("apply"), "chat");
		assert.equal(nextMode("chat"), "plan");
		assert.equal(nextMode("plan"), "apply");
	});

	it("previews edits compactly", () => {
		const preview = previewEdits([{ oldText: "a\nb", newText: "c" }]);
		assert.equal(preview, "- a\n- b\n+ c");
		const many = previewEdits(Array.from({ length: 3 }, () => ({ oldText: "a", newText: "b" })));
		assert.match(many, /1 more edit/);
		const long = previewEdits(
			[{ oldText: Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"), newText: "" }],
			2,
		);
		assert.match(long, /\+8 lines/);
	});
});
