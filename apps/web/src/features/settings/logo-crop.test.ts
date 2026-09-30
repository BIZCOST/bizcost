import { describe, expect, it } from 'vitest'
import {
  clampCrop,
  contentBox,
  fillCrop,
  FILL_MARGIN,
  maxZoom,
  moveCrop,
  placement,
  wholeCrop,
} from './logo-crop'

// The logo's square crop (the owner's request of 2026-09-30, O-A).

/** An RGBA picture of `width` × `height`, `background`, with a box of `ink` at (x, y, w, h). */
function picture(
  width: number,
  height: number,
  background: [number, number, number, number],
  box?: { x: number; y: number; w: number; h: number },
) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
      pixels.set(inside ? [29, 78, 216, 255] : background, (y * width + x) * 4)
    }
  }
  return pixels
}

describe('where the picture sits in the square', () => {
  const wide = { width: 600, height: 150 }

  it('shows the whole picture at zoom 1: its longer side fills the square, centred', () => {
    expect(placement(wholeCrop(wide), wide, 512)).toEqual({ x: 0, y: 192, width: 512, height: 128 })
  })

  it('keeps a smaller picture inside the square and a larger one over it', () => {
    // Whole: it can move up and down within the square, not out of it.
    const up = clampCrop({ zoom: 1, cx: 300, cy: 1000 }, wide, 8)
    expect(placement(up, wide, 512).y).toBeCloseTo(0)
    // Zoomed in 5 times: the picture is taller than the square and always covers it.
    const zoomed = clampCrop({ zoom: 5, cx: 0, cy: 0 }, wide, 8)
    const at = placement(zoomed, wide, 512)
    expect(at.x).toBeCloseTo(0)
    expect(at.y).toBeCloseTo(0)
    expect(at.height).toBeGreaterThan(512)
    // Never below the whole picture, never beyond the most.
    expect(clampCrop({ zoom: 0.2, cx: 300, cy: 75 }, wide, 8).zoom).toBe(1)
    expect(clampCrop({ zoom: 50, cx: 300, cy: 75 }, wide, 8).zoom).toBe(8)
  })

  it('moves with a drag, by the pixels of the square', () => {
    const square = { width: 1000, height: 1000 }
    const moved = moveCrop({ zoom: 2, cx: 500, cy: 500 }, square, 250, 50, -25)
    // 250 px show 500 px of the picture: 50 px right is 100 px of it.
    expect(moved).toEqual({ zoom: 2, cx: 400, cy: 550 })
  })
})

describe('fitting the logo to its content', () => {
  it('leaves out a white plate around a small mark, centred with a small margin', () => {
    const pixels = picture(400, 400, [255, 255, 255, 255], { x: 150, y: 170, w: 100, h: 60 })
    const box = contentBox(pixels, 400, 400)
    expect(box).toEqual({ x: 150, y: 170, width: 100, height: 60 })
    const fill = fillCrop({ width: 400, height: 400 }, box)
    expect(fill.cx).toBe(200)
    expect(fill.cy).toBe(200)
    const at = placement(fill, { width: 400, height: 400 }, 512)
    // The mark's width fills the square but for the margins.
    const drawn = (100 * at.width) / 400
    expect(drawn).toBeCloseTo(512 * (1 - 2 * FILL_MARGIN))
    expect(maxZoom(fill)).toBeGreaterThanOrEqual(fill.zoom)
  })

  it('leaves out transparency, and keeps a coloured plate that is the logo itself', () => {
    const clear = picture(200, 100, [0, 0, 0, 0], { x: 20, y: 10, w: 160, h: 80 })
    expect(contentBox(clear, 200, 100)).toEqual({ x: 20, y: 10, width: 160, height: 80 })
    // Corners of one colour: a plate around the mark.
    const plate = picture(100, 100, [240, 200, 10, 255], { x: 40, y: 40, w: 20, h: 20 })
    expect(contentBox(plate, 100, 100)).toEqual({ x: 40, y: 40, width: 20, height: 20 })
    // Nothing but background: no content (the whole picture is kept).
    expect(contentBox(picture(10, 10, [255, 255, 255, 255]), 10, 10)).toBeNull()
    expect(fillCrop({ width: 10, height: 10 }, null)).toEqual(wholeCrop({ width: 10, height: 10 }))
  })

  it('never zooms a wide logo out of its square: its whole width stays', () => {
    const wide = { width: 600, height: 150 }
    const pixels = picture(600, 150, [255, 255, 255, 255], { x: 5, y: 20, w: 590, h: 110 })
    const fill = fillCrop(wide, contentBox(pixels, 600, 150))
    expect(fill.zoom).toBe(1)
  })
})
