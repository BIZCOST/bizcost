import { describe, expect, it } from 'vitest'
import { clampCrop, coverCrop, coverZoom, moveCrop, placement, type Size } from './crop'

// A quotation line's picture in its 4:3 frame (D-299): filled whatever its shape, centred, never
// stretched; moved and zoomed only where it still fills the frame.

const FRAME: Size = { width: 800, height: 600 }
const SHAPES: Record<string, Size> = {
  portrait: { width: 300, height: 800 },
  landscape: { width: 1200, height: 800 },
  square: { width: 500, height: 500 },
  panorama: { width: 2400, height: 300 },
  tiny: { width: 7, height: 13 },
  saved: { width: 800, height: 600 },
}

describe('coverCrop', () => {
  for (const [name, image] of Object.entries(SHAPES)) {
    it(`${name}: fills the frame, centred, its own shape kept`, () => {
      const at = placement(coverCrop(image, FRAME), image, FRAME)
      // One side exactly the frame's, the other at least it: no band, nothing stretched.
      expect(Math.min(at.width / FRAME.width, at.height / FRAME.height)).toBeCloseTo(1, 9)
      expect(at.width).toBeGreaterThanOrEqual(FRAME.width - 1e-9)
      expect(at.height).toBeGreaterThanOrEqual(FRAME.height - 1e-9)
      expect(at.width / at.height).toBeCloseTo(image.width / image.height, 9)
      // Centred: as much cut on each side.
      expect(at.x + at.width / 2).toBeCloseTo(FRAME.width / 2, 9)
      expect(at.y + at.height / 2).toBeCloseTo(FRAME.height / 2, 9)
    })
  }

  it('a picture of the frame’s shape is drawn whole, exactly in the frame', () => {
    expect(coverZoom(SHAPES.saved!, FRAME)).toBe(1)
    expect(placement(coverCrop(SHAPES.saved!, FRAME), SHAPES.saved!, FRAME)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })
  })
})

describe('clampCrop with the cover zoom as its least', () => {
  it('never zooms out past filling the frame, and keeps the frame covered when moved', () => {
    const image = SHAPES.panorama!
    const least = coverZoom(image, FRAME)
    const out = clampCrop({ zoom: 0.5, cx: 0, cy: 0 }, image, FRAME, least * 4, least)
    expect(out.zoom).toBe(least)
    // Dragged far to the end: the picture's end meets the frame's edge, no further.
    const moved = clampCrop(
      moveCrop(out, image, FRAME, -100_000, 0),
      image,
      FRAME,
      least * 4,
      least,
    )
    const at = placement(moved, image, FRAME)
    expect(at.x + at.width).toBeCloseTo(FRAME.width, 6)
    expect(at.y).toBeCloseTo(0, 6)
    expect(at.y + at.height).toBeCloseTo(FRAME.height, 6)
  })

  it('zooms in up to its most, the chosen point kept at the centre', () => {
    const image = SHAPES.landscape!
    const least = coverZoom(image, FRAME)
    const zoomed = clampCrop({ zoom: 100, cx: 300, cy: 400 }, image, FRAME, least * 4, least)
    expect(zoomed).toEqual({ zoom: least * 4, cx: 300, cy: 400 })
    const at = placement(zoomed, image, FRAME)
    expect(at.x + 300 * (at.width / image.width)).toBeCloseTo(FRAME.width / 2, 6)
  })
})
