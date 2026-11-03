/** Source message link resolution and candidate card assembly for the main Session. */
import { handbacksOf, reachedTickets, type Candidate, type Thread, type Ticket, type Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { triggerMessage } from '../executor/dsh.ts'
import { CORRELATED, correlatedCard, relatedTickets, ticketCard, triggerCard } from './cards.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import { attribute } from './views/text.ts'
import { threadTitle } from './views/records.ts'

export interface LinkHost {
  readonly store: Pick<Store, 'settings' | 'triggers' | 'threads' | 'tickets' | 'decisions' | 'read'>
  readonly links: TextCache
  readonly commands: Commands
  readonly sources: SourceRegistry
  readonly lifetime: AbortSignal
}

/**
 * Resolves and caches a trigger's external message URL through its Channel's `messageLink`, falling back to the resource that
 * reads the message when the lookup fails.
 */
export async function sourceLink(host: LinkHost, trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }> {
  if (trigger.url) return { source_url: trigger.url }
  const link = host.sources.messageLink(trigger)
  if (!link) return {}
  const cached = host.links.get(link.key)
  if (cached) return { source_url: cached }
  let url: string
  try { url = await link.read(host.commands, signal ?? host.lifetime) }
  catch {
    host.lifetime.throwIfAborted()
    signal?.throwIfAborted()
    // Optional link enrichment may fail independently of the retained source message.
    return { source_url_read: link.fallback }
  }
  host.links.set(link.key, url)
  return { source_url: url }
}

export function repliedTo({ store, sources }: { store: Pick<Store, 'triggers'>; sources: Pick<SourceRegistry, 'repliesTo'> },
  trigger: Trigger): Trigger | undefined {
  const parent = sources.repliesTo(trigger)
  return parent === undefined ? undefined : store.triggers.get(parent)
}
/** Finds tickets subscribed to threads referenced in `trigger.text` (such as `#12` or URLs) that are not already in `known`. */
function referencedTickets(host: LinkHost, trigger: Trigger, known: readonly Ticket[]): Ticket[] {
  const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap(reference => host.sources.find(reference).threads)
  const ids = new Set(threads.flatMap(thread => host.store.threads.get(thread)?.subscriptions ?? []))
  for (const ticket of known) ids.delete(ticket.id)
  return [...ids].flatMap(id => host.store.tickets.get(id) ?? []).slice(0, 4)
}
/**
 * The Threads correlated with `thread`, at most `CORRELATED`, the most recently active first: each with its label, link,
 * latest Decision and ticket (see `correlatedCard`), for reference only; empty when it has none.
 */
export function correlatedThreads(store: LinkHost['store'], thread: Thread): { correlated_threads?: ReturnType<typeof correlatedCard>[] } {
  const active = (item: Thread) => item.lastAt ?? item.createdAt
  const threads = thread.correlated.flatMap(key => store.threads.get(key) ?? []).sort((a, b) => active(b).localeCompare(active(a)))
  const cards = threads.slice(0, CORRELATED).map(other => {
    const decision = store.decisions.latest(other.key)
    const own = other.subscriptions.filter(id => !other.context?.includes(id))
    const ticketId = decision?.ticketId ?? own.at(-1)
    const url = attribute(other.meta.url) ?? store.read.firstTrigger(other.key)?.url
    return correlatedCard(other, threadTitle(store, other), url, decision, ticketId ? store.tickets.get(ticketId) : undefined)
  })
  return cards.length ? { correlated_threads: cards } : {}
}
/** Builds the main Session's candidate card with routing metadata, handback history, related or referenced tickets, and correlated Threads. */
export async function candidateCard(host: LinkHost, candidate: Candidate) {
  const primary = candidate.triggers.at(-1)!
  const settings = host.store.settings()
  const disposition = host.store.triggers.disposition(primary.id)
  const delivered = disposition ? reachedTickets(disposition) : []
  const referenced = referencedTickets(host, primary, candidate.tickets)
  // Triggers that a worker Session handed back as outside its ticket's scope, with the worker's reason.
  const handedBack = candidate.triggers.flatMap(trigger => handbacksOf(host.store.triggers.disposition(trigger.id))
    .map(item => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })))
  // Format the primary trigger like a worker input (including the message it replies to) and summarize earlier batch triggers as cards.
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  return { ...triggerMessage(primary, await sourceLink(host, primary), undefined, repliedTo(host, primary)), strength: candidate.strength,
    mode: settings.eval.mode, ...others.length ? { batch: others.map(trigger => triggerCard(trigger)) } : {},
    ...handedBack.length ? { handed_back: handedBack } : {}, ...relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}), ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
    ...correlatedThreads(host.store, candidate.thread),
    next_action: candidate.strength === 'explicit' ? 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.'
      : 'Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.' }
}
