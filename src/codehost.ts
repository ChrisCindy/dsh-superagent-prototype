/**
 * The code-host adapter contract, version 1: the operations an operator's adapter command answers, their zod schemas (the source of
 * truth that docs/010 describes and `contractSchemas` exports as JSON Schema), `adapterCall`, and setup of the code-host Sources:
 * `resolveCodehost` checks each instance's adapter, account and repository, the merge adapter and the worker CLI, and returns
 * the warnings that leave dsh-superagent running
 */
import { z } from 'zod'
import { executable, type Machine, type Probe } from './deployment.ts'
import { workerBin } from './infra/environment.ts'
import { sameName } from './infra/text.ts'
import { SetupError, setupWarning, type SetupCode, type SetupWarning } from './setup.ts'

/** The code-host kind's ID, which is also its first instance's. */
export const CODEHOST = 'codehost'
export const CONTRACT_VERSION = 1
/** Operations an adapter must answer. */
export const REQUIRED = ['whoami', 'repository', 'events'] as const
/** Operations an adapter may answer; each one it leaves out turns off what needs it, and setup warns. */
export const OPTIONAL = ['thread', 'comments', 'comment', 'files', 'checks', 'approvals', 'contents', 'protection', 'merge', 'git-credential'] as const
export type Capability = typeof REQUIRED[number] | typeof OPTIONAL[number]
/** What each optional operation's absence turns off, for the setup warning. */
export const WITHOUT: Record<typeof OPTIONAL[number], string> = {
  thread: 'pull requests are not bound to tickets or checked for a merge',
  comments: 'assessments read no thread context, and replies cannot check that they were posted before',
  comment: 'no reply, acknowledgement or result reaches the code host',
  files: 'a ready report or merge under a Mandate with paths cannot be checked and waits for a person',
  checks: 'CI is not followed, and no merge passes the CI check',
  approvals: 'no merge passes the approval check',
  contents: 'assessments cannot read repository files',
  protection: 'setup cannot check that the code host requires an approval before a merge',
  merge: 'the merge adapter cannot enable auto-merge',
  'git-credential': 'workers\' git gets no credential for the code host',
}

const Text = z.string().min(1)
const Time = z.string().refine(value => Number.isFinite(Date.parse(value)), 'an ISO 8601 time')
const Count = z.number().int().positive()
export const ThreadType = z.enum(['issue', 'pr'])
export const UserSchema = z.looseObject({ login: Text, id: z.string().optional(), bot: z.boolean().default(false) })

/** `describe {}`: the contract version the adapter speaks and the operations it answers. */
export const DescribeSchema = z.looseObject({ contractVersion: z.number().int(), capabilities: z.array(z.string()), name: z.string().optional() })
/** `whoami {}`: the account the adapter acts as; `email` is the address its commits use. */
export const AccountSchema = z.looseObject({ id: z.string().min(1), login: Text, name: z.string().optional(), email: z.string().optional() })
/** `repository {repository}`: the repository as the code host names it; `cloneUrl` an https URL workers' git clones and pushes. */
export const RepositorySchema = z.looseObject({ id: z.string().min(1), path: Text, defaultBranch: Text, canPush: z.boolean(), webUrl: z.string(),
  cloneUrl: z.string().optional() })
/**
 * One event of `events`. `id` is stable and unique for the event's content, so a changed comment needs a new one; `addressed` is
 * true when the event mentions the agent, assigns it or requests its review, which `mention`, `assigned` and `review_requested`
 * imply. `pipeline` and `pr_state` carry no message: they tell the host to reread the pull request.
 */
export const EventSchema = z.looseObject({
  id: Text,
  kind: z.enum(['opened', 'comment', 'mention', 'review', 'assigned', 'review_requested', 'pipeline', 'pr_state']),
  thread: z.looseObject({ type: ThreadType, number: Count, title: z.string().optional() }),
  actor: UserSchema, text: z.string().default(''), url: z.string().optional(), at: Time, addressed: z.boolean().default(false),
  review: z.enum(['approved', 'changes_requested', 'commented']).optional(), commentId: z.string().optional(),
  path: z.string().optional(), line: z.number().int().optional(), replyTo: z.string().optional(),
})
export type CodehostEvent = z.infer<typeof EventSchema>
/** `events {repository, cursor, follow, observe}`: the events after `cursor`, oldest first, the cursor after them, and `more` while a next page waits. */
export const EventsSchema = z.looseObject({ events: z.array(z.unknown()), cursor: Text, more: z.boolean().default(false) })
/** `thread {repository, type, number}`: an Issue or a pull request; `head.repository` is set only for a pull request from a fork. */
export const ThreadSchema = z.looseObject({
  type: ThreadType, number: Count, title: z.string(), state: z.enum(['open', 'closed', 'merged']), url: z.string(), author: UserSchema,
  body: z.string().nullish(), createdAt: Time, draft: z.boolean().default(false),
  head: z.looseObject({ branch: Text, sha: Text, repository: z.string().nullish() }).optional(),
  additions: z.number().int().nonnegative().optional(), deletions: z.number().int().nonnegative().optional(),
  autoMerge: z.boolean().default(false), closedAt: z.string().nullish(), mergedAt: z.string().nullish(),
})
export type CodehostThread = z.infer<typeof ThreadSchema>
export const CommentSchema = z.looseObject({ id: Text, author: UserSchema, body: z.string(), url: z.string().optional(), createdAt: Time,
  updatedAt: z.string().optional(), path: z.string().optional(), line: z.number().int().optional(), replyTo: z.string().optional(),
  review: z.enum(['approved', 'changes_requested', 'commented']).optional() })
export type CodehostComment = z.infer<typeof CommentSchema>
/** `comments {repository, type, number, cursor}`: a page of comments and reviews, oldest first, and the cursor of the next page. */
export const CommentsSchema = z.looseObject({ comments: z.array(z.unknown()), cursor: z.string().nullish() })
/** `comment {repository, type, number, body, key, replyTo}`: posts once per `key`. */
export const PostedSchema = z.looseObject({ id: z.string(), url: z.string().optional() })
/** `files {repository, number}`: every file a pull request changes, a renamed one with its old path; `complete` false when the host could not list all. */
export const FilesSchema = z.looseObject({ files: z.array(z.looseObject({ path: Text, previousPath: z.string().optional() })),
  complete: z.boolean().default(true) })
export const CheckState = z.enum(['success', 'failure', 'running', 'skipped', 'cancelled'])
/** `checks {repository, number}`: the CI of a pull request's head commit `sha`. */
export const ChecksSchema = z.looseObject({ sha: Text, checks: z.array(z.looseObject({ name: Text, state: CheckState, url: z.string().optional() })) })
export type CodehostChecks = z.infer<typeof ChecksSchema>
/**
 * `approvals {repository, number}`: the approvals in force and who requests changes. An approval names the commit it approved as
 * `sha`; one without `sha` counts only when `dismissesStale` says the host withdraws approvals on a push.
 */
export const ApprovalsSchema = z.looseObject({ sha: Text, approvals: z.array(z.looseObject({ login: Text, bot: z.boolean().default(false),
  sha: z.string().nullish() })), changesRequested: z.array(z.string()).default([]), dismissesStale: z.boolean().default(false) })
/** `contents {repository, path, kind}`: a file of the default branch as text, or a directory's entries. */
export const ContentsSchema = z.union([z.looseObject({ content: z.string() }),
  z.looseObject({ entries: z.array(z.looseObject({ name: Text, type: z.enum(['file', 'directory']) })) })])
/**
 * `protection {repository, branch}`: whether the code host itself requires an approval before a merge to `branch`, withdraws it on a
 * push, and lets the agent's account push or merge around that; null where the adapter cannot tell.
 */
export const ProtectionSchema = z.looseObject({ requiresApproval: z.boolean().nullable(), dismissesStale: z.boolean().nullable(),
  agentCanBypass: z.boolean().nullable() })
/** `merge {repository, number, sha, method}`, run by the merge adapter: merges `sha` once its checks pass, or at once. */
export const MergedSchema = z.looseObject({ state: z.enum(['enabled', 'merged']) })
/** An adapter's error, on standard error with a non-zero exit: `code` 404 not found, 410 gone for good, 501 not implemented. */
export const ErrorSchema = z.object({ error: z.object({ code: z.number().int(), message: z.string() }) })

/** Request shapes, which docs/010 lists beside the answers. */
const Repo = { repository: Text }
const Ref = { ...Repo, type: ThreadType, number: Count }
export const REQUESTS = {
  describe: z.object({}), whoami: z.object({}), repository: z.object(Repo),
  events: z.object({ ...Repo, cursor: z.string().nullable(), follow: z.array(z.object({ type: ThreadType, number: Count })),
    observe: z.object({ issues: z.boolean(), prs: z.boolean(), comments: z.boolean() }) }),
  thread: z.object(Ref), comments: z.object({ ...Ref, cursor: z.string().nullable() }),
  comment: z.object({ ...Ref, body: Text, key: Text, replyTo: z.string().nullable() }),
  files: z.object({ ...Repo, number: Count }), checks: z.object({ ...Repo, number: Count }), approvals: z.object({ ...Repo, number: Count }),
  contents: z.object({ ...Repo, path: z.string(), kind: z.enum(['file', 'directory']) }),
  protection: z.object({ ...Repo, branch: Text }),
  merge: z.object({ ...Repo, number: Count, sha: Text, method: z.enum(['squash', 'merge', 'rebase']) }),
} as const
export const ANSWERS = { describe: DescribeSchema, whoami: AccountSchema, repository: RepositorySchema, events: EventsSchema, thread: ThreadSchema,
  comments: CommentsSchema, comment: PostedSchema, files: FilesSchema, checks: ChecksSchema, approvals: ApprovalsSchema, contents: ContentsSchema,
  protection: ProtectionSchema, merge: MergedSchema } as const
export type Operation = keyof typeof ANSWERS
/** The contract as JSON Schema, by operation: its request, its answer, and the shape of one event and one comment. */
export function contractSchemas(): Record<string, unknown> {
  const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  return { contractVersion: CONTRACT_VERSION, error: json(ErrorSchema), event: json(EventSchema), comment: json(CommentSchema),
    operations: Object.fromEntries(Object.keys(ANSWERS).map(name => [name,
      { request: json(REQUESTS[name as Operation]), answer: json(ANSWERS[name as Operation]) }])) }
}

/** Runs `<adapter> <operation> <request JSON>` and validates its answer. */
export async function adapterCall<T>(run: (argv: string[]) => Promise<string>, adapter: string, operation: Operation,
  request: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const output = await run([adapter, operation, JSON.stringify(request)])
  let value: unknown
  try { value = JSON.parse(output) } catch { throw new Error(`The code-host adapter answered ${operation} with no JSON`) }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`The code-host adapter answered ${operation} unexpectedly: ${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  return parsed.data
}

/** What setup reads of a code-host Source: the adapters, its repository, and the workers' CLI with the merge commands it refuses. */
export const CodehostSetupSchema = z.object({
  adapter: z.string().trim().default(''),
  repository: z.string().trim().max(200).default(''),
  mergeAdapter: z.string().trim().default(''),
  workerCli: z.string().trim().default(''),
  workerDeny: z.array(z.object({ pattern: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9 _./:=*?@+-]+$/,
    'letters, digits, spaces, _ . / : = @ + - and the wildcards * and ?') }).strict()).max(50).default([]),
})
/** A worker CLI's command name: a plain name that is not one of the commands the shims already own. */
const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export interface CodehostRepository { path: string; defaultBranch: string; webUrl: string; cloneUrl?: string }
/** The code-host Sources setup resolved: one adapter and account shared by every instance, and each instance's repository. */
export interface CodehostDeployment {
  adapter: string
  capabilities: string[]
  account: { id: string; login: string; name: string; email: string }
  repositories: Record<string, CodehostRepository>
  merge?: { adapter: string; login: string }
  worker?: { name: string; path: string; deny: string[] }
}
type StoredSources = Readonly<Record<string, { kind: string; enabled: boolean; config: Record<string, unknown> }>>
/** The code-host instances setup resolves: those stored and on, the first instance before the others in ID order. */
export function codehostInstances(sources: StoredSources): { id: string; config: unknown }[] {
  return Object.entries(sources).filter(([, stored]) => stored.kind === CODEHOST && stored.enabled)
    .sort(([a], [b]) => a === CODEHOST ? -1 : b === CODEHOST ? 1 : a.localeCompare(b)).map(([id, stored]) => ({ id, config: stored.config }))
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** The adapters' calls during setup, as Executor shells run them. */
const call = <T>(probe: Probe, adapter: string, operation: Operation, request: Record<string, unknown>, schema: z.ZodType<T>) =>
  adapterCall(argv => probe(argv), adapter, operation, request, schema)
/** Resolves an adapter and checks it speaks this contract with the required operations. */
async function describe(probe: Probe, name: string, path: string, machine: Machine, fail: (code: SetupCode, values?: Record<string, string>) => SetupError,
  needs: readonly string[]): Promise<{ adapter: string; capabilities: string[] }> {
  let adapter: string
  try { adapter = executable(name, path, workerBin(machine.stateDir)) } catch (error) { throw fail('codehostAdapterMissing', { adapter: name, output: reason(error) }) }
  const described = await call(probe, adapter, 'describe', {}, DescribeSchema)
    .catch((error: unknown) => { throw fail('codehostAdapterFailed', { adapter: name, output: reason(error) }) })
  const missing = needs.filter(item => !described.capabilities.includes(item))
  if (described.contractVersion !== CONTRACT_VERSION || missing.length) {
    throw fail('codehostContract', { adapter: name, version: String(described.contractVersion), expected: String(CONTRACT_VERSION),
      missing: missing.join(', ') || 'none' })
  }
  return { adapter, capabilities: described.capabilities }
}
/**
 * Verifies each code-host instance in order: its adapter speaks contract version 1 with the required operations, `whoami` names one
 * account that every instance shares, and that account may push to the instance's repository, which no other instance receives.
 * The first instance's merge adapter must act as another account and answer `merge`; its worker CLI must be a command. Returns
 * the warnings: optional operations the adapter lacks, review rules the code host does not enforce, and a worker CLI that refuses
 * no merge command.
 * @throws SetupError of place `codehost`, naming the instance as its `source`.
 */
export async function resolveCodehost(machine: Machine, instances: readonly { id: string; config: unknown }[], probe: Probe,
  path = process.env.PATH ?? ''): Promise<{ codehost: CodehostDeployment; warnings: SetupWarning[] }> {
  const [first] = instances
  if (!first) throw new SetupError('codehostAdapterUnset').in(CODEHOST)
  const failIn = (id: string) => (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).in(id)
  const settings = CodehostSetupSchema.parse(first.config ?? {})
  const fail = failIn(first.id)
  if (!settings.adapter) throw fail('codehostAdapterUnset')
  const { adapter, capabilities } = await describe(probe, settings.adapter, path, machine, fail, REQUIRED)
  const whoami = await call(probe, adapter, 'whoami', {}, AccountSchema)
    .catch((error: unknown) => { throw fail('codehostNoAccount', { adapter: settings.adapter, output: reason(error) }) })
  const account = { id: whoami.id, login: whoami.login, name: whoami.name ?? whoami.login, email: whoami.email ?? '' }
  const repositories: Record<string, CodehostRepository> = {}
  for (const instance of instances) {
    const own = CodehostSetupSchema.parse(instance.config ?? {})
    const failHere = failIn(instance.id)
    if (!own.repository) throw failHere('codehostRepositoryUnset')
    // Every instance acts as the one agent account through the first instance's adapter, as the shared fields copy it.
    if (own.adapter !== settings.adapter) throw failHere('codehostAdapterMismatch', { adapter: own.adapter, first: settings.adapter })
    const found = await call(probe, adapter, 'repository', { repository: own.repository }, RepositorySchema).catch((error: unknown) => {
      throw failHere('codehostRepositoryUnreadable', { account: account.login, repository: own.repository, output: reason(error) })
    })
    if (!found.canPush) throw failHere('codehostRepositoryReadOnly', { account: account.login, repository: found.path })
    if (Object.values(repositories).some(other => sameName(other.path, found.path))) throw failHere('codehostRepositoryTwice', { repository: found.path })
    repositories[instance.id] = { path: found.path, defaultBranch: found.defaultBranch, webUrl: found.webUrl,
      ...found.cloneUrl?.startsWith('https://') ? { cloneUrl: found.cloneUrl } : {} }
  }
  let merge: CodehostDeployment['merge']
  if (settings.mergeAdapter) {
    const merger = await describe(probe, settings.mergeAdapter, path, machine, fail, ['whoami', 'merge'])
    const login = (await call(probe, merger.adapter, 'whoami', {}, AccountSchema).catch((error: unknown) => {
      throw fail('codehostAdapterFailed', { adapter: settings.mergeAdapter, output: reason(error) })
    })).login
    // The code host credits a merge to the account that enabled it, which must not be the agent's.
    if (sameName(login, account.login)) throw fail('codehostMergeAgent', { adapter: settings.mergeAdapter, account: account.login })
    merge = { adapter: merger.adapter, login }
  }
  let worker: CodehostDeployment['worker']
  if (settings.workerCli) {
    const name = settings.workerCli.split('/').at(-1)!
    if (!WORKER_NAME.test(name) || ['gh', 'git', 'lark-cli'].includes(name)) throw fail('codehostWorkerCli', { cli: settings.workerCli, output: 'its name is taken or not a plain command name' })
    let cli: string
    try { cli = executable(settings.workerCli, path, workerBin(machine.stateDir)) } catch (error) { throw fail('codehostWorkerCli', { cli: settings.workerCli, output: reason(error) }) }
    worker = { name, path: cli, deny: settings.workerDeny.map(item => item.pattern) }
  }
  const warnings: SetupWarning[] = []
  const missing = OPTIONAL.filter(item => !capabilities.includes(item))
  if (missing.length) {
    warnings.push(setupWarning('codehostCapabilities', { adapter: settings.adapter, missing: missing.join(', '),
      effects: missing.map(item => `without ${item}, ${WITHOUT[item]}`).join('; ') }, first.id))
  }
  if (worker && !worker.deny.length) warnings.push(setupWarning('codehostShimUnguarded', { cli: worker.name }, first.id))
  for (const [id, repository] of Object.entries(repositories)) {
    const values = { account: account.login, branch: repository.defaultBranch, repository: repository.path }
    if (!capabilities.includes('protection')) { warnings.push(setupWarning('codehostMergeUnverified', values, id)); continue }
    const rules = await call(probe, adapter, 'protection', { repository: repository.path, branch: repository.defaultBranch }, ProtectionSchema)
      .catch(() => undefined)
    if (!rules || rules.requiresApproval === null || rules.dismissesStale === null || rules.agentCanBypass === null) {
      warnings.push(setupWarning('codehostMergeUnverified', values, id))
    } else if (rules.agentCanBypass) warnings.push(setupWarning('codehostMergeBypass', values, id))
    else if (!rules.requiresApproval || !rules.dismissesStale) warnings.push(setupWarning('codehostMergeUnprotected', values, id))
  }
  return { codehost: { adapter, capabilities, account, repositories, ...merge ? { merge } : {}, ...worker ? { worker } : {} }, warnings }
}
