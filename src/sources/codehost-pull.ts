/**
 * The code-host pull request rules: which pull requests a Ticket follows (`claimPr`, `observePr`), the closes it reports to the Engine,
 * their CI as Triggers (`pollChecks`), the end notices for other conversations, and `orchestrator_merge_request`'s host checks
 * (`mergeChecks`) before the merge adapter enables auto-merge of the checked head commit (`requestMerge`)
 */
import { actionAllowed, key, liveTicket, outsidePaths, type Follow, type OutboundMessage, type PullChanges, type ThreadFact, type Ticket }
  from '../core/index.ts'
import { AccountSchema, ApprovalsSchema, ChecksSchema, CODEHOST, FilesSchema, MergedSchema, ThreadSchema, type CodehostChecks,
  type CodehostThread } from '../codehost.ts'
import type { Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import type { MergeConfig } from '../policy.ts'
import { answers, ciTrigger, codehostCall, mergeCall, threadId, threadName, threadOf } from './codehost-trigger.ts'
import type { SourceContext } from './host.ts'

export type Pr = CodehostThread & { type: 'pr' }
/** Reads pull request `number` of instance `ctx.source`. */
export async function readPr(commands: Commands, number: number): Promise<Pr> {
  const thread = await codehostCall(commands, 'thread', { type: 'pr', number }, ThreadSchema)
  if (thread.type !== 'pr' || thread.number !== number) throw new Error(`The code-host adapter answered for another thread than pull request !${number}`)
  return thread as Pr
}
/** The pull requests of instance `source` a ticket follows (only the open ones with `open`), in the order it began following them. */
export const prsOf = (ticket: Pick<Ticket, 'follows'>, open = false, source = CODEHOST): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => {
    if (!item.thread.startsWith(`${source}:`)) return []
    const thread = threadOf(item.thread.slice(source.length + 1))
    return thread?.type === 'pr' ? [thread.number] : []
  })
export const prOf = (ticket: Pick<Ticket, 'follows'>, source = CODEHOST): number | undefined =>
  prsOf(ticket, true, source).at(-1) ?? prsOf(ticket, false, source).at(-1)
const agent = (ctx: Pick<SourceContext, 'deployment'>): string => {
  const codehost = ctx.deployment.codehost
  if (!codehost) throw new Error('No code-host Source is set up')
  return codehost.account.login
}
/** True when the agent account opened the pull request from a branch of the repository itself, not from a fork. */
export const agentPr = (pr: Pr, login: string): boolean => sameName(pr.author.login, login) && !pr.head?.repository
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, branch: string | undefined): boolean =>
  !!ticket.execution?.name && !!branch && branch.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }
const OPEN_PR_REFUSED = 'This ticket may not open a PR: its limits leave out open_pr, so the host does not bind one; report without pr_number and say what a person should do'

/**
 * Binds an open pull request to a ticket when it is the ticket's origin pull request, or one the agent opened from a branch named
 * after the ticket, and no other open ticket follows it; returns why it cannot, or undefined (also for one that is not open).
 */
export function claimPr(ctx: SourceContext, ticketId: string, pr: Pr): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  const started = origin?.threads[0]?.source === ctx.source && origin.threads[0]?.id === threadId('pr', pr.number)
  const login = agent(ctx)
  const opened = agentPr(pr, login) && ticketBranch(ticket, pr.head?.branch)
  if (!started && !opened) {
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  if (!started && !actionAllowed(ticket.mandate.limits, 'open_pr')) return OPEN_PR_REFUSED
  const owner = ctx.tickets.open().find(item => prsOf(item, true, ctx.source).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${ctx.source}:${threadId('pr', pr.number)}`)
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
function bind(ctx: SourceContext, ticketId: string, pr: Pr, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: ctx.source, id: threadId('pr', pr.number) }, own)
    ctx.threads.patch(`${ctx.source}:${threadId('pr', pr.number)}`, { type: 'pr', number: pr.number, isPr: true, url: pr.url, prAuthor: pr.author.login })
  })
}
/** The files a pull request changes, a renamed file under both its names. */
export async function prFiles(commands: Commands, number: number): Promise<PullChanges> {
  const { files, complete } = await codehostCall(commands, 'files', { number }, FilesSchema)
  return { pull: number, files: files.flatMap(file => [file.path, ...file.previousPath ? [file.previousPath] : []]), complete }
}
/** The files of each open pull request the ticket opened, counting `pr` when the report binds one, for a `ready` report under paths. */
export async function readyChanges(ctx: SourceContext, ticket: Ticket, state: string, pr: Pr | undefined, signal: AbortSignal): Promise<PullChanges[]> {
  if (state !== 'ready' || !ticket.mandate.limits?.paths) return []
  const own = new Set((ticket.follows ?? []).filter(item => item.own && !item.closed).flatMap(item => prsOf({ follows: [item] }, false, ctx.source)))
  if (pr && pr.state === 'open' && agentPr(pr, agent(ctx)) && ticketBranch(ticket, pr.head?.branch)) own.add(pr.number)
  const commands = ctx.commands.withSignal(signal)
  // Without `files` the host cannot check the paths, so the change counts as one it could not check whole.
  return Promise.all([...own].map(number => answers(commands, 'files') ? prFiles(commands, number) : { pull: number, files: [], complete: false }))
}
/**
 * Reconciles a read pull request with the tickets: a merged or closed one ends those that follow it, and an open one the agent
 * opened binds to the single open ticket of its branch unless that ticket follows another open pull request.
 * @returns whether the pull request has ended.
 */
export function observePr(ctx: SourceContext, pr: Pr): boolean {
  const ended = pr.state !== 'open'
  const thread = `${ctx.source}:${threadId('pr', pr.number)}`
  if (ended) {
    if (ctx.tickets.open().some(ticket => prsOf(ticket, true, ctx.source).includes(pr.number))) {
      ctx.tickets.threadClosed({ source: ctx.source, id: threadId('pr', pr.number) }, pr.state === 'merged' ? 'merged' : 'closed',
        pr.mergedAt ?? pr.closedAt ?? new Date().toISOString())
    }
  } else {
    const candidates = agentPr(pr, agent(ctx)) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head?.branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const openedAgain = ticket?.follows?.some(item => item.thread === thread && item.closed)
    if (ticket && (openedAgain || prsOf(ticket, true, ctx.source).every(number => number === pr.number))) claimPr(ctx, ticket.id, pr)
  }
  ctx.threads.patch(thread, { title: pr.title })
  ctx.threads.describe(thread, { label: `${threadName('pr', pr.number)} ${pr.title}`, url: pr.url,
    facts: { number: { value: threadName('pr', pr.number) }, autoMerge: !ended && pr.autoMerge ? AUTO_MERGE_ON : null } })
  return ended
}

const FAILING = new Set(['failure', 'cancelled'])
const names = (list: readonly string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
export function ciSummary(ci: CodehostChecks, where: string, read: string): string {
  const failed = ci.checks.filter(check => FAILING.has(check.state)).map(check => check.name)
  const running = ci.checks.filter(check => check.state === 'running').map(check => check.name)
  const total = ci.checks.length
  const at = `on ${where} at ${ci.sha.slice(0, 7)}`
  const line = failed.length ? `CI failed ${failed.length}/${total} ${at}: ${names(failed)}${running.length ? `; ${running.length} still running` : ''}`
    : running.length ? `CI running ${running.length}/${total} ${at}: ${names(running)}` : `CI passed ${total}/${total} ${at}`
  return `${line}\nRead ${read} for every check.`
}
export function ciFact(ci: CodehostChecks): ThreadFact {
  const failed = ci.checks.filter(check => FAILING.has(check.state)).length, running = ci.checks.filter(check => check.state === 'running').length
  if (failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(failed), problem: true }
  if (running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}
/** Reads a pull request's CI; a change after the first reading, the baseline, becomes a Trigger. */
export async function pollChecks(ctx: SourceContext, commands: Commands, pr: Pr): Promise<void> {
  const ci = await codehostCall(commands, 'checks', { number: pr.number }, ChecksSchema)
  const snapshot = { sha: ci.sha, checks: ci.checks.map(({ name, state }) => ({ name, state })).sort((a, b) => a.name.localeCompare(b.name) || a.state.localeCompare(b.state)) }
  const fingerprint = key(JSON.stringify(snapshot))
  const id = threadId('pr', pr.number)
  const previous = ctx.state.get(KV.codehost.ci(id))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(ciTrigger(pr.number, revision, ciSummary(ci, `PR ${threadName('pr', pr.number)}`, `${ctx.source}/prs/${pr.number}/checks`), pr.url, ctx.source))
  ctx.state.set(KV.codehost.ci(id), { fingerprint, revision })
  ctx.threads.describe(`${ctx.source}:${id}`, { facts: { ci: ciFact(ci) } })
}

/**
 * Notices for a ticket's other conversations, such as a chat, when it ends with a pull request it followed on a code-host instance:
 * the last one it opened that closed, else the last one it followed. The code host shows its own merge, so its Channels get none.
 */
export function prEndNotices(ticket: Ticket, request: string, url: (thread: string) => string | undefined): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const ours = (thread: string) => thread.startsWith(`${CODEHOST}:`) || thread.startsWith(`${CODEHOST}-`)
  const follows = (ticket.follows ?? []).filter(item => item.closed && ours(item.thread) && threadOf(item.thread.slice(item.thread.indexOf(':') + 1))?.type === 'pr')
  const latest = (items: Follow[]) => [...items].sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const name = follow.thread.slice(follow.thread.indexOf(':') + 1)
  const link = url(follow.thread)
  const pr = link ? `[PR ${name}](${link})` : `PR ${name}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese ? outcome === 'merged' ? `${pr} 已合并。` : `${pr} 已关闭，未合并。`
    : outcome === 'merged' ? `${pr} has merged.` : `${pr} was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== CODEHOST && !channel.source.startsWith(`${CODEHOST}-`)).map(channel => ({
    id: key('pr-terminal', follow.thread, channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}

export type MergeCheck = 'merge_cli' | 'limits' | 'ticket_pull' | 'open' | 'ready' | 'ci' | 'size' | 'paths' | 'approvals' | 'changes_requested'
  | 'merge_account'
export interface MergeRefusal { check: MergeCheck; detail: string }
export type MergeResult = { auto_merge: 'enabled' | 'merged'; pull: number; head: string; method: MergeConfig['method'] }
  | { auto_merge: 'refused'; pull: number; refused: MergeRefusal[]; next: string }
/**
 * Checks a pull request against the merge settings and the ticket's Mandate limits, as the GitHub Source does: a merge adapter is
 * set, the limits allow merging, the ticket opened the pull request and follows it, it is open and not a draft, every check of
 * its head commit succeeded, it changes at most `maxLines` lines and only files within the Mandate's paths, approvals of people
 * other than the agent and the author cover its head commit, no requested change is outstanding, and the merge adapter acts as
 * another account. An operation the adapter does not answer fails the check that needs it.
 */
export async function mergeChecks(ctx: SourceContext, ticket: Pick<Ticket, 'follows' | 'mandate'>, number: number, merge: MergeConfig,
  signal?: AbortSignal): Promise<{ refused: MergeRefusal[]; head?: string }> {
  const refused: MergeRefusal[] = []
  const { limits } = ticket.mandate
  const commands = ctx.commands.withSignal(signal)
  if (!ctx.deployment.codehost?.merge) refused.push({ check: 'merge_cli', detail: 'No merge adapter is set on the code-host Source, so a person merges every PR' })
  if (!actionAllowed(limits, 'merge')) refused.push({ check: 'limits', detail: 'This ticket\'s limits leave out merge, so a person merges its PR' })
  const own = ticket.follows?.some(item => item.thread === `${ctx.source}:${threadId('pr', number)}` && item.own && !item.closed)
  if (!own) refused.push({ check: 'ticket_pull', detail: `This ticket did not open PR !${number}, or does not follow it; bind the PR it opened with orchestrator_report pr_number first` })
  if (!answers(commands, 'thread')) refused.push({ check: 'open', detail: 'The code-host adapter cannot read pull requests, so a person merges this PR' })
  if (refused.length) return { refused }
  const pr = await readPr(commands, number)
  const head = pr.head?.sha
  if (!head) return { refused: [{ check: 'open', detail: `The code-host adapter reported no head commit of PR !${number}` }] }
  if (pr.state !== 'open') refused.push({ check: 'open', detail: `PR !${number} is ${pr.state}` })
  if (pr.draft) refused.push({ check: 'ready', detail: `PR !${number} is a draft; mark it ready for review first` })
  if (pr.additions === undefined || pr.deletions === undefined) refused.push({ check: 'size', detail: 'The code host did not report the size of the PR' })
  else if (pr.additions + pr.deletions > merge.maxLines) {
    refused.push({ check: 'size', detail: `PR !${number} changes ${pr.additions + pr.deletions} lines (additions plus deletions), more than the ${merge.maxLines} auto-merge accepts` })
  }
  if (limits?.paths) {
    const changes = answers(commands, 'files') ? await prFiles(commands, number) : { pull: number, files: [], complete: false }
    const outside = outsidePaths(limits, [changes])
    if (outside.length) refused.push({ check: 'paths', detail: `${outside.join('; ')}: outside the files this ticket may change (${limits.paths.join(', ')})` })
  }
  if (!answers(commands, 'checks')) refused.push({ check: 'ci', detail: 'The code-host adapter cannot read CI, so a person merges this PR' })
  else {
    const ci = await codehostCall(commands, 'checks', { number }, ChecksSchema)
    const failed = ci.checks.filter(check => FAILING.has(check.state)).map(check => check.name)
    const running = ci.checks.filter(check => check.state === 'running').map(check => check.name)
    if (ci.sha !== head) refused.push({ check: 'ci', detail: `CI has not reported on the head commit ${head.slice(0, 7)} yet` })
    else if (failed.length) refused.push({ check: 'ci', detail: `CI failed on ${head.slice(0, 7)}: ${names(failed)}` })
    else if (running.length) refused.push({ check: 'ci', detail: `CI is still running on ${head.slice(0, 7)}: ${names(running)}` })
  }
  const login = agent(ctx)
  if (!answers(commands, 'approvals')) refused.push({ check: 'approvals', detail: 'The code-host adapter cannot read approvals, so a person merges this PR' })
  else {
    const review = await codehostCall(commands, 'approvals', { number }, ApprovalsSchema)
    const people = (name: string) => !sameName(name, login) && !sameName(name, pr.author.login)
    const requested = review.changesRequested.filter(people)
    if (requested.length) refused.push({ check: 'changes_requested', detail: `Changes requested by ${names(requested)} are outstanding` })
    // An approval covers the head commit when it names it, or names none on a host that withdraws approvals on a push.
    const approvers = new Set(review.approvals.filter(item => !item.bot && people(item.login) && (item.sha ? item.sha === head : review.dismissesStale))
      .map(item => item.login.toLowerCase()))
    if (approvers.size < merge.requireApprovals) {
      refused.push({ check: 'approvals', detail: `${approvers.size} of the ${merge.requireApprovals} approvals required cover the head commit ${head.slice(0, 7)}` })
    }
  }
  // The code host credits the merge to the account that enables it, which must not be the agent's.
  const merger = await mergeCall(commands, 'whoami', {}, AccountSchema).then(account => account.login, (error: unknown) => {
    refused.push({ check: 'merge_account', detail: `The merge adapter cannot read its account: ${error instanceof Error ? error.message : String(error)}` })
    return undefined
  })
  if (merger !== undefined && sameName(merger, login)) refused.push({ check: 'merge_account', detail: `The merge adapter acts as the agent account @${login}` })
  return { refused, head }
}
/** Asks the merge adapter to merge the checked head commit once its checks pass, after `mergeChecks` passed. */
export async function requestMerge(ctx: SourceContext, ticket: Pick<Ticket, 'follows' | 'mandate'>, number: number, merge: MergeConfig,
  signal?: AbortSignal): Promise<MergeResult> {
  const { refused, head } = await mergeChecks(ctx, ticket, number, merge, signal)
  if (refused.length || !head) {
    const people = refused.some(item => ['merge_cli', 'limits', 'size', 'merge_account'].includes(item.check) || /cannot read/.test(item.detail))
    const next = people ? 'A person merges this PR; say so in your report.'
      : 'Fix what you can and call again for the new head; report ready without waiting for approvals, and call again when they arrive.'
    return { auto_merge: 'refused', pull: number, refused, next }
  }
  const { state } = await mergeCall(ctx.commands.withSignal(signal), 'merge', { number, sha: head, method: merge.method }, MergedSchema)
  return { auto_merge: state, pull: number, head, method: merge.method }
}
