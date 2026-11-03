/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import { instanceHealth, type ChannelLink, type ChannelLinks, type SourceInstance, type SourceKind, type SourceResources, type TriggerContext,
  type VariableSpec } from './kind.ts'

type Stored = Settings['sources'][string]

/**
 * Manages registered SourceKind plugins, resolves their instances from the settings, validates instance and policy
 * configurations, and implements SourceScope for the Engine. An instance is found by its ID, and its implementation by its
 * stored `kind`; a kind's first instance has the kind's ID and exists even when nothing is stored for it.
 * Claims each instance's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  /** Health entries claimed for each kind, by entry name: the first instance's at registration, another instance's when first asked for. */
  private readonly health = new Map<string, Map<string, HealthEntry>>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** Registers a SourceKind, claims its first instance's health entries on HealthBoard (rejecting `sync:` prefixes owned by Settings), and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const entry of entries.values()) entry.release(); entries.clear() }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    this.health.set(kind.kind, entries)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); this.health.delete(kind.kind); release(); unregistered() }
  }
  /**
   * Returns the active health entries of instance `id` of `kind`, keyed by the kind's entry names and claimed on first use for
   * an instance other than the first. A Source context writes through the entries it received when built, so reports sent
   * after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(kind: { kind: string; health: readonly string[] }, id = kind.kind): Map<string, HealthEntry> {
    const entries = this.health.get(kind.kind)
    if (!entries) return new Map()
    return new Map(kind.health.flatMap(name => {
      const named = instanceHealth(kind.kind, id, name)
      // A first instance writes to the entry of that name that a registered kind claimed.
      let entry = entries.get(named) ?? (id === kind.kind ? [...this.health.values()].find(claimed => claimed.has(named))?.get(named) : undefined)
      if (!entry && id !== kind.kind) {
        // An entry another part already reports stays theirs; this instance's reports to it do nothing.
        try { entry = this.board.claim(named, { state: 'starting', detail: '' }) } catch { return [] }
        entries.set(named, entry)
      }
      return entry ? [[name, entry] as const] : []
    }))
  }
  /** The health entry names instance `instance` reports, by the kind's entry name. */
  healthNames(instance: Pick<SourceInstance, 'id' | 'kind'>): { name: string; entry: string }[] {
    return (this.kinds.get(instance.kind)?.health ?? []).map(name => ({ name, entry: instanceHealth(instance.kind, instance.id, name) }))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** The installed kind of instance `id`: its stored `kind`, or the kind with that ID for a kind's first instance. */
  kindOf(id: string, settings = this.settings()): SourceKind | undefined { return this.kinds.get(settings.sources[id]?.kind ?? id) }
  /**
   * The instance of `kind` that `source` names, or the kind's first instance when `source` (such as a Feishu Trigger's) names
   * none of that kind. For a Trigger: the Source it came from when that is of `kind`, else the Source of its primary Thread when
   * that is, so a Trigger one Source places on another's Thread (a schedule hit on an Issue) takes that Thread's instance.
   */
  home(kind: string, source: string | Pick<Trigger, 'source' | 'threads'> | undefined, settings = this.settings()): string {
    const named = (id: string | undefined) => id !== undefined && (settings.sources[id]?.kind ?? id) === kind
    if (typeof source === 'object') return named(source.source) ? source.source : this.home(kind, source.threads[0]?.source, settings)
    return named(source) ? source! : kind
  }
  /**
   * Every registered kind's instances, kinds in ID order and the first instance of each before the others in ID order, followed
   * by stored instances whose kind is not installed (with their config kept as stored).
   */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      const others = Object.entries(settings.sources).filter(([id, stored]) => stored.kind === kind.kind && id !== kind.kind)
        .sort(([a], [b]) => a.localeCompare(b))
      return [this.resolve(kind, kind.kind, settings.sources[kind.kind]), ...others.map(([id, stored]) => this.resolve(kind, id, stored))]
        .map(instance => ({ ...instance, installed: true }))
    })
    const orphaned = Object.entries(settings.sources).filter(([, stored]) => !this.kinds.has(stored.kind))
      .map(([id, stored]) => ({ id, kind: stored.kind, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kindOf(id, settings)
    return kind ? this.resolve(kind, id, settings.sources[id]) as SourceInstance<C> : undefined
  }
  /**
   * Validates a submitted value for instance `id` (an existing instance, or a new one of `kind`) with its kind's schema.
   * @throws when the instance's kind is not installed, or the configuration is invalid.
   */
  validate(id: string, value: { enabled: boolean; config: unknown; executor?: string }, settings = this.settings(), kind = settings.sources[id]?.kind ?? id): Stored {
    const found = this.kinds.get(kind)
    if (!found) throw new Error(`Source kind not installed: ${kind}`)
    return { kind, enabled: value.enabled, config: found.schema.parse(value.config), ...value.executor ? { executor: value.executor } : {} }
  }
  /** Validates each Source's part of a submitted Policy against its instance's kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>, settings = this.settings()): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kindOf(id, settings)?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindOf(id, settings)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kindOf(channel.source, settings)
    if (!kind) return false
    const instance = this.resolve(kind, channel.source, settings.sources[channel.source])
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  /**
   * The enabled instance whose variables each kind contributes: the instance `origin` (a Ticket's Trigger, or a Source ID) has
   * of that kind (see `home`), else the kind's first instance.
   */
  environments(settings = this.settings(), origin?: string | Pick<Trigger, 'source' | 'threads'>) {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      const id = this.home(kind.kind, origin, settings)
      const instance = this.resolve(kind, id, settings.sources[id])
      return kind.environment && instance.enabled ? [{ kind, instance: id, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's instance, with `commands` scoped to that instance; returns `'waiting'`
   * while the instance's kind is not installed, or `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kindOf(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands: commands.forSource(message.channel.source) }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kindOf(channel.source)?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  /**
   * The lookup of `trigger`'s message URL through its instance's Channel, with that instance's configuration and commands, or
   * undefined when its kind has none or the Trigger names no message.
   */
  messageLink(trigger: Trigger, settings = this.settings()): { key: string; fallback: string; read(commands: Commands, signal: AbortSignal): Promise<string> } | undefined {
    const kind = this.kindOf(trigger.source, settings)
    const link = kind?.channel?.messageLink
    const key = link?.key(trigger)
    if (!kind || !link || key === undefined) return undefined
    const { config } = this.resolve(kind, trigger.source, settings.sources[trigger.source])
    return { key, fallback: link.fallback(trigger), read: (commands, signal) => link.read(commands.forSource(trigger.source), trigger, config, signal) }
  }
  /** The resources every installed kind serves, kinds in ID order, as `orchestrator_read` lists them. */
  resourceNames(): { name: string; holds: string }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.resources?.names ?? [])
  }
  /**
   * The instance whose resources a name starting with `prefix` reads, with its kind's title, resources and the instance's
   * configuration: for a kind's ID, the instance `origin` has of that kind (see `home`); for another instance's ID, that
   * instance. Undefined when no installed kind with resources has it.
   */
  resources(prefix: string, origin?: string | Pick<Trigger, 'source' | 'threads'>, settings = this.settings()):
    { id: string; title: string; resources: SourceResources<Record<string, unknown>>; config: Record<string, unknown> } | undefined {
    const kind = this.kindOf(prefix, settings)
    if (!kind?.resources) return undefined
    const id = prefix === kind.kind ? this.home(kind.kind, origin, settings) : prefix
    return { id, title: kind.title.en, resources: kind.resources, config: this.resolve(kind, id, settings.sources[id]).config }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = this.instances().flatMap(instance => {
      const kind = instance.installed ? this.kinds.get(instance.kind) : undefined
      return kind?.find ? [kind.find(query, instance)] : []
    })
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kindOf(trigger.source)?.repliesTo?.(trigger) }
  /** The thread context of `trigger`'s instance, whose reads run with the caller's commands scoped to that instance. */
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kindOf(trigger.source, settings)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind, trigger.source, settings.sources[trigger.source])
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands.forSource(trigger.source), trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands.forSource(trigger.source), trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kindOf(input.source, settings)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, input.source, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, id: string, stored: Stored | undefined): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
