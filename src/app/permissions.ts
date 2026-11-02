/**
 * The permissions of managed Sessions: the permission preset each role runs under by the Executor's `sandbox` setting, and the
 * setup checks that the profile defines those presets and that no extra writable root opens the state DeepSeek Harness and
 * dsh-superagent keep.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Sandbox } from '../policy.ts'
import { SetupError } from '../setup.ts'

/** One permission preset as DSH's permission-presets service holds it: a sandbox mode and an approval policy. */
export interface PermissionSpec { sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; approval: 'ask' | 'never' }
/**
 * The permission presets managed Sessions run under, which the bundle's patch adds to the profile's preset table. Approval is
 * `never` throughout: a denied write fails at once, and a request to widen the sandbox is rejected without asking anyone, so a
 * worker is never left waiting for an approval no person watches. `danger-full-access` is DSH's own preset, which the
 * `full` sandbox setting falls back to.
 */
export const PERMISSION_PRESETS = {
  'superagent-router': { sandbox: 'read-only', approval: 'never' },
  'superagent-worker': { sandbox: 'workspace-write', approval: 'never' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
} as const satisfies Record<string, PermissionSpec>
export type PermissionPreset = keyof typeof PERMISSION_PRESETS

/** The preset a Session of `role` runs under: read-only for the main Session, its Ticket directory for a worker, or anywhere under `full`. */
export function permissionPreset(role: 'orchestrator' | 'worker', sandbox: Sandbox): PermissionPreset {
  if (sandbox === 'full') return 'danger-full-access'
  return role === 'orchestrator' ? 'superagent-router' : 'superagent-worker'
}

/** What setup reads of DSH's permission-presets service: the preset names and each one's bundle. */
export interface PresetTable { readonly names: readonly string[]; resolve(name: string): { sandbox: string; approval: string } }
/**
 * Refuse a profile whose preset table lacks a preset managed Sessions need under `sandbox`, or holds it with another bundle,
 * as when a profile layer replaced the bundle's permission row: a Session set to a missing preset would fail to start.
 * @throws SetupError (`permissionPresetMissing`) naming the first such preset.
 */
export function checkPresets(presets: PresetTable, sandbox: Sandbox): void {
  for (const name of new Set([permissionPreset('orchestrator', sandbox), permissionPreset('worker', sandbox)])) {
    const wanted = PERMISSION_PRESETS[name]
    const held = presets.names.includes(name) ? presets.resolve(name) : undefined
    if (held?.sandbox !== wanted.sandbox || held.approval !== wanted.approval) {
      throw new SetupError('permissionPresetMissing', { preset: name, sandbox: wanted.sandbox, approval: wanted.approval })
    }
  }
}

/** A path with its symbolic links resolved, as far as it exists; a missing tail is kept as written. */
function real(path: string): string {
  try { return realpathSync.native(path) }
  catch {
    const parent = dirname(path)
    return parent === path ? path : join(real(parent), basename(path))
  }
}
/** Whether `inner` is `outer` or lies inside it. */
const within = (inner: string, outer: string): boolean => {
  const path = relative(outer, inner)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** The directories no worker may write: the state directory, DSH's home, and the profile directory when DSH names it. */
export function protectedDirectories(stateDir: string, baseUrl: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  // DSH boots a profile from `<profile>/cordis.yml`, which makes the profile directory the base URL its plugins see.
  const profile = typeof baseUrl === 'string' && baseUrl.startsWith('file:') ? fileURLToPath(new URL('.', baseUrl)) : undefined
  return [stateDir, home, ...profile ? [profile] : []]
}

/**
 * Refuse, under the `workspace` sandbox, a protected directory inside a temporary area: DSH's `workspace-write` sandbox lets
 * every confined command write `/tmp` and the user's temporary directory, so a worker could rewrite a state directory, DSH
 * home or profile kept there. Under `full` every Session may write anywhere, which the setting itself states.
 * @throws SetupError (`protectedInTemporary`) naming the first such directory and the area that holds it.
 */
export function checkTemporaryAreas(protectedDirs: readonly string[], sandbox: Sandbox, temporaryAreas: readonly string[]): void {
  if (sandbox !== 'workspace') return
  for (const directory of protectedDirs) {
    const resolved = real(directory)
    const area = temporaryAreas.find(path => within(resolved, real(path)))
    if (area !== undefined) throw new SetupError('protectedInTemporary', { directory, temporary: area })
  }
}

/**
 * Refuse an extra writable root that contains or lies inside a protected directory, where a worker could rewrite the
 * database, the command shims, the profile or DSH's own state; then, under the `workspace` sandbox, a configured root the
 * composed sandbox does not grant, so it is not silently ignored. `granted` is the extra roots DSH's sandbox-policy service
 * grants every `workspace-write` call, `undefined` on a DSH that has no such grant; those roots are checked as well.
 * @throws SetupError (`writableRootProtected` or `writableRootUngranted`) naming the first such root.
 */
export function checkWritableRoots(roots: readonly string[], sandbox: Sandbox, protectedDirs: readonly string[],
  granted: readonly string[] | undefined): void {
  const guarded = protectedDirs.map(path => ({ path, real: real(path) }))
  for (const root of [...roots, ...granted ?? []]) {
    const resolved = real(root)
    const hit = guarded.find(dir => within(dir.real, resolved) || within(resolved, dir.real))
    if (hit) throw new SetupError('writableRootProtected', { root, protected: hit.path })
  }
  if (sandbox !== 'workspace') return
  const grants = (granted ?? []).map(real)
  const missing = roots.find(root => !grants.includes(real(root)))
  if (missing !== undefined) throw new SetupError('writableRootUngranted', { root: missing })
}
