/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { sameName } from './infra/text.ts'
import { SetupError, setupWarning, type SetupCode, type SetupWarning } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  /** The temporary areas DSH's `workspace-write` sandbox lets every confined command write: `/tmp` and the user's temporary directory. */
  temporaryAreas: readonly string[]
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, temporaryAreas: [...new Set(['/tmp', tmpdir()])] }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys, by kind, that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }
type StoredSources = Readonly<Record<string, { kind: string; enabled: boolean; config: Record<string, unknown> }>>
/**
 * The GitHub Source instances setup resolves: the first instance (`github`) always, as the one every installation needs, and
 * each other GitHub instance while it is on, in ID order.
 */
export function githubInstances(sources: StoredSources): { id: string; config: unknown }[] {
  const others = Object.entries(sources).filter(([id, stored]) => stored.kind === 'github' && id !== 'github' && stored.enabled)
    .sort(([a], [b]) => a.localeCompare(b))
  return [{ id: 'github', config: sources.github?.config }, ...others.map(([id, stored]) => ({ id, config: stored.config }))]
}

/** The agent's GitHub account, which every GitHub Source instance shares, and the CLI signed in to it. */
export interface GithubAccount { cli: string; login: string; noreply: string }
export interface Deployment extends Machine {
  /** The canonical owner/name of each resolved GitHub Source instance, by instance ID; the first instance's ID is `github`. */
  repositories: Record<string, string>
  github: GithubAccount
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/**
 * Verifies one GitHub Source instance: its CLI's account, and that account's push access to its repository, whose canonical
 * name it returns.
 * @throws SetupError naming the instance as its `source`.
 */
export async function resolveGithub(machine: Machine, instance: { id: string; config: unknown }, probe: Probe, path = process.env.PATH ?? ''): Promise<{ repository: string; account: GithubAccount }> {
  const fail = (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).in(instance.id)
  const accounts = GithubAccountsSchema.parse(instance.config ?? {})
  const remote = accounts.repository
  if (!remote) throw fail('repositoryUnset')
  if (!accounts.cli) throw fail('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(machine.stateDir)) } catch (error) { throw fail('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw fail('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw fail('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw fail('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw fail('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw fail('repositoryReadOnly', { account: agent.login, repository })
  return { repository, account: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}
/**
 * Refuses an instance whose account is not `account`, since all GitHub instances share the agent's account, or whose repository
 * another instance already receives.
 */
export function sameAccount(id: string, resolved: { repository: string; account: GithubAccount }, other: { repository: string; account: GithubAccount }): void {
  if (!sameName(resolved.account.login, other.account.login)) {
    throw new SetupError('agentAccountMismatch', { account: resolved.account.login, agent: other.account.login }).in(id)
  }
  if (sameName(resolved.repository, other.repository)) throw new SetupError('repositoryTwice', { repository: resolved.repository }).in(id)
}
/**
 * Verifies each GitHub Source instance (`githubInstances`) in order: the agent's GitHub CLI identity, which every instance
 * shares, and push access to each instance's repository. The first instance's CLI is the one workers call as gh.
 */
export async function resolveDeployment(machine: Machine, instances: readonly { id: string; config: unknown }[], probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const resolved: { id: string; repository: string; account: GithubAccount }[] = []
  for (const instance of instances) {
    const found = await resolveGithub(machine, instance, probe, path)
    for (const other of resolved) sameAccount(instance.id, found, other)
    resolved.push({ id: instance.id, ...found })
  }
  const [first] = resolved
  if (!first) throw new SetupError('repositoryUnset').in('github')
  return { ...machine, repositories: Object.fromEntries(resolved.map(item => [item.id, item.repository])), github: first.account }
}

const DefaultBranch = z.object({ branch: z.string().min(1), admin: z.boolean().nullish() })
const BranchRules = z.array(z.looseObject({ type: z.string(), ruleset_id: z.number().optional(),
  parameters: z.looseObject({ required_approving_review_count: z.number().optional(), dismiss_stale_reviews_on_push: z.boolean().optional() }).optional() }))
const Ruleset = z.looseObject({ current_user_can_bypass: z.string().optional() })
const Protection = z.looseObject({
  required_pull_request_reviews: z.looseObject({ required_approving_review_count: z.number().optional(), dismiss_stale_reviews: z.boolean().optional(),
    bypass_pull_request_allowances: z.looseObject({ users: z.array(z.looseObject({ login: z.string() })).optional() }).optional() }).optional(),
  enforce_admins: z.looseObject({ enabled: z.boolean() }).nullish(),
})
/**
 * Checks, as the agent account, that GitHub itself keeps unreviewed commits off the default branch: a ruleset or branch protection
 * rule requires at least one approving review, dismisses stale approvals on a push, and the agent account cannot bypass it.
 * It never fails setup: it returns the warnings to show, and one that it cannot verify when the account may not read the rules,
 * as an account without admin rights may not read branch protection.
 */
export async function checkMerging(deployment: { repository: string; github: Pick<GithubAccount, 'cli' | 'login'> }, probe: Probe): Promise<SetupWarning[]> {
  const { repository, github: { cli, login } } = deployment
  const read = async <T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T> => {
    const value = parsed(schema, await probe([cli, 'api', path, ...flags]))
    if (value === undefined) throw new Error(`${path} returned an unexpected answer`)
    return value
  }
  let branch = 'the default branch'
  const unverified = () => [setupWarning('mergeUnverified', { account: login, branch, repository })]
  try {
    const repo = await read(DefaultBranch, `repos/${repository}`, '--jq', '{branch: .default_branch, admin: .permissions.admin}')
    branch = repo.branch
    const values = { account: login, branch, repository }
    // Rulesets that apply to the branch can be read with read access; only active ones are listed.
    const rules = await read(BranchRules, `repos/${repository}/rules/branches/${encodeURIComponent(branch)}`).catch(() => undefined)
    const reviewed = (rules ?? []).filter(rule => rule.type === 'pull_request' && (rule.parameters?.required_approving_review_count ?? 0) >= 1
      && rule.parameters?.dismiss_stale_reviews_on_push === true)
    const bypass = await Promise.all([...new Set(reviewed.flatMap(rule => rule.ruleset_id ?? []))].map(async id =>
      (await read(Ruleset, `repos/${repository}/rulesets/${id}`)).current_user_can_bypass ?? 'never'))
    if (bypass.includes('never')) return []
    const rulesetBypass = bypass.length > 0
    // Classic branch protection; reading it needs admin rights, and GitHub answers 404 Branch not protected for none.
    let protection: z.infer<typeof Protection> | undefined
    try { protection = await read(Protection, `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`) }
    catch (error) {
      if (rulesetBypass) return [setupWarning('mergeBypass', values)]
      if (rules && /Branch not protected/i.test(reason(error))) return [setupWarning('mergeUnprotected', values)]
      return unverified()
    }
    const reviews = protection.required_pull_request_reviews
    const required = (reviews?.required_approving_review_count ?? 0) >= 1 && reviews?.dismiss_stale_reviews === true
    const allowed = (reviews?.bypass_pull_request_allowances?.users ?? []).some(user => sameName(user.login, login))
    const bypasses = allowed || (repo.admin === true && protection.enforce_admins?.enabled !== true)
    if (required && !bypasses) return []
    return [setupWarning(required || rulesetBypass ? 'mergeBypass' : 'mergeUnprotected', values)]
  } catch {
    return unverified()
  }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
