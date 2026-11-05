/** The daily prune: what it deletes and keeps, its archive, the freed pages, and how a pruned Thread's next message is handled. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Prompts, defaultPrompts } from '../src/app/prompts.ts'
import { prune } from '../src/app/retention.ts'
import { UserError, type Decision, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

const DAY = 86_400_000
let directory: string
let h: Host | undefined
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'retention-')) })
afterEach(async () => { await h?.stop(); h = undefined; rmSync(directory, { recursive: true, force: true }) })

const iso = (ms: number) => new Date(ms).toISOString()
const trigger = (id: string, thread: string, at: string): Trigger => ({ id, source: 'github', threads: [{ source: 'github', id: thread }],
  actor: { source: 'github', id: 'alice' }, human: true, at, text: `message ${id}`, meta: {} })
const thread = (id: string, at: string, subscriptions: string[] = []): Thread => ({ key: `github:${id}`, ref: { source: 'github', id }, createdAt: at,
  lastAt: at, subscriptions, correlated: [], pending: [], meta: {} })
const ticket = (id: string, origin: string, at: string, ended?: string): Ticket => ({ id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: origin, triggerIds: [origin] },
  ...ended ? { ended: { at: ended, by: 'executor' as const, outcome: 'done' as const } } : {} } as Ticket)
const decision = (id: string, threadKey: string, triggerId: string, at: string, ticketId?: string) => ({ id, evalId: `e-${id}`, threadKey,
  triggerIds: [triggerId], policyVersion: '', at, kind: ticketId ? 'accept' : 'ignore', reason: [], strength: 'explicit', ...ticketId ? { ticketId } : {} }) as Decision
const count = (store: Store, table: string) => Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n)

/** Old work on Thread `n`: a Trigger, its disposition, a Decision, a Ticket that ended, a sent message and its Source and Session records. */
function oldWork(store: Store, n: number, at: string): void {
  const id = String(n)
  store.triggers.save(trigger(`t${id}`, id, at))
  store.triggers.saveDisposition(`t${id}`, { decided: `d-k${id}`, at } as never)
  store.decisions.save(decision(`d-k${id}`, `github:${id}`, `t${id}`, at, `k${id}`))
  store.tickets.save(ticket(`k${id}`, `t${id}`, at, at))
  store.threads.save(thread(id, at, [`k${id}`]))
  store.db.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run(`m${id}`, JSON.stringify({ id: `m${id}`, ticketId: `k${id}`, status: 'sent',
    channel: { source: 'github', thread: `github:${id}` }, text: 'done' }))
  store.set(KV.github.cursor(n), at)
  store.set(KV.sessions.prompts(`worker-k${id}`), [1])
  store.events.append({ type: 'ticket.ended', at, data: { ticketId: `k${id}` } } as never)
}

it('prunes a large database past the window into an archive, keeps live and recent work, and frees the pages', async () => {
  const path = join(directory, 'orchestrator.sqlite')
  // A database an earlier version made, before new ones freed pages on request.
  const old = new DatabaseSync(path)
  old.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); old.close()
  const store = new Store(path)
  expect(Number(store.db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum)).toBe(0)
  const now = Date.parse('2026-06-01T00:00:00Z'), long = iso(now - 200 * DAY), recent = iso(now - 3 * DAY)
  store.atomic(() => { for (let n = 1; n <= 3000; n++) oldWork(store, n, long) })
  // An open Ticket on an old Thread, and a Ticket that ended lately on another: both Threads, and what they name, stay.
  store.triggers.save(trigger('live', '5001', long)); store.tickets.save(ticket('open', 'live', long)); store.threads.save(thread('5001', long, ['open']))
  store.triggers.save(trigger('late', '5002', long)); store.tickets.save(ticket('ended', 'late', long, recent))
  store.threads.save(thread('5002', long, ['ended']))
  // A Thread with a Trigger queued stays however old.
  store.threads.save({ ...thread('5003', long), pending: ['queued'] })
  store.set(KV.github.cursor(5001), long)
  store.events.append({ type: 'ticket.ended', at: recent, data: {} } as never)
  // Settings and prompt versions beyond the newest ten, but not the one a Session works under.
  for (let n = 0; n < 15; n++) store.saveSettings({ ...store.settings(), paused: n % 2 === 1 }, { source: 'panel', block: 'pause', policyVersion: '', policyChanged: false, notified: [] })
  store.saveSettings({ ...store.settings(), retention: { days: 30, settingsVersions: 10, promptVersions: 10 } })
  const prompts = new Prompts(store, () => 100_000, () => undefined, () => ['feishu', 'github'])
  for (let n = 0; n < 15; n++) prompts.save({ ...defaultPrompts(), scope: `Scope ${n}` }, n, 'panel')
  store.set(KV.sessions.prompts('main'), [2])
  const before = statSync(path).size

  const { counts, archive } = await prune(store, directory, now)
  expect(counts).toMatchObject({ thread: 3000, trigger: 3000, disposition: 3000, decision: 3000, ticket: 3000, outbox: 3000, event: 3000 })
  // Per Thread its cursor and its Ticket's Session record; then the settings and prompt versions beyond the newest ten.
  const settingsRevision = store.get(KV.settings.revision)!
  expect(store.keys(KV.settings.version.prefix)).toHaveLength(10)
  // The prompt versions 0 (the built-in baseline) to 5 but 2.
  expect(counts.kv).toBe(6000 + settingsRevision - 10 + 5)
  expect(['5001', '5002', '5003'].map(id => !!store.threads.get(`github:${id}`))).toEqual([true, true, true])
  expect(['open', 'ended'].map(id => !!store.tickets.get(id))).toEqual([true, true])
  expect(['live', 'late'].map(id => !!store.triggers.get(id))).toEqual([true, true])
  expect(store.get(KV.github.cursor(5001))).toBe(long)
  expect(count(store, 'event')).toBe(1)
  expect(store.get(KV.prompts.version(2))).toBeDefined()
  expect(prompts.history(0, 50).revisions.map(version => version.revision)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6])
  expect(prompts.history(0, 10).next_offset).toBeNull()
  expect(store.settingsHistory(50).map(version => version.revision).at(-1)).toBe(settingsRevision - 9)

  // Every row went to the archive before it was deleted.
  const lines = readFileSync(archive!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { table: string })
  expect(lines).toHaveLength(Object.values(counts).reduce((sum, n) => sum + n, 0))
  expect(lines.find(line => line.table === 'ticket')).toMatchObject({ id: 'k1', value: { origin: { triggerId: 't1' } } })
  expect(statSync(archive!).mode & 0o777).toBe(0o600)
  // The first prune took the incremental mode with one VACUUM, which gave the pages back.
  expect(Number(store.db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum)).toBe(2)
  expect(statSync(path).size).toBeLessThan(before / 2)
  // A second prune finds nothing and writes no archive.
  expect(await prune(store, directory, now)).toEqual({ counts: {} })
  store.close()
})

it('handles a new message on a pruned Thread as a new message, and leaves a live Ticket as it was', async () => {
  h = await startRuntime()
  const followup = (id: string, root: string, text: string) => feishu(id, text, { mentions: [], root_id: root })
  const done = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(done.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
  const live = await h.acceptedTicket(feishu('2', '@bot 另一件事'))
  const store = h.runtime.store
  const pruned = `feishu:${CHAT}:om_1`
  const created = store.threads.get(pruned)!.createdAt
  const { counts } = await prune(store, h.directory, Date.now() + 200 * DAY)
  expect(counts).toMatchObject({ ticket: 1, thread: 1 })
  expect(store.tickets.get(done.ticket.id)).toBeUndefined()
  expect(store.threads.get(pruned)).toBeUndefined()
  expect(store.tickets.get(live.ticket.id)).toMatchObject({ id: live.ticket.id })
  expect(store.triggers.get(live.trigger.id)).toBeDefined()

  // Before the prune this message would have resumed the ended Ticket; now it starts an Eval on a new Thread.
  h.deliveries.mockClear()
  const message = followup('3', 'om_1', '再改一下标题')
  h.runtime.receive(message); await h.runtime.idle()
  expect(h.candidates()).toEqual([message.id])
  expect(store.threads.get(pruned)!.createdAt >= created).toBe(true)
  expect(store.threads.get(pruned)!.subscriptions).toEqual([])

  // A follow-up on the live Ticket's Thread still reaches its worker without an Eval.
  h.deliveries.mockClear()
  const more = followup('4', 'om_2', '顺便把标题也改了')
  h.runtime.receive(more); await h.runtime.idle()
  expect(h.relays(live.sessionId)).toEqual([expect.objectContaining({ trigger_id: more.id })])
  expect(h.candidates()).toEqual([])
})

it('queues the daily prune at start, and lets the panel alone save the retention block, without a notice to the main Session', async () => {
  h = await startRuntime()
  const { settings, store, effects } = h.runtime
  expect(effects.pending('prune', 'daily')).toBe(true)
  const value = { days: 30, settingsVersions: 50, promptVersions: 50 }
  await expect(settings.save('retention', value, store.blockRevision('retention'), 'tool'))
    .rejects.toThrow(new UserError('unknownBlock', { block: 'retention' }))
  await expect(settings.save('retention', { ...value, days: 14 }, store.blockRevision('retention'), 'panel')).rejects.toThrow()
  await h.runtime.idle()
  const notices = effects.pending('notice')
  expect(await settings.save('retention', value, store.blockRevision('retention'), 'panel')).toMatchObject({ saved: true, policy_changed: false })
  expect(store.settings().retention).toEqual(value)
  expect(effects.pending('notice')).toBe(notices)
})
