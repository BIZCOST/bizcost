// The worker thread that renders the documents' PDFs (M3 Step 7; D-224): one Typst compiler, one
// render at a time, off the API's main thread (a render holds its thread for its whole length). The
// engine (engine.ts) replaces this worker after a number of jobs or once the process's memory passes
// a limit: the compiler's WebAssembly memory grows with every distinct PDF and is never given back
// until the worker ends. Every answer, a failure's too, says how much memory the process holds
// (D-295). A job is a render, or a probe: one image decoded to see that it can be (uploads).

import { parentPort } from 'node:worker_threads'
import { createCore } from './typst-core.mjs'

const core = await createCore()

parentPort.on('message', async (message) => {
  try {
    if (message.kind === 'probe') {
      await core.probe(message.image)
      parentPort.postMessage({ id: message.id, ok: true, rss: process.memoryUsage().rss })
      return
    }
    const pdf = await core.render(message)
    parentPort.postMessage({ id: message.id, ok: true, pdf, rss: process.memoryUsage().rss }, [
      pdf.buffer,
    ])
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rss: process.memoryUsage().rss,
    })
  }
})

parentPort.postMessage({ ready: true })
