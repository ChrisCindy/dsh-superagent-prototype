import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, checkMerging, executable, githubInstances, machineOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { setupWarning } from '../src/setup.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000,
        temporaryAreas: [...new Set(['/tmp', tmpdir()])] })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), [{ id: 'github', config: { repository: 'acme/widgets', cli: 'gh' } }], probe, path)
    expect(deployment).toMatchObject({ repositories: { github: 'acme/widgets' }, github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), [{ id: 'github', config: { repository: 'acme/gadgets', cli: 'gh' } }], probe, path)).repositories)
      .toEqual({ github: 'acme/widgets' })
  })
  it('resolves each GitHub Source instance\'s repository under its ID, all with the one agent account', async () => {
    // A second stand-in, signed in to the same account, may push to acme/docs.
    program(join(dir, 'bin', 'gh-docs'), `case "$*" in\n  "api user") echo '{"login":"agent-bot","id":7}' ;;\n  "api repos/acme/docs --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/Docs","push":true}' ;;\n  *) exit 1 ;;\nesac`)
    const instances = (docs: Record<string, unknown>) => [{ id: 'github', config: { repository: 'acme/widgets', cli: 'gh' } },
      { id: 'github-docs', config: { repository: 'acme/docs', cli: 'gh', ...docs } }]
    // The first instance's CLI is the one workers call; both instances share its account.
    const twoRepositories = await resolveDeployment(machine(), instances({ cli: 'gh-docs' }), probe, path)
    expect(twoRepositories.repositories).toEqual({ github: 'acme/widgets', 'github-docs': 'acme/Docs' })
    expect(twoRepositories.github.cli).toBe(join(dir, 'bin', 'gh'))
    // A problem of another instance names it as its source, so the panel shows it on that instance's card.
    await expect(resolveDeployment(machine(), instances({ repository: '' }), probe, path).catch((error: { problem: unknown }) => error.problem))
      .resolves.toMatchObject({ place: 'github', code: 'repositoryUnset', source: 'github-docs' })
    // Another account, or a repository another instance receives, is refused.
    gh(join(dir, 'bin', 'gh-other'), 'someone-else')
    await expect(resolveDeployment(machine(), instances({ cli: 'gh-other' }), probe, path)).rejects
      .toMatchObject({ code: 'agentAccountMismatch', values: { account: 'someone-else', agent: 'Agent-Bot' }, source: 'github-docs' })
    await expect(resolveDeployment(machine(), instances({ repository: 'acme/gadgets' }), probe, path)).rejects
      .toMatchObject({ code: 'repositoryTwice', values: { repository: 'acme/widgets' }, source: 'github-docs' })
  })
  it('resolves the first GitHub instance always, and another one only while it is on', () => {
    const stored = (enabled: boolean) => ({ github: { kind: 'github', enabled: false, config: { repository: 'acme/widgets' } },
      'github-docs': { kind: 'github', enabled, config: { repository: 'acme/docs' } }, feishu: { kind: 'feishu', enabled: true, config: {} } })
    expect(githubInstances(stored(true)).map(item => item.id)).toEqual(['github', 'github-docs'])
    expect(githubInstances(stored(false))).toEqual([{ id: 'github', config: { repository: 'acme/widgets' } }])
    expect(githubInstances({})).toEqual([{ id: 'github', config: undefined }])
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), [{ id: 'github', config: github }], probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})

describe('merge check', () => {
  const deployment = { repository: 'acme/widgets', github: { cli: '/bin/gh', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' } }
  const BRANCH = '/bin/gh api repos/acme/widgets --jq {branch: .default_branch, admin: .permissions.admin}'
  const RULES = '/bin/gh api repos/acme/widgets/rules/branches/main'
  const PROTECTION = '/bin/gh api repos/acme/widgets/branches/main/protection'
  const reviewRule = (id: number, count = 1, dismiss = true) => ({ type: 'pull_request', ruleset_id: id,
    parameters: { required_approving_review_count: count, dismiss_stale_reviews_on_push: dismiss } })
  /** The agent's gh answering `answers` by command line; an Error answer fails the call with its message, as gh's stderr would. */
  const probeOf = (answers: Record<string, unknown>): Probe => async argv => {
    const answer = answers[argv.join(' ')]
    if (answer === undefined) throw new Error('gh: Not Found (HTTP 404)')
    if (answer instanceof Error) throw answer
    return typeof answer === 'string' ? answer : JSON.stringify(answer)
  }
  const warnings = async (answers: Record<string, unknown>) => (await checkMerging(deployment, probeOf({ [BRANCH]: { branch: 'main', admin: false }, ...answers })))
    .map(warning => warning.code)
  const NOT_PROTECTED = new Error('gh: Branch not protected (HTTP 404)')

  it('warns of nothing when a ruleset the agent cannot bypass, or a branch protection rule, requires a review that a push dismisses', async () => {
    expect(await warnings({ [RULES]: [reviewRule(1)], '/bin/gh api repos/acme/widgets/rulesets/1': { current_user_can_bypass: 'never' } })).toEqual([])
    const protection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true }, enforce_admins: { enabled: false } }
    expect(await warnings({ [RULES]: [], [PROTECTION]: protection })).toEqual([])
    // An admin bypasses branch protection unless it is enforced for administrators.
    expect(await warnings({ [RULES]: [], [PROTECTION]: { ...protection, enforce_admins: { enabled: true } },
      [BRANCH]: { branch: 'main', admin: true } })).toEqual([])
  })

  it('warns when nothing requires a review, or a push keeps stale approvals', async () => {
    expect(await warnings({ [RULES]: [], [PROTECTION]: NOT_PROTECTED })).toEqual(['mergeUnprotected'])
    expect(await warnings({ [RULES]: [reviewRule(1, 1, false)], [PROTECTION]: NOT_PROTECTED })).toEqual(['mergeUnprotected'])
    expect(await warnings({ [RULES]: [reviewRule(1, 0)], [PROTECTION]: { required_pull_request_reviews: { required_approving_review_count: 1 } } }))
      .toEqual(['mergeUnprotected'])
    const [warning] = await checkMerging(deployment, probeOf({ [BRANCH]: { branch: 'main', admin: false }, [RULES]: [], [PROTECTION]: NOT_PROTECTED }))
    expect(warning).toEqual(setupWarning('mergeUnprotected', { account: 'agent-bot', branch: 'main', repository: 'acme/widgets' }))
    expect(warning!.place).toBe('github')
  })

  it('warns when the agent account may bypass the rules: a ruleset\'s bypass list, an unenforced admin, or a pull request allowance', async () => {
    expect(await warnings({ [RULES]: [reviewRule(1)], '/bin/gh api repos/acme/widgets/rulesets/1': { current_user_can_bypass: 'pull_requests_only' },
      [PROTECTION]: new Error('gh: Must have admin rights to Repository. (HTTP 403)') })).toEqual(['mergeBypass'])
    const reviews = { required_approving_review_count: 2, dismiss_stale_reviews: true }
    expect(await warnings({ [RULES]: [], [PROTECTION]: { required_pull_request_reviews: reviews, enforce_admins: { enabled: false } },
      [BRANCH]: { branch: 'main', admin: true } })).toEqual(['mergeBypass'])
    expect(await warnings({ [RULES]: [], [PROTECTION]: { required_pull_request_reviews: { ...reviews,
      bypass_pull_request_allowances: { users: [{ login: 'Agent-Bot' }] } }, enforce_admins: { enabled: true } } })).toEqual(['mergeBypass'])
  })

  it('says it cannot verify when the account may not read branch protection or GitHub answers something else, and never fails', async () => {
    expect(await warnings({ [RULES]: [], [PROTECTION]: new Error('gh: Must have admin rights to Repository. (HTTP 403)') })).toEqual(['mergeUnverified'])
    expect(await warnings({ [RULES]: [], [PROTECTION]: new Error('gh: Not Found (HTTP 404)') })).toEqual(['mergeUnverified'])
    // Without the rulesets, a branch without protection may still have a ruleset.
    expect(await warnings({ [PROTECTION]: NOT_PROTECTED })).toEqual(['mergeUnverified'])
    expect(await checkMerging(deployment, probeOf({ [BRANCH]: 'not json' }))).toEqual([setupWarning('mergeUnverified', { account: 'agent-bot',
      branch: 'the default branch', repository: 'acme/widgets' })])
  })
})
