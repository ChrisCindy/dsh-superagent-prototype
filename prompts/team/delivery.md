For every ticket that changes UI, the PR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose private Feishu content or credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI PR is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.

Request the reviews that the matched rules, the assignment, these prompts or repository instructions ask for.
A worker never merges a PR or enables auto-merge with gh, which acts as the agent account: it requests the merge with orchestrator_merge_request, which enables auto-merge as the merge account of the Execution settings once the host's checks pass.
It checks that the PR is one you opened and reported, it is ready, its CI passed on the head commit, it changes no more lines than the limit, approvals of accounts other than the agent's cover the head commit, and no requested change is outstanding; a refusal lists each check that failed.
Request it for a PR you opened from the ticket branch once it is ready and, if it changes what users see, those instructions name who approves such changes and that approval covers the head commit.
Report ready without waiting for approvals, and request the merge again when they arrive.
When the answer says a person merges the PR, such as when no merge CLI is set or the PR is too large, say so in your report.
Withdraw auto-merge with `gh pr merge <number> --disable-auto --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY` as soon as a condition stops holding, such as when a review requests changes, and before you push to the PR; request the merge again for the new head.
Never approve or merge on behalf of a reviewer.
Credit each person who reviews a PR you opened, once per PR, on every commit of the PR branch: when a human reviewer's feedback on it is first assessed, rewrite the branch so each of its commits carries one `Co-authored-by: <name or login> <id+login@users.noreply.github.com>` trailer per person credited so far, with the id from `gh api users/<login> --jq .id`.
Withdraw auto-merge first as above.
Run `git fetch origin`, set `base=$(git merge-base HEAD origin/<base branch>)` with the base branch from `gh pr view <number> --json baseRefName` and `old=$(git rev-parse origin/<head branch>)`, then run `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD` with one `--trailer` per person credited, which changes only commit messages, and push with `git push --force-with-lease=<head branch>:$old`; if the push is rejected, stop and report.
Commits you add later carry the same trailers.
An approval of a commit also covers its rewritten copy, which has the same tree.
If the PR has merged, do not rewrite it; record the uncredited reviewer in orchestrator_report.
Never push an empty commit to credit a reviewer.
Do not credit bots (logins ending in [bot] and the accounts these instructions name as review bots), the PR's author, the agent account, or the person these instructions name as commit author, who is already credited as the author of every commit.
Record whom you have credited in orchestrator_report, so a later worker does not credit them again.
If a human is working on the same problem and their branch or PR contains this ticket's code (commits from the ticket branch, or its changes carried over), close this ticket's PR with gh immediately without asking anyone, leaving one sentence on it that names the human's PR.
Work that is only related, or does not contain the ticket's code, is not a reason to close.
Closing the PR ends the ticket; send no other message.
