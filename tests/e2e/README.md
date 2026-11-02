# End-to-end tests on a real DeepSeek Harness

`tests/e2e` runs dsh-superagent inside a real DeepSeek Harness (DSH) installation, not the simulated host of
`tests/fixtures/host.ts`. Nothing leaves the machine: GitHub and Feishu are local stubs, and the model is a scripted
local server. `pnpm test` does not run it.

## Run it

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm test:e2e
```

Requirements: Node.js 22.18+ (the fake CLIs run as `node file.ts` with type stripping), npm with access to the public
registry, python3, git, and tmux. `jq` is optional. A run takes about 80 s once DSH is cached. Most of that time is one
GitHub polling interval (60 s, the shortest the Source allows). The first run also installs DSH, which takes about a minute.

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
   `baseURL` pointed at the scripted model, and the Feishu plugin enabled.
3. It starts the service with `scripts/dsh-superagent start` in a tmux server of its own (`TMUX_TMPDIR` is a short
   temporary directory). The service runs with a temporary `HOME` and without the caller's GitHub, DSH or model
   variables.
4. Teardown runs `stop`, kills the tmux server, moves the startup logs into the run directory, and removes the
   profile's control files from the checkout.

Fakes (`fakes/`, executed by Node with type stripping):

- `gh.ts`: answers `gh api` for the routes the bundle uses (user, repository, notifications, Issues, comments, pull
  requests, reviews, commits and checks), plus `auth`, `pr` and `issue` writes. It reads from
  `fake-github/state.json`. It appends every call to `calls.jsonl` and every write (comments, pull request operations)
  to `writes.jsonl`. A request it does not know fails with 404 and is marked `unknown`; the suite asserts there are none.
  `--jq` uses `jq` when it is installed.
- `lark-cli.ts`: a bot-only app in strict mode `bot`. It answers the setup checks, the chat list, history and message
  reads, and records sends. `event consume` prints `[event] ready` and then emits the lines a test appends to
  `fake-lark/events.jsonl`.
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
| (f) | With the panel headers but without the DeepSeek Harness cookie, `GET state` answers 200, and reading the settings, saving the Policy, pausing and accepting a Policy proposal answer 401 |

## Not covered

- Real model behaviour: the script plays both roles, so prompts and model judgement are out of scope. Inferred
  candidates and Evals (`orchestrator_eval*`, Eval mode `auto`) are not driven.
- Pull requests, CI and git pushes. A worker's `git push` would need GitHub. The fake `gh` refuses `auth git-credential`,
  so no credential would reach one.
- Feishu messages end to end: the fake can stream events from `events.jsonl`, but no scenario sends one yet.
- `scripts/dsh-superagent` reads `GET state` without a cookie. If a DSH sign-in also guards reads, the script's own
  checks, and therefore `start`/`status`, need that change too.
