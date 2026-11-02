/**
 * Runs dsh-superagent in a real DeepSeek Harness installation, following docs/006-deployment.md: install DSH (cached),
 * create the profile from the Web template in a temporary DSH_HOME, link this checkout as a plugin, write the profile's
 * cordis.patch.yml with a temporary stateDir, and start and stop it with scripts/dsh-superagent in a tmux server of its
 * own. Everything the run creates lives in one run directory, removed by `teardown()` unless the run failed or
 * SAE2E_KEEP=1.
 *
 * Fakes stand in for everything outside the machine: `gh` and `lark-cli` stubs (tests/e2e/fakes) answer from local JSON
 * state, and a scripted Messages server (mock-llm.ts) is the profile's model provider.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authFromEnvironment, ManagementApi } from './api.ts'
import { MockLlm, type Script } from './mock-llm.ts'
import { createWorld, FakeGithub, initialWorld } from '../fakes/github-world.ts'
import { createLarkWorld, initialLarkWorld } from '../fakes/lark-world.ts'

/** This checkout, which holds the harness and the fakes. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/**
 * The dsh-superagent checkout under test: SUPERAGENT_CHECKOUT when set (it must be built, `pnpm install && pnpm build`),
 * otherwise this one. Its `scripts/dsh-superagent` runs the service, it is linked into the profile, and its `.artifacts/`
 * receives the startup logs and control files.
 */
export const CHECKOUT = resolve(process.env.SUPERAGENT_CHECKOUT || ROOT)
const SCRIPT = join(CHECKOUT, 'scripts', 'dsh-superagent')
const ARTIFACTS = join(CHECKOUT, '.artifacts')
const FAKES = join(ROOT, 'tests', 'e2e', 'fakes')
/** The version docs/006-deployment.md pins; SAE2E_DSH_VERSION overrides it. */
export const DSH_VERSION = process.env.SAE2E_DSH_VERSION ?? '0.2.1-rc.3'

export interface Run { code: number; stdout: string; stderr: string }
function run(program: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): Promise<Run> {
  return new Promise(resolve => execFile(program, args, { env: options.env, cwd: options.cwd ?? CHECKOUT, timeout: options.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })))
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** Polls `probe` until it returns a value other than undefined/false, or throws with the last error after `timeoutMs`. */
export async function waitFor<T>(what: string, probe: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 60_000,
  intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try { const value = await probe(); if (value !== undefined && value !== false) return value as T } catch (error) { last = error }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s waiting for ${what}${last ? `: ${String(last)}` : ''}`)
    await sleep(intervalMs)
  }
}

/**
 * Returns the `dsh` executable: SAE2E_DSH_BIN when set, otherwise `@deepseek-ai/dsh@<DSH_VERSION>` installed once into
 * SAE2E_DSH_CACHE (default `node_modules/.cache/dsh-superagent-e2e`) and reused by later runs.
 */
export async function installDsh(): Promise<string> {
  if (process.env.SAE2E_DSH_BIN) return process.env.SAE2E_DSH_BIN
  const cache = process.env.SAE2E_DSH_CACHE ?? join(ROOT, 'node_modules', '.cache', 'dsh-superagent-e2e')
  const prefix = join(cache, `dsh-${DSH_VERSION}`)
  const bin = join(prefix, 'bin', 'dsh')
  if (existsSync(bin) && (await run(bin, ['--version'])).stdout.trim() === DSH_VERSION) return bin
  const staging = `${prefix}.${process.pid}.tmp`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const installed = await run('npm', ['install', '-g', '--prefix', staging, '--no-fund', '--no-audit', `@deepseek-ai/dsh@${DSH_VERSION}`], { timeout: 600_000 })
  if (installed.code !== 0) throw new Error(`npm install @deepseek-ai/dsh@${DSH_VERSION} failed:\n${installed.stderr}`)
  rmSync(prefix, { recursive: true, force: true })
  renameSync(staging, prefix)
  return bin
}

export interface HarnessOptions {
  /** The fake world's repository and agent login. */
  repository?: string
  agent?: string
  /** Enables the bundle's Feishu Source plugin in the profile. */
  feishu?: boolean
  script: Script
}

interface HarnessFields {
  runDir: string; dshHome: string; home: string; stateDir: string; binDir: string; larkDir: string
  profile: string; port: number; url: string; dsh: string; repository: string; agent: string
  github: FakeGithub; llm: MockLlm; api: ManagementApi; tmuxDir: string; tmux: boolean
}

export class DshHarness implements HarnessFields {
  readonly runDir!: string
  readonly dshHome!: string
  readonly home!: string
  readonly stateDir!: string
  readonly binDir!: string
  readonly larkDir!: string
  readonly profile!: string
  readonly port!: number
  readonly url!: string
  readonly dsh!: string
  readonly repository!: string
  readonly agent!: string
  readonly github!: FakeGithub
  readonly llm!: MockLlm
  readonly api!: ManagementApi
  /** The tmux server's socket directory; short, because a Unix socket path has at most 107 bytes. */
  readonly tmuxDir!: string
  /** False when tmux is missing (or SAE2E_NO_TMUX=1): dsh is then started directly, as the script's tmux pane would run it. */
  readonly tmux!: boolean
  private direct?: { pid: number; log: string }
  /** Set by a suite whose test failed, so teardown keeps the run directory. */
  failed = false
  private constructor(fields: HarnessFields) { Object.assign(this, fields) }

  /** Installs DSH, creates the profile, links the bundle, writes the fakes and the patch. Does not start anything. */
  static async create(options: HarnessOptions): Promise<DshHarness> {
    if (!existsSync(join(CHECKOUT, 'lib', 'index.js'))) throw new Error(`Build the bundle in ${CHECKOUT} first: pnpm install && pnpm build`)
    const dsh = await installDsh()
    const runDir = mkdtempSync(join(process.env.SAE2E_TMP ?? tmpdir(), 'dsh-superagent-e2e-'))
    const base = tmpdir().length < 60 ? tmpdir() : '/tmp'
    const tmuxDir = mkdtempSync(join(base, 'sae2e-'))
    const ghDir = join(runDir, 'fake-github')
    const dirs = { dshHome: join(runDir, 'dsh-home'), home: join(runDir, 'home'), stateDir: join(runDir, 'state'), binDir: join(runDir, 'bin'),
      larkDir: join(runDir, 'fake-lark') }
    for (const dir of [...Object.values(dirs), ghDir]) mkdirSync(dir, { recursive: true })
    const repository = options.repository ?? 'acme/widgets'
    const agent = options.agent ?? 'widgets-agent'
    createWorld(ghDir, initialWorld(repository, agent))
    createLarkWorld(dirs.larkDir, initialLarkWorld())
    // The wrappers name their state directory themselves: setup runs them through DSH's subprocess service, which passes
    // only part of the environment.
    const wrapper = (name: string, fake: string, variable: string, state: string) => writeFileSync(join(dirs.binDir, name),
      `#!/bin/sh\n${variable}='${state}' exec '${process.execPath}' --no-warnings '${join(FAKES, fake)}' "$@"\n`, { mode: 0o755 })
    wrapper('gh-agent', 'gh.ts', 'SAE2E_GH_STATE', ghDir)
    wrapper('lark-bot', 'lark-cli.ts', 'SAE2E_LARK_STATE', dirs.larkDir)
    const port = await freePort()
    const url = `http://127.0.0.1:${port}`
    const profile = `sae2e-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
    const llm = await new MockLlm(options.script, join(runDir, 'llm-requests.jsonl')).start()
    const tmux = spawnSync('tmux', ['-V']).status === 0 && process.env.SAE2E_NO_TMUX !== '1'
    let harness!: DshHarness
    const api = new ManagementApi(url, authFromEnvironment(url, () => harness.launchToken()))
    harness = new DshHarness({ runDir, ...dirs, profile, port, url, dsh, github: new FakeGithub(ghDir), llm, api, repository, agent, tmuxDir, tmux })
    // docs/006: create the profile from the Web template (in this run's DSH_HOME), then add this checkout as a plugin.
    const created = await run(dsh, [profile, '--from-default-profile', 'web', '--dump-config'], { env: harness.env() })
    if (created.code !== 0) throw new Error(`Creating profile ${profile} failed:\n${created.stderr}`)
    const linked = await run(dsh, ['plugin', '--profile', profile, 'add', `link:${CHECKOUT}`], { env: harness.env() })
    if (linked.code !== 0) throw new Error(`dsh plugin add failed:\n${linked.stdout}\n${linked.stderr}`)
    // docs/006 Machine configuration: examples/profile.cordis.patch.yml with this run's port and stateDir, plus the model
    // route pointed at the scripted provider.
    writeFileSync(join(dirs.dshHome, 'profiles', profile, 'cordis.patch.yml'), [
      '- id: webserver', '  config:', '    host: 127.0.0.1', `    port: ${port}`,
      '- id: dsh-superagent', '  config:', `    stateDir: ${dirs.stateDir}`,
      '- id: llm-deepseek', '  config:', `    baseURL: ${llm.baseURL}`,
      ...options.feishu ? ['- id: dsh-superagent-feishu', '  disabled: false'] : [], ''].join('\n'))
    return harness
  }

  get gh(): string { return join(this.binDir, 'gh-agent') }
  get lark(): string { return join(this.binDir, 'lark-bot') }

  /** The environment of every dsh and service-script process: this run's DSH_HOME, HOME and tmux server, no real credentials. */
  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (/^(GH_|GITHUB_|TMUX|DSH_|DEEPSEEK_|ANTHROPIC_|OPENAI_|LARKSUITE_|XDG_|VITEST|NODE_OPTIONS)/.test(name)) continue
      env[name] = value
    }
    return { ...env, HOME: this.home, DSH_HOME: this.dshHome, TMUX_TMPDIR: this.tmuxDir, PATH: `${dirname(this.dsh)}:${process.env.PATH ?? ''}`,
      DSH_SUPERAGENT_PROFILE: this.profile, DSH_SUPERAGENT_URL: this.url,
      // The model route needs a credential to send; the scripted provider ignores it.
      DEEPSEEK_API_KEY: 'sae2e-fake-model-credential',
      DSH_TELEMETRY_OTLP_URL: 'http://127.0.0.1:9/v1/logs' }
  }

  /** Runs `scripts/dsh-superagent <args>` as an operator would. */
  async scriptRun(...args: string[]): Promise<Run> {
    return run('python3', [SCRIPT, '--profile', this.profile, '--url', this.url, ...args], { env: this.env(), timeout: 400_000 })
  }
  async start(): Promise<Run> {
    if (this.tmux) return this.scriptRun('start', '--timeout', '120')
    return this.startDirect()
  }
  async restart(): Promise<Run> {
    if (this.tmux) return this.scriptRun('restart', '--timeout', '120', '--stop-timeout', '120')
    await this.stop()
    return this.startDirect()
  }
  async stop(): Promise<Run> {
    if (this.tmux || !this.direct) return this.scriptRun('stop', '--stop-timeout', '120')
    const { pid } = this.direct
    process.kill(pid, 'SIGINT')
    await waitFor('dsh to exit', () => { try { process.kill(pid, 0); return false } catch { return true } }, 120_000)
    this.direct = undefined
    return { code: 0, stdout: 'stopped', stderr: '' }
  }
  async status(): Promise<Run & { json?: any }> {
    const result = await this.scriptRun('status')
    try { return { ...result, json: JSON.parse(result.stdout) } } catch { return result }
  }
  /**
   * Without tmux, starts `dsh --profile <p> --no-open` detached, as the script's tmux pane would, then waits for the same
   * readiness the script waits for and returns `status`.
   */
  private async startDirect(): Promise<Run> {
    const log = join(ARTIFACTS, `dsh-superagent-${this.profile}-direct-${Date.now()}.log`)
    mkdirSync(dirname(log), { recursive: true })
    const out = openSync(log, 'a')
    const child = spawn(this.dsh, ['--profile', this.profile, '--no-open'], { env: this.env(), cwd: CHECKOUT, detached: true, stdio: ['ignore', out, out] })
    child.unref()
    this.direct = { pid: child.pid!, log }
    await waitFor('the runtime to answer', async () => {
      const state = await this.api.request<any>('GET', 'state')
      return state.status === 200 && ['ready', 'paused'].includes(state.body.health?.runtime?.state)
    }, 120_000)
    return this.status()
  }

  /** Startup logs of this run's profile, oldest first. */
  logs(): string[] {
    const dir = ARTIFACTS
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(name => name.startsWith(`dsh-superagent-${this.profile}-`) && name.endsWith('.log'))
      .map(name => join(dir, name)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  }
  newestLog(): string { const log = this.logs().at(-1); return log ? readFileSync(log, 'utf8') : '' }
  /** The launch token DeepSeek Harness printed in the newest startup log (`dsh web: http://…/?token=…`). */
  launchToken(): string | undefined {
    return [...this.newestLog().matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
  }

  /** Stops the service, the tmux server and the scripted provider; keeps the run directory when the run failed or SAE2E_KEEP=1. */
  async teardown(): Promise<void> {
    const pid = (() => { try { return Number(readFileSync(join(ARTIFACTS, 'control', 'profiles', this.profile, 'service.pid'), 'utf8')) } catch { return 0 } })()
    try { await this.stop() } catch { /* Forced below. */ }
    for (const target of [pid, this.direct?.pid ?? 0]) {
      if (!target) continue
      try { process.kill(target, 0); process.kill(target, 'SIGKILL') } catch { /* Already gone. */ }
    }
    if (this.tmux) spawnSync('tmux', ['kill-server'], { env: this.env() })
    await this.llm.close()
    // The service script keeps logs and control files in the checkout; move this run's into the run directory.
    const logs = join(this.runDir, 'logs')
    mkdirSync(logs, { recursive: true })
    for (const log of this.logs()) { copyFileSync(log, join(logs, log.split('/').at(-1)!)); rmSync(log) }
    rmSync(join(ARTIFACTS, 'control', 'profiles', this.profile), { recursive: true, force: true })
    rmSync(this.tmuxDir, { recursive: true, force: true })
    if (this.failed || process.env.SAE2E_KEEP === '1') console.log(`dsh-superagent e2e: run directory kept at ${this.runDir}`)
    else rmSync(this.runDir, { recursive: true, force: true })
  }
}
