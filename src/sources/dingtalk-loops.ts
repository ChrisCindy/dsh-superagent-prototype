/**
 * The DingTalk loop and intake: the Stream mode connection with its health and backoff, and what a robot message does on the
 * way in: the Thread it joins (`threadOf`), its Trigger, the Thread's transcript and the sender's Thread window
 */
import { threadKey, type OutboundMessage, type ReceiveResult } from '../core/index.ts'
import { dingtalkApi } from '../infra/dingtalk.ts'
import { KV } from '../kv.ts'
import { connectStream, type StreamConnect, type Taken } from './dingtalk-stream.ts'
import { dingtalkThreadId, dingtalkTrigger, dingtalkTriggerId, quotedId, RobotMessageSchema, senderOf, SOURCE, transcriptEntry,
  type DingtalkEntry, type RobotMessage } from './dingtalk-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { consumerRetry, pause } from './poll.ts'

/** The Source's configuration as `runDingtalk` and `takeIn` read it (`DingtalkConfig` in dingtalk.ts). */
export interface DingtalkLoopConfig { threadMinutes: number }
/** How many messages a Thread's transcript keeps, newest last. */
export const TRANSCRIPT_MAX = 100
/** The longest Thread window, after which a sender's window record is removed. */
const WINDOW_MAX_MS = 24 * 3600_000

/**
 * The contexts of the running DingTalk instances, by instance ID. The Channel, the resources and the Thread context reach the
 * Source's records through it, since the SourceKind protocol hands them only the instance's commands.
 */
const running = new Map<string, SourceContext>()
/** Makes `ctx` the running context of its instance until the returned function is called. */
export function attach(ctx: SourceContext): () => void {
  running.set(ctx.source, ctx)
  return () => { if (running.get(ctx.source) === ctx) running.delete(ctx.source) }
}
/** @throws while instance `source` is not running. */
export function runningContext(source: string): SourceContext {
  const ctx = running.get(source)
  if (!ctx) throw new Error('The DingTalk Source is not running')
  return ctx
}
/** The transcript of Thread `thread` (its ID) of instance `source`. */
export const transcript = (source: string, thread: string): DingtalkEntry[] =>
  runningContext(source).state.get(KV.dingtalk.transcript(thread)) ?? []

const enabled = (ctx: SourceContext): DingtalkLoopConfig | undefined => ctx.config<DingtalkLoopConfig & Record<string, unknown>>(ctx.source)
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.dingtalk) return true
  const waiting = health('paused', ctx.configured() ? 'dingtalkUnset' : 'setupPending')
  ctx.report(SOURCE, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}
/** A robot message the Source cannot read; it is acknowledged, since DingTalk would only deliver it again. */
class Unreadable extends Error {}

/**
 * Keeps one Stream mode connection open while the Source is on, and reports it on the `dingtalk` health entry: `ready` once
 * open, unless a message of this connection failed, which stays on the entry until the next connection; `starting` while it
 * connects again; `error` after three connections in a row that did not open. A connection is retried after 1 s when the
 * previous one stayed up for a minute, otherwise after twice the previous wait, up to a minute. Switching the Source off ends
 * the connection within five seconds.
 */
export async function runDingtalk(ctx: SourceContext, signal: AbortSignal, connect: StreamConnect = connectStream): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it verified the app; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  let failures = 0
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report(SOURCE, health('paused', 'sourceOff'))
      await pause(5000, signal)
      continue
    }
    const connection = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) connection.abort() }, 5000)
    const stop = () => connection.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    let opened = false
    // A failed message keeps its error on the entry for the rest of this connection, whatever arrives after it.
    let failed = false
    const handlers = {
      open: () => {
        opened = true; failures = 0
        if (!failed) ctx.report(SOURCE, { state: 'ready', detail: 'Listening for robot messages', at: new Date().toISOString() })
      },
      message: async (payload: unknown): Promise<Taken> => {
        try { await takeIn(ctx, payload); return 'ack' }
        catch (error) {
          failed = true
          ctx.report(SOURCE, { state: 'error', detail: String(error), at: new Date().toISOString() })
          return error instanceof Unreadable ? 'ack' : 'retry'
        }
      },
    }
    try { await connect(dingtalkApi(ctx.deployment.dingtalk!), handlers, connection.signal) }
    catch (error) {
      if (!connection.signal.aborted) {
        if (!opened) failures += 1
        if (failures >= 3) ctx.report(SOURCE, health('error', 'streamFailures', { count: String(failures), error: String(error) }))
        else if (!failed) ctx.report(SOURCE, { state: 'starting', detail: `Connecting again: ${String(error)}`, at: new Date().toISOString() })
      }
    } finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (connection.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await pause(retry, signal)
  }
}

/**
 * The Thread a robot message joins, by its ID:
 * 1. the Thread of the message it quotes, when the Source received that message in the same conversation;
 * 2. for a message that addresses the robot, the Thread its sender or the robot last wrote in, in this conversation with this
 *    sender, when that was less than the Source's Thread window (`threadMinutes`) before it;
 * 3. otherwise a new Thread that starts with the message.
 */
export function threadOf(ctx: SourceContext, message: RobotMessage, config: DingtalkLoopConfig): string {
  const conversation = message.conversationId
  const quoted = quotedId(message)
  if (quoted) {
    const trigger = ctx.triggers.get(dingtalkTriggerId(quoted))
    const ref = trigger?.threads[0]
    if (ref && ref.source === ctx.source && trigger!.meta.conversationId === conversation) return ref.id
  }
  const addressed = message.conversationType === '1' || message.isInAtList === true
  const last = addressed && config.threadMinutes > 0 ? ctx.state.get(KV.dingtalk.window(conversation, senderOf(message))) : undefined
  const since = last ? message.createAt - Date.parse(last.at) : NaN
  if (last && since >= 0 && since < config.threadMinutes * 60_000) return last.thread
  return dingtalkThreadId(conversation, message.msgId)
}

/**
 * Takes one robot message in: a message already received, another robot's or one that arrives while the Source is off does
 * nothing; any other becomes a Trigger on the Thread `threadOf` gives. A stored Trigger goes on its Thread's transcript, and one
 * that addresses the robot opens its sender's Thread window. A group's title becomes its label in the Source's settings.
 * @throws Unreadable for a payload that is not a robot message.
 */
export async function takeIn(ctx: SourceContext, payload: unknown): Promise<ReceiveResult | undefined> {
  const parsed = RobotMessageSchema.safeParse(payload)
  if (!parsed.success) throw new Unreadable(`Unreadable DingTalk robot message: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
  const message = parsed.data
  const app = ctx.deployment.dingtalk
  if (message.robotCode && app && message.robotCode !== app.robotCode) return undefined
  const config = enabled(ctx)
  if (!config) return undefined
  if (ctx.triggers.get(dingtalkTriggerId(message.msgId))) return 'duplicate'
  const trigger = dingtalkTrigger(ctx.source, message, threadOf(ctx, message, config))
  if (!trigger) return undefined
  if (message.conversationType === '2' && message.conversationTitle) {
    const labels = ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
    if (labels[message.conversationId] !== message.conversationTitle) {
      ctx.state.set(KV.sources.labels(SOURCE), { ...labels, [message.conversationId]: message.conversationTitle })
    }
  }
  const result = await ctx.receive(trigger)
  if (result !== 'stored') return result
  remember(ctx, trigger.threads[0]!.id, transcriptEntry(trigger), trigger.addressed ? senderOf(message) : undefined, trigger.at)
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[message.conversationId] ?? message.conversationId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { chat } })
  return result
}
/** Adds `entry` to Thread `thread`'s transcript and, for `sender`, moves their Thread window in its conversation to it. */
function remember(ctx: SourceContext, thread: string, entry: DingtalkEntry, sender: string | undefined, at: string): void {
  ctx.atomic(() => {
    const record = KV.dingtalk.transcript(thread)
    const entries = (ctx.state.get(record) ?? []).filter(item => item.id !== entry.id)
    ctx.state.set(record, [...entries, entry].slice(-TRANSCRIPT_MAX))
    if (!sender) return
    const conversation = thread.slice(0, thread.indexOf(':'))
    ctx.state.set(KV.dingtalk.window(conversation, sender), { thread, at })
    // A window older than the longest one can never be joined again.
    for (const name of ctx.state.keys(KV.dingtalk.window)) {
      const value = ctx.state.get(name)
      if (!value || Date.parse(at) - Date.parse(value.at) > WINDOW_MAX_MS) ctx.state.set(name, undefined)
    }
  })
}
/**
 * Records a reply the robot sent on the transcript of the Thread of the message it answers, and moves the Thread window of that
 * message's sender to it, so their next message within the window continues the Thread. Does nothing while the Source is not
 * running or the answered message is unknown.
 */
export function recordReply(message: OutboundMessage, at = new Date().toISOString()): void {
  const ctx = running.get(message.channel.source)
  const answered = ctx?.triggers.get(dingtalkTriggerId(message.channel.address.messageId ?? ''))
  const thread = answered?.threads[0]
  if (!ctx || !answered || thread?.source !== ctx.source) return
  remember(ctx, thread.id, { id: message.id, from: 'robot', at, text: message.text, bot: true }, answered.actor.id, at)
}
