/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { checkMerging, executable, githubInstances, resolveDeployment, resolveFeishuBot, resolveGithub, sameAccount, workerProbe,
  type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import { sameName } from '../infra/text.ts'
import type { MergeConfig, Settings, SettingsBlock } from '../policy.ts'
import { SetupError, problemSource, setupWarning, type SetupProblem, type SetupWarning } from '../setup.ts'
import type { SourceKind } from '../sources/kind.ts'
import { checkPresets, checkTemporaryAreas, checkWritableRoots, protectedDirectories } from './permissions.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

type SetupKinds = readonly Pick<SourceKind, 'kind' | 'setup'>[]
/**
 * What setup reads from the Source settings: the setup fields (`SourceKind.setup`) of each kind's first instance, and of each
 * other instance while it is on. Switching another instance on or off, or removing one that is on, changes what setup resolves;
 * adding or removing one that is off does not.
 */
const setupFields = ({ sources }: Settings, kinds: SetupKinds) => JSON.stringify(kinds.flatMap(({ kind, setup: keys = [] }) => {
  if (!keys.length) return []
  const others = Object.keys(sources).filter(id => id !== kind && sources[id]!.kind === kind && sources[id]!.enabled).sort()
  return [kind, ...others].map(id => [id, ...keys.map(key => sources[id]?.config[key] ?? '')])
}))
/** Whether a save changes a field setup reads, of the installed `kinds` (`SourceRegistry.installed`). */
export const setupChanged = (before: Settings, after: Settings, kinds: SetupKinds): boolean =>
  setupFields(before, kinds) !== setupFields(after, kinds)

/**
 * Resolves each GitHub Source instance's repository, the GitHub account they share, and the optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** Findings that leave dsh-superagent running, such as a default branch whose merges GitHub does not gate on a review. */
  warnings: SetupWarning[] = []
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy and nothing warns, so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.warnings.length) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /**
   * Verify the account CLIs of a modified Source block before saving, ignoring setup errors belonging to other blocks. A GitHub
   * instance must also share the account of every other GitHub instance that resolves, and receive a repository none of them does;
   * an instance other than the kind's first that is off is not checked.
   */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const id = block.startsWith('source:') ? block.slice('source:'.length) : block
    const kind = settings.sources[id]?.kind ?? id
    const own = (error: unknown) => { if (!(error instanceof SetupError) || (error.place === kind && problemSource(error.problem) === id)) throw error }
    if (kind === 'feishu') { await resolveFeishuBot(machine, settings.sources[id]?.config, this.probe()).catch(own); return }
    if (kind !== 'github') return
    const instances = githubInstances(settings.sources)
    const instance = instances.find(item => item.id === id)
    if (!instance) return
    const resolved = await resolveGithub(machine, instance, this.probe()).catch((error: unknown) => { own(error); return undefined })
    if (!resolved) return
    for (const other of instances.filter(item => item.id !== id)) {
      const found = await resolveGithub(machine, other, this.probe()).catch(() => undefined)
      if (found) sameAccount(id, resolved, found)
    }
  }
  /**
   * Check how `settings` confine managed Sessions: the profile holds the permission presets they run under, and no extra
   * writable root, configured or granted by DSH's sandbox policy, opens the state directory, DSH's home or the profile, and
   * none of those lies in a temporary area the sandbox lets workers write.
   * @throws SetupError when a preset is missing or a writable root is refused.
   */
  checkConfinement(settings: Settings): void {
    const { context, machine } = this.host
    const { sandbox, writableRoots } = settings.executor
    checkPresets(context.permissionPresets, sandbox)
    // DSH's sandbox policy grants extra roots only where its version has them, deployment-wide, from the profile's configuration.
    const policy = context.get('sandboxPolicy') as { additionalWritableRoots?: readonly string[] } | undefined
    const guarded = protectedDirectories(machine.stateDir, (context as { baseUrl?: unknown }).baseUrl)
    checkTemporaryAreas(guarded, sandbox, machine.temporaryAreas)
    checkWritableRoots(writableRoots, sandbox, guarded, policy?.additionalWritableRoots)
  }
  /**
   * Checks a merge CLI before it is saved: it runs, as setup probes CLIs, and reads an account other than the agent's, since
   * GitHub attributes a merge to the account that enabled auto-merge. An empty CLI, or one saved while setup waits, is not checked.
   * @throws UserError `mergeCliFailed` or `mergeCliAgent`.
   */
  async checkMergeCli(merge: MergeConfig): Promise<void> {
    if (!merge.cli || !this.resolved) return
    let login: string
    try {
      const cli = executable(merge.cli, this.path, workerBin(this.host.machine.stateDir))
      login = (await this.probe()([cli, 'api', 'user', '--jq', '.login'])).trim()
    } catch (error) { throw new UserError('mergeCliFailed', { cli: merge.cli, error: error instanceof Error ? error.message : String(error) }) }
    if (!login) throw new UserError('mergeCliFailed', { cli: merge.cli, error: 'it printed no login' })
    if (sameName(login, this.resolved.github.login)) throw new UserError('mergeCliAgent', { cli: merge.cli, account: this.resolved.github.login })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    this.checkConfinement(settings)
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, githubInstances(settings.sources), probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    // Each repository has its own default branch and rules, so each GitHub instance is checked on its own.
    const warnings: SetupWarning[] = []
    for (const [id, repository] of Object.entries(resolved.repositories)) {
      for (const warning of await checkMerging({ repository, github: resolved.github }, probe)) warnings.push(setupWarning(warning.code, warning.values, id))
    }
    this.warnings = warnings
    for (const warning of this.warnings) context.logger.warn('dsh-superagent setup warning: %s', warning.detail)
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
