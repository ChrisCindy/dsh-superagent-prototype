# ADR 0009: DingTalk through Stream mode in the host process, with Threads by quote and window

- Status: accepted
- Date: 2026-11-05
- Related: [001 Domain model](../001-domain.md) (Thread, Subscription), [002 Authorization](../002-authorization.md) (follow-up ownership), [006 Deployment](../006-deployment.md) (DingTalk app), [009 Security](../009-security.md); `src/sources/dingtalk*.ts`, `src/infra/dingtalk.ts`.

## Context

A team on DingTalk (钉钉) asks the agent for work by mentioning a robot in a group or messaging it directly. The robot belongs to an enterprise-internal app. Three facts of the platform shape the Source:

- **Intake.** DingTalk pushes robot messages either to a public HTTP callback or over Stream mode, a WebSocket the app opens to DingTalk's gateway. dsh-superagent runs on a machine that serves its panel on `127.0.0.1` only and has no public URL.
- **No history.** An internal robot cannot list a group's messages. Each pushed message carries the sender (`senderStaffId`, `senderNick`, `isAdmin`), the conversation (`conversationId`, the `openConversationId`), whether the robot is mentioned (`isInAtList`), and, for a quote reply, the quoted message's `msgId`. A group robot receives only the messages that mention it unless DingTalk sends it more.
- **No topics.** A group is one flat stream. Feishu's topic, which the Feishu Source makes a Thread, has no counterpart. A quote reply names the message it quotes, but the robot's own messages have no `msgId` the robot learns when it sends them: the OpenAPI answers a send with a `processQueryKey` only.

001 makes a Thread the unit that one Eval runs on at a time, and the unit Subscriptions hold. 002 makes every person's message on a Ticket's Thread that Ticket's to decide, and a person's message on an ended Ticket's Thread resumes the Ticket. A Thread that is too wide, such as a whole group or a whole direct conversation, would hand every later request to the Tickets already on it, and resume every ended one: a person's tenth request in a direct chat would resume the nine Tickets before it, each of which would hand the message back. A Thread that is too narrow, one per message, would send every follow-up to Eval as a new request, as if the person had not been talking to the agent a minute before.

## Decision

**Intake through Stream mode, in the host process.** The DingTalk Source opens one Stream mode connection while it is on, from the dsh-superagent process, as the Feishu Source runs its event consumer: no public URL, no callback signature to verify, and DingTalk delivers again a message that was not acknowledged within a minute. The Source acknowledges a message once `receive` stored it, or for good when it is unreadable; a failure to store it leaves it unacknowledged, so DingTalk delivers it again and the stored Trigger ID makes the second delivery a duplicate.

The Source speaks the Stream mode protocol itself (`src/sources/dingtalk-stream.ts`), about a hundred lines on Node's built-in `WebSocket` and `fetch`, with the wire format of DingTalk's `dingtalk-stream` SDK 2.1.5, the current release (2.1.6 and 2.1.7 are betas). The SDK was the first choice and was read for this decision; it does not fit the Source's guarantees:

- It reports nothing about its connection: `connect()` swallows a failure, and no event says that the socket closed. The Source's health must say whether it listens.
- 2.1.5 reconnects every second forever, with no backoff; the betas add backoff.
- It hard-codes the gateway URL, so no test double can stand in for DingTalk, and the end-to-end test could not run against it.
- It logs to the console, and pulls in `axios`, `ws` and `debug`.

The protocol is small and stable: open the gateway with the app's Client ID and Client Secret and a `CALLBACK` subscription to `/v1.0/im/bot/messages/get`, connect to the endpoint with its ticket, answer `SYSTEM` `ping` frames with themselves, reconnect on `disconnect`, and acknowledge each `CALLBACK` with its `messageId`. `connectStream` is also the seam the tests replace.

A child process would isolate DingTalk's code from the host's, as the Feishu Source's `lark-cli` is isolated. It was not chosen: the connection is the Source's own code, with no third-party dependency, and a child would need the credentials too, in its arguments or its environment.

**Credentials stay where the operator put them.** The Source's configuration holds only where the AppKey and AppSecret are: an absolute path to a JSON file that only its owner may read, or `env:NAME` for a variable whose name contains `SECRET`, which DeepSeek Harness strips from every subprocess it starts, workers included. Setup and every token request read them again; the settings database, `Deployment`, the panel and the logs never hold them. Setup refuses a file group or others may read, gets an access token and opens a Stream mode connection before it accepts the app.

**Threads by quote, then by window.** A robot message joins:

1. the Thread of the message it quotes, when the Source received that message in the same conversation;
2. when it addresses the robot (a mention in a group, any direct message), the Thread its sender or the robot last wrote in, in this conversation with this sender, when that was less than the Source's Thread window before it (30 minutes by default, `threadMinutes`, 0 to switch it off); a reply the robot sends moves the window of the person it answers;
3. otherwise a new Thread, `<conversationId>:<msgId>`, which starts with the message.

A message that does not address the robot, in a group set to receive all messages, joins a Thread only by quoting.

The same rule holds in groups and direct conversations. A person who keeps talking to the agent stays on their Thread: a follow-up within the window reaches the Ticket as 002 describes, and resumes it if it ended. A request after a pause starts a Thread, takes an Eval, and resumes nothing. Within a group, two people's conversations with the robot stay apart even when they interleave.

**A Thread's transcript.** Since DingTalk keeps no history a robot may read, the Source records what it received and sent on each Thread, up to its last hundred messages (`KV.dingtalk.transcript`). Assessments read it as the Thread context, and agents read it as `dingtalk/<trigger-id>/thread`; pruning a Thread deletes it (`THREAD_RECORDS`).

## Consequences

- A request arrives within a second of the mention, with no polling and no public URL. A message DingTalk delivered while the Source was off, or before a restart, is lost unless DingTalk delivers it again within its retry minute: Stream mode has no cursor to recover from, and the robot cannot read the group.
- The Thread a message joins depends on the records at the time it arrives, not on the message alone. A message delivered twice is recognized by its stored Trigger before its Thread is computed, so a redelivery cannot move it.
- A quote of the robot's own reply cannot be matched to the reply, since the robot never learns that message's ID. Within the window it continues the Thread anyway; after it, it starts a new Thread, and the quoted text in the Trigger's text lets the main Session see what it answers.
- A person who asks two unrelated things within the window puts both on one Thread. The second reaches the first Ticket, whose Executor hands it back to Eval (002), at the cost of one hand-back.
- A transient network failure at setup pauses the Source until **Check again**, as a failed Feishu bot check does.
- If DingTalk changes the Stream mode protocol, the Source changes with it, where an SDK upgrade would have. The protocol has kept its form since the SDK's first release in 2023.

## Alternatives considered

- **The `dingtalk-stream` SDK in the host process.** Rejected for the reasons above; a later SDK that reports its connection and takes a gateway URL could replace `connectStream` behind the same seam.
- **An HTTP callback.** Needs a public HTTPS URL and signature checks; a deployment behind NAT cannot take it.
- **One Thread per direct conversation, and per group.** Simple, and wrong under 001 and 002: every new request would be a follow-up of every Ticket the conversation ever had, and would resume the ended ones.
- **One Thread per message, except quotes.** Correct, but every follow-up that does not quote would become a new request; people rarely quote in a conversation with a robot.
- **One Thread per mention window of the whole group.** Mixes the requests of everyone who mentions the robot within the window.
- **The per-message `sessionWebhook` for replies.** It would allow a real @mention, but it expires within hours, and it is a credential of the conversation that the Channel address would have to store. Replies go through the OpenAPI with the app's token instead, and name the person they answer in their text.
