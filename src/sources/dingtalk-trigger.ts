/** DingTalk robot messages as Triggers: the payload Stream mode delivers, its text, and the Thread a message joins */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'dingtalk'
/** A staff ID (`userid`) inside the organization, as the platform gives it in `senderStaffId`. */
export const STAFF_ID = /^[A-Za-z0-9_\-]{1,64}$/
/** An `openConversationId`, which a robot message names its group or direct chat by. The escapes keep the pattern valid in an HTML `pattern`. */
export const CONVERSATION_ID = /^cid[A-Za-z0-9+\/=_\-]{1,200}$/

/**
 * A robot message as the `/v1.0/im/bot/messages/get` topic delivers it; text and quotes are untrusted, the sender, the
 * conversation and `isInAtList` are the platform's. `conversationType` is `1` for a direct chat and `2` for a group.
 */
export const RobotMessageSchema = z.looseObject({
  msgId: z.string().min(1).max(200), conversationId: z.string().regex(CONVERSATION_ID), conversationType: z.enum(['1', '2']),
  conversationTitle: z.string().optional(), msgtype: z.string(), createAt: z.coerce.number().int().positive(),
  senderId: z.string().min(1), senderStaffId: z.string().regex(STAFF_ID).optional().catch(undefined), senderNick: z.string().default(''),
  isAdmin: z.boolean().optional(), isInAtList: z.boolean().optional(), chatbotUserId: z.string().optional(), robotCode: z.string().optional(),
  text: z.looseObject({ content: z.string().default(''), isReplyMsg: z.boolean().optional(),
    repliedMsg: z.looseObject({ msgId: z.string().optional(), senderId: z.string().optional(), msgType: z.string().optional(),
      content: z.unknown().optional() }).optional() }).optional(),
  content: z.unknown().optional(),
})
export type RobotMessage = z.infer<typeof RobotMessageSchema>
/** One message of a Thread's transcript: what the Source received there, and the robot's replies (`bot`). */
export interface DingtalkEntry { id: string; from: string; at: string; text: string; images?: string[]; bot?: true; quoted?: string }

const ContentSchema = z.looseObject({ downloadCode: z.string().optional(), fileName: z.string().optional(), recognition: z.string().optional(),
  richText: z.array(z.looseObject({ text: z.string().optional(), downloadCode: z.string().optional(), type: z.string().optional() })).optional() })
/** The `[image-<n>]` mark that stands for the n-th image of a message in its text; `images` holds their download codes in order. */
export const imageMark = (index: number): string => `[image-${index + 1}]`
export const imageKeys = (text: string): string[] => [...new Set([...text.matchAll(/\[(image-\d+)\]/g)].map(match => match[1]!))]
/** The text of a quoted message, whichever of the shapes DingTalk gives it. */
function quotedText(content: unknown): string {
  if (typeof content === 'string') return content
  const value = z.looseObject({ text: z.string().optional(), content: z.string().optional() }).safeParse(content).data
  return value?.text ?? value?.content ?? ''
}
/**
 * The message's text with its images as `[image-n]` marks, its files and voice by name, and the message it quotes, as a quote
 * line of up to 200 characters, before it; and the download codes of its images, in the order of the marks.
 */
export function messageText(message: RobotMessage): { text: string; images: string[]; files: string[] } {
  const content = ContentSchema.safeParse(message.content).data ?? {}
  const images: string[] = []
  const image = (code: string | undefined) => { if (!code) return '[image]'; images.push(code); return imageMark(images.length - 1) }
  let body: string
  switch (message.msgtype) {
    case 'text': body = message.text?.content.trim() ?? ''; break
    case 'picture': body = image(content.downloadCode); break
    case 'richText': body = (content.richText ?? []).map(item => item.text ?? (item.downloadCode ? image(item.downloadCode) : '')).join('').trim(); break
    case 'file': body = `[file: ${content.fileName ?? 'unnamed'}]`; break
    case 'audio': body = content.recognition ? `[voice] ${content.recognition}` : '[voice]'; break
    default: body = `[${message.msgtype}]`
  }
  const replied = message.text?.isReplyMsg ? message.text.repliedMsg : undefined
  const quote = replied ? quotedText(replied.content).replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  return { text: quote ? `> ${quote}\n${body}` : body, images, files: content.fileName ? [content.fileName] : [] }
}
/** The ID of the message `message` quotes, when it quotes one. */
export const quotedId = (message: RobotMessage): string | undefined =>
  message.text?.isReplyMsg ? message.text.repliedMsg?.msgId || undefined : undefined
/** The sender's identity: the staff ID inside the organization, else the platform's opaque sender ID (an external member's). */
export const senderOf = (message: RobotMessage): string => message.senderStaffId ?? message.senderId
/** Deterministic Trigger ID of a DingTalk message. */
export const dingtalkTriggerId = (msgId: string): string => key(SOURCE, msgId)
/** A Thread ID: the conversation and the message the Thread started with. */
export const dingtalkThreadId = (conversationId: string, root: string): string => `${conversationId}:${root}`
/**
 * The reply Channel of a conversation; replies of one conversation go out in order. `staffId` and `nick` name the person a reply
 * answers: a direct reply goes to their staff ID, and a group reply starts with their name.
 */
export function dingtalkChannel(source: string, message: RobotMessage): ChannelRef {
  const direct = message.conversationType === '1'
  const staffId = message.senderStaffId
  return { source, thread: `${source}:${message.conversationId}`, address: { conversationId: message.conversationId, messageId: message.msgId,
    ...direct ? { direct: 'true' } : {}, ...staffId ? { staffId } : {}, ...message.senderNick ? { nick: message.senderNick } : {} } }
}
/**
 * The Trigger of a robot message on Thread `thread` (see `threadOf` in dingtalk-loops.ts), or undefined for the robot's own
 * message. A direct message addresses the robot; a group message does when the platform lists the robot among its mentions.
 */
export function dingtalkTrigger(source: string, message: RobotMessage, thread: string): Trigger | undefined {
  if (message.chatbotUserId && message.senderId === message.chatbotUserId) return undefined
  const direct = message.conversationType === '1'
  const mentioned = !direct && message.isInAtList === true
  const { text, images, files } = messageText(message)
  const quoted = quotedId(message)
  return { id: dingtalkTriggerId(message.msgId), source, threads: [{ source, id: thread }], actor: { source, id: senderOf(message) }, human: true,
    ...direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {},
    at: new Date(message.createAt).toISOString(), text, channel: dingtalkChannel(source, message),
    meta: { conversationId: message.conversationId, messageId: message.msgId, direct, mentioned, msgtype: message.msgtype,
      ...message.senderStaffId ? { staffId: message.senderStaffId } : {}, ...message.senderNick ? { nick: message.senderNick } : {},
      ...message.isAdmin !== undefined ? { isAdmin: message.isAdmin } : {}, ...message.conversationTitle ? { title: message.conversationTitle } : {},
      ...quoted ? { quotedId: quoted } : {}, ...images.length ? { images } : {}, ...files.length ? { files } : {} } }
}
/** The transcript entry of a Trigger. */
export const transcriptEntry = (trigger: Trigger): DingtalkEntry => ({ id: String(trigger.meta.messageId), at: trigger.at, text: trigger.text,
  from: String(trigger.meta.nick ?? trigger.actor.id), ...Array.isArray(trigger.meta.images) ? { images: trigger.meta.images as string[] } : {},
  ...typeof trigger.meta.quotedId === 'string' ? { quoted: trigger.meta.quotedId } : {} })
