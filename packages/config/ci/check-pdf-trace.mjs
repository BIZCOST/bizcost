import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

// CI check (D-353): the hosted API function can make a PDF. A Vercel function has only the files its
// build traced, so a package the bundler never saw works on every machine with a node_modules folder
// and fails on the first PDF once deployed (Turbopack's outputFileTracingIncludes skips node_modules;
// documents/pdf/deploy-trace.ts is what puts the compiler in the trace). This copies the files of the
// API function's trace, and nothing else, to an empty folder outside the repository, starts the PDF
// worker there from apps/web as the function does, and renders with the compiler and the four fonts.
//
//   node packages/config/ci/check-pdf-trace.mjs <next build folder>   (e.g. apps/web/.next)

const PDF_DIR = 'packages/api/src/documents/pdf'
const ROUTE = 'server/app/api/trpc/[trpc]/route.js.nft.json'

/** What the worker reads or imports when it starts; a missing one fails with its name, not a stack. */
export const REQUIRED_FILES = [
  `${PDF_DIR}/worker.mjs`,
  `${PDF_DIR}/typst-core.mjs`,
  `${PDF_DIR}/templates/document.typ`,
  `${PDF_DIR}/fonts/IBMPlexSans-Regular.ttf`,
  `${PDF_DIR}/fonts/IBMPlexSans-Bold.ttf`,
  `${PDF_DIR}/fonts/IBMPlexSansArabic-Regular.ttf`,
  `${PDF_DIR}/fonts/IBMPlexSansArabic-Bold.ttf`,
  'node_modules/@myriaddreamin/typst.ts/package.json',
  'node_modules/@myriaddreamin/typst-ts-web-compiler/package.json',
  'node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
]

/** Which of REQUIRED_FILES a trace (its files, relative to the repository, with `/`) leaves out. */
export function missingFromTrace(files) {
  const traced = new Set(files)
  return REQUIRED_FILES.filter((file) => !traced.has(file))
}

/** The files of the API function's trace, relative to the repository. */
export function tracedFiles(buildDir, repoRoot) {
  const trace = join(buildDir, ROUTE)
  const { files } = JSON.parse(readFileSync(trace, 'utf8'))
  return files.map((file) =>
    relative(repoRoot, resolve(dirname(trace), file))
      .split(sep)
      .join('/'),
  )
}

/** A short document in both scripts: the compiler, its WebAssembly and the fonts all have to work. */
const SAMPLE = '#set text(font: ("IBM Plex Sans", "IBM Plex Sans Arabic"))\nBizCost مرحبًا *1.00*\n'

/** Runs from the copy, in a process of its own: renders the sample in the copy's worker. */
function renderInWorker(workerPath) {
  const worker = new Worker(workerPath)
  const fail = (message) => {
    console.error(`The traced PDF worker failed: ${message}`)
    process.exit(1)
  }
  worker.on('error', (error) => fail(error.message))
  worker.on('message', (message) => {
    if (message.ready) {
      worker.postMessage({ id: 1, kind: 'render', template: SAMPLE, data: '{}', images: [] })
      return
    }
    if (!message.ok) fail(message.error)
    const head = new TextDecoder().decode(message.pdf.subarray(0, 5))
    if (head !== '%PDF-') fail('the answer is not a PDF')
    console.log(`The traced PDF worker rendered a PDF of ${message.pdf.byteLength} bytes.`)
    void worker.terminate()
  })
}

function main(buildArg) {
  if (!buildArg) {
    console.error('Usage: check-pdf-trace.mjs <next build folder>')
    return 2
  }
  const repoRoot = process.cwd()
  const files = tracedFiles(resolve(buildArg), repoRoot)
  const missing = missingFromTrace(files)
  if (missing.length > 0) {
    console.error(`The API function's trace leaves out:\n  ${missing.join('\n  ')}`)
    return 1
  }
  const copy = mkdtempSync(join(tmpdir(), 'bizcost-pdf-trace-'))
  try {
    let bytes = 0
    for (const file of files) {
      const from = join(repoRoot, file)
      if (!existsSync(from) || !statSync(from).isFile()) continue
      const to = join(copy, file)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      bytes += statSync(from).size
    }
    console.log(
      `The API function's trace: ${files.length} files, ${Math.round(bytes / 1048576)} MB.`,
    )
    const cwd = join(copy, 'apps/web')
    mkdirSync(cwd, { recursive: true })
    const run = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--render', join(copy, PDF_DIR, 'worker.mjs')],
      { cwd, stdio: 'inherit', timeout: 120_000 },
    )
    return run.status ?? 1
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [first, second] = process.argv.slice(2)
  if (first === '--render') renderInWorker(second)
  else process.exit(main(first))
}
