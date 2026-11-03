/**
 * Metrics read from the event table and the records it names: how Evals judged and how long they took, how Tickets ended,
 * and what waits for the main Session. They are the evidence for moving the accept mode from `observe` to `auto`.
 */
import { settled, type Decision, type Strength, type Ticket, type TicketOutcome } from '../../core/index.ts'
import type { Store } from '../store.ts'

const DAY = 86_400_000
/** Durations in milliseconds: how many, and their median and 90th percentile, or null when there are none. */
export interface Spread { count: number; median: number | null; p90: number | null }
function spread(values: number[]): Spread {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  const at = (share: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]! : null
  return { count: sorted.length, median: at(0.5), p90: at(0.9) }
}
const between = (from: string | undefined, to: string | undefined) => from && to ? Date.parse(to) - Date.parse(from) : NaN

/**
 * How long each Eval whose Decision was recorded since `since` took: from its start to its candidate's delivery to the
 * assessor, from delivery to its Decision, and from start to Decision. A gate-only Eval has no start and is left out.
 */
export function evalLatency(store: Store, since: string) {
  // An Eval starts before its Decision, so its start and delivery are read from a day earlier.
  const from = new Date(Date.parse(since) - DAY).toISOString()
  const times = new Map<string, Partial<Record<'started' | 'delivered' | 'decided', string>>>()
  const rows = store.db.prepare(`SELECT type, at, data ->> '$.evalId' AS id FROM event
    WHERE type IN ('eval.started', 'eval.delivered', 'decision.recorded') AND at >= ? ORDER BY seq`).all(from)
  for (const row of rows) {
    const id = String(row.id), at = String(row.at)
    const entry = times.get(id) ?? {}
    if (row.type === 'eval.started') entry.started ??= at
    else if (row.type === 'eval.delivered') entry.delivered ??= at
    else entry.decided ??= at
    times.set(id, entry)
  }
  const decided = [...times.values()].filter(entry => entry.started && entry.decided && entry.decided >= since)
  return { delivered: spread(decided.map(entry => between(entry.started, entry.delivered))),
    decided: spread(decided.map(entry => between(entry.delivered, entry.decided))),
    total: spread(decided.map(entry => between(entry.started, entry.decided))) }
}
/** The relays waiting for the main Session, and since when the oldest waits. */
export function relayQueue(store: Store): { waiting: number; since: string | null } {
  const row = store.db.prepare("SELECT COUNT(*) AS n, MIN(since) AS since FROM effect WHERE kind = 'relay'").get()
  return { waiting: Number(row?.n ?? 0), since: row?.since ? String(row.since) : null }
}
/**
 * The Decisions recorded since `since`, by the strength of their Eval: how many judged a request (`settled`), how many of
 * those accepted it, and how many an Eval in `observe` mode would have accepted.
 */
function evalCounts(store: Store, since: string) {
  const counts: Record<Strength, { judged: number; accepted: number; wouldAccept: number }> = {
    explicit: { judged: 0, accepted: 0, wouldAccept: 0 }, inferred: { judged: 0, accepted: 0, wouldAccept: 0 } }
  let decided = 0
  const rows = store.db.prepare(`SELECT d.value FROM event e JOIN decision d ON d.id = e.data ->> '$.decisionId'
    WHERE e.type = 'decision.recorded' AND e.at >= ?`).all(since)
  for (const row of rows) {
    const decision = JSON.parse(String(row.value)) as Decision
    decided++
    if (!settled(decision)) continue
    const count = counts[decision.strength]
    count.judged++
    if (decision.kind === 'accept') count.accepted++
    if (decision.kind === 'ignore' && decision.audit?.would_accept === true) count.wouldAccept++
  }
  return { decided, ...counts }
}
/**
 * The Tickets that ended since `since`: how they ended, how long they took from acceptance to their end and to their first
 * result (a `ready` report), how many a person held or stopped, and how many had an Assignment that used up its budget.
 */
function ticketCounts(store: Store, since: string) {
  const created = Number(store.db.prepare("SELECT COUNT(*) AS n FROM event WHERE type = 'ticket.created' AND at >= ?").get(since)?.n ?? 0)
  const rows = store.db.prepare(`SELECT k.value, EXISTS (SELECT 1 FROM event h WHERE h.type = 'ticket.held'
      AND h.data ->> '$.ticketId' = k.id) AS held
    FROM ticket k WHERE k.id IN (SELECT data ->> '$.ticketId' FROM event WHERE type = 'ticket.ended' AND at >= ?) AND k.open IS NULL`).all(since)
  const outcomes: Record<TicketOutcome, number> = { completed: 0, merged: 0, closed: 0, dropped: 0, stopped: 0 }
  const durations: number[] = [], results: number[] = []
  let held = 0, stopped = 0, budgetSpent = 0, assignments = 0
  for (const row of rows) {
    const ticket = JSON.parse(String(row.value)) as Ticket
    const ended = ticket.ended!
    outcomes[ended.outcome] = (outcomes[ended.outcome] ?? 0) + 1
    durations.push(between(ticket.createdAt, ended.at))
    const ready = ticket.assignments.flatMap(assignment => assignment.report?.state === 'ready' ? [assignment.report.at] : []).sort()[0]
    if (ready) results.push(between(ticket.createdAt, ready))
    if (Number(row.held)) held++
    if (ended.by === 'human') stopped++
    if (ticket.assignments.some(assignment => assignment.endedReason === 'budgetSpent')) budgetSpent++
    assignments += ticket.assignments.length
  }
  return { created, ended: rows.length, outcomes, duration: spread(durations), toResult: spread(results), held, stopped, budgetSpent, assignments }
}
/**
 * The metrics of the last `days` days (`GET metrics`): Evals by strength, their latency, the Tickets that ended, and the relay
 * queue now. Counts come from the event table, so they start when it did and lose what pruning removed.
 */
export function metrics(store: Store, days: number, now = Date.now()) {
  const since = new Date(now - days * DAY).toISOString()
  return { days, since, evals: evalCounts(store, since), latency: evalLatency(store, since), tickets: ticketCounts(store, since),
    relay: relayQueue(store) }
}
export type MetricsView = ReturnType<typeof metrics>
