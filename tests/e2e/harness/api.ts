/**
 * Client of the management API (docs/006-deployment.md, Management API), with DeepSeek Harness's launch-token sign-in.
 *
 * Authentication lives in one place, `Auth`, chosen by `SAE2E_API_AUTH`:
 * - `browser` (default): `GET /?token=<launch token>` answers 303 with DeepSeek Harness's `dsh-auth-*` session cookie,
 *   the one the Web panel holds; it is sent on every request.
 * - `connect`: `GET /connect?token=<launch token>` answers 302 with an API operator's `dsh-auth-*` cookie.
 * - `none`: only the loopback host and `x-orchestrator-request: 1`, which is all the orchestrator routes need today.
 * The launch token is the one printed in the newest startup log (`dsh web: http://…/?token=…`). A 401 makes the client
 * sign in again once, because a restarted process prints a new token.
 */
export interface ApiAnswer<T = unknown> { status: number; body: T }

export interface Auth {
  /** Headers to add to a request; may log in first. */
  headers(): Promise<Record<string, string>>
  /** Forget the credential after a 401 so the next `headers()` logs in again; false when there is nothing to renew. */
  renew(): boolean
}
export const noAuth: Auth = { headers: async () => ({}), renew: () => false }

/** Exchanges the launch token at `path` (`/` or `/connect`) for a `dsh-auth-*` cookie, and sends it until a 401. */
export class LaunchTokenCookieAuth implements Auth {
  private cookie?: string
  private readonly origin: string
  private readonly path: string
  private readonly token: () => string | undefined
  constructor(origin: string, path: '/' | '/connect', token: () => string | undefined) { this.origin = origin; this.path = path; this.token = token }
  async headers(): Promise<Record<string, string>> {
    if (!this.cookie) {
      const token = this.token()
      if (!token) throw new Error('No DeepSeek Harness launch token in the startup log')
      const response = await fetch(`${this.origin}${this.path}?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
      const set = response.headers.getSetCookie().find(value => value.startsWith('dsh-auth-'))
      if (!set) throw new Error(`GET ${this.path}?token= answered ${response.status} without a dsh-auth cookie`)
      this.cookie = set.split(';')[0]!
    }
    return { cookie: this.cookie }
  }
  renew(): boolean { const had = !!this.cookie; this.cookie = undefined; return had }
}

export class ManagementApi {
  readonly origin: string
  private readonly auth: Auth
  constructor(origin: string, auth: Auth = noAuth) { this.origin = origin; this.auth = auth }
  /** One request to `/orchestrator/api/<path>`; resolves with any status, rejects only when the server does not answer. */
  async request<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiAnswer<T>> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.origin}/orchestrator/api/${path}`, {
        method, signal: AbortSignal.timeout(30_000),
        headers: { 'x-orchestrator-request': '1', ...body === undefined ? {} : { 'content-type': 'application/json' },
          ...await this.auth.headers(), ...headers },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
      const text = await response.text()
      if (response.status === 401 && attempt === 0 && this.auth.renew()) continue
      let parsed: unknown = text
      try { parsed = JSON.parse(text) } catch { /* Not JSON: kept as text. */ }
      return { status: response.status, body: parsed as T }
    }
  }
  /** GET that must answer 200. */
  async get<T = any>(path: string): Promise<T> { return ok(await this.request<T>('GET', path), `GET ${path}`) }
  async put<T = any>(path: string, body: unknown): Promise<T> { return ok(await this.request<T>('PUT', path, body), `PUT ${path}`) }
  async post<T = any>(path: string, body: unknown = {}): Promise<T> { return ok(await this.request<T>('POST', path, body), `POST ${path}`) }
  /** Saves one settings block at its current revision, as the docs' curl example does. */
  async saveBlock(block: string, value: unknown): Promise<ApiAnswer<any>> {
    const settings = await this.get('settings')
    const revision = block.startsWith('source:') ? settings.sources.find((source: { id: string }) => source.id === block.slice(7))?.revision
      : settings.blocks[block]?.revision
    return this.request('PUT', `settings/${block}`, { value, revision: revision ?? 0 })
  }
}
function ok<T>(answer: ApiAnswer<T>, what: string): T {
  if (answer.status !== 200) throw new Error(`${what} answered ${answer.status}: ${JSON.stringify(answer.body)}`)
  return answer.body
}

/** The Auth the environment asks for (`SAE2E_API_AUTH`: `browser`, the default, `connect` or `none`). */
export function authFromEnvironment(origin: string, token: () => string | undefined): Auth {
  const mode = process.env.SAE2E_API_AUTH || 'browser'
  if (mode === 'none') return noAuth
  if (mode === 'browser') return new LaunchTokenCookieAuth(origin, '/', token)
  if (mode === 'connect') return new LaunchTokenCookieAuth(origin, '/connect', token)
  throw new Error(`SAE2E_API_AUTH must be browser, connect or none, not ${mode}`)
}
