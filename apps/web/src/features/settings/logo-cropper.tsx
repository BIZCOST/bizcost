'use client'

import { ExpandIcon, Loader2Icon, ShrinkIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { PersonName } from '@/components/app/avatar'
import { FormAlert } from '@/components/form/form-alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  clampCrop,
  contentBox,
  fillCrop,
  LOGO_OUTPUT_SIZE,
  maxZoom,
  moveCrop,
  placement,
  wholeCrop,
  type Crop,
  type Size,
} from './logo-crop'

// "Adjust your logo" (the owner's request of 2026-09-30, O-A): a square crop before a logo is saved,
// and of the logo already saved. The picture is dragged into place (a finger, the mouse or the arrow
// keys) and zoomed (the slider, a pinch, the wheel or + and −); it starts fitted to its content (the
// empty background around it left out), and "Whole logo" shows all of it. Beside it, how it will look
// next to the business's name: in the sidebar and in a phone's header. Saving draws a square picture
// (512 × 512, WebP, or PNG where the browser cannot write WebP; transparent where the picture does
// not reach) that the section uploads as before.

/** The crop area's side on the screen (CSS pixels). */
const AREA = 256
/** What an arrow key moves the picture by (CSS pixels of the crop area). */
const KEY_STEP = 8
/** The slider's steps (the zoom follows it on a log scale: each step multiplies it alike). */
const SLIDER_STEPS = 100

/** Draws the crop in a square canvas of `side` CSS pixels, on white (as the logo shows). */
function paint(
  canvas: HTMLCanvasElement | null,
  image: HTMLImageElement,
  crop: Crop,
  side: number,
) {
  if (!canvas) return
  const ratio = window.devicePixelRatio || 1
  const pixels = Math.round(side * ratio)
  if (canvas.width !== pixels) canvas.width = pixels
  if (canvas.height !== pixels) canvas.height = pixels
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, side, side)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, side, side)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const at = placement(crop, sizeOf(image), side)
  context.drawImage(image, at.x, at.y, at.width, at.height)
}

function sizeOf(image: HTMLImageElement): Size {
  return { width: image.naturalWidth, height: image.naturalHeight }
}

/** The picture's content box (its empty background left out), read on a small copy of it. */
function measureContent(image: HTMLImageElement) {
  const size = sizeOf(image)
  const factor = Math.min(1, 256 / Math.max(size.width, size.height))
  const width = Math.max(1, Math.round(size.width * factor))
  const height = Math.max(1, Math.round(size.height * factor))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0, width, height)
  let box
  try {
    box = contentBox(context.getImageData(0, 0, width, height).data, width, height)
  } catch {
    // A picture the page may not read (it would not save either): the whole picture.
    return null
  }
  if (!box) return null
  return {
    x: box.x / factor,
    y: box.y / factor,
    width: box.width / factor,
    height: box.height / factor,
  }
}

/** The square picture to save: `LOGO_OUTPUT_SIZE` pixels, WebP where the browser writes it. */
export async function renderLogo(image: HTMLImageElement, crop: Crop): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = LOGO_OUTPUT_SIZE
  canvas.height = LOGO_OUTPUT_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no canvas')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const at = placement(crop, sizeOf(image), LOGO_OUTPUT_SIZE)
  context.drawImage(image, at.x, at.y, at.width, at.height)
  const encode = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  const webp = await encode('image/webp', 0.92)
  if (webp && webp.type === 'image/webp') return webp
  const png = await encode('image/png')
  if (!png) throw new Error('no picture')
  return png
}

/** A logo as the shell shows it (BusinessLogo): a square on white, `side` pixels, drawn live. */
function PreviewLogo({
  image,
  crop,
  side,
  className,
}: {
  image: HTMLImageElement
  crop: Crop
  side: number
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => paint(canvas.current, image, crop, side - 4), [image, crop, side])
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-white p-0.5 ring-1 ring-foreground/10 ${className ?? ''}`}
      style={{ width: side, height: side }}
    >
      <canvas ref={canvas} style={{ width: side - 4, height: side - 4 }} />
    </span>
  )
}

function Cropper({
  image,
  businessName,
  role,
  crop,
  onCrop,
  fill,
}: {
  image: HTMLImageElement
  businessName: string
  role: string
  crop: Crop
  onCrop: (next: Crop) => void
  fill: Crop
}) {
  const { t } = useTranslation()
  const ids = useId()
  const area = useRef<HTMLCanvasElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const size = sizeOf(image)
  const max = maxZoom(fill)
  const set = useCallback((next: Crop) => onCrop(clampCrop(next, size, max)), [onCrop, size, max])
  const latest = useRef({ crop, set })
  useLayoutEffect(() => {
    latest.current = { crop, set }
  })

  useLayoutEffect(() => paint(area.current, image, crop, AREA), [image, crop])

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
    return box ? AREA / box.width : 1
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
      set(moveCrop(crop, size, AREA, (now.x - before.x) * k, (now.y - before.y) * k))
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
      set(moveCrop(crop, size, AREA, move[0], move[1]))
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      set({ ...crop, zoom: crop.zoom * 1.1 })
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      set({ ...crop, zoom: crop.zoom / 1.1 })
    }
  }

  const sliderValue = Math.round((Math.log(crop.zoom) / Math.log(max)) * SLIDER_STEPS)
  return (
    <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
      <div className="mx-auto space-y-3" style={{ width: AREA }}>
        <canvas
          ref={area}
          tabIndex={0}
          role="img"
          aria-label={t('settings.business.logo.cropArea')}
          aria-describedby={`${ids}-how`}
          data-logo-crop
          className="block cursor-grab touch-none rounded-2xl ring-1 ring-foreground/15 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring active:cursor-grabbing"
          style={{ width: AREA, height: AREA }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onKeyDown}
        />
        <p id={`${ids}-how`} className="text-center text-xs text-muted-foreground">
          {t('settings.business.logo.cropHow')}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('settings.business.logo.zoomOut')}
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
            aria-label={t('settings.business.logo.zoom')}
            aria-valuetext={`${Math.round(crop.zoom * 100)}%`}
            data-logo-zoom
            onChange={(event) =>
              set({
                ...crop,
                zoom: Math.exp((Number(event.target.value) / SLIDER_STEPS) * Math.log(max)),
              })
            }
            className="h-11 min-w-0 flex-1 accent-primary"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('settings.business.logo.zoomIn')}
            onClick={() => set({ ...crop, zoom: crop.zoom * 1.2 })}
          >
            <ZoomInIcon aria-hidden />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => set(wholeCrop(size))}>
            <ShrinkIcon aria-hidden />
            {t('settings.business.logo.whole')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => set(fill)}>
            <ExpandIcon aria-hidden />
            {t('settings.business.logo.fill')}
          </Button>
        </div>
      </div>
      <div className="min-w-0 space-y-3">
        <p className="text-sm font-medium">{t('settings.business.logo.previewTitle')}</p>
        {/* As the sidebar's switcher shows it from 1024px. */}
        <div
          data-logo-preview="sidebar"
          className="flex min-w-0 items-center gap-3 rounded-xl border bg-card px-2 py-2"
        >
          <PreviewLogo image={image} crop={crop} side={36} className="rounded-lg" />
          <span className="min-w-0 flex-1">
            <PersonName className="text-sm font-semibold">{businessName}</PersonName>
            <span className="block truncate text-xs text-muted-foreground">{role}</span>
          </span>
        </div>
        {/* As a phone's header shows it. */}
        <div
          data-logo-preview="header"
          className="flex min-w-0 items-center gap-2 rounded-xl border bg-card px-2 py-2"
        >
          <PreviewLogo image={image} crop={crop} side={28} className="rounded-lg" />
          <PersonName className="min-w-0 text-sm font-semibold">{businessName}</PersonName>
        </div>
      </div>
    </div>
  )
}

/**
 * The dialog around the crop: it opens the picture at `src` (a chosen file's address, or the saved
 * logo's), and saves the square picture with `onSave` (the section uploads it).
 */
export function LogoCropDialog({
  src,
  businessName,
  role,
  onCancel,
  onSave,
  error,
}: {
  src: string
  businessName: string
  role: string
  /** Why the last save failed (translated), if it did. */
  error: string | null
  onCancel: () => void
  /** Uploads the square picture; resolves once done (the dialog then closes), or throws. */
  onSave: (picture: Blob) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [fill, setFill] = useState<Crop | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    const picture = new Image()
    // The saved logo comes from the storage's own address: read it without cookies (CORS).
    picture.crossOrigin = 'anonymous'
    picture.decoding = 'async'
    picture.onload = () => {
      if (!live) return
      if (picture.naturalWidth === 0 || picture.naturalHeight === 0) return setFailed(true)
      const size = sizeOf(picture)
      const fitted = clampCrop(
        fillCrop(size, measureContent(picture)),
        size,
        Number.POSITIVE_INFINITY,
      )
      setImage(picture)
      setFill(fitted)
      setCrop(fitted)
    }
    picture.onerror = () => {
      if (live) setFailed(true)
    }
    picture.src = src
    return () => {
      live = false
    }
  }, [src])

  async function save() {
    if (!image || !crop) return
    setSaving(true)
    try {
      const picture = await renderLogo(image, crop)
      if (!(await onSave(picture))) setSaving(false)
    } catch {
      setFailed(true)
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onCancel()}>
      <DialogContent closeLabel={t('actions.close')} className="max-w-2xl" data-logo-cropper>
        <DialogHeader>
          <DialogTitle>{t('settings.business.logo.cropTitle')}</DialogTitle>
          <DialogDescription>{t('settings.business.logo.cropDescription')}</DialogDescription>
        </DialogHeader>
        {failed ? (
          <FormAlert tone="error">{t('settings.business.logo.cantOpen')}</FormAlert>
        ) : image && crop && fill ? (
          <Cropper
            image={image}
            businessName={businessName}
            role={role}
            crop={crop}
            onCrop={setCrop}
            fill={fill}
          />
        ) : (
          <div className="flex h-64 items-center justify-center" role="status">
            <Loader2Icon aria-hidden className="size-6 animate-spin text-primary" />
            <span className="sr-only">{t('status.loading')}</span>
          </div>
        )}
        {error && !failed ? <FormAlert tone="error">{error}</FormAlert> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            disabled={saving || failed || !crop}
            onClick={() => void save()}
            className="min-w-28"
          >
            {saving ? t('settings.business.logo.uploading') : t('settings.business.logo.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
