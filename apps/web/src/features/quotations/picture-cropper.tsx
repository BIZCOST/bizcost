'use client'

import { ImagePlusIcon, Loader2Icon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CropArea, CropPreview, sizeOf } from '@/components/crop/crop-area'
import { clampCrop, coverCrop, coverZoom, type Crop, type Size } from '@/components/crop/crop'
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
import { drawFramed, PICTURE_FRAME } from '@/features/documents/frame-picture'

// "Adjust picture" (the owner's round of 2026-10-18, D-299): a line's picture moved and zoomed in its
// frame, the logo's crop area (D-198) at the PDF's 4:3. It always fills the frame (it zooms out no
// further than that), and beside it the picture shows as it prints. "Use this" draws the 800 × 600
// picture the line saves; "Start again" centres it as it was framed by itself. A saved picture is the
// framed one (the picture as picked is not kept, D-299): the dialog says so, and offers to pick it again
// to choose another part of it. Closed, it gives the focus back to the button that opened it.

/** The crop area on the screen (CSS pixels): the frame's shape, narrow enough for a phone. */
const AREA: Size = { width: 288, height: 216 }
/** The preview: as big as the line's picture in the editor and in the PDF's column. */
const PREVIEW: Size = { width: 80, height: 60 }
/** How far it zooms in: four times filling the frame. */
const ZOOM_IN = 4

export function PictureCropDialog({
  src,
  crop: start,
  name,
  saved = false,
  onPickAgain,
  onCancel,
  onSave,
}: {
  /** The picture as picked (its object URL), or the saved one (its signed URL). */
  src: string
  /** The framing chosen before; null: centred, filling the frame. */
  crop: Crop | null
  name: string
  /** The saved picture (already in its frame: what was cut off when it was framed is gone). */
  saved?: boolean
  /** Closes the dialog and opens the line's picture picker. */
  onPickAgain?: () => void
  onCancel: () => void
  onSave: (picture: File, crop: Crop) => void
}) {
  const { t } = useTranslation()
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  // What had the focus when it opened (it has no trigger of its own to go back to).
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )

  useEffect(() => {
    let live = true
    const picture = new Image()
    // A saved picture comes from the storage's own address: read it without cookies (CORS).
    picture.crossOrigin = 'anonymous'
    picture.decoding = 'async'
    picture.onload = () => {
      if (!live) return
      if (picture.naturalWidth === 0 || picture.naturalHeight === 0) return setFailed(true)
      const size = sizeOf(picture)
      const least = coverZoom(size, PICTURE_FRAME)
      setImage(picture)
      setCrop(
        start
          ? clampCrop(start, size, PICTURE_FRAME, least * ZOOM_IN, least)
          : coverCrop(size, PICTURE_FRAME),
      )
    }
    picture.onerror = () => {
      if (live) setFailed(true)
    }
    picture.src = src
    return () => {
      live = false
    }
  }, [src, start])

  async function save() {
    if (!image || !crop) return
    setSaving(true)
    try {
      onSave(await drawFramed(image, sizeOf(image), crop, name), crop)
    } catch {
      setFailed(true)
      setSaving(false)
    }
  }

  const least = image ? coverZoom(sizeOf(image), AREA) : 1
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onCancel()}>
      <DialogContent
        closeLabel={t('actions.close')}
        className="max-w-md"
        data-picture-cropper
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (opener?.isConnected) opener.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('documents.quotations.editor.crop.title')}</DialogTitle>
          <DialogDescription>
            {saved
              ? t('documents.quotations.editor.crop.savedNote')
              : t('documents.quotations.editor.crop.description')}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <div className="space-y-4">
            <FormAlert tone="error">{t('documents.quotations.editor.crop.cantOpen')}</FormAlert>
            {onPickAgain ? (
              <Button type="button" variant="outline" className="w-full" onClick={onPickAgain}>
                <ImagePlusIcon aria-hidden />
                {t('documents.quotations.editor.crop.pickAgain')}
              </Button>
            ) : null}
          </div>
        ) : image && crop ? (
          <div className="space-y-4">
            <CropArea
              image={image}
              crop={crop}
              onCrop={setCrop}
              frame={AREA}
              minZoom={least}
              maxZoom={least * ZOOM_IN}
              areaData="picture-crop"
              zoomData="picture-zoom"
              labels={{
                area: t('documents.quotations.editor.crop.area'),
                how: t('documents.quotations.editor.crop.how'),
                zoom: t('documents.quotations.editor.crop.zoom'),
                zoomIn: t('documents.quotations.editor.crop.zoomIn'),
                zoomOut: t('documents.quotations.editor.crop.zoomOut'),
              }}
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setCrop(coverCrop(sizeOf(image), PICTURE_FRAME))}
              >
                <RotateCcwIcon aria-hidden />
                {t('documents.quotations.editor.crop.reset')}
              </Button>
            </CropArea>
            <div className="flex items-center gap-3 rounded-xl border bg-card p-2">
              <CropPreview
                image={image}
                crop={crop}
                frame={PREVIEW}
                className="shrink-0 overflow-hidden rounded-lg border"
              />
              <p className="text-sm text-muted-foreground">
                {t('documents.quotations.editor.crop.preview')}
              </p>
            </div>
            {saved && onPickAgain ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                data-picture-pick-again
                onClick={onPickAgain}
              >
                <ImagePlusIcon aria-hidden />
                {t('documents.quotations.editor.crop.pickAgain')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex h-56 items-center justify-center" role="status">
            <Loader2Icon aria-hidden className="size-6 animate-spin text-primary" />
            <span className="sr-only">{t('status.loading')}</span>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            disabled={saving || failed || !crop}
            onClick={() => void save()}
            className="min-w-28"
            data-picture-crop-save
          >
            {t('documents.quotations.editor.crop.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
