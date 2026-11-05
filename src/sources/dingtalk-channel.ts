/** The DingTalk Channel: the robot's markdown messages to a group or a person, `sent` or `gone` */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { DingtalkError, dingtalkApi } from '../infra/dingtalk.ts'
import { checkedImText } from '../infra/text.ts'
import { recordReply } from './dingtalk-loops.ts'
import { dingtalkTriggerId } from './dingtalk-trigger.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'

const GroupAnswer = z.looseObject({ processQueryKey: z.string().optional() })
const DirectAnswer = z.looseObject({ processQueryKey: z.string().optional(), invalidStaffIdList: z.array(z.string()).optional(),
  flowControlledStaffIdList: z.array(z.string()).optional() })
/**
 * True when DingTalk refuses a message for good because its conversation or recipient no longer exists or no longer has the
 * robot; a refused permission, a limit or a failure without an answer may pass on a later attempt.
 */
export const gone = (error: unknown): boolean => error instanceof DingtalkError && [400, 404].includes(error.status)
  && /not.?exist|not.?found|notFound|robot.*(not|removed)|conversation.*invalid/i.test(`${error.code ?? ''} ${error.message}`)
  && !/forbidden|permission|throttl|limit/i.test(error.code ?? '')
/** The markdown title DingTalk shows in notifications: the message's first line without markdown, up to 30 characters. */
export const markdownTitle = (text: string): string =>
  text.trim().split('\n')[0]!.replace(/^[#>\s]+/, '').replace(/[*`_[\]]/g, '').trim().slice(0, 30) || 'dsh-superagent'

/**
 * Sends `message` as the robot's markdown message (`sampleMarkdown`): to the group by its `openConversationId`, starting with
 * the name of the person it answers, or to that person alone in a direct chat. DingTalk's robot messages take no idempotency
 * key: the Outbox's receipt keeps a sent message from going out again, and only a send whose answer was lost goes out twice.
 * @throws when delivery failed but may pass on a later attempt.
 */
export async function sendDingtalk(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const app = host.commands.deployment.dingtalk
  if (!app) throw new Error('The DingTalk Source has no verified app')
  const { conversationId, direct, staffId, nick } = message.channel.address
  if (!conversationId) throw new Error('Missing DingTalk reply target')
  const text = checkedImText(message.text)
  const param = (body: string) => JSON.stringify({ title: markdownTitle(message.text), text: body })
  const api = dingtalkApi(app)
  try {
    if (direct === 'true') {
      if (!staffId) return 'gone'
      const answer = await api.call(DirectAnswer, '/v1.0/robot/oToMessages/batchSend',
        { robotCode: app.robotCode, userIds: [staffId], msgKey: 'sampleMarkdown', msgParam: param(text) })
      if (answer.invalidStaffIdList?.includes(staffId)) return 'gone'
      if (answer.flowControlledStaffIdList?.includes(staffId)) throw new Error('DingTalk limits the messages to this person for now')
    } else {
      await api.call(GroupAnswer, '/v1.0/robot/groupMessages/send',
        { robotCode: app.robotCode, openConversationId: conversationId, msgKey: 'sampleMarkdown', msgParam: param(nick ? `@${nick} ${text}` : text) })
    }
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  recordReply(message)
  return 'sent'
}
/** DingTalk has no web link to a conversation; the panel links the Trigger the reply answers instead. */
export const dingtalkLink = (address: Record<string, string>): ChannelLink => ({ url: '', label: { zh: '钉钉消息', en: 'DingTalk message' },
  ...address.messageId ? { triggerId: dingtalkTriggerId(address.messageId) } : {} })
