/**
 * `Api`, every route with its parameters, query, body and response, and the filters of the lists; it imports only types, so the panel
 * bundles it
 */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { Settings } from './settings.ts'
import type { MetricsView } from './views/metrics.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { StoredEvent } from './store-read.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'POST sources': { body: { kind: string; id: string }; response: { revision: number; restarting: boolean } }
  'POST sources/:id/remove': { body: { revision: number }; response: { removed: boolean; revision: number; restarting: boolean } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; reason?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  /** Domain events newest first, of the comma-separated `type`s; `next_before` continues the list as `before`. */
  'GET events': { query?: { type?: string; since?: string; before?: number; limit?: number }
    response: { items: StoredEvent[]; next_before: number | null } }
  /** Evals, their latency, the Tickets that ended in the last `days` days (7 when left out), and the relays waiting now. */
  'GET metrics': { query?: { days?: number }; response: MetricsView }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  /** `executor` names the Executor the new Assignment runs on; without it, the one the stalled Assignment ran on. */
  'POST tickets/:id/retry': { body?: { executor?: string }; response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  /** Whether the ticket was held now, false when it was held already. */
  'POST tickets/:id/hold': { response: { held: boolean } }
  /** Whether the ticket was held. */
  'POST tickets/:id/release': { response: { released: boolean } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'GET policy-proposal': { response: { proposal: ReturnType<Settings['proposal']> } }
  'POST policy-proposal/accept': { response: { revision: number; restarting: boolean } }
  'POST policy-proposal/dismiss': { response: { dismissed: boolean } }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
