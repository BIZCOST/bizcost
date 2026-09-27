import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// CI check: no *.supabase.co host in what a browser (or, later, the mobile app) receives
// (docs/ARCHITECTURE.md §Network exposure: *.supabase.co has been blocked in the UAE and in India, so
// clients reach Supabase only through the custom domain). It scans a build's client output:
//
//   node packages/config/ci/check-bundle-hosts.js <dir>... [--expect <text>]...
//
// A Next.js build folder (it has static/) is scanned in static/ (the browser code) and in the
// prerendered pages under server/app and server/pages (HTML and RSC payloads; not the server's own
// .js). Any other folder (e.g. an `expo export` dist/) is scanned whole. Source maps are skipped: the
// browser never runs them, and they carry the libraries' doc comments.
//
// `--expect` names text the scan must find (e.g. the dummy public Supabase URL the CI build inlines),
// so a build that put its client code elsewhere cannot pass by scanning nothing.

const NEEDLE = 'supabase.co'
const HOST_CHAR = /[a-z0-9.*-]/
const LABEL_CHAR = /[a-z0-9-]/

/**
 * Host patterns that are not addresses the client contacts. supabase-js puts `*.supabase.co` in its
 * default trace-propagation targets (a hostname pattern it compares URLs with).
 */
export const ALLOWED_HOSTS = new Set(['*.supabase.co'])

/** Every `…supabase.co` host in `text` (not `supabase.com`), with its offset. */
export function findSupabaseHosts(text) {
  const lower = text.toLowerCase()
  const found = []
  let at = lower.indexOf(NEEDLE)
  while (at !== -1) {
    const end = at + NEEDLE.length
    if (!LABEL_CHAR.test(lower[end] ?? '')) {
      let start = at
      while (start > 0 && HOST_CHAR.test(lower[start - 1])) start--
      found.push({ host: lower.slice(start, end), index: start })
    }
    at = lower.indexOf(NEEDLE, end)
  }
  return found
}

function walk(dir, include) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path, include))
    else if (entry.isFile() && include(path)) files.push(path)
  }
  return files
}

const notSourceMap = (path) => !path.endsWith('.map')
/** Prerendered output served to browsers: everything but the server's own code and manifests. */
const prerendered = (path) => notSourceMap(path) && !/\.(c|m)?js$|\.json$/.test(path)

/** The files of `root` that reach clients (see the header). */
export function clientFiles(root) {
  if (!existsSync(join(root, 'static'))) return walk(root, notSourceMap)
  const files = walk(join(root, 'static'), notSourceMap)
  for (const sub of ['server/app', 'server/pages']) {
    const dir = join(root, sub)
    if (existsSync(dir)) files.push(...walk(dir, prerendered))
  }
  return files
}

/** Scans the client files of every root. `expect`: texts that must appear in them. */
export function scan(roots, expect = []) {
  const problems = []
  const missing = new Set(expect)
  let fileCount = 0
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      problems.push({ file: root, message: 'is not a folder (build first)' })
      continue
    }
    for (const file of clientFiles(root)) {
      fileCount++
      const text = readFileSync(file, 'utf8')
      for (const value of missing) if (text.includes(value)) missing.delete(value)
      for (const { host, index } of findSupabaseHosts(text)) {
        if (ALLOWED_HOSTS.has(host)) continue
        const context = text.slice(Math.max(0, index - 60), index + host.length + 60)
        problems.push({
          file: relative(process.cwd(), file),
          message: `contains ${host}: …${context.replace(/\s+/g, ' ')}…`,
        })
      }
    }
  }
  if (fileCount === 0 && problems.length === 0) {
    problems.push({ file: roots.join(', '), message: 'no client files found' })
  }
  for (const value of missing) {
    problems.push({
      file: roots.join(', '),
      message: `expected text "${value}" not found: the scan does not cover the client build`,
    })
  }
  return { fileCount, problems }
}

function parseArgs(argv) {
  const roots = []
  const expect = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--expect') {
      const value = argv[++i]
      if (!value) throw new Error('--expect needs a value')
      expect.push(value)
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`)
    } else {
      roots.push(resolve(arg))
    }
  }
  if (roots.length === 0) throw new Error('name at least one build folder')
  return { roots, expect }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`check-bundle-hosts: ${error.message}`)
    console.error('usage: node check-bundle-hosts.js <build dir>... [--expect <text>]...')
    process.exit(2)
  }
  const { fileCount, problems } = scan(args.roots, args.expect)
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p.file}: ${p.message}`)
    console.error(
      `\nNo client build may name a *.supabase.co host: clients use the Supabase custom domain ` +
        `(docs/ARCHITECTURE.md §Network exposure).`,
    )
    process.exit(1)
  }
  console.log(`✓ no *.supabase.co host in ${fileCount} client files`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
