import { crc32, deflateSync } from 'node:zlib'
import { createCanvas } from '@napi-rs/canvas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildQuotationPdfInput } from './build'
import { CompileError, PdfBusyError, PdfEngine } from './engine'
import {
  PDF_IMAGE_MAX_DECODED_BYTES,
  PDF_IMAGES_MAX_DECODED_BYTES,
  PDF_IMAGES_MAX_BYTES,
  pdfImageInfo,
} from './images'
import { createCore, type Core } from './typst-core.mjs'

// The images a PDF prints (M3 Step 7 review fixes; D-289, D-295): each is read the way its decoder
// reads it (a JPEG's fill bytes skipped and exactly one frame header, a PNG's chunks whole with their
// checksums, a WebP's frame agreeing with its canvas), its size counted as what decoding it takes,
// and whether it decodes asked of the compiler itself (the probe); the engine counts failed jobs,
// gives memory back before a heavy render and never lets jobs wait without end. Fictional images.

// ---------------------------------------------------------------------------------------------------
// Images made here
// ---------------------------------------------------------------------------------------------------

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array([...Buffer.from(type, 'latin1'), ...data])
  return new Uint8Array([...u32(data.length), ...body, ...u32(crc32(body))])
}

/** A PNG: its header, then `idat` (default: the real filtered and deflated pixels) and its end. */
function png(
  width: number,
  height: number,
  { colour = 6, depth = 8, idat }: { colour?: number; depth?: number; idat?: Uint8Array } = {},
): Uint8Array {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]!
  const header = new Uint8Array([...u32(width), ...u32(height), depth, colour, 0, 0, 0])
  let data = idat
  if (!data) {
    const row = 1 + Math.ceil((width * channels * depth) / 8)
    const raw = new Uint8Array(row * height)
    for (let y = 0; y < height; y++) raw.fill(0x60 + (y % 64), y * row + 1, (y + 1) * row)
    data = new Uint8Array(deflateSync(raw))
  }
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', header),
    ...chunk('IDAT', data),
    ...chunk('IEND', new Uint8Array()),
  ])
}

function canvasImage(width: number, height: number, kind: 'jpeg' | 'webp'): Uint8Array {
  const canvas = createCanvas(width, height)
  const g = canvas.getContext('2d')
  g.fillStyle = '#7a5c3e'
  g.fillRect(0, 0, width, height)
  g.fillStyle = '#e8dccb'
  g.fillRect(width / 4, height / 4, width / 2, height / 2)
  return new Uint8Array(
    kind === 'jpeg' ? canvas.encodeSync('jpeg', 80) : canvas.encodeSync('webp', 80),
  )
}

/** A JPEG segment: FF, its marker, its length and data. */
const segment = (marker: number, data: readonly number[]) => [
  0xff,
  marker,
  ((data.length + 2) >> 8) & 255,
  (data.length + 2) & 255,
  ...data,
]

/** A baseline frame header (SOF0) of `width` × `height`, three components. */
const sof0 = (width: number, height: number) =>
  segment(0xc0, [
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])

const insertAfterSoi = (jpeg: Uint8Array, bytes: readonly number[]) =>
  new Uint8Array([...jpeg.subarray(0, 2), ...bytes, ...jpeg.subarray(2)])

// ---------------------------------------------------------------------------------------------------
// Reading an image as its decoder reads it
// ---------------------------------------------------------------------------------------------------

describe('reading an image as its decoder does', () => {
  it('reads a PNG whole, its decoded size by its channels and depth, and refuses anything else', () => {
    expect(pdfImageInfo(png(512, 256))).toEqual({
      format: 'png',
      width: 512,
      height: 256,
      decodedBytes: 512 * 256 * 4,
    })
    expect(pdfImageInfo(png(40, 30, { colour: 2, depth: 16 }))?.decodedBytes).toBe(40 * 30 * 3 * 2)
    // A cut file, a wrong checksum, no end, no image data, a colour type that does not exist.
    const whole = png(64, 48)
    expect(pdfImageInfo(whole.subarray(0, whole.length - 20))).toBeNull()
    const flipped = whole.slice()
    flipped[40] = flipped[40]! ^ 0xff
    expect(pdfImageInfo(flipped)).toBeNull()
    expect(pdfImageInfo(whole.subarray(0, whole.length - 12))).toBeNull()
    expect(pdfImageInfo(png(64, 48, { colour: 5 }))).toBeNull()
    expect(
      pdfImageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull()
  })

  it('refuses an image too large to decode: a side, its pixels, or its decoded size', () => {
    const header = (width: number, height: number, colour = 6, depth = 8) =>
      pdfImageInfo(png(width, height, { colour, depth, idat: new Uint8Array([0x78, 0x9c]) }))
    expect(header(8001, 10)).toBeNull()
    expect(header(6000, 5000)).toBeNull() // 30 MP
    // 5000 × 5000 16-bit RGBA: 200 MB decoded (the review's 1.6 GB render), within 25 MP.
    expect(header(5000, 5000, 6, 16)).toBeNull()
    expect(header(5000, 5000, 6, 8)?.decodedBytes).toBe(100_000_000)
    expect(PDF_IMAGE_MAX_DECODED_BYTES).toBeLessThan(PDF_IMAGES_MAX_DECODED_BYTES)
    expect(PDF_IMAGES_MAX_BYTES).toBeGreaterThan(0)
  })

  it('skips the fill bytes before a JPEG marker as decoders do: a hidden frame header is never read', () => {
    // The review's file: a real 8,200 × 200 JPEG with "FF FF E1 F0 00" after its start, an APP1
    // whose payload holds a fake 100 × 100 frame header where a reader that takes the fill byte for a
    // marker would land. Read as a decoder reads it, the APP1 is skipped whole and the real frame
    // (8,200 px wide) is refused.
    const real = canvasImage(8200, 200, 'jpeg')
    expect(pdfImageInfo(real)).toBeNull()
    // File offset 57,844 = 2 (SOI) + 2 + 57,840 ("FF E1 F0" read as marker FF, length E1F0); the APP1's
    // payload starts at offset 7.
    const payload = new Array<number>(0xf000 - 2).fill(0)
    const fake = sof0(100, 100)
    payload.splice(57_844 - 7, fake.length, ...fake)
    const hide = [0xff, 0xff, 0xe1, 0xf0, 0x00, ...payload]
    expect(pdfImageInfo(insertAfterSoi(real, hide))).toBeNull()
    // The same on a small real image: its own size is read, never the hidden 100 × 100.
    const small = canvasImage(640, 480, 'jpeg')
    expect(pdfImageInfo(insertAfterSoi(small, hide))).toMatchObject({
      format: 'jpg',
      width: 640,
      height: 480,
    })
  })

  it('refuses a JPEG with a second frame header, or one of a kind the compiler cannot decode', () => {
    const jpeg = canvasImage(64, 48, 'jpeg')
    expect(pdfImageInfo(jpeg)).toMatchObject({ width: 64, height: 48, decodedBytes: 64 * 48 * 3 })
    expect(pdfImageInfo(insertAfterSoi(jpeg, sof0(100, 100)))).toBeNull()
    // Arithmetic coding (SOF9) and hierarchical (DHP) frames.
    expect(
      pdfImageInfo(insertAfterSoi(jpeg, segment(0xc9, [8, 0, 10, 0, 10, 1, 1, 0x11, 0]))),
    ).toBeNull()
    expect(
      pdfImageInfo(insertAfterSoi(jpeg, segment(0xde, [8, 0, 10, 0, 10, 1, 1, 0x11, 0]))),
    ).toBeNull()
    // A thumbnail inside an APP1 (as phones write) is skipped with its segment.
    const thumbnail = [...canvasImage(16, 12, 'jpeg')]
    expect(pdfImageInfo(insertAfterSoi(jpeg, segment(0xe1, thumbnail)))).toMatchObject({
      width: 64,
      height: 48,
    })
  })

  it('reads a WebP whole, its frame agreeing with its canvas', () => {
    const webp = canvasImage(96, 64, 'webp')
    expect(pdfImageInfo(webp)).toMatchObject({ format: 'webp', width: 96, height: 64 })
    expect(pdfImageInfo(webp.subarray(0, webp.length - 10))).toBeNull()
    // A VP8X header saying 100 × 100 over a 96 × 64 frame.
    const lying = webp.slice()
    const vp8x = Buffer.from(lying.buffer, lying.byteOffset, lying.length).indexOf('VP8X')
    expect(vp8x).toBe(12)
    lying.set([99, 0, 0, 99, 0, 0], vp8x + 12)
    expect(pdfImageInfo(lying)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------
// The compiler's probe and the engine
// ---------------------------------------------------------------------------------------------------

let core: Core

beforeAll(async () => {
  core = await createCore()
}, 60_000)

describe('the compiler decides what decodes', () => {
  it('decodes a real image, and refuses a PNG whose header and checksums are right over broken data', async () => {
    await expect(core.probe({ path: '/img/a.png', bytes: png(64, 48) })).resolves.toBeUndefined()
    await expect(
      core.probe({ path: '/img/b.jpg', bytes: canvasImage(64, 48, 'jpeg') }),
    ).resolves.toBeUndefined()
    // Every chunk whole with its CRC: the structure check passes, the data does not inflate.
    const broken = png(64, 48, { idat: new Uint8Array(200).fill(0x5a) })
    expect(pdfImageInfo(broken)).not.toBeNull()
    await expect(core.probe({ path: '/img/c.png', bytes: broken })).rejects.toThrow(
      /failed to decode image/,
    )
    await expect(core.probe({ path: '/etc/passwd', bytes: broken })).rejects.toThrow(
      /not an image path/,
    )
  }, 30_000)
})

/** A one-line quotation whose line prints `key`'s picture (the image mapped as `/img/<key>.png`). */
function withPicture(key: string) {
  const input = buildQuotationPdfInput({
    business: {
      legalName: 'Modern Touch Interiors',
      legalNameAr: null,
      locale: 'en',
      vatRegistered: false,
      trn: null,
      phone: null,
      phone2: null,
      email: null,
      addressLine: null,
      city: null,
      emirate: null,
      tradeLicenceNo: null,
      accent: 'navy',
      watermark: false,
      wholeAmounts: false,
      signatory: null,
      footer: null,
    },
    quotation: {
      number: 'Q-0001',
      revision: 1,
      draft: false,
      businessDate: '2026-10-08',
      validUntil: null,
      customerRef: null,
      site: null,
      currency: 'AED',
      vatRegistered: false,
      subtotal: '100',
      discountTotal: '0',
      adjustment: '0',
      roundingDifference: '0',
      netTotal: '100',
      vatTotal: '0',
      total: '100',
      payable: '100',
      vatRates: [],
      greeting: null,
      intro: null,
      terms: null,
      notes: null,
      issuedAt: new Date(Date.UTC(2026, 9, 8)),
      lines: [
        {
          area: null,
          title: 'Wardrobe',
          details: null,
          note: null,
          qty: '1',
          unit: null,
          unitPrice: '100',
          subtotal: '100',
          lineDiscount: '0',
          priceIncludesVat: false,
          vatCategory: null,
          vatRate: null,
          picture: key,
        },
      ],
      stages: [],
    },
    customer: {
      name: 'Sara Haddad',
      phone: null,
      trn: null,
      addressLine: null,
      city: null,
      emirate: null,
    },
    businessImages: { logo: null, signature: null, stamp: null },
    images: { [key]: { path: `/img/${key}.png`, format: 'png', width: 64, height: 48 } },
  })
  return JSON.stringify(input)
}

describe('the engine', () => {
  const engines: PdfEngine[] = []
  const engine = (options: ConstructorParameters<typeof PdfEngine>[0]) => {
    const made = new PdfEngine(options)
    engines.push(made)
    return made
  }

  afterAll(async () => {
    await Promise.all(engines.map((e) => e.close()))
  })

  it('probes an image: ok, or what the compiler said', async () => {
    const e = engine({})
    expect(await e.probe({ path: '/img/a.png', bytes: png(32, 32) })).toEqual({ ok: true })
    const broken = await e.probe({
      path: '/img/b.png',
      bytes: png(32, 32, { idat: new Uint8Array(64).fill(1) }),
    })
    expect(broken).toMatchObject({ ok: false })
  }, 60_000)

  it('counts failed renders: a worker that only fails is still replaced', async () => {
    const e = engine({ maxRenders: 2 })
    const broken = png(64, 48, { idat: new Uint8Array(100).fill(7) })
    const data = withPicture('line-1')
    for (let i = 0; i < 4; i++) {
      await expect(
        e.render({ data, images: [{ path: '/img/line-1.png', bytes: broken }] }),
      ).rejects.toBeInstanceOf(CompileError)
    }
    expect(e.workersStarted).toBeGreaterThanOrEqual(2)
    // A good render afterwards works on a fresh worker.
    const pdf = await e.render({ data, images: [{ path: '/img/line-1.png', bytes: png(64, 48) }] })
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
  }, 120_000)

  it('starts a heavy render on a new worker when its images could pass the memory limit', async () => {
    const e = engine({ maxRssBytes: 4 * 1024 * 1024 * 1024 })
    const data = withPicture('line-1')
    const images = [{ path: '/img/line-1.png', bytes: png(64, 48) }]
    await e.render({ data, images })
    expect(e.workersStarted).toBe(1)
    await e.render({ data, images, decodedBytes: 2 * 1024 * 1024 * 1024 })
    expect(e.workersStarted).toBe(2)
  }, 120_000)

  it('never lets jobs wait without end: busy past the queue or the wait', async () => {
    const full = engine({ maxQueued: 1 })
    const data = withPicture('line-1')
    const images = [{ path: '/img/line-1.png', bytes: png(64, 48) }]
    const first = full.render({ data, images })
    await expect(full.render({ data, images })).rejects.toBeInstanceOf(PdfBusyError)
    await first
    const slow = engine({ queueTimeoutMs: 30 })
    // The first render starts a worker (about a second); the second gives up waiting for it.
    const starting = slow.render({ data, images })
    await expect(slow.render({ data, images })).rejects.toBeInstanceOf(PdfBusyError)
    await expect(starting).resolves.toBeInstanceOf(Uint8Array)
  }, 120_000)
})
