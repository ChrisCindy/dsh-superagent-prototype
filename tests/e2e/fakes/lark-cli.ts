/**
 * A `lark-cli`-compatible stub for the e2e harness, configured as a bot-only app in strict mode `bot`. It answers the
 * setup checks, the chat list, history and message reads from `$SAE2E_LARK_STATE/state.json` (empty by default), records
 * sends in `writes.jsonl`, and runs `event consume` as a long-lived consumer that prints `[event] ready` and then emits each
 * line the harness appends to `events.jsonl`. Erasable syntax only (see store.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LarkWorld } from './lark-world.ts'
import { appendLog, readState } from './store.ts'

function run(dir: string, argv: string[]): number {
  const world = readState<LarkWorld>(dir)
  const out = (data: unknown) => { process.stdout.write(JSON.stringify({ ok: true, data }) + '\n'); return 0 }
  const words = argv.filter(arg => !arg.startsWith('--'))
  const [group, verb, third] = words
  appendLog(dir, 'calls', { argv })
  if (group === 'auth' && verb === 'status') {
    process.stdout.write(JSON.stringify({ appId: world.appId, brand: 'feishu', identities: { bot: { status: 'ready' } } }) + '\n')
    return 0
  }
  if (group === 'config' && verb === 'strict-mode') { process.stdout.write(`strict-mode: ${world.strictMode}\n`); return 0 }
  if (group === 'api' && verb === 'GET' && third === '/open-apis/bot/v3/info') {
    process.stdout.write(JSON.stringify({ code: 0, bot: { open_id: world.botOpenId, app_name: world.botName } }) + '\n')
    return 0
  }
  if (group === 'api' && verb === 'GET' && third === '/open-apis/im/v1/messages') return out({ items: [], has_more: false })
  if (group === 'api' && verb === 'GET' && third?.startsWith('/open-apis/im/v1/chats/')) return out({ items: [], has_more: false })
  if (group === 'im' && verb === '+chat-list') return out({ chats: world.chats })
  if (group === 'im' && verb === '+messages-mget') return out({ messages: [] })
  if (group === 'im' && (verb === '+messages-reply' || verb === '+messages-send')) {
    appendLog(dir, 'writes', { kind: verb.slice(1), argv })
    return out({ message_id: `om_e2e${Date.now()}` })
  }
  if (group === 'event' && verb === 'consume') return consume(dir)
  appendLog(dir, 'calls', { argv, unknown: true })
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 99991, message: `fake lark-cli: ${words.join(' ')} is not supported` } }) + '\n')
  return 1
}

/** Prints `[event] ready` on stderr, then streams new lines of events.jsonl to stdout until stdin closes or a signal arrives. */
function consume(dir: string): number {
  const file = join(dir, 'events.jsonl')
  let offset = existsSync(file) ? readFileSync(file).length : 0
  process.stderr.write('[event] ready event_key=im.message.receive_v1 (fake)\n')
  const timer = setInterval(() => {
    const data = readFileSync(file)
    if (data.length > offset) { process.stdout.write(data.subarray(offset)); offset = data.length }
  }, 200)
  const stop = () => { clearInterval(timer); process.exit(0) }
  process.stdin.on('end', stop); process.stdin.resume()
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  return 0
}

const dir = process.env.SAE2E_LARK_STATE
if (!dir) { process.stderr.write('fake lark-cli: SAE2E_LARK_STATE is not set\n'); process.exit(2) }
process.exitCode = run(dir, process.argv.slice(2))
