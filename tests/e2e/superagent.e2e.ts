/**
 * dsh-superagent end to end, on a real DeepSeek Harness installation (tests/e2e/README.md). The scenarios share one
 * installation and run in order, each starting where the previous one left the service.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readLog } from './fakes/store.ts'
import { DshHarness, waitFor } from './harness/dsh.ts'
import { ACKNOWLEDGEMENT, cards, RESULT, superagentScript } from './harness/script.ts'
import { existsSync } from 'node:fs'

let harness: DshHarness
const ALLOWED = 'alice'

beforeAll(async () => { harness = await DshHarness.create({ script: superagentScript(), feishu: true }) })
afterEach(context => { if (context.task.result?.state === 'fail') harness.failed = true })
afterAll(async () => { await harness?.teardown() })

describe('dsh-superagent on a real DeepSeek Harness', () => {
  it('(a) reports setup at startup, and saving the GitHub Source with the fake gh resolves it', async () => {
    const started = await harness.start()
    expect(started.code, started.stdout + started.stderr).toBe(3)
    // Without tmux the harness starts dsh itself and reports `status`; only the service script prints this line.
    if (harness.tmux) expect(started.stdout).toContain('dsh-superagent is waiting for setup: The GitHub Source names no repository.')
    expect(harness.launchToken()).toBeTruthy()

    let state = await harness.api.get('state')
    expect(state.setup.problem).toMatchObject({ place: 'github', code: 'repositoryUnset' })
    expect(state.health.github).toMatchObject({ state: 'paused' })

    // A CLI that does not exist is the setup problem the save reports, and nothing is saved.
    const missing = await harness.api.saveBlock('source:github', { enabled: true, config: { repository: harness.repository, cli: `${harness.binDir}/no-such-gh` } })
    expect(missing.status).toBe(400)
    expect(missing.body.setup).toMatchObject({ place: 'github', code: 'agentCliMissing' })
    expect(missing.body.error).toContain('The agent GitHub CLI was not found.')
    expect((await harness.status()).code).toBe(3)

    const saved = await harness.api.saveBlock('source:github', { enabled: true, config: { repository: harness.repository, cli: harness.gh } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject({ restarting: true })
    state = await waitFor('setup to resolve after the restart', async () => {
      const answer = await harness.api.request<any>('GET', 'state')
      return answer.status === 200 && answer.body.setup.accounts && answer.body.health.runtime?.state === 'ready' ? answer.body : undefined
    })
    expect(state.setup).toMatchObject({ problem: null, feishuProblem: null, accounts: { repository: harness.repository, agent: harness.agent } })
    const status = await harness.status()
    expect(status.code, status.stdout).toBe(0)
    expect(status.json).toMatchObject({ setup: null, errors: {}, manually_stopped: false })
    // Setup asked the fake who it is and whether it may push, through the worker subprocess service.
    const calls = readLog<{ argv: string[] }>(`${harness.runDir}/fake-github`, 'calls').map(call => call.argv.join(' '))
    expect(calls).toContain('api user')
    expect(calls).toContain(`api repos/${harness.repository} --jq {name: .full_name, push: .permissions.push}`)

    // A full restart through the service script keeps the resolved setup.
    const restarted = await harness.restart()
    expect(restarted.code, restarted.stdout + restarted.stderr).toBe(0)
    expect((await harness.api.get('state')).setup.problem).toBeNull()
  })

  it('(b) answers the documented management API with the documented shapes', async () => {
    const api = harness.api
    const state = await api.get('state')
    expect(state).toMatchObject({ setup: { problem: null, feishuProblem: null, accounts: expect.any(Object) },
      load: { running: expect.any(Number), queued: expect.any(Number), maxWorkers: expect.any(Number) },
      paused: false, masterId: expect.any(String) })
    for (const [name, entry] of Object.entries<any>(state.health)) {
      expect(['starting', 'ready', 'paused', 'error'], name).toContain(entry.state)
      expect(entry.detail, name).toEqual(expect.any(String))
      // docs/006 lists `at` on every entry; the code (Health in src/sources/host.ts) leaves it out of some, such as models and evals.
      if ('at' in entry) expect(Number.isNaN(Date.parse(entry.at)), name).toBe(false)
    }
    expect(Object.keys(state.health)).toEqual(expect.arrayContaining(['runtime', 'evals', 'assessment', 'launch', 'delivery', 'relay', 'notice', 'reply', 'github']))

    const settings = await api.get('settings')
    for (const block of ['policy', 'eval', 'executor']) expect(settings.blocks[block]).toMatchObject({ value: expect.any(Object), revision: expect.any(Number) })
    expect(settings.blocks.eval.value).toMatchObject({ mode: expect.any(String), timeoutSeconds: expect.any(Number) })
    expect(settings.blocks.executor.value).toMatchObject({ maxWorkers: expect.any(Number), directory: expect.any(String), prepare: expect.any(String),
      blockedCommands: expect.any(Array) })
    const github = settings.sources.find((source: any) => source.id === 'github')
    expect(github).toMatchObject({ kind: 'github', installed: true, revision: expect.any(Number),
      value: { enabled: true, config: { repository: harness.repository, cli: harness.gh, observeIssues: false, observePulls: false, observeComments: false, observeCi: false } } })
    expect(github.fields).toEqual(expect.any(Array))
    expect(settings.policyVersion).toEqual(expect.any(String))
    expect(settings.environment).toMatchObject({ root: expect.any(String), variables: expect.any(Array) })

    const sources = await api.get('sources')
    const status = sources.find((source: any) => source.id === 'github')
    expect(['starting', 'ready']).toContain(status.state)
    expect(status).toHaveProperty('health')
    expect(status).toHaveProperty('stats')
    expect(status.filtered).toEqual(expect.any(Array))
    expect(status.dropped).toEqual(expect.any(Array))

    // Saving a block: the Policy with the account allowed to ask for work.
    const policy = settings.blocks.policy
    const value = { ...policy.value, sources: { github: { allowed: [{ id: ALLOWED }] } } }
    const saved = await api.put('settings/policy', { value, revision: policy.revision })
    expect(saved).toMatchObject({ saved: expect.anything(), revision: policy.revision + 1, policy_changed: true, restarting: false })
    const stale = await api.request<any>('PUT', 'settings/policy', { value, revision: policy.revision })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toEqual(expect.any(String))
    const invalid = await api.request<any>('PUT', 'settings/executor', { value: { ...settings.blocks.executor.value, maxWorkers: -1 }, revision: settings.blocks.executor.revision })
    expect(invalid.status).toBe(400)
    expect(invalid.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining('maxWorkers') })]))
    const unknownSource = await api.request<any>('PUT', 'settings/source:nowhere', { value: {}, revision: 0 })
    expect(unknownSource.status).toBe(404)

    expect(await api.post('executor/pause', { paused: true })).toEqual({ paused: true })
    expect((await api.get('state')).paused).toBe(true)
    expect(await api.post('executor/pause', { paused: false })).toEqual({ paused: false })

    const check = await api.request<any>('POST', 'setup/check', {})
    expect(check.status).toBe(400)
    expect(check.body).toMatchObject({ code: 'setupComplete', error: expect.any(String) })

    const prompts = await api.get('prompts')
    expect(prompts).toMatchObject({ current: { revision: expect.any(Number), config: expect.any(Object) }, defaults: expect.any(Object),
      sections: expect.any(Array), skillName: expect.any(String), builtin: expect.any(Array), skillPrefix: expect.any(String) })
    const promptSave = await api.put('prompts', { config: prompts.current.config, baseRevision: prompts.current.revision })
    expect(promptSave).toMatchObject({ revision: expect.any(Number) })

    const sync = await api.request<any>('POST', 'policy-sync/github', {})
    expect([200, 400]).toContain(sync.status)
    if (sync.status === 200) expect(sync.body).toHaveProperty('policy')
    else expect(sync.body.error).toEqual(expect.any(String))
    for (const action of ['retry', 'stop']) expect((await api.request('POST', `tickets/no-such-ticket/${action}`, {})).status).toBe(404)
    expect((await api.request('GET', 'no-such-route')).status).toBe(404)

    // The same-origin fence: no header, or another Origin, is refused (401 where DeepSeek Harness sign-in guards the API first).
    const raw = (headers: Record<string, string>) => fetch(`${harness.url}/orchestrator/api/state`, { headers }).then(response => response.status)
    expect(await raw({})).toBeOneOf([401, 403])
    expect(await raw({ 'x-orchestrator-request': '1', origin: 'http://evil.example' })).toBeOneOf([401, 403])
    expect((await api.request('GET', 'state', undefined, { origin: harness.url })).status).toBe(200)
  })

  it('(c) turns a mention from an allowed login into a Trigger and a candidate for the main Session', async () => {
    const issue = harness.github.openIssue(ALLOWED, 'Typo in README', 'The README misspells the project name.')
    // A mention counts from the Source's read position on: wait for a completed poll, then mention the agent.
    await waitFor('a completed GitHub poll', async () => (await harness.api.get('state')).health.github?.state === 'ready', 120_000)
    const comment = harness.github.mention(issue.number, ALLOWED, `@${harness.agent} please fix the typo "widgts" in README.md`)
    // The next poll, at most a minute later, reads the notification, the Issue and its comments.
    const detail = await waitFor('the Trigger on the Thread', async () => {
      const answer = await harness.api.request<any>('GET', `threads/${encodeURIComponent(thread(issue.number))}`)
      return answer.status === 200 && answer.body.timeline.some((item: any) => item.text?.includes('widgts')) ? answer.body : undefined
    }, 150_000, 1000)
    debug('thread-after-mention', detail)
    const trigger = detail.timeline.find((item: any) => item.text.includes('widgts'))
    expect(trigger).toMatchObject({ source: 'github', human: true, url: comment.html_url, threads: [thread(issue.number)] })
    expect(JSON.stringify(trigger.actor)).toContain(ALLOWED)
    const threads = await harness.api.get('threads?filter=all')
    expect(threads.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: thread(issue.number), source: 'github' })]))

    // The main Session's next model request carries the trigger as an explicit candidate card.
    const request = await waitFor('the main Session to receive the candidate', () =>
      harness.llm.byRole('main').find(item => cards(item.latest).some(card => card.trigger_id === trigger.id)), 60_000)
    const card = cards(request.latest).find(item => item.trigger_id === trigger.id)!
    expect(card).toMatchObject({ kind: 'candidate', from: ALLOWED, thread: thread(issue.number), strength: 'explicit', source_url: comment.html_url })
    expect(card.text).toContain('widgts')
    expect(request.sessionId).toBe((await harness.api.get('state')).masterId)
    // The Issue's own body names no one: it is on the Thread, but no candidate.
    expect(harness.llm.byRole('main').flatMap(item => cards(item.latest)).filter(item => item.kind === 'candidate')).toHaveLength(1)
    issueNumber = issue.number
    triggerId = trigger.id
  })

  it('(d) carries the request through acceptance, the worker and the result reply', async () => {
    // The scripted main Session accepts the candidate: a Decision and a Ticket.
    const decided = await waitFor('the accept Decision', async () => {
      const detail = await harness.api.get(`threads/${encodeURIComponent(thread(issueNumber))}`)
      return detail.decisions.find((decision: any) => decision.kind === 'accept' && decision.triggerIds.includes(triggerId)) ?? undefined
    }, 60_000)
    const ticketId: string = decided.ticketId
    expect(ticketId).toEqual(expect.any(String))

    // Acceptance posts the acknowledgement through the agent's gh, on the Issue, once.
    const ack = await waitFor('the acknowledgement comment', () => writes().find(write => write.kind === 'comment' && write.body.includes(ACKNOWLEDGEMENT)), 60_000)
    expect(ack).toMatchObject({ number: issueNumber })
    expect(ack.body).toMatch(/<!-- dsh-superagent:[^>]+ -->/)

    // The worker Session starts in the Ticket's directory and reports ready.
    const ticket = await waitFor('the worker report', async () => {
      const detail = await harness.api.get(`tickets/${ticketId}`)
      return detail.assignments.some((assignment: any) => assignment.report?.state === 'ready') ? detail : undefined
    }, 120_000)
    debug('ticket-after-report', ticket)
    const workers = harness.llm.byRole('worker')
    const pwd = workers.flatMap(item => item.results).find(result => result.name === 'bash')
    expect(pwd, 'the worker ran pwd').toBeDefined()
    const directory = /\/\S+/.exec(pwd!.text)![0]
    expect(directory.startsWith(`${harness.stateDir}/work/`), directory).toBe(true)
    expect(ticket.directory).toBe(directory)
    expect(directory).toMatch(/\/work\/fix-readme-typo-[0-9a-f]+$/)
    expect(workers[0]!.sessionId).toBe(ticket.assignments[0].ref)
    // docs/009: the worker writes its Ticket directory, not the state directory, and its gh refuses to merge.
    expect(pwd!.text).toContain('INSIDE_WRITE_OK')
    expect(pwd!.text).toContain('ESCAPE_WRITE_DENIED')
    expect(existsSync(join(harness.stateDir, 'escape.txt'))).toBe(false)
    expect(pwd!.text).toContain('orchestrator_merge_request')
    expect(pwd!.text).not.toContain('MERGE_EXIT=0')

    // The main Session receives the worker's report and sends the result, which the Outbox delivers through gh.
    const result = await waitFor('the result comment', () => writes().find(write => write.kind === 'comment' && write.body.includes(RESULT)), 120_000)
    expect(result).toMatchObject({ number: issueNumber })
    const relay = harness.llm.byRole('main').flatMap(item => cards(item.latest)).find(card => card.kind === 'worker_report')
    expect(relay).toMatchObject({ state: 'ready', ticket: { ticket_id: ticketId }, trigger_id: triggerId })
    const ended = await harness.api.get(`tickets/${ticketId}`)
    debug('ticket-after-result', ended)
    // With no pull request to wait for, a ready report completes the Ticket.
    expect(ended.ended).toMatchObject({ outcome: 'completed' })
    // Each message went out once, and the bundle asked the fake nothing it does not know.
    expect(writes().filter(write => write.kind === 'comment').map(write => write.body.split('\n')[0])).toEqual([ACKNOWLEDGEMENT, RESULT])
    expect(writes().filter(write => /merge/i.test(String(write.kind)))).toEqual([])
    expect(readLog<{ argv: string[]; unknown?: boolean }>(`${harness.runDir}/fake-github`, 'calls').filter(call => call.unknown)).toEqual([])
    const status = await harness.status()
    expect(status.code, status.stdout).toBe(0)
  })
  it('(e) sets up the Feishu Source with the fake bot lark-cli, whose event consumer becomes ready', async () => {
    const saved = await harness.api.saveBlock('source:feishu', { enabled: true, config: { cli: harness.lark } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject({ restarting: true })
    const state = await waitFor('the Feishu bot to resolve and its consumer to be ready', async () => {
      const answer = await harness.api.request<any>('GET', 'state')
      return answer.status === 200 && answer.body.setup.accounts?.feishu && answer.body.health.feishu?.state === 'ready' ? answer.body : undefined
    }, 90_000)
    expect(state.setup).toMatchObject({ problem: null, feishuProblem: null, accounts: { feishu: { appId: 'cli_e2efake', botId: 'ou_e2ebot', brand: 'feishu' } } })
    const calls = readLog<{ argv: string[]; unknown?: boolean }>(harness.larkDir, 'calls')
    expect(calls.map(call => call.argv.slice(0, 2).join(' '))).toEqual(expect.arrayContaining(['auth status', 'config strict-mode', 'event consume']))
    expect(calls.filter(call => call.unknown)).toEqual([])
    const status = await harness.status()
    expect(status.code, status.stdout).toBe(0)
  })

  it('(f) refuses the management API without the DeepSeek Harness sign-in, except the health read', async () => {
    // docs/009: a worker or another local process that has the panel headers but not the signed cookie gets nowhere.
    const headers = { 'x-orchestrator-request': '1', origin: harness.url, 'content-type': 'application/json' }
    const call = (method: string, path: string, body?: unknown) => fetch(`${harness.url}/orchestrator/api/${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(response => response.status)
    expect(await call('GET', 'state')).toBe(200)
    expect(await call('GET', 'settings')).toBe(401)
    expect(await call('PUT', 'settings/policy', { value: {}, revision: 0 })).toBe(401)
    expect(await call('POST', 'executor/pause', { paused: true })).toBe(401)
    expect(await call('POST', 'policy-proposal/accept', {})).toBe(401)
    expect((await harness.api.get('state')).paused).toBe(false)
  })
})

let issueNumber = 0
let triggerId = ''
const thread = (number: number) => `github:${number}`
const writes = () => readLog<{ kind: string; number: number; body: string }>(`${harness.runDir}/fake-github`, 'writes')
/** Writes a view to the run directory, kept on failure, for diagnosis. */
const debug = (name: string, value: unknown) => writeFileSync(join(harness.runDir, `${name}.json`), JSON.stringify(value, null, 2))
