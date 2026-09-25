# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi).

| Extension | Purpose |
| --- | --- |
| `command-guard` | Pins the agent to the `*-dev` (DeveloperAccess) AWS role and gates GitHub, git, AWS, terragrunt, kubectl, helm and docker commands: reads run, risky actions ask, writes to infra are denied. |
| `modes` | `apply` / `chat` / `plan` working modes: chat asks before every edit, write and non-read-only shell command; plan hands over to Plannotator. |
| `subagent` | `subagent` tool: fans self-contained tasks out to parallel worker processes that inherit the parent's extensions and guards. |

## Install

From a local checkout (loaded in place, no copy):

```sh
pi install /path/to/pi-extensions
```

Then `/reload` in pi. Update by pulling the checkout.

## command-guard

### Identity layer (the actual permission boundary)

At load the extension rewrites the environment that every `bash` child process inherits:

| Variable | Value |
| --- | --- |
| `AWS_CONFIG_FILE` | `~/.pi/agent/command-guard/aws-config` — copy of `~/.aws/config` with only `[sso-session]` blocks and `*-dev` / `*-dev-euw3` profiles |
| `AWS_SHARED_CREDENTIALS_FILE` | non-existent file (no static keys can be picked up) |
| `KUBECONFIG` | `~/.pi/agent/command-guard/kubeconfig` — copy of `~/.kube/config` with `AWS_PROFILE=*-admin` in every exec block rewritten to `*-dev` |
| `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, … | dropped if inherited and not a `*-dev` profile |

Everything that uses the standard AWS credential chain — CLI, boto3, all SDKs, the terraform AWS provider under terragrunt, `aws eks get-token` for kubectl/helm — can therefore only resolve DeveloperAccess. IAM and cluster RBAC do the enforcement; the command rules below are the fast, explicit fail. Contexts whose account has no `*-dev` profile are unusable by the agent (fail closed).

### Command rules (`bash`)

Every command position is classified (`&&`, `;`, `|`, `$( )`, `bash -c`, `sudo`/`env`/`xargs`/`timeout` wrappers are looked through; `cd`, `asp` and `export AWS_PROFILE=` are tracked across segments). Verdicts: **allow** runs silently · **ask** prompts (Allow once / Allow for session / Deny; blocked when headless) · **deny** is blocked and the model is told to ask you.

| Tool | allow | ask | deny |
| --- | --- | --- | --- |
| `gh` | `pr/issue/run/repo/release/workflow … list/view/diff/checks/status/watch/download/checkout`, `search`, `auth status`, `api` GET without body | everything else (`pr merge/create/comment`, `run rerun`, `workflow run`, `api -X POST`, unknown) | — |
| `git` | pushes to non-protected branches; ordinary local ops | push to `main`/`master`/`prod*`/`release/*`, deletions, `--all/--tags/--mirror`, wildcards; `reset --hard`, `clean -f`, `checkout -- path`, `restore` (worktree), `branch -D`, `stash drop/clear` | force pushes (`-f`, `--force*`, `+ref`) |
| `aws` | `describe-*/get-*/list-*/…`, `s3 ls`, `s3 cp/sync` from S3, `logs tail`, `sts get-caller-identity` — with a `*-dev` profile | `secretsmanager get-secret-value`, `ssm … --with-decryption`, `kms decrypt`, `ecr get-login-password`, unknown operations | any mutation (`create/delete/put/update/start/stop/terminate/invoke/…`, `s3` writes), non-`*-dev` profile, no profile, `AWS_*` credential/config overrides, `configure`, `sso get-role-credentials`, `sts assume-role`, `eks update-kubeconfig` |
| `terragrunt` | `plan`, `init`, `validate`, `output`, `show`, `providers`, `state list/show/pull`, `workspace list/show`, `graph`, `hcl fmt/validate`, `render-json`, `info`, also via `run-all` / `run --all` | — | everything else (`apply`, `destroy`, `import`, `state mv/rm`, `taint`, `force-unlock`, `refresh`, `exec`, `stack`, unknown), non-`*-dev` profile |
| `terraform` / `tofu` | — | — | always — the message tells the model to use `terragrunt` |
| `kubectl` | `get/describe/logs/top/explain/events/diff/wait/port-forward`, `auth can-i/whoami`, `rollout status/history`, `config get-contexts/current-context/use-context/view`, `--dry-run=client\|server`, `kubectx`/`kubens` | `get/describe secret*`, `get --raw`, `config view --raw`, unknown verbs (plugins) | all writes (`apply/create/delete/edit/patch/scale/exec/cp/debug/run/drain/rollout restart…`), `--kubeconfig`, `KUBECONFIG=`, `--as`, `--token/--server` |
| `helm` | `list/status/history/search/show/template/lint/pull/package/create`, `repo list/add/update`, `dependency *`, `plugin list` | `helm get *`, unknown commands | `install/upgrade/uninstall/rollback/test/push`, `registry login`, `repo remove`, `plugin install`, `--post-renderer`, `--kubeconfig`, identity overrides |
| `docker` | build/run/ps/logs/inspect/pull/start/stop, `compose up/down/build/logs`, `system df` | `rm/rmi/prune`, `volume/network rm`, `compose down -v/--rmi`, `--remove-orphans`, `exec`, `compose exec/run`, `--privileged`, `--pid/--cap-add/--device`, docker-socket or `/` mounts, `push/login/logout`, swarm/service/context, mutations via `--context/-H/DOCKER_HOST` | — |
| scripts | — | `bash x.sh`, `./x.sh`, `python x.py`, `python -c`, `node -e` … whose content references a credential override (`AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_ACCESS_KEY_ID`, …), `KUBECONFIG`, `.aws/`, `.kube/` or `sso/cache` — the reason names the token and line | — |
| indirection | — | `eval …`, `$VAR …` mentioning a guarded tool | — |

### Protected paths (`bash`, `edit`, `write`)

`~/.aws/**`, `~/.kube/**`, `~/.pi/agent/command-guard/**`, `~/.pi/agent/settings.json` and this repository are never written: pure readers (`cat`, `grep`, `rg`, `less`, `ls`, `diff`, `jq`, `yq`, `sed`/`awk` without in-place) may access them; redirections, `tee`, `cp/mv/rm/ln/chmod/touch`, `sed -i`, `yq -i`, editors, `$AWS_CONFIG_FILE`/`$KUBECONFIG` references and the `edit`/`write` tools are denied.

### Limits

The guard classifies command lines; it is not a sandbox. `make deploy`, `npm run deploy` and compiled programs are not inspected — they still inherit the `*-dev` identity, which is the real boundary. Deliberately hardcoding `AWS_CONFIG_FILE=~/.aws/config` inside a script would bypass the env layer; the script scan asks on such mentions but cannot catch every encoding. Scripts that merely call `aws`/`kubectl`/`terragrunt` or import `boto3` are not flagged: they inherit the `*-dev` identity like everything else.

### Commands

- `/command-guard` — state: session grants, generated config paths, profile/user counts, warnings
- `/command-guard <command>` — dry-run the classifier

Edit `PROTECTED_BRANCHES` (`rules/git.ts`) or `DEV_PROFILE` (`types.ts`) to change the protected branch list or the accepted profile suffix.

## modes

Switch with `/mode [apply|chat|plan]`, `/mode` alone or `Ctrl+Alt+M` (cycles apply → chat → plan). Sessions start in `apply`; the mode is persisted per session and shown in the footer. command-guard keeps running in every mode — `modes` only adds prompts, it never loosens a guard verdict.

| Mode | `edit` / `write` | `bash` | MCP and other tools |
| --- | --- | --- | --- |
| `apply` | run | run | run |
| `chat` | ask (Allow once / Allow for session / Deny), with a diff preview | ask unless every command position is read-only (`ls`, `cat`, `rg`, `git status/log/diff`, `gh pr view`, `kubectl get`, … — no redirections, no `sed -i`, no unknown commands) | run |
| `plan` | Plannotator planning mode | Plannotator planning mode | run |

In `chat` the model is also told that the user wants to discuss rather than act. Entering `plan` calls Plannotator's plan mode; approving the plan switches to `apply`, leaving Plannotator without approval falls back to `chat`. If Plannotator is not installed, `plan` degrades to `chat` with a warning. Without a UI (headless runs) anything that would ask is blocked.

## subagent

Registers a `subagent` tool that runs up to 12 tasks per call (6 at a time by default, `concurrency` to change) in parallel worker processes. Ask naturally, e.g. "open a PR bumping X in these 10 repos, one worker per repo".

| Parameter | Default |
| --- | --- |
| `tasks[].task` | — self-contained instructions; the worker cannot see the conversation |
| `tasks[].cwd` | current cwd (absolute, `~/…` or relative) |
| `tasks[].model` | `anthropic/claude-opus-5-5` |
| `tasks[].thinking` | `medium` |
| `concurrency` | `6` |

Each worker is a separate `pi --mode json -p --no-session` process started in its `cwd`, so it loads the same settings, packages and extensions as the parent (command-guard, MCP, web tools…) and the repository's `AGENTS.md`. It has an isolated context window and a worker system prompt that asks for a fixed report (status, changes, branch/commits, PR title and body, notes).

- **Guards:** workers have no UI, so every command-guard or modes verdict that would ask is blocked. Workers can commit and push feature branches, but `gh pr create` and other asks fail: the parent opens PRs from the reports, with your approval.
- **No recursion:** workers run with `PI_SUBAGENT_DEPTH=1` and do not register the tool.
- **Usage:** progress streams per worker (last tool calls, tokens, cost); the tool result carries the summed usage so session totals include workers. Ctrl+C kills every worker.

Change the defaults in `extensions/subagent/rules.ts` (`DEFAULT_MODEL`, `DEFAULT_THINKING`, `MAX_TASKS`, `DEFAULT_CONCURRENCY`, `WORKER_PROMPT`).

## Development

```sh
npm install
npm test          # node test runner via tsx, one file per rule
npm run typecheck # tsgo
npm run lint      # biome
```
