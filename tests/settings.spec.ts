/**
 * Settings saves that race a model or account check, a Policy sync that a save outran, the refusals of the pause, a sync and a block, the
 * refusal of a tool's Policy or accept-mode change, and the pending Policy proposal
 */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})

it('refuses a tool save that changes the Policy or the accept mode, and lets a tool change the other eval fields and a sync the lists', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const policy = store.settings().policy, evaluation = store.settings().eval
  const mode = evaluation.mode === 'auto' ? 'observe' : 'auto'
  const savePolicy = (value: unknown, origin: 'tool' | 'sync' | 'panel') => settings.save('policy', value, store.blockRevision('policy'), origin)
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  const listed = { ...policy, sources: { ...policy.sources, github: { ...policy.sources.github!, allowed: [{ id: 'mallory' }] } } }
  for (const value of [{ ...policy, rules }, listed]) await expect(savePolicy(value, 'tool')).rejects.toMatchObject({ code: 'panelOnlyPolicy' })
  await expect(settings.save('eval', { ...evaluation, mode }, store.blockRevision('eval'), 'tool')).rejects.toMatchObject({ code: 'panelOnlyPolicy' })
  expect(store.settings()).toMatchObject({ policy, eval: evaluation })
  // A save that leaves authorization as it is, the other eval fields, and a Source's list sync are not refused.
  expect(await savePolicy(policy, 'tool')).toMatchObject({ saved: true, policy_changed: false })
  expect(await settings.save('eval', { ...evaluation, timeoutSeconds: 90 }, store.blockRevision('eval'), 'tool')).toMatchObject({ saved: true })
  expect(await savePolicy(listed, 'sync')).toMatchObject({ saved: true, policy_changed: true })
  expect(store.settings().policy.sources.github!.allowed).toEqual([{ id: 'mallory' }])
})

it('keeps one Policy proposal, the latest, refuses to accept it once its block changed, and dismisses it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const policy = store.settings().policy
  const first = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }], second = [{ ...first[0]!, name: 'Documentation' }]
  settings.propose('policy', { ...policy, rules: first }, store.blockRevision('policy'), 'first')
  expect(settings.propose('policy', { ...policy, rules: second }, store.blockRevision('policy'), 'second')).toMatchObject({ proposed: true })
  expect(settings.proposal()).toMatchObject({ block: 'policy', reason: 'second', value: { rules: second }, stale: false,
    changed: expect.arrayContaining(['policy.rules.0.id', 'policy.rules.0.name']) })
  // A save of the block after the proposal makes it stale: accepting it is refused and keeps it, for a person to dismiss.
  await settings.save('policy', { ...policy, rules: [] }, store.blockRevision('policy'), 'panel')
  expect(settings.proposal()).toMatchObject({ stale: true })
  await expect(settings.acceptProposal()).rejects.toThrow(SettingsConflict)
  expect(store.settings().policy.rules).toEqual([])
  expect(settings.dismissProposal()).toEqual({ dismissed: true })
  expect(settings.proposal()).toBeNull()
  expect(settings.dismissProposal()).toEqual({ dismissed: false })
  await expect(settings.acceptProposal()).rejects.toMatchObject({ code: 'noPolicyProposal', missing: true })
})
