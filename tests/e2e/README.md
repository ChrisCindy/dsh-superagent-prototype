# End-to-end tests on a real DeepSeek Harness

`tests/e2e` runs dsh-superagent inside a real DeepSeek Harness (DSH) installation, not the simulated host of
`tests/fixtures/host.ts`. Nothing leaves the machine: GitHub, Feishu, DingTalk and the code host are local stubs, and the model is a scripted
local server. `pnpm test` does not run it.

## Run it

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm test:e2e
```

Requirements: Node.js 22.18+ (the fake CLIs run as `node file.ts` with type stripping), npm with access to the public
registry, python3, git, and tmux. `jq` is optional. A run takes about three minutes once DSH is cached. Most of that time is
waiting: a GitHub polling interval (60 s, the shortest the Source allows), the schedule Source's one-minute tick, and
restarts. The first run also installs DSH, which takes about a minute.

| Variable | Effect |
| --- | --- |
| `SUPERAGENT_CHECKOUT` | The dsh-superagent checkout under test, already built. Default: this checkout. Its `scripts/dsh-superagent` runs the service, it is linked into the profile, and its `.artifacts/` holds the startup logs while the run lasts. The harness and the fakes always come from this checkout |
| `SAE2E_API_AUTH` | How the management API client signs in, in `harness/api.ts` only. `browser` (default): `GET /?token=<launch token>` answers 303 with DSH's `dsh-auth-*` session cookie, which every request then carries. `connect`: `GET /connect?token=…` (302, an API operator's cookie). `none`: headers only. The token comes from the newest startup log. After a 401 the client signs in again once |
| `SAE2E_DSH_VERSION` | The DSH version to install. Default: `0.2.1-rc.3`, the one docs/006 pins |
| `SAE2E_DSH_CACHE` | Where the npm install of DSH is cached. Default: `node_modules/.cache/dsh-superagent-e2e` |
| `SAE2E_DSH_BIN` | Use this `dsh` executable instead of installing one |
| `SAE2E_TMP` | Parent of the run directory. Default: `node_modules/.cache/dsh-superagent-e2e-runs`. It must lie outside `/tmp` and the OS temp directory, because setup refuses a state directory that workers may write |
| `SAE2E_KEEP=1` | Keep the run directory. A failed run always keeps it, and its path is printed |
| `SAE2E_NO_TMUX=1` | Start `dsh --profile <p> --no-open` directly, as the script's tmux pane would. The harness does this anyway when tmux is missing. The script then still serves `status`, `stop` and the readiness check, but its `start` line output is not checked |

## What a run does

`harness/dsh.ts` follows [docs/006-deployment.md](../../docs/006-deployment.md):

1. It installs `@deepseek-ai/dsh` (cached) and creates a profile `sae2e-<pid>-<random>` from the Web template in a
   temporary `DSH_HOME`. Then it runs `dsh plugin --profile <p> add link:<checkout>`.
2. It writes the profile's `cordis.patch.yml` with a free port, a temporary `stateDir`, the `llm-deepseek` route's
   `baseURL` pointed at the scripted model, and the Feishu, schedule, DingTalk and code-host plugins enabled.
3. It starts the service with `scripts/dsh-superagent start` in a tmux server of its own (`TMUX_TMPDIR` is a short
   temporary directory). The service runs with a temporary `HOME` and without the caller's GitHub, DSH or model
   variables.
4. Teardown runs `stop`, kills the tmux server, moves the startup logs into the run directory, and removes the
   profile's control files from the checkout.

Fakes (`fakes/`, executed by Node with type stripping):

- `gh.ts`: answers `gh api` for the routes the bundle uses (user, repository, notifications, Issues, comments, pull
  requests, reviews, commits and checks, and `search/issues` with the qualifiers the schedule Source's searches use), plus
  `auth`, `pr` and `issue` writes. A search qualifier it does not know fails with 422. It reads from
  `fake-github/state.json`. It appends every call to `calls.jsonl` and every write (comments, pull request operations)
  to `writes.jsonl`. A request it does not know fails with 404 and is marked `unknown`; the suite asserts there are none.
  `--jq` uses `jq` when it is installed.
- `lark-cli.ts`: a bot-only app in strict mode `bot`. It answers the setup checks, the chat list, history and message
  reads, and records sends. `event consume` prints `[event] ready` and then emits the lines a test appends to
  `fake-lark/events.jsonl`.
- `dingtalk.ts`: runs in the test process, not as a CLI. One local HTTP server answers the OpenAPI routes the DingTalk
  Source calls (access token, Stream mode gateway, group and direct robot sends) for the app `FAKE_APP`, and serves the
  Stream mode WebSocket the gateway names, a minimal RFC 6455 server that pings every 20 seconds. `push` sends a robot
  message as a `CALLBACK` frame; requests and acknowledgements are kept for assertions.
- `codehost-adapter.ts`: a code-host adapter of contract version 1 ([docs/010](../../docs/010-codehost-adapter.md)). It
  answers `describe`, `whoami`, `repository`, `events` (paged by index into the world's event log; the first call answers
  the cursor of now), `thread`, `comments`, `comment` (once per `key`) and `git-credential get` from
  `fake-codehost/state.json`, which `codehost-world.ts` seeds and edits. It logs calls and posted comments like `gh.ts`,
  and an operation it does not answer fails with 501 and is marked `unknown`.
- `harness/mock-llm.ts`: a Messages-protocol SSE server. It classifies each request by the tools offered: the main
  Session has `orchestrator_route`, a worker `orchestrator_report`. `harness/script.ts` answers it.

## Scenarios (`superagent.e2e.ts`, in order, on one installation)

| | Verifies |
| --- | --- |
| (a) | `start` exits 3 and prints the setup problem (`repositoryUnset`). Saving the GitHub Source with a CLI path that does not exist answers 400 `agentCliMissing`, and `status` stays 3. Saving it with the fake `gh` answers `restarting: true`, and setup resolves with the agent account. Setup asked the fake `api user` and the push permission with `--jq`. `status` exits 0, and a full `restart` keeps the setup resolved |
| (b) | The documented shapes of `GET state`, `settings` and `sources`, `PUT settings/<block>` (saved, 409 for a stale revision, 400 with `issues`, 404 for an unknown Source), `POST executor/pause`, `POST setup/check` (refused once setup is complete), `GET`/`PUT prompts`, `POST policy-sync/github`, ticket retry and stop (404), and the same-origin fence |
| (c) | An Issue by an allowed login, then a comment by that login that mentions the agent, with its notification. The next poll creates a human Trigger on Thread `github:1`, visible through `GET threads` and `GET threads/github:1`. The main Session's next model request carries exactly one candidate, explicit and from that login. The Issue body, which mentions no one, does not become a candidate |
| (d) | The scripted main Session accepts. That records an accept Decision and a Ticket, and the acknowledgement is posted once through the fake `gh` with its idempotency marker. The worker Session starts (its id is the Assignment's `ref`). It runs `pwd` in `<stateDir>/work/fix-readme-typo-…`, which matches the Ticket's `directory`. In the same command it writes a file there, which works, writes one in the state directory, which the sandbox denies, and runs `gh pr merge`, which the shim refuses. Then it reports ready. The main Session receives the `worker_report` relay and sends the result, which is posted once through the fake `gh`. The Ticket ends `completed`. No unknown `gh` call was made, and `status` exits 0 |
| (e) | Saving the Feishu Source with the fake `lark-cli` restarts the service. Setup resolves the bot (`cli_e2efake` / `ou_e2ebot`), and the event consumer reports `feishu` ready. `status` exits 0 |
| (f) | `POST sources` adds `github-docs`, switched off, with the first Source's CLI, and restarts nothing. Saving it with the first Source's repository answers 400 `repositoryTwice`. Saving it with `acme/docs`, a second repository of the fake, restarts the service. Setup resolves both repositories on the one agent account with no warning, reads the second one's push access and review rules, and the second Source polls that repository's notifications and reports `github-docs` ready. `POST sources/github-docs/remove` restarts the service without it |
| (g) | With the panel headers but without the DeepSeek Harness cookie, `GET state` answers 200, and reading the settings, saving the Policy, pausing and accepting a Policy proposal answer 401 |
| (h) | Saving the schedule Source with one entry (`is:issue is:open no:assignee updated:<{now-48h}`) restarts nothing. Within a minute the entry's search runs through the fake `gh` as `api -X GET search/issues` with `repo:` added, and its one hit, an Issue untouched for three days, becomes a Trigger on that Issue's Thread with `human: false` and the entry as its actor; the recently active Issue gets none. The entry is not on the Policy's list, so the hit is ignored without a candidate for the main Session. After a full `restart` the Source reports the same period again and searches nothing more |
| (i) | Saving the DingTalk Source with a credentials file others may read answers 400 `dingtalkCredentialsExposed`. After `chmod 600` the save restarts the service; setup gets a token and opens the gateway, `accounts.dingtalk` is verified, `dingtalk` reports ready, and neither the settings nor the state hold the secret. With the sender's staff ID on the Policy's DingTalk list, a mention pushed over the connection becomes a human Trigger on Thread `dingtalk:<conversation>:<msgId>` and is acknowledged on the connection. The main Session gets it as an explicit candidate and accepts, and the acknowledgement and the result go to the group through `groupMessages/send`, each starting with `@Alice` |
| (j) | Saving the `codehost` Source with the fake adapter restarts the service. Setup resolves its repository beside GitHub's and warns about the operations the adapter lacks and the review rules it cannot check. After the Policy allows the login, a comment that mentions the agent, reported by `events`, becomes a Trigger on Thread `codehost:1` and an explicit candidate. The accept posts the acknowledgement through the adapter's `comment` once with its marker, the worker reports, and the result is posted once; nothing goes to GitHub, the Ticket ends `completed`, and no operation outside `describe` was asked |

## Not covered

- Real model behaviour: the script plays both roles, so prompts and model judgement are out of scope. Inferred
  candidates and Evals (`orchestrator_eval*`, Eval mode `auto`) are not driven, so a listed schedule entry's candidate
  is left to the unit tests.
- A Ticket from the second repository. The runtime tests check that its workers get that repository in `DSH_SUPERAGENT_GITHUB_REPOSITORY`.
- Code-host pull requests, CI and merges: the fake adapter answers none of `files`, `checks`, `approvals` or `merge`, so
  the unit tests (`tests/codehost.spec.ts`) cover them.
- Pull requests, CI and git pushes. A worker's `git push` would need GitHub. The fake `gh` refuses `auth git-credential`,
  so no credential would reach one.
- DingTalk direct messages, quotes, the Thread window, images and reconnects: the unit tests (`tests/dingtalk.spec.ts`) cover them.
- Feishu messages end to end: the fake can stream events from `events.jsonl`, but no scenario sends one yet.
- `scripts/dsh-superagent` reads `GET state` without a cookie. If a DSH sign-in also guards reads, the script's own
  checks, and therefore `start`/`status`, need that change too.
