/**
 * Who decides a person's follow-up, as a state-transition table: each row starts a message in one state on one ticket, applies
 * one event, and checks what the state it ends in means. The rows are the rules of docs 002 and 003; they read only what the
 * Engine shows, so the table holds whatever the Engine stores.
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, followupOwners, runningAssignment } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Policy, Ticket, Trigger } from '../src/core/index.ts'

const member = { source: 'chat', id: 'alice' }
const guest = { source: 'chat', id: 'guest' }
const on = (thread: string) => ({ threads: [{ source: 'chat', id: thread }] })
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`,
    text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}

/** An Engine on memory repositories whose Executor starts and delivers when `settle` says, with a gate that admits people. */
function harness() {
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const deliveries = new Set<string>()
  const executor: Executor = { start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }),
    deliver: vi.fn(ticket => { deliveries.add(ticket.id) }), stop: vi.fn() }
  let version = 'v1', paused = false, clock = 0
  const policy: Policy = {
    get version() { return version }, get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' }
      : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked',
    admitsInferred: rules => rules.length > 0,
  }
  const engine = new Engine({ repo, policy: () => policy, assessor, executor,
    scope: { scope: () => ({ listened: true, observed: false }) },
    outbox: { send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
      status: id => outbox.some(item => item.id === id) ? 'pending' : undefined, withdraw: () => {} },
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() } satisfies EngineOptions)
  /** Start the queued Assignments and hand their tickets the Inputs that wait. */
  function settle() {
    for (;;) {
      const next = launches.shift()
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const [ticketId] = deliveries
      if (ticketId === undefined) return
      deliveries.delete(ticketId)
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (!ticket.ended && assignment && ticket.undelivered.length) engine.inputsDelivered(ticketId, assignment.id, [...ticket.undelivered])
    }
  }
  const h = {
    repo, engine, requests,
    pump: () => { engine.evaluateDue(); settle() },
    settle,
    tick: () => { clock += 1 },
    setVersion: (value: string) => { version = value },
    setPaused: (value: boolean) => { paused = value },
    /** A ticket accepted from message `id` on `thread`, running, with its first Inputs delivered. */
    ticket(id: string, thread = 't1'): string {
      engine.receive(trigger(id, on(thread))); h.pump()
      const candidate = requests.at(-1)!
      const decision = engine.decide(id, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', evalId: candidate.evalId })
      settle(); clock += 1
      return decision.ticketId!
    },
    /** A person's message `id` that arrives now. */
    receive(id: string, overrides: Partial<Trigger> = {}): string { clock += 1; engine.receive(trigger(id, overrides)); settle(); return id },
    /** The worker's Session takes every Trigger Input it has not read into a step. */
    read(ticketId: string): void {
      clock += 1
      engine.inputsRead(ticketId, repo.tickets.get(ticketId)!.inputs.flatMap(input => input.kind === 'trigger' && input.readAt === null ? [input.id] : []))
    },
    report(ticketId: string, state: 'progress' | 'ready' | 'dropped' | 'waiting' | 'blocked', answers?: string): void {
      clock += 1; engine.report(ticketId, { state, summary: state, ...answers ? { answers } : {} })
    },
    ack(ticketId: string, triggerId: string): void { clock += 1; engine.reply({ purpose: 'acknowledgement', ticketId, triggerId, text: 'On it' }) },
    stop(ticketId: string): void { clock += 1; engine.stopTicket(ticketId, 'not needed') },
    owners: (triggerId: string) => followupOwners(repo.triggers.get(triggerId)!, repo),
    /** Whether the message waits for an Eval, or one holds it. */
    queued(triggerId: string): boolean {
      const thread = repo.threads.get(`chat:${repo.triggers.get(triggerId)!.threads[0]!.id}`)!
      return thread.pending.includes(triggerId) || !!thread.evaluating?.triggerIds.includes(triggerId)
    },
    copies: (ticketId: string, triggerId: string) => repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger'
      && input.triggerId === triggerId).length,
    ended: (ticketId: string) => repo.tickets.get(ticketId)!.ended,
  }
  return h
}
type Harness = ReturnType<typeof harness>
const accept = { kind: 'accept' as const, title: 'Other', scope: 'small', reason: 'requested' }
const decides = (...tickets: string[]) => new UserError('workerDecides', { tickets: tickets.join(', ') })

/**
 * One rule: the state a message is in on a ticket before, the event, the state after, and the check of what that state
 * means. `none` is a ticket the message did not reach.
 */
interface Row { from: string; event: string; to: string; doc: '002' | '003'; check: (h: Harness) => void }

const rows: Row[] = [
  // Reaching a ticket.
  { from: 'none', event: 'a person writes on a Thread of the live ticket', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', { actor: guest })
    expect([h.owners('2'), h.queued('2'), h.requests.length]).toEqual([[k], false, 1])
  } },
  { from: 'none', event: 'a person writes on a Thread of a ticket its worker ended', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.report(k, 'ready')
    h.receive('2', { actor: guest })
    expect([h.ended(k), h.owners('2'), h.queued('2')]).toEqual([undefined, [k], false])
  } },
  { from: 'none', event: 'a person writes on a Thread of an ended ticket while processing is paused', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.report(k, 'dropped')
    h.setPaused(true); h.receive('2'); h.pump()
    // The message waits to resume the ticket, which decides it meanwhile.
    expect([!!h.ended(k), h.owners('2'), h.queued('2')]).toEqual([true, [k], false])
    h.setPaused(false); h.pump()
    expect([h.ended(k), h.owners('2')]).toEqual([undefined, [k]])
  } },
  { from: 'none', event: 'a person writes on a Thread of an ended ticket whose Mandate no longer holds', to: 'released', doc: '002', check: h => {
    const k = h.ticket('1')
    h.report(k, 'ready')
    h.setVersion('revoked'); h.receive('2'); h.setVersion('v1')
    expect([!!h.ended(k), h.owners('2'), h.queued('2')]).toEqual([true, [], true])
  } },
  { from: 'none', event: 'a person writes on a Thread of a ticket a person stopped', to: 'none', doc: '002', check: h => {
    const k = h.ticket('1')
    h.stop(k)
    h.receive('2')
    expect([h.copies(k, '2'), h.owners('2'), h.queued('2')]).toEqual([0, [], true])
  } },
  { from: 'none', event: 'a bot writes on a Thread of the ticket', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', { human: false })
    // The ticket gets it but does not decide it: it goes to Eval as well. An ended ticket does not get it.
    expect([h.copies(k, '2'), h.owners('2'), h.queued('2')]).toEqual([1, [], true])
    h.report(k, 'ready')
    h.receive('3', { human: false })
    expect([!!h.ended(k), h.copies(k, '3')]).toEqual([true, 0])
  } },
  { from: 'none', event: 'a person writes on a Thread the ticket follows for context', to: 'context', doc: '002', check: h => {
    const k = h.ticket('1')
    h.engine.followForContext(k, { source: 'chat', id: 'issue' })
    h.receive('2', on('issue'))
    expect([h.copies(k, '2'), h.owners('2'), h.queued('2')]).toEqual([1, [], true])
    // There it resumes no ended ticket.
    h.report(k, 'dropped')
    h.receive('3', on('issue'))
    expect([!!h.ended(k), h.copies(k, '3')]).toEqual([true, 0])
  } },
  { from: 'none', event: 'a person writes on a Thread two live tickets have', to: 'delivered', doc: '002', check: h => {
    const a = h.ticket('1'), b = h.ticket('2', 't2')
    h.engine.bindThread(b, { source: 'chat', id: 't1' }, false)
    h.receive('3')
    expect(h.owners('3')).toEqual([a, b])
  } },
  // What the main Session and people may do while a ticket decides it.
  { from: 'delivered', event: 'the main Session routes it', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1'), other = h.ticket('5', 't5')
    h.receive('2')
    expect(() => h.engine.decide('2', accept)).toThrow(decides(k))
    expect(() => h.engine.decide('2', { kind: 'ignore', reason: 'chat' })).toThrow(decides(k))
    expect(() => h.engine.attach(other, '2')).toThrow(decides(k))
    expect(h.engine.decide('2', { kind: 'hold', ticketId: k, reason: 'pause' }).kind).toBe('hold')
    expect(h.owners('2')).toEqual([k])
  } },
  { from: 'delivered', event: 'the main Session stops the ticket on it', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', { actor: guest })
    // A guest's follow-up is inferred, so its stop stops nothing; a member's stops the ticket.
    expect(h.engine.decide('2', { kind: 'stop', ticketId: k, reason: 'stop' })).toMatchObject({ kind: 'ignore', reason: [{ code: 'stopNotExplicit' }] })
    h.receive('3')
    expect(h.engine.decide('3', { kind: 'stop', ticketId: k, reason: 'stop' }).kind).toBe('stop')
    // The main Session that stopped it on the message decides the rest of it, and it goes to no Eval.
    expect([h.ended(k)?.by, h.queued('3'), h.engine.decide('3', accept).kind]).toEqual(['human', false, 'accept'])
  } },
  { from: 'delivered', event: 'a person sends it to Eval', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2')
    expect(h.engine.reevaluate('2')).toBe(true)
    expect([h.owners('2'), h.queued('2')]).toEqual([[], true])
    expect(h.copies(k, '2')).toBe(1)
  } },
  { from: 'delivered', event: 'an Eval an earlier version started holds it', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2')
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'e-legacy', threadKey: 'chat:t1', triggerIds: ['2'], strength: 'explicit', actor: member,
      basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '2026-09-23T00:00:00Z', deadline: '2026-09-24T00:00:00Z' } })
    expect(h.owners('2')).toEqual([])
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'chat', evalId: 'e-legacy' }).kind).toBe('ignore')
    expect(h.ended(k)).toBeUndefined()
  } },
  { from: 'delivered', event: 'an Eval starts with it queued by an earlier version', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2')
    h.repo.threads.save({ ...h.repo.threads.get('chat:t1')!, pending: ['2'] })
    h.pump()
    expect([h.queued('2'), h.owners('2'), h.repo.decisions.byThread('chat:t1').length]).toEqual([false, [k], 1])
  } },
  { from: 'delivered', event: 'a person drops the Subscriptions of its Thread', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2')
    expect(h.engine.unsubscribe('chat:t1')).toBe(true)
    expect(h.owners('2')).toEqual([k])
  } },
  // The main Session attaches it.
  { from: 'none', event: 'the main Session attaches it', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', on('x')); h.pump()
    h.engine.attach(k, '2'); h.settle()
    expect([h.copies(k, '2'), h.owners('2'), h.queued('2')]).toEqual([1, [k], false])
  } },
  { from: 'none', event: 'the main Session attaches it to an ended ticket', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.report(k, 'dropped')
    h.receive('2', on('x')); h.pump()
    h.engine.attach(k, '2')
    expect([h.ended(k), h.owners('2')]).toEqual([undefined, [k]])
  } },
  { from: 'context', event: 'the main Session attaches it', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.engine.followForContext(k, { source: 'chat', id: 'issue' })
    h.receive('2', on('issue')); h.pump()
    h.engine.attach(k, '2'); h.settle()
    // Its worker gets it again as the ticket's own, and the Thread is the ticket's own from then on.
    expect([h.copies(k, '2'), h.owners('2'), h.repo.threads.get('chat:issue')!.context]).toEqual([2, [k], []])
  } },
  { from: 'released', event: 'the main Session attaches it', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.report(k, 'progress')
    h.receive('2')
    h.report(k, 'dropped')
    expect([h.owners('2'), h.queued('2')]).toEqual([[], true])
    h.pump()
    h.engine.attach(k, '2'); h.settle()
    expect([h.ended(k), h.copies(k, '2'), h.owners('2')]).toEqual([undefined, 2, [k]])
  } },
  { from: 'delivered', event: 'the main Session attaches it back after a person sent it to Eval', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2')
    h.report(k, 'progress')
    h.engine.reevaluate('2'); h.pump()
    h.engine.attach(k, '2')
    expect([h.copies(k, '2'), h.owners('2')]).toEqual([2, [k]])
  } },
  { from: 'delivered', event: 'the main Session attaches a bot\'s message the worker has, with a note', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', { human: false }); h.pump()
    // The worker has the message, so the note comes with it again; a bot's message is still no ticket's to decide.
    h.engine.attach(k, '2', 'Also see the log'); h.settle()
    expect([h.copies(k, '2'), h.owners('2')]).toEqual([2, []])
  } },
  { from: 'delivered', event: 'the main Session attaches it to the ticket that decides it', to: 'delivered', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2')
    expect(() => h.engine.attach(k, '2', 'note')).toThrow(decides(k))
  } },
  { from: 'handedBack', event: 'the main Session attaches it to the same ticket', to: 'handedBack', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2')
    h.engine.handback(k, '2', 'Not this ticket')
    expect(() => h.engine.attach(k, '2')).toThrow(new UserError('handedBackHere'))
  } },
  { from: 'none', event: 'the main Session attaches it to a ticket a person stopped or whose Mandate no longer holds', to: 'none', doc: '002',
    check: h => {
      const stopped = h.ticket('1'), revoked = h.ticket('5', 't5')
      h.stop(stopped); h.report(revoked, 'dropped')
      h.receive('2', on('x')); h.pump()
      expect(() => h.engine.attach(stopped, '2')).toThrow(new UserError('ticketStopped'))
      h.setVersion('revoked')
      expect(() => h.engine.attach(revoked, '2')).toThrow(new UserError('mandateRevoked'))
    } },
  // The worker reads it, takes it up or hands it back.
  { from: 'delivered', event: 'the worker\'s Session takes it into a step, and the worker reports', to: 'read', doc: '003', check: h => {
    const k = h.ticket('1')
    h.receive('2'); h.read(k)
    h.report(k, 'progress')
    // Read before the report, it stays with the ticket at its end and goes to no Eval.
    h.report(k, 'dropped')
    expect([h.queued('2'), h.owners('2')]).toEqual([false, []])
  } },
  { from: 'delivered', event: 'the worker\'s Session takes it into a step, and its turn ends', to: 'read', doc: '003', check: h => {
    const k = h.ticket('1')
    h.receive('2'); h.read(k)
    h.tick(); h.engine.turnEnded(k, runningAssignment(h.repo.tickets.get(k)!)!.id)
    h.stop(k)
    expect(h.queued('2')).toBe(false)
  } },
  { from: 'delivered', event: 'the worker acknowledges it', to: 'taken', doc: '002', check: h => {
    const k = h.ticket('1')
    h.report(k, 'progress')
    h.receive('2'); h.ack(k, '2')
    expect(h.owners('2')).toEqual([k])
    // Taken up, it is not let go at the end, unread as it is.
    h.report(k, 'dropped')
    expect(h.queued('2')).toBe(false)
  } },
  { from: 'read', event: 'the worker answers it in a report', to: 'taken', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2'); h.read(k)
    h.report(k, 'ready', '2')
    expect([!!h.ended(k), h.queued('2')]).toEqual([true, false])
  } },
  { from: 'taken', event: 'a pull request the ticket opened merges before the worker reports again', to: 'taken', doc: '003', check: h => {
    const k = h.ticket('1')
    h.engine.bindThread(k, { source: 'gh', id: 'pr-9' }, true)
    h.report(k, 'ready')
    h.receive('2'); h.ack(k, '2')
    h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
    // The close waits for the work on the message; the next ready report ends the ticket as the close did.
    expect(h.ended(k)).toBeUndefined()
    h.report(k, 'ready')
    expect(h.ended(k)).toMatchObject({ outcome: 'merged' })
  } },
  { from: 'delivered', event: 'the worker hands it back', to: 'handedBack', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2')
    expect(h.engine.handback(k, '2', 'A new request')).toBe(true)
    expect([h.owners('2'), h.queued('2'), h.repo.threads.get('chat:t1')!.subscriptions]).toEqual([[], true, [k]])
    expect(() => h.engine.handback(k, '2', 'Again')).toThrow(new UserError('handedBack'))
  } },
  { from: 'taken', event: 'the worker hands it back', to: 'handedBack', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2'); h.ack(k, '2')
    expect(h.engine.handback(k, '2', 'For another ticket after all')).toBe(true)
    expect([h.owners('2'), h.queued('2')]).toEqual([[], true])
  } },
  { from: 'delivered', event: 'one of two tickets that decide it hands it back', to: 'handedBack', doc: '002', check: h => {
    const a = h.ticket('1'), b = h.ticket('5', 't5')
    h.engine.bindThread(b, { source: 'chat', id: 't1' }, false)
    h.receive('2')
    expect(h.engine.handback(a, '2', 'For the other ticket')).toBe(false)
    expect([h.owners('2'), h.queued('2')]).toEqual([[b], false])
    expect(h.engine.handback(b, '2', 'Neither ticket')).toBe(true)
    expect(h.queued('2')).toBe(true)
  } },
  { from: 'context', event: 'the worker hands it back', to: 'handedBack', doc: '002', check: h => {
    const k = h.ticket('1')
    h.engine.followForContext(k, { source: 'chat', id: 'issue' })
    h.receive('2', on('issue')); h.pump()
    h.engine.decide('2', { kind: 'ignore', reason: 'chat', evalId: h.requests.at(-1)!.evalId })
    // It went to Eval without the ticket, so nothing is queued, but the hand-back stands.
    expect([h.engine.handback(k, '2', 'Not this ticket'), h.queued('2')]).toEqual([false, false])
    expect(() => h.engine.attach(k, '2')).toThrow(new UserError('handedBackHere'))
  } },
  { from: 'delivered', event: 'the worker hands back a message the ticket does not decide', to: 'handedBack', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', { human: false }); h.receive('3'); h.engine.reevaluate('3'); h.pump()
    for (const id of ['2', '3']) expect(h.engine.handback(k, id, 'Not this ticket')).toBe(false)
  } },
  { from: 'delivered', event: 'the worker marks the Thread unrelated', to: 'handedBack', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', on('x')); h.pump()
    h.engine.attach(k, '2'); h.settle()
    h.receive('3', on('x'))
    h.engine.markUnrelated(k, 'chat:x', 'about something else')
    expect([h.owners('2'), h.owners('3'), h.repo.threads.get('chat:x')!.pending]).toEqual([[], [], ['2', '3']])
  } },
  // The ticket ends.
  { from: 'delivered', event: 'the ticket ends before its worker got it', to: 'released', doc: '002', check: h => {
    for (const [message, thread] of [['2', 't1'], ['6', 't5']] as const) {
      const k = h.ticket(message === '2' ? '1' : '5', thread)
      h.tick(); h.engine.receive(trigger(message, on(thread)))
      if (message === '2') h.report(k, 'dropped')
      else h.stop(k)
      expect([h.owners(message), h.queued(message)]).toEqual([[], true])
    }
  } },
  { from: 'delivered', event: 'the ticket ends before its worker\'s Session took it into a step', to: 'released', doc: '003', check: h => {
    const k = h.ticket('1')
    h.report(k, 'progress')
    h.receive('2')
    h.report(k, 'dropped')
    expect([h.owners('2'), h.queued('2')]).toEqual([[], true])
  } },
  { from: 'read', event: 'the ticket ends before the worker reported or ended a turn after reading it', to: 'released', doc: '003', check: h => {
    const k = h.ticket('1')
    h.report(k, 'progress')
    h.receive('2'); h.read(k)
    h.stop(k)
    expect(h.queued('2')).toBe(true)
  } },
  { from: 'taken', event: 'another ticket that decides it ends without taking it up', to: 'taken', doc: '002', check: h => {
    const a = h.ticket('1'), b = h.ticket('5', 't5')
    h.engine.bindThread(b, { source: 'chat', id: 't1' }, false)
    h.receive('2'); h.ack(a, '2')
    h.report(a, 'dropped')
    h.report(b, 'dropped')
    // One ticket took it up, so it goes to no Eval.
    expect([h.owners('2'), h.queued('2')]).toEqual([[], false])
  } },
  { from: 'delivered', event: 'the ticket ends after a stop of it on another ticket was refused', to: 'released', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', { actor: guest })
    h.engine.decide('2', { kind: 'stop', ticketId: k, reason: 'stop' })
    h.report(k, 'dropped')
    expect(h.queued('2')).toBe(true)
  } },
  { from: 'delivered', event: 'a stop on it ends the ticket that kept it after another handed it back', to: 'released', doc: '002', check: h => {
    const a = h.ticket('1'), b = h.ticket('5', 't5')
    h.engine.bindThread(b, { source: 'chat', id: 't1' }, false)
    h.receive('2')
    h.engine.handback(b, '2', 'For the first ticket')
    h.engine.decide('2', { kind: 'stop', ticketId: a, reason: 'stop' })
    expect(h.queued('2')).toBe(true)
  } },
  { from: 'delivered', event: 'the ticket ends after an Eval of the attached message was unavailable', to: 'released', doc: '002', check: h => {
    const k = h.ticket('1')
    h.receive('2', on('x')); h.pump()
    h.engine.decide('2', { kind: 'unavailable', reason: 'model down', evalId: h.requests.at(-1)!.evalId })
    h.engine.attach(k, '2'); h.settle()
    h.report(k, 'dropped')
    expect(h.queued('2')).toBe(true)
  } },
  { from: 'context', event: 'the ticket ends', to: 'released', doc: '002', check: h => {
    const k = h.ticket('1')
    h.engine.followForContext(k, { source: 'chat', id: 'issue' })
    h.receive('2', on('issue')); h.pump()
    h.engine.decide('2', { kind: 'ignore', reason: 'chat', evalId: h.requests.at(-1)!.evalId })
    h.report(k, 'dropped')
    // It was none of the ticket's, so its end sends nothing to Eval; attached later, the worker gets it as its own.
    expect(h.queued('2')).toBe(false)
    h.engine.attach(k, '2')
    expect([h.ended(k), h.copies(k, '2'), h.owners('2')]).toEqual([undefined, 2, [k]])
  } },
  { from: 'read', event: 'the ticket ends and later resumes', to: 'read', doc: '003', check: h => {
    const k = h.ticket('1')
    h.receive('2'); h.read(k)
    h.report(k, 'ready')
    expect(h.owners('2')).toEqual([])
    // A later message resumes the ticket, which decides again what it read and kept.
    h.receive('3')
    expect([h.ended(k), h.owners('2'), h.owners('3')]).toEqual([undefined, [k], [k]])
  } },
  // Rules the table found wrong, which later commits change.
  { from: 'taken', event: 'the worker that took it up hands it back, and the other ticket ends without taking it up', to: 'handedBack',
    doc: '002', check: h => {
      const a = h.ticket('1'), b = h.ticket('5', 't5')
      h.engine.bindThread(b, { source: 'chat', id: 't1' }, false)
      h.receive('2'); h.ack(a, '2')
      h.engine.handback(a, '2', 'For the other ticket')
      h.report(b, 'dropped')
      // The hand-back undoes the take-up: no ticket decides it, so it goes to Eval as it would have had the ticket that
      // handed it back been the only one.
      expect(h.queued('2')).toBe(true)
    } },
  { from: 'none', event: 'a ticket it did not reach acknowledges it, and the ticket that decides it ends without taking it up', to: 'none',
    doc: '002', check: h => {
      const a = h.ticket('1')
      h.receive('2')
      const b = h.ticket('5', 't5')
      h.engine.bindThread(b, { source: 'chat', id: 't1' }, false)
      h.ack(b, '2')
      expect(h.owners('2')).toEqual([a])
      h.report(a, 'dropped')
      // Locked as found: the acknowledgement of a ticket that never decided it keeps it from Eval.
      expect(h.queued('2')).toBe(false)
    } },
]

describe('follow-up ownership table', () => {
  it.each(rows.map(row => [`${row.from} → ${row.to}: ${row.event} (${row.doc})`, row] as const))('%s', (_, row) => { row.check(harness()) })
})
