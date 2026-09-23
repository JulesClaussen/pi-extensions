import { describe, it } from "node:test";
import { expectAll } from "./test-helpers.ts";

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
			"gh pr list && gh pr merge 42",
			"gh pr view 1; gh run rerun 2",
		]));

	it("looks through wrappers, nested shells and indirection", () =>
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
