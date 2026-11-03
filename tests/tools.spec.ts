/** Session tool registration, role-scoped resource reads, and routing/settings tool contracts. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TICKET_STATES } from '../src/app/cards.ts'
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { UserError, ticketStage, type Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { RESOURCES } from '../src/app/resources.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { IM_WORDS, NOTE_WORDS } from '../src/infra/text.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')
const read = (resource: string, page: { offset?: number; limit?: number } = {}) =>
  h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, ...page })

it('reads the lists, a ticket, a decision, the settings, the prompts and the models as resources', async () => {
  const { ticket, trigger } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.acceptedTicket(feishu('2', '@bot 再修一个'))
  const tickets = await read('tickets', { limit: 1 })
  expect(tickets).toEqual({ items: [expect.objectContaining({ ticket_id: expect.any(String), state: 'working' })], next_offset: 1 })
  expect(await read('tickets', { offset: 1 })).toMatchObject({ items: [expect.objectContaining({ ticket_id: ticket.id })], next_offset: null })
  const triggers = await read('triggers') as { items: { trigger_id: string }[] }
  expect(triggers.items.map(item => item.trigger_id)).toEqual([expect.any(String), trigger.id])
  expect(await read('threads')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ tickets: [ticket.id] })]) })
  const decisions = await read('decisions') as { items: { decision_id: string; read: string }[] }
  const accepted = expect.objectContaining({ kind: 'accept', ticket_id: ticket.id, trigger_ids: [trigger.id], read: expect.stringMatching(/^decision\//) })
  expect(decisions.items).toContainEqual(accepted)
  expect(await read(decisions.items.at(-1)!.read)).toMatchObject({ kind: 'accept', ticket_id: ticket.id, mandate: { strength: 'explicit' } })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ ticket_id: ticket.id, state: 'working', directory: ticket.execution!.directory,
    trigger_id: trigger.id, assignments: { items: [expect.objectContaining({ state: 'running' })] }, assignment: `ticket/${ticket.id}/assignment` })
  // The settings name each block's revision and hold the small blocks; a block reads whole by the name a save takes.
  const settings = await read('settings')
  expect(settings).toMatchObject({ eval: { value: { mode: 'auto' } }, policy: { revision: expect.any(Number), allowed: { feishu: 1, github: 1 }, read: 'settings/policy' },
    pause: { value: { paused: false } }, sources: expect.arrayContaining([expect.objectContaining({ id: 'github', read: 'settings/source:github' })]) })
  expect(JSON.stringify(settings)).not.toContain('ou_alice')
  for (const block of ['policy', 'eval', 'executor', 'pause', 'source:github']) {
    const page = await read(`settings/${block}`) as { text: string }
    expect(JSON.parse(page.text)).toEqual({ block, revision: h.runtime.store.blockRevision(block as 'policy'), value: h.runtime.settings.block(block).value })
  }
  expect(JSON.parse((await read('settings/policy') as { text: string }).text).value.sources.feishu.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }])
  await expect(read('settings/source:retired')).rejects.toThrow('Unknown settings block')
  const skills = { built_in: ['dsh-superagent-feishu', 'dsh-superagent-github'], team: [] }
  expect(await read('prompts')).toMatchObject({ revision: 0, read: 'prompts/0', skills, items: [expect.objectContaining({ revision: 0 })], next_offset: null })
  const models = [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }]
  const catalog = { default: { provider: 'p', model: 'm1' }, groups: [{ id: 'p', name: 'Provider', models }], failures: [] }
  Object.assign(h.controller, { modelCatalog: vi.fn(async () => catalog) })
  expect(await read('models')).toMatchObject({ providers: [{ id: 'p', count: 2, read: 'models/p' }], roles: expect.any(Object) })
  expect(await read('models/p', { limit: 1 })).toEqual({ items: [models[0]], next_offset: 1 })
  await expect(read('ticket')).rejects.toThrow('Unknown context resource')
  // A list page holds at most 50 items, the prompt history too.
  const config = h.runtime.prompts.current().config
  for (let revision = 0; revision < 51; revision++) h.runtime.prompts.save({ ...config, scope: `Scope ${revision}.` }, revision, 'panel')
  expect(await read('prompts', { limit: 8000 })).toMatchObject({ items: expect.objectContaining({ length: 50 }), next_offset: 50 })
})

it('lists in prompts the built-in parts whose text changed since the team overrode them, and the built-in parts in prompts/defaults', async () => {
  const read = (resource: string, offset = 0) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource, offset, limit: 8000 })
  expect(await read('prompts')).not.toHaveProperty('default_changed')
  // An override edited from the built-in text of an earlier version.
  h.runtime.prompts.save({ ...defaultPrompts(), overrides: { 'runtime/dispatch': { text: '## dispatch\nOurs.', base: 'earlier' } } }, 0, 'panel')
  expect(await read('prompts')).toMatchObject({ default_changed: ['runtime/dispatch'] })
  // A text page at a time, which the whole text joins.
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read('prompts/defaults', offset) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  const defaults = JSON.parse(text) as { parts: Record<string, string> }
  expect(defaults.parts).toEqual(Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text])))
})

it('saves with the prompt save tool an override without its base, refuses a part no version has, and drops a removed one read back', async () => {
  const save = (overrides: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_prompts_save',
    { config: { ...defaultPrompts(), overrides }, baseRevision: h.runtime.prompts.current().revision })
  await expect(save({ constructor: { text: 'x' } })).rejects.toThrow(new UserError('unknownPromptPart', { part: 'constructor' }))
  await save({ 'runtime/dispatch': { text: '## dispatch\nOurs.' } })
  const dispatch = { text: '## dispatch\nOurs.', base: builtInBase(builtInParts()['runtime/dispatch'].text) }
  expect(h.runtime.prompts.current().config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // The saved version overrides a part this version no longer has: saving back the configuration as read drops it.
  const { revision } = h.runtime.prompts.current(), read = { ...defaultPrompts(), overrides: { 'runtime/dispatch': dispatch,
    'runtime/retired': { text: 'Old.', base: 'b' } } }
  h.runtime.store.set(KV.prompts.version(revision + 1), { revision: revision + 1, previousRevision: revision, savedAt: '', source: 'panel', config: read })
  h.runtime.store.set(KV.prompts.revision, revision + 1)
  await h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config: read, baseRevision: revision + 1 })
  expect(h.runtime.prompts.current().config.overrides).toEqual({ 'runtime/dispatch': dispatch })
  // The tool describes the overrides once, in its schema.
  const tool = h.tools.get(h.runtime.masterId)!.get('orchestrator_prompts_save') as unknown as { description: string }
  expect(tool.description).not.toContain('overrides')
})

it('keeps the main Session\'s resources from an Executor Session, which lists only its own', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  for (const resource of ['tickets', 'triggers', 'threads', 'decisions', 'settings', 'prompts', 'models']) {
    await expect(h.runTool(sessionId, 'orchestrator_read', { resource })).rejects.toThrow('belongs to the main Session')
  }
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}` })).toMatchObject({ ticket_id: ticket.id })
  type Registered = { description: string; parameters: { properties: { resource: { description: string } } } }
  const registered = h.tools.get(sessionId)!.get('orchestrator_read') as unknown as Registered
  const offered = registered.description + registered.parameters.properties.resource.description
  for (const { name, executor } of RESOURCES) expect(offered.includes(`${name}:`), name).toBe(!!executor)
  // The Source kinds' originals follow the host's own, for both roles.
  for (const { name } of h.runtime.sources.resourceNames()) expect(offered.includes(`${name}:`), name).toBe(true)
  expect(h.runtime.sources.resourceNames().map(({ name }) => name)).toEqual(['feishu/<trigger-id>/…', 'github/…'])
  expect(offered).not.toMatch(/preview/i)
})

it('answers every routing tool in one shape: the decision it recorded, why, and the ticket card', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const card = expect.objectContaining({ ticket_id: ticket.id })
  const run = (name: string, args: unknown) => h.runTool(h.runtime.masterId, name, args)
  const route = async (item: Record<string, unknown>) => ((await run('orchestrator_route', { decisions: [item] })).results as unknown[])[0]
  const other = feishu('3', '@bot 顺便看看这个')
  h.runtime.receive(other); await h.runtime.idle()
  expect(await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })).toEqual({ trigger_id: other.id, kind: 'attach',
    reason: expect.any(String), ticket: card })
  const status = await run('orchestrator_ticket_request_status', { ticket_id: ticket.id })
  expect(status).toEqual({ reason: 'The worker is not waiting; nothing was sent', ticket: card })
  await h.runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'The build broke.' })
  expect(await run('orchestrator_ticket_retry', { ticket_id: ticket.id })).toEqual({ reason: 'Started a new assignment', ticket: card })
  const chatter = feishu('4', '@bot 谢谢')
  h.runtime.receive(chatter); await h.runtime.idle()
  expect(await route({ kind: 'ignore', trigger_id: chatter.id, reason: 'thanks' })).toEqual({ trigger_id: chatter.id, kind: 'ignore', decision: 'ignore',
    reason: 'thanks' })
  // A stop needs the person's stop message, which the gate judges; the ticket keeps the reason given.
  await expect(run('orchestrator_route', { decisions: [{ kind: 'stop', ticket_id: ticket.id, reason: 'Not needed after all' }] })).rejects.toThrow()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  const request = feishu('5', '@bot 不用修了')
  h.runtime.receive(request); await h.runtime.idle()
  const stopped = await route({ kind: 'stop', ticket_id: ticket.id, trigger_id: request.id, reason: 'Not needed after all' }) as { ticket: { state: string } }
  const ended = expect.objectContaining({ by: 'human', reason: 'Not needed after all' })
  expect(stopped).toEqual({ trigger_id: request.id, kind: 'stop', decision: 'stop', reason: 'Not needed after all',
    ticket: expect.objectContaining({ ticket_id: ticket.id, state: 'stopped', ended }) })
  expect(TICKET_STATES).toContain(stopped.ticket.state)
})

it('routes several triggers in one call, in order, and answers a refused or failed item without undoing the others', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thanks = feishu('2', '@bot 谢谢'), request = feishu('3', '@bot 另一个问题'), other = feishu('4', '@bot 顺便看看这个'), more = feishu('6', '@bot 还有这个')
  for (const trigger of [thanks, request, other, more]) h.runtime.receive(trigger)
  await h.runtime.idle()
  // One attach fails unexpectedly, as a busy database would.
  const attach = h.runtime.engine.attach.bind(h.runtime.engine)
  vi.spyOn(h.runtime.engine, 'attach').mockImplementation((ticketId, triggerId, note) => {
    if (triggerId === more.id) throw new Error('database is locked')
    return attach(ticketId, triggerId, note)
  })
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' },
    // A stop without its ticket is refused, alone.
    { kind: 'stop', trigger_id: request.id },
    { kind: 'accept', trigger_id: request.id, title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' },
    { kind: 'attach', trigger_id: other.id, ticket_id: 'no-such-ticket' },
    { kind: 'attach', trigger_id: more.id, ticket_id: ticket.id },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: thanks.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' },
    { trigger_id: request.id, kind: 'stop', refused: 'stop needs ticket_id' },
    expect.objectContaining({ trigger_id: request.id, kind: 'accept', decision: 'accept', ticket: expect.objectContaining({ title: 'Other' }) }),
    { trigger_id: other.id, kind: 'attach', refused: 'Unknown ticket' },
    // An unexpected failure recorded nothing, which the item may be sent again for.
    { trigger_id: more.id, kind: 'attach', refused: 'Not recorded: database is locked; retry this item' },
  ])
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
})

it('refuses alone an item that lacks a field its kind needs or breaks a field\'s limit, naming the field, and ignores unused fields', async () => {
  const triggers = ['2', '3', '4', '5', '6'].map(id => feishu(id, `@bot 请求 ${id}`))
  for (const trigger of triggers) h.runtime.receive(trigger)
  await h.runtime.idle()
  const [a, b, c, d, e] = triggers.map(trigger => trigger.id) as [string, string, string, string, string]
  const accept = { kind: 'accept', title: 'Fix', acknowledgement: '收到。' }
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { ...accept, trigger_id: a },
    { ...accept, trigger_id: b, worktree_name: 'one-two-three-four-five' },
    { ...accept, trigger_id: c, worktree_name: 'fix-c', note: words(NOTE_WORDS + 1) },
    { ...accept, trigger_id: d, worktree_name: 'fix-d', title: '' },
    // Fields of another kind, null or not, are left unread.
    { kind: 'ignore', trigger_id: e, reason: 'chat', ticket_id: null, title: null, note: null },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: a, kind: 'accept', refused: 'accept needs worktree_name' },
    { trigger_id: b, kind: 'accept', refused: expect.stringMatching(/^worktree_name: /) },
    { trigger_id: c, kind: 'accept', refused: expect.stringMatching(new RegExp(`^note: .*${NOTE_WORDS} words`)) },
    { trigger_id: d, kind: 'accept', refused: 'accept needs title' },
    { trigger_id: e, kind: 'ignore', decision: 'ignore', reason: 'chat' },
  ])
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('decides a candidate\'s batch with its card\'s trigger: a second accept keeps the first, and no other decision contradicts it', async () => {
  await h.runtime.settings.pause(true, 'panel')
  const first = feishu('1', '@bot 首页的标题'), second = feishu('2', '@bot 改成“浏览网页”', { root_id: 'om_1' })
  h.runtime.receive(first); h.runtime.receive(second)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  const accept = { kind: 'accept', worktree_name: 'retitle', acknowledgement: '收到。' }
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { ...accept, trigger_id: first.id, title: 'Retitle' },
    { ...accept, trigger_id: second.id, title: 'Another title' },
    { kind: 'ignore', trigger_id: second.id, reason: 'chat' },
  ] }) as { results: { ticket?: { ticket_id: string } }[] }
  const ticketId = results[0]!.ticket!.ticket_id
  expect(results).toEqual([
    expect.objectContaining({ trigger_id: first.id, decision: 'accept' }),
    expect.objectContaining({ trigger_id: second.id, decision: 'accept', reason: `Already accepted as ${ticketId}; title and acknowledgement unchanged` }),
    { trigger_id: second.id, kind: 'ignore', refused: `Decided in this call with ${first.id}, whose Decision took its batch` },
  ])
  expect(h.runtime.store.tickets.get(ticketId)!.title).toBe('Retitle')
})

it('states each routing field\'s limit in its description, which the schema leaves to the item\'s check', () => {
  type Schema = { parameters: { properties: { decisions: { items: { properties: Record<string, { description?: string }> } } } } }
  const fields = (h.tools.get(h.runtime.masterId)!.get('orchestrator_route') as unknown as Schema).parameters.properties.decisions.items.properties
  const limits: Record<string, string[]> = { title: ['200 characters'], worktree_name: ['kebab-case', '32 characters'],
    acknowledgement: [`${IM_WORDS} words`], note: [`${NOTE_WORDS} words`, 'Never add implementation instructions'], reason: ['500 characters'] }
  for (const [field, phrases] of Object.entries(limits)) for (const phrase of phrases) expect(fields[field]!.description, field).toContain(phrase)
})

it('stops one follow-up for each ticket it reached, in one call', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const two = await h.acceptedTicket(feishu('3', '@bot 另一件事'))
  // The second ticket follows the first's thread too, so a person's stop there reaches both.
  h.runtime.engine.bindThread(two.ticket.id, { source: 'feishu', id: `${CHAT}:om_1` }, false)
  const stop = feishu('7', '都先停一下', { mentions: [], root_id: 'om_1' })
  h.runtime.receive(stop); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'stop', trigger_id: stop.id, ticket_id: one.ticket.id }, { kind: 'stop', trigger_id: stop.id, ticket_id: two.ticket.id }] }) as
    { results: Record<string, unknown>[] }
  expect(results.map(result => result.decision)).toEqual(['stop', 'stop'])
  expect([one, two].map(item => h.runtime.store.tickets.get(item.ticket.id)!.ended?.outcome)).toEqual(['stopped', 'stopped'])
})

it('ignores a proactive candidate from its card beside other decisions, marked so, and leaves accepting one to an assessment', async () => {
  const chat = feishu('2', '中午吃什么', { mentions: [] }), thanks = feishu('3', '@bot 谢谢'), proposal = feishu('4', '把标题改短一点', { mentions: [] })
  for (const trigger of [chat, thanks, proposal]) h.runtime.receive(trigger)
  await h.runtime.pump(); await h.runtime.idle()
  const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [
    { kind: 'ignore', trigger_id: chat.id, reason: 'Lunch chat.' },
    { kind: 'ignore', trigger_id: thanks.id, reason: 'Thanks only.' },
    { kind: 'accept', trigger_id: proposal.id, title: 'Shorter title', worktree_name: 'short-title', acknowledgement: '收到。' },
  ] }) as { results: Record<string, unknown>[] }
  expect(results).toEqual([
    { trigger_id: chat.id, kind: 'ignore', decision: 'ignore', reason: 'Ignored from its card, without a rule assessment; Lunch chat.' },
    { trigger_id: thanks.id, kind: 'ignore', decision: 'ignore', reason: 'Thanks only.' },
    { trigger_id: proposal.id, kind: 'accept', refused: expect.stringContaining('assess proactive candidates with orchestrator_eval') },
  ])
})

it('returns where a reply stands: sent, or dropped when its conversation can no longer receive it', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
  const reply = (text: string) => h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text })
  expect(await reply('修好了。')).toEqual({ status: 'sent' })
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new CliError('the message was withdrawn', 230011))
  expect(await reply('修好了，请看 PR。')).toEqual({ status: 'dropped' })
})

it('checks an acknowledgement against the IM word limit, not a character count', async () => {
  const trigger = feishu('1', '@bot 修一下回归')
  h.runtime.receive(trigger); await h.runtime.idle()
  const accept = (acknowledgement: string) => h.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement })
  await expect(accept(words(IM_WORDS + 1))).rejects.toThrow(`at most ${IM_WORDS} words`)
  expect(await accept(words(IM_WORDS))).toMatchObject({ decision: 'accept', ticket: { title: 'Fix' } })
})

it('saves a settings block by name, a Source\'s block with the Source\'s id', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const github = { config: h.runtime.store.settings().sources.github!.config, revision: h.runtime.store.blockRevision('source:github') }
  const off = { enabled: false, config: github.config }
  await expect(save({ block: 'source', value: off, revision: github.revision })).rejects.toThrow('source names the Source')
  await expect(save({ block: 'source:github', value: off, revision: github.revision })).rejects.toThrow()
  expect(await save({ block: 'source', source: 'github', value: off, revision: github.revision })).toMatchObject({ saved: true })
  expect(h.runtime.store.settings().sources.github?.enabled).toBe(false)
  expect(await save({ block: 'pause', value: { paused: true }, revision: 0 })).toEqual({ paused: true })
})

it('refuses a Policy or accept-mode save from the main Session, which proposes it for a person to accept on the panel instead', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const propose = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_policy_propose', args)
  const { policy, eval: evaluation } = h.runtime.store.settings()
  const rules = policy.rules.map(rule => ({ ...rule, enabled: false })), mode = evaluation.mode === 'auto' ? 'observe' : 'auto'
  // The settings tool no longer takes the Policy block, and refuses a change of the accept mode by its code.
  await expect(save({ block: 'policy', value: { ...policy, rules }, revision: h.runtime.store.blockRevision('policy') })).rejects.toThrow()
  await expect(save({ block: 'eval', value: { ...evaluation, mode }, revision: h.runtime.store.blockRevision('eval') }))
    .rejects.toMatchObject({ code: 'panelOnlyPolicy' })
  expect(h.runtime.store.settings().eval.mode).toBe(evaluation.mode)
  // A proposal changes nothing; the latest one replaces an earlier one.
  expect(await propose({ block: 'eval', value: { ...evaluation, mode }, revision: h.runtime.store.blockRevision('eval'), reason: 'Alice asked for it' }))
    .toEqual({ proposed: true, changed: ['eval.mode'], effect: expect.stringContaining('person') })
  expect(await propose({ block: 'policy', value: { ...policy, rules }, revision: h.runtime.store.blockRevision('policy'), reason: 'Alice asked to pause the rules' }))
    .toMatchObject({ proposed: true, changed: rules.map((_, index) => `policy.rules.${index}.enabled`) })
  expect(h.runtime.store.settings().policy).toEqual(policy)
  expect(h.runtime.settings.proposal()).toMatchObject({ block: 'policy', reason: 'Alice asked to pause the rules', stale: false })
  // A value that changes nothing, or a stale revision, records no proposal.
  expect(await propose({ block: 'policy', value: policy, revision: h.runtime.store.blockRevision('policy'), reason: 'No change' }))
    .toEqual({ proposed: false, changed: [] })
  await expect(propose({ block: 'eval', value: evaluation, revision: h.runtime.store.blockRevision('eval') + 1, reason: 'Stale' })).rejects.toThrow('Settings changed')
  expect(h.runtime.settings.proposal()).toMatchObject({ block: 'policy' })
  // A person accepts it on the panel, which saves it as the panel would.
  expect(await h.runtime.settings.acceptProposal()).toMatchObject({ saved: true, policy_changed: true })
  expect(h.runtime.store.settings().policy.rules.every(rule => !rule.enabled)).toBe(true)
  expect(h.runtime.settings.proposal()).toBeNull()
})

it('previews a prompt configuration without saving it, and saves one only against the revision it edits', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', args)
  const config = { ...h.runtime.prompts.current().config, scope: 'Finish what was asked.' }
  const preview = await save({ config, preview: true }) as { previews: { role: string; read: string }[] }
  expect(preview.previews.map(item => item.role)).toEqual(['orchestrator', 'worker'])
  let text = '', offset: number | null = 0
  while (offset !== null) {
    const page = await read(preview.previews[1]!.read, { offset, limit: 8000 }) as { text: string; next_offset: number | null }
    text += page.text; offset = page.next_offset
  }
  expect(text).toContain('## Ticket scope\nFinish what was asked.')
  expect(h.runtime.prompts.current().revision).toBe(0)
  await expect(save({ config })).rejects.toThrow('baseRevision')
  expect(await save({ config, baseRevision: 0 })).toMatchObject({ revision: 1 })
})

it('releases the tools it registered for a Session once its agent is disposed, and leaves the other Sessions\' tools', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const worker = `worker-${ticket.id}`
  expect(h.tools.get(worker)!.size).toBeGreaterThan(0)
  h.ctx.emit('agent/disposed', { agent: h.agents.get(worker) } as never)
  expect([h.tools.get(worker)!.size, h.tools.get(h.runtime.masterId)!.size > 0]).toEqual([0, true])
  // Releasing again, as at shutdown, finds nothing left of it.
  h.ctx.emit('agent/disposed', { agent: h.agents.get(worker) } as never)
  expect(h.tools.get(worker)!.size).toBe(0)
})

it('reads a thread by the key cards show: its label, tickets, latest decisions and triggers, newest first, also for its own worker', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const key = `feishu:${CHAT}:om_1`
  const threads = await read('threads') as { items: { thread: string; label: string; read: string }[] }
  expect(threads.items[0]).toMatchObject({ thread: key, label: '@bot 修一下回归', read: `thread/${key}` })
  const thread = await read(`thread/${key}`)
  expect(thread).toMatchObject({ thread: key, label: '@bot 修一下回归', tickets: [expect.objectContaining({ ticket_id: ticket.id })],
    decisions: [expect.objectContaining({ kind: 'accept', ticket_id: ticket.id })], items: [expect.objectContaining({ trigger_id: trigger.id, read: `trigger/${trigger.id}` })],
    next_offset: null })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `thread/${key}` })).toMatchObject({ thread: key })
  const elsewhere = feishu('5', '@bot 别的事', { chat_id: 'oc_other' })
  h.runtime.store.triggers.save(elsewhere)
  h.runtime.store.threads.save({ key: `feishu:oc_other:om_5`, ref: { source: 'feishu', id: 'oc_other:om_5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} })
  await expect(h.runTool(sessionId, 'orchestrator_read', { resource: 'thread/feishu:oc_other:om_5' })).rejects.toThrow('Unknown or inaccessible thread')
})

it('reads a ticket with the ids it is tied to, its reports by assignment, and its assignments and inputs a page at a time, each by the name its line gives or by its id', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  const at = (n: number) => `2026-10-05T00:${String(n).padStart(2, '0')}:00.000Z`
  const report = (n: number) => ({ state: 'progress' as const, summary: `Report ${n}: ${'checked the config and the build. '.repeat(46)}`.slice(0, 1500), at: at(n) })
  const assignments = [1, 2, 3, 4, 5, 6, 7].map(n => ({ ...stored.assignments[0]!, id: `a${n}`, state: n < 7 ? 'ended' as const : 'running' as const, report: report(n), createdAt: at(n) }))
  const inputs = Array.from({ length: 24 }, (_, n) => n === 23 ? { id: 'text:long', kind: 'text' as const, text: `Note: ${'check the margin on mobile as well. '.repeat(4)}`, at: at(n) }
    : n % 2 ? { id: `text:${n}`, kind: 'text' as const, text: `Note ${n}: check the margin.`, at: at(n) }
    : { id: `trigger:${n}`, kind: 'trigger' as const, triggerId: `trigger-${n}`, at: at(n) })
  h.runtime.store.tickets.save({ ...stored, assignments, inputs: [...stored.inputs, ...inputs] })
  type Page = { items: { read?: string; report: { read: string } }[]; next_resource?: string; next_offset?: number }
  const details = await read(`ticket/${ticket.id}`) as { inputs: Page; assignments: Page }
  expect(details).toMatchObject({ trigger_id: ticket.origin.triggerId, decision_id: ticket.decisionId, threads: [{ thread: `feishu:${CHAT}:om_1` }],
    inputs: { next_resource: `ticket/${ticket.id}/inputs`, next_offset: 10 }, assignments: { next_resource: `ticket/${ticket.id}/assignments`, next_offset: 3 } })
  expect([details.inputs.items.length, details.assignments.items.length]).toEqual([10, 3])
  // The earlier assignments read on, so a worker reaches every report it continues from.
  const earlier = await read(details.assignments.next_resource!, { offset: details.assignments.next_offset! }) as Page
  expect([earlier.items.map(item => (item as { id?: string }).id), earlier.next_offset]).toEqual([['a4', 'a3', 'a2'], 6])
  expect(await read(details.assignments.next_resource!, { offset: 6 })).toEqual({ next_offset: null,
    items: [expect.objectContaining({ id: 'a1', report: expect.objectContaining({ read: `ticket/${ticket.id}/report/a1` }) })] })
  expect(await h.runTool(sessionId, 'orchestrator_read', { resource: `ticket/${ticket.id}/report/a1` })).toMatchObject({ text: report(1).summary })
  expect(JSON.stringify(details).length).toBeLessThan(3000)
  const page = await read(details.inputs.items[0]!.read!) as { text: string }
  expect(page.text).toContain('check the margin on mobile as well.')
  // An Input also reads by the id it has on the ticket.
  expect(await read(`ticket/${ticket.id}/input/text:long`)).toMatchObject({ text: page.text })
  expect(await read(`ticket/${ticket.id}/inputs`, { offset: 20 })).toMatchObject({ items: expect.objectContaining({ length: 4 }), next_offset: null })
  expect(await read(details.assignments.items[0]!.report.read)).toMatchObject({ text: report(7).summary.slice(0, 4000) })
  vi.mocked(h.controller.inspect).mockResolvedValueOnce({ events: [{ type: 'assistant/message', data: { message: { role: 'assistant',
    content: [{ type: 'text', text: `I fixed the margin. ${'Details. '.repeat(20)}` }] } } }] } as never)
  const transcript = JSON.parse((await read(`ticket/${ticket.id}/transcript`) as { text: string }).text) as { preview: string; read: string }
  expect(transcript).toMatchObject({ preview: expect.stringMatching(/^I fixed the margin\./), read: `ticket/${ticket.id}/message/0` })
  expect(transcript.preview.length).toBeLessThanOrEqual(80)
})

it('reads a trigger once with the message it replies to and the messages around it on its thread, without the CI runs', async () => {
  const at = (minute: number) => `2026-10-06T00:0${minute}:00.000Z`
  const message = (id: string, minute: number, overrides: Record<string, unknown> = {}) => ({ ...feishu(id, `message ${id}`, { root_id: 'om_root', ...overrides }), at: at(minute) })
  const ci = (id: string, minute: number) => ({ ...message(id, minute), source: 'github', human: false, text: '{"check":"build"}', meta: { ci: true } })
  const asked = message('asked', 1), replying = message('reply', 3, { parent_id: 'om_asked' })
  for (const item of [message('root', 0, { root_id: undefined }), asked, ci('ci-1', 2), replying, ci('ci-2', 4), message('later', 5)]) h.runtime.store.triggers.save(item)
  const page = await read(`trigger/${replying.id}`)
  expect(page).toMatchObject({ trigger_id: replying.id, replied_to: { trigger_id: asked.id, read: `trigger/${asked.id}` },
    around: { before: { trigger_id: asked.id }, after: { trigger_id: feishu('later', '').id } }, text: 'message reply' })
  // The page holds the text once, and no pointer to itself.
  expect(page).not.toHaveProperty('preview')
  expect(page).not.toHaveProperty('read')
})

const relaysOf = (kind: string) => h.relays(h.runtime.masterId).filter(item => item.kind === kind)
const notices = () => h.agents.get(h.runtime.masterId)!.inject.mock.calls
  .map(([message]) => JSON.parse(message.content.map(block => block.type === 'text' ? block.text : '').join('')) as Record<string, unknown>)

it('shows a candidate with its thread\'s tickets open first, the tickets it reached, those its text names, and a short next step', async () => {
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const a = first.ticket
  // Requests on its thread reach its worker, which hands back what is not its own; the main Session then routes them.
  const handBack = async (id: string) => {
    await h.runTool(first.sessionId, 'orchestrator_trigger_handback', { trigger_id: id, reason: 'Another change.' })
    await h.runtime.pump(); await h.runtime.idle()
  }
  const second = feishu('2', '@bot 另一个问题', { root_id: 'om_1' })
  h.runtime.receive(second); await h.runtime.idle()
  await handBack(second.id)
  const b = (await h.route({ kind: 'accept', trigger_id: second.id, title: 'Other', worktree_name: 'fix-other', acknowledgement: '收到。' })).ticket as
    { ticket_id: string }
  h.runtime.engine.stopTicket(b.ticket_id)
  // A follow-up reaches the live ticket without an Eval; handed back, its candidate shows where it went.
  const more = feishu('3', '@bot 还有按钮', { root_id: 'om_1' })
  h.runtime.receive(more); await h.runtime.idle()
  await handBack(more.id)
  const followup = relaysOf('candidate').at(-1)!
  expect((followup.related_tickets as { ticket_id: string }[]).map(card => card.ticket_id)).toEqual([a.id, b.ticket_id])
  expect(followup).toMatchObject({ tickets_total: 2, delivered_to: [a.id], thread: `feishu:${CHAT}:om_1` })
  expect(String(followup.next_action).length).toBeLessThanOrEqual(100)
  // A message elsewhere that names a pull request reads the tickets that follow it.
  const thread = { key: 'github:123', ref: { source: 'github', id: '123' }, createdAt: '', subscriptions: [a.id], correlated: [], pending: [], meta: {} }
  h.runtime.store.threads.save(thread)
  h.runtime.receive(feishu('4', '@bot 看看 #123 的进展')); await h.runtime.idle()
  expect(relaysOf('candidate').at(-1)).toMatchObject({ related_tickets: [], tickets_total: 0, referenced_tickets: [{ ticket_id: a.id }] })
  expect(relaysOf('candidate').at(-1)).not.toHaveProperty('correlated_threads')
  // A Thread correlated with the candidate's shows for reference, with its label, link and the ticket on it.
  h.runtime.store.threads.save({ ...thread, meta: { label: 'PR 123', url: 'https://github.com/acme/widgets/pull/123' } })
  h.runtime.store.threads.save({ key: `feishu:${CHAT}:om_5`, ref: { source: 'feishu', id: `${CHAT}:om_5` }, createdAt: '', subscriptions: [],
    correlated: ['github:123'], pending: [], meta: {} })
  h.runtime.receive(feishu('5', '@bot 这个也看看')); await h.runtime.idle()
  expect(relaysOf('candidate').at(-1)!.correlated_threads).toEqual([{ thread: 'github:123', label: 'PR 123',
    url: 'https://github.com/acme/widgets/pull/123', ticket: { ticket_id: a.id, title: expect.any(String), state: expect.any(String) },
    read: 'thread/github:123' }])
})

it('relays a worker\'s report with its ticket card and the start of its summary, and a question with the card alone', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Needs a decision.', human_action: 'Desktop too?' })
  await h.runtime.idle()
  expect(relaysOf('worker_attention').at(-1)).toEqual({ kind: 'worker_attention', state: 'progress', read: `ticket/${ticket.id}/result`,
    ticket: expect.objectContaining({ ticket_id: ticket.id, state: 'person/answer', attention: expect.objectContaining({ question: 'Desktop too?' }) }) })
  const summary = 'Done. ' + 'Evidence. '.repeat(100)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary, human_action: null })
  await h.runtime.idle()
  const report = relaysOf('worker_report').at(-1)!
  expect(report).toMatchObject({ ticket: { ticket_id: ticket.id, title: ticket.title }, trigger_id: trigger.id, state: 'ready', chars: summary.length,
    read: `ticket/${ticket.id}/result` })
  expect(String(report.summary)).toBe(summary.slice(0, 600))
  expect(report.ticket).not.toHaveProperty('preview')
  // The end of the ticket, which the ready report brought, comes with its card.
  expect(notices().at(-1)).toMatchObject({ ticket_ended: { ticket_id: ticket.id, state: 'completed' } })
})

it('tells the main Session of the settings, prompts, requeues and unsubscriptions others made, never of its own', async () => {
  const save = (args: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', args)
  const evaluation = h.runtime.store.settings().eval
  await h.runtime.settings.save('eval', { ...evaluation, mode: 'observe' }, h.runtime.store.blockRevision('eval'), 'panel')
  await h.runtime.idle()
  expect(notices().at(-1)).toEqual({ settings_saved: 'eval', changed: ['eval.mode'], read: 'settings/eval' })
  const before = notices().length
  expect(await save({ block: 'eval', value: { ...evaluation, mode: 'observe', timeoutSeconds: 90 }, revision: h.runtime.store.blockRevision('eval') })).not.toHaveProperty('context_delivery')
  const config = { ...h.runtime.prompts.current().config, scope: 'Finish what was asked.' }
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config, baseRevision: 0 })).not.toHaveProperty('context_delivery')
  await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const thanks = feishu('5', '@bot 谢谢')
  h.runtime.receive(thanks); await h.runtime.idle()
  await h.route({ kind: 'ignore', trigger_id: thanks.id, reason: 'thanks' })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_trigger_requeue', { trigger_id: thanks.id })).toEqual({ queued: true })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_thread_unsubscribe', { thread: `feishu:${CHAT}:om_1` })).toEqual({ removed: true, thread: `feishu:${CHAT}:om_1` })
  await h.runtime.idle()
  expect(notices().slice(before).filter(notice => !('ticket_ended' in notice))).toEqual([])
})

it('answers a policy sync with the counts and what changed, not the whole list', async () => {
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_bob', name: 'Bob' }], has_more: false })
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_policy_sync', { source: 'feishu' })).toEqual({ source: 'feishu', allowed: 2, added: ['Bob'], removed: [] })
})

it('shows an Executor Session no id it cannot read: no Decision, no other ticket, no Trigger its ticket did not reach', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const another = feishu('2', '@bot 再修一个', { root_id: 'om_1' })
  h.runtime.receive(another); await h.runtime.idle()
  await h.runTool(sessionId, 'orchestrator_trigger_handback', { trigger_id: another.id, reason: 'Another fix.' })
  const other = await h.acceptedTicket(another)
  const worker = (resource: string) => h.runTool(sessionId, 'orchestrator_read', { resource })
  const thread = await worker(`thread/feishu:${CHAT}:om_1`)
  expect(thread).not.toHaveProperty('tickets')
  expect(thread).not.toHaveProperty('decisions')
  for (const page of [thread, await worker(`ticket/${ticket.id}`), await worker(`trigger/${trigger.id}`)]) {
    const shown = JSON.stringify(page)
    expect(shown).not.toContain(ticket.decisionId)
    expect(shown).not.toContain(other.ticket.id)
  }
  expect(await read(`thread/feishu:${CHAT}:om_1`)).toMatchObject({ tickets: expect.arrayContaining([expect.objectContaining({ ticket_id: other.ticket.id })]),
    decisions: expect.arrayContaining([expect.objectContaining({ decision_id: ticket.decisionId })]) })
  expect(await read(`ticket/${ticket.id}`)).toMatchObject({ decision_id: ticket.decisionId })
})

it('marks the threads a worker follows for context apart from those a Source bound its ticket to', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '12' }, true)
  await h.runTool(sessionId, 'orchestrator_thread_follow', { thread: 'github:9', reason: 'The Issue it fixes.' })
  const { threads } = await read(`ticket/${ticket.id}`) as { threads: { thread: string }[] }
  expect(threads).toEqual(expect.arrayContaining([{ thread: `feishu:${CHAT}:om_1` }, { thread: 'github:12', bound: true }, { thread: 'github:9', context: true }]))
  expect(threads).toHaveLength(3)
})

it('gives a worker the other messages of the request its ticket was accepted from, in its first message and on its ticket', async () => {
  // Pause while receiving two messages so they are evaluated as a single batch.
  await h.runtime.settings.pause(true, 'panel')
  const first = feishu('1', '@bot 首页的标题'), second = feishu('2', '@bot 改成“浏览网页”', { root_id: 'om_1' })
  await h.runtime.receive(first); await h.runtime.receive(second)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.idle()
  const accepted = await h.route({ kind: 'accept', trigger_id: second.id, title: 'Retitle', worktree_name: 'retitle', acknowledgement: '收到。' })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  const other = ticket.origin.triggerIds.find(id => id !== ticket.origin.triggerId)!
  expect(ticket.origin.triggerIds).toHaveLength(2)
  const message = h.relays(`worker-${ticket.id}`)[0]!
  expect(message.batch).toEqual([expect.objectContaining({ trigger_id: other, preview: expect.any(String), read: `trigger/${other}` })])
  const page = await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}` })
  expect(page).toMatchObject({ batch: [{ trigger_id: other, read: `trigger/${other}` }] })
  expect(await h.runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `trigger/${other}` })).toMatchObject({ trigger_id: other })
})

describe('orchestrator_merge_request', () => {
  const MERGE = '/usr/local/bin/gh-merge'
  /** The ticket's branch, named after its short name. */
  let branch = ''
  /** GitHub as the agent's gh reads it: PR 42 from the ticket's branch, its CI, its reviews and the trees of its commits. */
  function github(overrides: { pull?: Record<string, unknown>; checks?: unknown[]; statuses?: unknown[]; reviews?: unknown[]; trees?: Record<string, string> } = {}) {
    const pull = { number: 42, state: 'open', draft: false, additions: 120, deletions: 30, html_url: 'https://github.com/acme/widgets/pull/42',
      user: { login: 'agent-bot' }, head: { sha: 'head2', ref: branch, repo: { full_name: 'acme/widgets' } }, ...overrides.pull }
    const trees: Record<string, string> = { head2: 'tree2', head1: 'tree1', ...overrides.trees }
    const answers: Record<string, unknown> = {
      'repos/acme/widgets/pulls/42': pull,
      'repos/acme/widgets/commits/head2/check-runs?per_page=100': [{ check_runs: overrides.checks ?? [{ name: 'test', status: 'completed', conclusion: 'success' }] }],
      'repos/acme/widgets/commits/head2/statuses?per_page=100': [overrides.statuses ?? []],
      'repos/acme/widgets/pulls/42/reviews?per_page=100': [overrides.reviews ?? [{ user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: 'head2' }]],
      ...Object.fromEntries(Object.entries(trees).map(([sha, tree]) => [`repos/acme/widgets/git/commits/${sha}`, { tree: { sha: tree } }])),
    }
    vi.mocked(Commands.prototype.gh).mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' }
      : args[1]! in answers ? answers[args[1]!] : { default_branch: 'master', permissions: { push: true } })
  }
  /** The merge CLI, signed in to `merger`; every other program answers as the fixture does. */
  function mergeCli(merger = 'merger') {
    vi.mocked(Commands.prototype.run).mockImplementation(async (program, args) => program !== MERGE ? '{"ok":true,"data":{}}'
      : args[0] === 'api' ? `${merger}\n` : '')
    return () => vi.mocked(Commands.prototype.run).mock.calls.filter(([program, args]) => program === MERGE && args[0] === 'pr')
  }
  const configure = (merge: Record<string, unknown>) => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, merge: { ...settings.executor.merge, ...merge } } })
  }
  /** A ticket whose worker reported PR 42, opened from its branch, so the ticket follows it as its own. */
  async function ticketWithPull() {
    const { sessionId, ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
    branch = `agent/${ticket.execution!.name}`
    github()
    await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 })
    return sessionId
  }
  const request = (sessionId: string, pull = 42) => h.runTool(sessionId, 'orchestrator_merge_request', { pull })

  it('refuses without a merge CLI, so people merge, and for a PR the ticket did not open, without reading GitHub', async () => {
    const sessionId = await ticketWithPull()
    const runs = mergeCli()
    vi.mocked(Commands.prototype.gh).mockClear()
    expect(await request(sessionId)).toEqual({ auto_merge: 'refused', pull: 42, next: 'A person merges this PR; say so in your report.',
      refused: [{ check: 'merge_cli', detail: expect.stringContaining('No merge CLI is set') }] })
    configure({ cli: MERGE })
    expect(await request(sessionId, 7)).toMatchObject({ auto_merge: 'refused', refused: [{ check: 'ticket_pull', detail: expect.stringContaining('#7') }] })
    expect(Commands.prototype.gh).not.toHaveBeenCalled()
    expect(runs()).toEqual([])
  })

  it('enables auto-merge as the merge account for the head commit it checked once every check passes', async () => {
    const sessionId = await ticketWithPull()
    const runs = mergeCli()
    configure({ cli: MERGE, method: 'merge', maxLines: 150 })
    expect(await request(sessionId)).toEqual({ auto_merge: 'enabled', pull: 42, head: 'head2', method: 'merge' })
    expect(runs()).toEqual([[MERGE, ['pr', 'merge', '42', '--auto', '--merge', '--match-head-commit', 'head2', '--repo', 'acme/widgets']]])
  })

  it('lists every failed check: a draft, failing CI, too many lines, approvals that miss the head, requested changes and the agent as merger', async () => {
    const sessionId = await ticketWithPull()
    const runs = mergeCli('Agent-Bot')
    configure({ cli: MERGE, requireApprovals: 2 })
    github({ pull: { draft: true, additions: 180, deletions: 21 }, checks: [{ name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'test', status: 'in_progress', conclusion: null }], reviews: [
      // The agent's own approval, a bot's, and one of an earlier commit with another tree count for nothing.
      { user: { login: 'agent-bot', type: 'User' }, state: 'APPROVED', commit_id: 'head2' },
      { user: { login: 'review[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: 'head2' },
      { user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: 'head1' },
      { user: { login: 'carol', type: 'User' }, state: 'APPROVED', commit_id: 'head2' },
      // Carol's later request for changes replaces her approval; Dave's comment decides nothing.
      { user: { login: 'carol', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: 'head2' },
      { user: { login: 'dave', type: 'User' }, state: 'COMMENTED', commit_id: 'head2' }] })
    const result = await request(sessionId) as { auto_merge: string; refused: { check: string; detail: string }[]; next: string }
    expect(result.auto_merge).toBe('refused')
    expect(result.refused).toEqual([
      { check: 'ready', detail: expect.stringContaining('draft') },
      { check: 'size', detail: expect.stringContaining('201 lines') },
      { check: 'ci', detail: 'CI failed on head2: lint' },
      { check: 'changes_requested', detail: expect.stringContaining('carol') },
      { check: 'approvals', detail: '0 of the 2 approvals required cover the head commit head2' },
      { check: 'merge_account', detail: 'The merge CLI is signed in to the agent account @agent-bot' }])
    expect(result.next).toBe('A person merges this PR; say so in your report.')
    expect(runs()).toEqual([])
  })

  it('counts an approval of an earlier commit with the same tree, drops a dismissed request, and waits for running CI', async () => {
    const sessionId = await ticketWithPull()
    const runs = mergeCli()
    configure({ cli: MERGE })
    github({ trees: { head1: 'tree2' }, statuses: [{ context: 'deploy', state: 'pending' }], reviews: [
      { user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: 'head1' },
      { user: { login: 'carol', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: 'head1' },
      { user: { login: 'carol', type: 'User' }, state: 'DISMISSED', commit_id: 'head1' }] })
    expect(await request(sessionId)).toEqual({ auto_merge: 'refused', pull: 42, refused: [{ check: 'ci', detail: 'CI is still running on head2: deploy' }],
      next: expect.stringContaining('call again') })
    github({ trees: { head1: 'tree2' }, reviews: [{ user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: 'head1' }] })
    expect(await request(sessionId)).toMatchObject({ auto_merge: 'enabled', head: 'head2', method: 'squash' })
    expect(runs()).toHaveLength(1)
  })

  it('refuses a merged PR, and answers an ended ticket that it ended', async () => {
    const sessionId = await ticketWithPull()
    mergeCli()
    configure({ cli: MERGE })
    github({ pull: { state: 'closed', merged: true } })
    expect(await request(sessionId)).toMatchObject({ refused: expect.arrayContaining([{ check: 'open', detail: 'PR #42 is merged' }]) })
    h.runtime.engine.stopTicket(h.runtime.store.tickets.list()[0]!.id)
    await expect(request(sessionId)).rejects.toThrow('Ticket ended')
  })

  it('leaves the merge settings to the management panel: the main Session cannot name a merge CLI or loosen a condition', async () => {
    const save = (merge: Record<string, unknown>) => h.runTool(h.runtime.masterId, 'orchestrator_settings_save', { block: 'executor',
      value: { ...h.runtime.store.settings().executor, merge: { ...h.runtime.store.settings().executor.merge, ...merge } },
      revision: h.runtime.store.blockRevision('executor') })
    await expect(save({ cli: MERGE })).rejects.toThrow(new UserError('panelOnlyEnvironment'))
    await expect(save({ maxLines: 5000 })).rejects.toThrow(new UserError('panelOnlyEnvironment'))
    await expect(h.runtime.settings.save('executor', { ...h.runtime.store.settings().executor, merge: { cli: 'bin/gh-merge' } },
      h.runtime.store.blockRevision('executor'), 'panel')).rejects.toThrow('A command name or an absolute path')
    // A panel save checks a changed merge CLI first, as setup probes CLIs: it must run and read an account other than the agent's.
    const panel = (merge: Record<string, unknown>) => h.runtime.settings.save('executor', { ...h.runtime.store.settings().executor, merge },
      h.runtime.store.blockRevision('executor'), 'panel')
    await expect(panel({ cli: MERGE })).rejects.toThrow(`The merge CLI ${MERGE} cannot read its account`)
    const cli = join(h.directory, 'gh-merge')
    writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    h.answers[`${cli} api user --jq .login`] = 'Agent-Bot\n'
    await expect(panel({ cli })).rejects.toThrow(new UserError('mergeCliAgent', { cli, account: 'agent-bot' }))
    h.answers[`${cli} api user --jq .login`] = 'merger\n'
    expect(await panel({ cli, maxLines: 80 })).toMatchObject({ saved: true, restarting: false })
    expect(h.runtime.store.settings().executor.merge).toEqual({ cli, method: 'squash', maxLines: 80, requireApprovals: 1 })
    // Changing only a condition does not check the CLI again.
    h.answers[`${cli} api user --jq .login`] = ''
    expect(await panel({ cli, maxLines: 90 })).toMatchObject({ saved: true })
  })
})

describe('Mandate limits', () => {
  const MERGE = '/usr/local/bin/gh-merge'
  /**
   * A ticket accepted proactively under the copy rule, which presets `limits`, and GitHub as the agent's gh reads it: PR 42 from
   * the ticket's branch, which changes `files`, with passing CI and an approval of its head.
   */
  async function proactiveTicket(limits: Record<string, unknown>) {
    const policy = h.runtime.store.settings().policy
    const rules = policy.rules.map(rule => rule.id === 'copy' ? { ...rule, limits } : rule)
    await h.runtime.settings.save('policy', { ...policy, rules }, h.runtime.store.blockRevision('policy'), 'panel')
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, merge: { ...settings.executor.merge, cli: MERGE } } })
    vi.mocked(Commands.prototype.run).mockImplementation(async (program, args) => program !== MERGE ? '{"ok":true,"data":{}}'
      : args[0] === 'api' ? 'merger\n' : '')
    const trigger = feishu('20', '把副标题改成“浏览网页”', { mentions: [] })
    await h.runtime.receive(trigger); await h.runtime.idle()
    vi.mocked(Commands.prototype.lark).mockResolvedValue({ items: [{ message_id: 'om_20', chat_id: CHAT }] })
    await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
    const accepted = await h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', { trigger_id: trigger.id, decision: 'accept', title: '文案修订',
      worktree_name: 'copy-fix', scope: 'the subtitle', reason: 'copy change', intent_evidence: 'quoted', paths: ['src/**'],
      rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy' }, { rule_id: 'visual', matched: false, reason: 'not visual' }],
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'it names the text' } }) as
      { ticket: { ticket_id: string } }
    await h.runtime.idle()
    const ticket = h.runtime.store.tickets.get(accepted.ticket.ticket_id)!
    return { ticket, sessionId: `worker-${ticket.id}` }
  }
  function github(ticket: Ticket, files: string[]) {
    const answers: Record<string, unknown> = {
      'repos/acme/widgets/pulls/42': { number: 42, state: 'open', draft: false, additions: 3, deletions: 1, html_url: 'https://github.com/acme/widgets/pull/42',
        user: { login: 'agent-bot' }, head: { sha: 'head2', ref: `agent/${ticket.execution!.name}`, repo: { full_name: 'acme/widgets' } } },
      'repos/acme/widgets/pulls/42/files?per_page=100': [files.map(filename => ({ filename, status: 'modified' }))],
      'repos/acme/widgets/commits/head2/check-runs?per_page=100': [{ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }],
      'repos/acme/widgets/commits/head2/statuses?per_page=100': [[]],
      'repos/acme/widgets/pulls/42/reviews?per_page=100': [[{ user: { login: 'alice', type: 'User' }, state: 'APPROVED', commit_id: 'head2' }]],
    }
    vi.mocked(Commands.prototype.gh).mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' }
      : args[1]! in answers ? answers[args[1]!] : { default_branch: 'master', permissions: { push: true } })
  }

  it('keeps a ticket whose rule allows only locale/** and whose PR changes src/ from person/review, and from a merge', async () => {
    const { ticket, sessionId } = await proactiveTicket({ paths: ['locale/**'] })
    // The rule's paths take precedence over those the assessment gave; the worker is told them in its assignment.
    expect(ticket.mandate.limits).toEqual({ paths: ['locale/**'] })
    expect(JSON.stringify(h.relays(sessionId)[0])).toContain('Limits the host checks: change only files matching locale/**.')
    github(ticket, ['locale/zh.json', 'src/app.ts'])
    h.deliveries.mockClear()
    const result = await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Changed the subtitle.', pr_number: 42 })
    expect(result).toMatchObject({ reported: true, state: 'blocked', attention: { question: expect.stringContaining('PR #42 changes src/app.ts') } })
    const blocked = h.runtime.store.tickets.get(ticket.id)!
    expect(ticketStage(blocked)).not.toEqual({ stage: 'person', action: 'review' })
    expect(blocked.follows).toEqual([expect.objectContaining({ thread: 'github:42', own: true })])
    await h.runtime.idle()
    expect(h.relays(h.runtime.masterId)).toEqual([expect.objectContaining({ kind: 'worker_attention', state: 'blocked' })])
    expect(await h.runTool(sessionId, 'orchestrator_merge_request', { pull: 42 })).toMatchObject({ auto_merge: 'refused',
      refused: [{ check: 'paths', detail: expect.stringContaining('PR #42 changes src/app.ts: outside the files this ticket may change (locale/**)') }] })
    // Once the PR changes only files within its paths, its ready report reaches a person for review, and it may merge.
    github(ticket, ['locale/zh.json'])
    expect(await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Kept only the copy.' })).not.toHaveProperty('state')
    expect(ticketStage(h.runtime.store.tickets.get(ticket.id)!)).toEqual({ stage: 'person', action: 'review' })
    expect(await h.runTool(sessionId, 'orchestrator_merge_request', { pull: 42 })).toMatchObject({ auto_merge: 'enabled' })
  })

  it('refuses on the host the actions its limits leave out: an acknowledgement, binding a PR it opened and a merge', async () => {
    const { ticket, sessionId } = await proactiveTicket({ actions: ['push'] })
    expect(ticket.mandate.limits).toEqual({ paths: ['src/**'], actions: ['push'] })
    await expect(h.runTool(sessionId, 'orchestrator_ack', { trigger_id: ticket.origin.triggerId, text: '收到。' })).rejects.toThrow('leave out comment')
    github(ticket, ['src/app.ts'])
    await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 })).rejects.toThrow('may not open a PR')
    expect(h.runtime.store.tickets.get(ticket.id)!.follows ?? []).toEqual([])
    expect(await h.runTool(sessionId, 'orchestrator_merge_request', { pull: 42 })).toMatchObject({ auto_merge: 'refused',
      refused: expect.arrayContaining([{ check: 'limits', detail: expect.stringContaining('leave out merge') }]) })
  })
})
