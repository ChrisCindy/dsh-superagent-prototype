/**
 * One DingTalk Stream mode connection: `connectStream` opens the gateway, answers the server's pings, hands each robot message to
 * the Source and acknowledges it once taken in, and ends when the connection does. The wire format is that of DingTalk's
 * `dingtalk-stream` SDK 2.1.5 (docs/adr/0009-dingtalk-stream-and-threads.md says why the Source does not run the SDK itself)
 */
import { TOPIC_ROBOT, type DingtalkApi } from '../infra/dingtalk.ts'

/** A frame the server sends: `SYSTEM` (pings and requests to reconnect), `EVENT` or `CALLBACK` (a robot message). */
interface Frame { type?: string; headers?: { topic?: string; messageId?: string; contentType?: string }; data?: string }
/** What the Source does with each robot message: `ack` once it took the message in, or `retry` to let DingTalk deliver it again. */
export type Taken = 'ack' | 'retry'
export interface StreamHandlers {
  /** The connection opened. */
  open(): void
  /** Takes one robot message in; messages are handed over one at a time, in the order they arrive. */
  message(payload: unknown): Promise<Taken>
}
/** The minimal WebSocket the connection uses: Node's global `WebSocket`, or a test double. */
export interface Socket {
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
}
/**
 * Opens one connection and resolves when `signal` ends it.
 * @throws when the gateway refuses the connection, or the connection ends otherwise.
 */
export type StreamConnect = (api: DingtalkApi, handlers: StreamHandlers, signal: AbortSignal) => Promise<void>
/** How long a connection may stay silent before it counts as lost; the server pings well within it. */
export const STREAM_IDLE_MS = 120_000

/** Opens a Stream mode connection for robot messages through `api`'s gateway (see `StreamConnect`). */
export async function connectStream(api: DingtalkApi, handlers: StreamHandlers, signal: AbortSignal,
  socket: (url: string) => Socket = url => new WebSocket(url) as unknown as Socket, idleMs = STREAM_IDLE_MS): Promise<void> {
  const { url } = await api.openStream([TOPIC_ROBOT], signal)
  signal.throwIfAborted()
  const ws = socket(url)
  let chain = Promise.resolve()
  let idle: ReturnType<typeof setTimeout> | undefined
  let ended: Error | undefined
  const end = (why: Error | undefined, code = 1000) => { ended ??= why; clearTimeout(idle); try { ws.close(code) } catch { /* Already closed. */ } }
  const quiet = () => { clearTimeout(idle); idle = setTimeout(() => end(new Error(`The DingTalk stream was silent for ${idleMs / 1000} s`), 4000), idleMs) }
  const answer = (messageId: string, data: string) =>
    ws.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data }))
  const stop = () => end(undefined)
  signal.addEventListener('abort', stop, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => { quiet(); handlers.open() })
      ws.addEventListener('error', () => end(new Error('The DingTalk stream connection failed')))
      ws.addEventListener('close', event => {
        clearTimeout(idle)
        if (signal.aborted && !ended) resolve()
        else reject(ended ?? new Error(`The DingTalk stream closed (${event.code ?? 'no code'}${event.reason ? `: ${event.reason}` : ''})`))
      })
      ws.addEventListener('message', event => {
        quiet()
        let frame: Frame
        try { frame = JSON.parse(String(event.data)) as Frame } catch { return }
        const { topic, messageId } = frame.headers ?? {}
        if (frame.type === 'SYSTEM') {
          // The server pings and expects its frame back; `disconnect` asks the client to connect again elsewhere.
          if (topic === 'ping' && messageId) answer(messageId, frame.data ?? '')
          if (topic === 'disconnect') end(new Error('The DingTalk stream server asked to reconnect'))
          return
        }
        if (!messageId) return
        if (frame.type !== 'CALLBACK' || topic !== TOPIC_ROBOT) { answer(messageId, JSON.stringify({ status: 'SUCCESS' })); return }
        chain = chain.then(async () => {
          let payload: unknown
          try { payload = JSON.parse(frame.data ?? '') } catch { payload = undefined }
          // An unacknowledged message is delivered again within a minute.
          if (await handlers.message(payload) === 'ack' && !ended) answer(messageId, JSON.stringify({ response: null }))
        }).catch(() => { /* `handlers.message` reports its own failures. */ })
      })
    })
  } finally { signal.removeEventListener('abort', stop); clearTimeout(idle); await chain }
}
