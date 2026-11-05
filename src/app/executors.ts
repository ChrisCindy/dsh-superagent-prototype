/** `Executors`, the registry the Engine's Executor port goes through, and `chosenExecutor`, which Executor a new Ticket runs on */
import { DEFAULT_EXECUTOR, executorOf, type Assignment, type Executor, type Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'

/**
 * The Executor of a new ticket: the first rule its assessment matched that names one, else the Source instance its origin
 * Trigger came from when that names one, else the DshExecutor.
 */
export function chosenExecutor(settings: Settings, rules: readonly string[], source: string | undefined): string {
  const rule = rules.map(id => settings.policy.rules.find(item => item.id === id)?.executor).find(Boolean)
  return rule ?? (source === undefined ? undefined : settings.sources[source]?.executor) ?? DEFAULT_EXECUTOR
}

/**
 * The Executor registry the Engine's Executor port goes through: it holds each Executor by name and dispatches each call to
 * the Executor its Assignment names. A start for a name no Executor holds goes to `unavailable`, which fails the Assignment,
 * so a person can retry it with another Executor.
 */
export class Executors implements Executor {
  private readonly table = new Map<string, Executor>()
  constructor(private readonly unavailable: (ticket: Ticket, assignment: Assignment, name: string) => void) {}
  /**
   * Adds an Executor under `name`.
   * @returns what removes it again.
   * @throws when an Executor holds the name already.
   */
  register(name: string, executor: Executor): () => void {
    if (this.table.has(name)) throw new Error(`An Executor named ${name} exists already`)
    this.table.set(name, executor)
    return () => { if (this.table.get(name) === executor) this.table.delete(name) }
  }
  has(name: string): boolean { return this.table.has(name) }
  /** The names of the Executors it holds, in the order they were added. */
  names(): string[] { return [...this.table.keys()] }
  start(ticket: Ticket, assignment: Assignment): void {
    const name = executorOf(assignment), executor = this.table.get(name)
    if (executor) executor.start(ticket, assignment)
    else this.unavailable(ticket, assignment, name)
  }
  deliver(ticket: Ticket, assignment: Assignment): void { this.table.get(executorOf(assignment))?.deliver(ticket, assignment) }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void { this.table.get(executorOf(assignment))?.stop(ticket, assignment, reason) }
}
