/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  temporaryAreas: [],
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})
/**
 * Probe answers of `cli` for a default branch `master` of acme/widgets whose ruleset requires an approving review that a push
 * dismisses, and which the agent account cannot bypass, so setup records no merge warning.
 */
export const reviewedBranch = (cli: string): Record<string, string> => ({
  [`${cli} api repos/acme/widgets --jq {branch: .default_branch, admin: .permissions.admin}`]: '{"branch":"master","admin":false}\n',
  [`${cli} api repos/acme/widgets/rules/branches/master`]:
    '[{"type":"pull_request","ruleset_id":1,"parameters":{"required_approving_review_count":1,"dismiss_stale_reviews_on_push":true}}]\n',
  [`${cli} api repos/acme/widgets/rulesets/1`]: '{"current_user_can_bypass":"never"}\n',
})
