# ADR 0006: Host-checked merges, backed by GitHub's branch protection

- Status: accepted
- Date: 2026-11-03 (plan item 1.5)
- Related: [003 Execution](../003-execution.md), Merging; [006 Deployment](../006-deployment.md), Merge account and Setup checks; [009 Security](../009-security.md); [ADR 0002](0002-agent-account-not-github-app.md).

## Context

Teams want small, reviewed pull requests to merge without a person pressing the button. Before this change, auto-merge was only prompt text: the Delivery requirements told the Executor when it might enable auto-merge with another account's CLI. Nothing on the host checked the pull request, and a worker steered by a comment could run the merge itself.

Two facts shape the design:

- GitHub credits a merge to the account that enabled auto-merge. If the agent account enabled it, the agent would approve its own work in GitHub's record.
- A worker runs as an OS user that can run any program by path ([ADR 0001](0001-worker-os-isolation.md)). A shim or a prompt cannot stop it from calling GitHub with the agent's token.

## Decision

Three layers, each enough for a different threat:

1. **A host tool decides.** An Executor asks with `orchestrator_merge_request`. The host (`mergeChecks` in `src/sources/github-merge.ts`) refuses unless every check passes: the Mandate allows `merge`; the Ticket opened the pull request and follows it, and it is open and not a draft; every CI check of the head commit succeeded; the change is at most `maxLines`; its files are within the Mandate's `paths`; at least `requireApprovals` approvals from accounts other than the agent's cover the head commit; no change request is outstanding; and a merge CLI is set to an account other than the agent's.
2. **A separate account merges, for the checked commit only.** The host enables auto-merge as the merge account with `--match-head-commit <head>`, so a later push cannot ride on the approval. Only the panel sets the merge CLI and limits.
3. **GitHub enforces.** The default branch must require an approving review, dismiss stale approvals on a push, and not let the agent account bypass this. Setup reads these rules as the agent account (`checkMerging`) and shows a warning when they are missing, bypassable or unreadable.

The `gh` shim also refuses `gh pr merge` and the GraphQL and REST merge calls, and points to the tool. It is a hint, not a boundary.

## Consequences

- A merge happens only when the host's checks and GitHub's rules both pass. A worker that bypasses the shim still meets branch protection.
- A refusal lists each failed check, and says whether a person merges or the Executor may ask again.
- Teams need a second account, signed in to its own wrapper, for auto-merge. Without one, people merge every pull request.
- The checks read GitHub through the agent's account, so they cost API calls and see what that account sees.
- Setup can only warn about branch protection, not enforce it: an account without admin rights may not read the rules, and the operator must fix them on GitHub.

## Alternatives considered

- **Prompt rules only** (the earlier design). Rejected: nothing outside the model checks them.
- **Let the agent account merge.** Rejected: the agent would be the account of record for its own merge, and branch protection could not tell it from a reviewer.
- **Branch protection only, no host tool.** Safe, but it cannot check the Mandate's paths, the size limit or that the Ticket owns the pull request, and the worker would need merge commands in its shell.
- **GitHub's merge queue.** Possible later for busy repositories. It orders merges but does not replace the Mandate checks.
