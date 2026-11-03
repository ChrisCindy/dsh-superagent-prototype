# 009 Security

This document states what dsh-superagent trusts, which layer stops each way an agent could gain authority it was not given, and which risks remain. It builds on [002 Authorization](002-authorization.md), [003 Execution](003-execution.md), [004 Prompts](004-prompts.md) and [006 Deployment](006-deployment.md).

The rule from 002 holds throughout: messages, comments and quoted documents are inputs to a decision; they never change permissions. A model can be talked into anything, so every permission is enforced outside the model.

## What is trusted

| Data | Trusted | Why |
| --- | --- | --- |
| A Trigger's `actor`, `human`, `addressed` and `threads` | Yes | The Source derives them from the platform's own fields, such as the GitHub login or the Feishu sender id, not from message text |
| A Trigger's `text`, quotes, attachments and links | No | Anyone who can write in the conversation controls them |
| Source `meta` read from a platform record | As far as the platform vouches for it | A number or a state is the platform's; a title or a body is text |
| An Executor's Report, question and pull-request binding | No | The model writes them; the host checks each against the Ticket (ownership, the pull-request rules) |
| Settings, Policy and prompt versions | Yes | Only people change the Policy and the execution environment (below) |

## Escalation paths and what stops them

| Path | Stopped by |
| --- | --- |
| A message asks the main Session to add someone to an allowed list, change a rule or switch to `auto` | The main Session cannot save the Policy or the accept mode; it can only propose a change, which a person accepts on the panel (002, Who changes the Policy) |
| A message asks the main Session to change the prepare command, the sandbox, writable roots or the merge settings | Those fields are panel-only; tool saves are refused |
| A worker or another local process calls the management API | Every route but `GET state` needs DeepSeek Harness's signed session cookie (006, Management API) |
| A worker rewrites the database, the command shims, the git configuration or the profile | The worker's preset lets it write only its Ticket directory, the temporary areas and the writable roots; setup refuses a writable root that contains the state directory, `$DSH_HOME` or the profile, and any of those kept in a temporary area, which every worker may write (006, Permissions and isolation) |
| The main Session writes files | Its preset is read-only |
| A proactive Ticket's pull request changes files beyond what its rule allows | A rule's `paths` become the Mandate's limits; a `ready` Report whose pull request changes other files is recorded as `blocked` and waits for a person, and a merge request for it is refused (002, Mandate limits) |
| A worker merges its own pull request | Merging goes through `orchestrator_merge_request`, which checks ownership, size, CI and approvals on the host; the worker's `gh` refuses merge commands; setup warns when GitHub's branch protection does not require an approval the agent cannot bypass (003, Merging) |

## Remaining risks

- **The same OS user.** Workers run as the operator's user. The file sandbox stops writes, not reads, and does not govern the network, so a worker can read `$DSH_HOME/.credentials.yaml` and the startup log and so obtain the session cookie. Run the whole profile as a dedicated OS user so the operator's own files and credentials are out of reach. Separating workers from the host process needs a second user or a container (planned).
- **Shims are not a boundary.** A worker can run a program by its absolute path, including `gh` with the agent's token. GitHub's branch protection is what makes an unchecked merge fail; keep it on.
- **`sandbox: full`** turns the file sandbox off for every Session. Use it only to recover a toolchain that the sandbox breaks, and switch back.
- **Prompt rules.** Review rounds, when to ask a person, and any scope a rule does not express as limits are still prompt text that the host does not check. Of the limits, the host checks the files of the pull requests a Ticket opened, acknowledgements, binding a pull request and merge requests; it does not check `git push`, comments the worker posts with `gh`, or changes outside pull requests (002, Mandate limits).
- **Prompt overrides.** The main Session can save prompt overrides on a person's request. They change instructions, not permissions.
