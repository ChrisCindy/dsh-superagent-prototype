/**
 * A fake DingTalk for the e2e harness: one local HTTP server that answers the OpenAPI routes the DingTalk Source calls
 * (`oauth2/accessToken`, `gateway/connections/open`, `robot/groupMessages/send`, `robot/oToMessages/batchSend`) and serves the
 * Stream mode WebSocket the gateway names. The Source's `endpoint` points here (http on the loopback interface).
 *
 * The WebSocket side is a minimal RFC 6455 server, enough for Node's client: the handshake, unfragmented text frames, close
 * and ping. It sends a `SYSTEM` ping every 20 seconds, as DingTalk's gateway keeps a connection alive, and `push` sends a
 * robot message as a `CALLBACK` frame. Every request, acknowledgement and robot send is kept for assertions.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

export const FAKE_APP = { appKey: 'dinge2efake', appSecret: 'e2e-fake-app-secret' }
const TOPIC = '/v1.0/im/bot/messages/get'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface DingtalkCall { path: string; body: Record<string, unknown> }
export interface StreamAck { messageId: string; code: number; data: string }

/** One text frame, unmasked, as a server sends it. */
function frame(text: string, opcode = 1): Buffer {
  const payload = Buffer.from(text)
  const length = payload.length
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
      : (() => { const value = Buffer.alloc(10); value[0] = 0x80 | opcode; value[1] = 127; value.writeBigUInt64BE(BigInt(length), 2); return value })()
  return Buffer.concat([header, payload])
}

/** A Stream mode connection the fake serves. */
class StreamSocket {
  private buffer = Buffer.alloc(0)
  open = true
  constructor(private readonly socket: Duplex, private readonly onText: (text: string) => void) {
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.read() })
    socket.on('close', () => { this.open = false })
    socket.on('error', () => { this.open = false })
  }
  send(text: string): void { if (this.open) this.socket.write(frame(text)) }
  close(): void { if (this.open) { this.socket.write(frame('', 8)); this.socket.end(); this.open = false } }
  private read(): void {
    for (;;) {
      if (this.buffer.length < 2) return
      const opcode = this.buffer[0]! & 15
      const masked = (this.buffer[1]! & 128) !== 0
      let length = this.buffer[1]! & 127
      let offset = 2
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10 }
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined
      if (masked) offset += 4
      if (this.buffer.length < offset + length) return
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      if (mask) for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!
      this.buffer = this.buffer.subarray(offset + length)
      if (opcode === 1) this.onText(payload.toString('utf8'))
      else if (opcode === 8) this.close()
      else if (opcode === 9) this.socket.write(frame(payload.toString('utf8'), 10))
    }
  }
}

/** The fake DingTalk OpenAPI and Stream mode gateway, in the test process. */
export class FakeDingtalk {
  readonly calls: DingtalkCall[] = []
  readonly acks: StreamAck[] = []
  readonly connections: StreamSocket[] = []
  private server?: Server
  private ping?: ReturnType<typeof setInterval>
  private sequence = 0
  origin = ''

  async start(): Promise<this> {
    const server = createServer((request, response) => { void this.answer(request).then(([status, body]) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }) })
    server.on('upgrade', (request: IncomingMessage, socket: Duplex) => this.upgrade(request, socket))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    this.ping = setInterval(() => this.system('ping'), 20_000)
    return this
  }
  async close(): Promise<void> {
    if (this.ping) clearInterval(this.ping)
    for (const connection of this.connections) connection.close()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }
  /** The open Stream mode connection, if any. */
  live(): StreamSocket | undefined { return this.connections.filter(connection => connection.open).at(-1) }
  /** Sends `message` as a robot message on the open connection; returns the frame's message id. */
  push(message: Record<string, unknown>): string {
    const live = this.live()
    if (!live) throw new Error('No open DingTalk Stream mode connection')
    const messageId = `e2e-frame-${++this.sequence}`
    live.send(JSON.stringify({ specVersion: '1.0', type: 'CALLBACK', headers: { topic: TOPIC, messageId, contentType: 'application/json',
      time: String(Date.now()), appId: FAKE_APP.appKey }, data: JSON.stringify(message) }))
    return messageId
  }
  sends(): DingtalkCall[] { return this.calls.filter(call => call.path.startsWith('/v1.0/robot/')) }

  private system(topic: string): void {
    const live = this.live()
    if (live) live.send(JSON.stringify({ specVersion: '1.0', type: 'SYSTEM', headers: { topic, messageId: `e2e-system-${++this.sequence}`,
      contentType: 'application/json', time: String(Date.now()) }, data: JSON.stringify({ opaque: 'e2e' }) }))
  }
  private async answer(request: IncomingMessage): Promise<[number, unknown]> {
    let text = ''
    for await (const chunk of request) text += chunk
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(text || '{}') } catch { return [400, { code: 'InvalidParameter', message: 'not JSON' }] }
    const path = (request.url ?? '').split('?')[0]!
    this.calls.push({ path, body })
    const token = request.headers['x-acs-dingtalk-access-token']
    switch (path) {
      case '/v1.0/oauth2/accessToken':
        return body.appKey === FAKE_APP.appKey && body.appSecret === FAKE_APP.appSecret
          ? [200, { accessToken: 'e2e-access-token', expireIn: 7200 }] : [400, { code: 'invalidClientIdOrSecret', message: 'wrong app' }]
      case '/v1.0/gateway/connections/open':
        return body.clientId === FAKE_APP.appKey && body.clientSecret === FAKE_APP.appSecret
          ? [200, { endpoint: `${this.origin.replace('http:', 'ws:')}/connect`, ticket: `e2e-ticket-${++this.sequence}` }]
          : [401, { code: 'Unauthorized', message: 'wrong app' }]
      case '/v1.0/robot/groupMessages/send':
      case '/v1.0/robot/oToMessages/batchSend':
        return token === 'e2e-access-token' ? [200, { processQueryKey: `e2e-${++this.sequence}` }]
          : [401, { code: 'InvalidAuthentication', message: 'no token' }]
      default:
        return [404, { code: 'NotFound', message: `unknown route ${path}` }]
    }
  }
  private upgrade(request: IncomingMessage, socket: Duplex): void {
    const key = request.headers['sec-websocket-key']
    if (!request.url?.startsWith('/connect?ticket=e2e-ticket-') || typeof key !== 'string') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
    this.connections.push(new StreamSocket(socket, text => {
      try {
        const answer = JSON.parse(text) as { code?: number; headers?: { messageId?: string }; data?: string }
        if (answer.headers?.messageId?.startsWith('e2e-frame-')) this.acks.push({ messageId: answer.headers.messageId, code: answer.code ?? 0, data: answer.data ?? '' })
      } catch { /* Not JSON: ignored. */ }
    }))
  }
}
