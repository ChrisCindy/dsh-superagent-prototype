# ADR 0002: An agent account and the GitHub CLI, not a GitHub App

- Status: accepted
- Date: 2026-10-31, recorded 2026-11-05
- Related: [006 Deployment](../006-deployment.md), Agent GitHub account and Merge account; [003 Execution](../003-execution.md), Merging; [ADR 0006](0006-host-checked-merges.md).

## Context

The agent works on GitHub as a team member: people mention it, it comments, pushes branches and opens pull requests. Something must hold its identity and credentials, and something must tell it about new work.

GitHub offers two kinds of identity for this: a user account, and a GitHub App with its own bot user. The two differ in how work reaches them and how they sign in:

- A user account has notifications. A mention, a review request or an assignment lands there, so one poll of `notifications` finds every request in the repository.
- An App has no notifications. It learns about events through webhooks, which need a public callback, or it must poll every Issue and pull request it cares about.
- An App signs in with a private key and short-lived installation tokens, so a long-running process must renew them. A user account signs in once with `gh auth login`.
- People mention a user account the same way they mention a colleague, and the mention reaches its notifications. An App sees a mention only if it reads the comment itself, from a webhook or a poll.

The workers also need the same tools a person uses: `git` with credentials and `gh` for pull requests, reviews and CI.

## Decision

The agent is a GitHub user account of its own. dsh-superagent reaches it through a GitHub CLI wrapper, such as `gh-agent`, that sets its own `GH_CONFIG_DIR` and is signed in only as that account.

- The host reads GitHub as that account: notifications, threads, CI and pull requests, all through `Commands`, limited to the configured repository.
- Workers get a `gh` shim and a git credential helper that run the same wrapper, so their pushes and comments come from the agent account.
- Merging uses a second account and its own wrapper (`merge.cli`), because GitHub credits a merge to whoever enabled auto-merge. ADR 0006 explains why.
- Setup probes each wrapper the way a worker shell runs it, reads the login, and refuses a merge CLI signed in as the agent.

## Consequences

- No public endpoint, no webhook secret and no token renewal. dsh-superagent runs on a laptop or a server behind a firewall.
- Requests arrive with the delay of one poll, not at once. [ADR 0008](0008-github-webhook-mode.md) looks at webhooks as a supplement.
- The account needs write access to each repository and, depending on the plan, a seat. GitHub's terms allow machine accounts; the person who creates it is responsible for it.
- The token is a user's token. Anything that runs as the agent's OS user can read it (ADR 0001), so branch protection must not let the agent account bypass reviews.
- Rate limits are the user's limits, shared by every GitHub Source that uses the account.
- The agent's actions show as an ordinary user in GitHub's interface, which is what people expect of a team member.

## Alternatives considered

- **A GitHub App.** Finer permissions per repository and a clear bot label. Rejected: no notifications, so either webhooks with a public callback or polling every Issue; token renewal in a long-running host; and a mention of it reaches no notifications.
- **The operator's own account.** Simplest to set up. Rejected: the agent's actions would look like the operator's, its token would reach everything the operator can reach, and the operator could not review the agent's pull requests.
- **A REST client in the host instead of `gh`.** Rejected: workers need `gh` anyway, and one wrapper for host and workers means one sign-in to check.
