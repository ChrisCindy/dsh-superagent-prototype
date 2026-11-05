/**
 * The code-host kind and plugin entry, exported as `./codehost-watch`: a Source for a code host that an operator's adapter command
 * reaches (docs/010). A poll round reads the adapter's events after its cursor, then the pull requests of open Tickets with their CI
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { CODEHOST, CodehostSetupSchema, EventSchema, EventsSchema } from '../codehost.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { answers, codehostCall, codehostChannel, codehostLink, eventTrigger, sendCodehost, threadId, threadName, threadOf, type ThreadType }
  from './codehost-trigger.ts'
import { claimPr, observePr, pollChecks, prEndNotices, prOf, prsOf, readPr, readyChanges, requestMerge } from './codehost-pull.ts'
import { codehostThreadContext, readCodehost, readCodehostPath } from './codehost-read.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { pause, polled } from './poll.ts'

const CodehostConfigSchema = CodehostSetupSchema.extend({
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePrs: z.boolean().default(false), observeComments: z.boolean().default(false),
}).strict()
export type CodehostConfig = z.infer<typeof CodehostConfigSchema>
const OBSERVED = { issues: 'observeIssues', prs: 'observePrs', comments: 'observeComments' } as const
type Row = keyof typeof OBSERVED
const rowOf = (meta: Record<string, unknown>): Row | undefined =>
  meta.row === 'issues' || meta.row === 'prs' || meta.row === 'comments' ? meta.row : undefined
const account = (deployment: { codehost?: { account: { login: string } } } | undefined) => deployment?.codehost?.account.login ?? ''

export const codehostKind: SourceKind<CodehostConfig> = {
  kind: CODEHOST,
  title: { zh: '代码托管', en: 'Code host' },
  description: { zh: '通过运维方提供的适配器命令接入的代码托管（docs/010 描述适配器契约）；接收仓库里发给智能体的事件、已订阅 Issue 与 PR 的讨论、CI 变化和 PR 合并关闭。每个仓库一个代码托管来源，共用智能体的账号。', en: 'A code host reached through an adapter command the operator supplies (docs/010 describes the adapter contract); receives events addressed to the agent in the repository, discussion on subscribed Issues and PRs, CI changes, and PR merge or close. Each repository has its own code-host Source, and they share the agent\'s account.' },
  setup: Object.keys(CodehostSetupSchema.shape),
  schema: CodehostConfigSchema,
  fields: [
    { key: 'adapter', type: 'text', label: { zh: '智能体的适配器', en: 'Agent adapter' },
      hint: { zh: '命令名或绝对路径，按 docs/010 的契约以智能体的账号回答代码托管的操作，也给执行器的 git 提供凭据。保存时检查它的契约版本、账号和仓库的推送权限，然后重启 dsh-superagent。', en: 'A command name or absolute path that answers the code host\'s operations as the agent\'s account, following the contract of docs/010, and serves the credential of workers\' git. Saving checks its contract version, its account and push access to the repository, then restarts dsh-superagent.' } },
    { key: 'repository', type: 'text', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '适配器认得的仓库名，例如 group/name。这个来源接收这个仓库的事件。', en: 'The repository as the adapter names it, such as group/name. This Source receives that repository\'s events.' } },
    { key: 'mergeAdapter', type: 'text', label: { zh: '合并用的适配器', en: 'Merge adapter' },
      hint: { zh: '以另一个可以合并的账号回答 whoami 和 merge 的适配器。留空时，代码托管的 PR 都由人合并。合并的行数上限、批准数和方式取执行设置。', en: 'An adapter that answers whoami and merge as another account that may merge. Empty: people merge every code-host PR. The line limit, approvals and method come from the Execution settings.' } },
    { key: 'workerCli', type: 'text', label: { zh: '执行器用的代码托管 CLI', en: 'Workers\' code-host CLI' },
      hint: { zh: '可选。内部 CLI 的命令名或绝对路径，执行器以同名命令调用它，它应以智能体的账号行事。', en: 'Optional. A command name or absolute path of an internal CLI, which workers call by its name; it should act as the agent\'s account.' } },
    { key: 'workerDeny', type: 'rows', label: { zh: 'CLI 拒绝的合并命令', en: 'Merge commands the CLI refuses' },
      hint: { zh: '与 CLI 参数（以空格连接）匹配的模式，* 和 ? 是通配符，例如 mr merge。匹配的调用被拒绝，并让执行器改用 orchestrator_merge_request。这只是默认路径上的提醒，不是安全边界。', en: 'Patterns matched against the CLI\'s arguments joined by spaces, with * and ? as wildcards, such as mr merge. A matching call is refused and points the worker to orchestrator_merge_request. A reminder on the default path, not a security boundary.' },
      columns: [{ key: 'pattern', type: 'text', label: { zh: '模式', en: 'Pattern' }, pattern: '[A-Za-z0-9 _./:=*?@+\\-]+', wide: true }] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，适配器也报告没有 @ 智能体的新 Issue，由策略的接收表决定是否成为候选。', en: 'The adapter also reports new Issues that do not mention the agent, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observePrs', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，适配器也报告没有 @ 智能体的新 PR。', en: 'The adapter also reports new pull requests that do not mention the agent.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，适配器也报告仓库里没有 @ 智能体的评论。', en: 'The adapter also reports comments in the repository that do not mention the agent.' } },
  ],
  scope: ({ meta }, config) => {
    const row = rowOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: [CODEHOST],
  multiple: true,
  // Every instance acts as the one agent account through the one adapter, and its workers share one CLI.
  shared: ['adapter', 'mergeAdapter', 'workerCli', 'workerDeny'],
  channel: { send: sendCodehost, link: codehostLink },
  resources: {
    names: [{ name: 'codehost/…', holds: 'a code-host original, as the dsh-superagent-codehost skill describes; another code-host Source\'s under its id' }],
    open: ({ resource, prefix, commands }) => () => readCodehost(commands, resource, prefix),
  },
  threadContext: codehostThreadContext,
  read: readCodehostPath,
  skill: { name: 'codehost', active: deployment => !!deployment?.codehost },
  // `!12` names pull request 12 of every instance; `#12` or `12` names Issue 12.
  find: (query, { id }) => {
    const match = /^([!#]?)([1-9]\d*)$/.exec(query.trim())
    return { threads: match ? [`${id}:${threadId(match[1] === '!' ? 'pr' : 'issue', Number(match[2]))}`] : [], terms: [] }
  },
  claim: {
    account: ctx => account(ctx.deployment),
    pull: ticket => prOf(ticket),
    async report(ctx, ticket, report, signal) {
      const pr = report.pull !== undefined ? await readPr(ctx.commands.withSignal(signal), report.pull) : undefined
      const changes = await readyChanges(ctx, ticket, report.state, pr, signal)
      return { changes, bind: () => pr ? claimPr(ctx, ticket.id, pr) : undefined }
    },
    merge: (ctx, ticket, pull, merge, signal) => requestMerge(ctx, ticket, pull, merge, signal),
  },
  ticketEnded(ctx, ticket) {
    if (!ctx.configured()) return
    const request = ctx.triggers.get(ticket.origin.triggerId)?.text ?? ''
    const url = (thread: string) => { const value = ctx.threads.get(thread)?.meta.url; return typeof value === 'string' ? value : undefined }
    for (const message of prEndNotices(ticket, request, url)) ctx.notify(message)
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._@-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._@\[\]-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的代码托管账号', en: 'Code-host accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9._@\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list becomes an inferred candidate for an assessment when the Source receives it. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9._@\\[\\]\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、PR 或评论里 @ 智能体的账号，或把 Issue 指派给它、请它评审 PR。', en: 'An account on the list mentions the agent\'s account in an Issue, a PR or a comment, assigns it an Issue, or requests its review of a PR.' },
    rows(stored) {
      const config = CodehostConfigSchema.partial().parse(stored)
      const row = (id: Row, label: Localized) => ({ id, label, note: config[OBSERVED[id]] ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('prs', { zh: '新 PR', en: 'New pull requests' }), row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_CODEHOST_REPOSITORY', description: { zh: '这个代码托管来源监听的仓库。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The repository this code-host Source watches. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_CODEHOST_CLONE_URL', description: { zh: '仓库的 https 克隆地址；git 从适配器取得智能体的凭据', en: 'The repository\'s https clone URL; git gets the agent\'s credential from the adapter' } },
      { key: 'DSH_SUPERAGENT_CODEHOST_ACCOUNT', description: { zh: '智能体在代码托管上的账号；执行器用 orchestrator_merge_request 请求合并，不自己合并', en: 'The agent\'s account on the code host; a worker requests a merge with orchestrator_merge_request and never merges itself' } },
      { key: 'DSH_SUPERAGENT_CODEHOST_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱；提示词没有写明作者时用智能体账号和这个邮箱提交', en: 'Commit email of the agent\'s account; commit as the agent\'s account with this email when these instructions name no author' } },
      { key: 'DSH_SUPERAGENT_CODEHOST_CLI', description: { zh: '执行器可以调用的代码托管 CLI 的命令名；没有时为空', en: 'The command name of the code-host CLI workers may call; empty when there is none' } },
      { key: 'DSH_SUPERAGENT_CODEHOST_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从代码托管来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on the code host' } },
      { key: 'DSH_SUPERAGENT_CODEHOST_TYPE', description: { zh: '接下工单的是 issue 还是 pr；工单不是从代码托管来的时为空', en: 'Whether an issue or a pr started the ticket; empty when the ticket did not start on the code host' } },
    ],
    values: ({ deployment, instance, trigger }) => {
      const codehost = deployment.codehost
      const repository = codehost?.repositories[instance]
      const thread = trigger?.threads[0]?.source === instance ? threadOf(trigger.threads[0].id) : undefined
      return { DSH_SUPERAGENT_CODEHOST_REPOSITORY: repository?.path ?? '', DSH_SUPERAGENT_CODEHOST_CLONE_URL: repository?.cloneUrl ?? '',
        DSH_SUPERAGENT_CODEHOST_ACCOUNT: codehost?.account.login ?? '', DSH_SUPERAGENT_CODEHOST_COMMIT_EMAIL: codehost?.account.email ?? '',
        DSH_SUPERAGENT_CODEHOST_CLI: codehost?.worker?.name ?? '', DSH_SUPERAGENT_CODEHOST_NUMBER: thread ? String(thread.number) : '',
        DSH_SUPERAGENT_CODEHOST_TYPE: thread?.type ?? '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.codehost ? {
    adapter: { zh: `当前账号 @${account(deployment)}`, en: `Current account @${account(deployment)}` },
    ...deployment.codehost.merge ? { mergeAdapter: { zh: `合并账号 @${deployment.codehost.merge.login}`, en: `Merge account @${deployment.codehost.merge.login}` } } : {},
  } : {},
}
export const name = 'dsh-superagent-codehost'
export const inject = ['orchestrator']
/** Registers the kind and polls each of its instances on its own; adding, removing or switching one restarts dsh-superagent. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(codehostKind), 'codehost: source kind')
  ctx.effect(() => {
    const ids = ctx.orchestrator.sources.instances().filter(instance => instance.kind === CODEHOST).map(instance => instance.id)
    const controller = new AbortController()
    const running = ids.map(id => {
      const source = sourceContext(ctx.orchestrator, codehostKind, id)
      // Unhandled rejections end the DSH process, so a failure that escapes the loop becomes the Source's health instead.
      return watch(source, controller.signal).catch((error: unknown) => { source.report(CODEHOST, { state: 'error', detail: String(error) }) })
    })
    return async () => { controller.abort(); await Promise.all(running) }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report(CODEHOST, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<CodehostConfig>()
    try {
      if (!config) ctx.report(CODEHOST, health('paused', 'sourceOff'))
      else if (!ctx.deployment.codehost?.repositories[ctx.source]) ctx.report(CODEHOST, health('paused', 'codehostUnresolved'))
      else await pollRound(ctx, signal)
      failures = 0
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= (config?.failuresBeforeError ?? 1)) {
        ctx.report(CODEHOST, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((ctx.config<CodehostConfig>()?.pollSeconds ?? 60) * 1000, signal)
  }
}
/** The Issues and pull requests whose comments and changes the adapter reports beyond what addresses the agent. */
function followed(ctx: SourceContext): { type: ThreadType; number: number }[] {
  const threads = new Map<string, { type: ThreadType; number: number }>()
  for (const thread of ctx.threads.subscribed(ctx.source)) {
    const ref = threadOf(thread.ref.id)
    if (ref && polled(ctx, thread)) threads.set(thread.ref.id, ref)
  }
  for (const number of ctx.tickets.open().flatMap(ticket => prsOf(ticket, true, ctx.source))) threads.set(threadId('pr', number), { type: 'pr', number })
  return [...threads.values()]
}
/** Most pages of events one round reads; the rest wait for the next round. */
const EVENT_PAGES = 10
/**
 * One poll round: the adapter's events after the cursor, page by page, each page's Triggers stored before the cursor moves past
 * them; then every pull request an open ticket follows, or an event named, is read for its state and CI. A pull request that
 * fails fails the round after the others were read.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const started = new Date().toISOString()
  const config = ctx.config<CodehostConfig>()
  if (!config) return
  const commands = ctx.commands.withSignal(signal)
  const login = account(ctx.deployment)
  const stopped = () => !!signal?.aborted || !ctx.config()
  const tally: Tally = { skipped: 0 }
  const touched = new Set<number>()
  let events = 0
  const follow = followed(ctx)
  for (let page = 0; page < EVENT_PAGES; page++) {
    const cursor = ctx.state.get(KV.codehost.cursor) ?? null
    const answer = await codehostCall(commands, 'events', { cursor, follow,
      observe: { issues: config.observeIssues, prs: config.observePrs, comments: config.observeComments } }, EventsSchema)
    for (const event of validItems(EventSchema, answer.events, tally)) {
      // Stopping mid-page keeps the cursor, so the page is read again; Trigger IDs make that safe.
      if (stopped()) throw new Error('The code-host Source stopped during the poll')
      events++
      const { type, number, title } = event.thread
      if (type === 'pr') touched.add(number)
      const trigger = eventTrigger(event, login, ctx.source)
      if (!trigger) continue
      await ctx.receive(trigger)
      const key = `${ctx.source}:${threadId(type, number)}`
      ctx.threads.patch(key, { type, number, isPr: type === 'pr', ...event.url ? { url: event.url } : {}, ...title ? { title } : {} })
      ctx.threads.describe(key, { ...title ? { label: `${threadName(type, number)} ${title}` } : {}, facts: { number: { value: threadName(type, number) } } })
    }
    ctx.state.set(KV.codehost.cursor, answer.cursor)
    if (!answer.more) break
  }
  const failures: string[] = []
  const prs = new Set([...ctx.tickets.open().flatMap(ticket => prsOf(ticket, true, ctx.source)), ...touched])
  for (const number of answers(commands, 'thread') ? prs : []) {
    if (stopped()) return
    try {
      const pr = await readPr(commands, number)
      const ended = observePr(ctx, pr)
      if (!ended && answers(commands, 'checks') && ctx.tickets.open().some(ticket => prsOf(ticket, true, ctx.source).includes(number))) {
        await pollChecks(ctx, commands, pr)
      }
      ctx.threads.patch(`${ctx.source}:${threadId('pr', number)}`, { pollError: undefined })
    } catch (error) {
      if (stopped()) return
      failures.push(`!${number}: ${String(error)}`)
      ctx.threads.patch(`${ctx.source}:${threadId('pr', number)}`, { pollError: String(error) })
    }
  }
  if (failures.length) throw new Error(`${failures.length} code-host reads failed: ${failures.slice(0, 3).join('; ')}`)
  const skipped = tally.skipped ? `; ${tally.skipped} unreadable events skipped` : ''
  ctx.report(CODEHOST, { state: 'ready', detail: `${events} events; ${prs.size} pull requests read${skipped}`, at: started })
}
export { codehostChannel }
