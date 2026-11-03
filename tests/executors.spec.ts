import { expect, it, vi } from 'vitest'
import { Executors, chosenExecutor } from '../src/app/executors.ts'
import type { Assignment, Executor, Ticket } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'

const ticket = { id: 't1' } as Ticket
const assignment = (executor?: string): Assignment => ({ id: 'a1', state: 'pending', createdAt: '', ...executor ? { executor } : {} })
const fake = () => ({ start: vi.fn<Executor['start']>(), deliver: vi.fn<Executor['deliver']>(), stop: vi.fn<Executor['stop']>() })

it('sends each call to the Executor its Assignment names, an Assignment without a name to the DshExecutor\'s', () => {
  const unavailable = vi.fn()
  const executors = new Executors(unavailable)
  const dsh = fake(), other = fake()
  executors.register('dsh', dsh)
  const remove = executors.register('other', other)
  expect(() => executors.register('dsh', fake())).toThrow('exists already')
  expect(executors.names()).toEqual(['dsh', 'other'])
  executors.start(ticket, assignment())
  executors.deliver(ticket, assignment('other'))
  executors.stop(ticket, assignment('other'), 'retried')
  expect(dsh.start).toHaveBeenCalledWith(ticket, assignment())
  expect(other.deliver).toHaveBeenCalledOnce()
  expect(other.stop).toHaveBeenCalledWith(ticket, assignment('other'), 'retried')
  // An Executor removed again holds no Assignment; a start for it is unavailable, a delivery or a stop does nothing.
  remove()
  expect(executors.has('other')).toBe(false)
  executors.start(ticket, assignment('other'))
  executors.stop(ticket, assignment('other'), 'held')
  expect(unavailable).toHaveBeenCalledWith(ticket, assignment('other'), 'other')
  expect(other.start).not.toHaveBeenCalled()
})

it('chooses the Executor of the first matched rule that names one, else of the origin Source instance, else the DshExecutor', () => {
  const settings = SettingsSchema.parse({
    policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'x' }, { id: 'docs', name: 'Docs', enabled: true, instruction: 'y', executor: 'writer' }] },
    sources: { github: { enabled: true, config: {}, executor: 'ci' }, feishu: { enabled: true, config: {} } } })
  expect(chosenExecutor(settings, ['copy', 'docs'], 'github')).toBe('writer')
  expect(chosenExecutor(settings, ['copy'], 'github')).toBe('ci')
  expect(chosenExecutor(settings, [], 'feishu')).toBe('dsh')
  expect(chosenExecutor(settings, [], undefined)).toBe('dsh')
  expect(() => SettingsSchema.parse({ sources: { github: { enabled: true, config: {}, executor: 'Not A Name' } } })).toThrow()
})
