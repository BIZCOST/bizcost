import {
  clampCrop as clampInFrame,
  fillCrop as fillInFrame,
  moveCrop as moveInFrame,
  placement as placeInFrame,
  type Box,
  type Crop,
  type Size,
} from '../../components/crop/crop'

// The logo's square crop (the owner's request of 2026-09-30, O-A): where the picture sits in the
// square the logo shows in (next to the business's name in the sidebar, the header and the switcher),
// as a zoom and the picture's point at the square's centre: the frame maths of components/crop (a
// quotation line's picture uses them at 4:3, D-299) for a square. The saved logo is a square PNG or
// WebP drawn by the browser, then uploaded through business.logoUploadUrl and checked by the API.

export {
  contentBox,
  FILL_MARGIN,
  wholeCrop,
  type Box,
  type Crop,
  type Size,
} from '../../components/crop/crop'

/** The saved logo's side, in pixels. */
export const LOGO_OUTPUT_SIZE = 512

/** The largest picture the browser opens for cropping (the saved logo is always small). */
export const LOGO_SOURCE_MAX_BYTES = 10 * 1024 * 1024

const square = (side: number): Size => ({ width: side, height: side })

/** How far the zoom goes: 8 times the whole picture, or twice what fits its content. */
export function maxZoom(fill: Crop): number {
  return Math.max(8, fill.zoom * 2)
}

/**
 * Keeps the picture where it makes sense: where it is larger than the square it covers the square,
 * where it is smaller it stays inside it (it can move within). The zoom stays within [1, max].
 */
export function clampCrop(crop: Crop, image: Size, max: number): Crop {
  return clampInFrame(crop, image, square(1), max)
}

/**
 * The crop that fills the square with the picture's content (`content`: its box without the empty
 * background around it), centred, with a small margin; never less than the whole picture.
 */
export function fillCrop(image: Size, content: Box | null): Crop {
  return fillInFrame(image, content, square(1))
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
  return placeInFrame(crop, image, square(side))
}

/** The crop moved by (`dx`, `dy`) pixels of a square of `side` pixels (a drag, an arrow key). */
export function moveCrop(crop: Crop, image: Size, side: number, dx: number, dy: number): Crop {
  return moveInFrame(crop, image, square(side), dx, dy)
}
