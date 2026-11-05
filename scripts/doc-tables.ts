/**
 * Writes the module and test tables of docs/007-architecture.md from the files themselves: each row is a file's path and the
 * first paragraph of the comment that opens it. Run `node scripts/doc-tables.ts` after adding, removing or redescribing a file;
 * `tests/docs.spec.ts` fails while the tables differ from what this writes.
 *
 * The rows keep the order the document has; a new file goes after the last row of its directory. In a description,
 * `docs/NNN-name.md` becomes a link to that numbered document, titled by its heading.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository's root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The document the tables are in, relative to the root. */
export const DOCUMENT = 'docs/007-architecture.md'

/** One generated table: its marker name, its header and the files it lists. */
interface Table { name: string; header: string; files: (root: string) => string[] }

const filesUnder = (root: string, directory: string): string[] =>
  readdirSync(join(root, directory), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split('\\').join('/')).sort()

const TABLES: Table[] = [
  { name: 'modules', header: '| Path | Responsibility |\n| --- | --- |', files: root => filesUnder(root, 'src') },
  { name: 'tests', header: '| Test | Covers |\n| --- | --- |',
    files: root => filesUnder(root, 'tests').filter(path => /\.(spec|e2e)\.tsx?$/.test(path)) },
]

/**
 * The first paragraph of the comment a file opens with, on one line. A `#!` line and `//` lines that carry a
 * `@vitest-environment` pragma may come before it.
 */
export function description(text: string): string | undefined {
  const lines = text.split('\n')
  let start = 0
  while (start < lines.length && /^(#!|\/\/\s*@vitest-environment\b)/.test(lines[start]!)) start++
  const match = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(lines.slice(start).join('\n'))
  if (!match) return undefined
  const body = match[1]!.split('\n').map(line => line.replace(/^\s*\* ?/, '').trim())
  const paragraph: string[] = []
  for (const line of body) {
    if (line) paragraph.push(line)
    else if (paragraph.length) break
  }
  return paragraph.join(' ').trim() || undefined
}

/** Where the rows of the table `name` lie in a document, between its markers, or undefined when a marker is missing. */
function markers(document: string, name: string): { start: number; end: number } | undefined {
  const open = `<!-- ${name}:start (scripts/doc-tables.ts) -->`
  const close = `<!-- ${name}:end -->`
  const start = document.indexOf(open)
  const end = document.indexOf(close)
  return start < 0 || end < start ? undefined : { start: start + open.length, end }
}

/** The files the existing rows name, in their order. */
function order(rows: string): string[] {
  return [...rows.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]!)
}

/** `files` in the order of `previous`, with each new file after the last listed one of its directory, or at the end. */
export function ordered(files: string[], previous: string[]): string[] {
  const result = previous.filter(path => files.includes(path))
  for (const path of files.filter(file => !result.includes(file))) {
    const directory = dirname(path)
    const last = result.findLastIndex(item => dirname(item) === directory)
    result.splice(last < 0 ? result.length : last + 1, 0, path)
  }
  return result
}

/** A description as a table cell: numbered documents as links, pipes escaped. */
function cell(root: string, text: string): string {
  return text.replace(/\|/g, '\\|').replace(/(?<![`/\w])docs\/(\d{3}-[a-z0-9-]+\.md)(?![`\w])/g, (_, name: string) => {
    const heading = /^# (.+)$/m.exec(readFileSync(join(root, 'docs', name), 'utf8'))?.[1] ?? name
    return `[${heading}](${name})`
  })
}

/** The document with its tables written from the files under `root`; throws for a file without a description. */
export function render(root = ROOT): string {
  let document = readFileSync(join(root, DOCUMENT), 'utf8')
  const missing: string[] = []
  for (const table of TABLES) {
    const place = markers(document, table.name)
    if (!place) throw new Error(`${DOCUMENT} has no ${table.name} markers`)
    const rows = ordered(table.files(root), order(document.slice(place.start, place.end))).map(path => {
      const text = description(readFileSync(join(root, path), 'utf8'))
      if (!text) missing.push(path)
      return `| \`${path}\` | ${cell(root, text ?? '')} |`
    })
    document = `${document.slice(0, place.start)}\n\n${table.header}\n${rows.join('\n')}\n\n${document.slice(place.end)}`
  }
  if (missing.length) throw new Error(`These files open with no descriptive comment: ${missing.join(', ')}`)
  return document
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const document = render()
  if (document === readFileSync(join(ROOT, DOCUMENT), 'utf8')) console.log(`${DOCUMENT} is up to date`)
  else {
    writeFileSync(join(ROOT, DOCUMENT), document)
    console.log(`wrote ${DOCUMENT}`)
  }
}
