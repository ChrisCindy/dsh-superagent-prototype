# ADR 0005: Follow-up ownership as an explicit state machine

- Status: accepted
- Date: 2026-11-05 (plan item 4.1)
- Related: [002 Authorization](../002-authorization.md), Follow-up ownership; [003 Execution](../003-execution.md), Follow-ups and context Threads; `tests/followups-table.spec.ts`.

## Context

A person's message on a Ticket's Thread reaches that Ticket. Its Executor decides it: handle it within the Ticket, or hand it back for a fresh Eval. Until then, no Eval runs on it, and the main Session may only stop or hold the work. The question "which Tickets still own this message?" decides whether a message goes to Eval, whether the main Session may accept it, and whether a closed pull request ends a Ticket.

Schema 14 answered it from several lists on the message's disposition, `fanout` (the Tickets it reached), `context`, `handbacks` and `acked`, together with whether an acknowledgement receipt existed and whether the Ticket's Inputs were read. Each rule read a different mix of them. A message could be in two lists at once, and what a combination meant was spread over the rules that read it.

## Decision

Each disposition keeps one entry per Ticket the message reached (`owners`), with one state and the time it entered it:

| State | Means |
| --- | --- |
| `delivered` | It reached the Ticket on one of its own Threads, or the main Session attached it |
| `read` | The Executor's Session took every copy of it into a step |
| `taken` | The Executor acknowledged or answered it |
| `handedBack` | The Executor handed it back, with a reason |
| `released` | The Ticket ended or could not resume before its Executor read it |
| `context` | It reached the Ticket only on a Thread the Ticket follows for context |

- `OWNER_TRANSITIONS` in `src/core/model.ts` lists, for each event, the state it moves each state to. `transition` is the only function that changes a state. An event a state does not list leaves it alone.
- `delivered`, `read` and `taken` own the message (`OWNING`). `followupOwners` reads only these states, plus whether the Ticket can still decide it.
- 002 shows the same table, and draws it as a diagram.
- `tests/followups-table.spec.ts` checks the rules row by row: each row puts a message in one state, applies one event, and checks the result.
- The schema 15 migration turns each stored disposition's lists into these states once, at start.

## Consequences

- One place to read and change the rules. A new rule is a new row in the table and in the test.
- Each entry records when it entered its state, and a hand-back also its reason.
- A hand-back stands for good, and a take-up stands through a new copy and the Ticket's end. The table states this once, where before each rule had to keep it.
- The migration picks one state for a record that was in several lists: a hand-back first, then context, a take-up, a read of every copy, and else delivered (`ownersOf` in `src/app/migration.ts`).
- Older versions cannot read schema 15 databases; rollback needs the backup (006, Upgrade).

## Alternatives considered

- **Keep the lists and fix each rule.** Smaller change, but the rules would keep reading different lists, and the next rule would add another list.
- **Derive ownership on demand from Inputs, Reports and receipts.** No stored state, but every read would rebuild history from several tables, and a pruned record would change the answer.
- **One owner per message.** Simpler, but a message on a Thread with two Tickets reaches both, and each must decide it.
