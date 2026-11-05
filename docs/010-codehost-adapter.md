# 010 Code-host adapter

The code-host Source (kind `codehost`) serves a code host that dsh-superagent has no built-in client for, such as a company's internal one. dsh-superagent never calls that code host itself: an **adapter**, a command the operator writes on top of whatever the code host offers (an internal CLI, its REST API), answers a fixed set of operations. This document is the contract, version 1. It builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md), [003 Execution](003-execution.md) and [006 Deployment](006-deployment.md), and the Source follows the recipe of [008 Cookbook](008-cookbook.md). `docs/adr/0010-codehost-adapter.md` says why.

The zod schemas in `src/codehost.ts` are the source of truth. `contractSchemas()` there exports them as JSON Schema, by operation:

```sh
node -e "import('./src/codehost.ts').then(m => console.log(JSON.stringify(m.contractSchemas(), null, 2)))"
```

`examples/codehost-adapter/codehost-adapter.mjs` is a stub to start from: it answers `describe` and refuses every other operation with 501, with a TODO where each one calls the internal CLI.

## What maps onto what

| GitHub Source | Code-host Source | Operation |
| --- | --- | --- |
| The agent's account, read with `gh api user` | `whoami` | required |
| Push access to the repository | `repository` (`canPush`) | required |
| Notifications, then the comments of each notified Issue or pull request since its cursor; the repository-wide streams | `events` after the adapter's cursor, with the followed Threads and the observe switches | required |
| An Issue or pull request; a pull request's state, head and size | `thread` | optional |
| The conversation for assessments, `github/…/comments`, the duplicate check of a reply | `comments` | optional |
| Replies, acknowledgements and results as comments | `comment` | optional |
| The files a pull request changes, for Mandate paths | `files` | optional |
| Check runs and statuses of the head commit | `checks` | optional |
| Reviews: approvals covering the head commit, changes requested | `approvals` | optional |
| Repository files an assessment reads | `contents` | optional |
| Branch protection and rulesets read at setup | `protection` | optional |
| Auto-merge enabled by the merge account | `merge`, answered by the merge adapter | optional |
| `gh auth git-credential` as git's credential helper | `git-credential` | optional |

An operation the adapter leaves out of `describe` is never called. Setup records the warning `codehostCapabilities`, naming each missing operation and what it turns off:

- without `thread`, pull requests are not bound to Tickets or checked for a merge;
- without `comments`, assessments read no Thread context, and a reply cannot check that a retry already posted it;
- without `comment`, no reply reaches the code host: replies are dropped (`gone`) and show on the Source page;
- without `files`, a ready report or a merge under a Mandate with paths cannot be checked and waits for a person;
- without `checks`, CI is not followed and no merge passes the CI check;
- without `approvals`, no merge passes the approval check;
- without `contents`, assessments cannot read repository files;
- without `protection`, setup warns that it cannot verify the review rules (`codehostMergeUnverified`);
- without `git-credential`, workers' git gets no credential for the code host.

## Invocation

```
<adapter> <operation> '<request JSON>'
```

- The request is one JSON object in the second argument. Every request but `describe` and `whoami` carries `"repository"`: the Source's repository as its configuration names it.
- The answer is one JSON value on standard output, with exit status 0. Unknown fields are allowed and ignored.
- A failure exits non-zero and prints `{"error": {"code": <integer>, "message": "<text>"}}` on standard error. `410` means gone for good (a reply to a deleted thread is dropped); `501` means not implemented; `404` and every other code are retried on the next poll or send. The message may reach the panel and the Executor; never put a credential in it.
- Calls time out after 90 seconds and run with the agent's environment: `PATH` without the worker shims, and git variables pointing at the agent's git configuration. Setup runs its calls as worker shells do, through DeepSeek Harness's subprocess service, which removes variables whose names contain KEY, PASSWORD, SECRET or TOKEN, so the adapter reads its credential from a file or from the internal CLI's own configuration.
- An operation must be safe to repeat, except `comment` and `merge`, which dsh-superagent repeats only as described below.

Times are ISO 8601 strings. Logins are compared case-insensitively. Thread numbers are positive integers; Issues and pull requests may be numbered apart, since their Thread ids differ.

## Operations

### `describe` (required)

Request `{}`. Answer `{"contractVersion": 1, "capabilities": ["whoami", "repository", "events", …], "name"?: "…"}`. Setup refuses another version, or an adapter without `whoami`, `repository` and `events` (`codehostContract`).

### `whoami` (required)

Request `{}`. Answer `{"id": "…", "login": "…", "name"?: "…", "email"?: "…"}`: the account the adapter acts as. `email` is the address the agent's commits use (`DSH_SUPERAGENT_CODEHOST_COMMIT_EMAIL`).

### `repository` (required)

Request `{"repository"}`. Answer `{"id", "path", "defaultBranch", "canPush", "webUrl", "cloneUrl"?}`. Setup refuses `canPush: false` (`codehostRepositoryReadOnly`) and a `path` another instance already receives. `cloneUrl`, when it is `https://`, is what workers clone (`DSH_SUPERAGENT_CODEHOST_CLONE_URL`), and its origin gets the adapter as git's credential helper.

### `events` (required)

Request:

```json
{ "repository": "acme/widgets", "cursor": "…" | null,
  "follow": [{ "type": "issue" | "pr", "number": 12 }],
  "observe": { "issues": false, "prs": false, "comments": false } }
```

Answer `{"events": [Event, …], "cursor": "…", "more"?: false}`, oldest first. The cursor is opaque: dsh-superagent stores it after it took in the page's events and passes it back. `cursor: null` is the first call: answer no past events (or a short window of the adapter's choice) and the cursor of now. While `more` is true dsh-superagent asks again at once, up to 10 pages a round.

Report:

1. everything that addresses the agent: a mention of its login, an assignment to it, a review request of it;
2. on each Thread in `follow` (subscribed Issues and pull requests, and every pull request an open Ticket follows): new comments and reviews, a change of state (`pr_state`) and of CI (`pipeline`);
3. with `observe.issues`, `observe.prs` or `observe.comments`: new Issues, new pull requests, or comments anywhere in the repository.

Never omit the agent's own events because of the cursor; dsh-superagent drops them itself, but reads its own pull requests' `opened` and `pr_state` events to bind them.

Event:

| Field | Meaning |
| --- | --- |
| `id` | Stable and unique: the same event read again has the same `id`; an edited comment gets a new one, so its new text is a new Trigger. It names the Trigger (`codehost-event`, `id`), so duplicates are dropped |
| `kind` | `opened` (an Issue or pull request, with its description as `text`), `comment`, `mention` (a comment that mentions the agent), `review` (with `review`), `assigned`, `review_requested`, `pipeline` or `pr_state` |
| `thread` | `{"type": "issue" \| "pr", "number", "title"?}` |
| `actor` | `{"login", "id"?, "bot"?}`; `bot: true` for bots and service accounts, whose words never authorize work |
| `text`, `url`, `at` | The message, a link to it, and when it was written |
| `addressed` | true when the event mentions the agent, assigns it, or requests its review; implied by `mention`, `assigned` and `review_requested` |
| `review` | `approved`, `changes_requested` or `commented` |
| `commentId`, `replyTo`, `path`, `line` | The comment's id, the comment it answers, and for a review comment its file and line |

`pipeline` and `pr_state` carry no message; dsh-superagent reads the pull request again (`thread`, `checks`).

### `thread`

Request `{"repository", "type", "number"}`. Answer:

```json
{ "type": "pr", "number": 5, "title": "…", "state": "open" | "closed" | "merged", "url": "…",
  "author": { "login": "…", "bot": false }, "body": "…", "createdAt": "…", "draft": false,
  "head": { "branch": "agent/fix-link", "sha": "…", "repository": null },
  "additions": 3, "deletions": 1, "autoMerge": false, "closedAt": null, "mergedAt": null }
```

`head.repository` is set only for a pull request from a fork; the agent's own pull requests must come from the repository itself. `additions` plus `deletions` is the size the merge check limits.

### `comments`

Request `{"repository", "type", "number", "cursor": null | "…"}`. Answer `{"comments": [Comment, …], "cursor"?: "…"}`, oldest first, `cursor` absent on the last page. Comment: `{"id", "author": {"login", "bot"?}, "body", "url"?, "createdAt", "updatedAt"?, "path"?, "line"?, "replyTo"?, "review"?}`.

### `comment`

Request `{"repository", "type", "number", "body", "key", "replyTo": null | "<comment id>"}`. Answer `{"id", "url"?}`. Post `body` as the agent, in the review discussion of `replyTo` when the code host has one. `body` ends with a hidden marker `<!-- dsh-superagent:<key> -->`. Before a retry dsh-superagent reads `comments` and skips the post when the agent's comment with that marker exists; an adapter that can should also post at most once per `key`. Answer 410 for a thread that is deleted or locked for good.

### `files`, `checks`, `approvals`

- `files {"repository", "number"}` → `{"files": [{"path", "previousPath"?}], "complete"?: true}`; `complete: false` when the code host could not list every file, which no Mandate with paths accepts.
- `checks {"repository", "number"}` → `{"sha", "checks": [{"name", "state": "success" | "failure" | "running" | "skipped" | "cancelled", "url"?}]}`, for the head commit `sha`. A change between two reads becomes a CI Trigger on the pull request; the first read is the baseline.
- `approvals {"repository", "number"}` → `{"sha", "approvals": [{"login", "bot"?, "sha"?}], "changesRequested": ["login"], "dismissesStale"?: false}`. An approval counts for a merge when it names the head commit as `sha`, or names none and `dismissesStale` says the code host withdraws approvals on a push. Approvals of the agent, of the pull request's author and of bots never count.

### `contents`

Request `{"repository", "path", "kind": "file" | "directory"}`. Answer `{"content": "…"}` for a file of the default branch, or `{"entries": [{"name", "type": "file" | "directory"}]}` for a directory. dsh-superagent never asks for hidden paths or `node_modules`.

### `protection`

Request `{"repository", "branch"}`. Answer `{"requiresApproval", "dismissesStale", "agentCanBypass"}`, each `true`, `false` or `null` when the adapter cannot tell. Setup warns `codehostMergeUnverified` for any `null`, `codehostMergeBypass` when the agent's account can push to the default branch or merge into it without an approval, and `codehostMergeUnprotected` when no approval is required or a push keeps it.

### `merge` (merge adapter)

Run by the **merge adapter**, a second adapter that acts as another account: request `{"repository", "number", "sha", "method": "squash" | "merge" | "rebase"}`, answer `{"state": "enabled" | "merged"}`. Merge only `sha`, once the code host's own checks pass, or at once when they already have; refuse when the head moved. The merge adapter answers `describe` (with `whoami` and `merge`) and `whoami`; setup refuses one that acts as the agent (`codehostMergeAgent`), since the code host credits a merge to whoever enabled it.

### `git-credential`

Git runs `<adapter> git-credential get|store|erase` as its [credential helper](https://git-scm.com/docs/gitcredentials) for the origin of each `cloneUrl`, with git's key=value protocol on standard input and output. For `get`, print `username=` and `password=` of the agent's account. `store` and `erase` may do nothing.

## What dsh-superagent does with it

- **Threads.** An Issue's Thread is `codehost:<number>`, a pull request's `codehost:!<number>`; another instance uses its ID, such as `codehost-docs:!5`. Code hosts that number Issues and pull requests apart, as GitLab does, keep them apart this way; a person names them `#12` and `!12` in a search.
- **Policy.** The Source's part lists the allowed logins and the bots. An allowed login's mention makes an explicit request; so does assigning the agent an Issue or requesting its review, which dsh-superagent records as a direct address. The admission table has rows for new Issues, new pull requests and comments, each `All` only with its observe switch.
- **Pull requests.** A Ticket follows its origin pull request, or one the agent's account opened from a branch whose last path segment is the Ticket's name. A poll reads every pull request an open Ticket follows, ends the Ticket when it merges or closes, and turns CI changes into Triggers.
- **Merges.** `orchestrator_merge_request` runs the GitHub Source's checks against the adapter's answers: a merge adapter is set, the Mandate allows `merge`, the Ticket opened and follows the pull request, it is open and not a draft, the head commit's checks all succeeded, the size is within the Execution settings' line limit, its files are within the Mandate's paths, enough approvals cover the head commit, no change request is outstanding, and the merge adapter acts as another account. Only then does it run `merge` with the checked `sha`. A missing operation fails its check and sends a person to merge.
- **Workers.** The variables `DSH_SUPERAGENT_CODEHOST_REPOSITORY`, `_CLONE_URL`, `_ACCOUNT`, `_COMMIT_EMAIL`, `_CLI`, `_NUMBER` and `_TYPE` describe the Ticket's repository. Workers read originals as `codehost/issues/<n>`, `codehost/prs/<n>` with `/comments`, and a pull request's `/files`, `/checks` and `/approvals`, and post through the host's tools. An internal CLI is optional, below.

## The workers' CLI

The Source's **workers' code-host CLI** names an internal CLI, such as `b1`, as a command name or an absolute path. Setup exposes it in the worker shims under its own name, as `gh` is, and refuses a name the shims already use (`gh`, `git`, `lark-cli`). The CLI should act as the agent's account.

**Merge commands the CLI refuses** are patterns matched against the CLI's arguments joined by spaces, with `*` and `?` as wildcards: `mr merge` refuses `b1 mr merge 5`, and `*/merge_requests/*/merge` an API call to a merge endpoint. A refused call prints that the agent requests merges with `orchestrator_merge_request`. With no pattern, setup warns `codehostShimUnguarded`. Like `gh`'s, these refusals are a reminder on the default path: a worker can run the CLI by its path. What stops an unreviewed merge is the code host's own rule that the agent's account cannot merge or push to the default branch without an approval, which `protection` lets setup check.

## Configuration

| Field | Meaning |
| --- | --- |
| Agent adapter | The adapter, a command name or absolute path. Shared by every instance |
| Repository | The repository as the adapter names it |
| Merge adapter | The merge account's adapter; empty means people merge every pull request. The method, line limit and approvals come from the Execution settings' merge block |
| Workers' code-host CLI, Merge commands the CLI refuses | Above |
| Receive new Issues / pull requests / comments | The observe switches |
| Polling interval, Failed polls before reporting an error | Advanced |

Every field but the switches and the polling ones is a setup field: only the panel changes it, saving checks it as setup does, and dsh-superagent restarts.

With the GitHub Source switched off and a code-host Source on, setup resolves no GitHub account: `gh` in the worker shims fails, and the code host is the only one. Switching either changes what setup resolves and restarts dsh-superagent.

## Writing an adapter

1. Copy `examples/codehost-adapter/codehost-adapter.mjs`, or write the same contract in any language.
2. Implement `whoami`, `repository` and `events`, and add them to `describe`. Check each by hand, such as `./adapter whoami '{}'`.
3. Add `thread`, `comments` and `comment`, so the agent can bind pull requests, read conversations and reply.
4. Add `files`, `checks`, `approvals` and `protection` before turning on merges, then a merge adapter acting as the merge account.
5. Add `git-credential` and return `cloneUrl`, so workers' git clones and pushes as the agent.
6. Set the adapter and repository on the Code host Source, switch the GitHub Source off if the code host replaces it, and read the setup warnings on the Overview.
