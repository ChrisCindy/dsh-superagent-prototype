/**
 * The code-host Source's reads through its adapter: the `codehost/` resources, `codehostThreadContext` (an Issue's or pull request's
 * conversation by page) and `readCodehostPath`, a repository file or directory for assessments
 */
import { ApprovalsSchema, ChecksSchema, CommentSchema, CommentsSchema, ContentsSchema, ThreadSchema, type CodehostComment } from '../codehost.ts'
import { validItems, type Commands } from '../infra/commands.ts'
import { allComments, codehostCall, threadOf, type ThreadType } from './codehost-trigger.ts'
import { prFiles } from './codehost-pull.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** A comment or review as a model-facing message; a bot's never authorizes work. */
function message(comment: CodehostComment): ContextMessage {
  const decision = comment.review && comment.review !== 'commented' ? `${comment.review.toUpperCase()} review` : ''
  return { id: comment.id, from: comment.author.login, at: comment.createdAt, text: [decision, comment.body].filter(Boolean).join('\n\n'),
    ...comment.author.bot ? { bot: true as const } : {}, ...comment.replyTo ? { reply_to: comment.replyTo } : {},
    ...comment.url ? { url: comment.url } : {}, ...comment.path ? { path: comment.path, ...comment.line !== undefined ? { line: comment.line } : {} } : {} }
}
/** An Issue's or pull request's description as the first message of its conversation, whose id is `description`. */
async function description(commands: Commands, type: ThreadType, number: number): Promise<ContextMessage> {
  const thread = await codehostCall(commands, 'thread', { type, number }, ThreadSchema)
  return { id: 'description', from: thread.author.login, at: thread.createdAt, text: [thread.title, thread.body ?? ''].filter(Boolean).join('\n\n'),
    ...thread.author.bot ? { bot: true as const } : {}, url: thread.url }
}
const RESOURCE = /^(issues|prs)\/([1-9]\d*)(?:\/(comments|files|checks|approvals))?$/
/**
 * Reads an Issue or pull request (`<prefix>/issues/<n>`, `<prefix>/prs/<n>`), its comments, or a pull request's files, CI or
 * approvals, through the adapter of instance `prefix`, whose repository `commands` call.
 */
export async function readCodehost(commands: Commands, resource: string, prefix: string): Promise<unknown> {
  const match = RESOURCE.exec(resource.startsWith(`${prefix}/`) ? resource.slice(prefix.length + 1) : '')
  if (!match) throw new Error(`Use ${prefix}/issues/<number> or ${prefix}/prs/<number>, or append /comments; a PR also /files, /checks or /approvals`)
  const [, kind, digits, section] = match
  const type: ThreadType = kind === 'prs' ? 'pr' : 'issue'
  const number = Number(digits)
  if (type === 'issue' && section && section !== 'comments') throw new Error('Files, checks and approvals require a pull request')
  if (section === 'comments') return { messages: (await allComments(commands, type, number)).map(message) }
  if (section === 'files') return prFiles(commands, number)
  if (section === 'checks') return codehostCall(commands, 'checks', { number }, ChecksSchema)
  if (section === 'approvals') return codehostCall(commands, 'approvals', { number }, ApprovalsSchema)
  return codehostCall(commands, 'thread', { type, number }, ThreadSchema)
}

/**
 * The conversation of a Trigger's Issue or pull request for assessments: its description, then its comments a page at a time. The
 * root is the description; the parent is the comment the Trigger's comment replies to, found in its first pages.
 */
export const codehostThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.commentId ?? 'description'),
  async read(commands, trigger, part, cursor) {
    const thread = threadOf(trigger.threads[0]?.id ?? '')
    if (!thread) return { messages: [], body: { messages: [] }, status: 'no_thread' }
    const { type, number } = thread
    if (part === 'root') { const root = await description(commands, type, number); return { messages: [root], body: { messages: [root] } } }
    if (part === 'parent') {
      const parent = typeof trigger.meta.replyTo === 'string' ? (await allComments(commands, type, number, undefined, 5)).find(item => item.id === trigger.meta.replyTo) : undefined
      const messages = parent ? [message(parent)] : [await description(commands, type, number)]
      return { messages, body: { messages } }
    }
    const page = await codehostCall(commands, 'comments', { type, number, cursor: cursor ?? null }, CommentsSchema)
    const messages = [...cursor ? [] : [await description(commands, type, number)], ...validItems(CommentSchema, page.comments).map(message)]
    return { messages, ...page.cursor ? { next: page.cursor } : {}, body: { messages } }
  },
}

/** Reads a non-hidden file, or lists a directory, of the default branch through the adapter's `contents`. */
export async function readCodehostPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const answer = await codehostCall(commands, 'contents', { path: parts.join('/'), kind }, ContentsSchema) as { content?: string; entries?: { name: string }[] }
  if (kind === 'file') {
    if (typeof answer.content !== 'string') throw new Error(`${path} is not a file`)
    return answer.content
  }
  if (!answer.entries) throw new Error(`${path} is not a directory`)
  return answer.entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
