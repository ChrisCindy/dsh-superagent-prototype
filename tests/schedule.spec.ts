/** The schedule Source: its entries, searches, Triggers on GitHub Threads, periods kept across restarts, and its part of the Policy. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, threadKey, type Candidate, type Ticket, type Trigger } from '../src/core/index.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { assessmentOutcome, SettingsSchema, settingsPolicy, type Assessment } from '../src/policy.ts'
import { claimPull, type Pull } from '../src/sources/github-pull.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { apply, fireEntry, MAX_HITS, periodOf, scheduleKind, scheduleRound, scheduleTrigger, searchQuery, TICK_MS,
  type ScheduleEntry } from '../src/sources/schedule.ts'
import { testDeployment } from './fixtures/deployment.ts'

const HOUR = 3_600_000
/** 2026-11-03T10:00:00Z, inside the period of a six-hour entry that began at 06:00. */
const NOW = Date.parse('2026-11-03T10:00:00Z')
const STALE = { id: 'stale', description: 'Issues nobody took up for two days', every: '6h', query: 'is:issue is:open no:assignee updated:<{now-48h}' }
const deployment = testDeployment({ repositories: { github: 'acme/widgets', 'github-docs': 'acme/docs' } })

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

interface Options { entries?: Record<string, unknown>[]; listed?: string[]; mode?: 'off' | 'observe' | 'auto'; maxInferredPerHour?: number }
function settingsOf({ entries = [STALE], listed = ['stale'], mode = 'observe', maxInferredPerHour = 20 }: Options = {}) {
  return SettingsSchema.parse({
    sources: { schedule: { enabled: true, config: { entries } }, 'github-docs': { kind: 'github', enabled: true, config: { repository: 'acme/docs' } } },
    policy: { sources: { schedule: { bots: listed.map(id => ({ id })) }, github: { allowed: [{ id: 'alice' }] } } },
    eval: { mode, maxInferredPerHour },
  })
}
/** A Store, registry and Engine as the Runtime wires them, with stand-in ports, and the schedule Source's context. */
function host(options: Options = {}, store = new Store(join(mkdtempSync(join(tmpdir(), 'schedule-')), 'db.sqlite'))) {
  store.saveSettings(settingsOf(options))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(scheduleKind); sources.register(githubKind)
  const requests: Candidate[] = []
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn((candidate: Candidate) => { requests.push(candidate) }) },
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment, ready: Promise.resolve(), configured: () => true, receive }
  return { store, sources, engine, receive, requests, health: board.all, deps, ctx: sourceContextOf(deps, scheduleKind) }
}
const hit = (number: number, overrides: Record<string, unknown> = {}) => ({ number, title: `Issue ${number}`, state: 'open',
  html_url: `https://github.com/acme/widgets/issues/${number}`, repository_url: 'https://api.github.com/repos/acme/widgets', ...overrides })
/** GitHub's search, answering each query with the hits `answer` gives; returns the `gh` arguments of each search. */
function searches(answer: (q: string) => unknown[] | Error) {
  const calls: string[][] = []
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => {
    calls.push(args)
    const q = args[args.indexOf('search/issues') + 2]!.slice(2)
    const items = answer(q)
    if (items instanceof Error) throw items
    return { total_count: items.length, incomplete_results: false, items }
  })
  return calls
}
const query = (call: string[]) => call[call.indexOf('search/issues') + 2]!.slice(2)
const entry = (overrides: Partial<ScheduleEntry> = {}) => scheduleKind.schema.parse({ entries: [{ ...STALE, ...overrides }] }).entries[0]!
/** An accept as the main Session's assessment gives it, matching the copy rule. */
const accept: Assessment = { decision: 'accept', title: 'Triage', scope: 'Label the stale Issue', reason: 'stale', intent_evidence: 'unclaimed for days',
  rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'fits' }, { rule_id: 'visual', matched: false, reason: 'no' }],
  direction: { implementation_requested: true, target_basis: 'existing-standard', requires_design_decision: false, evidence: 'the Issue' } }

describe('entries', () => {
  it('receives nothing by default and keeps each entry to a GitHub Source, an interval and a search of that repository', () => {
    expect(scheduleKind.schema.parse({})).toEqual({ entries: [] })
    // A row left without a GitHub Source searches the first one's repository.
    expect(entry()).toEqual({ ...STALE, github: 'github' })
    expect(entry({ github: '' as never }).github).toBe('github')
    expect(entry({ github: 'github-docs' }).github).toBe('github-docs')
    const refused = (overrides: Record<string, unknown>) => scheduleKind.schema.safeParse({ entries: [{ ...STALE, ...overrides }] }).success
    expect(refused({ every: '10m' })).toBe(false)
    expect(refused({ every: '31d' })).toBe(false)
    expect(refused({ every: '15m' })).toBe(true)
    expect(refused({ every: '1w' })).toBe(false)
    // A search may not reach past the repository, since GitHub joins two repo: qualifiers with OR.
    for (const widening of ['repo:other/x is:open', 'is:open org:other', 'user:someone', '-repo:acme/widgets', 'is:open (owner:x)']) {
      expect(refused({ query: widening }), widening).toBe(false)
    }
    expect(refused({ query: 'label:"repo: tips"' })).toBe(true)
    expect(refused({ query: 'updated:<{yesterday}' })).toBe(false)
    expect(refused({ github: 'feishu' })).toBe(false)
    expect(refused({ id: 'Stale Issues' })).toBe(false)
    expect(scheduleKind.schema.safeParse({ entries: [STALE, STALE] }).success).toBe(false)
  })
  it('fills in the times of its placeholders and limits the search to the repository', () => {
    expect(searchQuery(STALE.query, 'acme/widgets', NOW)).toBe('is:issue is:open no:assignee updated:<2026-11-01T10:00:00Z repo:acme/widgets')
    expect(searchQuery('created:{now-1w}..{now}', 'acme/docs', NOW)).toBe('created:2026-10-27T10:00:00Z..2026-11-03T10:00:00Z repo:acme/docs')
  })
  it('counts periods from the epoch, so a day starts at 00:00 UTC', () => {
    expect(periodOf('1d', Date.parse('2026-11-03T23:59:59Z'))).toBe(periodOf('1d', Date.parse('2026-11-03T00:00:00Z')))
    expect(periodOf('1d', Date.parse('2026-11-04T00:00:00Z'))).toBe(periodOf('1d', Date.parse('2026-11-03T00:00:00Z')) + 1)
    expect(periodOf('6h', NOW)).toBe(periodOf('6h', Date.parse('2026-11-03T06:00:00Z')))
  })
})

describe('Triggers', () => {
  it('puts each hit on its Issue\'s Thread, with the entry as its actor and no person behind it', () => {
    const period = periodOf('6h', NOW)
    const trigger = scheduleTrigger('schedule', entry(), period, hit(12), new Date(NOW).toISOString())
    expect(trigger).toEqual({ id: expect.any(String), source: 'schedule', threads: [{ source: 'github', id: '12' }], actor: { source: 'schedule', id: 'stale' },
      human: false, at: '2026-11-03T10:00:00.000Z', text: 'Issues nobody took up for two days\n\nIssue #12 Issue 12',
      channel: { source: 'github', thread: 'github:12', address: { number: '12', url: 'https://github.com/acme/widgets/issues/12' } },
      url: 'https://github.com/acme/widgets/issues/12', meta: { entry: 'stale', period, query: STALE.query, github: 'github', number: 12, isPr: false } })
    expect(trigger).not.toHaveProperty('addressed')
    // One Trigger per hit, entry and period: the same hit in the next period, or of another entry, is another.
    expect(scheduleTrigger('schedule', entry(), period, hit(12), 'later').id).toBe(trigger.id)
    expect(scheduleTrigger('schedule', entry(), period + 1, hit(12), 'later').id).not.toBe(trigger.id)
    expect(scheduleTrigger('schedule', entry({ id: 'other' }), period, hit(12), 'later').id).not.toBe(trigger.id)
    // Another GitHub Source's hit is on that Source's Thread, and a PR's says so.
    const docs = scheduleTrigger('schedule', entry({ github: 'github-docs' }), period, hit(3, { pull_request: { url: 'x' } }), 'now')
    expect(docs).toMatchObject({ threads: [{ source: 'github-docs', id: '3' }], channel: { source: 'github-docs', thread: 'github-docs:3' },
      meta: { github: 'github-docs', isPr: true }, text: expect.stringContaining('PR #3') })
    expect(docs.id).not.toBe(scheduleTrigger('schedule', entry(), period, hit(3), 'now').id)
  })
})

describe('rounds', () => {
  it('fires an entry once a period, keeps its period across a restart, and fires again in the next one', async () => {
    const h = host()
    const calls = searches(() => [hit(12), hit(13)])
    await scheduleRound(h.ctx, undefined, NOW)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(0, 4)).toEqual(['api', '-X', 'GET', 'search/issues'])
    expect(query(calls[0]!)).toBe('is:issue is:open no:assignee updated:<2026-11-01T10:00:00Z repo:acme/widgets')
    expect(calls[0]).toEqual(expect.arrayContaining(['sort=updated', 'order=asc', `per_page=${MAX_HITS}`]))
    expect(await Promise.all(h.receive.mock.results.map(result => result.value))).toEqual(['stored', 'stored'])
    const triggers = h.receive.mock.calls.map(([trigger]) => trigger)
    expect(triggers.map(trigger => threadKey(trigger.threads[0]!))).toEqual(['github:12', 'github:13'])
    expect(h.store.get(KV.schedule.fired('stale'))).toEqual({ period: periodOf('6h', NOW), at: new Date(NOW).toISOString(), hits: 2 })
    // The Source names the Threads it put hits on.
    expect(h.store.threads.get('github:12')!.meta).toMatchObject({ label: '#12 Issue 12', url: 'https://github.com/acme/widgets/issues/12' })
    expect(h.health.schedule).toMatchObject({ state: 'ready', detail: '1 entries; 1 fired this period with 2 hits' })
    // Later in the same period nothing is searched.
    await scheduleRound(h.ctx, undefined, NOW + HOUR)
    expect(calls).toHaveLength(1)
    // A restart builds everything again over the same Store: still nothing in this period.
    const restarted = host({}, h.store)
    await scheduleRound(restarted.ctx, undefined, NOW + 1.5 * HOUR)
    expect(calls).toHaveLength(1)
    expect(restarted.receive).not.toHaveBeenCalled()
    // The next period searches again and takes in the same Issues once more.
    await scheduleRound(restarted.ctx, undefined, NOW + 2 * HOUR)
    expect(calls).toHaveLength(2)
    expect(await Promise.all(restarted.receive.mock.results.map(result => result.value))).toEqual(['stored', 'stored'])
    expect(h.store.read.threadTriggers('github:12', 10)).toHaveLength(2)
    h.store.close()
  })
  it('takes in a hit once a period even when the period\'s record is lost, and leaves Threads with a live ticket alone', async () => {
    const h = host()
    searches(() => [hit(12), hit(14)])
    await scheduleRound(h.ctx, undefined, NOW)
    h.store.delete(KV.schedule.fired('stale'))
    await scheduleRound(h.ctx, undefined, NOW + HOUR)
    expect(await Promise.all(h.receive.mock.results.map(result => result.value))).toEqual(['stored', 'stored', 'duplicate', 'duplicate'])
    // A ticket working on #14 keeps the next period's hit off its Thread; one only following it for context does not.
    const ticket = { id: 'ticket-14', title: '', decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'followup' },
      actor: { source: 'github', id: 'alice' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      origin: { triggerId: 'x', triggerIds: [] } } satisfies Ticket
    h.store.tickets.save(ticket)
    h.store.threads.save({ ...h.store.threads.get('github:14')!, subscriptions: [ticket.id] })
    h.store.threads.save({ ...h.store.threads.get('github:12')!, subscriptions: [ticket.id], context: [ticket.id] })
    h.receive.mockClear()
    await scheduleRound(h.ctx, undefined, NOW + 2 * HOUR)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.threads[0]!.id)).toEqual(['12'])
    expect(h.store.get(KV.schedule.fired('stale'))).toMatchObject({ hits: 1 })
    expect(h.health.schedule).toMatchObject({ detail: expect.stringContaining('1 hits on Threads with a live ticket skipped') })
    h.store.close()
  })
  it('searches each entry in its own GitHub Source\'s repository and drops hits from anywhere else', async () => {
    const h = host({ entries: [STALE, { ...STALE, id: 'docs', github: 'github-docs', query: 'is:pr review:required' }] })
    const calls = searches(q => q.endsWith('repo:acme/docs')
      ? [hit(3, { html_url: 'https://github.com/acme/docs/pull/3', repository_url: 'https://api.github.com/repos/acme/docs', pull_request: { url: '' } })]
      : [hit(12), hit(99, { repository_url: 'https://api.github.com/repos/other/repo' }), { broken: true }])
    await scheduleRound(h.ctx, undefined, NOW)
    expect(calls.map(query)).toEqual([expect.stringMatching(/ repo:acme\/widgets$/), 'is:pr review:required repo:acme/docs'])
    expect(h.receive.mock.calls.map(([trigger]) => threadKey(trigger.threads[0]!))).toEqual(['github:12', 'github-docs:3'])
    expect(h.health.schedule).toMatchObject({ detail: '2 entries; 2 fired this period with 2 hits; 1 unreadable hits skipped' })
    h.store.close()
  })
  it('runs every entry when one fails, records no period for the failed one, and forgets removed entries', async () => {
    const h = host({ entries: [{ ...STALE, id: 'broken', query: 'is:open' }, STALE, { ...STALE, id: 'off', github: 'github-archive' }] })
    h.store.set(KV.schedule.fired('removed'), { period: 1, at: '', hits: 0 })
    const calls = searches(q => q.startsWith('is:open repo') ? commandError({ stderr: 'gh: Validation Failed (HTTP 422)', code: 1 }) : [hit(12)])
    await expect(scheduleRound(h.ctx, undefined, NOW)).rejects.toThrow(/2 schedule searches failed: broken: .*HTTP 422.*; off: .*github-archive has no repository/)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.store.get(KV.schedule.fired('broken'))).toBeUndefined()
    expect(h.store.get(KV.schedule.fired('stale'))).toBeDefined()
    expect(h.store.get(KV.schedule.fired('removed'))).toBeUndefined()
    // The next round runs the failed entry again, and only it.
    await expect(scheduleRound(h.ctx, undefined, NOW + 60_000)).rejects.toThrow('broken')
    expect(calls.map(query).filter(q => q.startsWith('is:open repo'))).toHaveLength(2)
    expect(calls).toHaveLength(3)
    h.store.close()
  })
  it('stops between hits without recording the period', async () => {
    const h = host()
    searches(() => [hit(12), hit(13)])
    const controller = new AbortController()
    h.receive.mockImplementationOnce(trigger => { controller.abort(); return h.engine.receive(trigger) })
    await expect(fireEntry(h.ctx, entry(), NOW, controller.signal)).rejects.toThrow('stopped')
    expect(h.store.get(KV.schedule.fired('stale'))).toBeUndefined()
    h.store.close()
  })
})

describe('Policy', () => {
  it('admits an entry on its list as an inferred candidate, which observe mode only records as would accept', async () => {
    const h = host()
    searches(() => [hit(12)])
    await scheduleRound(h.ctx, undefined, NOW)
    expect(h.requests).toHaveLength(1)
    const candidate = h.requests[0]!
    expect(candidate).toMatchObject({ strength: 'inferred', thread: { key: 'github:12' } })
    expect(h.store.threads.get('github:12')!.evaluating).toMatchObject({ actor: { source: 'schedule', id: 'stale' },
      basis: { via: 'bot', source: 'schedule', sender: 'stale', observation: { mode: 'observe' } } })
    const trigger = candidate.triggers[0]!
    const decision = h.engine.decide(trigger.id, { ...assessmentOutcome(accept, h.store.settings(), candidate.strength), evalId: candidate.evalId })
    expect(decision).toMatchObject({ kind: 'ignore', audit: { would_accept: true, proposal: { title: 'Triage' } } })
    expect(h.store.tickets.list()).toEqual([])
    h.store.close()
  })
  it('accepts in auto mode under a matched rule, never as an explicit request, and holds the Mandate only while the entry is listed and configured', async () => {
    const h = host({ mode: 'auto' })
    searches(() => [hit(12)])
    await scheduleRound(h.ctx, undefined, NOW)
    const candidate = h.requests[0]!
    const decision = h.engine.decide(candidate.triggers[0]!.id, { ...assessmentOutcome(accept, h.store.settings(), candidate.strength), evalId: candidate.evalId })
    expect(decision.kind).toBe('accept')
    const ticket = h.store.tickets.list()[0]!
    expect(ticket.mandate).toMatchObject({ strength: 'inferred', actor: { source: 'schedule', id: 'stale' }, basis: { via: 'bot', rules: ['copy'] } })
    // Replies go to the Issue through its GitHub Source.
    expect(ticket.channels).toEqual([expect.objectContaining({ source: 'github', thread: 'github:12' })])
    const holds = (options: Options) => {
      const settings = settingsOf(options)
      const sources = new SourceRegistry(() => settings)
      sources.register(scheduleKind)
      return settingsPolicy(settings, sources).revalidate(ticket.mandate)
    }
    expect(holds({ mode: 'auto' })).toBe(true)
    expect(holds({ mode: 'observe' })).toBe(false)
    expect(holds({ mode: 'auto', listed: [] })).toBe(false)
    expect(holds({ mode: 'auto', entries: [] })).toBe(false)
    h.store.close()
  })
  it('ignores an entry off the list, and every hit while the accept mode is off', async () => {
    const cases: [Options, string][] = [[{ listed: [] }, 'not_human'], [{ mode: 'off' }, 'admission_ignored']]
    for (const [options, reason] of cases) {
      const h = host(options)
      searches(() => [hit(12)])
      await scheduleRound(h.ctx, undefined, NOW)
      expect(h.requests).toEqual([])
      expect(h.store.decisions.byThread('github:12')).toEqual([expect.objectContaining({ kind: 'ignore', reason: [expect.objectContaining({ code: reason })] })])
      h.store.close()
    }
  })
  it('filters a hit of an entry no longer configured', () => {
    const h = host({ entries: [] })
    const trigger = scheduleTrigger('schedule', entry(), 1, hit(12), new Date(NOW).toISOString())
    expect(h.engine.receive(trigger)).toBe('filtered')
    expect(h.store.triggers.disposition(trigger.id)?.filtered).toEqual({ code: 'entry_not_listed' })
    h.store.close()
  })
  it('counts its candidates toward the hourly limit of the GitHub Source whose Threads they are on', async () => {
    const h = host({ maxInferredPerHour: 1 })
    searches(() => [hit(12), hit(13)])
    await scheduleRound(h.ctx, undefined, NOW)
    expect(h.requests.map(candidate => candidate.thread.key)).toEqual(['github:12'])
    expect(h.store.decisions.byThread('github:13')).toEqual([expect.objectContaining({ kind: 'ignore',
      reason: [{ code: 'rateLimited', values: { limit: '1' } }] })])
    h.store.close()
  })
  it('validates its part of the Policy: no allowed senders, and entries whose hits may become candidates', () => {
    const { schema, fields } = scheduleKind.policy!
    expect(schema.parse({})).toEqual({ allowed: [], bots: [] })
    expect(schema.safeParse({ allowed: [{ id: 'alice' }] }).success).toBe(false)
    expect(schema.safeParse({ bots: [{ id: 'stale' }, { id: 'stale' }] }).success).toBe(false)
    expect(schema.safeParse({ bots: [{ id: 'Stale' }] }).success).toBe(false)
    expect(fields.map(field => field.key)).toEqual(['bots'])
    expect(scheduleKind.policy!.rows).toBeUndefined()
  })
})

describe('the Thread a hit is on', () => {
  it('gives assessments that GitHub Source\'s conversation of the Issue', async () => {
    const h = host()
    const gh = vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1]!.endsWith('/comments?per_page=100&page=1') ? []
      : { number: 3, title: 'Docs', body: 'The page is stale', state: 'open', id: 1, user: { login: 'carol' }, created_at: '2026-11-01T00:00:00Z',
        html_url: 'https://github.com/acme/docs/issues/3' })
    const trigger = scheduleTrigger('schedule', entry({ github: 'github-docs' }), 1, hit(3, { html_url: 'https://github.com/acme/docs/issues/3' }), 'now')
    const context = h.sources.threadContext(trigger)!
    expect(context.messageId).toBe('https://github.com/acme/docs/issues/3')
    const page = await context.read(new Commands(() => deployment, {}, new AbortController().signal), 'thread')
    expect(gh.mock.calls.map(([args]) => args[1])).toEqual(['repos/acme/docs/issues/3', 'repos/acme/docs/issues/3/comments?per_page=100&page=1'])
    expect(page.messages).toEqual([expect.objectContaining({ id: 'https://github.com/acme/docs/issues/3', from: 'carol', text: 'Docs\n\nThe page is stale' })])
    h.store.close()
  })
  it('gives a ticket from a hit that GitHub Source\'s repository and number, and lets it follow the PR it is on', () => {
    const h = host()
    const docs = scheduleTrigger('schedule', entry({ github: 'github-docs' }), 1, hit(3, { pull_request: { url: '' } }), 'now')
    const values = Object.fromEntries(environmentOf({ deployment, sources: h.sources, settings: h.store.settings(), trigger: docs })
      .map(variable => [variable.key, variable.value]))
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/docs', DSH_SUPERAGENT_GITHUB_NUMBER: '3', DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/3/head' })
    expect(h.sources.home('github', docs)).toBe('github-docs')
    // A hit on the first GitHub Source's Thread, and a Trigger of a GitHub Source itself, keep their own.
    expect(h.sources.home('github', scheduleTrigger('schedule', entry(), 1, hit(3), 'now'))).toBe('github')
    expect(h.sources.home('github', { source: 'github-docs', threads: [{ source: 'github-docs', id: '1' }] })).toBe('github-docs')
    expect(h.sources.home('github', { source: 'feishu', threads: [{ source: 'feishu', id: 'oc:om' }] })).toBe('github')
    // The ticket the hit started follows its PR on the GitHub Source of that repository.
    h.store.triggers.save(docs)
    const ticket = { id: 't', title: '', decisionId: '', mandate: { strength: 'inferred', policyVersion: '', basis: { via: 'bot', observation: { mode: 'auto' } },
      actor: { source: 'schedule', id: 'stale' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      origin: { triggerId: docs.id, triggerIds: [docs.id] } } satisfies Ticket
    h.store.tickets.save(ticket)
    const pr: Pull = { number: 3, title: 'Docs', state: 'open', html_url: 'https://github.com/acme/docs/pull/3', user: { login: 'carol' },
      head: { sha: 'abc', ref: 'fix', repo: { full_name: 'acme/docs' } } }
    const bind = vi.fn()
    const github = { ...sourceContextOf(h.deps, githubKind, 'github-docs'), tickets: { ...sourceContextOf(h.deps, githubKind, 'github-docs').tickets, bindThread: bind } }
    expect(claimPull(github, 't', pr)).toBeUndefined()
    expect(bind).toHaveBeenCalledWith('t', { source: 'github-docs', id: '3' }, false)
    expect(claimPull(sourceContextOf(h.deps, githubKind, 'github'), 't', pr)).toMatch(/does not belong/)
    h.store.close()
  })
})

describe('plugin', () => {
  it('registers the kind, waits for setup, pauses while off, fires on its tick, and turns a failure that escapes the loop into health', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const start = (overrides: Partial<SourceContextDeps>, options: Options & { enabled?: boolean } = {}) => {
      const h = host(options)
      if (options.enabled === false) h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, schedule: { kind: 'schedule', enabled: false, config: {} } } })
      // The plugin registers the kind on a registry of its own, as a Runtime's.
      const board = new HealthBoard()
      const sources = new SourceRegistry(() => h.store.settings(), board)
      sources.register(githubKind)
      const deps = { ...h.deps, sources, ...overrides }
      const disposers: (() => unknown)[] = []
      apply({ orchestrator: { sources, context: (kind: { kind: string; health: readonly string[] }, id?: string) => sourceContextOf(deps, kind, id) },
        effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      return { ...h, sources, health: board.all, stop: async () => { for (const dispose of disposers) await dispose(); h.store.close() } }
    }
    const pending = start({ configured: () => false })
    expect(pending.sources.kind('schedule')).toBe(scheduleKind)
    await vi.waitFor(() => expect(pending.health.schedule).toMatchObject({ state: 'paused', code: 'setupPending' }))
    await pending.stop()
    expect(pending.sources.kind('schedule')).toBeUndefined()
    const off = start({}, { enabled: false })
    await vi.waitFor(() => expect(off.health.schedule).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    await off.stop()
    // Failing searches report an error from the third round in a row; the period then fires once on the next good round.
    let failing = true
    const calls = searches(() => failing ? commandError({ stderr: 'gh: Bad Gateway (HTTP 502)', code: 1 }) : [hit(12)])
    const running = start({})
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(running.health.schedule).toMatchObject({ state: 'starting' })
    await vi.advanceTimersByTimeAsync(TICK_MS)
    await vi.waitFor(() => expect(running.health.schedule).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '3' } }))
    failing = false
    await vi.advanceTimersByTimeAsync(TICK_MS)
    await vi.waitFor(() => expect(running.health.schedule).toMatchObject({ state: 'ready' }))
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(calls).toHaveLength(4)
    await running.stop()
    // A failure outside a round, such as an unreadable configuration, becomes the Source's health instead of a rejection.
    const broken = start({ configured: () => { throw new Error('setup exploded') } })
    await vi.waitFor(() => expect(broken.health.schedule).toMatchObject({ state: 'error', detail: 'Error: setup exploded' }))
    await broken.stop()
  })
})
