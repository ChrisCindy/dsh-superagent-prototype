# Architecture decision records

Each record states one decision: its context, what was decided, what follows from it, and what else was considered. A record is not edited once accepted, except its status; a later decision gets a new record that names the one it replaces.

The numbered documents in `docs/` describe how dsh-superagent works now. These records say why.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-worker-os-isolation.md) | Run the profile as a dedicated OS user now, and workers as a second user next | Accepted; step 2 pending |
| [0002](0002-agent-account-not-github-app.md) | The agent is a GitHub user account reached through the GitHub CLI, not a GitHub App | Accepted |
| [0003](0003-model-routes-host-enforces.md) | A model routes work in the main Session and Eval; the host enforces every permission | Accepted |
| [0004](0004-github-source-per-repository.md) | One GitHub Source instance per repository, all sharing the agent account | Accepted |
| [0005](0005-followup-ownership-state-machine.md) | Who decides a follow-up is one state per Ticket, changed only through a transition table | Accepted |
| [0006](0006-host-checked-merges.md) | Merges go through host checks and a separate account, backed by branch protection | Accepted |
| [0007](0007-permission-presets.md) | Sessions run under dsh-superagent's own permission presets with approval `never` | Accepted |
| [0008](0008-github-webhook-mode.md) | GitHub webhooks as a supplement to polling | Proposed, deferred |
| [0009](0009-dingtalk-stream-and-threads.md) | DingTalk through Stream mode in the host process, with Threads by quote and window | Accepted |

To add one, copy the layout of the latest record: a title, then Status, Date and Related, then Context, Decision, Consequences and Alternatives considered. Number it after the last one and add it to this table.
