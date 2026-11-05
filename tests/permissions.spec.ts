/** The permission preset of each role, the preset check, and the writable roots: their form, the protected directories and the grant */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { checkPresets, checkTemporaryAreas, checkWritableRoots, permissionPreset, protectedDirectories } from '../src/app/permissions.ts'
import { SetupError } from '../src/setup.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { PRESET_TABLE, permissionPresets } from './fixtures/host.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-permissions-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const problem = (run: () => void) => { try { run() } catch (error) { if (error instanceof SetupError) return error.problem; throw error } }

it('runs the main Session read-only and a worker in its workspace, or both with full access under the escape hatch', () => {
  expect(permissionPreset('orchestrator', 'workspace')).toBe('superagent-router')
  expect(permissionPreset('worker', 'workspace')).toBe('superagent-worker')
  expect([permissionPreset('orchestrator', 'full'), permissionPreset('worker', 'full')]).toEqual(['danger-full-access', 'danger-full-access'])
})

it('requires the presets each sandbox setting uses, with the sandbox and the approval policy they stand for', () => {
  expect(problem(() => checkPresets(permissionPresets(), 'workspace'))).toBeUndefined()
  const { 'superagent-router': _router, ...withoutRouter } = PRESET_TABLE
  expect(problem(() => checkPresets(permissionPresets(withoutRouter), 'workspace'))).toMatchObject({ place: 'deployment',
    code: 'permissionPresetMissing', values: { preset: 'superagent-router', sandbox: 'read-only', approval: 'never' } })
  // A preset of the same name that would ask for approval is not ours: a worker would wait for a person nobody tells.
  const asking = { ...PRESET_TABLE, 'superagent-worker': { sandbox: 'workspace-write', approval: 'ask' } }
  expect(problem(() => checkPresets(permissionPresets(asking), 'workspace'))).toMatchObject({ values: { preset: 'superagent-worker' } })
  expect(problem(() => checkPresets(permissionPresets(withoutRouter), 'full'))).toBeUndefined()
})

it('protects the state directory, DSH_HOME, defaulting to ~/.dsh, and the profile directory DSH boots from', () => {
  const profile = join(directory, 'home', 'profiles', 'superagent')
  expect(protectedDirectories('/srv/state', pathToFileURL(`${profile}/`).href, { DSH_HOME: join(directory, 'home') }))
    .toEqual(['/srv/state', join(directory, 'home'), `${profile}/`])
  expect(protectedDirectories('/srv/state', undefined, {})).toEqual(['/srv/state', join(homedir(), '.dsh')])
})

it('refuses, under the workspace sandbox, a protected directory in a temporary area every worker may write', () => {
  const state = join(directory, 'state')
  mkdirSync(state)
  // DSH's workspace-write sandbox grants /tmp and the user's temporary directory to every confined command.
  expect(problem(() => checkTemporaryAreas([state], 'workspace', [directory]))).toMatchObject({ code: 'protectedInTemporary', values: { directory: state, temporary: directory } })
  expect(problem(() => checkTemporaryAreas([directory], 'workspace', [directory]))).toMatchObject({ code: 'protectedInTemporary' })
  // Through a symbolic link that resolves into the area, too.
  const outside = mkdtempSync(join(homedir(), '.dsh-superagent-permissions-'))
  try {
    const link = join(outside, 'state')
    symlinkSync(state, link)
    expect(problem(() => checkTemporaryAreas([link], 'workspace', [directory]))).toMatchObject({ code: 'protectedInTemporary', values: { directory: link } })
    expect(problem(() => checkTemporaryAreas([outside], 'workspace', [directory]))).toBeUndefined()
  } finally { rmSync(outside, { recursive: true, force: true }) }
  // A sibling whose name only starts with the area's is outside it; under full access every Session writes anywhere anyway.
  expect(problem(() => checkTemporaryAreas([`${directory}-other`], 'workspace', [directory]))).toBeUndefined()
  expect(problem(() => checkTemporaryAreas([state], 'full', [directory]))).toBeUndefined()
})

it('refuses a writable root that contains or lies inside a protected directory, also through a symbolic link', () => {
  const state = join(directory, 'state'), cache = join(directory, 'cache')
  mkdirSync(state); mkdirSync(cache)
  symlinkSync(state, join(directory, 'link'))
  const check = (roots: string[], granted: string[] | undefined = roots) => problem(() => checkWritableRoots(roots, 'workspace', [state], granted))
  expect(check([cache])).toBeUndefined()
  expect(check([directory])).toMatchObject({ place: 'execution', code: 'writableRootProtected', values: { root: directory, protected: state } })
  expect(check([join(state, 'worker-bin')])).toMatchObject({ code: 'writableRootProtected' })
  expect(check([join(directory, 'link', 'missing')])).toMatchObject({ code: 'writableRootProtected' })
  expect(check(['/'])).toMatchObject({ code: 'writableRootProtected' })
  // A root DSH's sandbox policy grants is checked too, even when the Execution settings do not name it.
  expect(check([], [directory])).toMatchObject({ code: 'writableRootProtected', values: { root: directory } })
})

it('refuses, under the workspace sandbox, a writable root the composed sandbox does not grant, which would otherwise be ignored', () => {
  const cache = join(directory, 'cache')
  mkdirSync(cache)
  expect(problem(() => checkWritableRoots([cache], 'workspace', [], undefined))).toMatchObject({ code: 'writableRootUngranted', values: { root: cache } })
  expect(problem(() => checkWritableRoots([cache], 'workspace', [], []))).toMatchObject({ code: 'writableRootUngranted' })
  expect(problem(() => checkWritableRoots([cache], 'workspace', [], [cache]))).toBeUndefined()
  expect(problem(() => checkWritableRoots([cache], 'full', [], undefined))).toBeUndefined()
})

it('takes writable roots as absolute paths without . or .. segments, trailing slashes dropped, and at most 16 of them', () => {
  const parse = (writableRoots: unknown) => ExecutorConfigSchema.safeParse({ writableRoots })
  expect(ExecutorConfigSchema.parse({})).toMatchObject({ sandbox: 'workspace', writableRoots: [] })
  expect(parse([' /home/me/src/widgets/.git/ ', '/']).data?.writableRoots).toEqual(['/home/me/src/widgets/.git', '/'])
  for (const roots of [['relative/path'], ['/home/me/../etc'], ['/a/./b'], ['/a', '/a/'], Array.from({ length: 17 }, (_, index) => `/r${index}`)]) {
    expect(parse(roots).success, JSON.stringify(roots)).toBe(false)
  }
  expect(ExecutorConfigSchema.safeParse({ sandbox: 'none' }).success).toBe(false)
})
