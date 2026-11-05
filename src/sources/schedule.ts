/**
 * The schedule kind and plugin entry, exported as `./schedule-watch`: each entry's GitHub search once per period, its hits as Triggers on
 * GitHub Threads, and the period each entry last fired in, kept in KV
 *
 * It holds the waiting conditions that belong to Sources, such as Issues nobody took up within two days.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, liveTicket, type Trigger } from '../core/index.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { githubThreadContext } from './github-read.ts'
import { githubChannel } from './github-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

/** The kind's ID, which is also its one instance's. */
export const SCHEDULE = 'schedule'
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const
/** Milliseconds of a length such as `30m`, `6h`, `2d` or `1w`. */
const lengthMs = (length: string): number => Number(length.slice(0, -1)) * UNITS[length.at(-1) as keyof typeof UNITS]
/** Milliseconds of an entry's interval (`every`, such as `6h`). */
export const intervalMs = (every: string): number => lengthMs(every)
/** The period `at` (epoch milliseconds) falls in for an interval: whole intervals since the Unix epoch, so a day starts at 00:00 UTC. */
export const periodOf = (every: string, at: number): number => Math.floor(at / intervalMs(every))
const MIN_INTERVAL = '15m', MAX_INTERVAL = '30d'
/** `{now}` or `{now-<length>}` in a search, replaced with that time when the entry fires, since a GitHub search takes only dates. */
const PLACEHOLDER = /\{now(?:-([1-9][0-9]{0,4}[mhdw]))?\}/g
/** Qualifiers that would widen a search past the GitHub Source's repository: GitHub joins two `repo:` qualifiers with OR. */
const WIDENING = /(^|[\s(])-?(repo|org|user|owner):/i
const ENTRY_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/
const GITHUB_INSTANCE = /^github(-[a-z0-9]+)*$/
/**
 * Each search fires its entry once a period and takes in at most this many hits, the least recently updated first; a hit
 * past them waits for the next period.
 */
export const MAX_HITS = 30

/** A search with its placeholders replaced by times `now` gives (GitHub's `YYYY-MM-DDTHH:MM:SSZ`), and limited to `repository`. */
export function searchQuery(query: string, repository: string, now: number): string {
  const expanded = query.replace(PLACEHOLDER, (_match, length?: string) =>
    new Date(now - (length ? lengthMs(length) : 0)).toISOString().replace(/\.\d{3}Z$/, 'Z'))
  return `${expanded} repo:${repository}`
}
const EntrySchema = z.object({
  id: z.string().max(40).regex(ENTRY_ID),
  description: z.string().trim().min(1).max(200),
  every: z.string().regex(/^[1-9][0-9]{0,4}[mhd]$/)
    .refine(every => intervalMs(every) >= lengthMs(MIN_INTERVAL) && intervalMs(every) <= lengthMs(MAX_INTERVAL),
      `From ${MIN_INTERVAL} to ${MAX_INTERVAL}`),
  query: z.string().trim().min(1).max(256)
    .refine(query => !WIDENING.test(query), 'The search covers the GitHub Source\'s repository only: leave out repo:, org:, user: and owner:')
    .refine(query => !query.replace(PLACEHOLDER, '').includes('{'), 'The only placeholders are {now} and {now-<length>}, such as {now-48h}'),
  // A row whose GitHub Source is left empty searches the first GitHub Source's repository.
  github: z.preprocess(value => value === '' || value === undefined ? 'github' : value, z.string().max(40).regex(GITHUB_INSTANCE)),
}).strict()
export type ScheduleEntry = z.infer<typeof EntrySchema>
const ScheduleConfigSchema = z.object({
  entries: z.array(EntrySchema).max(20).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate entry ids')
    .default([]),
}).strict()
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>

/** One hit of `search/issues`: an Issue, or a pull request with `pull_request` set. */
const HitSchema = z.looseObject({ number: z.number().int().positive(), title: z.string(), html_url: z.string(), repository_url: z.string(),
  pull_request: z.looseObject({}).nullish() })
export type ScheduleHit = z.infer<typeof HitSchema>
const SearchSchema = z.looseObject({ total_count: z.number(), items: z.array(z.unknown()) })

/**
 * The Trigger of one hit of an entry in one period, on the hit's Thread of the entry's GitHub Source. Its id names the entry,
 * the period and the hit, so a hit is taken in once a period; its actor is the entry, which is no person.
 */
export function scheduleTrigger(source: string, entry: ScheduleEntry, period: number, hit: ScheduleHit, at: string): Trigger {
  const isPr = !!hit.pull_request
  return {
    id: key(SCHEDULE, source, entry.id, String(period), entry.github, String(hit.number)),
    source,
    threads: [{ source: entry.github, id: String(hit.number) }],
    actor: { source, id: entry.id },
    human: false,
    at,
    text: `${entry.description}\n\n${isPr ? 'PR' : 'Issue'} #${hit.number} ${hit.title}`,
    channel: githubChannel(hit.number, hit.html_url, entry.github),
    url: hit.html_url,
    meta: { entry: entry.id, period, query: entry.query, github: entry.github, number: hit.number, isPr },
  }
}

/** Runs an entry's search in the repository of its GitHub Source; a hit in another repository is dropped. */
export async function search(commands: Commands, entry: ScheduleEntry, now: number, tally?: Tally): Promise<ScheduleHit[]> {
  const github = commands.forSource(entry.github)
  const { repository } = github
  // `search/issues` is outside the repository's API paths that `api` allows, so the query's `repo:` keeps it to the repository.
  const answer = SearchSchema.parse(await github.gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${searchQuery(entry.query, repository, now)}`,
    '-f', 'sort=updated', '-f', 'order=asc', '-f', `per_page=${MAX_HITS}`]))
  return validItems(HitSchema, answer.items, tally).filter(hit => sameName(hit.repository_url.replace(/^.*\/repos\//, ''), repository))
}
/** Whether a ticket that is not only following it for context is still live on Thread `thread`. */
function working(ctx: SourceContext, thread: string): boolean {
  const found = ctx.threads.get(thread)
  return !!found?.subscriptions.some(id => {
    const ticket = ctx.tickets.get(id)
    return !!ticket && liveTicket(ticket) && !found.context?.includes(id)
  })
}
export interface Fired { hits: number; working: number }
/**
 * Fires `entry` unless it already fired in the period of `now`: takes in a Trigger per hit, except on a Thread a live ticket
 * works on, then records the period. A failed or stopped search records nothing, so the next round runs it again, and a hit
 * taken in before the failure is a duplicate then.
 * @returns undefined when the entry already fired in this period.
 */
export async function fireEntry(ctx: SourceContext, entry: ScheduleEntry, now: number, signal?: AbortSignal, tally?: Tally): Promise<Fired | undefined> {
  const period = periodOf(entry.every, now)
  const record = KV.schedule.fired(entry.id)
  if (ctx.state.get(record)?.period === period) return undefined
  const at = new Date(now).toISOString()
  const hits = await search(ctx.commands.withSignal(signal), entry, now, tally)
  const fired: Fired = { hits: 0, working: 0 }
  for (const hit of hits) {
    if (signal?.aborted) throw new Error('The schedule Source stopped during a search')
    const thread = `${entry.github}:${hit.number}`
    if (working(ctx, thread)) { fired.working++; continue }
    await ctx.receive(scheduleTrigger(ctx.source, entry, period, hit, at))
    fired.hits++
    ctx.threads.describe(thread, { label: `#${hit.number} ${hit.title}`, url: hit.html_url, facts: { number: { value: `#${hit.number}` } } })
  }
  ctx.state.set(record, { period, at, hits: fired.hits })
  return fired
}
/**
 * One round: fires each entry whose period has not fired, each on its own, and forgets the periods of entries no longer
 * configured. Reports the round as the Source's health.
 * @throws when a search failed, after every entry ran.
 */
export async function scheduleRound(ctx: SourceContext, signal?: AbortSignal, now = Date.now()): Promise<void> {
  const config = ctx.config<ScheduleConfig>()
  if (!config) return
  const ids = new Set(config.entries.map(entry => entry.id))
  for (const name of ctx.state.keys(KV.schedule.fired)) if (!ids.has(name.slice(KV.schedule.fired.prefix.length))) ctx.state.set(name, undefined)
  const tally = { skipped: 0 }
  const failures: string[] = []
  let busy = 0
  for (const entry of config.entries) {
    if (signal?.aborted) return
    try { busy += (await fireEntry(ctx, entry, now, signal, tally))?.working ?? 0 }
    catch (error) {
      if (signal?.aborted) return
      failures.push(`${entry.id}: ${String(error)}`)
    }
  }
  if (failures.length) throw new Error(`${failures.length} schedule searches failed: ${failures.slice(0, 3).join('; ')}`)
  const current = config.entries.flatMap(entry => {
    const fired = ctx.state.get(KV.schedule.fired(entry.id))
    return fired?.period === periodOf(entry.every, now) ? [fired] : []
  })
  const detail = `${config.entries.length} entries; ${current.length} fired this period with ${current.reduce((sum, fired) => sum + fired.hits, 0)} hits`
    + (busy ? `; ${busy} hits on Threads with a live ticket skipped` : '') + (tally.skipped ? `; ${tally.skipped} unreadable hits skipped` : '')
  ctx.report(SCHEDULE, { state: 'ready', detail, at: new Date(now).toISOString() })
}

export const scheduleKind: SourceKind<ScheduleConfig> = {
  kind: SCHEDULE,
  title: { zh: '定时条件', en: 'Schedule' },
  description: { zh: '按间隔在 GitHub 来源的仓库里搜索 Issue 和 PR，每个命中成为它所在线程上的一个触发，例如两天没人认领的 Issue。触发不是人发的，只能成为推断的候选。', en: 'Searches the Issues and pull requests of a GitHub Source\'s repository on an interval; each hit becomes a Trigger on its Thread, such as an Issue nobody took up for two days. Its Triggers are not a person\'s, so they can only become inferred candidates.' },
  schema: ScheduleConfigSchema,
  fields: [
    { key: 'entries', type: 'rows', label: { zh: '条目', en: 'Entries' },
      hint: { zh: '每个条目在每个间隔里搜索一次，从 UTC 零点起算；同一个间隔里重启不会再搜索。搜索用 GitHub 的搜索语法，只在 GitHub 来源的仓库里搜，不写 repo:、org:、user:。{now-48h} 换成 48 小时前的时间，例如 is:issue is:open no:assignee updated:<{now-48h}。每次最多取 30 个命中，最久没有更新的在前；已有进行中工单的线程跳过。GitHub 来源不填时是第一个。条目要列入策略的“命中可以成为候选的条目”才会交给评估。', en: 'Each entry searches once an interval, counted from 00:00 UTC; a restart in the same interval does not search again. The search uses GitHub\'s search syntax, in the GitHub Source\'s repository only, without repo:, org: or user:. {now-48h} becomes the time 48 hours ago, as in is:issue is:open no:assignee updated:<{now-48h}. Each search takes up to 30 hits, the least recently updated first, and skips Threads with a live ticket. An empty GitHub Source is the first one. An entry goes to Eval only once it is on the Policy\'s list of entries whose hits may become candidates.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '条目', en: 'Entry' }, pattern: '[a-z0-9]+(-[a-z0-9]+)*' },
        { key: 'description', type: 'text', label: { zh: '说明', en: 'Description' }, wide: true },
        { key: 'every', type: 'text', label: { zh: '间隔，如 6h', en: 'Every, as 6h' }, pattern: '[1-9][0-9]{0,4}[mhd]' },
        { key: 'query', type: 'text', label: { zh: 'GitHub 搜索', en: 'GitHub search' }, wide: true },
        { key: 'github', type: 'text', label: { zh: 'GitHub 来源', en: 'GitHub Source' }, pattern: 'github(-[a-z0-9]+)*', optional: true },
      ] },
  ],
  health: [SCHEDULE],
  // A hit is received only while its entry is configured; its Mandate holds only while the entry remains.
  scope: ({ meta }, config) => config.entries.some(entry => entry.id === meta.entry)
    ? { listened: true, observed: true } : { listened: false, reason: 'entry_not_listed' },
  // A hit's Thread is a GitHub Thread: assessments read its conversation from that GitHub Source's repository.
  threadContext: {
    messageId: trigger => githubThreadContext.messageId(trigger),
    read: (commands, trigger, part, cursor) => githubThreadContext.read(commands.forSource(trigger.threads[0]!.source), trigger, part, cursor, undefined),
  },
  policy: {
    // Its Triggers have no person behind them: nobody is allowed, and the entries are listed as `bots`, which the gate admits
    // as inferred candidates at most.
    schema: z.object({ allowed: z.array(z.object({ id: z.string() }).strict()).max(0).default([]),
      bots: z.array(z.object({ id: z.string().max(40).regex(ENTRY_ID), name: z.string().trim().max(100).optional() }).strict())
        .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate entry ids').default([]) }).strict(),
    fields: [{ key: 'bots', type: 'rows', label: { zh: '命中可以成为候选的条目', en: 'Entries whose hits may become candidates' },
      hint: { zh: '名单里的条目的命中成为推断的候选，交给评估：要匹配启用的规则，按接单方式处理，观察时只记录“会接单”，并计入命中所在 GitHub 来源每小时的主动评估上限。它们不能发起明确的请求，也不能停止工单；其他条目的命中记为忽略。', en: 'A hit of an entry on this list becomes an inferred candidate for an assessment: it must match an enabled rule, follows the accept mode, is only recorded as would accept while observing, and counts toward the hourly proactive Eval limit of the GitHub Source it is on. It never makes an explicit request or stops a ticket; hits of other entries are recorded as ignored.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '条目', en: 'Entry' }, pattern: '[a-z0-9]+(-[a-z0-9]+)*' }] }],
    explicit: { zh: '定时条件从不发起明确的请求；名单里的条目的命中只成为推断的候选。', en: 'A schedule never makes an explicit request; a hit of an entry on the list only becomes an inferred candidate.' },
  },
}

/** How often the loop looks for an entry whose period has not fired; an entry fires at most once a period whatever this is. */
export const TICK_MS = 60_000
export const name = 'dsh-superagent-schedule'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(scheduleKind), 'schedule: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, scheduleKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report(SCHEDULE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is searched.
  if (!ctx.configured()) { ctx.report(SCHEDULE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    if (!ctx.config()) ctx.report(SCHEDULE, health('paused', 'sourceOff'))
    else {
      try {
        await scheduleRound(ctx, signal)
        failures = 0
      } catch (error) {
        failures += 1
        // A search failure is retried on the next round; three rounds in a row need a person.
        if (!signal.aborted && failures >= 3) ctx.report(SCHEDULE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause(TICK_MS, signal)
  }
}
