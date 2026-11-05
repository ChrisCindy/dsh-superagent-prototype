/** What an assessment needs before it reads an image of a message: the attachment service, and a model route that reads images */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'

/** The image types an assessment reads, by file extension. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif' }
/** The type of the image `data` holds, by its first bytes, or undefined for any other file. */
export function imageType(data: Uint8Array): ImageMediaType | undefined {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}
/**
 * The attachment service of `agent`'s Session, once its model route is known to take image input.
 * @throws when no attachment service is mounted, the route is unresolved, or its model reads no images.
 */
export async function imageAttachments(agent: Agent, signal: AbortSignal) {
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (!llm || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
  signal.throwIfAborted()
  return attachments
}
