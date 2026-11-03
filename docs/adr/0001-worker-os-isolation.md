# ADR 0001: OS-level isolation of workers

- Status: accepted. Step 1 applies now; step 2 waits for the follow-ups below.
- Date: 2026-11-03
- Related: [006 Deployment](../006-deployment.md), Permissions and isolation; [009 Security](../009-security.md), Remaining risks; item 3.3, several Executors.

## Context

Today a worker is confined by DeepSeek Harness's file sandbox, set through the `superagent-worker` permission preset. The sandbox stops writes outside the Ticket directory, the temporary areas and the writable roots. It does not stop reads, and it does not govern the network. Every Session runs as the operator's OS user.

So a worker can read everything that user can read:

| Asset | Where | Who needs it |
| --- | --- | --- |
| Model provider keys | `$DSH_HOME/.credentials.yaml` | The DeepSeek Harness process |
| Launch token | The profile's startup log | The operator, `scripts/dsh-superagent login` |
| Panel session cookie | The cookie jar `login` writes, and the browser | The operator, scripts. With it the management API has the panel's rights, so it can change the Policy and the accept mode |
| dsh-superagent's database | `<stateDir>/orchestrator.sqlite` | The host process |
| Merge account token | That account's `gh` configuration | The host process, for `orchestrator_merge_request` |
| Agent GitHub token | The agent's `gh` configuration | The host process (Sources) and workers |
| Feishu bot credentials | The bot's `lark-cli` configuration | The host process, and workers through the `lark-cli` shim |
| The operator's own files | `~`: SSH keys, personal `gh`, cloud credentials, other projects | Nobody in dsh-superagent |
| The host process's memory and environment | `/proc/<pid>/` | Nobody else |

### Threat model

- A worker reads text that anyone can write: Trigger text, quotes, linked pages and files in the repository. Assume this text can steer the worker completely.
- A steered worker runs any command its OS user can run, including programs called by their absolute path. Shims and prompts do not stop it.
- The goal: a worker reaches only what its job needs. That is its Ticket directory, the agent's GitHub credentials and the network its toolchain needs.
- Out of scope: kernel exploits, a malicious operator, and misuse of the agent's own token on GitHub. Branch protection still stops an unreviewed merge (009).

## Options

### Step 1: run the whole profile as a dedicated OS user

Create a user, for example `dsh`, and install DeepSeek Harness, the `superagent` profile, `$DSH_HOME` and the state directory under it. Sign the agent's `gh` in as that user. The operator's own account then holds nothing that the profile can read.

This changes no code. The workers, the main Session and the host process still share one user, so a worker can still read `$DSH_HOME/.credentials.yaml`, the startup log, the cookie jar, the database and the merge account's token.

### Path A: workers as a second user, through DeepSeek Harness's SSH provider

DeepSeek Harness ships an SSH provider: `@deepseek-ai/dsh-ssh` with `dsh-fs-ssh`, `dsh-subprocess-ssh` and `dsh-sandbox-ssh` (`packages/ssh` in the DeepSeek Harness source). It replaces a profile's `ctx.fs`, `ctx.subprocess` and `ctx.sandbox`. The Harness, the model transport and Session storage stay in the host process. File tools, Bash, terminals and the sandbox run in a helper on the SSH host. Point it at `127.0.0.1` and log in as a second user, for example `dsh-worker`, and every tool call runs as that user.

What we verified in the provider's source, and in the published `0.2.1-rc.3` package that matches the DeepSeek Harness version 006 installs:

- Configuration: `host` (an OpenSSH alias), `launch` (`{kind: executable}` or `{kind: node-script, node}`), `helper`, `workspace`, `helperHash` (SHA-256 of the installed helper), and optional `requestTimeoutMs`, `maxFrameBytes`, `maxPending` and `leaseMs`.
- The client starts `ssh -T -M -S <socket> -o ControlPersist=no -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no -o ClearAllForwardings=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3 <host> <helper>`. Each program stream then uses `ssh -S <socket> -O forward -L <local socket>:<remote socket>`. So the key, the `known_hosts` entry and the alias must exist before startup, and the server must allow Unix-socket forwarding.
- It applies to the whole profile. The provider's README also warns that the Web workspace UI still assumes host file paths. On `127.0.0.1` the paths are the same, so this matters less.
- No reconnect and no replay. If the connection is lost, pending operations fail and the helper cleans up its processes.
- The `dsh` CLI `0.2.1-rc.3` does not depend on these packages. They are published separately and must be installed in the profile.

Two ways to use it:

- **A1, one profile.** Mount the SSH provider in the `superagent` profile itself. All Sessions then run their tools as `dsh-worker`. The main Session's preset is read-only, so it loses nothing it needs. dsh-superagent's own code (Sources, `gh`, the database, the management API) runs in the host process with `node:fs` and `execFile`, so it stays the host user. The commands dsh-superagent runs through `ctx.subprocess` (the prepare command, `verifyDirectory`, the setup probes) run as the worker. That is what we want. This needs no Executor change.
- **A2, a worker profile.** Workers run in a second, headless profile. This needs the several-Executor work (3.3), plus a way for dsh-superagent to create, prompt and stop Sessions in another DeepSeek Harness process. Nothing provides that today.

### Path B: a container Executor

One container per Ticket. It mounts only the Ticket directory and the agent's credentials, and it has its own network policy. DeepSeek Harness has no container provider. Its sandbox README says that "a container or remote executor replaces whole capabilities". So this needs an Executor that runs a DeepSeek Harness runtime, or at least its tools, inside each container, and carries Session events, deliveries and stops across. It also needs an image with the repository's toolchain. One shortcut: a container that runs `sshd` and the SSH helper is just another SSH host, so a later container Executor could reuse path A's provider.

## What each option blocks

"Read" means a worker can read it. Writes stay limited by the file sandbox in every column.

| A worker reading … | Today | Step 1 | Step 1 + A | B |
| --- | --- | --- | --- | --- |
| The operator's home and personal credentials | Read | Blocked | Blocked | Blocked |
| `$DSH_HOME/.credentials.yaml` | Read | Read | Blocked | Blocked |
| The startup log and the cookie jar (so the management API) | Read | Read | Blocked | Blocked |
| `orchestrator.sqlite` | Read | Read | Blocked | Blocked |
| The merge account's token | Read | Read | Blocked | Blocked |
| The host process's environment in `/proc` | Read | Read | Blocked | Blocked |
| Other Tickets' directories | Read | Read | Read, since one worker user shares them | Blocked |
| The agent's GitHub token | Read, by design | Read | Read, from the worker's own copy | Read, mounted |
| The network | Open | Open | Open. A firewall rule on the worker's uid can limit it (PoC) | Each container's own network policy |
| The management API without the cookie | 401 | 401 | 401 | Unreachable unless the network allows it |

## Costs

| | Step 1 | Path A (A1) | Path B |
| --- | --- | --- | --- |
| Code | None | None to start. Follow-ups below | A new Executor, image handling, event bridge |
| Setup | One user, a service unit | `sshd` on 127.0.0.1, a key, `known_hosts`, the helper and its hash, four packages in the profile, ACLs on the state and work directories, the agent's `gh` signed in for the worker user | A container runtime, an image with the repository's toolchain, credential mounts |
| Runtime cost | None | One SSH master per profile; streams stay local | A container start per Ticket |
| Failure modes | None new | SSH or helper loss fails running work with no replay | Image drift, runtime outages |
| Isolation between Tickets | No | No | Yes |

## PoC

`scripts/isolation-poc.sh` builds the layout this ADR proposes on a disposable Linux host, as root. It then checks every claim in the step 1 and path A columns. It creates three users: `dshpoc-op` stands in for the operator, `dshpoc-host` runs the profile (step 1), and `dshpoc-worker` runs the workers (step 2). The layout it uses:

- `$DSH_HOME` stays in the host user's home, mode 700. The stand-in startup log is deliberately world-readable, so the home's mode alone must stop it.
- The state directory is `/srv/dshpoc/state`, owned by the host user, mode 700. An ACL gives the worker `--x` on it, so the worker can reach `worker-bin` and `worker-gitconfig` by name, but cannot list the directory or open the database. The database is mode 600, as `src/app/store.ts` sets it.
- The Ticket root is `/srv/dshpoc/work`. Its default ACLs give both users `rwx` on everything created below, whatever either process's umask is.
- The agent's `gh` wrapper is in a shared path, and each user has its own signed-in `gh-agent` configuration in its home.

The SSH leg runs `sshd` on 127.0.0.1:2222. It admits only the worker user, by key, with `restrict,port-forwarding` in `authorized_keys` and `AllowStreamLocalForwarding local`. It opens the master connection with exactly the provider's options and forwards a Unix socket served by a stand-in helper running as the worker. Then it repeats every check through that master.

It ran in this repository's development container (Ubuntu 24.04, git 2.43, OpenSSH 9.6) and exited 0:

```text
== setup: users and layout
PASS  users dshpoc-op, dshpoc-host, dshpoc-worker and /srv/dshpoc ready
      user::rwx user:dshpoc-worker:--x group::--- mask::--x other::---

== check: process separation
PASS  control: the host user reads its own process environment
      SECRET_IN_ENV=cookie-value
PASS  cannot read the environment of a host-user process (/proc/12705/environ)
      cat: /proc/12705/environ: Permission denied

== check: what dshpoc-worker cannot read (local)
PASS  cannot read /home/dshpoc-host/.dsh/.credentials.yaml
      cat: /home/dshpoc-host/.dsh/.credentials.yaml: Permission denied
PASS  cannot read /home/dshpoc-host/.dsh/logs/startup.log
      cat: /home/dshpoc-host/.dsh/logs/startup.log: Permission denied
PASS  cannot read /home/dshpoc-host/dsh-superagent/.artifacts/control/profiles/superagent/cookies.txt
      cat: /home/dshpoc-host/dsh-superagent/.artifacts/control/profiles/superagent/cookies.txt: Permission denied
PASS  cannot read /srv/dshpoc/state/orchestrator.sqlite
      cat: /srv/dshpoc/state/orchestrator.sqlite: Permission denied
PASS  cannot read /home/dshpoc-host/.config-gh-merge
      cat: /home/dshpoc-host/.config-gh-merge: Permission denied
PASS  cannot read /home/dshpoc-host/.config/gh-agent/hosts.yml
      cat: /home/dshpoc-host/.config/gh-agent/hosts.yml: Permission denied
PASS  cannot read /home/dshpoc-op/.config/gh/hosts.yml
      cat: /home/dshpoc-op/.config/gh/hosts.yml: Permission denied
PASS  cannot read /home/dshpoc-op/.ssh/id_ed25519
      cat: /home/dshpoc-op/.ssh/id_ed25519: Permission denied
PASS  cannot list the operator's home /home/dshpoc-op
      ls: cannot open directory '/home/dshpoc-op': Permission denied
PASS  cannot list the host user's home /home/dshpoc-host
      ls: cannot open directory '/home/dshpoc-host': Permission denied
PASS  cannot list stateDir /srv/dshpoc/state
      ls: cannot open directory '/srv/dshpoc/state': Permission denied
PASS  cannot replace a shim in /srv/dshpoc/state/worker-bin
      sh: 1: cannot create /srv/dshpoc/state/worker-bin/gh: Permission denied
PASS  cannot rewrite /srv/dshpoc/state/worker-gitconfig
      sh: 1: cannot create /srv/dshpoc/state/worker-gitconfig: Permission denied

== check: what dshpoc-worker can do (local)
PASS  runs as dshpoc-worker
      uid=30035(dshpoc-worker) gid=30035(dshpoc-worker) groups=30035(dshpoc-worker)
PASS  reads the gh shim and the agent's own credentials
      gh-agent as dshpoc-worker, config /home/dshpoc-worker/.config/gh-agent, token ghp_AGENT_TOKEN_for_dshpoc-worker
PASS  reads worker-gitconfig
      !'/srv/dshpoc/bin/gh-agent' auth git-credential
PASS  finding: git refuses the host user's repository by default
      fatal: detected dubious ownership in repository at '/srv/dshpoc/origin.git'
PASS  finding: a worktree of the host user's clone fails, since its git data is not the worker's to write
      fatal: cannot lock ref 'refs/heads/local-worktree': Unable to create '/srv/dshpoc/origin.git/./refs/heads/local-worktree.lock': Permission denied
PASS  clones into its Ticket directory (--no-local, safe.directory for upload-pack)
PASS  writes and commits there
      21004e2 worker change
PASS  the host user can read and delete what the worker wrote
      removed

== check: step 1 alone (workers still run as the host user)
PASS  the host user reads its own credentials, so its workers could too
      deepseek:   apiKey: sk-MODEL_PROVIDER_KEY
PASS  the host user cannot read the operator's home
      ls: cannot open directory '/home/dshpoc-op': Permission denied
PASS  the host user cannot read the operator's personal gh token
      cat: /home/dshpoc-op/.config/gh/hosts.yml: Permission denied

== ssh: the DeepSeek Harness SSH provider's connection to dshpoc-worker@127.0.0.1
PASS  master connection up, opened as the provider opens it; remote helper socket /home/dshpoc-worker/.dsh-helper/s0
PASS  ssh -O forward -L <local socket>:<remote socket> through the master
PASS  the forwarded stream reaches the worker-side socket
PASS  the remote environment comes from sshd SetEnv, not from the host process
      GIT_CONFIG_GLOBAL=/srv/dshpoc/state/worker-gitconfig PATH=/home/dshpoc-worker/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/srv/dshpoc/state/worker-bin:/u

== check: what dshpoc-worker cannot read (ssh)
PASS  cannot read /home/dshpoc-host/.dsh/.credentials.yaml
      cat: /home/dshpoc-host/.dsh/.credentials.yaml: Permission denied
PASS  cannot read /home/dshpoc-host/.dsh/logs/startup.log
      cat: /home/dshpoc-host/.dsh/logs/startup.log: Permission denied
PASS  cannot read /home/dshpoc-host/dsh-superagent/.artifacts/control/profiles/superagent/cookies.txt
      cat: /home/dshpoc-host/dsh-superagent/.artifacts/control/profiles/superagent/cookies.txt: Permission denied
PASS  cannot read /srv/dshpoc/state/orchestrator.sqlite
      cat: /srv/dshpoc/state/orchestrator.sqlite: Permission denied
PASS  cannot read /home/dshpoc-host/.config-gh-merge
      cat: /home/dshpoc-host/.config-gh-merge: Permission denied
PASS  cannot read /home/dshpoc-host/.config/gh-agent/hosts.yml
      cat: /home/dshpoc-host/.config/gh-agent/hosts.yml: Permission denied
PASS  cannot read /home/dshpoc-op/.config/gh/hosts.yml
      cat: /home/dshpoc-op/.config/gh/hosts.yml: Permission denied
PASS  cannot read /home/dshpoc-op/.ssh/id_ed25519
      cat: /home/dshpoc-op/.ssh/id_ed25519: Permission denied
PASS  cannot list the operator's home /home/dshpoc-op
      ls: cannot open directory '/home/dshpoc-op': Permission denied
PASS  cannot list the host user's home /home/dshpoc-host
      ls: cannot open directory '/home/dshpoc-host': Permission denied
PASS  cannot list stateDir /srv/dshpoc/state
      ls: cannot open directory '/srv/dshpoc/state': Permission denied
PASS  cannot replace a shim in /srv/dshpoc/state/worker-bin
      sh: 1: cannot create /srv/dshpoc/state/worker-bin/gh: Permission denied
PASS  cannot rewrite /srv/dshpoc/state/worker-gitconfig
      sh: 1: cannot create /srv/dshpoc/state/worker-gitconfig: Permission denied

== check: what dshpoc-worker can do (ssh)
PASS  runs as dshpoc-worker
      uid=30035(dshpoc-worker) gid=30035(dshpoc-worker) groups=30035(dshpoc-worker)
PASS  reads the gh shim and the agent's own credentials
      gh-agent as dshpoc-worker, config /home/dshpoc-worker/.config/gh-agent, token ghp_AGENT_TOKEN_for_dshpoc-worker
PASS  reads worker-gitconfig
      !'/srv/dshpoc/bin/gh-agent' auth git-credential
PASS  finding: git refuses the host user's repository by default
      fatal: detected dubious ownership in repository at '/srv/dshpoc/origin.git'
PASS  finding: a worktree of the host user's clone fails, since its git data is not the worker's to write
      fatal: cannot lock ref 'refs/heads/ssh-worktree': Unable to create '/srv/dshpoc/origin.git/./refs/heads/ssh-worktree.lock': Permission denied
PASS  clones into its Ticket directory (--no-local, safe.directory for upload-pack)
PASS  writes and commits there
      22c731f worker change
PASS  the host user can read and delete what the worker wrote
      removed

== network: user separation alone does not limit it
PASS  dshpoc-worker reaches http://archive.ubuntu.com/ubuntu/
      200
PASS  with an iptables owner rule, dshpoc-worker cannot reach http://archive.ubuntu.com/ubuntu/
      curl: (6) Could not resolve host: archive.ubuntu.com
PASS  while dshpoc-host still can
      200

== cleanup
PASS  removed the users and /srv/dshpoc

All checks passed.
```

### Proven and assumed

Proven by the run above:

- Step 1 keeps the operator's home and personal tokens out of reach, but the profile user, and so its workers, still reads `$DSH_HOME/.credentials.yaml`.
- With a second user, the worker cannot read the credentials, the startup log, the cookie jar, the database, the merge token, the host user's copy of the agent token, the operator's files, or the host process's environment. It cannot replace the shims or `worker-gitconfig`. It can run the shims, use its own agent token, clone into its Ticket directory, commit there, and the host user can read and remove what it wrote.
- The OpenSSH side of the provider works as a different local user: the multiplexed master with the provider's options, `-O forward` of a Unix socket, and commands over the master.
- The host process's environment does not cross SSH. dsh-superagent puts the shims first on `PATH` and sets `GIT_CONFIG_GLOBAL` in its own `process.env` (`applyEnvironment`). DeepSeek Harness's Bash passes only explicit overrides, and the remote helper uses its own environment. So these variables must come from the SSH server, for example `SetEnv` under `Match User`, which the PoC shows working.
- git refuses a repository owned by another user ("dubious ownership"), and `worker-gitconfig` names no `safe.directory`. A worktree of the host user's clone fails, because its git data is not the worker's to write. A per-Ticket clone made with `git clone --no-local -u 'git -c safe.directory=<clone> upload-pack' <clone> <dir>` works. A plain local clone ignores `-c safe.directory`.
- A firewall rule on the worker's uid (`iptables -m owner --uid-owner`) cuts the worker's network and leaves the host user's alone.

Assumed, not run:

- The real DeepSeek Harness SSH provider and helper. We did not install the helper (an archive built with Node 24, or the helper script with its dependencies) or run a profile with the four packages. This container has no model provider either. The stand-in helper only proves the OpenSSH contract.
- The remote sandbox (`sandbox-local` on the SSH host: bwrap or Landlock) applying the worker preset under the worker user.
- The Web panel and the Web workspace UI in a profile whose `ctx.fs` is the SSH provider.
- How `DshExecutor` handles losing the SSH connection while workers run.
- The container option. It was not built.

## Fit with several Executors (3.3)

Item 3.3 adds a registry of Executors by name and an `executor` field on each Assignment. Each Executor keeps today's interface in `src/core/ports.ts`: `start`, `deliver` and `stop`.

- A1 needs no registry: the existing `DshExecutor` keeps working, and the profile decides where tools run.
- A2 would be a second Executor whose Sessions live in another profile. It needs a cross-process Session API first.
- B would be a `container` Executor in the registry. A Policy rule or the Mandate could then pick it for riskier work, such as proactive Tickets or Tickets from people outside the team, while the rest stay on `DshExecutor`.

This PoC adds no Executor and changes no core file. Wiring a second Executor stays with 3.3.

## Decision

1. Step 1 now: run the whole `superagent` profile as a dedicated OS user. 006 describes the setup.
2. Step 2: path A1. Put the workers' tools under a second user by mounting the SSH provider in the `superagent` profile and pointing it at 127.0.0.1, once the follow-ups below are done and a run with the real provider passes the same checks as this PoC.
3. Defer path B. Reconsider it when we need isolation between Tickets or a network policy per Ticket, or after A2 exists.

## Follow-ups

1. **Real provider run.** Install `@deepseek-ai/dsh-ssh`, `dsh-fs-ssh`, `dsh-subprocess-ssh` and `dsh-sandbox-ssh` at the DeepSeek Harness version in use, plus a helper, in a test profile. Then run the e2e suite and this PoC's checks with a real worker. Confirm the panel and the Web UI still work, and that the remote sandbox enforces the worker preset.
2. **Worker environment.** Generate the `SetEnv` block (`PATH` with `worker-bin` first, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `GIT_TERMINAL_PROMPT=0`) from dsh-superagent, or have it pass these variables explicitly. Today's `verifyEnvironment` already fails when `GIT_CONFIG_GLOBAL` is missing, but its message (`gitTooOld`) would mislead. The remote login profile can also put entries before `worker-bin` on `PATH`, as the PoC shows.
3. **git ownership.** Either add `safe.directory` for the source clone to `worker-gitconfig`, or document the `--no-local -u …` clone in the prepare command. Tell operators to use a per-Ticket clone, not a worktree, under step 2.
4. **Setup check.** Warn when workers run as the host user. Compare the uid the worker probe reports with the host's, and check that the worker cannot read `$DSH_HOME/.credentials.yaml`. This is a change to `src/app/setup.ts`, not core.
5. **Network.** Write an egress rule set for the worker uid that allows only GitHub (and Feishu, the package registries and the proxy, when used).
6. **Credentials per user.** Document which credentials each user holds: the agent's `gh` and the bot's `lark-cli` for both users, the merge account and the model keys only for the host user.
7. **Isolation between Tickets.** Under A all Tickets share one worker user, so they can read each other. Path B, or one user per concurrent slot, would fix this. Decide whether it matters before B.
