/** Main-session assessor per-eval state and context loading. */
import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AssessmentSchema, EvalReadSchema, MasterAssessor, type AssessorHost } from '../src/app/assessment.ts'
import { mainAdmissionPolicy } from '../src/app/context.ts'
import { correlatedThreads, type LinkHost } from '../src/app/links.ts'
import { Engine, MemoryRepositories, type Executor, type Policy, type Trigger } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { deferred } from './fixtures/async.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

/** Assessor fixture backed by in-memory repositories and fake GitHub Issue and file reads. */
function setup(strength: 'explicit' | 'inferred' = 'inferred', bodies = Array.from({ length: 5 }, (_, i) => `comment ${i}`),
  threadContext?: AssessorHost['threadContext']) {
  const comments = bodies.map((body, i) => ({ id: i, html_url: `https://github.com/acme/widgets/issues/1#c${i}`,
    user: { login: 'bob' }, created_at: '2026-09-09T00:00:00Z', body }))
  const gate = { issue: undefined as Promise<void> | undefined }
  const commands = {
    repository: 'acme/widgets', deployment: testDeployment(),
    withSignal() { return commands }, forSource() { return commands },
    gh: vi.fn(async (args: string[]) => {
      await gate.issue
      const number = Number(/issues\/(\d+)/.exec(args[1]!)?.[1])
      return args[1]!.includes('/comments') ? comments : { id: 100 + number, number, state: 'open',
        html_url: `https://github.com/acme/widgets/issues/${number}`,
        user: { login: 'bob' }, created_at: '2026-09-09T00:00:00Z', title: 'Issue', body: 'body' }
    }),
    run: vi.fn(async () => 'export const value = 1\n'),
    // A string first argument is a raw file path; otherwise validate the fake gh response against the schema.
    api: vi.fn(async (schema: unknown, ...rest: string[]) => typeof schema === 'string' ? 'export const value = 1\n'
      : (schema as { parse(value: unknown): unknown }).parse(await (commands as unknown as { gh(args: string[]): Promise<unknown> }).gh(['api', rest[0]!]))),
  } as unknown as Commands
  const repo = new MemoryRepositories()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}))
  sources.register(githubKind)
  let engine!: Engine
  // The Store's reads the correlated Threads take, over the in-memory repositories: a Thread's first Trigger is the oldest stored on it.
  const triggers: Trigger[] = []
  const records = { threads: repo.threads, tickets: repo.tickets, decisions: { latest: (key: string) => repo.decisions.byThread(key).at(-1) },
    read: { firstTrigger: (key: string) => triggers.find(trigger => trigger.threads.some(ref => `${ref.source}:${ref.id}` === key)) } } as unknown as LinkHost['store']
  const host: AssessorHost = {
    correlatedThreads: thread => correlatedThreads(records, thread),
    get engine() { return engine }, commands, deployment: testDeployment(), settings: () => SettingsSchema.parse({}),
    threadContext: threadContext ?? (trigger => sources.threadContext(trigger)), githubSource: () => 'github',
    effects: { enqueue: () => {}, handle: () => {} }, paused: () => false, deliver: async () => {}, candidateCard: async candidate => ({ eval_id: candidate.evalId }),
  }
  const assessor = new MasterAssessor(host)
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 600_000, gate: () => ({ admissible: true, strength, basis: { via: 'followup' } }),
    revalidate: () => true, admitsInferred: rules => rules.length > 0 }
  const executor: Executor = { start: async () => {}, deliver: async () => {}, stop: async () => {} }
  const scope = { scope: () => ({ listened: true as const, observed: true }) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  engine = new Engine({ repo, policy: () => policy, scope, assessor, executor, outbox })
  const tools: Record<string, (args: unknown, signal: AbortSignal) => Promise<unknown>> = {}
  tools.orchestrator_eval_read = (args, signal) => assessor.read({} as Agent, EvalReadSchema.parse(args), signal)
  tools.orchestrator_eval_decide = (args, signal) => {
    const { trigger_id, ...result } = args as { trigger_id: string }
    return assessor.decide(trigger_id, AssessmentSchema.parse(result), signal)
  }
  // Per-Eval state retained by the assessor and released when the Eval ends.
  const kept = assessor as unknown as { evals: Map<string, unknown> }
  const size = () => kept.evals.size
  const receive = (trigger: Trigger) => { triggers.push(trigger); engine.receive(trigger) }
  return { repo, engine, assessor, tools, size, gate, receive }
}
const issue = (n: number): Trigger => ({ id: `issue-${n}`, source: 'github', threads: [{ source: 'github', id: String(n) }], actor: { source: 'github', id: 'bob' }, human: true,
  at: new Date(Date.UTC(2026, 8, 9, 0, 0, n)).toISOString(), text: `issue ${n}`, url: `https://github.com/acme/widgets/issues/${n}`, meta: { number: n } })
const signal = new AbortController().signal

it('keeps nothing for an Eval once it is decided, as for one that timed out', async () => {
  const s = setup()
  for (let n = 1; n <= 3; n++) {
    s.engine.receive(issue(n)); s.engine.evaluateDue()
    await s.assessor.context(`issue-${n}`, signal)
    await s.tools.orchestrator_eval_read!({ trigger_id: `issue-${n}`, resource: 'file', path: 'src/value.ts', offset: 0 }, signal)
    expect(s.size()).toBeGreaterThan(0)
    s.engine.decide(`issue-${n}`, { kind: 'ignore', reason: 'not a request' })
    expect(s.size()).toBe(0)
  }
  s.engine.receive(issue(9)); s.engine.evaluateDue()
  await s.assessor.context('issue-9', signal)
  const thread = s.repo.threads.get('github:9')!
  s.repo.threads.save({ ...thread, expired: 2, evaluating: { ...thread.evaluating!, delivered: '2000-01-01T00:00:00.000Z', deadline: '2000-01-01T00:00:00.000Z' } })
  s.engine.evaluateDue()
  expect(s.size()).toBe(0)
})

it('keeps nothing from a context read that finishes after its Eval was decided', async () => {
  const s = setup()
  const hold = deferred()
  s.gate.issue = hold.promise
  s.engine.receive(issue(1)); s.engine.evaluateDue()
  const details = s.assessor.context('issue-1', signal)
  s.engine.decide('issue-1', { kind: 'ignore', reason: 'not a request' })
  hold.resolve()
  await expect(details).rejects.toThrow('This assessment has finished')
  expect(s.size()).toBe(0)
})

it('reads the context of a Trigger through its Source, and none for a Source that gives none', async () => {
  const s = setup()
  s.engine.receive(issue(1)); s.engine.evaluateDue()
  const context = await s.assessor.context('issue-1', signal)
  expect(context.thread).toMatchObject({ complete: true, loaded_messages: 6, source_found: true })
  const page = await s.tools.orchestrator_eval_read!({ trigger_id: 'issue-1', resource: 'thread', offset: 0 }, signal) as { text: string }
  expect(JSON.parse(page.text)).toMatchObject({ next_read: null,
    messages: expect.arrayContaining([expect.objectContaining({ text: 'comment 0' })]) })
  const other: Trigger = { ...issue(2), id: 'other-2', source: 'probe', threads: [{ source: 'probe', id: '2' }], actor: { source: 'probe',
    id: 'bob' } }
  s.engine.receive(other); s.engine.evaluateDue()
  expect((await s.assessor.context('other-2', signal)).thread).toMatchObject({ error: expect.stringContaining('gives no Thread context') })
  await expect(s.tools.orchestrator_eval_read!({ trigger_id: 'other-2', resource: 'thread', offset: 0 },
    signal)).rejects.toThrow('gives no Thread context')
  // The Trigger's own text is still readable when its Source provides no Thread context.
  expect(await s.tools.orchestrator_eval_read!({ trigger_id: 'other-2', resource: 'message', offset: 0 },
    signal)).toMatchObject({ text: 'issue 2' })
})
it('routes an explicit candidate instead of assessing it: each eval tool names the routing tools', async () => {
  const s = setup('explicit')
  s.engine.receive(issue(1)); s.engine.evaluateDue()
  const routed = 'orchestrator_route with its trigger_id and kind accept, attach, stop or ignore'
  await expect(s.assessor.context('issue-1', signal)).rejects.toThrow(routed)
  await expect(s.tools.orchestrator_eval_read!({ trigger_id: 'issue-1', resource: 'message', offset: 0 }, signal)).rejects.toThrow(routed)
  const direction = { implementation_requested: false, target_basis: 'undetermined', requires_design_decision: false, evidence: 'chatter' }
  const decision = { trigger_id: 'issue-1', decision: 'ignore', rule_assessments: [], direction, title: 't', scope: 's', reason: 'r' }
  await expect(s.tools.orchestrator_eval_decide!(decision, signal)).rejects.toThrow(routed)
})

it('asks the assessment only for decisions its tool accepts, which no longer include reopen or stop', () => {
  expect(mainAdmissionPolicy).not.toMatch(/reopen|decision=stop/)
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'e' }
  const result = (decision: string, extra = {}) =>
    AssessmentSchema.safeParse({ decision, rule_assessments: [], direction, title: 't', scope: 's', reason: 'r', ...extra }).success
  expect([result('ignore'), result('unavailable'), result('reopen'), result('stop')]).toEqual([true, true, false, false])
  expect(result('ignore', { ticket_id: 't' })).toBe(false)
})

it('loads a window without the assessment instructions: the trigger once, cut messages with their length, and stubs for the rest',
  async () => {
  const bodies = Array.from({ length: 30 }, (_, i) => `comment ${i}: ${'the label reads oddly on the settings page. '.repeat(i % 4 === 0
    ? 40 : 3)}`)
  const s = setup('inferred', bodies)
  const trigger = { ...issue(1), id: 'c15', text: bodies[15]!, url: 'https://github.com/acme/widgets/issues/1#c15', meta: { number: 1,
    kind: 'comment' } }
  s.engine.receive(trigger); s.engine.evaluateDue()
  const result = await s.assessor.context('c15', signal) as Record<string, unknown> & { thread: { messages: Record<string, unknown>[] } }
  expect(result).not.toHaveProperty('instructions')
  expect(result.text).toBe(bodies[15])
  const messages = new Map(result.thread.messages.map(message => [message.id as string, message]))
  const at = (i: number) => messages.get(`https://github.com/acme/widgets/issues/1#c${i}`)!
  // The trigger's own text is given once at top level; its two nearest neighbours keep more text than the rest of the window.
  expect(at(15)).toEqual({ id: expect.any(String), from: 'bob', at: expect.any(String), trigger: true })
  expect(at(16)).toMatchObject({ chars: bodies[16]!.length, text: `${bodies[16]!.slice(0, 1200)}…` })
  expect(at(12)).toMatchObject({ chars: bodies[12]!.length, text: `${bodies[12]!.slice(0, 400)}…` })
  expect(at(14)).toMatchObject({ text: bodies[14] })
  expect(at(14)).not.toHaveProperty('chars')
  // Messages outside the window are stubs that orchestrator_eval_read can read in full.
  expect(at(8)).toEqual({ id: expect.any(String), from: 'bob', preview: bodies[8]!.slice(0, 50) })
  const whole = await s.tools.orchestrator_eval_read!({ trigger_id: 'c15', resource: 'message', message_id: at(8).id }, signal)
  expect(JSON.stringify(whole)).toContain(bodies[8]!.slice(-40))
  expect(JSON.stringify(result).length).toBeLessThan(9000)
})

it('lets the main Session read on from the cursor its loaded window ends with, and points a cut batch message at its whole text', async () => {
  // Every page returns a next cursor so the bounded window ends with a continuation cursor.
  const page = (cursor?: string) => {
    const n = Number(cursor ?? 0)
    const message = { id: `m${n}`, from: 'bob', at: new Date(Date.UTC(2026, 8, 9, 0, 0, n)).toISOString(), text: `message ${n}` }
    return { messages: [message], next: String(n + 1), body: { messages: [message] } }
  }
  const context = { messageId: 'm0', read: async (_commands: Commands, _part: string, cursor?: string) => page(cursor), images: () => [],
    image: async () => { throw new Error('No images') } }
  const s = setup('inferred', undefined, () => context)
  s.engine.receive(issue(1))
  const long = { ...issue(2), id: 'long', threads: issue(1).threads, text: 'a long follow-up. '.repeat(40) }
  s.engine.receive(long); s.engine.evaluateDue()
  const result = await s.assessor.context('long', signal) as { thread: { next_cursor?: string }, batch: Record<string, unknown>[] }
  expect(result.thread.next_cursor).toBe('10')
  const more = await s.tools.orchestrator_eval_read!({ trigger_id: 'long', resource: 'thread', cursor: '10' }, signal)
  expect(JSON.stringify(more)).toContain('message 10')
  const shorter = { trigger_id: 'issue-1' }
  expect(result.batch).toEqual([expect.objectContaining(shorter)])
  const s2 = setup('inferred', undefined, () => context)
  s2.engine.receive(long); s2.engine.receive({ ...issue(3), threads: issue(1).threads }); s2.engine.evaluateDue()
  const other = await s2.assessor.context('issue-3', signal) as { batch: Record<string, unknown>[] }
  expect(other.batch).toEqual([expect.objectContaining({ trigger_id: 'long', chars: long.text.length, read: 'trigger/long' })])
})

it('gives the assessment the correlated Threads for reference: label, link, latest Decision, and its ticket with the ticket\'s state', async () => {
  const s = setup()
  // A message on Issue 1 earlier started a ticket; a CI run's message now belongs to Issue 1 and to pull request 7, which is the primary Thread.
  s.receive(issue(1)); s.engine.evaluateDue()
  const accepted = s.engine.decide('issue-1', { kind: 'accept', title: 'Fix it', scope: 'the label', reason: 'asked', rules: ['copy'] })
  const run: Trigger = { ...issue(7), id: 'run-7', human: false, threads: [{ source: 'github', id: '7' }, { source: 'github', id: '1' }],
    text: 'CI failed on the label fix' }
  s.receive(run); s.engine.evaluateDue()
  const context = await s.assessor.context('run-7', signal) as { correlated_threads?: Record<string, unknown>[] }
  expect(context.correlated_threads).toEqual([{ thread: 'github:1', label: 'issue 1', url: 'https://github.com/acme/widgets/issues/1',
    decision: { decision_id: accepted.id, kind: 'accept', at: accepted.at }, ticket: { ticket_id: accepted.ticketId, title: 'Fix it',
      state: 'working/queued' }, read: 'thread/github:1' }])
  // No more than five show, the most recently active first.
  for (let n = 20; n < 27; n++) s.receive({ ...issue(n), id: `run-${n}`, threads: [{ source: 'github', id: '8' }, { source: 'github', id: String(n) }] })
  s.engine.evaluateDue()
  const many = await s.assessor.context('run-26', signal) as { correlated_threads?: { thread: string }[] }
  expect(many.correlated_threads!.map(item => item.thread)).toEqual(['github:26', 'github:25', 'github:24', 'github:23', 'github:22'])
  s.receive(issue(30)); s.engine.evaluateDue()
  expect(await s.assessor.context('issue-30', signal)).not.toHaveProperty('correlated_threads')
})
