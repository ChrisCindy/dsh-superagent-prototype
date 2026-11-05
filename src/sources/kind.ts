/** The `SourceKind` protocol */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { z } from 'zod'
import type { OutboundMessage, PullChanges, ScopeResult, Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { MergeConfig } from '../policy.ts'
import type { SourceContext, SourceHost } from './host.ts'

export interface Localized { zh: string; en: string }
/** `advanced` folds a rarely changed field (such as a polling tunable) behind the card's Advanced section. */
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/**
 * Configuration field specification; `rows` edits a list of records keyed by its first column, `choose` picks from
 * resolved source labels, a `wide` column takes twice the width of the others, and `fact` displays a read-only value from `facts`.
 */
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'fact'; settings?: 'deployment' }
  | FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; wide?: true; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] }

export interface VariableSpec { key: string; description: Localized }
/** `instance` is the id of the instance whose values these are: the one the Ticket's Trigger came from, or the kind's first instance. */
export interface EnvironmentInput<C> { deployment: Deployment; instance: string; config: C; trigger?: Trigger }
export interface AdmissionRowView { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }
/** Policy extension for a source kind, defining allowed senders, admission table rows, and optional external roster sync. */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** Validates the Source's part of the Policy, including `allowed` (senders who may originate work). */
  schema: z.ZodType<P>
  /** Form fields of the policy part; the first is `allowed`. */
  fields: FieldSpec[]
  /** Describes what the Source marks as addressed to the agent, which an allowed sender's explicit request requires. */
  explicit: Localized
  /** Fallback display labels for unlisted human or bot senders when raw sender IDs are not human-readable. */
  unnamed?: { person: Localized; bot: Localized }
  /** Receiving scopes of the Policy's admission table under `config` (matching `scope().row`); kinds without `rows` use the table's defaults. */
  rows?(config: Record<string, unknown>): AdmissionRowView[]
  /** Optional external roster sync (such as chat members); `ready` reports whether `part` names a target to refresh from. */
  sync?: { label: Localized; ready(part: P): boolean; run(host: SourceHost, part: P, signal: AbortSignal): Promise<P> }
}
/** UI link for a channel address; `triggerId` names the Trigger whose own deep link is preferred when available. */
export interface ChannelLink { url: string; label: Localized; triggerId?: string }
/** Deployment facts a link needs: the repository of the channel's own Source instance, and the Feishu bot. */
export interface ChannelLinks { repository?: string; feishu?: Deployment['feishu'] }
/** Outbound messaging adapter for a source kind's threads. */
export interface SourceChannel<C> {
  /** Most words a reply may have; Outbox refuses a longer reply before queueing it. Without it, replies have no limit. */
  limit?: number
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** Returns the URL and label for `address`; `url` is empty when `links` lack the required deployment info. */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink
  /** Looks up the URL of a Trigger's own message when its event carried none; without it, such a Trigger has no link. */
  messageLink?: MessageLink<C>
}
/** Lookup of a Trigger's message URL, which the host caches. */
export interface MessageLink<C> {
  /** The message's key in the link cache, ending with the ID that search matches; undefined when the Trigger names no message. */
  key(trigger: Trigger): string | undefined
  /**
   * Reads the URL within the kind's own time limit.
   * @throws when it cannot, such as after a timeout or for a deleted message.
   */
  read(commands: Commands, trigger: Trigger, config: C, signal: AbortSignal): Promise<string>
  /** The resource that reads the message itself, which the host offers when the lookup fails. */
  fallback(trigger: Trigger): string
}
/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message can never authorize work on its own (at most an inferred candidate). */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** Bounded thread context reader used by assessments to inspect messages and images around a trigger. */
export interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  messageId(trigger: Trigger): string
  /** Reads a page of thread messages (`thread`, first page when `cursor` is omitted), the topic root (`root`), or the replied-to message (`parent`). */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
  /** Extracts image keys from message text that `image` can read; omitted for kinds without image support. */
  images?(text: string): string[]
  /** Reads one image of a message in the Trigger's Thread as an attachment for `agent`. */
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
/** What a Source kind's resource read receives: the name, the instance's commands and configuration, and a Trigger lookup. */
export interface ResourceRead<C> {
  /** The resource name, which starts with `prefix` and a slash. */
  resource: string
  /** The kind's ID, or the ID of the other instance of the kind whose resource this is, such as `github-docs`. */
  prefix: string
  /** Commands of that instance. */
  commands: Commands
  config: C
  /** The Trigger `id`, which the reading Session may read. @throws for an unknown Trigger, or one the Session may not read. */
  trigger(id: string): Trigger
}
/** Originals of a Source kind that `orchestrator_read` serves, under the kind's ID or another instance's. */
export interface SourceResources<C> {
  /** The resources `orchestrator_read` lists after the host's own, by name and what each holds; Executor Sessions read them too. */
  names: readonly { name: string; holds: string }[]
  /**
   * Checks a resource name and the reader's access, and returns the read that fetches it; the host calls the read at offset 0
   * and serves the JSON of its result in pages from a cache after.
   * @throws for a name the kind does not serve, or a Trigger the reader may not read.
   */
  open(input: ResourceRead<C>): () => Promise<unknown>
  /** Resources that read around a Trigger of this kind, which `trigger/<id>` shows as `context`; undefined for none. */
  references?(trigger: Trigger): Record<string, string> | undefined
}
/**
 * How a kind binds the changes an Executor reports, such as pull requests, to its ticket, and merges one. The host calls it
 * with the context of the kind's instance the ticket came from (`SourceRegistry.home`), else the first.
 */
export interface SourceClaim {
  /** The account whose changes from a branch named after the ticket the ticket may claim, which the report tool names. */
  account(ctx: SourceContext): string
  /** The number of the change a ticket card shows: the newest open one it follows on the kind's first instance, else the newest. */
  pull(ticket: Pick<Ticket, 'follows'>): number | undefined
  /**
   * Prepares a report before its transaction: reads change `pull` when one is reported, and for a `ready` report under a
   * Mandate with paths, the files of each open change the ticket opened, as `changes`. `bind`, which the host calls in the
   * report's transaction before recording it, binds the reported change, or returns why it cannot.
   */
  report(ctx: SourceContext, ticket: Ticket, report: { state: string; pull?: number }, signal: AbortSignal):
    Promise<{ changes: PullChanges[]; bind(): string | undefined }>
  /** Checks change `pull` against the merge settings and the ticket's limits, and enables its auto-merge or lists each failed check. */
  merge(ctx: SourceContext, ticket: Ticket, pull: number, merge: MergeConfig, signal: AbortSignal): Promise<unknown>
}
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
  images(text: string): string[]
  /** @throws for a kind without image support. */
  image(agent: Agent, commands: Commands, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
/** Pluggable source kind descriptor registered with SourceRegistry. */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; the kind's first instance has the same ID and always exists, with defaults when none is stored. */
  kind: string
  /** Whether more instances of the kind may be added, each with its own ID (`instanceIdError`), configuration, health, state and Threads. */
  multiple?: true
  /** Configuration keys that a new instance copies from the kind's first instance, such as an account CLI the instances share. */
  shared?: readonly string[]
  title: Localized
  description: Localized
  /** Read-only status facts derived from `deployment` (undefined while waiting for setup), keyed by field key. */
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>
  /**
   * Configuration keys that setup reads, such as an account CLI: of the kind's first instance, and of each other instance while it
   * is on. Only the panel may change one; a change is checked before it is saved and restarts dsh-superagent.
   */
  setup?: readonly string[]
  /** Validates stored and submitted configuration and fills defaults. */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /**
   * Health entry names owned by this kind's first instance under `health[...]`; no other kind or core loop may report them.
   * Another instance reports them under the names `instanceHealth` gives.
   */
  health: string[]
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** Outbound reply adapter; kinds without `channel` produce no replies or channel checks. */
  channel?: SourceChannel<C>
  /** Originals `orchestrator_read` serves under the kind's ID and its other instances' IDs. */
  resources?: SourceResources<C>
  /** Bounded context reader for assessments; assessments of a kind without `threadContext` read none. */
  threadContext?: ThreadContext<C>
  /**
   * Reads a file, or lists a directory, of the repository an assessment reads, with the commands of the instance the Trigger came
   * from (`SourceRegistry.home`); the kind of the Trigger's Source, or of its primary Thread's, serves them when it has `read`, else
   * the first installed kind with `read`, in ID order.
   */
  read?(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string>
  /** Maps a search query to an instance's candidate Thread keys (such as `github:12`) and Trigger search terms (such as a Feishu `om_` ID). */
  find?(query: string, instance: SourceInstance<C>): { threads: string[]; terms: string[] }
  /** Returns the ID of the Trigger whose message this Trigger replies to, when derivable without a network read. */
  repliesTo?(trigger: Trigger): string | undefined
  /**
   * Binding and merging of the changes an Executor reports; the kind of the Ticket's origin Source, or of its primary Thread's,
   * provides it when it has `claim`, else the first installed kind with `claim`, in ID order.
   */
  claim?: SourceClaim
  /**
   * Runs in the transaction that ends a ticket, with the context of the kind's first instance, so the kind can tell the ticket's
   * conversations through `ctx.notify`, such as that its pull request merged.
   */
  ticketEnded?(ctx: SourceContext, ticket: Ticket): void
  /** Policy section for kinds whose senders have their own identity. */
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  /** Rereads display names for row keys (such as chat names), stores the resolved names in `KV.sources.labels(kind)`, and returns them. */
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>
  /**
   * The packaged skill (`skills/dsh-superagent-<name>`) every Session gets while the kind is installed, and, with `active`, only
   * while `active` holds for the deployment, which is undefined while setup waits.
   */
  skill?: { name: string; active?(deployment: Deployment | undefined): boolean }
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }

/** Longest instance ID; it names health entries, KV keys and Thread keys. */
export const INSTANCE_ID_MAX = 40
/**
 * Why `id` cannot name a new instance of `kind`, or undefined when it can: another instance's ID is the kind's ID, a hyphen,
 * and lowercase letters and digits, which may be joined by single hyphens (such as `github-docs`).
 */
export function instanceIdError(kind: string, id: string): 'pattern' | 'length' | undefined {
  if (id.length > INSTANCE_ID_MAX) return 'length'
  return id.startsWith(`${kind}-`) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id.slice(kind.length + 1)) ? undefined : 'pattern'
}
/** The name under which instance `id` of `kind` reports the kind's health entry `name`: unchanged for the kind's first instance. */
export const instanceHealth = (kind: string, id: string, name: string): string =>
  id === kind ? name : name === kind ? id : `${id}:${name}`
