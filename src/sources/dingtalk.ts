/** The DingTalk kind and plugin entry, exported as `./dingtalk-watch` */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { DingtalkAppSchema } from '../deployment.ts'
import { IM_WORDS } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { dingtalkLink, sendDingtalk } from './dingtalk-channel.ts'
import { attach, runDingtalk } from './dingtalk-loops.ts'
import { dingtalkRead, dingtalkReferences, dingtalkResource, dingtalkThreadContext } from './dingtalk-read.ts'
import { CONVERSATION_ID, dingtalkTriggerId, SOURCE, STAFF_ID } from './dingtalk-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'

export { dingtalkChannel, dingtalkThreadId, dingtalkTrigger, dingtalkTriggerId, imageKeys, messageText, RobotMessageSchema }
  from './dingtalk-trigger.ts'
export type { DingtalkEntry, RobotMessage } from './dingtalk-trigger.ts'
export { attach, recordReply, runDingtalk, runningContext, takeIn, threadOf, TRANSCRIPT_MAX } from './dingtalk-loops.ts'

const pattern = (expression: RegExp) => expression.source.slice(1, -1)
const DingtalkConfigSchema = DingtalkAppSchema.extend({
  chats: z.array(z.object({ conversationId: z.string().regex(CONVERSATION_ID), name: z.string().trim().max(60).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.conversationId)).size === chats.length, 'Duplicate conversation IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  threadMinutes: z.number().int().min(0).max(1440).default(30),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>
const mentionsOnly = { zh: '仅 @', en: '@ only' }

export const dingtalkKind: SourceKind<DingtalkConfig> = {
  kind: SOURCE,
  title: { zh: '钉钉', en: 'DingTalk' },
  description: { zh: '通过 Stream 模式接收下列群里 @ 机器人的消息和发给机器人的私聊。', en: 'Receives, through Stream mode, messages that mention the robot in these groups, and direct messages to it.' },
  // The group titles the robot has seen in messages; DingTalk lists no robot's groups.
  refreshLabels: async host => sourceContext(host, dingtalkKind).state.get(KV.sources.labels(SOURCE)) ?? {},
  setup: Object.keys(DingtalkAppSchema.shape),
  schema: DingtalkConfigSchema,
  fields: [
    { key: 'credentials', type: 'text', label: { zh: '应用凭据的位置', en: 'Where the app credentials are' },
      hint: { zh: '只填位置，不填凭据本身：一个绝对路径，指向只有运行 dsh-superagent 的用户能读的 JSON 文件（chmod 600），内容为 {"appKey": "…", "appSecret": "…"}；或 env:变量名，变量名须含 SECRET，值为同样的 JSON。保存时检查凭据和 Stream 模式，然后重启 dsh-superagent。', en: 'Only where they are, never the credentials themselves: an absolute path to a JSON file only the user running dsh-superagent may read (chmod 600), holding {"appKey": "…", "appSecret": "…"}; or env:NAME, a variable whose name contains SECRET and whose value is that JSON. Saving checks the credentials and Stream mode, then restarts dsh-superagent.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Groups' },
      hint: { zh: '钉钉机器人默认只收到 @ 它的群消息。“全部消息”另外接收机器人收到的其余消息，评估可以按规则从中推断工作；钉钉不推送时它和“仅 @”一样。', en: 'A DingTalk robot receives only the group messages that mention it, by default. "All" also receives any other message the robot is sent, from which Eval may infer work under the rules; where DingTalk sends none, it is the same as "@ only".' },
      columns: [
        { key: 'conversationId', type: 'text', label: { zh: '群', en: 'Group' }, pattern: pattern(CONVERSATION_ID), choose: { zh: '选择 @ 过机器人的群', en: 'Choose a group that mentioned the robot' }, refresh: { zh: '刷新群列表', en: 'Refresh groups' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: mentionsOnly }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other groups' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: mentionsOnly }],
      hint: { zh: '机器人所在、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Groups the robot is in that are not listed above. "@ only" receives messages there that mention the robot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'threadMinutes', type: 'number', advanced: true, min: 0, max: 1440, label: { zh: '线程窗口 / 分钟', en: 'Thread window / minutes' },
      hint: { zh: '同一个人在同一个会话里 @ 机器人或私聊机器人时，距他或机器人上一次在那里说话不到这么久，就接在同一个线程上；引用回复总是接在被引用消息的线程上。0 让每条消息自成线程。', en: 'A message that mentions or messages the robot continues the Thread its sender or the robot last wrote in, in that conversation, when that was less than this long ago; a quote reply always continues the quoted message\'s Thread. 0 starts a Thread with every message.' } },
    { key: 'endpoint', type: 'text', advanced: true, label: { zh: 'OpenAPI 地址', en: 'OpenAPI endpoint' },
      hint: { zh: '钉钉开放平台的地址，通常不用改。', en: 'The DingTalk OpenAPI origin; normally unchanged.' } },
  ],
  health: [SOURCE],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find(item => item.conversationId === meta.conversationId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.conversationId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a conversation the Source still receives.
  channel: {
    allowed: (address, config) =>
      dingtalkKind.scope!({ meta: { conversationId: address.conversationId ?? '', direct: address.direct === 'true' } }, config).listened,
    limit: IM_WORDS, send: sendDingtalk, link: dingtalkLink,
  },
  // Messages are read around a Trigger the reader may read, never by conversation or message IDs.
  resources: {
    names: [{ name: 'dingtalk/<trigger-id>/…', holds: 'a DingTalk message (message) or its Thread (thread), as the Source received and sent them' }],
    open: ({ resource, commands, trigger }) => {
      const { triggerId, part } = dingtalkResource(resource)
      const found = trigger(triggerId)
      if (found.source !== commands.source) throw new Error('A DingTalk source trigger is required')
      return async () => dingtalkRead(commands.source, found, part)
    },
    references: trigger => trigger.source === SOURCE ? dingtalkReferences(SOURCE, trigger) : undefined,
  },
  threadContext: dingtalkThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bmsg[A-Za-z0-9+/=_-]{6,}/g) ?? [])] }),
  // A quote reply's Trigger answers the Trigger of the message it quotes.
  repliesTo: trigger => typeof trigger.meta.quotedId === 'string' ? dingtalkTriggerId(trigger.meta.quotedId) : undefined,
  policy: {
    unnamed: { person: { zh: '钉钉用户', en: 'DingTalk user' }, bot: { zh: '钉钉机器人', en: 'DingTalk robot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(STAFF_ID), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id.toLowerCase())).size === users.length, 'Duplicate staff IDs').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的钉钉用户', en: 'DingTalk users who may originate work' },
        hint: { zh: '按企业内的 userid（staffId）列出，可以在钉钉管理后台的通讯录里查到。', en: 'Listed by their userid (staffId) in the organization, which the DingTalk admin console shows in the contacts.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'userid', en: 'userid' }, pattern: pattern(STAFF_ID) }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人在群里 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the robot in a group or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = DingtalkConfigSchema.parse(stored)
      return [
        ...config.chats.map(chat => ({ id: chat.conversationId, label: chat.name || chat.conversationId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentionsOnly,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他群', en: 'Other groups' }, note: config.otherChats === 'mentions' ? mentionsOnly : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_DINGTALK_CHAT', description: { zh: '接下工单的钉钉会话的 openConversationId；工单不是从钉钉来的时为空', en: 'openConversationId of the DingTalk conversation that started the ticket; empty when the ticket did not start on DingTalk' } }],
    values: ({ instance, trigger }) => ({ DSH_SUPERAGENT_DINGTALK_CHAT: trigger?.source === instance ? String(trigger.meta.conversationId ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.dingtalk
    ? { credentials: { zh: '凭据已验证，Stream 模式可用', en: 'Credentials verified; Stream mode available' } } : {},
}

export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, dingtalkKind)
    const detach = attach(source)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = runDingtalk(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running; detach() }
  })
}
