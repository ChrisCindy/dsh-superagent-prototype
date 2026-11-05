/**
 * The DingTalk OpenAPI transport: `readDingtalkCredentials` reads the app's AppKey and AppSecret from where the Source's
 * configuration names them, `DingtalkApi` calls the OpenAPI with an access token it caches until shortly before it expires, and
 * `dingtalkApi` keeps one client per app. `DingtalkError` carries the HTTP status and DingTalk's error code
 *
 * The credentials are never stored: setup and every token request read them again from the file or the variable, so the
 * settings database, the deployment facts and the panel never hold them.
 */
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

/** The OpenAPI origin of DingTalk's public cloud; the Source's `endpoint` replaces it, such as for a test double. */
export const DINGTALK_API = 'https://api.dingtalk.com'
/** The Stream mode topic of robot messages: a group message that mentions the robot, or a direct message to it. */
export const TOPIC_ROBOT = '/v1.0/im/bot/messages/get'
const TIMEOUT_MS = 30_000
/** How long before its expiry an access token is fetched again. */
const TOKEN_MARGIN_MS = 5 * 60_000

/** The app's credentials: AppKey (Client ID), AppSecret (Client Secret) and the robot's code, which is the AppKey unless set. */
export interface DingtalkCredentials { appKey: string; appSecret: string; robotCode: string }
/** What setup resolves for the DingTalk Source: where its credentials are, the OpenAPI origin and the robot's code. */
export interface DingtalkApp { credentials: string; endpoint: string; robotCode: string }

const CredentialsSchema = z.object({ appKey: z.string().trim().min(1), appSecret: z.string().trim().min(1),
  robotCode: z.string().trim().min(1).optional() })
/** `env:NAME` names a variable whose value holds the credentials' JSON; DSH strips it from workers when NAME contains SECRET. */
const ENV = /^env:([A-Z_][A-Z0-9_]*)$/

/**
 * Why the credentials could not be read, which setup turns into its own problem codes: `unreadable` (the file or variable is
 * missing), `exposed` (group or others may read the file, or another user owns it), `malformed` (not the JSON described) or
 * `variable` (a variable name without SECRET, which DSH would pass on to workers).
 */
export class DingtalkCredentialsError extends Error {
  constructor(readonly reason: 'unreadable' | 'exposed' | 'malformed' | 'variable', message: string) { super(message) }
}
/** Whether `locator` has the form of a credentials location: an absolute path or `env:NAME`. */
export const credentialsLocator = (locator: string): boolean => isAbsolute(locator) || ENV.test(locator)

/**
 * Reads the app's credentials from `locator`: an absolute path to a regular file of the operator's that only its owner may read
 * (mode 0600 or 0400), or `env:NAME`, a variable of the host's process whose name contains SECRET. Both hold
 * `{"appKey": "…", "appSecret": "…"}`, with an optional `robotCode`.
 * @throws DingtalkCredentialsError, whose message never contains the secret.
 */
export async function readDingtalkCredentials(locator: string, env: NodeJS.ProcessEnv = process.env): Promise<DingtalkCredentials> {
  let text: string
  const variable = ENV.exec(locator)?.[1]
  if (variable) {
    if (!variable.includes('SECRET')) throw new DingtalkCredentialsError('variable', `The variable ${variable} does not contain SECRET in its name`)
    const value = env[variable]
    if (!value) throw new DingtalkCredentialsError('unreadable', `The variable ${variable} is not set`)
    text = value
  } else if (isAbsolute(locator)) {
    const file = await lstat(locator).catch(() => undefined)
    if (!file?.isFile()) throw new DingtalkCredentialsError('unreadable', `${locator} is not a regular file`)
    const owner = process.getuid?.()
    if ((file.mode & 0o077) !== 0 || (owner !== undefined && file.uid !== owner)) {
      throw new DingtalkCredentialsError('exposed', `${locator} has mode ${(file.mode & 0o777).toString(8)}; only its owner, the user dsh-superagent runs as, may read it (chmod 600)`)
    }
    text = await readFile(locator, 'utf8').catch((error: unknown) => {
      throw new DingtalkCredentialsError('unreadable', `${locator} cannot be read: ${(error as NodeJS.ErrnoException).code ?? 'error'}`)
    })
  } else throw new DingtalkCredentialsError('unreadable', 'The credentials are named by neither an absolute path nor env:NAME')
  let value: unknown
  try { value = JSON.parse(text) } catch { /* Reported below without echoing the text, which may hold the secret. */ }
  const parsed = CredentialsSchema.safeParse(value)
  if (!parsed.success) throw new DingtalkCredentialsError('malformed', 'The credentials are not JSON with appKey and appSecret')
  return { appKey: parsed.data.appKey, appSecret: parsed.data.appSecret, robotCode: parsed.data.robotCode ?? parsed.data.appKey }
}

/** The origin of `value` when it is an https URL, or an http one on the loopback interface (a local test double). */
export function dingtalkEndpoint(value: string, schemes: readonly string[] = ['https:', 'http:']): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${value} is not a URL`) }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!schemes.includes(url.protocol) || (url.protocol === schemes[1] && !loopback)) {
    throw new Error(`${value} must use ${schemes[0]}, or ${schemes[1]} on the loopback interface`)
  }
  return url.protocol.startsWith('http') ? url.origin : url.href
}

/**
 * A failed OpenAPI call: `status` is the HTTP status (0 when no answer came) and `code` DingTalk's error code, such as
 * `InvalidAuthentication`. The message carries DingTalk's own message, never the request.
 */
export class DingtalkError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}

const TokenSchema = z.object({ accessToken: z.string().min(1), expireIn: z.number().positive() })
const GatewaySchema = z.object({ endpoint: z.string().min(1), ticket: z.string().min(1) })
type Fetch = typeof globalThis.fetch

/**
 * Calls the DingTalk OpenAPI as one app. It reads the credentials when it needs a token, keeps the token in memory until five
 * minutes before it expires, fetches one token at a time, and fetches a new one once when DingTalk refuses the cached one.
 * The Source's loops, its Channel and its reads share one instance per app (`dingtalkApi`).
 */
export class DingtalkApi {
  private token?: { value: string; until: number }
  private fetching?: Promise<string>
  constructor(readonly app: DingtalkApp, private readonly fetcher: Fetch = globalThis.fetch, private readonly now: () => number = Date.now,
    private readonly env: NodeJS.ProcessEnv = process.env) {}
  credentials(): Promise<DingtalkCredentials> { return readDingtalkCredentials(this.app.credentials, this.env) }
  /** A valid access token, fetched with the credentials when none is cached or the cached one expires within five minutes. */
  accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.until > this.now()) return Promise.resolve(this.token.value)
    this.fetching ??= (async () => {
      try {
        const { appKey, appSecret } = await this.credentials()
        const answer = TokenSchema.parse(await this.request('/v1.0/oauth2/accessToken', { appKey, appSecret }, undefined, signal))
        this.token = { value: answer.accessToken, until: this.now() + answer.expireIn * 1000 - TOKEN_MARGIN_MS }
        return answer.accessToken
      } finally { this.fetching = undefined }
    })()
    return this.fetching
  }
  /** Forgets the cached token, so the next call fetches one. */
  expire(): void { this.token = undefined }
  /**
   * Calls `path` with `body` as the app and validates the answer.
   * @throws DingtalkError for a refused call; a refused token is fetched again once.
   */
  async call<T>(schema: z.ZodType<T>, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(signal)
      try { return schema.parse(await this.request(path, body, token, signal)) }
      catch (error) {
        const refused = error instanceof DingtalkError && (error.status === 401 || /InvalidAuthentication|token/i.test(error.code ?? ''))
        if (!refused || attempt > 0) throw error
        this.expire()
      }
    }
  }
  /** Opens a Stream mode connection for `topics`: the WebSocket endpoint and its one-time ticket. */
  async openStream(topics: readonly string[], signal?: AbortSignal): Promise<{ url: string }> {
    const { appKey, appSecret } = await this.credentials()
    const answer = GatewaySchema.parse(await this.request('/v1.0/gateway/connections/open', { clientId: appKey, clientSecret: appSecret,
      subscriptions: topics.map(topic => ({ type: 'CALLBACK', topic })), ua: 'dsh-superagent' }, undefined, signal))
    const endpoint = dingtalkEndpoint(answer.endpoint, ['wss:', 'ws:'])
    return { url: `${endpoint}${endpoint.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(answer.ticket)}` }
  }
  /** Downloads `url`, a temporary https link the OpenAPI returned, up to `maxBytes`. */
  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ data: Uint8Array; type: string }> {
    dingtalkEndpoint(url)
    const response = await this.fetcher(url, { signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...signal ? [signal] : []]) })
    if (!response.ok) throw new DingtalkError(`The download answered ${response.status}`, response.status)
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error('The file exceeds the deployment byte limit')
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body?.getReader()
    for (let read = await reader?.read(); read && !read.done; read = await reader!.read()) {
      size += read.value.byteLength
      if (size > maxBytes) { await reader!.cancel(); throw new Error('The file exceeds the deployment byte limit') }
      chunks.push(read.value)
    }
    const data = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    return { data, type: response.headers.get('content-type') ?? '' }
  }
  private async request(path: string, body: unknown, token: string | undefined, signal?: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(`${this.app.endpoint}${path}`, { method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...token ? { 'x-acs-dingtalk-access-token': token } : {} },
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...signal ? [signal] : []]) })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new DingtalkError(`DingTalk did not answer ${path}: ${error instanceof Error ? error.message : String(error)}`, 0)
    }
    const text = await response.text()
    let value: unknown
    try { value = text ? JSON.parse(text) : {} } catch { value = undefined }
    if (!response.ok) {
      const error = z.looseObject({ code: z.string().optional(), message: z.string().optional() }).safeParse(value).data
      throw new DingtalkError(`DingTalk refused ${path} (${response.status}${error?.code ? ` ${error.code}` : ''}): ${error?.message ?? text.slice(0, 300)}`,
        response.status, error?.code)
    }
    if (value === undefined) throw new DingtalkError(`DingTalk answered ${path} with something other than JSON`, response.status)
    return value
  }
}

const clients = new Map<string, DingtalkApi>()
/** The one client of `app`, so its token is fetched once for the Source's loops, its Channel and its reads. */
export function dingtalkApi(app: DingtalkApp): DingtalkApi {
  const id = JSON.stringify([app.credentials, app.endpoint, app.robotCode])
  let client = clients.get(id)
  if (!client) { client = new DingtalkApi(app); clients.set(id, client) }
  return client
}
