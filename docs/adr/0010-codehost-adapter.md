# ADR 0010: A code-host Source driven by an operator's adapter command

- Status: accepted
- Date: 2026-11-05
- Related: [010 Code-host adapter](../010-codehost-adapter.md); [008 Cookbook](../008-cookbook.md), Add a Source; [ADR 0002](0002-agent-account-not-github-app.md); [ADR 0004](0004-github-source-per-repository.md); [ADR 0006](0006-host-checked-merges.md).

## Context

A team wants the agent on its company's own code host instead of GitHub. That code host started as a self-managed GitLab, but it is heavily modified: its API may not match GitLab's, and the team reaches it through an internal CLI (`b1`) whose interface dsh-superagent does not know. Two earlier designs were dropped before any code: a GitLab Source on the `glab` CLI, and one calling GitLab's REST API v4 from the host.

Everything the GitHub Source does is still wanted: requests by mention, replies, pull requests bound to Tickets, CI, host-checked merges by a second account, workers' git as the agent, and the setup warnings about review rules.

## Decision

A new Source kind, `codehost`, reaches the code host only through an **adapter**: one executable the operator writes and configures, run as `<adapter> <operation> '<request JSON>'`, answering JSON. The contract is versioned (`describe` answers `contractVersion: 1` and the operations it supports), and its zod schemas in `src/codehost.ts` are the source of truth that 010 documents.

- **Intake is one operation.** `events` returns, after an opaque cursor, what addresses the agent, what happens on the Threads dsh-superagent names as followed, and what the observe switches ask for. The adapter decides how: a todo list, notifications, webhooks it stored, or updated-since queries. The host stores the cursor only after it took in the page's events, and event IDs make a replay harmless.
- **Thread keys tell Issues from pull requests**: `codehost:12` and `codehost:!12`, since a GitLab-like host numbers them apart. Assigning the agent or requesting its review is a direct address, as a mention is.
- **Optional operations degrade.** Only `whoami`, `repository` and `events` are required. A missing operation turns off what needs it, and setup names each one in a warning. A merge check whose operation is missing fails, so a person merges.
- **Merges stay host-checked** (ADR 0006): the same checks run against `thread`, `files`, `checks` and `approvals`, then a separate **merge adapter**, acting as another account, runs `merge` for the checked head commit. Setup refuses a merge adapter that acts as the agent, and reads `protection` to warn when the code host itself does not require a review.
- **Workers get git, and optionally the CLI.** The adapter is git's credential helper for the clone URL's origin. An internal CLI is an optional worker shim under its own name, refusing the merge commands the operator lists as patterns.
- **GitHub becomes optional.** With the GitHub Source switched off and a code-host Source on, setup resolves no GitHub account, and `gh` in the shims fails.
- **Hooks serve their own kind.** `claim` and `read` come from the kind of the Ticket's or Trigger's own Source when it has them, so a code-host Ticket binds code-host pull requests even with GitHub installed.

## Consequences

- dsh-superagent ships no client for the code host. The team implements and maintains the adapter, and its correctness bounds the Source's: a wrong `approvals` answer passes a merge check. The code host's own branch rules remain the boundary, as on GitHub.
- The contract is the integration surface. A change to it gets a new `contractVersion`, and setup refuses an adapter that speaks another.
- Every call starts a process, so a poll round costs one `events` call per page and one or two calls per followed pull request.
- An adapter can serve GitHub-like or GitLab-like hosts alike; Issues and pull requests never share Thread keys even where a host numbers them together.
- An adapter without `comment` cannot reply; replies are dropped, not retried forever.

## Alternatives considered

- **A GitLab Source on `glab`.** Rejected: the company's host is not reachable through `glab`.
- **GitLab's REST API from the host, with a token file.** Rejected: the host may not be GitLab-compatible, and the team's access goes through its own CLI.
- **A plugin API in TypeScript for the team to implement.** A tighter integration, but the team would build against dsh-superagent's internals and its release cycle; a command with a JSON contract can wrap any CLI in any language and be tested by hand.
- **Webhooks into dsh-superagent.** Left to the adapter: it may receive them and answer `events` from what it stored, without a public endpoint on dsh-superagent (see ADR 0008).
