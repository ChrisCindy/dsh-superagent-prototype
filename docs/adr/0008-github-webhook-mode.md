# ADR 0008: GitHub webhooks as a supplement to polling

- Status: proposed, deferred
- Date: 2026-11-05 (plan item 4.6, evaluation only)
- Related: [006 Deployment](../006-deployment.md), Settings; [ADR 0002](0002-agent-account-not-github-app.md); [ADR 0004](0004-github-source-per-repository.md).

## Context

Each GitHub Source polls on an interval: the agent account's notifications in its repository, the repository-wide streams that are switched on, the pull requests and CI of open Tickets, and subscribed Threads. The interval is at least 60 seconds, longer when GitHub asks for it (`pollSeconds`). So a mention waits up to about a minute before it becomes a Trigger, and every instance spends API calls even when nothing happens.

GitHub can push the same events to a URL instead: a repository or organization webhook sends `issue_comment`, `pull_request`, `pull_request_review`, `check_run` and similar events within seconds.

## When webhooks would be worth it

- Response time matters, for example a team that expects an answer to a mention within seconds.
- Many repositories or a busy one make polling cost a large part of the agent account's rate limit.
- CI and review events on open Tickets must wake an Executor sooner than the next round.

None of these holds for the teams dsh-superagent serves today. Requests are rare compared with the poll interval, and the work itself takes minutes to hours.

## What it would need

- **A public callback.** dsh-superagent listens only on `127.0.0.1`, behind DeepSeek Harness's sign-in. Webhooks need an HTTPS endpoint GitHub can reach: a reverse proxy, a tunnel, or a relay service. That endpoint must accept only the webhook route, without the sign-in, and nothing else of the management API.
- **Secret verification.** Each delivery carries `X-Hub-Signature-256`, an HMAC of the body with a shared secret. The host must check it in constant time before reading the body, refuse unsigned or stale deliveries, and keep the secret out of workers' reach (ADR 0001).
- **Someone to register the hook.** A repository webhook needs admin rights on the repository. The agent account usually has only write access, so an operator registers it, or a GitHub App does (ADR 0002 explains why the agent is not one).
- **Dedupe with the polling cursors.** Webhooks get lost: GitHub does not retry a failed delivery on its own, and the host may be down. So polling stays, at a longer interval, as the source of truth. A webhook event becomes the same Trigger, with the same ID, that the poll would make from the same comment or review, so `Engine.receive` answers `duplicate` for the second one. The poll's cursors still advance only from what the poll read, so a lost webhook is caught on the next round.
- **Mapping to instances.** A delivery names its repository; the host routes it to the GitHub Source instance for that repository and drops the rest (ADR 0004).
- **Notifications are not webhooks.** A mention reaches the agent account's notifications, which GitHub does not send by webhook. The webhook path would read the comment events of the repository and decide mentions itself, as the repository-wide streams do now.

## Decision

Defer. Keep polling as the only GitHub input. Revisit when one of the conditions above holds for a real deployment, or when dsh-superagent gets a public endpoint for another reason.

If built, it would be a supplement inside the GitHub kind: a webhook route that turns deliveries into the same Triggers the poll makes, with polling kept as the fallback at a longer interval. It would not be a new Source kind, because the Threads, cursors and Policy part are the GitHub instance's.

## Consequences of deferring

- Requests wait up to one poll interval.
- No public endpoint, secret or proxy to run and protect.
- Polling cost grows with the number of GitHub Source instances.

## Alternatives considered

- **Replace polling with webhooks.** Rejected: lost deliveries would lose requests, and notifications have no webhook.
- **A shorter poll interval.** GitHub sets the lower bound through `X-Poll-Interval`, and it raises the API cost of every instance.
- **GitHub Actions that forward events.** Still needs a reachable endpoint, and puts a secret in every repository's workflow settings.
