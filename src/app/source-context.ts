/** `sourceContextOf`: each Source kind's `SourceContext` */
import type { EngineForSources, ReceiveResult, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SetupProblem } from '../setup.ts'
import type { SourceContext } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export interface SourceContextDeps {
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  readonly commands: Commands
  readonly sources: SourceRegistry
  /** Throws when accessed before initial setup completes. */
  readonly deployment: Deployment
  readonly ready: Promise<void>
  configured(): boolean
  /** Setup problem whose `place` matches the Source kind, and whose `source` (or `place`) the instance, receives it on `context.problem`. */
  readonly setupProblem?: SetupProblem | undefined
  /** Why setup found no Feishu bot even though the Feishu Source names a CLI. */
  readonly feishuProblem?: SetupProblem | undefined
  /** Why setup left the DingTalk app out even though the DingTalk Source names its credentials. */
  readonly dingtalkProblem?: SetupProblem | undefined
  /** Hands a Trigger to the Engine and schedules the pass that assesses it. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}

/** KV prefix of an instance's own records; the kind's first instance keeps the unprefixed keys it always had. */
export const instanceState = (kind: string, id: string): string => id === kind ? '' : `source:${id}:`
/**
 * Builds the context for instance `instance` of one Source kind. Its commands, KV records and health entries are the instance's
 * own; health reports are restricted to entries declared by the kind and bound to the active registration, becoming no-ops once
 * unregistered.
 */
export function sourceContextOf(deps: SourceContextDeps, kind: { kind: string; health: readonly string[] }, instance = kind.kind): SourceContext {
  const { store } = deps
  const health = deps.sources.healthEntries(kind, instance)
  const prefix = instanceState(kind.kind, instance)
  return {
    source: instance,
    get deployment() { return deps.deployment },
    commands: deps.commands.forSource(instance),
    ready: deps.ready,
    configured: () => deps.configured(),
    get problem() {
      return [deps.feishuProblem, deps.dingtalkProblem, deps.setupProblem].find(problem => problem?.place === kind.kind && (problem.source ?? problem.place) === instance)
    },
    config: <C extends Record<string, unknown>>(id = instance) => {
      const found = deps.sources.instance<C>(id)
      return found?.enabled ? found.config : undefined
    },
    receive: trigger => deps.receive(trigger),
    atomic: work => store.atomic(work),
    state: {
      get: name => store.get(`${prefix}${name}`),
      set: (name, value) => { if (value === undefined) store.delete(`${prefix}${name}`); else store.set(`${prefix}${name}`, value) },
      keys: family => store.keys(`${prefix}${family.prefix}`).map(name => name.slice(prefix.length)),
    },
    threads: {
      get: key => store.threads.get(key),
      subscribed: source => store.read.subscribedThreads(source),
      describe: (key, description) => store.threads.describe(key, description),
      patch: (key, meta) => { store.threads.patchMeta(key, meta) },
    },
    tickets: {
      get: id => store.tickets.get(id),
      open: () => store.tickets.open(),
      bindThread: (id, thread, own) => { deps.engine.bindThread(id, thread, own) },
      threadClosed: (thread, outcome, at) => { deps.engine.threadClosed(thread, outcome, at) },
    },
    triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
    notify: message => { deps.outbox.send(message) },
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
      health.get(entry)?.set(value)
    },
  }
}
