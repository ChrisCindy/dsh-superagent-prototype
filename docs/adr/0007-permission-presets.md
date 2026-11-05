# ADR 0007: Confine Sessions with DeepSeek Harness permission presets

- Status: accepted
- Date: 2026-11-03 (plan item 1.3)
- Related: [006 Deployment](../006-deployment.md), Permissions and isolation; [007 Architecture](../007-architecture.md), Permission presets and the file sandbox; [009 Security](../009-security.md); [ADR 0001](0001-worker-os-isolation.md).

## Context

Every Session read text that anyone can write, and both roles ran with DeepSeek Harness's `danger-full-access`. A steered worker could rewrite the database, the command shims, the agent's git configuration, the profile or another Ticket's checkout. The main Session, which only routes, could write files too.

dsh-superagent runs unattended. A permission prompt that waits for a person would stall the work, so "ask before writing outside the workspace" is not an option.

## Decision

The bundle adds two presets to DeepSeek Harness's preset table, and `Sessions` gives each managed Session its role's preset before its first turn and on every `ensure`:

| Preset | Session | Writes | Approval |
| --- | --- | --- | --- |
| `superagent-router` | Main Session | Nothing | `never` |
| `superagent-worker` | Executor Sessions and their subagents | Its Ticket directory, the temporary areas, the writable roots | `never` |

- DeepSeek Harness's file sandbox enforces the presets on shell and file tools. With approval `never`, a denied write fails at once; nothing waits for a person.
- The bundle's `permission` row restates DeepSeek Harness's own presets beside these two, because a patch replaces the row whole. Setup stops when the composed profile lacks a preset the current setting uses.
- **Writable roots** in the Execution settings name what a toolchain needs outside the Ticket directory. Setup refuses a root the sandbox does not grant, and any root that contains or lies inside the state directory, `$DSH_HOME` or the profile. It also refuses those directories inside a temporary area, which every worker may write.
- **Sandbox: full** switches both roles to `danger-full-access`, as a way out when a toolchain cannot run in the sandbox. Only the panel can change the sandbox or the writable roots, and a change restarts dsh-superagent so every Session takes its preset.
- The prepare command runs unconfined: it is the operator's own command, set only in the panel, and it must write the main clone to create a checkout.

## Consequences

- Workers cannot change the host's state, the shims or the profile, and the main Session writes nothing. 009 lists the paths this closes.
- The sandbox confines writes only. Workers still read everything their OS user can read and reach the network; ADR 0001 deals with that.
- A git worktree keeps its data in the main clone, outside the Ticket directory, so Tickets need a checkout whose git data is inside it, such as `git clone --shared`, or the main clone's `.git` as a writable root.
- DeepSeek Harness 0.2.1 cannot grant extra writable roots, so on it no writable root can be listed.
- Two presets show in DeepSeek Harness's preset list that people should not choose for their own Sessions.

## Alternatives considered

- **Stay on `danger-full-access`.** Rejected: one steered worker could change the host's state and every other Ticket's work.
- **`workspace-write` with approval on request.** Rejected: unattended Sessions would wait for approvals no one answers.
- **The built-in `read-only` and `workspace-write` presets.** Rejected: dsh-superagent needs approval `never`, and its own names keep the roles apart from a person's Sessions.
- **OS-level isolation instead.** Needed for reads and the network, and planned in ADR 0001. It complements the presets; it does not replace them, since a second OS user still shares its Tickets' files.
