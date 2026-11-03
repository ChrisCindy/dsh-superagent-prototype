# 002 Authorization

Authorization determines who may start work and what that work may include. This document builds on [001 Domain model](001-domain.md).

The host enforces allowed lists, rules and Mandates. Messages, comments and quoted documents are inputs to a decision; they cannot change those permissions.

## Two paths for a Trigger

### Eval: deciding whether to start work

The Source records whether a message addresses the agent: `mention` for a mention of the bot or agent account, and `direct` for a direct message. The gate checks the sender and the Source's Policy:

- An allowed person who addresses the agent makes an explicit request.
- A person's follow-up on a Thread with Tickets follows the rules below.
- Other human messages use the admission table for their receiving scope.
- A bot on the Source's bot list can produce an inferred candidate, never an explicit request. Other bots are not admitted.
- A hit of a schedule entry on the schedule Source's list is treated like a listed bot's message. See [Schedule entries](#schedule-entries).

### Subscriptions: continuing existing work

Every message on a subscribed Thread reaches its subscribed Tickets as context, including messages from bots and CI. This delivery bypasses the gate and grants no new authority. Each Ticket remains limited by its Mandate.

A person's message on a Ticket's own Thread belongs to that Ticket's Executor to decide. The same applies when the main Session attaches a message to a Ticket. While an Executor owns the message, it takes no Eval and gets no Decision. Each Executor either handles the request within its Ticket's scope or hands it back for routing elsewhere.

Ownership continues while the Ticket is live, even if a person removes its Subscription. It also covers an ended Ticket that was not stopped by a person and has the message waiting to resume it.

The main Session receives a follow-up notice. While an Executor owns the message, the main Session may only stop or hold work on the person's request; accept, attach, ignore and requeue are refused. A stop or a hold still passes through the gate with the follow-up strength described below.

### Handing back and releasing follow-ups

An Executor hands a message back once when it asks for work beyond the Ticket's scope or belongs to another Ticket. The Ticket keeps its Subscription. If an attached Thread is unrelated, the Executor hands back the messages it owns there.

A message goes to a fresh Eval only after no Ticket still owns it. Its candidate includes the Executors' reasons. The gate judges it as an ordinary message on that Thread, and the main Session can accept it, attach it elsewhere or ignore it. Handing back a message the Ticket did not own, such as a bot message or one a person already sent to Eval, queues nothing.

When a Ticket ends, it releases follow-ups its Executor did not read or take up. These include messages never delivered to the Executor and messages delivered after its last Report or turn end, provided it neither acknowledged, answered nor handed them back. Each released message goes to Eval when no other Ticket owns it. A stop ends only the stopped Ticket's work.

A stopped Ticket does not send its stop message to Eval again unless another Ticket handed it back. The main Session that stopped it may accept the rest of the message as new work.

A person can send an owned follow-up to Eval from the panel. If the main Session then attaches it back to a live Ticket, the Executor receives it again. The panel also offers re-evaluation when no effective judgement covers the message.

### Context-only subscriptions

An Executor can follow a related Thread, such as another Issue or pull request, for context. Its messages reach the Ticket but grant no authority or follow-up strength. Human messages there do not resume an ended Ticket unless the main Session attaches a message from that Thread. Notes from the main Session about other work are also context only.

Human messages that reach no Ticket, including Threads whose Tickets were stopped by a person, take the Eval path. Bot messages take that path independently of their delivery to subscribed Tickets.

## Strength

| Strength | Cases |
| --- | --- |
| explicit | A person on the list addresses the agent, or follows up on a Thread that already has a Ticket; a cell of the admission table set to explicit request |
| inferred | A person not on the list follows up on a Thread with a Ticket, unless their cell of the admission table is explicit; a cell of the admission table set to inferred candidate; a message of a bot on the Source's bot list that addresses the agent or arrives where the Source receives every message; a hit of a listed schedule entry |
| not admitted | Any other bot's message, a hit of an unlisted schedule entry, everything the admission table ignores, and every inferred case while the accept mode is `off` |

For an unlisted person, an explicit admission cell takes precedence even on a Thread with Tickets and works in every accept mode. Otherwise their follow-up is inferred and is not admitted in `off` mode. Messages on Threads followed only for context use the admission table instead of follow-up strength.

## Admission

Each Source's Policy has an admission table. Its rows are receiving scopes:

- **Feishu:** each configured chat, other chats the bot receives mentions from, and direct messages. Other chats are received only when **其他群** is set to **仅 @** on the Feishu card.
- **GitHub:** new Issues, new pull requests, comments and the default branch's CI.

A row has up to three cells. Each cell decides whether a message becomes an explicit request, an inferred candidate or nothing:

| Cell | Choices | Default |
| --- | --- | --- |
| On the list, not addressing the agent | inferred, ignore | inferred |
| Not on the list, addressing the agent | explicit, inferred, ignore | ignore |
| Not on the list, not addressing the agent | inferred, ignore | ignore |

Cells for unaddressed messages are available only where the Source receives every message, such as a Feishu chat set to **全部消息** or a GitHub scope with its receive-all switch enabled. A CI result has no sender, so its row offers only the last cell. Bot messages use the bot list instead of these cells.

Setting the unlisted-addressed cell to explicit lets anyone in that scope request work by mentioning the agent. This can be useful for a dedicated support chat. Inferred candidates still depend on the accept mode. Follow-ups normally bypass this table, except that an explicit cell still grants explicit strength.

The admission table is part of the Policy version. Weakening a cell does not immediately stop open Tickets accepted under it. It can revoke their Mandates when they are revalidated before resuming.

### Bots and automated reviewers

The host recognizes GitHub Apps, logins ending in `[bot]`, and Feishu bots as bots. A Source can list bots such as `dependabot[bot]` whose messages may become inferred candidates. They must either address the agent or post in a scope that receives every message. They cannot make explicit requests or stop Tickets.

An automated reviewer using an ordinary account counts as a person to the host. Its comments reach subscribed Tickets and generate follow-up notices. Team prompt text must identify such accounts as automated reviewers.

### Schedule entries

The optional schedule Source holds conditions that need waiting, such as "an Issue nobody took up for two days". Each entry runs a GitHub search in one GitHub Source's repository once per interval. Each hit becomes a Trigger on that Issue's or pull request's Thread, such as `github:12`. Its actor is the entry, and no person sent it.

The schedule Source's Policy part has no allowed list. It lists the entries whose hits may become candidates, as a bot list does. A hit of a listed entry is an inferred candidate: it must match an enabled rule, `observe` mode only records "would accept", and `off` admits nothing. A hit never makes an explicit request or stops a Ticket. A hit of another entry is ignored. The Mandate holds only while the entry is still configured and listed.

A hit is a candidate on a GitHub Thread, so the proactive limit below counts it for that GitHub Source, not for the schedule Source.

## Routing candidates

The main Session routes explicit candidates with `orchestrator_route`. One call can contain several accept, attach, stop, hold or ignore decisions. Each item is processed independently: a refused item or a missing field does not prevent the others from running.

An inferred candidate normally needs a full assessment. There is one shortcut: if its card clearly touches no enabled rule, such as plain chat or unrelated discussion, the main Session may ignore it directly. The Decision records `ignoredFromCard` to distinguish this from a rule assessment. The main Session reads the enabled rules in its Policy prompt section.

Accepting an inferred candidate always requires an assessment. Direct accept refuses a Trigger that the gate did not admit as explicit.

## Accept mode and rules

The accept mode is part of the Policy:

| Mode | Effect |
| --- | --- |
| `off` | Nothing inferred becomes a candidate, such as an unaddressed message, a bot's message or the follow-up of a person not on the list |
| `observe` (default) | Inferred candidates are assessed; a positive assessment is recorded as ignore marked "would accept", and nothing is accepted |
| `auto` | A positive assessment of an inferred candidate accepts it |

Explicit requests work in every mode. Start in `observe` and switch to `auto` after reviewing the recorded Decisions. Each assessment judges every enabled rule exactly once, whether it matches or not. A proactive accept requires at least one matching rule.

### Proactive limit

`eval.maxInferredPerHour` (default 20) caps how many inferred Evals one Source starts in an hour. The host counts the Decisions of the last hour whose Eval asked the main Session for an inferred candidate on that Source's Threads, plus the inferred Evals still running there. A candidate over the limit is recorded as ignore with reason `rateLimited`, and the main Session never sees it. Explicit requests are never limited. The panel's Eval page has a filter for these Decisions, and a person can send such a message to Eval again. Only the panel changes the limit, as with the accept mode.

Each rule describes a kind of proactive work. The Ticket's Mandate records the matched rules, and its Executor receives their names and instructions.

For that Ticket, a rule's process and communication requirements override the defaults. A silence rule can suppress an acknowledgement; a review rule can name the required reviewer and approval before merge. Requirements that apply to every Ticket belong in team prompt sections instead.

### Mandate limits

A Mandate's scope is text for the Executor. Its optional `limits` are the part the host checks:

- `paths`: globs of the repository files the work may change, such as `locale/**`. A glob matches the whole path from the repository root: `*` matches within one folder, `**` across folders, `?` one character, and `{a,b}` either alternative.
- `actions`: what the work may do, out of `comment`, `push`, `open_pr` and `merge`.

A rule can preset limits on the panel. A field is limited only when every rule the assessment matched presets it. The Mandate then allows the union of what those rules allow, because the work may belong to any of them. A matched rule that leaves a field out sets no limit on it. An explicit request matches no rule and so has no limits. The assessment can also give `paths`; they apply only when the matched rules set none. A Mandate without limits works as before.

Limits are fixed at accept, like the rest of the Mandate. A rule's limits are part of the Policy version, so editing them notifies the Tickets accepted under the rule, but their Mandates keep the limits they were given. The Executor's assignment states its limits.

What the host checks, and what it cannot:

| Limit | The host checks | Not checked |
| --- | --- | --- |
| `paths` | On a `ready` Report, the files of each open pull request the Ticket opened, a renamed file under both names. A file outside the paths, or a pull request with more files than GitHub lists (3,000), turns the Report into `blocked` with an Attention that names the files, so the Ticket does not reach `person/review`. A merge request for such a pull request is refused | A pull request the Ticket started from, which holds other people's changes; commits that are in no pull request |
| `comment` | `orchestrator_ack` refuses | Comments the Executor posts with `gh`; replies the main Session sends |
| `push` | Nothing: no host tool pushes | `git push` itself |
| `open_pr` | The host does not bind a pull request the Ticket opened, whether reported or found by polling | `gh pr create` itself: the pull request exists, but the Ticket does not follow it |
| `merge` | `orchestrator_merge_request` refuses | The Executor's `gh` refuses merges for every Ticket anyway |

A person answers the Attention of a `paths` refusal: ask the Executor to drop the other files, or review and merge the pull request themselves. Wider work needs a new request.

## Policy version

Rules, accept mode and each Source's Policy form the Policy version. Every Mandate records the version under which it was accepted.

A version change discards running Evals and queues their Triggers again. It also sends a policy-changed Input to each affected live Ticket. The Input explains whether:

- a matched rule changed, including its new text, or no longer applies;
- the requester may no longer start work; or
- proactive work is no longer accepted, for example because the mode changed from `auto`.

Unaffected Tickets receive no notice. The change does not immediately revoke live Tickets' Mandates.

### Who changes the Policy

Only a person on the panel changes the Policy version, apart from a Source's sync of its own allowed list. The main Session reads untrusted text, so `Settings.save` refuses its saves (origin `tool`) that change the `policy` block, the accept mode or the proactive limit (`panelOnlyPolicy`); it may still change the Eval time limit and model. On a person's request, the main Session calls `orchestrator_policy_propose` with the whole block and its revision instead. The proposal changes nothing. One proposal is kept, the latest, with the request it carries out and the settings paths it changes. The panel's overview shows it to a person, who accepts it, which saves it as a panel save against the revision it was made from, or dismisses it. If the block was saved after the proposal, the proposal is stale and accepting it is refused.

Source configuration is separate from Policy. It controls what enters the system: which chats are read and whether a scope receives all messages or only mentions. A Mandate records its Source and receiving scope. Resuming needs the Source to still listen to the Thread, but does not require it to still receive every message there.

Replies wait while their Source is off. They are dropped if the Source no longer listens to their destination.

A condition on what the Executor may do with its own result, such as when it may merge, does not decide who may authorize work. It is part of the agent's instructions, not of the Policy.

## Resume and stop

An ended Ticket keeps its Mandate. A person's message on one of its own Threads can resume the same work without a new Eval or Decision, regardless of who sent it. Bots and CI do not wake ended Tickets. The Executor decides whether the request fits the scope and ends the round if it does not.

Only three operations change a Mandate: accept creates it, a person's stop withdraws it, and failed revalidation revokes it. A Ticket stopped by a person stays ended and receives nothing more. Work requested there needs a new accept.

### Revalidation before resume

The Source must still listen to the original Thread. The remaining checks depend on the Mandate's basis:

- An explicit follow-up Mandate passes.
- An inferred Mandate needs `auto` mode and its matched rules still enabled.
- A Mandate admitted by a table cell must still receive at least its original strength under today's table and sender membership. Removing a sender from the list can therefore revoke a Mandate accepted through the listed-sender cell.
- A bot's Mandate requires that bot to remain on the Source's bot list. A schedule entry's Mandate also requires the entry to remain configured. Inferred table and bot Mandates also need `auto` mode and enabled matched rules.
- Other Mandates require the sender to remain on the Source's allowed list.

If revalidation fails, the Ticket stays ended and takes none of its waiting messages. Each message is treated as having reached no Ticket; if no other Ticket owns it, it goes to Eval. The main Session is not told it reached a worker. This also applies after a processing pause. Attaching to the Ticket is refused, and further work requires a new accept.

- **A person saying "stop" in a Thread is an ordinary Trigger,** and Eval decides stop. An Executor cannot declare that a person asked it to stop.
- **"Stop for now" is a hold, not a stop.** A person who asks to pause gets a `hold` Decision: the Ticket stays open with its Mandate and takes no automatic Input until a person's message or a release. Like a stop, a hold needs an explicit request.
- **Stop in the panel is a command.** It acts on the Ticket directly and is recorded as a manual stop.
- **Waiting conditions belong to Sources.** A condition such as "no assignee for N hours" would be a Source that waits and checks again itself; Eval never waits.

## When Eval does not finish

The time limit starts when the candidate reaches the main Session. Time spent waiting for delivery does not count, and an undelivered candidate never expires.

An expired Eval queues its Triggers for another attempt. After two consecutive retries, the third expiry records `unavailable`. An assessment failure also records `unavailable`; a later Trigger can start a new Eval. A Policy change or a decision made against an outdated Policy records `unavailable` and immediately queues the batch under the current version.

The `evals` health entry reports unresolved unavailable Decisions from the last hour. `scripts/dsh-superagent status` includes that error.

The panel asks for human attention only when the unavailable Decision is less than 24 hours old, is still the latest Decision on its Thread, has not been dismissed, and the Thread is neither queued nor evaluating. A person can evaluate the Trigger again or dismiss the problem.
