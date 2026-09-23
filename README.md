# pi-extensions

Personal extensions for [pi](https://github.com/earendil-works/pi).

| Extension | Purpose |
| --- | --- |
| `command-guard` | Pins the agent to the `*-dev` (DeveloperAccess) AWS role and gates GitHub, git, AWS, terragrunt, kubectl, helm and docker commands: reads run, risky actions ask, writes to infra are denied. |

## Install

From a local checkout (loaded in place, no copy):

```sh
pi install /Users/jules/Documents/perso/pi-extensions
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
| scripts | — | `bash x.sh`, `./x.sh`, `python x.py`, `python -c`, `node -e` … whose content mentions `aws/kubectl/helm/terragrunt/terraform`, `-admin`, `AWS_*`/`KUBECONFIG`, `.aws/`, `.kube/`, `boto3`, `@aws-sdk`, `kubernetes` | — |
| indirection | — | `eval …`, `$VAR …` mentioning a guarded tool | — |

### Protected paths (`bash`, `edit`, `write`)

`~/.aws/**`, `~/.kube/**`, `~/.pi/agent/command-guard/**`, `~/.pi/agent/settings.json` and this repository are never written: pure readers (`cat`, `grep`, `rg`, `less`, `ls`, `diff`, `jq`, `yq`, `sed`/`awk` without in-place) may access them; redirections, `tee`, `cp/mv/rm/ln/chmod/touch`, `sed -i`, `yq -i`, editors, `$AWS_CONFIG_FILE`/`$KUBECONFIG` references and the `edit`/`write` tools are denied.

### Limits

The guard classifies command lines; it is not a sandbox. `make deploy`, `npm run deploy` and compiled programs are not inspected — they still inherit the `*-dev` identity, which is the real boundary. Deliberately hardcoding `AWS_CONFIG_FILE=~/.aws/config` inside a script would bypass the env layer; the script scan asks on such mentions but cannot catch every encoding.

### Commands

- `/command-guard` — state: session grants, generated config paths, profile/user counts, warnings
- `/command-guard <command>` — dry-run the classifier

Edit `PROTECTED_BRANCHES` (`rules/git.ts`) or `DEV_PROFILE` (`types.ts`) to change the protected branch list or the accepted profile suffix.

## Development

```sh
npm install
npm test          # node test runner via tsx, one file per rule
npm run typecheck # tsgo
npm run lint      # biome
```
