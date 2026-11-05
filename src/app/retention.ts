/**
 * The daily prune: deletes the records the `retention` settings no longer keep, after writing them to an archive, then frees the file's
 * pages
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'
import { workerSessionId } from '../executor/dsh.ts'
import { KV, THREAD_RECORDS } from '../kv.ts'
import type { Effects } from './effects.ts'
import { instanceState } from './source-context.ts'
import type { Store } from './store.ts'

const DAY = 86_400_000
/** How long after startup the first prune runs, and how often one runs after it. */
export const PRUNE_FIRST_MS = 3_600_000, PRUNE_EVERY_MS = DAY
/** How many Threads and Tickets one transaction prunes, and how many Triggers and events; a prune yields between transactions. */
const BATCH = 2000, ROWS = 20_000

/** What one prune deleted, by table (and `kv` records), and the archive it wrote them to, when it deleted anything. */
export interface Pruned { counts: Record<string, number>; archive?: string }

/** Lines appended to one JSONL archive file, created on the first line, readable only by its owner. */
class Archive {
  private fd: number | undefined
  constructor(readonly path: string) {}
  write(table: string, rows: Record<string, unknown>[]): void {
    if (!rows.length) return
    if (this.fd === undefined) {
      mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 })
      this.fd = openSync(this.path, 'a', 0o600)
    }
    writeSync(this.fd, rows.map(row => `${JSON.stringify({ table, ...row })}\n`).join(''))
  }
  get written(): boolean { return this.fd !== undefined }
  close(): void { if (this.fd !== undefined) closeSync(this.fd) }
}
const json = (value: unknown) => JSON.parse(String(value)) as unknown

/**
 * One transaction of a prune: Threads idle since `cutoff`, with no Trigger queued, no Eval running and no open Ticket or
 * Ticket that ended since `cutoff` subscribed, and no open Ticket that follows, answers on or came from them; their Triggers
 * once no kept Thread or kept Ticket names them, with their dispositions; their Decisions that no kept Ticket came from;
 * Tickets that ended before `cutoff` that no kept Thread subscribes, with their settled outbox receipts and their Sessions'
 * prompt records; and the Source records of each pruned Thread. Each row goes to `archive` before it is deleted.
 * @returns How many rows of each table it deleted.
 */
function batch(store: Store, cutoff: string, archive: Archive): Record<string, number> {
  const { db } = store
  const all = (sql: string, ...parameters: SQLInputValue[]) => db.prepare(sql).all(...parameters)
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS prune_keep_thread (key TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS prune_keep_trigger (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS prune_thread (key TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS prune_ticket (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS prune_trigger (id TEXT PRIMARY KEY);
    DELETE FROM prune_keep_thread; DELETE FROM prune_keep_trigger; DELETE FROM prune_thread; DELETE FROM prune_ticket; DELETE FROM prune_trigger;`)
  // What open Tickets need: the Threads they follow and answer on, and the Triggers they came from or took as Inputs, with
  // those Triggers' Threads.
  const keepThread = db.prepare('INSERT OR IGNORE INTO prune_keep_thread VALUES (?)')
  const keepTrigger = db.prepare('INSERT OR IGNORE INTO prune_keep_trigger VALUES (?)')
  for (const ticket of store.tickets.open()) {
    for (const thread of [...(ticket.follows ?? []).map(follow => follow.thread), ...ticket.channels.map(channel => channel.thread)]) keepThread.run(thread)
    for (const id of [...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => 'triggerId' in input ? [input.triggerId] : [])]) keepTrigger.run(id)
  }
  db.exec('INSERT OR IGNORE INTO prune_keep_thread SELECT x.thread FROM trigger_thread x JOIN prune_keep_trigger k ON k.id = x.id')
  db.prepare(`INSERT INTO prune_thread SELECT t.key FROM thread t WHERE t.active IS NULL
      AND COALESCE(t.value ->> '$.lastAt', t.value ->> '$.createdAt') < ?
      AND t.key NOT IN (SELECT key FROM prune_keep_thread)
      AND NOT EXISTS (SELECT 1 FROM json_each(t.value, '$.subscriptions') s JOIN ticket k ON k.id = s.value
        WHERE k.open = 1 OR k.value ->> '$.ended.at' >= ?)
    LIMIT ?`).run(cutoff, cutoff, BATCH)
  // A Ticket a kept Thread subscribes stays, so no kept Thread names a Ticket that is gone.
  db.prepare(`INSERT INTO prune_ticket SELECT k.id FROM ticket k WHERE k.open IS NULL AND k.value ->> '$.ended.at' < ?
      AND k.id NOT IN (SELECT s.value FROM thread t INDEXED BY thread_subscribed, json_each(t.value, '$.subscriptions') s
        WHERE t.subscribed IS NOT NULL AND t.key NOT IN (SELECT key FROM prune_thread))
    LIMIT ?`).run(cutoff, BATCH)
  // A kept Ticket keeps the Triggers it came from or took, and the Decision it came from.
  db.exec(`INSERT OR IGNORE INTO prune_keep_trigger SELECT j.value FROM ticket k, json_each(k.value, '$.origin.triggerIds') j
      WHERE k.id NOT IN (SELECT id FROM prune_ticket);
    INSERT OR IGNORE INTO prune_keep_trigger SELECT i.value ->> '$.triggerId' FROM ticket k, json_each(k.value, '$.inputs') i
      WHERE k.id NOT IN (SELECT id FROM prune_ticket) AND i.value ->> '$.triggerId' IS NOT NULL`)
  // A Trigger goes once every Thread it is on is gone, or never had a record, as one its Source filtered.
  db.prepare(`INSERT INTO prune_trigger SELECT t.id FROM trigger t WHERE t.at < ?
      AND NOT EXISTS (SELECT 1 FROM trigger_thread x JOIN thread h ON h.key = x.thread
        WHERE x.id = t.id AND x.thread NOT IN (SELECT key FROM prune_thread))
      AND t.id NOT IN (SELECT id FROM prune_keep_trigger)
    LIMIT ?`).run(cutoff, ROWS)
  const counts: Record<string, number> = {}
  const take = (table: string, select: string, del: string, map: (row: Record<string, SQLInputValue>) => Record<string, unknown>,
    ...parameters: SQLInputValue[]) => {
    const rows = all(select, ...parameters)
    archive.write(table, rows.map(map))
    db.prepare(del).run(...parameters)
    if (rows.length) counts[table] = (counts[table] ?? 0) + rows.length
    return rows
  }
  const row = (name: string) => (item: Record<string, SQLInputValue>) => ({ [name]: item[name], value: json(item.value) })
  const threads = take('thread', 'SELECT key, value FROM thread WHERE key IN (SELECT key FROM prune_thread)',
    'DELETE FROM thread WHERE key IN (SELECT key FROM prune_thread)', row('key'))
  take('decision', `SELECT id, value FROM decision d WHERE (d.thread IN (SELECT key FROM prune_thread)
      OR (d.value ->> '$.at' < ? AND NOT EXISTS (SELECT 1 FROM thread h WHERE h.key = d.thread)))
      AND d.id NOT IN (SELECT k.value ->> '$.decisionId' FROM ticket k WHERE k.id NOT IN (SELECT id FROM prune_ticket)
        AND k.value ->> '$.decisionId' IS NOT NULL)`,
  `DELETE FROM decision WHERE id IN (SELECT id FROM decision d WHERE (d.thread IN (SELECT key FROM prune_thread)
      OR (d.value ->> '$.at' < ? AND NOT EXISTS (SELECT 1 FROM thread h WHERE h.key = d.thread)))
      AND d.id NOT IN (SELECT k.value ->> '$.decisionId' FROM ticket k WHERE k.id NOT IN (SELECT id FROM prune_ticket)
        AND k.value ->> '$.decisionId' IS NOT NULL))`, row('id'), cutoff)
  take('trigger', 'SELECT id, value FROM trigger WHERE id IN (SELECT id FROM prune_trigger)',
    'DELETE FROM trigger WHERE id IN (SELECT id FROM prune_trigger)', row('id'))
  take('disposition', 'SELECT id, value FROM disposition WHERE id IN (SELECT id FROM prune_trigger)',
    'DELETE FROM disposition WHERE id IN (SELECT id FROM prune_trigger)', row('id'))
  db.exec('DELETE FROM trigger_thread WHERE id IN (SELECT id FROM prune_trigger)')
  const tickets = take('ticket', 'SELECT id, value FROM ticket WHERE id IN (SELECT id FROM prune_ticket)',
    'DELETE FROM ticket WHERE id IN (SELECT id FROM prune_ticket)', row('id'))
  // A receipt keeps a message from being queued twice; once its Ticket or its Thread is gone, nothing queues its id again.
  // One that still waits, or still has a `reply` effect, stays.
  const receipts = `FROM outbox o WHERE o.value ->> '$.status' <> 'pending'
    AND NOT EXISTS (SELECT 1 FROM effect e WHERE e.kind = 'reply' AND e.key = o.id)
    AND (o.value ->> '$.ticketId' IN (SELECT id FROM prune_ticket)
      OR (o.value ->> '$.ticketId' IS NULL AND o.value ->> '$.channel.thread' IN (SELECT key FROM prune_thread)))`
  take('outbox', `SELECT o.id, o.value ${receipts}`, `DELETE FROM outbox WHERE id IN (SELECT o.id ${receipts})`, row('id'))
  // The Source records of each pruned Thread, under its Source instance's prefix, and the prompt records of each pruned
  // Ticket's Session.
  const sources = store.settings().sources
  const names = threads.flatMap(item => {
    const ref = (json(item.value) as { ref: { source: string; id: string } }).ref
    const kind = sources[ref.source]?.kind ?? ref.source
    const prefix = instanceState(kind, ref.source)
    return THREAD_RECORDS.filter(record => record.kind === kind)
      .map(record => `${prefix}${record.prefix}${record.by === 'key' ? String(item.key) : ref.id}`)
  })
  names.push(...tickets.map(item => KV.sessions.prompts(workerSessionId(String(item.id)))))
  deleteKeys(store, archive, names, counts)
  return counts
}
/** Deletes the `kv` records named, writing those that exist to the archive first. */
function deleteKeys(store: Store, archive: Archive, names: string[], counts: Record<string, number>): void {
  const found = names.flatMap(name => { const value = store.get<unknown>(name); return value === undefined ? [] : [{ key: name, value }] })
  archive.write('kv', found)
  for (const { key } of found) store.delete(key)
  if (found.length) counts.kv = (counts.kv ?? 0) + found.length
}
/**
 * The settings and prompt versions beyond the newest `settings` and `prompts`: never the current one, nor a prompt version
 * that a Session works under now.
 */
function oldVersions(store: Store, settings: number, prompts: number): string[] {
  const numbered = (prefix: string) => store.keys(prefix).map(name => ({ name, revision: Number(name.slice(prefix.length)) }))
    .filter(item => Number.isInteger(item.revision))
  const settingsRevision = store.get(KV.settings.revision) ?? 0, promptRevision = store.get(KV.prompts.revision) ?? 0
  const active = new Set(store.keys(KV.sessions.prompts).flatMap(name => store.get(name)?.at(-1) ?? []))
  return [...numbered(KV.settings.version.prefix).filter(item => item.revision <= settingsRevision - settings),
    ...numbered(KV.prompts.version.prefix).filter(item => item.revision <= promptRevision - prompts && !active.has(item.revision))]
    .map(item => item.name)
}
/**
 * Returns the file's free pages to the file system: incrementally once the database is in incremental `auto_vacuum` mode,
 * which a new database starts in; an older one takes the mode with one full `VACUUM`, run after its first prune made it
 * small. Then truncates the write-ahead log.
 */
export function vacuum(store: Store, report: (error: unknown) => void = () => {}): void {
  const { db } = store
  try {
    if (Number(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum) === 2) db.prepare('PRAGMA incremental_vacuum').all()
    else db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM')
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
  } catch (error) { report(error) }
}
/**
 * Prunes what the `retention` settings no longer keep, as of `now`: Threads, Triggers, dispositions, Decisions, ended
 * Tickets, settled outbox receipts and their Source and Session records past `retention.days` (see `batch`), events older
 * than that, and settings and prompt versions beyond the newest `retention.settingsVersions` and `retention.promptVersions`.
 * Everything it deletes goes first to `<stateDir>/archive/prune-<time>.jsonl`, one row per line. It works in transactions
 * of a bounded size and yields between them, then vacuums.
 */
export async function prune(store: Store, stateDir: string, now = Date.now(), report?: (error: unknown) => void): Promise<Pruned> {
  const { days, settingsVersions, promptVersions } = store.settings().retention
  const cutoff = new Date(now - days * DAY).toISOString()
  const archive = new Archive(join(stateDir, 'archive', `prune-${new Date(now).toISOString().replace(/[:.]/g, '-')}.jsonl`))
  const counts: Record<string, number> = {}
  const add = (more: Record<string, number>) => { for (const [table, count] of Object.entries(more)) counts[table] = (counts[table] ?? 0) + count }
  try {
    for (;;) {
      const done = store.atomic(() => batch(store, cutoff, archive))
      add(done)
      if (!Object.keys(done).length) break
      await new Promise(resolve => setImmediate(resolve))
    }
    for (;;) {
      const done = store.atomic(() => {
        const rows = store.db.prepare('SELECT seq, type, at, data FROM event WHERE at < ? ORDER BY seq LIMIT ?').all(cutoff, ROWS)
        archive.write('event', rows.map(item => ({ seq: item.seq, type: item.type, at: item.at, data: json(item.data) })))
        if (rows.length) store.db.prepare('DELETE FROM event WHERE seq <= ? AND at < ?').run(Number(rows.at(-1)!.seq), cutoff)
        return rows.length
      })
      if (done) add({ event: done })
      if (done < ROWS) break
      await new Promise(resolve => setImmediate(resolve))
    }
    store.atomic(() => { const more: Record<string, number> = {}; deleteKeys(store, archive, oldVersions(store, settingsVersions, promptVersions), more); add(more) })
  } finally { archive.close() }
  if (archive.written) vacuum(store, report)
  return { counts, ...archive.written ? { archive: archive.path } : {} }
}
/**
 * Has the effect queue prune every day: the `prune` effect prunes, then queues itself again a day later. Queues the first
 * prune an hour from now unless one waits.
 */
export function schedulePrune(effects: Effects, store: Store, stateDir: string, report: (error: unknown) => void): void {
  // A prune that failed tries again after a minute, then less often, up to every hour.
  effects.handle('prune', async () => {
    await prune(store, stateDir, Date.now(), report)
    effects.enqueue('prune', 'daily', {}, Date.now() + PRUNE_EVERY_MS)
  }, { retry: [60_000, 3_600_000] })
  if (!effects.pending('prune', 'daily')) effects.enqueue('prune', 'daily', {}, Date.now() + PRUNE_FIRST_MS)
}
