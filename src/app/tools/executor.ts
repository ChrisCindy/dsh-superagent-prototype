/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, requesting a merge, and reporting status. */
import { z } from 'zod'
import { actionAllowed, latestAssignment, liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { IM_WORDS } from '../../infra/text.ts'
import type { SourceContext } from '../../sources/host.ts'
import type { SourceClaim } from '../../sources/kind.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic' | 'settings'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /**
   * The kind that binds reported changes (`SourceRegistry.claimant`) with the context of its instance the ticket came from, else
   * the first instance, whose repository and pull-request rules govern claiming a reported PR and requesting its merge; undefined
   * when no installed kind binds changes.
   */
  claims(ticket: Ticket): { context: SourceContext; claim: SourceClaim } | undefined
  sendReplies(): Promise<void>
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  const claims = host.claims(ticket)
  // A kind that registers after the tools were built still binds the reports that follow.
  const claiming = () => {
    const found = claims ?? host.claims(ticket)
    if (!found) throw new Error('No Source binds pull requests here: report without pr_number, and ask a person to merge')
    return found
  }
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, host.resources.sourceResourceNames(), (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        if (!actionAllowed(host.store.tickets.get(ticketId)?.mandate.limits, 'comment')) {
          throw new Error('This ticket\'s limits leave out comment: the host posts no acknowledgement for it')
        }
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async args => host.store.atomic(() => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const followed = host.engine.followForContext(ticketId, { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) })
        if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
        return { followed, thread: args.thread }
      }),
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_merge_request',
      description: 'Ask the host to enable auto-merge of a PR this ticket opened, as the delivery requirements say. The host checks that the PR is ready, its CI passed, it is small enough, approvals of others cover its head commit and no requested change is outstanding, then enables auto-merge with the merge account; otherwise it lists each failed check. Never merge or enable auto-merge with gh.',
      schema: z.object({ pull: z.number().int().positive().describe('The PR number.') }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const { context, claim } = claiming()
        return claim.merge(context, current, args.pull, host.store.settings().executor.merge, signal)
      },
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${claims ? claims.claim.account(claims.context) : 'the agent account'} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        // The claiming kind reads the reported PR, and what each PR the ticket opened changes for a ready report under paths.
        let prepared: Awaited<ReturnType<SourceClaim['report']>> = { changes: [], bind: () => undefined }
        if (args.pr_number != null || (args.state === 'ready' && current.mandate.limits?.paths)) {
          const { context, claim } = claiming()
          prepared = await claim.report(context, current, { state: args.state, ...args.pr_number != null ? { pull: args.pr_number } : {} }, signal)
        }
        const { changes } = prepared
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = prepared.bind()
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}), ...(changes.length ? { changes } : {}) }
          const updated = host.engine.report(ticketId, report)
          // The report as recorded, which the host turns blocked when its PR reaches beyond the Mandate's paths.
          const recorded = latestAssignment(updated)?.report
          const relayed = recorded && recorded.state !== report.state ? { ...report, state: recorded.state, summary: recorded.summary,
            question: updated.attention?.question } : report
          const relay = reportRelay(updated, relayed, ticket => host.resources.pull(ticket))
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(relayed !== report ? { state: recorded!.state } : {}),
            ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
