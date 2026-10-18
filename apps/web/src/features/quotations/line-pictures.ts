'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { AttachmentContentType } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
import type { QuotationLineDraft } from './quotation-draft'
import { pictureProblem } from './quotation-lines'

// A quotation line's picture (M3 Step 7; the attachment entity `quotation_line`: one image per line,
// PNG, JPEG or WebP, changed only while the quotation is a draft), saved after the quotation: a
// picture picked in the editor is uploaded straight to the private bucket with a signed URL the API
// issues (attachment.uploadUrl), then checked and attached by the API (attachment.add); a picture
// taken off is removed (attachment.remove).

export class PictureError extends Error {
  constructor(readonly key: I18nKey) {
    super(key)
  }
}

/** Saves the lines' picture changes; throws a PictureError with the first problem. */
export function useSaveLinePictures() {
  const trpc = useTRPC()
  const uploadUrl = useMutation(trpc.attachment.uploadUrl.mutationOptions())
  const add = useMutation(trpc.attachment.add.mutationOptions())
  const remove = useMutation(trpc.attachment.remove.mutationOptions())
  return async (lines: readonly QuotationLineDraft[]): Promise<number> => {
    let changed = 0
    for (const line of lines) {
      const { saved, pending, remove: taken } = line.picture
      try {
        if (saved && taken) {
          await remove.mutateAsync({ id: saved.id })
          changed += 1
        }
        if (!pending) continue
        const problem = pictureProblem(pending)
        if (problem) throw new PictureError(problem)
        const record = { entity: 'quotation_line' as const, entityId: line.id }
        const target = await uploadUrl.mutateAsync({
          ...record,
          contentType: pending.type as AttachmentContentType,
        })
        const response = await fetch(target.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': pending.type, 'x-upsert': 'false' },
          body: pending,
        })
        if (!response.ok) {
          throw new PictureError(
            response.status === 413 || response.status === 400 || response.status === 415
              ? 'documents.quotations.editor.pictureInvalid'
              : 'errors.internal',
          )
        }
        await add.mutateAsync({
          ...record,
          path: target.path,
          fileName: pending.name.slice(0, 200),
        })
        changed += 1
      } catch (caught) {
        if (caught instanceof PictureError) throw caught
        throw new PictureError(caught instanceof TypeError ? 'errors.network' : apiErrorKey(caught))
      }
    }
    return changed
  }
}
