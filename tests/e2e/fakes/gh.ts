/**
 * A `gh`-compatible stub for the e2e harness. It never touches the network: it answers the subcommands dsh-superagent and
 * its scripted Sessions use from the JSON world in `$SAE2E_GH_STATE` (see github-world.ts), records every invocation in
 * `calls.jsonl` and every write (comments, pull request operations) in `writes.jsonl`. A request it does not know fails
 * as GitHub's 404 does and is logged with `unknown: true`, so a harness can assert that the bundle used nothing unexpected.
 *
 * Run as `node gh.ts <gh arguments>`; the harness writes a wrapper script that sets the state directory.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { addComment, apiUrl, pageUrl, type GhComment, type GithubWorld } from './github-world.ts'
import { appendLog, readState, update } from './store.ts'

const dir = process.env.SAE2E_GH_STATE
if (!dir) { process.stderr.write('fake gh: SAE2E_GH_STATE is not set\n'); process.exit(2) }
const argv = process.argv.slice(2)

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
interface Request {
  method: string; path: string; query: URLSearchParams; fields: Record<string, string>
  include: boolean; paginate: boolean; slurp: boolean; jq?: string | undefined; headers: string[]
}
function parseApi(args: string[]): Request {
  let method = '', target = ''
  const fields: Record<string, string> = {}, headers: string[] = []
  let include = false, paginate = false, slurp = false, jq: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const value = () => args[++index] ?? ''
    if (arg === '-X' || arg === '--method') method = value().toUpperCase()
    else if (arg === '-f' || arg === '-F' || arg === '--raw-field' || arg === '--field') {
      const field = value(); const at = field.indexOf('=')
      fields[field.slice(0, at)] = field.slice(at + 1)
    } else if (arg === '-H' || arg === '--header') headers.push(value())
    else if (arg === '-i' || arg === '--include') include = true
    else if (arg === '--paginate') paginate = true
    else if (arg === '--slurp') slurp = true
    else if (arg === '-q' || arg === '--jq') jq = value()
    else if (arg === '--input') Object.assign(fields, JSON.parse(readFileSync(value(), 'utf8')) as Record<string, string>)
    else if (!arg.startsWith('-') && !target) target = arg
  }
  const url = new URL(target.replace(/^\//, ''), 'https://api.github.invalid/')
  return { method: method || (Object.keys(fields).length ? 'POST' : 'GET'), path: url.pathname.slice(1), query: url.searchParams,
    fields, include, paginate, slurp, jq, headers }
}

const now = () => new Date().toISOString()
const since = (items: GhComment[], query: URLSearchParams) => {
  const from = query.get('since')
  return from ? items.filter(item => Date.parse(item.updated_at) >= Date.parse(from)) : items
}
function issueOf(world: GithubWorld, number: string) {
  const issue = world.issues[number]
  if (!issue) throw new HttpError(404, 'Not Found')
  return issue
}

/** Answers one REST request; returns the JSON body. Writes mutate `world` and are logged by the caller. */
function route(world: GithubWorld, request: Request, write: (entry: Record<string, unknown>) => void): unknown {
  const { method, path, query, fields } = request
  if (path === 'user') {
    if (!world.signedIn) throw new HttpError(401, 'Requires authentication')
    return world.agent
  }
  let match = /^users\/([^/]+)$/.exec(path)
  if (match) { const user = world.users[match[1]!]; if (!user) throw new HttpError(404, 'Not Found'); return user }
  match = /^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(path)
  if (!match || match[1]!.toLowerCase() !== world.repository.full_name.toLowerCase()) throw new HttpError(404, 'Not Found')
  const rest = match[2] ?? ''
  const repo = world.repository
  const is = (verb: string, pattern: RegExp) => method === verb ? pattern.exec(rest) : null
  if (rest === '' && method === 'GET') {
    return { full_name: repo.full_name, name: repo.full_name.split('/')[1], default_branch: repo.default_branch,
      permissions: { admin: false, push: repo.push, pull: true }, html_url: `https://github.com/${repo.full_name}` }
  }
  if (is('GET', /^notifications$/)) {
    const from = query.get('since')
    return world.notifications.filter(item => !from || Date.parse(item.updated_at) >= Date.parse(from))
  }
  if ((match = is('GET', /^issues\/(\d+)$/))) return issueOf(world, match[1]!)
  if ((match = is('GET', /^issues\/(\d+)\/comments$/))) { issueOf(world, match[1]!); return since(world.comments[match[1]!] ?? [], query) }
  if ((match = is('POST', /^issues\/(\d+)\/comments$/))) {
    const number = Number(match[1]); issueOf(world, match[1]!)
    const comment = addComment(world, number, world.agent.login, fields.body ?? '')
    write({ kind: 'comment', number, id: comment.id, body: comment.body })
    return comment
  }
  if ((match = is('PATCH', /^issues\/comments\/(\d+)$/))) {
    const comment = Object.values(world.comments).flat().find(item => item.id === Number(match![1]))
    if (!comment) throw new HttpError(404, 'Not Found')
    comment.body = fields.body ?? comment.body; comment.updated_at = now()
    write({ kind: 'comment-edit', id: comment.id, body: comment.body })
    return comment
  }
  if (is('GET', /^issues$/)) return Object.values(world.issues).filter(issue => !query.get('since') || issue.updated_at >= query.get('since')!)
  if (is('GET', /^issues\/comments$/)) return since(Object.values(world.comments).flat(), query)
  if (is('GET', /^pulls\/comments$/)) return since(Object.values(world.reviewComments).flat(), query)
  if ((match = is('GET', /^pulls\/comments\/(\d+)$/))) {
    const comment = Object.values(world.reviewComments).flat().find(item => item.id === Number(match![1]))
    if (!comment) throw new HttpError(404, 'Not Found')
    return comment
  }
  if ((match = is('GET', /^pulls\/(\d+)$/))) {
    const pull = world.pulls[match[1]!]
    if (!pull) throw new HttpError(404, 'Not Found')
    return pull
  }
  if ((match = is('GET', /^pulls\/(\d+)\/comments$/))) return since(world.reviewComments[match[1]!] ?? [], query)
  if ((match = is('GET', /^pulls\/(\d+)\/reviews$/))) return world.reviews[match[1]!] ?? []
  if ((match = is('POST', /^pulls\/(\d+)\/comments\/(\d+)\/replies$/))) {
    const id = world.nextId++
    const comment = { id, body: fields.body ?? '', user: world.agent, html_url: `${pageUrl(world, Number(match[1]), true)}#discussion_r${id}`,
      created_at: now(), updated_at: now(), in_reply_to_id: Number(match[2]) }
    ;(world.reviewComments[match[1]!] ??= []).push(comment)
    write({ kind: 'review-reply', number: Number(match[1]), inReplyTo: Number(match[2]), id, body: comment.body })
    return comment
  }
  if (is('GET', /^pulls$/)) return Object.values(world.pulls)
  if (is('POST', /^pulls$/)) {
    const number = Object.keys(world.issues).length + 1
    const at = now()
    const pull = { id: world.nextId++, number, title: fields.title ?? '', body: fields.body ?? '', state: 'open', merged: false, user: world.agent,
      head: { ref: fields.head ?? '', sha: repo.head_sha }, base: { ref: fields.base ?? repo.default_branch }, created_at: at, updated_at: at,
      html_url: pageUrl(world, number, true) }
    world.pulls[String(number)] = pull
    world.issues[String(number)] = { id: pull.id, number, title: pull.title, body: pull.body, state: 'open', user: world.agent, created_at: at,
      updated_at: at, html_url: pull.html_url, pull_request: { url: apiUrl(world, `pulls/${number}`) } }
    write({ kind: 'pull-create', number, title: pull.title, head: pull.head.ref, base: pull.base.ref })
    return pull
  }
  if ((match = is('PUT', /^pulls\/(\d+)\/merge$/))) { write({ kind: 'pull-merge', number: Number(match[1]), fields }); return { merged: true } }
  if ((match = is('PATCH', /^pulls\/(\d+)$/))) { write({ kind: 'pull-edit', number: Number(match[1]), fields }); return world.pulls[match[1]!] ?? {} }
  if ((match = is('POST', /^pulls\/(\d+)\/reviews$/))) { write({ kind: 'pull-review', number: Number(match[1]), fields }); return { id: world.nextId++ } }
  if ((match = is('GET', /^commits\/([^/]+)$/))) return { sha: match[1] === repo.default_branch ? repo.head_sha : match[1] }
  if (is('GET', /^commits\/[^/]+\/check-runs$/)) return { total_count: 0, check_runs: [] }
  if (is('GET', /^commits\/[^/]+\/statuses$/)) return []
  throw new HttpError(404, 'Not Found')
}

function jq(expression: string, value: unknown): string {
  const ran = spawnSync('jq', ['-r', '-c', expression], { input: JSON.stringify(value), encoding: 'utf8' })
  if (!ran.error) {
    if (ran.status !== 0) throw new HttpError(0, ran.stderr.trim())
    return ran.stdout
  }
  // Without jq, answer the one expression setup uses.
  const repo = value as { full_name?: string; permissions?: { push?: boolean } }
  if (expression === '{name: .full_name, push: .permissions.push}') return JSON.stringify({ name: repo.full_name, push: repo.permissions?.push ?? null }) + '\n'
  if (expression === '.id') return `${(value as { id?: number }).id}\n`
  throw new HttpError(0, `fake gh: jq is not installed and ${expression} has no built-in answer`)
}

function api(args: string[]): number {
  const request = parseApi(args)
  const writes: Record<string, unknown>[] = []
  let body: unknown
  try {
    body = request.method === 'GET'
      ? route(readState<GithubWorld>(dir!), request, () => { throw new Error('a GET wrote') })
      : update<GithubWorld, unknown>(dir!, world => route(world, request, entry => writes.push(entry)))
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    appendLog(dir!, 'calls', { argv, status, ...status === 404 ? { unknown: true } : {} })
    if (status) process.stdout.write(JSON.stringify({ message: (error as Error).message, status: String(status) }))
    process.stderr.write(status ? `gh: ${(error as Error).message} (HTTP ${status})\n` : `${(error as Error).message}\n`)
    return 1
  }
  for (const entry of writes) appendLog(dir!, 'writes', { ...entry, argv })
  appendLog(dir!, 'calls', { argv, status: 200 })
  let text: string
  if (request.jq) text = jq(request.jq, body)
  else text = JSON.stringify(request.slurp ? [body] : body)
  if (request.include) {
    const etag = createHash('sha1').update(text).digest('hex')
    text = `HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nX-Poll-Interval: 60\r\nEtag: "${etag}"\r\n\r\n${text}`
  }
  process.stdout.write(text)
  return 0
}

function flag(args: string[], ...names: string[]): string | undefined {
  const at = args.findIndex(arg => names.includes(arg))
  return at >= 0 ? args[at + 1] : undefined
}
/** `gh pr …` and `gh issue …`: the writes a worker may make, recorded; anything else is refused. */
function porcelain(group: string, args: string[]): number {
  const [verb, target] = args
  const number = Number(target?.replace(/^#/, '')) || undefined
  if (group === 'issue' && verb === 'comment' && number) return api([`repos/${readState<GithubWorld>(dir!).repository.full_name}/issues/${number}/comments`, '-f', `body=${flag(args, '-b', '--body') ?? ''}`])
  if (group === 'pr' && verb === 'comment' && number) return api([`repos/${readState<GithubWorld>(dir!).repository.full_name}/issues/${number}/comments`, '-f', `body=${flag(args, '-b', '--body') ?? ''}`])
  if (group === 'pr' && verb === 'create') {
    const repo = readState<GithubWorld>(dir!).repository.full_name
    const created = update<GithubWorld, unknown>(dir!, world => route(world, parseApi([`repos/${repo}/pulls`, '-f', `title=${flag(args, '-t', '--title') ?? ''}`,
      '-f', `body=${flag(args, '-b', '--body') ?? ''}`, '-f', `head=${flag(args, '-H', '--head') ?? ''}`, '-f', `base=${flag(args, '-B', '--base') ?? ''}`]),
    entry => appendLog(dir!, 'writes', { ...entry, argv }))) as { html_url: string }
    appendLog(dir!, 'calls', { argv, status: 200 })
    process.stdout.write(`${created.html_url}\n`)
    return 0
  }
  if (group === 'pr' && ['merge', 'close', 'ready', 'edit', 'review'].includes(verb ?? '')) {
    appendLog(dir!, 'writes', { kind: `pull-${verb}`, number, argv })
    appendLog(dir!, 'calls', { argv, status: 200 })
    return 0
  }
  appendLog(dir!, 'calls', { argv, status: 404, unknown: true })
  process.stderr.write(`fake gh: ${group} ${verb ?? ''} is not supported\n`)
  return 1
}

function main(): number {
  const [command, ...rest] = argv
  if (command === 'api') return api(rest)
  if (command === 'auth') {
    appendLog(dir!, 'calls', { argv, status: 200 })
    const world = readState<GithubWorld>(dir!)
    if (rest[0] === 'status') { process.stderr.write(`github.com\n  ✓ Logged in to github.com account ${world.agent.login} (fake)\n`); return world.signedIn ? 0 : 1 }
    // `auth git-credential`: the fake has no credential, so git fails before it reaches a network.
    return 1
  }
  if (command === '--version') { process.stdout.write('gh version 2.99.0 (fake for dsh-superagent e2e)\n'); return 0 }
  if (command === 'pr' || command === 'issue') return porcelain(command, rest)
  appendLog(dir!, 'calls', { argv, status: 404, unknown: true })
  process.stderr.write(`fake gh: ${command ?? ''} is not supported\n`)
  return 1
}
process.exitCode = main()
