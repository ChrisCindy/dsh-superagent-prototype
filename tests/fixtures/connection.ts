/**
 * A stand-in for DeepSeek Harness's Host Connection (`ctx.connection`): it admits a request as the operator when the request
 * carries `OPERATOR_COOKIE` and answers 401 otherwise, as the real one does for a missing browser session cookie.
 */
import type { HostConnectionHandle, PeerAdmission } from '@deepseek-ai/dsh-client-connection'

/** The `cookie` header the fake accepts as a signed-in browser session. */
export const OPERATOR_COOKIE = 'dsh_session=operator'
/** The headers the panel sends from a signed-in DeepSeek Harness page. */
export const PANEL_HEADERS = { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', cookie: OPERATOR_COOKIE }

/** Build the fake Connection; `admitted` records each request it was asked to admit. */
export function fakeConnection() {
  const operator = { id: 'operator' }
  const admitted: unknown[] = []
  const admit = (request: { headers: Record<string, unknown> }): PeerAdmission => {
    admitted.push(request)
    return request.headers.cookie === OPERATOR_COOKIE ? { peer: operator as never } : { rejection: 401 }
  }
  return { operator, admit, admitted } satisfies Partial<Record<keyof HostConnectionHandle, unknown>> & { admitted: unknown[] }
}
