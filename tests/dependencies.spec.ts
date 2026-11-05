import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The modules of one Source, which only reach the application through the SourceKind contract and SourceHost. */
const SPECIFIC = /^src\/sources\/(github|feishu)[^/]*$/

/** Each module that `file` imports, statically or dynamically, as a path relative to the repository root. */
function imports(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8')
  return [...text.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)].map(match => relative(ROOT, resolve(ROOT, dirname(file), match[1]!)))
}

it('keeps src/app free of imports of a specific Source', () => {
  const files = readdirSync(join(ROOT, 'src/app'), { recursive: true, encoding: 'utf8' }).filter(path => /\.tsx?$/.test(path))
    .map(path => `src/app/${path}`)
  expect(files.length).toBeGreaterThan(0)
  expect(files.flatMap(file => imports(file).filter(target => SPECIFIC.test(target)).map(target => `${file} → ${target}`))).toEqual([])
})
