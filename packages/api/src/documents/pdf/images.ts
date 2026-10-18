import { crc32 } from 'node:zlib'

// The images a PDF prints (M3 Step 7; D-224, D-289, D-295): the logo, a quotation line's picture, the
// signature and the stamp, always bytes the server read from the business's own Storage objects. Each
// is checked before the compiler sees it: its first bytes say PNG, JPEG or WebP, its structure is read
// the way a decoder reads it (a PNG's chunks with their checksums and its end; a JPEG's segments with
// the fill bytes a decoder skips, exactly one frame header of a kind the compiler decodes; a WebP's
// chunks, the frame's own size agreeing with the canvas), and its size stays within the limits below,
// counted as what decoding it takes (width × height × channels × bytes per sample), so no image can
// make the compiler decode more than it should. Whether an image really decodes is asked of the
// compiler itself when it is uploaded (engine.ts `probe`); at render time an image that fails is left
// out (the line prints without its picture).

export type PdfImageFormat = 'png' | 'jpg' | 'webp'

export interface PdfImageInfo {
  readonly format: PdfImageFormat
  readonly width: number
  readonly height: number
  /** What decoding it takes, in bytes (width × height × channels × bytes per sample). */
  readonly decodedBytes: number
}

/** The largest side of an image, in pixels, and its largest area (a 12 MP phone photo is fine). */
export const PDF_IMAGE_MAX_SIDE = 8000
export const PDF_IMAGE_MAX_PIXELS = 25_000_000
/** The most one image may take decoded (25 MP of 8-bit RGBA; a 16-bit image half of that). */
export const PDF_IMAGE_MAX_DECODED_BYTES = 100 * 1024 * 1024

/**
 * What all the images of one PDF may come to: decoded (the compiler holds about twice that while it
 * renders, so a PDF stays well within its worker's memory limit) and as files.
 */
export const PDF_IMAGES_MAX_DECODED_BYTES = 256 * 1024 * 1024
export const PDF_IMAGES_MAX_BYTES = 60 * 1024 * 1024

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
const u32be = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
const u32le = (b: Uint8Array, i: number) =>
  b[i]! + (b[i + 1]! << 8) + (b[i + 2]! << 16) + ((b[i + 3]! << 24) >>> 0)

function starts(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte)
}

interface Size {
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly bytesPerSample: number
}

// ---------------------------------------------------------------------------------------------------
// PNG: IHDR first, every chunk whole with its CRC, IEND at the end
// ---------------------------------------------------------------------------------------------------

/** The bit depths each PNG colour type allows, and the channels it decodes to. */
const PNG_COLOUR: Readonly<Record<number, { depths: readonly number[]; channels: number }>> = {
  0: { depths: [1, 2, 4, 8, 16], channels: 1 }, // grey
  2: { depths: [8, 16], channels: 3 }, // RGB
  3: { depths: [1, 2, 4, 8], channels: 4 }, // palette (expanded to RGB, or RGBA with tRNS)
  4: { depths: [8, 16], channels: 2 }, // grey + alpha
  6: { depths: [8, 16], channels: 4 }, // RGBA
}

function pngSize(bytes: Uint8Array): Size | null {
  // The IHDR chunk comes first, 13 bytes: width, height, depth, colour type, compression, filter,
  // interlace.
  if (bytes.length < 33 || u32be(bytes, 8) !== 13) return null
  if (!starts(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return null
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  const depth = bytes[24]!
  const colour = PNG_COLOUR[bytes[25]!]
  if (!colour || !colour.depths.includes(depth)) return null
  if (bytes[26] !== 0 || bytes[27] !== 0 || (bytes[28] !== 0 && bytes[28] !== 1)) return null
  // Every chunk whole (a cut file is refused), its CRC right, one IHDR, image data, and IEND.
  let i = 8
  let sawData = false
  let ended = false
  while (i + 12 <= bytes.length) {
    const length = u32be(bytes, i)
    if (length > 0x7fffffff || i + 12 + length > bytes.length) return null
    const type = bytes.subarray(i + 4, i + 8)
    const stored = u32be(bytes, i + 8 + length)
    if (crc32(bytes.subarray(i + 4, i + 8 + length)) !== stored) return null
    const name = String.fromCharCode(...type)
    if (name === 'IHDR' && i !== 8) return null
    if (name === 'IDAT') sawData = true
    i += 12 + length
    if (name === 'IEND') {
      ended = true
      break
    }
  }
  if (!sawData || !ended) return null
  return { width, height, channels: colour.channels, bytesPerSample: depth === 16 ? 2 : 1 }
}

// ---------------------------------------------------------------------------------------------------
// JPEG: segments walked as a decoder walks them
// ---------------------------------------------------------------------------------------------------

/** Frame headers the compiler's decoder reads: baseline, extended sequential and progressive (Huffman). */
const JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2])
/** Every other frame header (lossless, arithmetic, hierarchical, JPEG-LS…): refused. */
const isOtherFrame = (m: number) =>
  (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xcc) || m === 0xde || m === 0xdf || m === 0xf7

function jpegSize(bytes: Uint8Array): Size | null {
  let frame: Size | null = null
  let i = 2
  for (;;) {
    if (i >= bytes.length) return frame
    if (bytes[i] !== 0xff) return null
    // Any number of 0xFF fill bytes may come before a marker (T.81 B.1.1.2): skipped, as decoders do.
    while (i < bytes.length && bytes[i] === 0xff) i += 1
    if (i >= bytes.length) return frame
    const marker = bytes[i]!
    i += 1
    if (marker === 0x00 || marker === 0xd8) return null
    if (marker === 0xd9) return frame // the end of the image: whatever follows is not decoded
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue // no length
    if (i + 2 > bytes.length) return null
    const length = u16be(bytes, i)
    if (length < 2 || i + length > bytes.length) return null
    if (JPEG_FRAMES.has(marker)) {
      // Exactly one frame header: a second one could be the frame a decoder reads.
      if (frame || length < 8) return null
      const precision = bytes[i + 2]!
      const height = u16be(bytes, i + 3)
      const width = u16be(bytes, i + 5)
      const components = bytes[i + 7]!
      if ((precision !== 8 && precision !== 12) || components < 1 || components > 4) return null
      if (length !== 8 + 3 * components) return null
      // Decoded to grey (1), RGB (3) or, from CMYK, RGB with a fourth sample counted to be safe.
      frame = {
        width,
        height,
        channels: components === 1 ? 1 : components === 2 ? 3 : components,
        bytesPerSample: precision === 12 ? 2 : 1,
      }
    } else if (isOtherFrame(marker) || marker === 0xc8 || (marker >= 0xf0 && marker <= 0xfd)) {
      return null
    }
    i += length
    if (marker === 0xda) {
      // A scan: its entropy-coded data runs to the next marker (0xFF then neither 0x00, a restart
      // marker nor another fill byte). A file cut inside a scan ends here (decoders print what they
      // read).
      if (!frame) return null
      for (;;) {
        while (i < bytes.length && bytes[i] !== 0xff) i += 1
        if (i + 1 >= bytes.length) return frame
        let next = i + 1
        while (next < bytes.length && bytes[next] === 0xff) next += 1
        if (next >= bytes.length) return frame
        const byte = bytes[next]!
        if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) {
          i = next + 1
          continue
        }
        i = next - 1 // the marker's 0xFF; the outer loop reads it
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// WebP: the RIFF chunks whole, the frame's size agreeing with the canvas
// ---------------------------------------------------------------------------------------------------

function vp8Size(bytes: Uint8Array, at: number, length: number) {
  // A key frame (bit 0 of the frame tag clear), the start code 9D 01 2A, 14-bit width and height.
  if (length < 10 || (bytes[at]! & 0x01) !== 0 || !starts(bytes, [0x9d, 0x01, 0x2a], at + 3)) {
    return null
  }
  return { width: u16le(bytes, at + 6) & 0x3fff, height: u16le(bytes, at + 8) & 0x3fff }
}

function vp8lSize(bytes: Uint8Array, at: number, length: number) {
  if (length < 5 || bytes[at] !== 0x2f) return null
  const b = bytes
  const width = 1 + (((b[at + 2]! & 0x3f) << 8) | b[at + 1]!)
  const height = 1 + (((b[at + 4]! & 0x0f) << 10) | (b[at + 3]! << 2) | ((b[at + 2]! & 0xc0) >> 6))
  return { width, height }
}

function webpSize(bytes: Uint8Array): Size | null {
  const end = 8 + u32le(bytes, 4)
  // The whole RIFF in the file (a cut file is refused).
  if (bytes.length < 20 || end > bytes.length || end < 20) return null
  const chunks: { name: string; at: number; length: number }[] = []
  let i = 12
  while (i + 8 <= end) {
    const length = u32le(bytes, i + 4)
    if (i + 8 + length > end) return null
    chunks.push({ name: String.fromCharCode(...bytes.subarray(i, i + 4)), at: i + 8, length })
    i += 8 + length + (length % 2)
  }
  const first = chunks[0]
  if (!first) return null
  if (first.name === 'VP8 ') {
    const size = vp8Size(bytes, first.at, first.length)
    return size ? { ...size, channels: 3, bytesPerSample: 1 } : null
  }
  if (first.name === 'VP8L') {
    const size = vp8lSize(bytes, first.at, first.length)
    return size ? { ...size, channels: 4, bytesPerSample: 1 } : null
  }
  if (first.name !== 'VP8X' || first.length < 10) return null
  const flags = bytes[first.at]!
  if (flags & 0x02) return null // an animation
  const canvas = { width: 1 + u24le(bytes, first.at + 4), height: 1 + u24le(bytes, first.at + 7) }
  const image = chunks.find((c) => c.name === 'VP8 ' || c.name === 'VP8L')
  if (!image) return null
  const frame =
    image.name === 'VP8 '
      ? vp8Size(bytes, image.at, image.length)
      : vp8lSize(bytes, image.at, image.length)
  // The frame a decoder reads must be the canvas the header says (no smaller header over a big frame).
  if (!frame || frame.width !== canvas.width || frame.height !== canvas.height) return null
  const alpha = (flags & 0x10) !== 0 || image.name === 'VP8L'
  return { ...canvas, channels: alpha ? 4 : 3, bytesPerSample: 1 }
}

/**
 * The format, size and decoded size of an image (PNG, JPEG, WebP), or null when it is none of them,
 * its structure cannot be read as its decoder reads it, or it is larger than PDF_IMAGE_MAX_SIDE,
 * PDF_IMAGE_MAX_PIXELS or PDF_IMAGE_MAX_DECODED_BYTES.
 */
export function pdfImageInfo(bytes: Uint8Array): PdfImageInfo | null {
  let size: Size | null
  let format: PdfImageFormat
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    format = 'png'
    size = pngSize(bytes)
  } else if (starts(bytes, [0xff, 0xd8, 0xff])) {
    format = 'jpg'
    size = jpegSize(bytes)
  } else if (
    starts(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    format = 'webp'
    size = webpSize(bytes)
  } else {
    return null
  }
  if (!size || size.width < 1 || size.height < 1) return null
  if (size.width > PDF_IMAGE_MAX_SIDE || size.height > PDF_IMAGE_MAX_SIDE) return null
  if (size.width * size.height > PDF_IMAGE_MAX_PIXELS) return null
  const decodedBytes = size.width * size.height * size.channels * size.bytesPerSample
  if (decodedBytes > PDF_IMAGE_MAX_DECODED_BYTES) return null
  return { format, width: size.width, height: size.height, decodedBytes }
}
