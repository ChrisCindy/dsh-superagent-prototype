/** The code-host Source: translation, a poll round and its cursor, the Channel, pull request binding, CI, merge checks and setup */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Ticket, type Trigger } from '../src/core/index.ts'
import { CODEHOST, contractSchemas, resolveCodehost, type CodehostDeployment } from '../src/codehost.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { githubSkipped, setupChanged } from '../src/app/setup.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy, type MergeConfig } from '../src/policy.ts'
import { apply, codehostKind, pollRound } from '../src/sources/codehost.ts'
import { claimPr, mergeChecks, observePr, pollChecks, prEndNotices, prOf, requestMerge, type Pr } from '../src/sources/codehost-pull.ts'
import { codehostThreadContext, readCodehost } from '../src/sources/codehost-read.ts'
import { eventTrigger, mentions, sendCodehost, threadOf } from '../src/sources/codehost-trigger.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { CodehostEvent } from '../src/codehost.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

afterEach(() => { vi.restoreAllMocks() })
const ALL = ['whoami', 'repository', 'events', 'thread', 'comments', 'comment', 'files', 'checks', 'approvals', 'contents', 'protection', 'merge', 'git-credential']
const codehost = (overrides: Partial<CodehostDeployment> = {}): CodehostDeployment => ({ adapter: '/bin/adapter', capabilities: ALL,
  account: { id: '7', login: 'agent-bot', name: 'Agent', email: 'agent@example.com' },
  repositories: { codehost: { path: 'acme/widgets', defaultBranch: 'main', webUrl: 'https://code.example.com/acme/widgets',
    cloneUrl: 'https://code.example.com/acme/widgets.git' } },
  merge: { adapter: '/bin/merger', login: 'merge-bot' }, ...overrides })

function host(deployment = testDeployment({ codehost: codehost() })) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'codehost-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    sources: { codehost: { kind: 'codehost', enabled: true, config: { adapter: 'adapter', repository: 'acme/widgets' } } },
    policy: { sources: { codehost: { allowed: [{ id: 'alice' }] } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(codehostKind); sources.register(githubKind)
  const executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(async () => {}) }, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  return { store, engine, sources, receive, executor, health: board.all, deps, ctx: sourceContextOf(deps, codehostKind) }
}
type Route = (request: Record<string, unknown>) => unknown
/** The adapters as `Commands.run` reaches them: answers by program and operation, and every call in order. */
function adapter(routes: Record<string, Route | unknown>, merger: Record<string, Route | unknown> = { whoami: { id: '9', login: 'merge-bot' } }) {
  const calls: { program: string; operation: string; request: Record<string, unknown> }[] = []
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (program, args) => {
    const [operation, json] = args
    const request = JSON.parse(json ?? '{}') as Record<string, unknown>
    calls.push({ program, operation: operation!, request })
    const route = (program === '/bin/merger' ? merger : routes)[operation!]
    const value = typeof route === 'function' ? (route as Route)(request) : route
    if (value === undefined) throw commandError({ stderr: JSON.stringify({ error: { code: 501, message: `not implemented: ${operation}` } }), code: 1 })
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  return calls
}
const event = (id: string, fields: Record<string, unknown> = {}) => ({ id, kind: 'comment',
  thread: { type: 'issue', number: 3, title: 'Broken link' }, actor: { login: 'alice' }, text: '@agent-bot please fix', at: '2026-11-01T00:00:00Z',
  url: `https://code.example.com/acme/widgets/issues/3#note_${id}`, ...fields })
const pr = (fields: Partial<Pr> = {}): Pr => ({ type: 'pr', number: 5, title: 'Fix link', state: 'open', url: 'https://code.example.com/acme/widgets/pr/5',
  author: { login: 'agent-bot', bot: false }, createdAt: '2026-11-01T00:00:00Z', draft: false, head: { branch: 'agent/fix-link', sha: 'abc1234def' },
  additions: 3, deletions: 1, autoMerge: false, ...fields })
function ticket(h: ReturnType<typeof host>, fields: Partial<Ticket> = {}): Ticket {
  const origin = eventTrigger(event('origin') as CodehostEvent, 'agent-bot')!
  h.store.triggers.save(origin)
  const saved: Ticket = { id: 't1', title: 'fix', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
    actor: { source: 'codehost', id: 'alice' }, scope: '' }, channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }],
  assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  execution: { name: 'fix-link', directory: '/w/fix-link', assignment: '' }, origin: { triggerId: origin.id, triggerIds: [origin.id] }, ...fields }
  h.store.tickets.save(saved)
  return saved
}
const MERGE: MergeConfig = { cli: '', method: 'squash', maxLines: 200, requireApprovals: 1 }

describe('translation', () => {
  it('keys Issues and pull requests apart, addresses the agent by mention, assignment or review request, and drops its own events', () => {
    const comment = eventTrigger(event('e1') as CodehostEvent, 'agent-bot')!
    expect(comment).toMatchObject({ id: key('codehost-event', 'e1'), source: 'codehost', threads: [{ source: 'codehost', id: '3' }],
      actor: { source: 'codehost', id: 'alice' }, human: true, addressed: 'mention', text: '@agent-bot please fix',
      channel: { source: 'codehost', thread: 'codehost:3', address: { type: 'issue', number: '3' } }, meta: { type: 'issue', number: 3, row: 'comments' } })
    const assigned = eventTrigger(event('e2', { kind: 'assigned', text: '', thread: { type: 'pr', number: 3, title: 'Docs' } }) as CodehostEvent, 'agent-bot', 'codehost-docs')!
    expect(assigned).toMatchObject({ id: key('codehost-docs-event', 'e2'), threads: [{ source: 'codehost-docs', id: '!3' }], addressed: 'direct',
      text: 'Assigned the agent to pull request !3: Docs', meta: { row: 'prs', isPr: true } })
    const review = eventTrigger(event('e3', { kind: 'review', review: 'changes_requested', text: 'nope', path: 'a.ts', line: 4, commentId: 'c9',
      thread: { type: 'pr', number: 5 } }) as CodehostEvent, 'agent-bot')!
    expect(review.text).toBe('CHANGES_REQUESTED review\n\na.ts:4\n\nnope')
    expect(review.addressed).toBeUndefined()
    expect(review.channel!.address).toMatchObject({ replyTo: 'c9' })
    expect(eventTrigger(event('e4', { actor: { login: 'Agent-Bot' } }) as CodehostEvent, 'agent-bot')).toBeUndefined()
    expect(eventTrigger(event('e5', { kind: 'pipeline' }) as CodehostEvent, 'agent-bot')).toBeUndefined()
    expect(eventTrigger(event('e6', { actor: { login: 'ci', bot: true } }) as CodehostEvent, 'agent-bot')!.human).toBe(false)
    expect(mentions('ping @agent-bot.', 'agent-bot')).toBe(true)
    expect(mentions('ping @agent-bots', 'agent-bot')).toBe(false)
    expect(threadOf('!12')).toEqual({ type: 'pr', number: 12 })
    expect(threadOf('12')).toEqual({ type: 'issue', number: 12 })
    expect(threadOf('ci:main')).toBeUndefined()
    expect(codehostKind.find!('!7', { id: 'codehost', kind: 'codehost', enabled: true, config: codehostKind.schema.parse({}) }).threads).toEqual(['codehost:!7'])
  })
  it('exports the contract as JSON Schema, by operation', () => {
    const schemas = contractSchemas() as { contractVersion: number; operations: Record<string, { request: unknown; answer: unknown }> }
    expect(schemas.contractVersion).toBe(1)
    expect(Object.keys(schemas.operations)).toEqual(expect.arrayContaining(['describe', 'whoami', 'events', 'comment', 'merge', 'protection']))
  })
})

describe('poll round', () => {
  it('takes in the events after the cursor once, follows subscribed threads, and moves the cursor', async () => {
    const h = host()
    const calls = adapter({ events: (request: Record<string, unknown>) => request.cursor === null
      ? { events: [event('e1'), { id: 'broken' }], cursor: 'c1', more: true }
      : request.cursor === 'c1' ? { events: [event('e2', { actor: { login: 'mallory' }, text: 'unrelated' })], cursor: 'c2' } : { events: [], cursor: request.cursor } })
    await pollRound(h.ctx)
    expect(h.store.get(KV.codehost.cursor)).toBe('c2')
    expect(calls.filter(call => call.operation === 'events').map(call => call.request)).toEqual([
      { repository: 'acme/widgets', cursor: null, follow: [], observe: { issues: false, prs: false, comments: false } },
      { repository: 'acme/widgets', cursor: 'c1', follow: [], observe: { issues: false, prs: false, comments: false } }])
    expect(h.engine.candidate(key('codehost-event', 'e1'))?.strength).toBe('explicit')
    expect(h.store.threads.get('codehost:3')).toMatchObject({ meta: { title: 'Broken link', isPr: false } })
    expect(h.health.codehost).toMatchObject({ state: 'ready', detail: '2 events; 0 pull requests read; 1 unreadable events skipped' })
    // Read again, the same event is a duplicate.
    h.store.delete(KV.codehost.cursor)
    await pollRound(h.ctx)
    expect(await h.receive.mock.results.at(-2)!.value).toBe('duplicate')
    h.store.close()
  })
  it('reports setup waiting and then its health through the plugin, and unregisters on disposal', async () => {
    const h = host()
    const sources = new SourceRegistry(() => h.store.settings(), new HealthBoard())
    const disposers: (() => unknown)[] = []
    const orchestrator = { sources, context: (kind: { kind: string; health: readonly string[] }, id?: string) => sourceContextOf({ ...h.deps, sources, configured: () => false }, kind, id) }
    apply({ orchestrator, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(sources.kind('codehost')).toBe(codehostKind)
    await vi.waitFor(() => expect(sources.healthEntries(codehostKind).get('codehost')?.get()).toMatchObject({ code: 'setupPending' }))
    for (const dispose of disposers) await dispose()
    expect(sources.kind('codehost')).toBeUndefined()
    h.store.close()
  })
})

describe('channel', () => {
  const message = { id: 'reply-1', channel: { source: 'codehost', thread: 'codehost:3', address: { type: 'issue', number: '3' } }, text: 'On it', kind: 'reply' as const }
  it('posts once with its marker, finds an earlier post, drops a gone thread and retries other failures', async () => {
    const h = host()
    const posted: unknown[] = []
    adapter({ comments: { comments: [] }, comment: (request: Record<string, unknown>) => { posted.push(request); return { id: 'c1' } } })
    expect(await sendCodehost({ commands: h.ctx.commands }, message)).toBe('sent')
    expect(posted).toEqual([{ repository: 'acme/widgets', type: 'issue', number: 3, body: 'On it\n\n<!-- dsh-superagent:reply-1 -->', key: 'reply-1', replyTo: null }])
    vi.restoreAllMocks()
    adapter({ comments: { comments: [{ id: 'c1', author: { login: 'agent-bot' }, body: 'On it\n\n<!-- dsh-superagent:reply-1 -->', createdAt: '2026-11-01T00:00:00Z' }] },
      comment: () => { throw new Error('posted twice') } })
    expect(await sendCodehost({ commands: h.ctx.commands }, message)).toBe('sent')
    vi.restoreAllMocks()
    adapter({ comments: { comments: [] }, comment: () => commandError({ stderr: '{"error":{"code":410,"message":"deleted"}}', code: 1 }) })
    expect(await sendCodehost({ commands: h.ctx.commands }, message)).toBe('gone')
    vi.restoreAllMocks()
    adapter({ comments: { comments: [] }, comment: () => commandError({ stderr: '{"error":{"code":502,"message":"bad gateway"}}', code: 1 }) })
    await expect(sendCodehost({ commands: h.ctx.commands }, message)).rejects.toThrow('bad gateway')
    // An adapter that cannot comment can never deliver a reply.
    const silent = host(testDeployment({ codehost: codehost({ capabilities: ['whoami', 'repository', 'events'] }) }))
    expect(await sendCodehost({ commands: silent.ctx.commands }, message)).toBe('gone')
    expect(h.sources.link(message.channel, {})).toEqual({ url: '', label: { zh: '代码托管 #3', en: 'Code host #3' } })
    h.store.close(); silent.store.close()
  })
  it('reads a thread\'s description and comments for assessments and resources', async () => {
    const h = host()
    adapter({ thread: pr({ body: 'Body', author: { login: 'carol', bot: false } }),
      comments: (request: Record<string, unknown>) => request.cursor ? { comments: [] }
        : { comments: [{ id: 'c1', author: { login: 'bot', bot: true }, body: 'lint failed', createdAt: '2026-11-01T00:00:00Z' }], cursor: 'p2' } })
    const trigger = eventTrigger(event('e1', { thread: { type: 'pr', number: 5 }, commentId: 'c1' }) as CodehostEvent, 'agent-bot')!
    const page = await codehostThreadContext.read(h.ctx.commands, trigger, 'thread', undefined, {})
    expect(page).toMatchObject({ next: 'p2', messages: [{ id: 'description', from: 'carol', text: 'Fix link\n\nBody' }, { id: 'c1', bot: true }] })
    expect(codehostThreadContext.messageId(trigger)).toBe('c1')
    expect(await readCodehost(h.ctx.commands, 'codehost/prs/5/comments', 'codehost')).toEqual({ messages: [expect.objectContaining({ id: 'c1' })] })
    await expect(readCodehost(h.ctx.commands, 'codehost/issues/5/files', 'codehost')).rejects.toThrow('require a pull request')
    h.store.close()
  })
})

describe('pull requests', () => {
  it('binds the agent\'s pull request from the ticket\'s branch, follows its CI, and ends the ticket when it merges', async () => {
    const h = host()
    ticket(h)
    observePr(h.ctx, pr())
    expect(prOf(h.store.tickets.get('t1')!)).toBe(5)
    expect(h.sources.pull(h.store.tickets.get('t1')!)).toBe(5)
    expect(claimPr(h.ctx, 't1', pr({ number: 6, head: { branch: 'other', sha: 'x' } }))).toMatch(/does not belong/)
    // The first CI reading is the baseline; a change after it becomes a Trigger on the pull request.
    let state = 'running'
    adapter({ checks: () => ({ sha: 'abc1234def', checks: [{ name: 'unit', state }] }) })
    await pollChecks(h.ctx, h.ctx.commands, pr())
    state = 'failure'
    await pollChecks(h.ctx, h.ctx.commands, pr())
    const ci = h.receive.mock.calls.at(-1)![0]
    expect(ci).toMatchObject({ id: key('codehost-ci', '5', '1'), threads: [{ id: '!5' }], human: false, text: expect.stringMatching(/^CI failed 1\/1 on PR !5 at abc1234: unit/) })
    expect(observePr(h.ctx, pr({ state: 'merged', mergedAt: '2026-11-02T00:00:00Z' }))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    const notices = prEndNotices(h.store.tickets.get('t1')!, 'please fix', () => 'https://code.example.com/acme/widgets/pr/5')
    expect(notices).toEqual([expect.objectContaining({ channel: expect.objectContaining({ source: 'feishu' }), text: '[PR !5](https://code.example.com/acme/widgets/pr/5) has merged.' })])
    h.store.close()
  })
  it('lets the ticket\'s origin kind serve its claims and repository reads', () => {
    const h = host()
    const origin = eventTrigger(event('o') as CodehostEvent, 'agent-bot')!
    expect(h.sources.claimant(origin)?.kind.kind).toBe('codehost')
    expect(h.sources.claimant({ source: 'github', threads: [{ source: 'github', id: '1' }] })?.kind.kind).toBe('github')
    h.store.close()
  })
})

describe('merge checks', () => {
  const routes = (overrides: Record<string, unknown> = {}) => ({ thread: pr(), files: { files: [{ path: 'docs/a.md' }] },
    checks: { sha: 'abc1234def', checks: [{ name: 'unit', state: 'success' }] },
    approvals: { sha: 'abc1234def', approvals: [{ login: 'carol', sha: 'abc1234def' }], changesRequested: [] }, ...overrides })
  const owned = (h: ReturnType<typeof host>) => ticket(h, { follows: [{ thread: 'codehost:!5', own: true }] })
  it('merges the checked head commit with the merge adapter when every check passes', async () => {
    const h = host()
    const calls = adapter(routes(), { whoami: { id: '9', login: 'merge-bot' }, merge: { state: 'enabled' } })
    expect(await requestMerge(h.ctx, owned(h), 5, MERGE)).toEqual({ auto_merge: 'enabled', pull: 5, head: 'abc1234def', method: 'squash' })
    expect(calls.at(-1)).toEqual({ program: '/bin/merger', operation: 'merge', request: { repository: 'acme/widgets', number: 5, sha: 'abc1234def', method: 'squash' } })
    h.store.close()
  })
  it('refuses stale approvals, changes requested, running CI, a large change and a merge adapter of the agent', async () => {
    const h = host()
    adapter(routes({ thread: pr({ additions: 300 }), checks: { sha: 'abc1234def', checks: [{ name: 'unit', state: 'running' }] },
      approvals: { sha: 'abc1234def', approvals: [{ login: 'carol', sha: 'old' }, { login: 'dave' }, { login: 'agent-bot', sha: 'abc1234def' }],
        changesRequested: ['erin'] } }), { whoami: { id: '7', login: 'agent-bot' } })
    const { refused } = await mergeChecks(h.ctx, owned(h), 5, MERGE)
    expect(refused.map(item => item.check)).toEqual(['size', 'ci', 'changes_requested', 'approvals', 'merge_account'])
    expect(refused.find(item => item.check === 'approvals')!.detail).toBe('0 of the 1 approvals required cover the head commit abc1234')
    // An approval without a commit counts where the host withdraws approvals on a push.
    vi.restoreAllMocks()
    adapter(routes({ approvals: { sha: 'abc1234def', approvals: [{ login: 'dave' }], dismissesStale: true } }))
    expect((await mergeChecks(h.ctx, owned(h), 5, MERGE)).refused).toEqual([])
    h.store.close()
  })
  it('sends a person to merge when the adapter lacks an operation a check needs, or no merge adapter is set', async () => {
    const h = host(testDeployment({ codehost: codehost({ capabilities: ['whoami', 'repository', 'events', 'thread'] }) }))
    adapter(routes())
    const result = await requestMerge(h.ctx, owned(h), 5, MERGE)
    expect(result).toMatchObject({ auto_merge: 'refused', next: 'A person merges this PR; say so in your report.' })
    expect('refused' in result && result.refused.map(item => item.check)).toEqual(['ci', 'approvals'])
    const unset = host(testDeployment({ codehost: codehost({ merge: undefined }) }))
    expect((await mergeChecks(unset.ctx, ticket(unset), 5, MERGE)).refused.map(item => item.check)).toEqual(['merge_cli', 'ticket_pull'])
    h.store.close(); unset.store.close()
  })
})

describe('setup', () => {
  const answers: Record<string, unknown> = {
    describe: { contractVersion: 1, capabilities: ALL }, whoami: { id: '7', login: 'agent-bot', email: 'agent@example.com' },
    repository: { id: '1', path: 'acme/widgets', defaultBranch: 'main', canPush: true, webUrl: 'https://code.example.com/acme/widgets',
      cloneUrl: 'https://code.example.com/acme/widgets.git' },
    protection: { requiresApproval: true, dismissesStale: true, agentCanBypass: false },
  }
  const probe = (byProgram: Record<string, Record<string, unknown>>) => async (argv: string[]) => {
    const route = byProgram[argv[0]!]?.[argv[1]!]
    if (route === undefined) throw new Error(`${argv[0]} ${argv[1]} not implemented`)
    return JSON.stringify(typeof route === 'function' ? (route as Route)(JSON.parse(argv[2]!) as Record<string, unknown>) : route)
  }
  const instance = (config: Record<string, unknown> = {}) => [{ id: 'codehost', config: { adapter: '/bin/sh', repository: 'acme/widgets', ...config } }]
  it('resolves the adapter, the account, each repository, the merge account and the worker CLI, with no warning when all is in place', async () => {
    const { codehost: resolved, warnings } = await resolveCodehost(testMachine(), [...instance({ mergeAdapter: '/bin/ls', workerCli: '/bin/cat',
      workerDeny: [{ pattern: 'mr merge' }] }), { id: 'codehost-docs', config: { adapter: '/bin/sh', repository: 'acme/docs' } }],
    probe({ '/bin/sh': { ...answers, repository: (request: Record<string, unknown>) => ({ ...answers.repository as object, path: request.repository }) },
      '/bin/ls': { describe: { contractVersion: 1, capabilities: ['whoami', 'merge'] }, whoami: { id: '9', login: 'merge-bot' } } }))
    expect(warnings).toEqual([])
    expect(resolved).toMatchObject({ adapter: '/bin/sh', account: { login: 'agent-bot', email: 'agent@example.com' },
      merge: { adapter: '/bin/ls', login: 'merge-bot' }, worker: { name: 'cat', path: '/bin/cat', deny: ['mr merge'] } })
    expect(Object.keys(resolved.repositories)).toEqual(['codehost', 'codehost-docs'])
  })
  it('refuses another contract, a read-only repository and a merge adapter of the agent, and warns of what is missing', async () => {
    const fail = (config: Record<string, unknown>, sh: Record<string, unknown>, other: Record<string, Record<string, unknown>> = {}) =>
      resolveCodehost(testMachine(), instance(config), probe({ '/bin/sh': { ...answers, ...sh }, ...other })).catch((error: { code: string }) => error.code)
    expect(await fail({}, { describe: { contractVersion: 2, capabilities: ALL } })).toBe('codehostContract')
    expect(await fail({}, { describe: { contractVersion: 1, capabilities: ['whoami'] } })).toBe('codehostContract')
    expect(await fail({}, { repository: { ...answers.repository as object, canPush: false } })).toBe('codehostRepositoryReadOnly')
    expect(await fail({ adapter: '' }, {})).toBe('codehostAdapterUnset')
    expect(await fail({ mergeAdapter: '/bin/ls' }, {}, { '/bin/ls': { describe: { contractVersion: 1, capabilities: ['whoami', 'merge'] }, whoami: { id: '7', login: 'Agent-Bot' } } }))
      .toBe('codehostMergeAgent')
    expect(await fail({ workerCli: '/usr/bin/git' }, {})).toBe('codehostWorkerCli')
    const { warnings } = await resolveCodehost(testMachine(), instance({ workerCli: '/bin/cat' }),
      probe({ '/bin/sh': { ...answers, describe: { contractVersion: 1, capabilities: ['whoami', 'repository', 'events', 'protection'] },
        protection: { requiresApproval: true, dismissesStale: true, agentCanBypass: true } } }))
    expect(warnings.map(warning => warning.code)).toEqual(['codehostCapabilities', 'codehostShimUnguarded', 'codehostMergeBypass'])
    expect(warnings[0]!.values.missing).toContain('approvals')
  })
  it('leaves GitHub out only when it is off and a code-host Source is on, and restarts when that changes', () => {
    const settings = (github: boolean, code: boolean) => SettingsSchema.parse({ sources: { github: { kind: 'github', enabled: github, config: {} },
      codehost: { kind: CODEHOST, enabled: code, config: { adapter: 'a', repository: 'r' } } } })
    expect(githubSkipped(settings(false, true))).toBe(true)
    expect(githubSkipped(settings(false, false))).toBe(false)
    expect(githubSkipped(settings(true, true))).toBe(false)
    expect(setupChanged(settings(true, true), settings(false, true), [])).toBe(true)
    expect(setupChanged(settings(true, true), settings(true, true), [])).toBe(false)
  })
})
