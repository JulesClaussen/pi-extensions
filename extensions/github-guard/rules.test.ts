import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCommand, type RuleContext, type Verdict } from "./rules.ts";

const branches: Record<string, string | null> = {
	"/repo": "feat/guard",
	"/repo-on-main": "main",
	"/repo/sub": "feat/nested",
	"/detached": null,
};

const ctx: RuleContext = {
	cwd: "/repo",
	currentBranch: async (cwd) => branches[cwd] ?? null,
};

async function verdict(command: string, context: RuleContext = ctx): Promise<Verdict> {
	return (await checkCommand(command, context)).verdict;
}

async function expectAll(expected: Verdict, commands: string[], context: RuleContext = ctx) {
	for (const command of commands) {
		assert.equal(await verdict(command, context), expected, `${command} should be ${expected}`);
	}
}

describe("gh", () => {
	it("allows read and list commands", () =>
		expectAll("allow", [
			"gh pr list",
			"gh pr view 42 --json title,body",
			"gh pr diff 42",
			"gh pr checks 42 --watch",
			"gh pr status",
			"gh pr checkout 42",
			"gh issue list --state open",
			"gh run list --limit 5",
			"gh run view 123 --log-failed",
			"gh run watch 123",
			"gh repo view owner/repo",
			"gh release list",
			"gh workflow list",
			"gh search prs --author @me",
			"gh auth status",
			"gh api repos/owner/repo/pulls --paginate --jq '.[].number'",
			"gh api -X GET repos/owner/repo",
			"gh --version",
			"gh pr merge --help",
			"gh pr list | head -5",
			"gh pr list && gh issue list",
		]));

	it("asks for mutations", () =>
		expectAll("ask", [
			"gh pr merge 42 --squash",
			"gh pr create --fill",
			"gh pr comment 42 --body hi",
			"gh pr review 42 --approve",
			"gh pr close 42",
			"gh pr edit 42 --add-label bug",
			"gh run rerun 123",
			"gh run cancel 123",
			"gh workflow run ci.yml",
			"gh issue create --title x",
			"gh release create v1.0",
			"gh repo delete owner/repo",
			"gh api -X POST repos/owner/repo/issues -f title=x",
			"gh api repos/owner/repo/issues -f title=x",
			"gh api --method DELETE repos/owner/repo/labels/x",
			"gh api graphql -f query='{ viewer { login } }'",
			"gh auth token",
			"gh secret set FOO",
			"gh unknown-thing",
			"gh pr",
		]));

	it("asks for combined lines where one segment mutates", () =>
		expectAll("ask", ["gh pr list && gh pr merge 42", "gh pr view 1; gh run rerun 2"]));

	it("looks through wrappers and nested shells", () =>
		expectAll("ask", [
			"sudo gh pr merge 42",
			"env GH_TOKEN=x gh pr merge 42",
			"timeout 30 gh run rerun 1",
			"bash -c 'gh pr merge 42'",
			'sh -lc "gh pr merge 42"',
			'eval "$CMD" gh pr merge',
			"$GH pr merge 42",
			"xargs gh pr merge",
		]));

	it("does not trip on gh inside string arguments", () =>
		expectAll("allow", ["echo 'gh pr merge 42'", "rg 'gh pr merge' docs/", "git commit -m 'run gh pr merge later'"]));
});

describe("git push", () => {
	it("allows pushes to feature branches", () =>
		expectAll("allow", [
			"git push",
			"git push origin",
			"git push -u origin feat/guard",
			"git push origin HEAD",
			"git push --set-upstream origin feat/guard",
			"git push origin feat/a:feat/b",
			"git push origin refs/heads/feat/x",
			"git push origin v1.2.3",
			"git push origin refs/tags/v1.2.3",
			"git push -o ci.skip origin feat/guard",
			"git add -A && git commit -m x && git push",
			"git --no-pager push origin feat/x",
			"git -C /repo/sub push",
			"cd /repo/sub && git push",
		]));

	it("asks for pushes to protected branches", () =>
		expectAll("ask", [
			"git push origin main",
			"git push origin master",
			"git push origin production",
			"git push origin prod",
			"git push origin release/1.2",
			"git push origin HEAD:main",
			"git push origin feat/x:main",
			"git push origin refs/heads/main",
			"git push -u origin main",
			"git push origin -- main",
		]));

	it("asks when the current branch is protected or unknown", async () => {
		await expectAll("ask", ["git push", "git push origin", "git push origin HEAD"], { ...ctx, cwd: "/repo-on-main" });
		await expectAll("ask", ["git push"], { ...ctx, cwd: "/detached" });
		await expectAll("ask", ["git -C /repo-on-main push"]);
		await expectAll("ask", ["cd /repo-on-main && git push"]);
	});

	it("asks for deletions, bulk pushes and wildcards", () =>
		expectAll("ask", [
			"git push origin :feat/old",
			"git push origin --delete feat/old",
			"git push -d origin feat/old",
			"git push --all",
			"git push --tags",
			"git push --mirror",
			"git push --prune origin",
			"git push origin 'refs/heads/*:refs/heads/*'",
			"git push --exec=/tmp/evil origin feat/x",
			"git -c alias.push=reset push",
		]));

	it("denies force pushes", () =>
		expectAll("deny", [
			"git push --force",
			"git push -f",
			"git push -fu origin feat/x",
			"git push --force-with-lease origin feat/x",
			"git push --force-with-lease=feat/x:abc origin feat/x",
			"git push --force-if-includes",
			"git push origin +feat/x",
			"git commit -m x && git push -f",
			"bash -c 'git push --force'",
		]));

	it("ignores non-push git commands", () =>
		expectAll("allow", [
			"git status",
			"git fetch --all",
			"git pull --rebase",
			"git rebase -i main",
			"git checkout main",
			"git branch -D feat/old",
			"git reset --hard origin/main",
			"git remote -v",
		]));
});
