import {
  documentImageUploadUrlDto,
  documentImageUploadUrlInput,
  documentSettingsDto,
  removeDocumentImageInput,
  setDocumentImageInput,
  updateDocumentSettingsInput,
} from '@bizcost/contracts'
import {
  documentImageUploadUrl,
  removeDocumentImage,
  setDocumentImage,
} from '../services/document-files'
import { documentSettings, updateDocumentSettings } from '../services/document-settings'
import { businessProcedure, requireAnyAccess, router } from '../trpc'

/**
 * Settings → Documents (services/document-settings.ts, document-files.ts; M3 Step 7): served only
 * while Quotations or Invoices is (MODULE_DISABLED otherwise), for `settings.documents.manage` (the
 * Owner and the Admin; FORBIDDEN otherwise): the series' prefixes, padding and first numbers, the
 * footer, a new quotation's terms and validity, the letterhead's accent and watermark, whole amounts,
 * the signatory and the signature and stamp images.
 */
const manage = businessProcedure.use(
  requireAnyAccess(
    ['quotations', 'settings.documents.manage'],
    ['invoices', 'settings.documents.manage'],
  ),
)

export const documentRouter = router({
  /** `document.settings`. */
  settings: manage.output(documentSettingsDto).query(({ ctx }) => documentSettings(ctx)),
  /** `document.updateSettings`: the whole form, `version` as read. */
  updateSettings: manage
    .input(updateDocumentSettingsInput)
    .output(documentSettingsDto)
    .mutation(({ ctx, input }) => updateDocumentSettings(ctx, input)),
  /** `document.imageUploadUrl`: where to upload a new signature or stamp. */
  imageUploadUrl: manage
    .input(documentImageUploadUrlInput)
    .output(documentImageUploadUrlDto)
    .mutation(({ ctx, input }) => documentImageUploadUrl(ctx, input.kind, input.contentType)),
  /** `document.setImage`: saves the uploaded signature or stamp after checking it. */
  setImage: manage
    .input(setDocumentImageInput)
    .output(documentSettingsDto)
    .mutation(async ({ ctx, input }) => {
      await setDocumentImage(ctx, input.kind, input.path)
      return documentSettings(ctx)
    }),
  /** `document.removeImage`: takes the signature or stamp off. */
  removeImage: manage
    .input(removeDocumentImageInput)
    .output(documentSettingsDto)
    .mutation(async ({ ctx, input }) => {
      await removeDocumentImage(ctx, input.kind)
      return documentSettings(ctx)
    }),
})
