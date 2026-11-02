/**
 * The on-disk state the fake `gh` and `lark-cli` share with the e2e harness: one JSON document per fake, guarded by a
 * directory lock, an append-only log of every invocation (`calls.jsonl`) and of every write (`writes.jsonl`).
 *
 * This file runs under Node's type stripping (the fakes are executed as `node gh.ts`), so it uses only erasable syntax.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCK_WAIT_MS = 10_000
const STALE_LOCK_MS = 30_000

function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Runs `body` while holding `<dir>/state.lock`; a lock older than 30 s is taken over (a fake was killed mid-write). */
export function withLock<T>(dir: string, body: () => T): T {
  const lock = join(dir, 'state.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { mkdirSync(lock); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) { rmdirSync(lock); continue } } catch { continue }
      if (Date.now() > deadline) throw new Error(`fake state lock ${lock} is held`)
      sleep(10)
    }
  }
  try { return body() } finally { rmdirSync(lock) }
}

export function readState<T>(dir: string): T {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as T
}
export function writeState(dir: string, state: unknown): void {
  const file = join(dir, 'state.json')
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(state, null, 2))
  renameSync(`${file}.${process.pid}.tmp`, file)
}
/** Reads, changes and writes the state under the lock; `change` may mutate the state and return a result. */
export function update<T, R>(dir: string, change: (state: T) => R): R {
  return withLock(dir, () => {
    const state = readState<T>(dir)
    const result = change(state)
    writeState(dir, state)
    return result
  })
}
export function appendLog(dir: string, name: 'calls' | 'writes', entry: Record<string, unknown>): void {
  appendFileSync(join(dir, `${name}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}
export function readLog<T = Record<string, unknown>>(dir: string, name: 'calls' | 'writes'): T[] {
  const file = join(dir, `${name}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
}
