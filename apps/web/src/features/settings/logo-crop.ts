// The logo's square crop (the owner's request of 2026-09-30, O-A): where the picture sits in the
// square the logo shows in (next to the business's name in the sidebar, the header and the switcher),
// as a zoom and the picture's point at the square's centre. Pure maths, the same for the crop area on
// the screen, the previews and the saved picture (a square PNG or WebP drawn by the browser, then
// uploaded through business.logoUploadUrl and checked by the API as before).

/** The saved logo's side, in pixels. */
export const LOGO_OUTPUT_SIZE = 512

/** The largest picture the browser opens for cropping (the saved logo is always small). */
export const LOGO_SOURCE_MAX_BYTES = 10 * 1024 * 1024

/** Room left around the logo when it is fitted to its content (a fraction of the square, each side). */
export const FILL_MARGIN = 0.04

export interface Size {
  readonly width: number
  readonly height: number
}

/** A box inside the picture, in its pixels. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The crop: `zoom` 1 shows the whole picture in the square (its longer side fills it); more zooms in.
 * (`cx`, `cy`) is the point of the picture at the square's centre, in the picture's pixels.
 */
export interface Crop {
  readonly zoom: number
  readonly cx: number
  readonly cy: number
}

/** How far the zoom goes: 8 times the whole picture, or twice what fits its content. */
export function maxZoom(fill: Crop): number {
  return Math.max(8, fill.zoom * 2)
}

/**
 * Keeps the picture where it makes sense: where it is larger than the square it covers the square,
 * where it is smaller it stays inside it (it can move within). The zoom stays within [1, max].
 */
export function clampCrop(crop: Crop, image: Size, max: number): Crop {
  const zoom = Math.min(Math.max(crop.zoom, 1), max)
  // Half the square, in the picture's pixels.
  const half = Math.max(image.width, image.height) / (2 * zoom)
  const axis = (value: number, length: number) => {
    const a = half
    const b = length - half
    return Math.min(Math.max(value, Math.min(a, b)), Math.max(a, b))
  }
  return { zoom, cx: axis(crop.cx, image.width), cy: axis(crop.cy, image.height) }
}

/** The whole picture, centred. */
export function wholeCrop(image: Size): Crop {
  return { zoom: 1, cx: image.width / 2, cy: image.height / 2 }
}

/**
 * The crop that fills the square with the picture's content (`content`: its box without the empty
 * background around it), centred, with a small margin; never less than the whole picture.
 */
export function fillCrop(image: Size, content: Box | null): Crop {
  if (!content || content.width <= 0 || content.height <= 0) return wholeCrop(image)
  const longest = Math.max(image.width, image.height)
  const side = Math.max(content.width, content.height) / (1 - 2 * FILL_MARGIN)
  return {
    zoom: Math.max(1, longest / side),
    cx: content.x + content.width / 2,
    cy: content.y + content.height / 2,
  }
}

/**
 * Where the picture is drawn in a square of `side` pixels: its top-left corner and its drawn size
 * (the parts outside the square are cut; the square around a smaller picture stays transparent).
 */
export function placement(
  crop: Crop,
  image: Size,
  side: number,
): { x: number; y: number; width: number; height: number } {
  const scale = (side / Math.max(image.width, image.height)) * crop.zoom
  return {
    x: side / 2 - crop.cx * scale,
    y: side / 2 - crop.cy * scale,
    width: image.width * scale,
    height: image.height * scale,
  }
}

/** The crop moved by (`dx`, `dy`) pixels of a square of `side` pixels (a drag, an arrow key). */
export function moveCrop(crop: Crop, image: Size, side: number, dx: number, dy: number): Crop {
  const scale = (side / Math.max(image.width, image.height)) * crop.zoom
  return { ...crop, cx: crop.cx - dx / scale, cy: crop.cy - dy / scale }
}

/**
 * The picture's content: the box of its pixels that are not the background around it (transparent,
 * or the colour of its corners: a white or coloured plate). `pixels` is RGBA, `width` × `height`.
 * Null when the whole picture is background.
 */
export function contentBox(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance = 24,
): Box | null {
  const at = (x: number, y: number) => (y * width + x) * 4
  // The background: the colour the four corners share (a transparent corner counts as none).
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
  const opaque = corners.filter((i) => (pixels[i + 3] ?? 0) >= 16)
  const plate =
    opaque.length === corners.length
      ? opaque.map((i) => [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!] as const)
      : null
  const same = (i: number, [r, g, b]: readonly [number, number, number]) =>
    Math.abs(pixels[i]! - r) + Math.abs(pixels[i + 1]! - g) + Math.abs(pixels[i + 2]! - b) <=
    tolerance * 3
  // Only when the corners agree (a plate of one colour); otherwise only transparency is background.
  const background = plate && plate.every((c) => same(corners[0]!, c)) ? plate[0]! : null
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = at(x, y)
      const alpha = pixels[i + 3]!
      const empty = alpha < 16 || (background !== null && same(i, background))
      if (empty) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
