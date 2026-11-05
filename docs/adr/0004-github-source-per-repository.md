# ADR 0004: One GitHub Source instance per repository, sharing one agent account

- Status: accepted
- Date: 2026-11-03 (plan item 3.2)
- Related: [001 Domain model](../001-domain.md), Source; [006 Deployment](../006-deployment.md), Settings; [008 Cookbook](../008-cookbook.md), Add a Source; [ADR 0002](0002-agent-account-not-github-app.md).

## Context

dsh-superagent first served one repository: one GitHub Source with one `repository` setting. Teams work across several repositories, such as code and docs, and want one agent, one panel and one Policy for all of them.

The pieces that depend on the repository are many: the notification cursor, the Thread keys (`github:<number>`), the repository a worker's `gh` may call, the execution variables, the merge checks, the schedule entries' searches and the panel's Source status. An Issue number means nothing without its repository.

## Decision

A Source kind may allow several instances (`multiple: true`). The GitHub kind does: one instance per repository.

- The kind's first instance keeps the kind's ID, `github`, so its Thread keys, Trigger IDs and records keep the names they always had. Another instance has the ID `github-<name>`, such as `github-docs`, which never changes. Its Thread keys, Trigger IDs and health names start with that ID, and its KV records live under `source:<id>:`.
- All instances share the agent account. A new instance copies the `shared` keys of the first, here the agent CLI (`cli`); setup refuses instances signed in to different accounts.
- Each instance polls its own repository's notifications (`repos/<repository>/notifications`) with its own cursor, and drops anything from another repository.
- `Commands` is scoped to the instance's repository, so a call for one instance cannot reach another repository.
- A Ticket keeps the instance it came from (`home`). Its variables, resources, pull requests and merge checks use that repository. A schedule hit on `github-docs:3` gets the `github-docs` repository.
- Each instance has its own part of the Policy, its own admission table and its own Executor setting.
- An added instance starts switched off. It cannot be removed while an open Ticket uses it; the first instance cannot be removed.

## Consequences

- One agent and one Policy serve several repositories, with no change to the core: a Source instance is still a Source.
- One account means one sign-in and one set of rate limits for all instances. A busy repository uses the limits the others need.
- The agent account needs write access to every repository, and branch protection must hold in each (ADR 0006).
- Each instance polls separately, so the cost grows with the number of repositories.
- Correlation and Subscriptions work across instances, because Thread keys are unique.
- Migration names each stored Source's kind, so older single-repository data keeps working.

## Alternatives considered

- **One GitHub Source watching a list of repositories.** Fewer polls of notifications, but every key, cursor, health entry and Policy part would need a repository inside one Source, which is what an instance already is.
- **One dsh-superagent profile per repository.** No code change, but several panels, several main Sessions that cannot see each other's Tickets, and several copies of the Policy to keep in sync.
- **One agent account per repository.** Stronger separation, but more accounts to create, sign in and protect, and people would have to know which account to mention.
