/**
 * The `dingtalk/` reads of a Trigger's message and its Thread, and `dingtalkThreadContext`, which gives the Thread to assessments with
 * its images. DingTalk keeps no message history a robot may read, so a Thread is what the Source received and sent on it, its
 * transcript; an image is downloaded with the robot's download code
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { dingtalkApi } from '../infra/dingtalk.ts'
import { transcript } from './dingtalk-loops.ts'
import { imageKeys, type DingtalkEntry } from './dingtalk-trigger.ts'
import { imageAttachments, imageType } from './image-model.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** The parts of a Trigger that `dingtalk/<trigger-id>/<part>` reads. */
const PARTS = ['message', 'thread'] as const
/** Checks a model-supplied resource name before reading anything. */
export function dingtalkResource(resource: string): { triggerId: string; part: typeof PARTS[number] } {
  const match = /^dingtalk(?:-[a-z0-9-]+)?\/([^/]+)\/(message|thread)$/.exec(resource)
  if (!match) throw new Error('Use dingtalk/<trigger-id>/message or /thread')
  return { triggerId: match[1]!, part: match[2] as typeof PARTS[number] }
}
/** The resources `trigger/<id>` shows as its context. */
export const dingtalkReferences = (prefix: string, trigger: Trigger): Record<string, string> =>
  Object.fromEntries(PARTS.map(part => [part, `${prefix}/${trigger.id}/${part}`]))

const view = (entry: DingtalkEntry): ContextMessage => ({ id: entry.id, from: entry.from, at: entry.at, text: entry.text,
  ...entry.bot ? { bot: true } : {}, ...entry.quoted ? { reply_to: entry.quoted } : {} })
/** The messages of `trigger`'s Thread, oldest first, as instance `source` received and sent them. */
const threadOf = (source: string, trigger: Trigger): DingtalkEntry[] => transcript(source, trigger.threads[0]!.id)

/**
 * Reads `part` of `trigger`, a Trigger of instance `source`: `message`, the message as received, with its sender's name and
 * whether DingTalk marks them a group admin, the conversation, the message it quotes and its files; or `thread`, the Thread's
 * transcript.
 */
export function dingtalkRead(source: string, trigger: Trigger, part: typeof PARTS[number]): Record<string, unknown> {
  const meta = trigger.meta
  if (part === 'thread') return { status: 'available', thread: `${trigger.threads[0]!.source}:${trigger.threads[0]!.id}`, messages: threadOf(source, trigger).map(view) }
  return { status: 'available', message: { id: meta.messageId, from: meta.nick ?? trigger.actor.id, sender: trigger.actor.id,
    ...meta.isAdmin === true ? { group_admin: true } : {}, at: trigger.at, text: trigger.text,
    conversation: meta.direct === true ? 'direct' : meta.title ?? meta.conversationId, ...meta.quotedId ? { reply_to: meta.quotedId } : {},
    ...Array.isArray(meta.files) ? { files: meta.files } : {} } }
}

/** One image of a message, saved as an attachment for the assessing Session. */
export interface DingtalkImage { source_message_id: string; image_key: string; image: unknown }
/**
 * Downloads image `key` (`image-<n>`) of message `message` of `trigger`'s Thread through the robot's download code, within
 * the deployment's image byte limit, and saves it as an attachment for `agent`.
 * @throws for a key the message does not have, a model that reads no images, or a file that is not a PNG, JPEG, WebP or GIF image.
 */
export async function readDingtalkImage(agent: Agent, commands: Commands, trigger: Trigger, message: { id: string }, key: string,
  signal: AbortSignal): Promise<DingtalkImage> {
  const own = message.id === trigger.meta.messageId && Array.isArray(trigger.meta.images) ? trigger.meta.images as string[] : undefined
  const codes = own ?? threadOf(commands.source, trigger).find(entry => entry.id === message.id)?.images ?? []
  const code = /^image-(\d+)$/.exec(key) ? codes[Number(key.slice('image-'.length)) - 1] : undefined
  if (!code) throw new Error('Choose an image key from this message')
  const app = commands.deployment.dingtalk
  if (!app) throw new Error('The DingTalk Source has no verified app')
  const attachments = await imageAttachments(agent, signal)
  const api = dingtalkApi(app)
  const { downloadUrl } = await api.call(z.object({ downloadUrl: z.string().min(1) }), '/v1.0/robot/messageFiles/download',
    { downloadCode: code, robotCode: app.robotCode }, signal)
  const limit = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  const { data } = await api.download(downloadUrl, limit, signal)
  const mediaType = imageType(data)
  if (!mediaType) throw new Error('The downloaded file is not a supported PNG/JPEG/WebP/GIF image')
  signal.throwIfAborted()
  const image = await attachments.saveImage({ data, mediaType, name: `${key}.${mediaType.slice('image/'.length)}` })
  return { source_message_id: message.id, image_key: key, image }
}

/** The Thread of a DingTalk Trigger for assessments: its transcript in one page, its first message, and the message it quotes. */
export const dingtalkThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, part) => {
    if (trigger.source !== commands.source) throw new Error('A DingTalk source trigger is required')
    const messages = threadOf(commands.source, trigger).map(view)
    if (part === 'thread') return { messages, body: { status: 'available', messages }, status: 'available' }
    const target = part === 'root' ? messages[0] : messages.find(message => message.id === trigger.meta.quotedId)
    const status = target ? 'available' : `no_${part}`
    return { messages: target ? [target] : [], body: { status, message: target ?? null }, status }
  },
  images: imageKeys,
  image: (agent, commands, trigger, message, key, _stateDir, signal) => readDingtalkImage(agent, commands, trigger, message, key, signal),
}
