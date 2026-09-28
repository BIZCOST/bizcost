import {
  addAttachmentInput,
  attachmentIdInput,
  attachmentListDto,
  attachmentListInput,
  attachmentResultDto,
  attachmentUploadUrlDto,
  attachmentUploadUrlInput,
  okDto,
} from '@bizcost/contracts'
import {
  addAttachment,
  attachmentUploadUrl,
  listAttachments,
  removeAttachment,
} from '../services/attachments'
import { router } from '../trpc'
import { managePurchases, viewPurchases } from './purchase'

/**
 * Attachments (services/attachments.ts): access follows the record. Their one kind of record is a
 * purchase (its receipts), so: module `purchases`, purchases.documents.view to list and
 * purchases.documents.manage to add or remove; the download URLs are supplier_price.
 */
export const attachmentRouter = router({
  /** `attachment.list`: the record's files with signed download URLs. */
  list: viewPurchases
    .input(attachmentListInput)
    .output(attachmentListDto)
    .query(({ ctx, input }) => listAttachments(ctx, input)),
  /** `attachment.uploadUrl`: where to upload one file for the record. */
  uploadUrl: managePurchases
    .input(attachmentUploadUrlInput)
    .output(attachmentUploadUrlDto)
    .mutation(({ ctx, input }) => attachmentUploadUrl(ctx, input)),
  /** `attachment.add`: attaches the uploaded file after checking it. */
  add: managePurchases
    .input(addAttachmentInput)
    .output(attachmentResultDto)
    .mutation(({ ctx, input }) => addAttachment(ctx, input)),
  /** `attachment.remove`: the file is taken off and deleted. */
  remove: managePurchases
    .input(attachmentIdInput)
    .output(okDto)
    .mutation(({ ctx, input }) => removeAttachment(ctx, input)),
})
