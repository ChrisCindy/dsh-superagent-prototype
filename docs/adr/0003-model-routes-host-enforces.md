# ADR 0003: A model routes work; the host enforces permissions

- Status: accepted
- Date: 2026-10-31, recorded 2026-11-05
- Related: [001 Domain model](../001-domain.md), Flow; [002 Authorization](../002-authorization.md); [009 Security](../009-security.md).

## Context

Requests arrive as free text in comments, reviews and chat messages. Before work starts, someone must answer questions such as:

- Is this a request at all, or a remark, a thank-you, or a reply to someone else?
- Is it new work, a follow-up to a Ticket that already runs, or a request to stop one?
- Does an unaddressed message match a rule the team wrote for proactive work?
- Is the same work already open on another Thread?

Keyword rules, labels or a classifier answer these badly: the wording varies, and the answer often depends on the Thread's history and on the other Tickets. A language model reads that context well.

But a model can be talked into anything. Any text it reads can come from anyone who can write in the conversation, and that text may ask it to widen its own rights.

## Decision

Split each decision into what a model judges and what the host enforces.

The model judges, in the main Session (the `orchestrator` Session):

- Explicit requests and follow-ups: whether to accept, attach to a Ticket the message points at, stop, hold or ignore (`orchestrator_route`).
- Inferred candidates, in an Eval: the assessment of each enabled rule, with the evidence for it (`orchestrator_eval`, `orchestrator_eval_decide`).

The host decides, in code, and the model cannot change it:

- **The gate.** Who may originate work and with what strength comes from the Source's allowed list, bot list and admission table, never from message text (002).
- **The outcome.** `assessmentOutcome` turns the model's assessment into an accept only with a judgement for every enabled rule, a matching rule and evidence of intent. Outside `auto` mode an inferred accept is only recorded as "would accept".
- **The Mandate.** An accept records the Policy version, the matched rules and the sender, and the host checks its limits, the files and actions it allows, on acknowledgements, pull-request bindings, `ready` Reports and merge requests (002, Mandate limits).
- **Ownership.** A person's follow-up on a Ticket's Thread goes to that Ticket's Executor; the main Session may only stop or hold it (ADR 0005).
- **Configuration.** The main Session cannot save the Policy or the accept mode; it can only propose a change for a person to accept on the panel. Panel-only fields stay panel-only.
- **Confinement.** The main Session's preset is read-only; workers write only their Ticket directory (ADR 0007). Merges go through host checks (ADR 0006).
- **Limits.** Eval deadlines, the proactive limit per Source and hour, and each Assignment's budget are counted by the host.

## Consequences

- Routing handles free text, context and duplicates without a rule for each case, and the team tunes it in prompts.
- A wrong judgement costs attention, not authority: the worst case is a Ticket that the gate and the Mandate already allowed, or a request ignored. 009 lists each escalation path and the layer that stops it.
- Each model judgement is a stored Decision with its reasons, so people can audit and re-evaluate it.
- Routing costs model time. Evals run one at a time per Thread and have a deadline; an Eval that runs out of time requeues its Triggers and ends `unavailable` on the third try.
- Some scope stays prompt text that the host does not check, such as when to ask a person (009, Remaining risks).

## Alternatives considered

- **Rules only** (mentions, labels, keywords). Predictable, but it misses requests written in other words and cannot tell a follow-up from new work.
- **A model decides everything, including permissions.** Rejected: a message could talk it into adding its sender to the allowed list or into merging.
- **A separate Session per Trigger, with no main Session.** Rejected: no shared view of open Tickets, so more duplicates, and no single place for people to talk to the agent.
- **A small classifier in front of the model.** Possible later as a cost filter; it would not replace the gate or the Mandate.
