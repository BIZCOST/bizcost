import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import 'server-only'

// The PDF engine (M3 Step 7; D-224, D-295): Typst in a worker thread of the API's function, never on
// its main thread, one job at a time (the others wait their turn). A job is a render, or a probe (one
// image decoded to see that it can be, at upload). The worker is replaced after `maxRenders` jobs (50
// to start) or once the process's memory passes `maxRssBytes` (1 GB to start), counted after every
// job, a failed one too (the compiler's WebAssembly memory grows with every distinct PDF and is never
// given back until its worker ends), and before a render whose images could take it past the limit
// (they are decoded whole: about twice their decoded size while it renders). A job that takes longer
// than `timeoutMs` ends its worker (the next one starts a new one). At most `maxQueued` jobs wait, each
// at most `queueTimeoutMs`: past either the engine is busy (PdfBusyError), never an unbounded wait.
// Creating a worker costs about 0.2 s and its first PDF about 1.1 s more on 1 vCPU; later PDFs about
// 0.2 s.

export interface PdfImageFile {
  /** /img/<key>.<png|jpg|webp>: set by the server only. */
  readonly path: string
  readonly bytes: Uint8Array
}

export interface PdfRenderRequest {
  /** The Typst source; the default document template when left out. */
  readonly template?: string
  /** The JSON text of the document's data (DocumentPdfInput). */
  readonly data: string
  readonly images: readonly PdfImageFile[]
  /** What its images take decoded, in bytes (images.ts); 0 when left out. */
  readonly decodedBytes?: number
}

export interface PdfEngineOptions {
  /** The worker script; found next to this file (the package's own folder) by default. */
  readonly workerPath?: string
  readonly maxRenders?: number
  readonly maxRssBytes?: number
  readonly timeoutMs?: number
  readonly maxQueued?: number
  readonly queueTimeoutMs?: number
}

export const PDF_WORKER_MAX_RENDERS = 50
export const PDF_WORKER_MAX_RSS_BYTES = 1024 * 1024 * 1024
export const PDF_RENDER_TIMEOUT_MS = 30_000
export const PDF_MAX_QUEUED = 24
export const PDF_QUEUE_TIMEOUT_MS = 60_000
/** How much memory a render takes per byte of its images decoded (measured: 1–2×). */
const DECODE_FACTOR = 2

/** The engine is busy: too many jobs wait, or this one waited too long (try again shortly). */
export class PdfBusyError extends Error {
  constructor() {
    super('the PDF engine is busy')
    this.name = 'PdfBusyError'
  }
}

/** What the compiler refused (its own words, never the data). */
export class CompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompileError'
  }
}

/**
 * The folder of the PDF service (worker.mjs, templates/, fonts/). Next bundles this module, so its
 * own URL may not point at the source: the folder is looked for there first, then from the working
 * directory (apps/web, packages/api, or the repository) through the workspace's packages, and
 * BIZCOST_PDF_DIR (the hosted deploy, ARCHITECTURE.md §API "PDFs") comes before both.
 */
export function pdfServiceDir(): string {
  const candidates: string[] = []
  const configured = process.env.BIZCOST_PDF_DIR
  if (configured) candidates.push(configured)
  try {
    candidates.push(fileURLToPath(new URL('.', import.meta.url)))
  } catch {
    // Not a file URL (a bundled module): the working directory below.
  }
  const cwd = process.cwd()
  const inPackage = join('src', 'documents', 'pdf')
  candidates.push(
    join(cwd, inPackage),
    join(cwd, 'packages', 'api', inPackage),
    join(cwd, '..', '..', 'packages', 'api', inPackage),
    join(cwd, 'node_modules', '@bizcost', 'api', inPackage),
    join(cwd, '..', '..', 'node_modules', '@bizcost', 'api', inPackage),
  )
  const found = candidates.find((dir) => existsSync(join(dir, 'worker.mjs')))
  if (!found) throw new Error('the PDF service folder (worker.mjs) was not found')
  return found
}

interface Pending {
  readonly resolve: (value: Uint8Array | null) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** A worker thread with its compiler, and how many jobs it did. */
interface Running {
  readonly worker: Worker
  readonly ready: Promise<void>
  renders: number
  rss: number
  retiring: boolean
}

type Job =
  | { readonly kind: 'render'; readonly request: PdfRenderRequest }
  | { readonly kind: 'probe'; readonly image: PdfImageFile }

export class PdfEngine {
  private readonly options: Required<PdfEngineOptions>
  private running: Running | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /** How many workers this engine started (the tests read it). */
  workersStarted = 0

  constructor(options: PdfEngineOptions = {}) {
    this.options = {
      workerPath: options.workerPath ?? join(pdfServiceDir(), 'worker.mjs'),
      maxRenders: options.maxRenders ?? PDF_WORKER_MAX_RENDERS,
      maxRssBytes: options.maxRssBytes ?? PDF_WORKER_MAX_RSS_BYTES,
      timeoutMs: options.timeoutMs ?? PDF_RENDER_TIMEOUT_MS,
      maxQueued: options.maxQueued ?? PDF_MAX_QUEUED,
      queueTimeoutMs: options.queueTimeoutMs ?? PDF_QUEUE_TIMEOUT_MS,
    }
  }

  /** The PDF's bytes; jobs wait for each other (one compiler, one job at a time). */
  async render(request: PdfRenderRequest): Promise<Uint8Array> {
    const pdf = await this.enqueue({ kind: 'render', request })
    if (!pdf) throw new Error('the PDF worker gave no PDF')
    return pdf
  }

  /**
   * Whether the compiler decodes `image` (measured, never printed): `ok: false` with what it said when
   * it cannot. A timeout, a stopped worker or a busy engine rejects.
   */
  async probe(image: PdfImageFile): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.enqueue({ kind: 'probe', image })
      return { ok: true }
    } catch (error) {
      if (error instanceof CompileError) return { ok: false, reason: error.message }
      throw error
    }
  }

  /** Ends the worker (a test's end, a server's shutdown). */
  async close(): Promise<void> {
    const running = this.running
    this.running = null
    if (running) {
      running.retiring = true
      await running.worker.terminate()
    }
  }

  private enqueue(job: Job): Promise<Uint8Array | null> {
    if (this.waiting >= this.options.maxQueued) return Promise.reject(new PdfBusyError())
    this.waiting += 1
    let expired = false
    let giveUp: (error: Error) => void = () => undefined
    const gaveUp = new Promise<never>((_, reject) => (giveUp = reject))
    gaveUp.catch(() => undefined)
    const timer = setTimeout(() => {
      // Still waiting for its turn: skipped when it comes.
      expired = true
      this.waiting -= 1
      giveUp(new PdfBusyError())
    }, this.options.queueTimeoutMs)
    const turn = this.queue.then(async () => {
      if (expired) return null
      clearTimeout(timer)
      this.waiting -= 1
      return this.runNow(job)
    })
    this.queue = turn.catch(() => undefined)
    return Promise.race([turn, gaveUp])
  }

  private start(): Running {
    const worker = new Worker(this.options.workerPath)
    this.workersStarted += 1
    worker.unref()
    let markReady: () => void = () => undefined
    let failStart: (error: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failStart = reject
    })
    ready.catch(() => undefined)
    const running: Running = { worker, ready, renders: 0, rss: 0, retiring: false }
    worker.on('message', (message: WorkerMessage) => {
      if ('ready' in message) {
        markReady()
        return
      }
      running.rss = message.rss
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.pdf ?? null)
      else pending.reject(new CompileError(message.error))
    })
    const fail = (error: Error) => {
      failStart(error)
      if (this.running === running) this.running = null
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(error)
        this.pending.delete(id)
      }
    }
    worker.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', (code) => {
      if (!running.retiring) fail(new Error(`the PDF worker stopped (${code})`))
      else if (this.running === running) this.running = null
    })
    return running
  }

  private async runNow(job: Job): Promise<Uint8Array | null> {
    // A render whose images could take the worker past its memory limit starts on a new one.
    const expected = job.kind === 'render' ? (job.request.decodedBytes ?? 0) * DECODE_FACTOR : 0
    const current = this.running
    if (current && current.renders > 0 && current.rss + expected >= this.options.maxRssBytes) {
      await this.retire(current)
    }
    const running = this.running ?? (this.running = this.start())
    await running.ready
    const id = this.nextId++
    try {
      return await new Promise<Uint8Array | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error('the PDF took too long'))
          void this.retire(running)
        }, this.options.timeoutMs)
        this.pending.set(id, { resolve, reject, timer })
        if (job.kind === 'probe') {
          running.worker.postMessage({ id, kind: 'probe', image: job.image })
        } else {
          const { template, data, images } = job.request
          running.worker.postMessage({ id, kind: 'render', template, data, images })
        }
      })
    } finally {
      // Counted after every job, a failed one too: a failure keeps the memory it grew.
      running.renders += 1
      if (
        !running.retiring &&
        (running.renders >= this.options.maxRenders || running.rss >= this.options.maxRssBytes)
      ) {
        await this.retire(running)
      }
    }
  }

  private async retire(running: Running): Promise<void> {
    running.retiring = true
    if (this.running === running) this.running = null
    await running.worker.terminate()
  }
}

type WorkerMessage =
  | { ready: true }
  | { id: number; ok: true; pdf?: Uint8Array; rss: number }
  | { id: number; ok: false; error: string; rss: number }

let shared: PdfEngine | null = null

/** The process's engine (one worker at a time, replaced as above). */
export function pdfEngine(): PdfEngine {
  shared ??= new PdfEngine()
  return shared
}
