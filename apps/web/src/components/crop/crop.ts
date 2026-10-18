// Where a picture sits in a frame (the logo's square, D-198; a quotation line's 4:3 picture, D-299):
// a zoom and the picture's point at the frame's centre. Pure maths, the same for the crop area on the
// screen, the previews and the picture saved (drawn by the browser at the frame's size, then
// uploaded and checked by the API as before).

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
 * The crop: `zoom` 1 shows the whole picture in the frame (it fits inside, touching two sides); more
 * zooms in. (`cx`, `cy`) is the point of the picture at the frame's centre, in the picture's pixels.
 */
export interface Crop {
  readonly zoom: number
  readonly cx: number
  readonly cy: number
}

/** Room left around a logo when it is fitted to its content (a fraction of the square, each side). */
export const FILL_MARGIN = 0.04

/** The picture's scale at zoom 1: the whole picture inside the frame. */
export function fitScale(image: Size, frame: Size): number {
  return Math.min(frame.width / image.width, frame.height / image.height)
}

/** The zoom at which the picture just fills the frame (1 for a picture of the frame's shape). */
export function coverZoom(image: Size, frame: Size): number {
  return Math.max(frame.width / image.width, frame.height / image.height) / fitScale(image, frame)
}

/**
 * Keeps the picture where it makes sense: where it is larger than the frame it covers the frame,
 * where it is smaller it stays inside it (it can move within). The zoom stays within [min, max].
 */
export function clampCrop(crop: Crop, image: Size, frame: Size, max: number, min = 1): Crop {
  const zoom = Math.min(Math.max(crop.zoom, min), Math.max(min, max))
  const scale = fitScale(image, frame) * zoom
  // Half the frame, in the picture's pixels.
  const halfWidth = frame.width / (2 * scale)
  const halfHeight = frame.height / (2 * scale)
  const axis = (value: number, length: number, half: number) => {
    const a = half
    const b = length - half
    return Math.min(Math.max(value, Math.min(a, b)), Math.max(a, b))
  }
  return {
    zoom,
    cx: axis(crop.cx, image.width, halfWidth),
    cy: axis(crop.cy, image.height, halfHeight),
  }
}

/** The whole picture, centred. */
export function wholeCrop(image: Size): Crop {
  return { zoom: 1, cx: image.width / 2, cy: image.height / 2 }
}

/** The picture filling the frame, centred (a "cover" crop: never stretched, never with bands). */
export function coverCrop(image: Size, frame: Size): Crop {
  return { zoom: coverZoom(image, frame), cx: image.width / 2, cy: image.height / 2 }
}

/**
 * The crop that fills the frame with the picture's content (`content`: its box without the empty
 * background around it), centred, with a small margin; never less than the whole picture.
 */
export function fillCrop(image: Size, content: Box | null, frame: Size): Crop {
  if (!content || content.width <= 0 || content.height <= 0) return wholeCrop(image)
  const width = content.width / (1 - 2 * FILL_MARGIN)
  const height = content.height / (1 - 2 * FILL_MARGIN)
  const scale = Math.min(frame.width / width, frame.height / height)
  return {
    zoom: Math.max(1, scale / fitScale(image, frame)),
    cx: content.x + content.width / 2,
    cy: content.y + content.height / 2,
  }
}

/**
 * Where the picture is drawn in the frame (`frame` in pixels): its top-left corner and its drawn size
 * (the parts outside the frame are cut; the frame around a smaller picture stays as it is).
 */
export function placement(
  crop: Crop,
  image: Size,
  frame: Size,
): { x: number; y: number; width: number; height: number } {
  const scale = fitScale(image, frame) * crop.zoom
  return {
    x: frame.width / 2 - crop.cx * scale,
    y: frame.height / 2 - crop.cy * scale,
    width: image.width * scale,
    height: image.height * scale,
  }
}

/** The crop moved by (`dx`, `dy`) pixels of the frame (a drag, an arrow key). */
export function moveCrop(crop: Crop, image: Size, frame: Size, dx: number, dy: number): Crop {
  const scale = fitScale(image, frame) * crop.zoom
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
