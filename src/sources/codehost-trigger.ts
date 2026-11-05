/**
 * The code-host Source's adapter calls (`codehostCall`, `mergeCall`), its Thread ids (`12` for an Issue, `!12` for a pull request),
 * adapter events and CI changes as Triggers, and its Channel: comments posted once by their idempotency marker, `sent` or `gone`
 */
import type { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage, type Trigger } from '../core/index.ts'
import { adapterCall, CODEHOST, CommentSchema, CommentsSchema, PostedSchema, type CodehostEvent, type CodehostRepository, type Operation }
  from '../codehost.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'

export type ThreadType = 'issue' | 'pr'
/** The Thread id of an Issue (`12`) or a pull request (`!12`): a code host may number them apart, so a pull request's carries `!`. */
export const threadId = (type: ThreadType, number: number): string => type === 'pr' ? `!${number}` : String(number)
/** The Issue or pull request a Thread id names, or undefined for another id. */
export function threadOf(id: string): { type: ThreadType; number: number } | undefined {
  const match = /^(!?)([1-9]\d*)$/.exec(id)
  return match ? { type: match[1] ? 'pr' : 'issue', number: Number(match[2]) } : undefined
}
/** How a person names an Issue (`#12`) or a pull request (`!12`). */
export const threadName = (type: ThreadType, number: number): string => `${type === 'pr' ? '!' : '#'}${number}`
/** The prefix of instance `source`'s Trigger IDs: the first instance's start with `codehost-`, another's with its ID. */
const idOf = (source: string, name: string): string => `${source}-${name}`

/**
 * The repository of instance `commands.source` as setup resolved it.
 * @throws when setup resolved no code host, or not this instance.
 */
export function repositoryOf(commands: Pick<Commands, 'deployment' | 'source'>): CodehostRepository {
  const repository = commands.deployment.codehost?.repositories[commands.source]
  if (!repository) throw new Error(`The code-host Source ${commands.source} has no repository: setup has not resolved it`)
  return repository
}
/** Whether the agent's adapter answers `operation`. */
export const answers = (commands: Pick<Commands, 'deployment'>, operation: Operation): boolean =>
  commands.deployment.codehost?.capabilities.includes(operation) ?? false
/**
 * Calls the agent's adapter for the repository of instance `commands.source`, with the commands' signal and environment.
 * @throws CliError 501 when the adapter does not answer `operation`, and the adapter's own error (its `code`) when it fails.
 */
export async function codehostCall<T>(commands: Commands, operation: Operation, request: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const codehost = commands.deployment.codehost
  if (!codehost) throw new Error('No code-host Source is set up')
  if (!codehost.capabilities.includes(operation)) throw new CliError(`The code-host adapter does not answer ${operation}`, 501)
  return adapterCall(([program, ...args]) => commands.run(program!, args), codehost.adapter, operation,
    { repository: repositoryOf(commands).path, ...request }, schema)
}
/** Calls the merge adapter, which acts as the merge account, for the repository of instance `commands.source`. */
export async function mergeCall<T>(commands: Commands, operation: 'whoami' | 'merge', request: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const merge = commands.deployment.codehost?.merge
  if (!merge) throw new Error('No merge adapter is set on the code-host Source')
  const body = operation === 'whoami' ? {} : { repository: repositoryOf(commands).path, ...request }
  return adapterCall(([program, ...args]) => commands.run(program!, args), merge.adapter, operation, body, schema)
}
/** Reads every page of an Issue's or pull request's comments, oldest first, skipping malformed ones; at most `pages` pages. */
export async function allComments(commands: Commands, type: ThreadType, number: number, tally?: Tally, pages = 20) {
  const comments: z.infer<typeof CommentSchema>[] = []
  let cursor: string | null = null
  for (let page = 0; page < pages; page++) {
    const answer: z.infer<typeof CommentsSchema> = await codehostCall(commands, 'comments', { type, number, cursor }, CommentsSchema)
    comments.push(...validItems(CommentSchema, answer.comments, tally))
    if (!answer.cursor) break
    cursor = answer.cursor
  }
  return comments
}

export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-]|\\.[a-zA-Z0-9_])`, 'i').test(text)
/** Reply address of instance `source`: the Issue or pull request, and the comment a reply answers in a review discussion. */
export const codehostChannel = (type: ThreadType, number: number, source = CODEHOST, url?: string, replyTo?: string): ChannelRef =>
  ({ source, thread: `${source}:${threadId(type, number)}`, address: { type, number: String(number), ...url ? { url } : {}, ...replyTo ? { replyTo } : {} } })
/** The admission row of an event: new Issues, new pull requests, or comments. */
const rowOf = (event: CodehostEvent): 'issues' | 'prs' | 'comments' =>
  event.kind === 'comment' || event.kind === 'mention' || event.kind === 'review' ? 'comments' : event.thread.type === 'pr' ? 'prs' : 'issues'
function eventText(event: CodehostEvent): string {
  const { type, number, title } = event.thread
  if (event.kind === 'assigned' || event.kind === 'review_requested') {
    const what = event.kind === 'assigned' ? 'Assigned the agent to' : 'Requested the agent\'s review of'
    return [`${what} ${type === 'pr' ? 'pull request' : 'Issue'} ${threadName(type, number)}${title ? `: ${title}` : ''}`, event.text].filter(Boolean).join('\n\n')
  }
  if (event.kind === 'opened') return [title ?? '', event.text].filter(Boolean).join('\n\n')
  const decision = event.review && event.review !== 'commented' ? `${event.review.toUpperCase()} review` : ''
  const place = event.path ? `${event.path}${event.line !== undefined ? `:${event.line}` : ''}` : ''
  return [decision, place, event.text].filter(Boolean).join('\n\n')
}
/**
 * The Trigger of one adapter event on instance `source`, or undefined for the agent's own events, for `pipeline` and `pr_state`,
 * which carry no message, and for a comment without text. An assignment or a review request addresses the agent directly.
 */
export function eventTrigger(event: CodehostEvent, agent: string, source = CODEHOST): Trigger | undefined {
  if (sameName(event.actor.login, agent) || event.kind === 'pipeline' || event.kind === 'pr_state') return undefined
  const text = eventText(event)
  if (!text) return undefined
  const { type, number } = event.thread
  const direct = event.kind === 'assigned' || event.kind === 'review_requested'
  const addressed = direct ? 'direct' as const : event.kind === 'mention' || event.addressed || mentions(event.text, agent) ? 'mention' as const : undefined
  return {
    id: key(idOf(source, 'event'), event.id), source, threads: [{ source, id: threadId(type, number) }],
    actor: { source, id: event.actor.login }, human: !event.actor.bot, at: event.at, text, ...addressed ? { addressed } : {},
    channel: codehostChannel(type, number, source, event.url, event.path ? event.replyTo ?? event.commentId : undefined),
    ...event.url ? { url: event.url } : {},
    meta: { type, number, isPr: type === 'pr', row: rowOf(event), event: event.kind, eventId: event.id,
      ...event.commentId ? { commentId: event.commentId } : {}, ...event.replyTo ? { replyTo: event.replyTo } : {},
      ...event.path ? { path: event.path, line: event.line ?? null } : {}, ...event.review ? { review: event.review } : {} },
  }
}
/** The Trigger of a change of a pull request's CI; CI has no sender, so its actor is empty. */
export function ciTrigger(number: number, revision: number, summary: string, url: string | undefined, source = CODEHOST): Trigger {
  return { id: key(idOf(source, 'ci'), String(number), String(revision)), source, threads: [{ source, id: threadId('pr', number) }],
    actor: { source, id: '' }, human: false, at: new Date().toISOString(), text: summary,
    channel: codehostChannel('pr', number, source), ...url ? { url } : {},
    meta: { type: 'pr', number, isPr: true, ci: true, revision } }
}

/** The marker a reply carries, by which a retry finds that it was already posted. */
export const marker = (id: string): string => `<!-- dsh-superagent:${id} -->`
/**
 * Posts a reply as a comment once: a retry first looks for the agent's comment with the message's marker. Without `comment` the
 * reply can never go out, so it is `gone`; so is one the adapter answers with 410.
 */
export async function sendCodehost(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { type, number, replyTo } = message.channel.address
  if ((type !== 'issue' && type !== 'pr') || !Number(number)) throw new Error('Missing code-host reply target')
  if (!answers(commands, 'comment')) return 'gone'
  const login = commands.deployment.codehost!.account.login
  try {
    if (answers(commands, 'comments')) {
      const posted = await allComments(commands, type, Number(number))
      if (posted.some(comment => sameName(comment.author.login, login) && comment.body.includes(marker(message.id)))) return 'sent'
    }
    await codehostCall(commands, 'comment', { type, number: Number(number), body: `${message.text}\n\n${marker(message.id)}`, key: message.id,
      replyTo: replyTo ?? null }, PostedSchema)
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
export function codehostLink(address: Record<string, string>): ChannelLink {
  const type = address.type === 'pr' ? 'pr' : 'issue'
  const name = threadName(type, Number(address.number))
  return { url: address.url ?? '', label: address.replyTo ? { zh: `代码托管 ${name} 的评审讨论`, en: `Review discussion on code host ${name}` }
    : { zh: `代码托管 ${name}`, en: `Code host ${name}` } }
}
