/**
 * A scripted model provider for the e2e harness: an HTTP server speaking the Anthropic-compatible Messages protocol
 * (`POST /v1/messages`, streamed as SSE) that DeepSeek Harness's `llm-deepseek` route uses. The profile points that route's
 * `baseURL` here, so every Session of the real host, main Session and workers alike, talks to it instead of a real model.
 *
 * Each request is classified by the tools it offers (the main Session has `orchestrator_route`, a worker
 * `orchestrator_report`) and answered by the `script` callback with text or one tool call. Every request and answer is
 * kept in `requests` and appended to a JSONL log for debugging.
 */
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Role = 'main' | 'worker' | 'other'
export interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
export interface WireMessage { role: 'user' | 'assistant'; content: string | ContentBlock[] }
export interface LlmRequest {
  seq: number
  role: Role
  sessionId: string | undefined
  tools: string[]
  system: string
  messages: WireMessage[]
  /** Text of the messages after the last assistant message: what this turn reacts to. */
  latest: string
  /** Tool results after the last assistant message, by tool name. */
  results: { name: string; text: string }[]
  reply?: Reply
}
export type Reply = { text: string } | { tool: string; input: Record<string, unknown>; text?: string }
export type Script = (request: LlmRequest, history: readonly LlmRequest[]) => Reply

/** Flattens any content (string, blocks, nested tool_result content) to text. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(textOf).join('\n')
  if (content && typeof content === 'object') {
    const block = content as ContentBlock
    if (block.type === 'text') return block.text ?? ''
    if (block.type === 'tool_result') return textOf(block.content)
    if (block.type === 'tool_use') return JSON.stringify(block.input)
  }
  return ''
}
function classify(body: { system?: unknown; messages?: WireMessage[]; tools?: { name: string }[] }, sessionId: string | undefined, seq: number): LlmRequest {
  const tools = (body.tools ?? []).map(tool => tool.name)
  const messages = body.messages ?? []
  const lastAssistant = messages.map(message => message.role).lastIndexOf('assistant')
  const after = messages.slice(lastAssistant + 1)
  const uses = new Map<string, string>()
  const previous = messages[lastAssistant]
  if (previous && Array.isArray(previous.content)) for (const block of previous.content) if (block.type === 'tool_use') uses.set(block.id!, block.name!)
  const results = after.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result').map(block => ({ name: uses.get(block.tool_use_id ?? '') ?? '', text: textOf(block.content) }))
  const role: Role = tools.includes('orchestrator_route') ? 'main' : tools.includes('orchestrator_report') ? 'worker' : 'other'
  return { seq, role, sessionId, tools, system: textOf(body.system), messages, latest: after.map(message => textOf(message.content)).join('\n'), results }
}

/** Scripted Messages endpoint; `baseURL` is the route's `baseURL` (the adapter appends `/v1/messages`). */
export class MockLlm {
  readonly requests: LlmRequest[] = []
  script: Script
  private server?: Server
  private readonly log: string | undefined
  constructor(script: Script, log?: string) { this.script = script; this.log = log }
  get baseURL(): string { return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}` }
  async start(port = 0): Promise<this> {
    this.server = createServer((request, response) => { void this.handle(request, response) })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', resolve) })
    return this
  }
  async close(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }
  byRole(role: Role): LlmRequest[] { return this.requests.filter(request => request.role === role) }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://mock.invalid').pathname
    if (request.method !== 'POST' || !path.endsWith('/v1/messages')) { response.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    let body: Parameters<typeof classify>[0]
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body } catch { response.writeHead(400).end(); return }
    const header = request.headers['x-deepseek-harness-session-id']
    const entry = classify(body, typeof header === 'string' ? header : undefined, this.requests.length + 1)
    let reply: Reply
    try { reply = this.script(entry, this.requests) } catch (error) { reply = { text: `mock script failed: ${String(error)}` } }
    entry.reply = reply
    this.requests.push(entry)
    if (this.log) appendFileSync(this.log, JSON.stringify({ seq: entry.seq, role: entry.role, sessionId: entry.sessionId, tools: entry.tools,
      latest: entry.latest.slice(0, 4000), results: entry.results, reply, system: entry.system.slice(0, 200) }) + '\n')
    this.stream(response, reply, entry.seq)
  }

  private stream(response: ServerResponse, reply: Reply, seq: number): void {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (payload: Record<string, unknown>) => response.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`)
    send({ type: 'message_start', message: { id: `msg_e2e_${seq}`, type: 'message', role: 'assistant', model: 'e2e-mock', content: [],
      usage: { input_tokens: 10, output_tokens: 0 } } })
    let index = 0
    const text = 'tool' in reply ? reply.text : reply.text
    if (text) {
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
      send({ type: 'content_block_stop', index })
      index++
    }
    if ('tool' in reply) {
      send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_e2e_${seq}`, name: reply.tool, input: {} } })
      send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } })
      send({ type: 'content_block_stop', index })
    }
    send({ type: 'message_delta', delta: { stop_reason: 'tool' in reply ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    send({ type: 'message_stop' })
    response.end()
  }
}
