/**
 * A code-host adapter (docs/010, contract version 1) for the e2e harness, run as `codehost-adapter <operation> '<request JSON>'`. It
 * answers describe, whoami, repository, events, thread, comments and comment from `$SAE2E_CODEHOST_STATE/state.json`, and git's
 * `git-credential get` with a fake credential. Every call goes to `calls.jsonl`, every posted comment to `writes.jsonl`; an operation
 * it does not answer fails with 501 and is marked `unknown`. Erasable syntax only (see store.ts).
 */
import type { ChComment, CodehostWorld } from './codehost-world.ts'
import { threadKey } from './codehost-world.ts'
import { appendLog, readState, update } from './store.ts'

const PAGE = 50

function fail(code: number, message: string): never {
  process.stderr.write(JSON.stringify({ error: { code, message } }) + '\n')
  process.exit(1)
}

function answer(dir: string, operation: string, request: Record<string, any>): unknown {
  const world = readState<CodehostWorld>(dir)
  const sameRepository = () => { if (request.repository !== world.repository.path) fail(404, `no repository ${String(request.repository)}`) }
  switch (operation) {
    case 'describe': return { contractVersion: 1, capabilities: world.capabilities, name: 'sae2e fake adapter' }
    case 'whoami': return world.agent
    case 'repository': sameRepository(); return world.repository
    case 'events': {
      sameRepository()
      // The first call starts at now, as the contract asks; later ones page through the log by index.
      if (request.cursor === null) return { events: [], cursor: String(world.events.length), more: false }
      const start = Number(request.cursor)
      const events = world.events.slice(start, start + PAGE)
      return { events, cursor: String(start + events.length), more: start + events.length < world.events.length }
    }
    case 'thread': {
      sameRepository()
      return world.threads[threadKey(request.type, request.number)] ?? fail(404, `no ${String(request.type)} ${String(request.number)}`)
    }
    case 'comments': {
      sameRepository()
      if (!world.threads[threadKey(request.type, request.number)]) fail(404, `no ${String(request.type)} ${String(request.number)}`)
      return { comments: world.comments[threadKey(request.type, request.number)] ?? [], cursor: null }
    }
    case 'comment': {
      sameRepository()
      return update<CodehostWorld, ChComment>(dir, state => {
        const key = threadKey(request.type, request.number)
        const thread = state.threads[key] ?? fail(404, `no ${String(request.type)} ${String(request.number)}`)
        const known = (state.comments[key] ?? []).find(comment => comment.key === request.key)
        if (known) return known
        const id = String(state.nextId++)
        const comment: ChComment = { id, author: { login: state.agent.login, id: state.agent.id, bot: false }, body: String(request.body),
          url: `${thread.url}#note_${id}`, createdAt: new Date().toISOString(), key: String(request.key) }
        ;(state.comments[key] ??= []).push(comment)
        appendLog(dir, 'writes', { kind: 'comment', type: request.type, number: request.number, body: comment.body, key: request.key,
          replyTo: request.replyTo ?? null })
        return comment
      })
    }
    default: return undefined
  }
}

const dir = process.env.SAE2E_CODEHOST_STATE
if (!dir) fail(500, 'SAE2E_CODEHOST_STATE is not set')
const [operation = '', json = '{}'] = process.argv.slice(2)
if (operation === 'git-credential') {
  appendLog(dir, 'calls', { operation, action: process.argv[3] })
  if (process.argv[3] === 'get') process.stdout.write('username=widgets-agent\npassword=sae2e-fake-code-host-credential\n')
} else {
  const request = JSON.parse(json) as Record<string, any>
  const known = ['describe', 'whoami', 'repository', 'events', 'thread', 'comments', 'comment'].includes(operation)
  appendLog(dir, 'calls', { operation, request, ...known ? {} : { unknown: true } })
  if (!known) fail(501, `not implemented: ${operation}`)
  process.stdout.write(JSON.stringify(answer(dir, operation, request)) + '\n')
}
