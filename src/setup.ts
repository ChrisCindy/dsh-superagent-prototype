/**
 * Setup problems: `SetupError`, with a code, the place that fixes it and the English text the log, the main Session and the panel share;
 * and setup warnings (`SETUP_WARNINGS`, `setupWarning`), which leave dsh-superagent running
 */
import { fill } from './infra/text.ts'

export type SetupPlace = 'deployment' | 'execution' | 'github' | 'feishu' | 'dingtalk' | 'codehost'
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  permissionPresetMissing: ['deployment', 'The profile has no permission preset {preset} with sandbox {sandbox} and approval {approval}; keep the permission row of dsh-superagent\'s cordis.patch.yml, or restore the preset in the profile\'s cordis.patch.yml.'],
  protectedInTemporary: ['deployment', '{directory} lies in {temporary}, which the DeepSeek Harness sandbox lets every worker write; move it out of the temporary areas, as docs/006 describes.'],
  writableRootProtected: ['execution', 'The writable root {root} would let workers write {protected}; remove it, or name a directory that neither contains nor lies inside it.'],
  writableRootUngranted: ['execution', 'The DeepSeek Harness sandbox does not grant the writable root {root}; remove it, add it to the additionalWritableRoots of the profile\'s sandbox-policy row where DeepSeek Harness supports that, or set the sandbox to full.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  agentAccountMismatch: ['github', 'The agent GitHub CLI of this Source is signed in to @{account}, but GitHub Sources share the agent\'s account @{agent}.'],
  repositoryTwice: ['github', 'Another GitHub Source already receives {repository}.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
  dingtalkCredentialsUnreadable: ['dingtalk', 'The DingTalk app credentials cannot be read: {reason}.'],
  dingtalkCredentialsExposed: ['dingtalk', 'Others may read the DingTalk app credentials in {file}; make the file readable only by the user dsh-superagent runs as (chmod 600).'],
  dingtalkCredentialsMalformed: ['dingtalk', 'The DingTalk app credentials are not JSON with appKey and appSecret.'],
  dingtalkCredentialsVariable: ['dingtalk', 'The variable {variable} that holds the DingTalk app credentials must have SECRET in its name, so DeepSeek Harness keeps it from workers.'],
  dingtalkEndpointInvalid: ['dingtalk', 'The DingTalk OpenAPI endpoint {endpoint} is not an https URL.'],
  dingtalkCredentialsRejected: ['dingtalk', 'DingTalk gave the app no access token; check its AppKey and AppSecret.'],
  dingtalkStreamRefused: ['dingtalk', 'DingTalk refused a Stream mode connection for the app; set the robot\'s message receiving mode to Stream mode, as docs/006-deployment.md describes.'],
  codehostAdapterUnset: ['codehost', 'The code-host Source is on, and its adapter is not set.'],
  codehostAdapterMissing: ['codehost', 'The code-host adapter {adapter} was not found.'],
  codehostAdapterFailed: ['codehost', 'The code-host adapter {adapter} does not work.'],
  codehostContract: ['codehost', 'The code-host adapter {adapter} speaks contract version {version}, not {expected}, or lacks required operations: {missing}; docs/010 describes the contract.'],
  codehostNoAccount: ['codehost', 'The code-host adapter {adapter} did not report the agent\'s account.'],
  codehostRepositoryUnset: ['codehost', 'The code-host Source names no repository.'],
  codehostAdapterMismatch: ['codehost', 'This code-host Source uses the adapter {adapter}, but code-host Sources share the agent\'s adapter {first}.'],
  codehostRepositoryUnreadable: ['codehost', '@{account} cannot read {repository} on the code host.'],
  codehostRepositoryReadOnly: ['codehost', '@{account} cannot push to {repository} on the code host.'],
  codehostRepositoryTwice: ['codehost', 'Another code-host Source already receives {repository}.'],
  codehostMergeAgent: ['codehost', 'The merge adapter {adapter} acts as the agent account @{account}; give it the credential of another account that may merge.'],
  codehostWorkerCli: ['codehost', 'The workers\' code-host CLI {cli} cannot be used.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
/** `source` names the Source instance a problem of a Source place belongs to, when it is not the kind's first instance. */
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string; source?: string }

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  /** The Source instance the problem belongs to, when it is not the first instance of the kind `place` names. */
  source?: string
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  /** Names Source instance `source` as the one the problem belongs to; the kind's first instance needs no name. */
  in(source: string): this {
    if (source !== this.place) this.source = source
    return this
  }
  get problem(): SetupProblem {
    return { place: this.place, code: this.code, values: this.values, detail: this.message, ...this.source ? { source: this.source } : {} }
  }
}

/**
 * Setup findings that leave dsh-superagent running: the Overview and the Source page show each with its fix. A warning names
 * a GitHub rule that should back what the prompts ask of the agent, such as an approval before a merge.
 */
export const SETUP_WARNINGS = {
  mergeUnverified: ['github', '@{account} cannot read the review rules of {branch} in {repository}, so dsh-superagent cannot check that GitHub requires an approval before a merge; check in the repository settings that {branch} requires an approving review and dismisses stale approvals when new commits are pushed.'],
  mergeUnprotected: ['github', '{branch} in {repository} does not require an approving review that a new push dismisses, so only the prompts keep unreviewed commits from merging; in a branch protection rule or ruleset of {branch}, require at least one approving review and dismiss stale approvals when new commits are pushed.'],
  mergeBypass: ['github', '@{account} may bypass the review rules of {branch} in {repository}, so the agent could merge without an approval; remove it from the bypass list, or turn on Do not allow bypassing the above settings.'],
  codehostCapabilities: ['codehost', 'The code-host adapter {adapter} does not answer {missing}: {effects}.'],
  codehostMergeUnverified: ['codehost', 'The code-host adapter cannot tell whether {branch} in {repository} requires an approval before a merge; check on the code host that {branch} requires an approving review, withdraws approvals on a push, and that @{account} can neither push to it nor merge without one.'],
  codehostMergeUnprotected: ['codehost', '{branch} in {repository} does not require an approval that a new push withdraws, so only dsh-superagent\'s checks keep unreviewed commits from merging; require one on the code host.'],
  codehostMergeBypass: ['codehost', '@{account} may push to {branch} in {repository}, or merge into it without an approval, so the agent could merge unreviewed work; take that right from the agent\'s account on the code host.'],
  codehostShimUnguarded: ['codehost', 'The workers\' CLI {cli} refuses no command: no merge pattern is set, so only the code host\'s branch rules keep the agent from merging with it; add the CLI\'s merge commands as patterns.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupWarningCode = keyof typeof SETUP_WARNINGS
/** `source` names the Source instance a warning belongs to, when it is not the first instance of the kind `place` names. */
export interface SetupWarning { place: SetupPlace; code: SetupWarningCode; values: Record<string, string>; detail: string; source?: string }
export function setupWarning(code: SetupWarningCode, values: Record<string, string> = {}, source?: string): SetupWarning {
  const [place, text] = SETUP_WARNINGS[code]
  return { place, code, values, detail: fill(text, values), ...source && source !== place ? { source } : {} }
}
/** The Source instance a setup problem or warning belongs to: its `source`, or the first instance of the kind its `place` names. */
export const problemSource = (problem: Pick<SetupProblem, 'place' | 'source'>): string => problem.source ?? problem.place
