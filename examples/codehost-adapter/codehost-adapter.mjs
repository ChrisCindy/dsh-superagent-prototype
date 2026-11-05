#!/usr/bin/env node
// Reference stub of a dsh-superagent code-host adapter, contract version 1 (docs/010-codehost-adapter.md).
//
// dsh-superagent runs it as `codehost-adapter <operation> '<request JSON>'` and reads one JSON value from standard output.
// On failure it must exit non-zero and print {"error":{"code":<number>,"message":"…"}} on standard error: 404 not found
// (retried), 410 gone for good (a reply to it is dropped), 501 not implemented, anything else is retried later.
// Git runs it as `codehost-adapter git-credential get|store|erase`, with git's credential protocol on standard input.
//
// Every operation below answers 501 until it is implemented on top of the internal CLI (`b1` here). Implement the three
// required ones first (whoami, repository, events), then list each operation that works in CAPABILITIES: dsh-superagent calls
// only what `describe` lists and warns at setup about the rest. Keep the adapter's own credential out of its output and its
// arguments; read it from a file only this OS user can read, or let `b1` hold it.
//
// Run it for the agent account. For the merge account, install a second copy (or a wrapper) that acts as that account and
// answers only describe, whoami and merge; set it as the merge adapter.
import { execFileSync } from 'node:child_process'

/** The operations this adapter answers; add each one once it is implemented. */
const CAPABILITIES = ['whoami', 'repository', 'events']
const CONTRACT_VERSION = 1

/** Runs the internal CLI and parses its JSON output; adapt to how `b1` prints JSON and reports errors. */
// eslint-disable-next-line no-unused-vars
function b1(...args) {
  return JSON.parse(execFileSync('b1', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
}
class AdapterError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const notImplemented = operation => { throw new AdapterError(501, `not implemented: ${operation}`) }

const operations = {
  describe: () => ({ contractVersion: CONTRACT_VERSION, capabilities: CAPABILITIES, name: 'b1 adapter (stub)' }),
  // TODO: the account `b1` is signed in to: {id, login, name?, email?}; email is the address the agent's commits use.
  //   e.g. const me = b1('user', 'me', '--json'); return { id: String(me.id), login: me.username, name: me.name, email: me.email }
  whoami: () => notImplemented('whoami'),
  // TODO: {id, path, defaultBranch, canPush, webUrl, cloneUrl?} of request.repository; canPush is the agent's push right.
  repository: () => notImplemented('repository'),
  // TODO: the events after request.cursor (null on the first call: answer none and the cursor of now), oldest first:
  //   anything that mentions the agent, assigns it or requests its review; comments, reviews and state or CI changes on
  //   request.follow; and, per request.observe, new Issues, new pull requests and comments across the repository.
  //   Answer {events: [...], cursor, more}. A good source is the code host's todo or notification list plus an
  //   updated-since query of the followed threads. Give each event a stable `id` that changes when its text is edited.
  events: () => notImplemented('events'),
  // TODO: {type, number, title, state, url, author, body, createdAt, draft, head: {branch, sha, repository?}, additions,
  //   deletions, autoMerge, closedAt, mergedAt} of request.type/request.number; head.repository only for a fork.
  thread: () => notImplemented('thread'),
  // TODO: a page of comments and reviews of the thread after request.cursor, oldest first: {comments, cursor?}.
  comments: () => notImplemented('comments'),
  // TODO: post request.body on the thread (as a reply to request.replyTo when set), at most once per request.key: {id, url?}.
  comment: () => notImplemented('comment'),
  // TODO: every file the pull request request.number changes: {files: [{path, previousPath?}], complete}.
  files: () => notImplemented('files'),
  // TODO: the CI of the pull request's head commit: {sha, checks: [{name, state: success|failure|running|skipped|cancelled, url?}]}.
  checks: () => notImplemented('checks'),
  // TODO: {sha, approvals: [{login, bot?, sha?}], changesRequested: [login], dismissesStale}; an approval names the commit it
  //   approved when the code host records it.
  approvals: () => notImplemented('approvals'),
  // TODO: a file of the default branch as {content}, or a directory as {entries: [{name, type: file|directory}]}.
  contents: () => notImplemented('contents'),
  // TODO: {requiresApproval, dismissesStale, agentCanBypass} for request.branch; null where it cannot tell.
  protection: () => notImplemented('protection'),
  // TODO (merge adapter only): merge request.number at request.sha once its pipeline passes, with request.method:
  //   {state: enabled|merged}. Refuse when the head is no longer request.sha.
  merge: () => notImplemented('merge'),
}

/** Git's credential helper: print `username=` and `password=` for `get`, as the agent, for the code host's https URLs. */
function gitCredential(action) {
  if (action !== 'get') return // store and erase: nothing to keep
  // TODO: read git's request (protocol=, host=, path=) from standard input and print the agent's credential, e.g.
  //   process.stdout.write(`username=${login}\npassword=${token}\n`)
  process.exit(1)
}

const [operation, json = '{}'] = process.argv.slice(2)
if (operation === 'git-credential') gitCredential(process.argv[3])
else {
  try {
    const handler = operations[operation]
    if (!handler) throw new AdapterError(501, `unknown operation: ${operation}`)
    process.stdout.write(`${JSON.stringify(handler(JSON.parse(json)))}\n`)
  } catch (error) {
    const code = error instanceof AdapterError ? error.code : 500
    process.stderr.write(`${JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`)
    process.exit(1)
  }
}
