'use client'

import { QUOTATION_PICTURE_HEIGHT, QUOTATION_PICTURE_WIDTH } from '@bizcost/contracts'
import { coverCrop, placement, type Crop, type Size } from '@/components/crop/crop'

// A line's picture framed before it is uploaded (the owner's round of 2026-10-18, D-299: «الصور
// اللي يحطها تتضبط تلقائي بنفس المقاس»): every picture is drawn at exactly 800 × 600 (4:3, the frame
// the PDF prints it in, 20 × 15 mm), filling the frame: by itself centred whatever the picture's shape
// (portrait, panorama, square or tiny), or as the owner moved and zoomed it ("Adjust picture"). It is
// saved as a JPEG on white (a transparent cut-out prints on white paper anyway), small enough for every
// line of a long quotation to keep its picture within the PDF's image budget (D-295). The API checks it
// as every attachment (its bytes, its size, that it decodes).

/** The frame every line picture is saved in, in pixels. */
export const PICTURE_FRAME: Size = {
  width: QUOTATION_PICTURE_WIDTH,
  height: QUOTATION_PICTURE_HEIGHT,
}

/** The picture as `crop` frames it, drawn at the frame's size on white, as a JPEG named `name`. */
export async function drawFramed(
  image: CanvasImageSource,
  size: Size,
  crop: Crop,
  name: string,
): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = PICTURE_FRAME.width
  canvas.height = PICTURE_FRAME.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no canvas')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const at = placement(crop, size, PICTURE_FRAME)
  context.drawImage(image, at.x, at.y, at.width, at.height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.88),
  )
  if (!blob || blob.type !== 'image/jpeg') throw new Error('no picture')
  const base = name.replace(/\.[^.]*$/, '') || 'picture'
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' })
}

/**
 * A picked picture framed by itself: centred, filling the frame (upright, as the phone took it).
 * Returns the framed file and its crop; a picture the browser cannot read comes back as picked
 * (crop null): the API checks it, and the PDF frames it the same way.
 */
export async function framePicture(file: File): Promise<{ file: File; crop: Crop | null }> {
  if (typeof createImageBitmap !== 'function') return { file, crop: null }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return { file, crop: null }
  }
  try {
    const size = { width: bitmap.width, height: bitmap.height }
    const crop = coverCrop(size, PICTURE_FRAME)
    return { file: await drawFramed(bitmap, size, crop, file.name), crop }
  } catch {
    return { file, crop: null }
  } finally {
    bitmap.close()
  }
}
