import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { feishuChannel, feishuTrigger, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { issueTrigger, pullTrigger } from '../src/sources/github-trigger.ts'
import { instanceHealth, instanceIdError } from '../src/sources/kind.ts'

const probe: SourceKind<{ interval: number }> = {
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  fields: [{ key: 'interval', type: 'number', min: 1, max: 60, label: { zh: '间隔', en: 'Interval' } }],
}

describe('Source registry', () => {
  it('lists every installed kind with defaults, in id order, followed by stored instances whose kind is not installed', () => {
    const settings = SettingsSchema.parse({ sources: { probe: { enabled: false, config: { interval: 9 } }, retired: { enabled: true, config: { x: 1 } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(probe); sources.register(githubKind)
    expect(sources.instances()).toEqual([
      { id: 'github', kind: 'github', enabled: true, config: { repository: '', cli: '', pollSeconds: 60, failuresBeforeError: 3,
        observeIssues: false, observePulls: false, observeComments: false, observeCi: false }, installed: true },
      { id: 'probe', kind: 'probe', enabled: false, config: { interval: 9 }, installed: true },
      { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false },
    ])
  })
  it('validates submitted instances with the kind schema and refuses kinds that are not installed', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(probe)
    expect(sources.validate('probe', { enabled: true, config: {} })).toEqual({ kind: 'probe', enabled: true, config: { interval: 5 } })
    expect(() => sources.validate('probe', { enabled: true, config: { interval: 0 } })).toThrow()
    expect(() => sources.validate('missing', { enabled: true, config: {} })).toThrow('not installed')
  })
  it('sends, links and reads a kind\'s Threads through its own channel and context, and nothing for a kind without them', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { probe: { enabled: true, config: { interval: 7 } } } }))
    const sent: OutboundMessage[] = []
    const read: unknown[] = []
    sources.register({ ...probe,
      channel: { send: async (_host, message) => { sent.push(message); return 'sent' },
        link: address => ({ url: `https://probe/${address.room}`, label: { zh: '探针', en: 'Probe' } }) },
      threadContext: { messageId: trigger => String(trigger.meta.id), read: async (_commands, trigger, part, cursor, config) => {
        read.push([trigger.id, part, cursor, config.interval])
        return { messages: [{ id: 'm1', from: 'u', at: '1', text: '' }],
          body: { page: cursor ?? 'first' } }
      } } })
    const commands = { forSource() { return commands } } as unknown as Commands
    const message = (source: string): OutboundMessage => ({ id: 'r1', channel: { source, thread: 'probe:1', address: { room: 'r' } },
      text: 'hi', kind: 'reply' })
    expect(await sources.send(message('probe'), commands)).toBe('sent')
    expect(sent).toEqual([message('probe')])
    // A kind that is not installed keeps its replies waiting; links to it have no page.
    expect(await sources.send(message('retired'), commands)).toBe('waiting')
    expect(sources.link(message('probe').channel, {})).toEqual({ url: 'https://probe/r', label: { zh: '探针', en: 'Probe' } })
    expect(sources.link(message('retired').channel, {})).toEqual({ url: '', label: { zh: 'retired', en: 'retired' } })
    const trigger = { id: 't1', source: 'probe', threads: [{ source: 'probe', id: '1' }], actor: { source: 'probe', id: 'u' }, human: true,
      at: '', text: 'hi', meta: { id: 'm1' } }
    const context = sources.threadContext(trigger)!
    expect(context.messageId).toBe('m1')
    expect(await context.read(commands, 'thread', '2')).toMatchObject({ body: { page: '2' } })
    expect(read).toEqual([['t1', 'thread', '2', 7]])
    expect(context.images('img_x')).toEqual([])
    await expect(context.image({} as Agent, commands, { id: 'm1', text: '' }, 'img_x', '',
      new AbortController().signal)).rejects.toThrow('no images')
    // A kind without a channel or a context has neither.
    sources.register({ ...probe, kind: 'quiet' })
    expect(await sources.send(message('quiet'), commands)).toBe('gone')
    expect(sources.threadContext({ ...trigger, source: 'quiet' })).toBeUndefined()
  })
  it('refuses a kind that declares a health entry another kind or dsh-superagent itself reports, and gives up its entries at unregister', () => {
    const board = new HealthBoard()
    // Pre-claim built-in health entries; sync:* entries are reserved for settings sync.
    for (const name of ['runtime', 'reply']) board.claim(name)
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const unregister = sources.register(githubKind)
    expect(() => sources.register({ ...probe, health: ['github'] })).toThrow('declares the health entry github')
    for (const name of ['runtime', 'reply', 'sync:github']) expect(() => sources.register({ ...probe, health: ['probe', name] })).toThrow(name)
    expect(sources.kind('probe')).toBeUndefined()
    sources.register({ ...probe, health: ['probe'] })
    const deps = { sources, commands: { forSource: () => ({}) } } as unknown as SourceContextDeps
    const context = (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind)
    const first = context(githubKind)
    first.report('github', { state: 'ready', detail: 'ok' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => first.report('probe', { state: 'ready', detail: '' })).toThrow('has no health entry probe')
    // A report sent after its kind unregisters (such as from an exiting CLI listener) is ignored and does not affect a later registration.
    unregister()
    expect(() => first.report('github', { state: 'error', detail: 'WARN exiting' })).not.toThrow()
    expect(board.all.github).toBeUndefined()
    sources.register(githubKind)
    first.report('github', { state: 'error', detail: 'late' })
    expect(board.all.github).toEqual({ state: 'starting', detail: '' })
    context(githubKind).report('github', { state: 'ready', detail: 'again' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'again' })
  })
  it('names the Trigger whose message a Trigger\'s message answers, where its kind can', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind); sources.register(githubKind)
    const reply = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user',
      content: 'yes', create_time: '1757376000000', parent_id: 'om_1' }, 'ou_bot', 'cli_bot')!
    expect(sources.repliesTo(reply)).toBe(feishuTriggerId('om_1'))
    expect(sources.repliesTo({ ...reply, meta: { ...reply.meta, parentId: undefined } })).toBeUndefined()
    expect(sources.repliesTo({ ...reply, source: 'github' })).toBeUndefined()
  })
  it('finds what a search query names in each kind\'s terms', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.find('#12')).toEqual({ threads: ['github:12'], terms: [] })
    expect(sources.find('https://github.com/acme/widgets/pull/7#issuecomment-3')).toEqual({ threads: ['github:7'], terms: [] })
    expect(sources.find('see om_abc and om_abc, om_def')).toEqual({ threads: [], terms: ['om_abc', 'om_def'] })
    expect(sources.find('login fails')).toEqual({ threads: [], terms: [] })
    expect(feishuKind.policy!.unnamed).toEqual({ person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } })
  })
  it('refuses a second registration of one kind and forgets a kind after its disposer runs', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    const dispose = sources.register(probe)
    expect(() => sources.register(probe)).toThrow('already registered')
    dispose()
    expect(sources.instance('probe')).toBeUndefined()
  })
  it('validates each Source\'s part of the Policy with its kind, keeping parts of kinds that are not installed as stored', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } }))
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.validatePolicy({ feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] }, retired: { allowed: [], x: 1 } }))
      .toEqual({ feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: '', admission: {} }, retired: { allowed: [], x: 1 } })
    expect(() => sources.validatePolicy({ feishu: { allowed: [{ id: 'alice' }] } })).toThrow()
    expect(sources.policyPart('feishu')).toEqual({ allowed: [{ id: 'ou_alice' }], syncChat: '', admission: {} })
    expect(sources.policyPart('github')).toEqual({ allowed: [], admission: {} })
    sources.register(probe)
    expect(sources.policyPart('probe')).toBeUndefined()
  })
  it('allows a reply only on a Channel whose Source still listens to its chat', () => {
    const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }], directMessages: false } } } })
    const sources = new SourceRegistry(() => settings)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(false)
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_other' } })).toBe(false)
    // A direct chat's id starts with oc_ too; the address says it is direct, and with direct messages off it gets no reply.
    expect(sources.channelAllowed(feishuChannel('oc_dm', 'om_1', true))).toBe(false)
    expect(sources.channelAllowed({ source: 'github', address: { number: '7' } })).toBe(true)
  })
  it('delivers a reply to a direct message under the default settings', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind)
    const trigger = feishuTrigger({ message_id: 'om_dm', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: 'ou_alice', sender_type: 'user',
      content: 'fix it', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    const channel = trigger.channel!
    expect(channel.address).toEqual({ chatId: 'oc_dm', messageId: 'om_dm', direct: 'true' })
    expect(sources.channelAllowed(channel)).toBe(true)
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('{"ok":true,"data":{}}')
    const reply: OutboundMessage = { id: 'reply-1', channel, text: 'Done', kind: 'reply' }
    expect(await sources.send(reply, commands)).toBe('sent')
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['+messages-reply', '--message-id', 'om_dm']))
  })
})

describe('Source instances', () => {
  const twoRepositories = () => SettingsSchema.parse({ sources: {
    github: { kind: 'github', enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } },
    'github-docs': { kind: 'github', enabled: true, config: { repository: 'acme/docs', cli: 'gh' } },
    'github-archive': { kind: 'github', enabled: false, config: { repository: 'acme/archive', cli: 'gh' } },
  } })
  it('lists a kind\'s first instance before its other instances and dispatches each by its stored kind', () => {
    const settings = twoRepositories()
    const sources = new SourceRegistry(() => settings)
    sources.register(githubKind); sources.register(feishuKind)
    expect(sources.instances().map(instance => [instance.id, instance.kind, instance.enabled]))
      .toEqual([['feishu', 'feishu', true], ['github', 'github', true], ['github-archive', 'github', false], ['github-docs', 'github', true]])
    expect(sources.kindOf('github-docs')).toBe(githubKind)
    expect(sources.kindOf('feishu')).toBe(feishuKind)
    expect(sources.kindOf('github-missing')).toBeUndefined()
    expect(sources.instance('github-docs')).toMatchObject({ id: 'github-docs', kind: 'github', config: { repository: 'acme/docs' } })
    // Each instance answers with its own configuration and scope.
    expect(sources.scope({ source: 'github-archive', meta: {} })).toEqual({ listened: false, reason: 'source_disabled' })
    expect(sources.channelAllowed({ source: 'github-docs', address: { number: '7' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'github-archive', address: { number: '7' } })).toBe(false)
    // A submitted instance validates with its stored kind; a new one names its kind.
    expect(sources.validate('github-docs', { enabled: true, config: { repository: 'acme/docs' } })).toMatchObject({ kind: 'github', config: { repository: 'acme/docs' } })
    expect(sources.validate('github-new', { enabled: false, config: {} }, settings, 'github')).toMatchObject({ kind: 'github', enabled: false })
    expect(() => sources.validate('github-new', { enabled: false, config: {} })).toThrow('not installed: github-new')
  })
  it('names the instance a Trigger came from as its home, and the kind\'s first instance for any other Source', () => {
    const sources = new SourceRegistry(twoRepositories)
    sources.register(githubKind); sources.register(feishuKind)
    expect(sources.home('github', 'github-docs')).toBe('github-docs')
    expect(sources.home('github', 'github')).toBe('github')
    expect(sources.home('github', 'feishu')).toBe('github')
    expect(sources.home('github', undefined)).toBe('github')
    expect(sources.home('feishu', 'github-docs')).toBe('feishu')
  })
  it('finds a page of each repository in the instance that receives it, and a bare number in every instance', () => {
    const sources = new SourceRegistry(twoRepositories)
    sources.register(githubKind)
    expect(sources.find('https://github.com/acme/docs/pull/7')).toEqual({ threads: ['github-docs:7'], terms: [] })
    expect(sources.find('https://github.com/ACME/widgets/issues/3')).toEqual({ threads: ['github:3'], terms: [] })
    expect(sources.find('#12')).toEqual({ threads: ['github:12', 'github-archive:12', 'github-docs:12'], terms: [] })
  })
  it('keeps each instance\'s part of the Policy, validated with its kind', () => {
    const settings = SettingsSchema.parse({ ...twoRepositories(), policy: { sources: { 'github-docs': { allowed: [{ id: 'carol' }] } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(githubKind)
    expect(sources.policyPart('github-docs')).toEqual({ allowed: [{ id: 'carol' }], admission: {} })
    expect(sources.policyPart('github')).toEqual({ allowed: [], admission: {} })
    expect(() => sources.validatePolicy({ 'github-docs': { allowed: [{ id: 'ou_x y' }] } })).toThrow()
  })
  it('sends, and reads thread context, with commands scoped to the Channel\'s instance', async () => {
    const sources = new SourceRegistry(twoRepositories)
    sources.register(githubKind)
    const commands = new Commands(() => testDeployment({ repositories: { github: 'acme/widgets', 'github-docs': 'acme/docs' } }), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('[]')
    const message: OutboundMessage = { id: 'r1', channel: { source: 'github-docs', thread: 'github-docs:7', address: { number: '7' } }, text: 'hi', kind: 'reply' }
    await sources.send(message, commands).catch(() => undefined)
    // The spy on the unscoped commands sees the calls, made by commands whose repository is the instance's.
    const paths = run.mock.calls.flatMap(call => call[1]).filter(arg => arg.startsWith('repos/'))
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every(path => path.startsWith('repos/acme/docs/'))).toBe(true)
    expect(commands.repository).toBe('acme/widgets')
    expect(commands.forSource('github')).toBe(commands)
    expect(() => commands.forSource('github-missing').repository).toThrow('The Source github-missing has no repository')
  })
  it('contributes the variables of the instance a Ticket came from, and of the first instance for a Ticket from another Source', () => {
    const sources = new SourceRegistry(twoRepositories)
    sources.register(githubKind); sources.register(feishuKind)
    const deployment = testDeployment({ repositories: { github: 'acme/widgets', 'github-docs': 'acme/docs' } })
    const values = (origin: string | undefined, trigger?: Parameters<NonNullable<typeof githubKind.environment>['values']>[0]['trigger']) => {
      const found = sources.environments(undefined, origin).find(item => item.kind.kind === 'github')!
      return found.environment.values({ deployment, instance: found.instance, config: found.config, trigger })
    }
    const opened = { number: 7, title: 'Docs', body: '', html_url: 'https://github.com/acme/docs/pull/7', created_at: '2026-01-01T00:00:00Z',
      user: { login: 'alice', type: 'User' } }
    const docs = pullTrigger(opened as never, 'agent-bot', 'github-docs')
    expect(docs.id).not.toBe(pullTrigger(opened as never, 'agent-bot').id)
    expect(issueTrigger(opened as never, 'agent-bot').id).toBe(pullTrigger(opened as never, 'agent-bot').id)
    expect(values('github-docs', docs)).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/docs', DSH_SUPERAGENT_GITHUB_NUMBER: '7',
      DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/7/head', DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-bot' })
    expect(values('github')).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets', DSH_SUPERAGENT_GITHUB_NUMBER: '' })
    expect(values('feishu')).toMatchObject({ DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets', DSH_SUPERAGENT_GITHUB_NUMBER: '' })
    // A disabled instance contributes nothing.
    expect(sources.environments(undefined, 'github-archive').some(item => item.kind.kind === 'github')).toBe(false)
  })
  it('reports each instance\'s health under its own entry, and keeps its KV records apart', () => {
    const board = new HealthBoard()
    const settings = twoRepositories()
    const sources = new SourceRegistry(() => settings, board)
    sources.register(githubKind)
    const records = new Map<string, unknown>()
    const store = { get: (key: string) => records.get(key), set: (key: string, value: unknown) => { records.set(key, value) },
      delete: (key: string) => { records.delete(key) }, keys: (prefix: string) => [...records.keys()].filter(key => key.startsWith(prefix)) }
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const deps = { sources, commands, store } as unknown as SourceContextDeps
    const first = sourceContextOf(deps, githubKind)
    const docs = sourceContextOf(deps, githubKind, 'github-docs')
    expect([first.source, docs.source]).toEqual(['github', 'github-docs'])
    expect(docs.commands.source).toBe('github-docs')
    expect(docs.config()).toMatchObject({ repository: 'acme/docs' })
    expect(docs.config('github-archive')).toBeUndefined()
    first.report('github', { state: 'ready', detail: 'widgets' })
    docs.report('github', { state: 'error', detail: 'docs' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'widgets' })
    expect(board.all['github-docs']).toEqual({ state: 'error', detail: 'docs' })
    expect(sources.healthNames({ id: 'github-docs', kind: 'github' })).toEqual([{ name: 'github', entry: 'github-docs' }])
    first.state.set('github:poll', 'a'); docs.state.set('github:poll', 'b')
    expect(Object.fromEntries(records)).toEqual({ 'github:poll': 'a', 'source:github-docs:github:poll': 'b' })
    expect([first.state.get('github:poll'), docs.state.get('github:poll')]).toEqual(['a', 'b'])
    expect(docs.state.keys({ prefix: 'github:' } as never)).toEqual(['github:poll'])
    expect(first.state.keys({ prefix: 'github:' } as never)).toEqual(['github:poll'])
    docs.state.set('github:poll', undefined)
    expect(docs.state.get('github:poll')).toBeUndefined()
    expect(first.state.get('github:poll')).toBe('a')
  })
  it('names instance health entries and checks instance IDs', () => {
    expect(instanceHealth('github', 'github', 'github')).toBe('github')
    expect(instanceHealth('github', 'github-docs', 'github')).toBe('github-docs')
    expect(instanceHealth('github', 'github-docs', 'poll')).toBe('github-docs:poll')
    expect(instanceIdError('github', 'github-docs')).toBeUndefined()
    expect(instanceIdError('github', 'github-docs-2')).toBeUndefined()
    for (const id of ['github', 'github-', 'docs', 'github-Docs', 'github-a--b', 'github-a_b', 'github-docs-', 'feishu-docs']) expect(instanceIdError('github', id)).toBe('pattern')
    expect(instanceIdError('github', `github-${'a'.repeat(34)}`)).toBe('length')
    expect(instanceIdError('github', `github-${'a'.repeat(33)}`)).toBeUndefined()
  })
})
