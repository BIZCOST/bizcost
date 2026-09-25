import { sql } from 'drizzle-orm'
import { check, index, text, unique } from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantTable } from './_helpers'

/** What an upload is for. M1: the business logo only. */
export type FileUploadPurpose = 'logo'
/** issued: the signed upload URL may still be used · used: saved (e.g. as the logo) · discarded. */
export type FileUploadStatus = 'issued' | 'used' | 'discarded'

// Every signed upload URL the API issues for the private bucket `business-files`
// (docs/ARCHITECTURE.md §Storage). Storage accepts an object there only while its path is `issued` and
// not expired (trigger app.guard_business_file on storage.objects), so an old upload URL cannot write
// again after the file was saved, refused or removed. At most 10 per business an hour
// (app.file_upload_limits). Expired, unused uploads are removed when the next URL is issued.
export const fileUploads = tenantTable(
  'file_uploads',
  {
    // {business_id}/{purpose}/{uuidv7}.{ext}
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
    check('file_uploads_purpose_check', sql`purpose in ('logo')`),
    check('file_uploads_status_check', sql`status in ('issued', 'used', 'discarded')`),
    check('file_uploads_path_check', sql`starts_with(path, business_id::text || '/')`),
  ],
)

export type FileUpload = typeof fileUploads.$inferSelect
export type NewFileUpload = typeof fileUploads.$inferInsert
