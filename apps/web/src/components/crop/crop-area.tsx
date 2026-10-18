'use client'

import { ZoomInIcon, ZoomOutIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { Button } from '@/components/ui/button'
import { clampCrop, moveCrop, placement, type Crop, type Size } from './crop'

// A picture moved and zoomed in its frame (the logo's square, D-198; a quotation line's 4:3 picture,
// D-299): dragged into place (a finger, the mouse or the arrow keys) and zoomed (the slider, a pinch,
// the wheel or + and −), drawn live on white as it will be saved. The dialogs around it add their
// own buttons (`children`) and previews.

/** What an arrow key moves the picture by (CSS pixels of the crop area). */
const KEY_STEP = 8
/** The slider's steps (the zoom follows it on a log scale: each step multiplies it alike). */
const SLIDER_STEPS = 100

export function sizeOf(image: HTMLImageElement): Size {
  return { width: image.naturalWidth, height: image.naturalHeight }
}

/** Draws the crop in a canvas of `frame` CSS pixels, on white (as the picture is saved and shown). */
export function paintCrop(
  canvas: HTMLCanvasElement | null,
  image: HTMLImageElement,
  crop: Crop,
  frame: Size,
) {
  if (!canvas) return
  const ratio = window.devicePixelRatio || 1
  const width = Math.round(frame.width * ratio)
  const height = Math.round(frame.height * ratio)
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, frame.width, frame.height)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, frame.width, frame.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const at = placement(crop, sizeOf(image), frame)
  context.drawImage(image, at.x, at.y, at.width, at.height)
}

/** The picture drawn live as the crop frames it (a preview), `frame` CSS pixels. */
export function CropPreview({
  image,
  crop,
  frame,
  className,
}: {
  image: HTMLImageElement
  crop: Crop
  frame: Size
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => paintCrop(canvas.current, image, crop, frame), [image, crop, frame])
  return (
    <canvas
      ref={canvas}
      aria-hidden
      className={className}
      style={{ width: frame.width, height: frame.height }}
    />
  )
}

export interface CropAreaLabels {
  /** The crop area's name (a picture you can move). */
  readonly area: string
  /** How to move and zoom it. */
  readonly how: string
  readonly zoom: string
  readonly zoomIn: string
  readonly zoomOut: string
}

export function CropArea({
  image,
  crop,
  onCrop,
  frame,
  minZoom = 1,
  maxZoom,
  labels,
  areaData,
  zoomData,
  children,
}: {
  image: HTMLImageElement
  crop: Crop
  onCrop: (next: Crop) => void
  /** The crop area's size on the screen (CSS pixels): the frame's shape. */
  frame: Size
  /** The least zoom (1: the whole picture; a picture that must fill its frame: its cover zoom). */
  minZoom?: number
  maxZoom: number
  labels: CropAreaLabels
  /** A data attribute on the crop area and on the zoom slider (the tests find them by it). */
  areaData?: string
  zoomData?: string
  /** Buttons under the slider. */
  children?: ReactNode
}) {
  const ids = useId()
  const area = useRef<HTMLCanvasElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const size = sizeOf(image)
  const set = useCallback(
    (next: Crop) => onCrop(clampCrop(next, size, frame, maxZoom, minZoom)),
    [onCrop, size, frame, maxZoom, minZoom],
  )
  const latest = useRef({ crop, set })
  useLayoutEffect(() => {
    latest.current = { crop, set }
  })

  useLayoutEffect(() => paintCrop(area.current, image, crop, frame), [image, crop, frame])

  // The wheel zooms (a listener that may stop the page from scrolling).
  useEffect(() => {
    const element = area.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const { crop: now, set: apply } = latest.current
      apply({ ...now, zoom: now.zoom * Math.exp(-event.deltaY * 0.0015) })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // A drag in CSS pixels, in the crop area's own pixels (the same unless the page is zoomed).
  const scaleToArea = () => {
    const box = area.current?.getBoundingClientRect()
    return box ? frame.width / box.width : 1
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const before = pointers.current.get(event.pointerId)
    if (!before) return
    const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId)
    const now = { x: event.clientX, y: event.clientY }
    if (others.length === 0) {
      const k = scaleToArea()
      set(moveCrop(crop, size, frame, (now.x - before.x) * k, (now.y - before.y) * k))
    } else {
      // A pinch: the zoom follows the distance between the two fingers.
      const [, other] = others[0]!
      const was = Math.hypot(before.x - other.x, before.y - other.y)
      const is = Math.hypot(now.x - other.x, now.y - other.y)
      if (was > 0) set({ ...crop, zoom: crop.zoom * (is / was) })
    }
    pointers.current.set(event.pointerId, now)
  }

  function onPointerEnd(event: PointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(event.pointerId)
  }

  function onKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP, 0],
      ArrowRight: [KEY_STEP, 0],
      ArrowUp: [0, -KEY_STEP],
      ArrowDown: [0, KEY_STEP],
    }
    const move = moves[event.key]
    if (move) {
      event.preventDefault()
      set(moveCrop(crop, size, frame, move[0], move[1]))
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      set({ ...crop, zoom: crop.zoom * 1.1 })
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      set({ ...crop, zoom: crop.zoom / 1.1 })
    }
  }

  // The slider runs from the least zoom to the most on a log scale.
  const span = Math.log(Math.max(maxZoom, minZoom * 1.0001) / minZoom)
  const sliderValue = Math.round((Math.log(crop.zoom / minZoom) / span) * SLIDER_STEPS)
  const dataOf = (name: string | undefined) => (name ? { [`data-${name}`]: '' } : {})
  return (
    <div className="mx-auto space-y-3" style={{ width: frame.width }}>
      <canvas
        ref={area}
        tabIndex={0}
        role="img"
        aria-label={labels.area}
        aria-describedby={`${ids}-how`}
        {...dataOf(areaData)}
        className="block cursor-grab touch-none rounded-2xl ring-1 ring-foreground/15 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring active:cursor-grabbing"
        style={{ width: frame.width, height: frame.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      />
      <p id={`${ids}-how`} className="text-center text-xs text-muted-foreground">
        {labels.how}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={labels.zoomOut}
          onClick={() => set({ ...crop, zoom: crop.zoom / 1.2 })}
        >
          <ZoomOutIcon aria-hidden />
        </Button>
        <input
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={sliderValue}
          aria-label={labels.zoom}
          aria-valuetext={`${Math.round((crop.zoom / minZoom) * 100)}%`}
          {...dataOf(zoomData)}
          onChange={(event) =>
            set({
              ...crop,
              zoom: minZoom * Math.exp((Number(event.target.value) / SLIDER_STEPS) * span),
            })
          }
          className="h-11 min-w-0 flex-1 accent-primary"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={labels.zoomIn}
          onClick={() => set({ ...crop, zoom: crop.zoom * 1.2 })}
        >
          <ZoomInIcon aria-hidden />
        </Button>
      </div>
      {children}
    </div>
  )
}
