# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi).

| Extension | Purpose |
| --- | --- |
| `github-guard` | Gates GitHub-affecting `bash` commands: `gh` reads run silently, mutations ask; `git push` to feature branches runs silently, protected branches ask, force pushes are denied. |

## Install

From a local checkout (loaded in place, no copy):

```sh
pi install /Users/jules/Documents/perso/pi-extensions
```

Then `/reload` in pi. Update by pulling the checkout.

## github-guard

Hooks `tool_call` for the `bash` tool and classifies each command segment
(`&&`, `;`, `|`, `$( )`, nested `sh -c`, `sudo`/`env`/`xargs` wrappers).

| Command | Verdict |
| --- | --- |
| `gh pr/issue/run/repo/release/workflow … list/view/diff/checks/status/watch/download`, `gh search`, `gh auth status`, `gh api` (GET, no body) | allow |
| Any other `gh` command (`pr merge`, `pr create`, `run rerun`, `workflow run`, `api -X POST`, unknown) | ask |
| `git push` to a non-protected branch (explicit refspec or current branch) | allow |
| `git push` to `main`, `master`, `prod*`, `release/*`; deletions; `--all/--tags/--mirror/--prune`; wildcards; unknown current branch | ask |
| `git push --force`, `-f`, `--force-with-lease`, `+refspec` | deny |
| `eval`/`$VAR` invocations that mention `gh`/`git` | ask |

Asking opens a prompt: **Allow once**, **Allow for session (this exact command)**, **Deny**.
Without a UI (headless) anything that would ask is blocked.

Commands:

- `/github-guard` — show state
- `/github-guard off|on` — toggle for the session (`PI_GITHUB_GUARD=off` disables at startup)
- `/github-guard <command>` — dry-run the classifier

Edit `PROTECTED_BRANCHES` in `extensions/github-guard/rules.ts` to change the protected list.

## Development

```sh
npm install
npm test          # node test runner via tsx
npm run typecheck # tsgo
npm run lint      # biome
```
