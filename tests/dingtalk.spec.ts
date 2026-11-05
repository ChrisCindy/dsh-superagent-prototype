/**
 * The DingTalk Source: robot messages as Triggers and the Threads they join, intake with its transcript and Thread windows, the
 * gate and the admission rows, the Channel, the OpenAPI client with its credentials and token cache, setup's check, the Stream
 * mode connection, the loop's health and backoff, and the reads
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Engine, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { resolveDingtalkApp } from '../src/deployment.ts'
import { Commands } from '../src/infra/commands.ts'
import { DingtalkApi, DingtalkError, readDingtalkCredentials, type DingtalkApp } from '../src/infra/dingtalk.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { apply as applyDingtalk, attach, dingtalkKind, dingtalkTrigger, dingtalkTriggerId, messageText, runDingtalk, takeIn, threadOf,
  type RobotMessage } from '../src/sources/dingtalk.ts'
import { gone, markdownTitle, sendDingtalk } from '../src/sources/dingtalk-channel.ts'
import { dingtalkRead, dingtalkResource, dingtalkThreadContext, readDingtalkImage } from '../src/sources/dingtalk-read.ts'
import { connectStream, type Socket, type StreamHandlers } from '../src/sources/dingtalk-stream.ts'
import { RobotMessageSchema } from '../src/sources/dingtalk-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const T0 = Date.parse('2026-11-01T08:00:00Z')
const ENDPOINT = 'https://api.dingtalk.test'
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dingtalk-')) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

/** A credentials file of the operator's, readable only by them. */
function credentials(content: unknown = { appKey: 'dingkey', appSecret: 'shh-secret' }, mode = 0o600): string {
  const file = join(directory, `app-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  chmodSync(file, mode)
  return file
}
/** A robot message as Stream mode delivers it: Alice mentions the robot in the team group. */
const message = (id: string, overrides: Record<string, unknown> = {}) => ({ msgId: `msg${id}`, conversationId: 'cidTeam', conversationType: '2',
  conversationTitle: 'Team', msgtype: 'text', createAt: T0 + Number(id.replace(/\D/g, '') || 0) * 60_000, senderId: '$:LWCP_v1:$alice',
  senderStaffId: 'alice', senderNick: 'Alice', isAdmin: false, isInAtList: true, chatbotUserId: '$:LWCP_v1:$robot', robotCode: 'dingkey',
  sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=x', text: { content: ' fix the login page' }, ...overrides })
const parse = (value: unknown): RobotMessage => RobotMessageSchema.parse(value)

interface Call { path: string; body: Record<string, unknown>; token?: string }
/** The OpenAPI as a fetch function: each path answers from `routes`, a value or a function of the request; others answer 404. */
function openApi(routes: Record<string, unknown>) {
  const calls: Call[] = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    const token = (init?.headers as Record<string, string> | undefined)?.['x-acs-dingtalk-access-token']
    calls.push({ path: url.pathname, body, ...token ? { token } : {} })
    const route = routes[url.pathname] ?? routes[url.href]
    const value = typeof route === 'function' ? (route as (call: Call) => unknown)(calls.at(-1)!) : route
    if (value instanceof Response) return value
    if (value === undefined) return new Response(JSON.stringify({ code: 'NotFound', message: 'no such API' }), { status: 404 })
    return new Response(JSON.stringify(value), { status: 200 })
  })
  return { fetcher, calls }
}
const TOKEN = { '/v1.0/oauth2/accessToken': { accessToken: 'token-1', expireIn: 7200 } }
const GATEWAY = { '/v1.0/gateway/connections/open': { endpoint: 'wss://wss-open-connection.dingtalk.test/connect', ticket: 'ticket-1' } }

function host(overrides: Partial<SourceContextDeps> = {}, config: Record<string, unknown> = {}) {
  const store = new Store(join(directory, 'db.sqlite'))
  const app: DingtalkApp = { credentials: credentials(), endpoint: ENDPOINT, robotCode: 'dingkey' }
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    policy: { sources: { dingtalk: { allowed: [{ id: 'alice', name: 'Alice' }] } } },
    sources: { dingtalk: { enabled: true, config: { credentials: app.credentials, endpoint: ENDPOINT,
      chats: [{ conversationId: 'cidTeam', listen: 'mentions' }, { conversationId: 'cidAll', listen: 'all' }], ...config } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  if (!overrides.sources) sources.register(dingtalkKind)
  const deployment = testDeployment({ dingtalk: app })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: outgoing => { store.receipts.add(outgoing) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(deps, dingtalkKind)
  const detach = attach(ctx)
  return { ...deps, store, engine, sources, receive, ctx, app, health: board.all, board, close: () => { detach(); store.close() } }
}

describe('dingtalk messages as Triggers', () => {
  it('maps a mention, a direct message and an external sender, and drops the robot\'s own message', () => {
    const trigger = dingtalkTrigger('dingtalk', parse(message('1')), 'cidTeam:msg1')!
    expect(trigger).toMatchObject({ id: dingtalkTriggerId('msg1'), source: 'dingtalk', threads: [{ source: 'dingtalk', id: 'cidTeam:msg1' }],
      actor: { source: 'dingtalk', id: 'alice' }, human: true, addressed: 'mention', at: '2026-11-01T08:01:00.000Z', text: 'fix the login page',
      channel: { source: 'dingtalk', thread: 'dingtalk:cidTeam', address: { conversationId: 'cidTeam', messageId: 'msg1', staffId: 'alice', nick: 'Alice' } },
      meta: { conversationId: 'cidTeam', messageId: 'msg1', direct: false, mentioned: true, staffId: 'alice', nick: 'Alice', isAdmin: false, title: 'Team' } })
    // The per-message session webhook is a short-lived credential of the group; it is kept nowhere.
    expect(JSON.stringify(trigger)).not.toContain('sendBySession')
    const direct = dingtalkTrigger('dingtalk', parse(message('2', { conversationType: '1', conversationId: 'cidAlice', isInAtList: undefined })), 'x')!
    expect(direct).toMatchObject({ addressed: 'direct', channel: { address: { direct: 'true', staffId: 'alice' } }, meta: { direct: true } })
    const unaddressed = dingtalkTrigger('dingtalk', parse(message('3', { isInAtList: false })), 'x')!
    expect(unaddressed).not.toHaveProperty('addressed')
    // An external member has no staff ID: the platform's opaque sender ID names them, which no allowed list holds.
    const external = dingtalkTrigger('dingtalk', parse(message('4', { senderStaffId: '' })), 'x')!
    expect(external.actor.id).toBe('$:LWCP_v1:$alice')
    expect(external.channel!.address).not.toHaveProperty('staffId')
    expect(dingtalkTrigger('dingtalk', parse(message('5', { senderId: '$:LWCP_v1:$robot' })), 'x')).toBeUndefined()
  })
  it('words images as marks with their download codes, files and voice by name, and a quoted message before the text', () => {
    expect(messageText(parse(message('1', { msgtype: 'picture', text: undefined, content: { downloadCode: 'code-a' } }))))
      .toEqual({ text: '[image-1]', images: ['code-a'], files: [] })
    expect(messageText(parse(message('1', { msgtype: 'richText', text: undefined,
      content: { richText: [{ text: 'before ' }, { downloadCode: 'code-a', type: 'picture' }, { text: ' after' }, { downloadCode: 'code-b' }] } }))))
      .toEqual({ text: 'before [image-1] after[image-2]', images: ['code-a', 'code-b'], files: [] })
    expect(messageText(parse(message('1', { msgtype: 'file', text: undefined, content: { downloadCode: 'f', fileName: 'log.txt' } }))).text).toBe('[file: log.txt]')
    expect(messageText(parse(message('1', { msgtype: 'audio', text: undefined, content: { recognition: '修一下' } }))).text).toBe('[voice] 修一下')
    const quoted = parse(message('1', { text: { content: 'still broken', isReplyMsg: true, repliedMsg: { msgId: 'msg0', content: { text: 'the login\n page fails' } } } }))
    expect(messageText(quoted).text).toBe('> the login page fails\nstill broken')
    expect(dingtalkTrigger('dingtalk', quoted, 'x')).toMatchObject({ meta: { quotedId: 'msg0' } })
    expect(dingtalkKind.repliesTo!(dingtalkTrigger('dingtalk', quoted, 'x')!)).toBe(dingtalkTriggerId('msg0'))
    expect(RobotMessageSchema.safeParse({ ...message('1'), conversationId: 'oc_feishu' }).success).toBe(false)
  })
})

describe('dingtalk intake', () => {
  it('stores a Trigger once, filters a group it does not receive, and makes an allowed person\'s mention an explicit request', async () => {
    const h = host()
    expect(await takeIn(h.ctx, message('1'))).toBe('stored')
    expect(h.engine.candidate(dingtalkTriggerId('msg1'))?.strength).toBe('explicit')
    // Stream mode delivers an unacknowledged message again; it is taken in once.
    expect(await takeIn(h.ctx, message('1'))).toBe('duplicate')
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(await takeIn(h.ctx, message('2', { conversationId: 'cidElsewhere', conversationTitle: 'Elsewhere' }))).toBe('filtered')
    expect(h.store.triggers.disposition(dingtalkTriggerId('msg2'))?.filtered).toMatchObject({ code: 'chat_not_allowed' })
    // A message for another robot of the organization, or one that arrives while the Source is off, does nothing.
    expect(await takeIn(h.ctx, message('3', { robotCode: 'other' }))).toBeUndefined()
    // Group titles become the choices of the settings' group column.
    expect(h.store.get(KV.sources.labels('dingtalk'))).toEqual({ cidTeam: 'Team', cidElsewhere: 'Elsewhere' })
    expect(await dingtalkKind.refreshLabels!({ sources: h.sources, context: kind => sourceContextOf(h, kind) }))
      .toEqual({ cidTeam: 'Team', cidElsewhere: 'Elsewhere' })
    expect(h.store.threads.get('dingtalk:cidTeam:msg1')?.meta).toMatchObject({ facts: { chat: { value: 'Team' } } })
    await expect(takeIn(h.ctx, { msgId: 'x' })).rejects.toThrow('Unreadable DingTalk robot message')
    h.close()
  })
  it('continues a Thread through a quote, or within the sender\'s Thread window, and starts one otherwise', async () => {
    const h = host()
    const config = { threadMinutes: 30 }
    await takeIn(h.ctx, message('1'))
    // Ten minutes later Alice mentions the robot again: the same Thread, and the transcript holds both.
    await takeIn(h.ctx, message('10', { text: { content: 'and the logout page' } }))
    expect(h.store.triggers.get(dingtalkTriggerId('msg10'))?.threads[0]?.id).toBe('cidTeam:msg1')
    expect(h.store.get<unknown[]>(KV.dingtalk.transcript('cidTeam:msg1'))).toMatchObject([{ id: 'msg1', from: 'Alice' }, { id: 'msg10', text: 'and the logout page' }])
    // Bob's mention, and Alice's message after the window, start their own Threads.
    expect(threadOf(h.ctx, parse(message('11', { senderStaffId: 'bob', senderId: 'bob' })), config)).toBe('cidTeam:msg11')
    expect(threadOf(h.ctx, parse(message('41')), config)).toBe('cidTeam:msg41')
    expect(threadOf(h.ctx, parse(message('39')), config)).toBe('cidTeam:msg1')
    expect(threadOf(h.ctx, parse(message('11')), { threadMinutes: 0 })).toBe('cidTeam:msg11')
    // A message that does not address the robot joins a Thread only by quoting.
    expect(threadOf(h.ctx, parse(message('12', { isInAtList: false })), config)).toBe('cidTeam:msg12')
    const quote = (id: string, of: string, overrides: Record<string, unknown> = {}) =>
      parse(message(id, { isInAtList: false, text: { content: 'same here', isReplyMsg: true, repliedMsg: { msgId: of } }, ...overrides }))
    expect(threadOf(h.ctx, quote('500', 'msg10'), config)).toBe('cidTeam:msg1')
    // A quote of a message the Source never received, or one from another conversation, does not.
    expect(threadOf(h.ctx, quote('501', 'msgUnknown'), config)).toBe('cidTeam:msg501')
    expect(threadOf(h.ctx, quote('502', 'msg10', { conversationId: 'cidAll' }), config)).toBe('cidAll:msg502')
    h.close()
  })
  it('keeps a direct conversation\'s messages within the window on one Thread, and a reply of the robot extends the window', async () => {
    const h = host()
    const dm = (id: string) => message(id, { conversationType: '1', conversationId: 'cidAlice', isInAtList: undefined, conversationTitle: undefined })
    await takeIn(h.ctx, dm('1'))
    const outgoing: OutboundMessage = { id: 'reply-1', kind: 'reply', text: 'Done.', ticketId: 't1',
      channel: dingtalkTrigger('dingtalk', parse(dm('1')), 'x')!.channel! }
    const { fetcher } = openApi({ ...TOKEN, '/v1.0/robot/oToMessages/batchSend': { processQueryKey: 'q' } })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 + 50 * 60_000)
    expect(await sendDingtalk({ commands: h.commands }, outgoing)).toBe('sent')
    vi.useRealTimers()
    // Fifty minutes after Alice's first message, but twenty after the robot's reply: the same Thread.
    expect(threadOf(h.ctx, parse(dm('70')), { threadMinutes: 30 })).toBe('cidAlice:msg1')
    expect(h.store.get<unknown[]>(KV.dingtalk.transcript('cidAlice:msg1'))).toMatchObject([{ id: 'msg1' }, { id: 'reply-1', bot: true, from: 'robot', text: 'Done.' }])
    expect(h.store.threads.get('dingtalk:cidAlice:msg1')?.meta).toMatchObject({ facts: { chat: { value: { en: 'Direct message' } } } })
    h.close()
  })
})

describe('dingtalk scope and policy', () => {
  it('receives listed groups, other groups and direct messages as configured, with an admission row each', () => {
    const config = dingtalkKind.schema.parse({ chats: [{ conversationId: 'cidAll', listen: 'all' }], directMessages: false })
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cidAll', direct: false } }, config)).toEqual({ listened: true, observed: true, row: 'cidAll' })
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cidX', direct: false } }, config)).toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cidX', direct: false } }, { ...config, otherChats: 'mentions' })).toMatchObject({ listened: true, row: 'other' })
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cidA', direct: true } }, config)).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(dingtalkKind.channel!.allowed!({ conversationId: 'cidX' }, config)).toBe(false)
    expect(dingtalkKind.policy!.rows!(config).map(row => [row.id, row.cells])).toEqual([
      ['cidAll', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
      ['other', { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }],
      ['direct', { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }]])
    expect(dingtalkKind.policy!.schema.safeParse({ allowed: [{ id: 'alice' }, { id: 'ALICE' }] }).success).toBe(false)
    expect(dingtalkKind.policy!.schema.safeParse({ allowed: [{ id: 'ou_feishu' }, { id: '$:LWCP_v1:$x' }] }).success).toBe(false)
    // Neither the configuration nor the settings form hold the credentials themselves, only where they are.
    expect(dingtalkKind.schema.safeParse({ credentials: 'dingkey:secret' }).success).toBe(false)
    expect(dingtalkKind.schema.parse({ credentials: 'env:DINGTALK_APP_SECRET' })).toMatchObject({ endpoint: 'https://api.dingtalk.com', threadMinutes: 30 })
    expect(dingtalkKind.setup).toEqual(['credentials', 'endpoint'])
  })
  it('gives an unlisted person\'s mention no candidate and a direct message from the list an explicit one', async () => {
    const h = host()
    await takeIn(h.ctx, message('1', { senderStaffId: 'mallory', senderId: 'mallory', senderNick: 'Mallory' }))
    expect(h.engine.candidate(dingtalkTriggerId('msg1'))).toBeUndefined()
    await takeIn(h.ctx, message('2', { conversationType: '1', conversationId: 'cidAlice', isInAtList: undefined }))
    expect(h.engine.candidate(dingtalkTriggerId('msg2'))?.strength).toBe('explicit')
    h.close()
  })
})

describe('dingtalk channel', () => {
  const reply = (address: Record<string, string>, text = 'Fixed in #12.'): OutboundMessage =>
    ({ id: 'reply-1', kind: 'reply', text, channel: { source: 'dingtalk', thread: 'dingtalk:cidTeam', address: { conversationId: 'cidTeam', messageId: 'msg1', ...address } } })
  it('posts a markdown message to the group naming the person it answers, or to that person directly', async () => {
    const h = host()
    const { fetcher, calls } = openApi({ ...TOKEN, '/v1.0/robot/groupMessages/send': { processQueryKey: 'q1' },
      '/v1.0/robot/oToMessages/batchSend': { processQueryKey: 'q2', invalidStaffIdList: [] } })
    vi.stubGlobal('fetch', fetcher)
    expect(await sendDingtalk({ commands: h.commands }, reply({ staffId: 'alice', nick: 'Alice' }))).toBe('sent')
    expect(calls.at(-1)).toEqual({ path: '/v1.0/robot/groupMessages/send', token: 'token-1', body: { robotCode: 'dingkey', openConversationId: 'cidTeam',
      msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'Fixed in #12.', text: '@Alice Fixed in #12.' }) } })
    expect(await sendDingtalk({ commands: h.commands }, reply({ direct: 'true', staffId: 'alice' }))).toBe('sent')
    expect(calls.at(-1)).toMatchObject({ path: '/v1.0/robot/oToMessages/batchSend', body: { robotCode: 'dingkey', userIds: ['alice'], msgKey: 'sampleMarkdown' } })
    // One token serves both sends.
    expect(calls.filter(call => call.path === '/v1.0/oauth2/accessToken')).toHaveLength(1)
    await expect(sendDingtalk({ commands: h.commands }, reply({}, Array.from({ length: 200 }, () => 'word').join(' ')))).rejects.toThrow('maximum is 100')
    expect(markdownTitle('## **Done**: the fix\nmore')).toBe('Done: the fix')
    h.close()
  })
  it('answers gone only when the conversation or the person is gone, and throws for a failure that may pass', async () => {
    const h = host()
    const routes: Record<string, unknown> = { ...TOKEN }
    vi.stubGlobal('fetch', openApi(routes).fetcher)
    routes['/v1.0/robot/oToMessages/batchSend'] = { invalidStaffIdList: ['alice'] }
    expect(await sendDingtalk({ commands: h.commands }, reply({ direct: 'true', staffId: 'alice' }))).toBe('gone')
    routes['/v1.0/robot/oToMessages/batchSend'] = { flowControlledStaffIdList: ['alice'] }
    await expect(sendDingtalk({ commands: h.commands }, reply({ direct: 'true', staffId: 'alice' }))).rejects.toThrow('limits')
    const refuse = (status: number, code: string) => () => new Response(JSON.stringify({ code, message: code }), { status })
    routes['/v1.0/robot/groupMessages/send'] = refuse(400, 'resource.notFound.openConversationId')
    expect(await sendDingtalk({ commands: h.commands }, reply({}))).toBe('gone')
    routes['/v1.0/robot/groupMessages/send'] = refuse(403, 'Forbidden.AccessDenied.AccessTokenPermissionDenied')
    await expect(sendDingtalk({ commands: h.commands }, reply({}))).rejects.toThrow(DingtalkError)
    routes['/v1.0/robot/groupMessages/send'] = refuse(500, 'ServiceUnavailable')
    await expect(sendDingtalk({ commands: h.commands }, reply({}))).rejects.toThrow('500')
    expect(gone(new Error('not found'))).toBe(false)
    expect(dingtalkKind.channel!.link({ messageId: 'msg1' }, {})).toEqual({ url: '', label: { zh: '钉钉消息', en: 'DingTalk message' }, triggerId: dingtalkTriggerId('msg1') })
    h.close()
  })
})

describe('dingtalk OpenAPI client and setup', () => {
  it('reads credentials only from a file its owner alone may read, or a variable DSH keeps from workers', async () => {
    expect(await readDingtalkCredentials(credentials())).toEqual({ appKey: 'dingkey', appSecret: 'shh-secret', robotCode: 'dingkey' })
    expect(await readDingtalkCredentials(credentials({ appKey: 'k', appSecret: 's', robotCode: 'r' }))).toMatchObject({ robotCode: 'r' })
    await expect(readDingtalkCredentials(credentials(undefined, 0o644))).rejects.toMatchObject({ reason: 'exposed' })
    await expect(readDingtalkCredentials(credentials('appKey=k'))).rejects.toMatchObject({ reason: 'malformed' })
    await expect(readDingtalkCredentials(join(directory, 'missing.json'))).rejects.toMatchObject({ reason: 'unreadable' })
    const env = { DINGTALK_APP_SECRET: JSON.stringify({ appKey: 'k', appSecret: 's' }), DINGTALK_APP: '{}' }
    expect(await readDingtalkCredentials('env:DINGTALK_APP_SECRET', env)).toMatchObject({ appKey: 'k' })
    await expect(readDingtalkCredentials('env:DINGTALK_APP', env)).rejects.toMatchObject({ reason: 'variable' })
    // No message names the secret.
    const error = await readDingtalkCredentials(credentials('{"appKey": "k", "appSecret": 42, "note": "shh-secret"}')).catch((caught: Error) => caught)
    expect(String(error)).not.toContain('shh-secret')
  })
  it('caches the access token until five minutes before it expires, and fetches one again when DingTalk refuses it', async () => {
    let issued = 0
    const { fetcher, calls } = openApi({ '/v1.0/oauth2/accessToken': () => ({ accessToken: `token-${++issued}`, expireIn: 7200 }),
      '/v1.0/robot/groupMessages/send': (call: Call) => call.token === 'token-2'
        ? new Response(JSON.stringify({ code: 'InvalidAuthentication', message: 'expired' }), { status: 401 }) : { processQueryKey: 'q' } })
    let now = T0
    const api = new DingtalkApi({ credentials: credentials(), endpoint: ENDPOINT, robotCode: 'dingkey' }, fetcher, () => now)
    const send = () => api.call(z.unknown(), '/v1.0/robot/groupMessages/send', {})
    await Promise.all([send(), send()])
    expect(issued).toBe(1)
    expect(calls[0]!.body).toEqual({ appKey: 'dingkey', appSecret: 'shh-secret' })
    now += 7200_000 - 4 * 60_000
    await send()
    // token-2 is refused, so token-3 is fetched and the call passes with it.
    expect(issued).toBe(3)
    expect(calls.filter(call => call.path === '/v1.0/robot/groupMessages/send').map(call => call.token)).toEqual(['token-1', 'token-1', 'token-2', 'token-3'])
  })
  it('verifies the app at setup: its credentials, a token and a Stream mode connection, and refuses each failure by its own problem', async () => {
    const { fetcher, calls } = openApi({ ...TOKEN, ...GATEWAY })
    const file = credentials()
    expect(await resolveDingtalkApp({ credentials: file }, fetcher)).toEqual({ credentials: file, endpoint: 'https://api.dingtalk.com', robotCode: 'dingkey' })
    expect(calls.map(call => call.path)).toEqual(['/v1.0/oauth2/accessToken', '/v1.0/gateway/connections/open'])
    expect(calls[1]!.body).toMatchObject({ clientId: 'dingkey', subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }] })
    expect(await resolveDingtalkApp({ credentials: '' }, fetcher)).toBeUndefined()
    const code = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: unknown) => error instanceof SetupError ? error.code : String(error))
    expect(await code(resolveDingtalkApp({ credentials: credentials(undefined, 0o640) }, fetcher))).toBe('dingtalkCredentialsExposed')
    expect(await code(resolveDingtalkApp({ credentials: 'env:DINGTALK_APP' }, fetcher, {}))).toBe('dingtalkCredentialsVariable')
    expect(await code(resolveDingtalkApp({ credentials: 'env:DINGTALK_APP_SECRET' }, fetcher, {}))).toBe('dingtalkCredentialsUnreadable')
    expect(await code(resolveDingtalkApp({ credentials: credentials('{}') }, fetcher))).toBe('dingtalkCredentialsMalformed')
    expect(await code(resolveDingtalkApp({ credentials: file, endpoint: 'http://api.dingtalk.com' }, fetcher))).toBe('dingtalkEndpointInvalid')
    // A loopback endpoint over http is a local test double.
    expect(await code(resolveDingtalkApp({ credentials: file, endpoint: 'http://127.0.0.1:9' }, fetcher))).toBe('resolved')
    expect(await code(resolveDingtalkApp({ credentials: file }, openApi({ ...GATEWAY }).fetcher))).toBe('dingtalkCredentialsRejected')
    expect(await code(resolveDingtalkApp({ credentials: file }, openApi({ ...TOKEN }).fetcher))).toBe('dingtalkStreamRefused')
    const insecure = openApi({ ...TOKEN, '/v1.0/gateway/connections/open': { endpoint: 'ws://wss-open-connection.dingtalk.test', ticket: 't' } })
    expect(await code(resolveDingtalkApp({ credentials: file }, insecure.fetcher))).toBe('dingtalkStreamRefused')
  })
})

/** A WebSocket double: what the client sent, and the server's side of the connection. */
class FakeSocket implements Socket {
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<string, ((event: { data?: unknown; code?: number; reason?: string }) => void)[]>()
  closed?: number
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }
  emit(type: string, event: { data?: unknown; code?: number; reason?: string } = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>) }
  close(code = 1000) { if (this.closed === undefined) { this.closed = code; queueMicrotask(() => this.emit('close', { code })) } }
  frame(type: string, topic: string, messageId: string, data: unknown) {
    this.emit('message', { data: JSON.stringify({ specVersion: '1.0', type, headers: { topic, messageId, contentType: 'application/json' }, data: JSON.stringify(data) }) })
  }
}
const streamApi = (urls: string[] = []) => ({ openStream: vi.fn(async () => { urls.push('wss://x?ticket=t'); return { url: 'wss://x?ticket=t' } }) }) as unknown as DingtalkApi

describe('dingtalk stream connection', () => {
  it('answers pings, acknowledges a robot message once it was taken in, and leaves a refused one for DingTalk to deliver again', async () => {
    const socket = new FakeSocket()
    const taken: unknown[] = []
    const handlers: StreamHandlers = { open: vi.fn(), message: vi.fn(async (payload: unknown) => { taken.push(payload); return taken.length === 1 ? 'ack' : 'retry' }) }
    const controller = new AbortController()
    const running = connectStream(streamApi(), handlers, controller.signal, () => socket)
    await vi.waitFor(() => expect(socket.sent).toBeDefined())
    await Promise.resolve()
    socket.emit('open')
    expect(handlers.open).toHaveBeenCalledOnce()
    socket.emit('message', { data: JSON.stringify({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'p1' }, data: '{"opaque":"1"}' }) })
    expect(socket.sent[0]).toEqual({ code: 200, headers: { contentType: 'application/json', messageId: 'p1' }, message: 'OK', data: '{"opaque":"1"}' })
    socket.frame('CALLBACK', '/v1.0/im/bot/messages/get', 'm1', message('1'))
    socket.frame('CALLBACK', '/v1.0/im/bot/messages/get', 'm2', message('2'))
    await vi.waitFor(() => expect(taken).toHaveLength(2))
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(socket.sent[1]).toEqual({ code: 200, headers: { contentType: 'application/json', messageId: 'm1' }, message: 'OK', data: '{"response":null}' })
    expect(taken[0]).toMatchObject({ msgId: 'msg1' })
    controller.abort()
    await expect(running).resolves.toBeUndefined()
  })
  it('ends with why when the server asks to reconnect, the connection drops or stays silent', async () => {
    const asked = new FakeSocket()
    const handlers: StreamHandlers = { open: () => {}, message: async () => 'ack' }
    const first = connectStream(streamApi(), handlers, new AbortController().signal, () => asked)
    await vi.waitFor(() => expect(asked).toBeDefined())
    await new Promise(resolve => setTimeout(resolve, 0))
    asked.emit('open')
    asked.emit('message', { data: JSON.stringify({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'd' } }) })
    await expect(first).rejects.toThrow('asked to reconnect')
    const dropped = new FakeSocket()
    const second = connectStream(streamApi(), handlers, new AbortController().signal, () => dropped)
    await new Promise(resolve => setTimeout(resolve, 0))
    dropped.emit('close', { code: 1006 })
    await expect(second).rejects.toThrow('closed (1006)')
    const silent = new FakeSocket()
    const third = connectStream(streamApi(), handlers, new AbortController().signal, () => silent, 20)
    await new Promise(resolve => setTimeout(resolve, 0))
    silent.emit('open')
    await expect(third).rejects.toThrow('silent')
    expect(silent.closed).toBe(4000)
  })
})

describe('dingtalk loop', () => {
  it('waits for setup and its credentials, naming on its health what it still needs', async () => {
    const run = async (overrides: Partial<SourceContextDeps>) => {
      const h = host({ ...overrides })
      await runDingtalk(h.ctx, new AbortController().signal, vi.fn())
      const health = { ...h.health }
      h.close()
      return health.dingtalk
    }
    expect(await run({ configured: () => false })).toMatchObject({ state: 'paused', code: 'setupPending' })
    expect(await run({ deployment: testDeployment() })).toMatchObject({ state: 'paused', code: 'dingtalkUnset' })
    const problem = new SetupError('dingtalkStreamRefused').problem
    expect(await run({ deployment: testDeployment(), dingtalkProblem: problem })).toEqual({ state: 'paused', detail: problem.detail })
  })
  it('reports ready once connected, keeps a failed message on its health for the connection, and an error after three failed connections', async () => {
    const h = host()
    vi.useFakeTimers()
    let attempt = 0
    const failed: Record<string, unknown>[] = []
    const connect = vi.fn(async (_api: DingtalkApi, handlers: StreamHandlers, signal: AbortSignal) => {
      attempt += 1
      if (attempt === 1) {
        handlers.open()
        expect(h.health.dingtalk).toMatchObject({ state: 'ready', detail: 'Listening for robot messages' })
        // An unreadable message is acknowledged and reported; a ready report later in this connection does not hide it.
        expect(await handlers.message({ msgId: 'broken' })).toBe('ack')
        handlers.open()
        failed.push({ ...h.health.dingtalk })
        // A message the Source could not store is left for DingTalk to deliver again.
        vi.spyOn(h.ctx, 'receive').mockRejectedValueOnce(new Error('database locked'))
        expect(await handlers.message(message('1'))).toBe('retry')
        throw new Error('closed (1006)')
      }
      if (attempt <= 4) throw new Error('gateway refused')
      handlers.open()
      await new Promise(resolve => signal.addEventListener('abort', resolve))
    })
    const controller = new AbortController()
    const running = runDingtalk(h.ctx, controller.signal, connect)
    await vi.advanceTimersByTimeAsync(0)
    expect(failed[0]).toMatchObject({ state: 'error', detail: expect.stringContaining('Unreadable DingTalk robot message') })
    expect(h.health.dingtalk).toMatchObject({ state: 'error', detail: expect.stringContaining('database locked') })
    // The connection that opened and dropped is retried after 1 s, then each failed one after twice the wait.
    await vi.advanceTimersByTimeAsync(1000)
    expect(attempt).toBe(2)
    expect(h.health.dingtalk).toMatchObject({ state: 'starting', detail: 'Connecting again: Error: gateway refused' })
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    expect(attempt).toBe(4)
    expect(h.health.dingtalk).toMatchObject({ state: 'error', code: 'streamFailures', values: { count: '3' } })
    await vi.advanceTimersByTimeAsync(8000)
    expect(attempt).toBe(5)
    expect(h.health.dingtalk).toMatchObject({ state: 'ready' })
    // Switching the Source off ends the connection within five seconds.
    const settings = h.store.settings()
    h.store.saveSettings({ ...settings, sources: { ...settings.sources, dingtalk: { ...settings.sources.dingtalk!, enabled: false } } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.health.dingtalk).toMatchObject({ state: 'paused', code: 'sourceOff' })
    controller.abort()
    await vi.advanceTimersByTimeAsync(5000)
    await running
    h.close()
  })
  it('registers its kind, runs its loop while applied, and stops it when disposed', async () => {
    const board = new HealthBoard()
    const h = host({ configured: () => false })
    const sources = new SourceRegistry(() => h.store.settings(), board)
    const disposers: (() => unknown)[] = []
    const orchestrator = { sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf({ ...h, sources }, kind) }
    applyDingtalk({ orchestrator, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(sources.kind('dingtalk')).toBe(dingtalkKind)
    await vi.waitFor(() => expect(board.all.dingtalk).toMatchObject({ code: 'setupPending' }))
    for (const dispose of disposers.reverse()) await dispose()
    expect(sources.kind('dingtalk')).toBeUndefined()
    h.close()
  })
})

describe('dingtalk reads', () => {
  it('reads a Trigger\'s message and its Thread for agents and assessments, by the Trigger alone', async () => {
    const h = host()
    await takeIn(h.ctx, message('1', { isAdmin: true, text: { content: 'the login page', isReplyMsg: true, repliedMsg: { msgId: 'msg0', content: { text: 'old' } } } }))
    await takeIn(h.ctx, message('2', { msgtype: 'picture', text: undefined, content: { downloadCode: 'code-a' } }))
    const first = h.store.triggers.get(dingtalkTriggerId('msg1'))!
    expect(dingtalkResource('dingtalk/abc/thread')).toEqual({ triggerId: 'abc', part: 'thread' })
    expect(() => dingtalkResource('dingtalk/abc/../thread')).toThrow('Use dingtalk/<trigger-id>/message or /thread')
    expect(dingtalkRead('dingtalk', first, 'message')).toMatchObject({ message: { id: 'msg1', from: 'Alice', sender: 'alice', group_admin: true,
      conversation: 'Team', reply_to: 'msg0', text: '> old\nthe login page' } })
    expect(dingtalkRead('dingtalk', first, 'thread')).toMatchObject({ thread: 'dingtalk:cidTeam:msg1', messages: [{ id: 'msg1' }, { id: 'msg2', text: '[image-1]' }] })
    const read = dingtalkKind.resources!.open({ resource: `dingtalk/${first.id}/thread`, prefix: 'dingtalk', commands: h.commands.forSource('dingtalk'),
      config: {} as never, trigger: () => first })
    expect(await read()).toMatchObject({ status: 'available' })
    expect(dingtalkKind.resources!.references!(first)).toEqual({ message: `dingtalk/${first.id}/message`, thread: `dingtalk/${first.id}/thread` })
    const context = h.sources.threadContext(first)!
    expect(context.messageId).toBe('msg1')
    expect((await context.read(h.commands, 'thread')).messages.map(item => item.id)).toEqual(['msg1', 'msg2'])
    expect(await context.read(h.commands, 'parent')).toMatchObject({ status: 'no_parent', messages: [] })
    expect((await context.read(h.commands, 'root')).messages[0]!.id).toBe('msg1')
    expect(context.images('[image-1] and [image-2] [image-1]')).toEqual(['image-1', 'image-2'])
    await expect(dingtalkThreadContext.read(h.commands, { ...first, source: 'feishu' }, 'thread', undefined, {})).rejects.toThrow('DingTalk source trigger')
    h.close()
  })
  it('downloads an image of a message through its download code, within the deployment\'s byte limit', async () => {
    const h = host()
    await takeIn(h.ctx, message('1', { msgtype: 'picture', text: undefined, content: { downloadCode: 'code-a' } }))
    const trigger = h.store.triggers.get(dingtalkTriggerId('msg1'))!
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
    const { fetcher, calls } = openApi({ ...TOKEN, '/v1.0/robot/messageFiles/download': { downloadUrl: 'https://files.dingtalk.test/a.png' },
      'https://files.dingtalk.test/a.png': () => new Response(png, { headers: { 'content-type': 'image/png' } }) })
    vi.stubGlobal('fetch', fetcher)
    const saveImage = vi.fn().mockResolvedValue({ attachmentId: 'image-id' })
    const ctx = new Context()
    ctx.reflect.provide('attachments', { saveImage, imageLimits: { maxImageBytes: 100, maxMessageImageBytes: 100 } })
    ctx.reflect.provide('llm', { resolveModelInfo: vi.fn().mockResolvedValue({ inputModalities: ['text', 'image'] }) })
    const agent = { ctx, session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} } as unknown as Agent
    const signal = new AbortController().signal
    expect(await readDingtalkImage(agent, h.commands, trigger, { id: 'msg1' }, 'image-1', signal))
      .toEqual({ source_message_id: 'msg1', image_key: 'image-1', image: { attachmentId: 'image-id' } })
    expect(calls.find(call => call.path === '/v1.0/robot/messageFiles/download')?.body).toEqual({ downloadCode: 'code-a', robotCode: 'dingkey' })
    expect(saveImage).toHaveBeenCalledWith({ data: png, mediaType: 'image/png', name: 'image-1.png' })
    await expect(readDingtalkImage(agent, h.commands, trigger, { id: 'msg1' }, 'image-2', signal)).rejects.toThrow('Choose an image key')
    const small = new Context()
    small.reflect.provide('attachments', { saveImage, imageLimits: { maxImageBytes: 4, maxMessageImageBytes: 100 } })
    small.reflect.provide('llm', { resolveModelInfo: vi.fn().mockResolvedValue({ inputModalities: ['image'] }) })
    await expect(readDingtalkImage({ ...agent, ctx: small } as unknown as Agent, h.commands, trigger, { id: 'msg1' }, 'image-1', signal)).rejects.toThrow('byte limit')
    h.close()
  })
})
