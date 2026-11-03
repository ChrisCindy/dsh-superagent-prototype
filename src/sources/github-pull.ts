/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, SOURCE, UserSchema } from './github-trigger.ts'

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  draft: z.boolean().optional(), additions: z.number().optional(), deletions: z.number().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
/** The number of instance `source`'s Issue or PR Thread `thread`, such as 12 for `github:12`. */
const pullNumber = (thread: string, source = SOURCE): number | undefined => {
  if (!thread.startsWith(`${source}:`)) return undefined
  const number = Number(thread.slice(source.length + 1))
  return Number.isInteger(number) && number > 0 ? number : undefined
}
/** The PRs of instance `source` that a ticket follows (only the open ones with `open`), in the order it began following them. */
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false, source = SOURCE): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread, source) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>, source = SOURCE): number | undefined =>
  pullsOf(ticket, true, source).at(-1) ?? pullsOf(ticket, false, source).at(-1)
/** True when the PR was opened by the agent account from a branch in `repository` (not a fork). */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  account: Pick<Deployment['github'], 'login'>, repository: string): boolean =>
  sameName(pr.user.login, account.login) && sameName(pr.head?.repo?.full_name ?? '', repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === ctx.source && source.meta.isPr === true && source.meta.number === pr.number
  const opened = agentPull(pr, ctx.deployment.github, ctx.commands.repository) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.github
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true, ctx.source).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${ctx.source}:${pr.number}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment.github, ctx.commands.repository) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${ctx.source}:${pr.number}` && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true, ctx.source).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(`${ctx.source}:${pr.number}`, { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: ctx.source, id: String(pr.number) }, own)
    ctx.threads.patch(`${ctx.source}:${pr.number}`, { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true, ctx.source).includes(pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: ctx.source, id: String(pr.number) }, pr.merged ? 'merged' : 'closed', at)
}
/** The GitHub instance and number of a followed PR Thread, such as `github-docs:12`, when `repositories` holds that instance. */
function pullThread(thread: string, repositories: Readonly<Record<string, string>>): { repository: string; number: number } | undefined {
  const at = thread.lastIndexOf(':')
  const repository = at > 0 ? repositories[thread.slice(0, at)] : undefined
  const number = repository ? pullNumber(thread, thread.slice(0, at)) : undefined
  return repository && number ? { repository, number } : undefined
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed), on whichever GitHub instance `repositories` (by instance ID) holds it. The notice
 * language follows the ticket's source request: Chinese when it contains Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repositories: Readonly<Record<string, string>>): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullThread(item.thread, repositories) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const { repository, number } = pullThread(follow.thread, repositories)!
  const url = githubPage(repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub timelines and linked issues already show the merge or closure, so the Channels of every GitHub Source are skipped,
  // also of one without a repository now: an instance's ID starts with its kind.
  const github = (source: string) => source === SOURCE || source.startsWith(`${SOURCE}-`) || source in repositories
  return ticket.channels.filter(channel => !github(channel.source)).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
