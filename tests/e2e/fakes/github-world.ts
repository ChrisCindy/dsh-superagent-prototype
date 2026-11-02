/**
 * The GitHub world the fake `gh` serves: one repository, the agent account, Issues and pull requests with their comments,
 * and the agent's notifications. The harness seeds and edits it; the fake answers from it and appends what it is asked to
 * write. Erasable syntax only (see store.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { update, writeState } from './store.ts'

export interface GhUser { login: string; id: number; type: string }
export interface GhComment {
  id: number; body: string; user: GhUser; html_url: string; created_at: string; updated_at: string
  issue_url?: string; in_reply_to_id?: number
}
export interface GhIssue {
  id: number; number: number; title: string; body: string; state: string; user: GhUser; created_at: string; updated_at: string; html_url: string
  pull_request?: { url: string }
}
export interface GhNotification {
  id: string; reason: string; unread: boolean; updated_at: string
  repository: { full_name: string }; subject: { title: string; url: string; type: string }
}
export interface GithubWorld {
  agent: GhUser
  /** False makes `gh api user` fail as a signed-out CLI does. */
  signedIn: boolean
  repository: { full_name: string; default_branch: string; push: boolean; head_sha: string }
  users: Record<string, GhUser>
  issues: Record<string, GhIssue>
  comments: Record<string, GhComment[]>
  reviewComments: Record<string, GhComment[]>
  reviews: Record<string, GhComment[]>
  pulls: Record<string, Record<string, unknown>>
  notifications: GhNotification[]
  /** Active ruleset rules on the default branch, as `GET repos/<r>/rules/branches/<b>` lists them. */
  branchRules: Record<string, unknown>[]
  /** Rulesets by id, as `GET repos/<r>/rulesets/<id>` answers as the agent account. */
  rulesets: Record<string, Record<string, unknown>>
  nextId: number
}

export function initialWorld(repository: string, agentLogin: string): GithubWorld {
  const agent = { login: agentLogin, id: 4242, type: 'User' }
  return { agent, signedIn: true, repository: { full_name: repository, default_branch: 'main', push: true, head_sha: 'e2e0000000000000000000000000000000000001' },
    users: { [agentLogin]: agent }, issues: {}, comments: {}, reviewComments: {}, reviews: {}, pulls: {}, notifications: [],
    // GitHub requires a fresh approval the agent account cannot bypass, so merge setup raises no warning.
    branchRules: [{ type: 'pull_request', ruleset_id: 7, parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } }],
    rulesets: { 7: { id: 7, current_user_can_bypass: 'never' } }, nextId: 1000 }
}
/** Creates the fake's state directory with an initial world. */
export function createWorld(dir: string, world: GithubWorld): void {
  mkdirSync(dir, { recursive: true })
  writeState(dir, world)
  writeFileSync(join(dir, 'calls.jsonl'), '')
  writeFileSync(join(dir, 'writes.jsonl'), '')
}
export const pageUrl = (world: GithubWorld, number: number, pr = false) =>
  `https://github.com/${world.repository.full_name}/${pr ? 'pull' : 'issues'}/${number}`
export const apiUrl = (world: GithubWorld, path: string) => `https://api.github.com/repos/${world.repository.full_name}/${path}`

export function userOf(world: GithubWorld, login: string): GhUser {
  world.users[login] ??= { login, id: 5000 + Object.keys(world.users).length, type: login.endsWith('[bot]') ? 'Bot' : 'User' }
  return world.users[login]!
}
/** Adds a comment to an Issue or PR conversation as `login`, at `at` (now by default). */
export function addComment(world: GithubWorld, number: number, login: string, body: string, at = new Date().toISOString()): GhComment {
  const id = world.nextId++
  const pr = !!world.issues[String(number)]?.pull_request
  const comment: GhComment = { id, body, user: userOf(world, login), html_url: `${pageUrl(world, number, pr)}#issuecomment-${id}`,
    created_at: at, updated_at: at, issue_url: apiUrl(world, `issues/${number}`) }
  ;(world.comments[String(number)] ??= []).push(comment)
  return comment
}

/** Harness-side editing of the world, under the same lock the fake takes. */
export class FakeGithub {
  readonly dir: string
  constructor(dir: string) { this.dir = dir }
  edit<R>(change: (world: GithubWorld) => R): R { return update<GithubWorld, R>(this.dir, change) }
  /** Opens an Issue as `login`, created at `at`. */
  openIssue(login: string, title: string, body: string, at = new Date().toISOString()): GhIssue {
    return this.edit(world => {
      const number = Object.keys(world.issues).length + 1
      const issue: GhIssue = { id: world.nextId++, number, title, body, state: 'open', user: userOf(world, login), created_at: at, updated_at: at,
        html_url: pageUrl(world, number) }
      world.issues[String(number)] = issue
      return issue
    })
  }
  /** Posts a comment as `login` and gives the agent a notification for its Issue, as GitHub does for a mention. */
  mention(number: number, login: string, body: string): GhComment {
    return this.edit(world => {
      const comment = addComment(world, number, login, body)
      const issue = world.issues[String(number)]!
      issue.updated_at = comment.created_at
      world.notifications.unshift({ id: String(world.nextId++), reason: 'mention', unread: true, updated_at: comment.created_at,
        repository: { full_name: world.repository.full_name },
        subject: { title: issue.title, url: apiUrl(world, `${issue.pull_request ? 'pulls' : 'issues'}/${number}`), type: issue.pull_request ? 'PullRequest' : 'Issue' } })
      return comment
    })
  }
}
