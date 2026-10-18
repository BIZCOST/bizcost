// The Typst compiler of the documents' PDFs (M3 Step 7; D-224): Typst compiled to WebAssembly
// (typst.ts 0.7.0 = Typst 0.14.2). Plain JavaScript, so a worker thread runs it as it is (worker.mjs);
// the tests use it in-process too. Only this folder may import typst.ts (lint).
//
// What the compiler can reach while it renders: the template, the document's data as JSON
// (/data.json) and the images the server mapped (/img/…), all in its in-memory file system; the four
// IBM Plex TTFs, loaded from bytes. No access model (it cannot read the disk), no package registry (no
// `#import "@preview/…"`), the default CDN fonts off: no file, network or process call while
// rendering.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createTypstCompiler, initOptions, loadFonts } from '@myriaddreamin/typst.ts'

const here = new URL('.', import.meta.url)

/** The fonts the PDFs embed (OFL, shipped with fonts/OFL.txt). */
export const FONT_FILES = [
  'IBMPlexSans-Regular.ttf',
  'IBMPlexSans-Bold.ttf',
  'IBMPlexSansArabic-Regular.ttf',
  'IBMPlexSansArabic-Bold.ttf',
]

/** The template of every document kind (its data says which). */
export const DOCUMENT_TEMPLATE = 'templates/document.typ'

/** Everything the compiler needs, read from disk once (before rendering, never during). */
export function loadCoreAssets() {
  const require = createRequire(import.meta.url)
  return {
    wasm: readFileSync(require.resolve('@myriaddreamin/typst-ts-web-compiler/wasm')),
    fonts: FONT_FILES.map((file) => new Uint8Array(readFileSync(new URL(`fonts/${file}`, here)))),
    template: readFileSync(new URL(DOCUMENT_TEMPLATE, here), 'utf8'),
  }
}

/** A short, safe account of what the compiler refused (never the data). */
function diagnosticsText(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return 'no diagnostics'
  return diagnostics
    .slice(0, 5)
    .map((d) => (typeof d === 'string' ? d : `${d.path ?? ''} ${d.range ?? ''} ${d.message ?? ''}`))
    .join('; ')
    .slice(0, 2000)
}

const IMAGE_PATH = /^\/img\/[a-z0-9-]+\.(png|jpg|webp)$/

/**
 * A compiler ready to render: `render({ template, data, images })` gives the PDF's bytes. `template` is
 * the Typst source (the default one unless a designer's sample CLI passes its own), `data` the JSON
 * text of a DocumentPdfInput, `images` the bytes the server mapped, each at its `/img/…` path.
 * `probe({ path, bytes })` asks the compiler to decode one image (measured, never printed): it
 * resolves when the image decodes and rejects with the compiler's own words when it does not (D-295).
 */
export async function createCore(assets = loadCoreAssets()) {
  const compiler = createTypstCompiler()
  await compiler.init({
    beforeBuild: [initOptions.disableDefaultFontAssets(), loadFonts(assets.fonts)],
    getModule: () => ({ module_or_path: assets.wasm }),
  })
  return {
    defaultTemplate: assets.template,
    async render({ template, data, images }) {
      // Every file of the last render is dropped first (its data and images), the template included.
      compiler.resetShadow()
      compiler.addSource('/main.typ', template ?? assets.template)
      compiler.mapShadow('/data.json', new TextEncoder().encode(data))
      for (const image of images ?? []) {
        if (!IMAGE_PATH.test(image.path)) throw new Error(`not an image path: ${image.path}`)
        compiler.mapShadow(image.path, image.bytes)
      }
      const result = await compiler.compile({
        mainFilePath: '/main.typ',
        format: 1,
        diagnostics: 'full',
      })
      if (!result.result) throw new Error(`typst: ${diagnosticsText(result.diagnostics)}`)
      return new Uint8Array(result.result)
    },
    async probe({ path, bytes }) {
      if (!IMAGE_PATH.test(path)) throw new Error(`not an image path: ${path}`)
      compiler.resetShadow()
      // Measuring the image makes the compiler decode it whole, as a document's render would.
      compiler.addSource('/main.typ', `#context { let _ = measure(image("${path}")); [ok] }`)
      compiler.mapShadow(path, bytes)
      const result = await compiler.compile({
        mainFilePath: '/main.typ',
        format: 1,
        diagnostics: 'full',
      })
      if (!result.result) throw new Error(`typst: ${diagnosticsText(result.diagnostics)}`)
    },
  }
}
