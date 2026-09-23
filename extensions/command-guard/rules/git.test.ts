import { describe, it } from "node:test";
import { ctx, expectAll } from "./test-helpers.ts";

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
		await expectAll("ask", ["git -C /repo-on-main push", "cd /repo-on-main && git push"]);
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
});

describe("git local", () => {
	it("allows ordinary operations", () =>
		expectAll("allow", [
			"git status",
			"git fetch --all",
			"git pull --rebase",
			"git rebase -i main",
			"git checkout main",
			"git checkout -b feat/x",
			"git switch main",
			"git branch -d feat/old",
			"git reset HEAD~1",
			"git reset --soft HEAD~1",
			"git clean -n",
			"git clean -nd",
			"git restore --staged file.ts",
			"git stash",
			"git stash pop",
			"git stash list",
			"git remote -v",
		]));

	it("asks for destructive operations", () =>
		expectAll("ask", [
			"git reset --hard origin/main",
			"git clean -fdx",
			"git clean -f",
			"git clean --force -d",
			"git checkout -- src/file.ts",
			"git checkout main -- src/file.ts",
			"git checkout -f main",
			"git restore src/file.ts",
			"git restore --staged --worktree src/file.ts",
			"git branch -D feat/old",
			"git branch --delete --force feat/old",
			"git stash drop",
			"git stash clear",
		]));
});
