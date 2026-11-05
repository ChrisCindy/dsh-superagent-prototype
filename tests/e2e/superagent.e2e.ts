/**
 * Only with `pnpm test:e2e` (tests/e2e/README.md): the bundle in a real DeepSeek Harness installation, through `scripts/dsh-superagent` and
 * the management API, with fake `gh`, `lark-cli` and DingTalk and a scripted model: setup, the API's shapes, a mention through acceptance, the worker
 * and the result reply, the Feishu bot setup, a second GitHub Source for another repository, a schedule entry's Trigger on an Issue's
 * Thread that a restart does not repeat, the DingTalk Source's setup and a mention of its robot carried to the replies in the group,
 * and the escalations of 009 a worker or local process can try (writing the state directory,
 * merging, the API without the sign-in)
 *
 * The scenarios share one installation and run in order, each starting where the previous one left the service.
 */
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_APP, FakeDingtalk } from './fakes/dingtalk.ts'
import { readLog } from './fakes/store.ts'
import { DshHarness, waitFor } from './harness/dsh.ts'
import { ACKNOWLEDGEMENT, cards, RESULT, superagentScript } from './harness/script.ts'
import { existsSync } from 'node:fs'

let harness: DshHarness
let dingtalk: FakeDingtalk | undefined
const ALLOWED = 'alice'

beforeAll(async () => { harness = await DshHarness.create({ script: superagentScript(), feishu: true, schedule: true, dingtalk: true }) })
afterEach(context => { if (context.task.result?.state === 'fail') harness.failed = true })
afterAll(async () => { await harness?.teardown(); await dingtalk?.close() })

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
    for (const action of ['retry', 'stop', 'hold', 'release']) expect((await api.request('POST', `tickets/no-such-ticket/${action}`, {})).status).toBe(404)
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
    // An ended Ticket cannot be held or released (docs/003, Hold).
    for (const action of ['hold', 'release']) expect(await harness.api.request('POST', `tickets/${ticketId}/${action}`, {})).toMatchObject({ status: 400, body: { code: 'ticketEnded' } })
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

  it('(f) runs a second GitHub Source for another repository on the same account, checked by setup, and removes it', async () => {
    const docs = 'acme/docs'
    harness.github.edit(world => { world.others = { [docs]: { ...world.repository, full_name: docs } } })
    // An added Source starts off, with the agent CLI of the first, and restarts nothing.
    expect(await harness.api.post('sources', { kind: 'github', id: 'github-docs' })).toMatchObject({ restarting: false })
    const added = (await harness.api.get('settings')).sources.find((source: any) => source.id === 'github-docs')
    expect(added).toMatchObject({ kind: 'github', value: { enabled: false, config: { cli: harness.gh, repository: '' } } })
    const twice = await harness.api.saveBlock('source:github-docs', { enabled: true, config: { repository: harness.repository, cli: harness.gh } })
    expect(twice.status).toBe(400)
    expect(twice.body.setup).toMatchObject({ code: 'repositoryTwice' })
    const saved = await harness.api.saveBlock('source:github-docs', { enabled: true, config: { repository: docs, cli: harness.gh } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject({ restarting: true })
    const state = await waitFor('both repositories to resolve and both Sources to poll', async () => {
      const answer = await harness.api.request<any>('GET', 'state')
      return answer.status === 200 && answer.body.setup.accounts?.repositories?.['github-docs']
        // After the restart each instance's poll loop reports ready on its own first poll, in either order.
        && answer.body.health['github-docs']?.state === 'ready' && answer.body.health.github?.state === 'ready'
        ? answer.body : undefined
    }, 90_000)
    expect(state.setup).toMatchObject({ problem: null, warnings: [],
      accounts: { repository: harness.repository, repositories: { github: harness.repository, 'github-docs': docs }, agent: harness.agent } })
    expect(state.health.github).toMatchObject({ state: 'ready' })
    // Setup read the second repository's push access and review rules, and its poll read that repository's notifications.
    const calls = readLog<{ argv: string[]; unknown?: boolean }>(`${harness.runDir}/fake-github`, 'calls')
    const lines = calls.map(call => call.argv.join(' '))
    expect(lines).toContain(`api repos/${docs} --jq {name: .full_name, push: .permissions.push}`)
    expect(lines).toContain(`api repos/${docs}/rules/branches/main`)
    expect(lines.some(line => line.startsWith(`api repos/${docs}/notifications`))).toBe(true)
    expect(calls.filter(call => call.unknown)).toEqual([])
    const revision = (await harness.api.get('settings')).sources.find((source: any) => source.id === 'github-docs').revision
    expect(await harness.api.post('sources/github-docs/remove', { revision })).toMatchObject({ removed: true, restarting: true })
    await waitFor('the second Source to be gone after the restart', async () => {
      const answer = await harness.api.request<any>('GET', 'state')
      return answer.status === 200 && answer.body.setup.accounts && !answer.body.setup.accounts.repositories['github-docs']
        && answer.body.health.runtime?.state === 'ready' && !answer.body.health['github-docs'] ? true : undefined
    }, 90_000)
    expect((await harness.api.get('settings')).sources.map((source: any) => source.id)).toEqual(['dingtalk', 'feishu', 'github', 'schedule'])
    const status = await harness.status()
    expect(status.code, status.stdout).toBe(0)
  })

  it('(g) refuses the management API without the DeepSeek Harness sign-in, except the health read', async () => {
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

  it('(h) fires a schedule entry once a period: a Trigger on the hit Issue\'s Thread that no person sent, not again after a restart', async () => {
    // An Issue nobody touched for three days, by someone not on the list; Issue 1 was active minutes ago.
    const stale = harness.github.openIssue('carol', 'The install page is out of date', 'Nobody has looked at this.',
      new Date(Date.now() - 3 * 86_400_000).toISOString())
    const searches = () => readLog<{ argv: string[] }>(`${harness.runDir}/fake-github`, 'calls').filter(call => call.argv.includes('search/issues'))
    const entry = { id: 'stale', description: 'Issues nobody took up for two days', every: '30d', query: 'is:issue is:open no:assignee updated:<{now-48h}' }
    const saved = await harness.api.saveBlock('source:schedule', { enabled: true, config: { entries: [entry] } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject({ restarting: false })
    // The Source looks for due entries once a minute.
    const detail = await waitFor('the schedule Trigger on the stale Issue\'s Thread', async () => {
      const answer = await harness.api.request<any>('GET', `threads/${encodeURIComponent(thread(stale.number))}`)
      return answer.status === 200 && answer.body.timeline.some((item: any) => item.source === 'schedule') ? answer.body : undefined
    }, 120_000, 1000)
    debug('thread-after-schedule', detail)
    const trigger = detail.timeline.find((item: any) => item.source === 'schedule')
    expect(trigger).toMatchObject({ human: false, url: stale.html_url, threads: [thread(stale.number)] })
    expect(trigger.text).toContain('Issues nobody took up for two days')
    expect(JSON.stringify(trigger.actor)).toContain('stale')
    // The search ran through the agent's gh, limited to the repository, and found only the stale Issue.
    const [search] = searches()
    expect(search!.argv.slice(0, 4)).toEqual(['api', '-X', 'GET', 'search/issues'])
    expect(search!.argv.find(arg => arg.startsWith('q='))).toMatch(new RegExp(`^q=is:issue is:open no:assignee updated:<\\S+Z repo:${harness.repository}$`))
    expect((await harness.api.get(`threads/${encodeURIComponent(thread(issueNumber))}`)).timeline.some((item: any) => item.source === 'schedule')).toBe(false)
    // The entry is not on the Policy's list, so its hit is ignored without a candidate for the main Session.
    const decided = await waitFor('the Decision on the hit', async () => (await harness.api.get(`threads/${encodeURIComponent(thread(stale.number))}`))
      .decisions.find((decision: any) => decision.triggerIds.includes(trigger.id)), 30_000)
    expect(decided).toMatchObject({ kind: 'ignore' })
    expect(harness.llm.byRole('main').flatMap(item => cards(item.latest)).some(card => card.trigger_id === trigger.id)).toBe(false)
    const fired = await waitFor('the schedule Source to report the period', async () => {
      const health = (await harness.api.get('state')).health.schedule
      return health?.state === 'ready' && health.detail.includes('1 fired this period with 1 hits') ? health : undefined
    }, 60_000)
    expect(fired.detail).toContain('1 entries')

    // A restart in the same period finds the period recorded and searches nothing.
    const restarted = await harness.restart()
    expect(restarted.code, restarted.stdout + restarted.stderr).toBe(0)
    const after = await waitFor('the schedule Source after the restart', async () => {
      const answer = await harness.api.request<any>('GET', 'state')
      const health = answer.status === 200 ? answer.body.health.schedule : undefined
      return health?.state === 'ready' && Date.parse(health.at) > Date.parse(fired.at) ? health : undefined
    }, 120_000)
    expect(after.detail).toContain('1 fired this period with 1 hits')
    expect(searches()).toHaveLength(1)
    const timeline = (await harness.api.get(`threads/${encodeURIComponent(thread(stale.number))}`)).timeline
    expect(timeline.filter((item: any) => item.source === 'schedule')).toHaveLength(1)
    expect(readLog<{ argv: string[]; unknown?: boolean }>(`${harness.runDir}/fake-github`, 'calls').filter(call => call.unknown)).toEqual([])
    const status = await harness.status()
    expect(status.code, status.stdout).toBe(0)
  })

  it('(i) sets up the DingTalk Source over Stream mode, and carries a mention of the robot to replies in the group', async () => {
    dingtalk = await new FakeDingtalk().start()
    // docs/006 DingTalk robot: the app's credentials in a file only its owner may read; the settings name only the file.
    const credentials = join(harness.home, 'dingtalk-app.json')
    writeFileSync(credentials, JSON.stringify(FAKE_APP), { mode: 0o644 })
    const group = 'cidE2EgroupA1'
    const config = { credentials, endpoint: dingtalk.origin, chats: [{ conversationId: group, name: 'E2E group', listen: 'mentions' }],
      directMessages: true, otherChats: 'none', threadMinutes: 30 }
    const exposed = await harness.api.saveBlock('source:dingtalk', { enabled: true, config })
    expect(exposed.status).toBe(400)
    expect(exposed.body.setup).toMatchObject({ place: 'dingtalk', code: 'dingtalkCredentialsExposed' })
    chmodSync(credentials, 0o600)
    const saved = await harness.api.saveBlock('source:dingtalk', { enabled: true, config })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject({ restarting: true })
    const state = await waitFor('the DingTalk app to resolve and its Stream mode connection to be ready', async () => {
      const answer = await harness.api.request<any>('GET', 'state')
      return answer.status === 200 && answer.body.setup.accounts?.dingtalk && answer.body.health.dingtalk?.state === 'ready' ? answer.body : undefined
    }, 90_000)
    expect(state.setup).toMatchObject({ problem: null, dingtalkProblem: null, accounts: { dingtalk: { verified: true } } })
    // Neither the settings nor the state carry the secret.
    expect(JSON.stringify(await harness.api.get('settings'))).not.toContain(FAKE_APP.appSecret)
    expect(JSON.stringify(state)).not.toContain(FAKE_APP.appSecret)
    expect(dingtalk.calls.map(call => call.path)).toEqual(expect.arrayContaining(['/v1.0/oauth2/accessToken', '/v1.0/gateway/connections/open']))
    expect(dingtalk.live(), 'an open Stream mode connection').toBeDefined()

    // The staff ID of the person who asks is on the Policy's DingTalk list.
    const policy = (await harness.api.get('settings')).blocks.policy
    const staffId = 'e2e-alice'
    const value = { ...policy.value, sources: { ...policy.value.sources, dingtalk: { allowed: [{ id: staffId, name: 'Alice' }] } } }
    expect(await harness.api.put('settings/policy', { value, revision: policy.revision })).toMatchObject({ saved: expect.anything(), restarting: false })

    // A mention of the robot in the group arrives over the connection, becomes a Trigger on a new Thread, and is acknowledged.
    const msgId = 'msgE2Ementionaaaa1'
    const frame = dingtalk.push({ msgId, conversationId: group, conversationType: '2', conversationTitle: 'E2E group', msgtype: 'text',
      createAt: Date.now(), senderId: '$:LWCP_v1:$e2ealice', senderStaffId: staffId, senderNick: 'Alice', isAdmin: false, isInAtList: true,
      chatbotUserId: '$:LWCP_v1:$e2ebot', robotCode: FAKE_APP.appKey, text: { content: ' please fix the typo "widgts" in README.md' } })
    const key = `dingtalk:${group}:${msgId}`
    const detail = await waitFor('the DingTalk Trigger on its Thread', async () => {
      const answer = await harness.api.request<any>('GET', `threads/${encodeURIComponent(key)}`)
      return answer.status === 200 && answer.body.timeline.some((item: any) => item.source === 'dingtalk') ? answer.body : undefined
    }, 30_000, 500)
    debug('thread-after-dingtalk', detail)
    const trigger = detail.timeline.find((item: any) => item.source === 'dingtalk')
    expect(trigger).toMatchObject({ human: true, threads: [key] })
    expect(trigger.text).toContain('widgts')
    expect(JSON.stringify(trigger.actor)).toContain(staffId)
    expect(await waitFor('the acknowledgement of the frame', () => dingtalk!.acks.find(ack => ack.messageId === frame), 10_000)).toMatchObject({ code: 200 })

    // The main Session accepts; the acknowledgement and the result go to the group as the robot, addressed to Alice.
    const card = await waitFor('the DingTalk candidate', () => harness.llm.byRole('main').flatMap(item => cards(item.latest))
      .find(item => item.trigger_id === trigger.id), 60_000)
    expect(card).toMatchObject({ kind: 'candidate', strength: 'explicit', thread: key })
    const sent = await waitFor('the acknowledgement and the result in the group', () => {
      const sends = dingtalk!.sends()
      return sends.length >= 2 ? sends : undefined
    }, 240_000, 1000)
    debug('dingtalk-sends', sent)
    const texts = sent.map(call => JSON.parse(String(call.body.msgParam)).text as string)
    expect(sent.map(call => call.path)).toEqual(['/v1.0/robot/groupMessages/send', '/v1.0/robot/groupMessages/send'])
    expect(sent[0]!.body).toMatchObject({ robotCode: FAKE_APP.appKey, openConversationId: group, msgKey: 'sampleMarkdown' })
    expect(texts[0]).toContain(ACKNOWLEDGEMENT)
    expect(texts[1]).toContain(RESULT)
    for (const text of texts) expect(text.startsWith('@Alice ')).toBe(true)
    const status = await harness.status()
    expect(status.code, status.stdout).toBe(0)
  })
})

let issueNumber = 0
let triggerId = ''
const thread = (number: number) => `github:${number}`
const writes = () => readLog<{ kind: string; number: number; body: string }>(`${harness.runDir}/fake-github`, 'writes')
/** Writes a view to the run directory, kept on failure, for diagnosis. */
const debug = (name: string, value: unknown) => writeFileSync(join(harness.runDir, `${name}.json`), JSON.stringify(value, null, 2))
