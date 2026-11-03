/** Host checks of a PR an Executor asks to merge, and enabling auto-merge for it with the merge account's CLI. */
import { z } from 'zod'
import { actionAllowed, outsidePaths, type Ticket } from '../core/index.ts'
import type { MergeConfig } from '../policy.ts'
import { sameName } from '../infra/text.ts'
import { ciFailures, pullChecks, pullFiles } from './github-read.ts'
import { readPull } from './github-pull.ts'
import { isHumanLogin } from './github-trigger.ts'
import type { SourceContext } from './host.ts'

const ReviewSchema = z.looseObject({ user: z.looseObject({ login: z.string(), type: z.string().optional() }).nullable(), state: z.string(),
  commit_id: z.string().nullish() })
const CommitSchema = z.looseObject({ tree: z.looseObject({ sha: z.string() }) })

/** The condition a refusal names: each is checked by the host before auto-merge is enabled. */
export type MergeCheck = 'merge_cli' | 'limits' | 'ticket_pull' | 'open' | 'ready' | 'ci' | 'size' | 'paths' | 'approvals' | 'changes_requested'
  | 'merge_account'
export interface MergeRefusal { check: MergeCheck; detail: string }
export type MergeResult = { auto_merge: 'enabled'; pull: number; head: string; method: MergeConfig['method'] }
  | { auto_merge: 'refused'; pull: number; refused: MergeRefusal[]; next: string }

const names = (list: readonly string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
/**
 * Checks a PR against the merge settings and the ticket's Mandate limits: they allow merging, the ticket opened it and follows
 * it, it is open and not a draft, every CI check of its head commit succeeded, it changes at most `maxLines` lines and only
 * files within the Mandate's paths, approvals of accounts other than the agent cover its head commit
 * (an approval of an earlier commit with the same tree, such as one rewritten to credit a reviewer, covers it too), and no
 * requested change is outstanding. Reads go through the agent's GitHub CLI.
 * @returns the refusals, empty when every check passed, and the head commit that was checked.
 */
export async function mergeChecks(ctx: SourceContext, ticket: Pick<Ticket, 'follows' | 'mandate'>, number: number, merge: MergeConfig,
  signal?: AbortSignal): Promise<{ refused: MergeRefusal[]; head?: string }> {
  const refused: MergeRefusal[] = []
  const { limits } = ticket.mandate
  if (!merge.cli) refused.push({ check: 'merge_cli', detail: 'No merge CLI is set in the Execution settings, so a person merges every PR' })
  if (!actionAllowed(limits, 'merge')) refused.push({ check: 'limits', detail: 'This ticket\'s limits leave out merge, so a person merges its PR' })
  const own = ticket.follows?.some(item => item.thread === `${ctx.source}:${number}` && item.own && !item.closed)
  if (!own) refused.push({ check: 'ticket_pull', detail: `This ticket did not open PR #${number}, or does not follow it; bind the PR it opened with orchestrator_report pr_number first` })
  if (refused.length) return { refused }
  const commands = ctx.commands.withSignal(signal)
  const pull = await readPull(ctx, number, signal)
  const head = pull.head.sha
  if (pull.state !== 'open' || pull.merged) refused.push({ check: 'open', detail: `PR #${number} is ${pull.merged ? 'merged' : pull.state}` })
  if (pull.draft) refused.push({ check: 'ready', detail: `PR #${number} is a draft; mark it ready for review first` })
  const lines = (pull.additions ?? 0) + (pull.deletions ?? 0)
  if (pull.additions === undefined || pull.deletions === undefined) refused.push({ check: 'size', detail: 'GitHub did not report the size of the PR' })
  else if (lines > merge.maxLines) refused.push({ check: 'size', detail: `PR #${number} changes ${lines} lines (additions plus deletions), more than the ${merge.maxLines} auto-merge accepts` })
  // A PR that changes files outside the Mandate's paths is a wider change than the ticket was accepted for.
  const outside = limits?.paths ? outsidePaths(limits, [await pullFiles(commands, number)]) : []
  if (outside.length) refused.push({ check: 'paths', detail: `${outside.join('; ')}: outside the files this ticket may change (${limits!.paths!.join(', ')})` })
  const ci = await pullChecks(commands, head)
  const failed = ciFailures(ci)
  const running = [...ci.checks.filter(check => check.status !== 'completed').map(check => check.name),
    ...ci.statuses.filter(status => status.state === 'pending').map(status => status.context)]
  if (failed.length) refused.push({ check: 'ci', detail: `CI failed on ${head.slice(0, 7)}: ${names(failed)}` })
  else if (running.length) refused.push({ check: 'ci', detail: `CI is still running on ${head.slice(0, 7)}: ${names(running)}` })
  // The latest decision of each person other than the agent and the PR's author; a comment decides nothing, a dismissal withdraws one.
  const { login } = ctx.deployment.github
  const latest = new Map<string, { state: string; commit?: string }>()
  for (const review of await commands.pages(ReviewSchema, `pulls/${number}/reviews?per_page=100`)) {
    const user = review.user
    if (!user || !isHumanLogin(user) || sameName(user.login, login) || sameName(user.login, pull.user.login)) continue
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') latest.set(user.login.toLowerCase(), { state: review.state, ...review.commit_id ? { commit: review.commit_id } : {} })
    else if (review.state === 'DISMISSED') latest.delete(user.login.toLowerCase())
  }
  const requested = [...latest].filter(([, review]) => review.state === 'CHANGES_REQUESTED').map(([name]) => name)
  if (requested.length) refused.push({ check: 'changes_requested', detail: `Changes requested by ${names(requested)} are outstanding` })
  const trees = new Map<string, Promise<string>>()
  const tree = (sha: string) => trees.get(sha) ?? trees.set(sha, commands.api(CommitSchema, `git/commits/${sha}`).then(commit => commit.tree.sha)).get(sha)!
  let approvals = 0
  for (const review of latest.values()) {
    if (review.state !== 'APPROVED' || !review.commit) continue
    if (review.commit === head || await tree(review.commit).catch(() => '') === await tree(head)) approvals++
  }
  if (approvals < merge.requireApprovals) {
    refused.push({ check: 'approvals', detail: `${approvals} of the ${merge.requireApprovals} approvals required cover the head commit ${head.slice(0, 7)}` })
  }
  // GitHub attributes the merge to the account that enables auto-merge, which must not be the agent's.
  const merger = (await commands.run(merge.cli, ['api', 'user', '--jq', '.login']).catch((error: unknown) => {
    refused.push({ check: 'merge_account', detail: `The merge CLI cannot read its account: ${error instanceof Error ? error.message : String(error)}` })
    return undefined
  }))?.trim()
  if (merger !== undefined && (!merger || sameName(merger, login))) {
    refused.push({ check: 'merge_account', detail: merger ? `The merge CLI is signed in to the agent account @${login}` : 'The merge CLI did not report its account' })
  }
  return { refused, head }
}

/**
 * Enables auto-merge of a PR the ticket opened once `mergeChecks` passes, as the merge account with `--match-head-commit` so
 * only the commit that was checked merges; GitHub's own rules, such as required reviews, still apply when it merges.
 */
export async function requestMerge(ctx: SourceContext, ticket: Pick<Ticket, 'follows' | 'mandate'>, number: number, merge: MergeConfig,
  signal?: AbortSignal): Promise<MergeResult> {
  const { refused, head } = await mergeChecks(ctx, ticket, number, merge, signal)
  if (refused.length || !head) {
    const people = refused.some(item => ['merge_cli', 'limits', 'size', 'merge_account'].includes(item.check))
    const next = people ? 'A person merges this PR; say so in your report.'
      : 'Fix what you can and call again for the new head; report ready without waiting for approvals, and call again when they arrive.'
    return { auto_merge: 'refused', pull: number, refused, next }
  }
  await ctx.commands.withSignal(signal).run(merge.cli, ['pr', 'merge', String(number), '--auto', `--${merge.method}`, '--match-head-commit', head,
    '--repo', ctx.commands.repository])
  return { auto_merge: 'enabled', pull: number, head, method: merge.method }
}
