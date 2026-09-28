import { ATTACHMENT_ENTITIES, type AttachmentEntity } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { check, index, integer, text, unique, uuid } from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantTable } from './_helpers'

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

/** What an upload is for: the business logo (M1), or a file attached to a record (M2 Step 3). */
export type FileUploadPurpose = 'logo' | 'attachment'
/** issued: the signed upload URL may still be used · used: saved (e.g. as the logo) · discarded. */
export type FileUploadStatus = 'issued' | 'used' | 'discarded'

// Every signed upload URL the API issues for the private bucket `business-files`
// (docs/ARCHITECTURE.md §Storage). Storage accepts an object there only while its path is `issued` and
// not expired (trigger app.guard_business_file on storage.objects), so an old upload URL cannot write
// again after the file was saved, refused or removed. At most 10 logos and 100 attachments per
// business an hour (app.file_upload_limits). Expired, unused uploads are removed when the next URL is
// issued.
export const fileUploads = tenantTable(
  'file_uploads',
  {
    // {business_id}/logo/{uuidv7}.{ext}, or {business_id}/{entity}/{uuidv7}.{ext} for an attachment.
    path: text('path').notNull(),
    purpose: text('purpose').$type<FileUploadPurpose>().notNull(),
    contentType: text('content_type').notNull(),
    // When the signed upload URL stops working (Storage issues them for 2 hours).
    expiresAt: timestamptz('expires_at').notNull(),
    status: text('status').$type<FileUploadStatus>().notNull().default('issued'),
  },
  (t) => [
    unique('file_uploads_business_id_path_key').on(t.businessId, t.path),
    // The hourly limit counts a business's uploads of the last hour.
    index('file_uploads_created_idx').on(t.businessId, t.createdAt),
    check('file_uploads_purpose_check', sql`purpose in ('logo', 'attachment')`),
    check('file_uploads_status_check', sql`status in ('issued', 'used', 'discarded')`),
    check('file_uploads_path_check', sql`starts_with(path, business_id::text || '/')`),
  ],
)

/**
 * A file attached to a record (M2 Step 3: a purchase's receipts; docs/DATA_MODEL.md §6 Files): the
 * object's path in the private bucket (uploaded through the registry above), the name it had and what
 * it is. `entity` + `entity_id` name the record; a trigger (purchasing_security) checks that it is a
 * record of the same business. Removing an attachment soft-deletes the row and removes the object.
 */
export const attachments = tenantTable(
  'attachments',
  {
    entity: text('entity').$type<AttachmentEntity>().notNull(),
    entityId: uuid('entity_id').notNull(),
    path: text('path').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
  },
  (t) => [
    unique('attachments_business_id_path_key').on(t.businessId, t.path),
    index('attachments_entity_idx').on(t.businessId, t.entity, t.entityId),
    check('attachments_entity_check', sql`entity in (${quoted(ATTACHMENT_ENTITIES)})`),
    check('attachments_path_check', sql`starts_with(path, business_id::text || '/')`),
    check(
      'attachments_file_name_check',
      sql`btrim(file_name) <> '' and char_length(file_name) <= 200`,
    ),
    check('attachments_size_check', sql`size_bytes > 0`),
  ],
)

export type FileUpload = typeof fileUploads.$inferSelect
export type NewFileUpload = typeof fileUploads.$inferInsert
export type Attachment = typeof attachments.$inferSelect
export type NewAttachment = typeof attachments.$inferInsert
