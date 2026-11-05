/**
 * The code host the fake adapter serves (docs/010): the agent account, one repository, Issues with their comments, and the
 * event log the adapter's `events` pages through by index. The harness seeds and edits it; the adapter answers from it and appends
 * what it is asked to write. Erasable syntax only (see store.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { update, writeState } from './store.ts'

export interface ChUser { login: string; id: string; bot: boolean }
export interface ChComment { id: string; author: ChUser; body: string; url: string; createdAt: string; key?: string }
export interface ChThread {
  type: 'issue' | 'pr'; number: number; title: string; state: 'open' | 'closed' | 'merged'; url: string; author: ChUser; body: string; createdAt: string
}
export interface ChEvent {
  id: string; kind: string; thread: { type: 'issue' | 'pr'; number: number; title?: string }; actor: ChUser; text: string; url?: string; at: string
  addressed: boolean; commentId?: string
}
export interface CodehostWorld {
  agent: { id: string; login: string; name: string; email: string }
  repository: { id: string; path: string; defaultBranch: string; canPush: boolean; webUrl: string; cloneUrl: string }
  /** The operations `describe` lists. */
  capabilities: string[]
  threads: Record<string, ChThread>
  comments: Record<string, ChComment[]>
  events: ChEvent[]
  nextId: number
}

export function initialCodehostWorld(path: string, login: string): CodehostWorld {
  const webUrl = `https://code.example.test/${path}`
  return { agent: { id: '77', login, name: 'Widgets Agent', email: `${login}@code.example.test` },
    repository: { id: '9', path, defaultBranch: 'main', canPush: true, webUrl, cloneUrl: `${webUrl}.git` },
    capabilities: ['whoami', 'repository', 'events', 'thread', 'comments', 'comment', 'git-credential'],
    threads: {}, comments: {}, events: [], nextId: 100 }
}
export function createCodehostWorld(dir: string, world: CodehostWorld): void {
  mkdirSync(dir, { recursive: true })
  writeState(dir, world)
  writeFileSync(join(dir, 'calls.jsonl'), '')
  writeFileSync(join(dir, 'writes.jsonl'), '')
}
export const threadKey = (type: string, number: number) => `${type}:${number}`

/** Harness-side editing of the code host, under the lock the adapter takes. */
export class FakeCodehost {
  readonly dir: string
  constructor(dir: string) { this.dir = dir }
  edit<R>(change: (world: CodehostWorld) => R): R { return update<CodehostWorld, R>(this.dir, change) }
  private user(login: string): ChUser { return { login, id: `u-${login}`, bot: login.endsWith('[bot]') } }
  /** Opens an Issue as `login`; its `opened` event mentions no one. */
  openIssue(login: string, title: string, body: string): ChThread {
    return this.edit(world => {
      const number = Object.values(world.threads).filter(thread => thread.type === 'issue').length + 1
      const at = new Date().toISOString()
      const issue: ChThread = { type: 'issue', number, title, state: 'open', url: `${world.repository.webUrl}/issues/${number}`, author: this.user(login), body, createdAt: at }
      world.threads[threadKey('issue', number)] = issue
      world.events.push({ id: `opened-${number}`, kind: 'opened', thread: { type: 'issue', number, title }, actor: issue.author, text: body, url: issue.url,
        at, addressed: false })
      return issue
    })
  }
  /** Comments as `login` on an Issue, mentioning the agent, and records the `mention` event the adapter reports. */
  mention(number: number, login: string, body: string): ChComment {
    return this.edit(world => {
      const id = String(world.nextId++)
      const issue = world.threads[threadKey('issue', number)]!
      const comment: ChComment = { id, author: this.user(login), body, url: `${issue.url}#note_${id}`, createdAt: new Date().toISOString() }
      ;(world.comments[threadKey('issue', number)] ??= []).push(comment)
      world.events.push({ id: `note-${id}`, kind: 'mention', thread: { type: 'issue', number, title: issue.title }, actor: comment.author, text: body,
        url: comment.url, at: comment.createdAt, addressed: true, commentId: id })
      return comment
    })
  }
}
