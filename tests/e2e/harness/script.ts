/**
 * The scripted model behind every Session of the e2e run. It plays the main Session and the workers just well enough to
 * drive one explicit request through the whole lifecycle, deciding only from what the real host sends:
 *
 * - main Session: an explicit `candidate` card → `orchestrator_route` accept; a `worker_report` with state `ready` →
 *   `orchestrator_reply` purpose `result`; anything else → a short text that ends the turn.
 * - worker: first turn → `bash pwd` (proves the directory it runs in); after that result → `orchestrator_report` ready
 *   with the directory in the summary; afterwards → a short text.
 * - any other request (such as a Session title) → a short text.
 */
import type { LlmRequest, Reply, Script } from './mock-llm.ts'

/** JSON objects on their own lines of a turn's input, such as candidate cards and relays. */
export function cards(text: string): Record<string, any>[] {
  return text.split('\n').flatMap(line => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return []
    try { const value = JSON.parse(trimmed) as unknown; return value && typeof value === 'object' ? [value as Record<string, any>] : [] } catch { return [] }
  })
}

export interface ScriptOptions {
  /** What the worker reports as its result; receives the directory `pwd` printed. */
  summary?: (directory: string) => string
  /** The result text the main Session sends to the requester. */
  result?: string
}
export const ACKNOWLEDGEMENT = 'I will correct the README typo "widgts" to "widgets".'
export const RESULT = 'Fixed: README.md now says "widgets". (e2e scripted result)'

export function superagentScript(options: ScriptOptions = {}): Script {
  const routed = new Set<string>()
  const replied = new Set<string>()
  const main = (request: LlmRequest): Reply => {
    if (request.results.length) return { text: 'Done.' }
    for (const card of cards(request.latest)) {
      if (card.kind === 'candidate' && card.strength === 'explicit' && !routed.has(card.trigger_id)) {
        routed.add(card.trigger_id)
        return { tool: 'orchestrator_route', input: { decisions: [{ kind: 'accept', trigger_id: card.trigger_id, title: 'Fix the README typo',
          worktree_name: 'fix-readme-typo', acknowledgement: ACKNOWLEDGEMENT }] } }
      }
      const ticket = card.ticket?.ticket_id as string | undefined
      if (card.kind === 'worker_report' && card.state === 'ready' && ticket && !replied.has(ticket)) {
        replied.add(ticket)
        return { tool: 'orchestrator_reply', input: { ticket_id: ticket, purpose: 'result', text: options.result ?? RESULT } }
      }
    }
    return { text: 'Nothing to do.' }
  }
  const worker = (request: LlmRequest, history: readonly LlmRequest[]): Reply => {
    const pwd = request.results.find(result => result.name === 'bash')
    if (pwd) {
      const directory = /\/\S+/.exec(pwd.text)?.[0] ?? pwd.text.trim()
      return { tool: 'orchestrator_report', input: { state: 'ready', summary: options.summary?.(directory) ?? `Ready in ${directory}: README.md fixed.` } }
    }
    if (request.results.length) return { text: 'Reported.' }
    const started = history.some(earlier => earlier.role === 'worker' && earlier.sessionId === request.sessionId)
    if (started) return { text: 'Waiting.' }
    return { tool: 'bash', input: { command: 'pwd', description: 'Show the ticket directory' } }
  }
  return (request, history) => request.role === 'main' ? main(request) : request.role === 'worker' ? worker(request, history) : { text: 'E2E' }
}
