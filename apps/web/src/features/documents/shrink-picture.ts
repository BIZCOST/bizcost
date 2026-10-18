'use client'

// A picture made the size a document prints it at, before it is uploaded (M3 Step 7 review, D-295,
// D-297): a phone's 12-megapixel photo is drawn again at most `maxSide` pixels on its longer side
// (upright, as the phone took it), so the PDF compiler decodes a small image and every line of a long
// quotation keeps its picture within the PDF's image budget. A JPEG stays a JPEG; a PNG or WebP keeps
// its transparency (as WebP, or PNG where the browser cannot write WebP). A picture already small
// enough, one the browser cannot read, or one that would only grow in bytes, is sent as it was picked: the
// server checks every image anyway.

const EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** At most this many bytes, a picture within `maxSide` is sent as it is. */
const SMALL_ENOUGH = 1.5 * 1024 * 1024

function blobOf(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export async function shrinkPicture(file: File, maxSide: number): Promise<File> {
  if (!(file.type in EXTENSION) || typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= maxSide && file.size <= SMALL_ENOUGH) return file
    const scale = Math.min(1, maxSide / longest)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return file
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const photo = file.type === 'image/jpeg'
    const blob = await blobOf(canvas, photo ? 'image/jpeg' : 'image/webp', photo ? 0.86 : 0.9)
    const type = blob?.type ?? ''
    if (!blob || !(type in EXTENSION)) return file
    // Within the size already, drawn again only for its bytes: kept when that would not save any.
    if (longest <= maxSide && blob.size >= file.size) return file
    const name = `${file.name.replace(/\.[^.]*$/, '') || 'picture'}.${EXTENSION[type]}`
    return new File([blob], name, { type, lastModified: file.lastModified })
  } finally {
    bitmap.close()
  }
}
