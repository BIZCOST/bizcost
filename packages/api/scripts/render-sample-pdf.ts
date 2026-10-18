// Renders a document template with a sample's data to a PDF and a PNG of each page (M3 Step 7), so a
// designer can change the template and see it at once, without the API, a database or Storage.
//
//   pnpm --filter @bizcost/api pdf:sample [--template <file.typ>] [--data <sample.json>]
//                                         [--images <folder>] [--out <folder>] [--scale <n>]
//
// Defaults: the document template (src/documents/pdf/templates/document.typ), the fit-out sample
// (scripts/samples/fit-out-quotation.json with the images of scripts/samples/images), and the output
// folder scripts/samples/out (ignored by git). The sample is a DocumentPdfInput as the server builds it;
// its `images` are filled from the folder: each file <key>.<png|jpg|webp> is the image `<key>` (the
// logo, line-1, signature, stamp…). Samples use fictional businesses and customers only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pdfImageInfo } from '../src/documents/pdf/images'
import type { DocumentPdfImage, DocumentPdfInput } from '../src/documents/pdf/input'
import { createCore, loadCoreAssets } from '../src/documents/pdf/typst-core.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

function raw(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

function option(name: string, fallback: string): string {
  const value = raw(name)
  return value ? resolve(value) : fallback
}

const templatePath = option('template', '')
const dataPath = option('data', join(here, 'samples', 'fit-out-quotation.json'))
const imagesDir = option('images', join(here, 'samples', 'images'))
const outDir = option('out', join(here, 'samples', 'out'))
const scale = Number(raw('scale') ?? '2')

const sample = JSON.parse(readFileSync(dataPath, 'utf8')) as DocumentPdfInput
const images: Record<string, DocumentPdfImage> = {}
const files: { path: string; bytes: Uint8Array }[] = []
const entries: string[] = (() => {
  try {
    return readdirSync(imagesDir)
  } catch {
    return []
  }
})()
for (const entry of entries) {
  const ext = extname(entry).slice(1).toLowerCase()
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) continue
  const key = basename(entry, extname(entry)).toLowerCase()
  if (!/^[a-z0-9-]+$/.test(key)) continue
  const bytes = new Uint8Array(readFileSync(join(imagesDir, entry)))
  const info = pdfImageInfo(bytes)
  if (!info) {
    console.warn(`skipped ${entry}: not a PNG, JPEG or WebP within the size limits`)
    continue
  }
  const path = `/img/${key}.${info.format}`
  images[key] = { path, format: info.format, width: info.width, height: info.height }
  files.push({ path, bytes })
}

const data: DocumentPdfInput = { ...sample, images: { ...images } }
const assets = loadCoreAssets()
const template = templatePath ? readFileSync(templatePath, 'utf8') : assets.template
const core = await createCore(assets)
const started = performance.now()
const pdf = await core.render({ template, data: JSON.stringify(data), images: files })
const took = performance.now() - started

mkdirSync(outDir, { recursive: true })
const name = basename(dataPath, extname(dataPath))
const pdfPath = join(outDir, `${name}.pdf`)
writeFileSync(pdfPath, pdf)

const loading = getDocument({ data: pdf.slice(), useSystemFonts: false })
const document = await loading.promise
for (let n = 1; n <= document.numPages; n++) {
  const page = await document.getPage(n)
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise
  writeFileSync(join(outDir, `${name}-page-${n}.png`), canvas.toBuffer('image/png'))
}
console.log(
  `${pdfPath}: ${document.numPages} page(s), ${pdf.byteLength} bytes, rendered in ${Math.round(took)} ms`,
)
await loading.destroy()
