import { ATTACHMENT_ENTITIES } from '@bizcost/domain'
import { z } from 'zod'
import { withMeta } from '../envelope'
import { zUuid } from '../primitives'
import { ATTACHMENT_CONTENT_TYPES, ATTACHMENT_FILE_NAME_MAX_LENGTH } from '../purchasing'
import { sensitive } from '../sensitivity'
import { CONTROL_CHARACTER } from '../text'

// Attachments (ROADMAP.md M2 Step 3; docs/DATA_MODEL.md §6 Files): files attached to a record, first
// a purchase's receipts. A file goes through the upload registry of the private bucket (D-085): the
// API registers and signs an upload URL, the client puts the file there, then `attachment.add` checks
// the object (size, type, first bytes) and attaches it. Downloads are signed URLs of 10 minutes.
// Access follows the record: a purchase's attachments need purchases.documents.view to list and
// purchases.documents.manage to add or remove. A receipt shows what was paid, so its URL is
// `supplier_price` (members who may not see supplier prices see the file's name, not the file).

const isoTimestamp = z.iso.datetime({ offset: true })

export const attachmentEntityDto = z.enum(ATTACHMENT_ENTITIES)
export const attachmentContentTypeDto = z.enum(ATTACHMENT_CONTENT_TYPES)

/** The record: `entity` + `entityId` (a record of the business, NOT_FOUND otherwise). */
const recordFields = { entity: attachmentEntityDto, entityId: zUuid }

/** A file's name as the user had it (shown in the list; never part of the path). */
const fileNameInput = z
  .string()
  .trim()
  .min(1)
  .max(ATTACHMENT_FILE_NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER.test(value), { message: 'control character' })

/** `attachment.uploadUrl`: where to upload one file of this type for the record. */
export const attachmentUploadUrlInput = z.object({
  ...recordFields,
  contentType: attachmentContentTypeDto,
})
export type AttachmentUploadUrlInput = z.input<typeof attachmentUploadUrlInput>

export const attachmentUploadUrlDto = z.object({
  /** {business_id}/{entity}/{uuidv7}.{ext}: pass it to attachment.add once the file is uploaded. */
  path: z.string(),
  /** Storage's signed upload URL (PUT the file there, with its content type). */
  uploadUrl: z.string(),
  token: z.string(),
  maxBytes: z.int().positive(),
})
export type AttachmentUploadUrlDto = z.infer<typeof attachmentUploadUrlDto>

/** `attachment.add`: attaches an uploaded file to the record it was uploaded for. */
export const addAttachmentInput = z.object({
  ...recordFields,
  path: z.string().min(1).max(300),
  fileName: fileNameInput,
})
export type AddAttachmentInput = z.input<typeof addAttachmentInput>

/** `attachment.list`: the record's files, oldest first. */
export const attachmentListInput = z.object(recordFields)
export type AttachmentListInput = z.input<typeof attachmentListInput>

/** `attachment.remove`. */
export const attachmentIdInput = z.object({ id: zUuid })
export type AttachmentIdInput = z.input<typeof attachmentIdInput>

export const attachmentDto = z.object({
  id: zUuid,
  entity: attachmentEntityDto,
  entityId: zUuid,
  fileName: z.string(),
  contentType: attachmentContentTypeDto,
  sizeBytes: z.int().positive(),
  /** A signed download URL (valid for at least 5 minutes); null when the file is missing. */
  url: sensitive(z.string().nullable(), 'supplier_price'),
  createdAt: isoTimestamp,
})
export type AttachmentDto = z.infer<typeof attachmentDto>

export const attachmentResultDto = withMeta(attachmentDto)
export type AttachmentResultDto = z.infer<typeof attachmentResultDto>

export const attachmentListDto = withMeta(z.object({ items: z.array(attachmentDto) }))
export type AttachmentListDto = z.infer<typeof attachmentListDto>
