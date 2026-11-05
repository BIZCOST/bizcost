import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { businessMembers } from './access'
import { app, citext, timestamptz } from './_app'
import { businesses } from './businesses'

// The closed beta (D-350, D-355): rows of the operator's, not of a business, so they have no
// `business_id` and are not tenant tables (docs/DATA_MODEL.md §4). FORCE RLS on all three.

/**
 * Who may create an account while sign-up is closed (the Auth hook auth_hooks.before_user_created,
 * D-355): one row per address added, kept when it is removed. No RLS policy: bizcost_api reaches it
 * only through the app.platform_beta_* functions, which the API calls for platform admins alone.
 * `id` has a default so the owner can add his own first address in the SQL editor (the runbook).
 */
export const betaList = app.table(
  'beta_list',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    note: text('note'),
    /** Who added it; null for a row typed in the SQL editor. */
    addedBy: uuid('added_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Removed from the list: it stops new sign-ups only; an account already made stays. */
    removedAt: timestamptz('removed_at'),
    removedBy: uuid('removed_by'),
  },
  () => [
    uniqueIndex('beta_list_active_email_key')
      .on(sql`lower((email)::text)`)
      .where(sql`removed_at is null`),
    check(
      'beta_list_email_check',
      sql`(email)::text = lower(btrim((email)::text)) and position('@' in (email)::text) > 1 and char_length((email)::text) <= 254`,
    ),
    check('beta_list_note_check', sql`note is null or char_length(note) <= 200`),
  ],
)

/** issued: the signed upload URL may still be used · checking: one send has claimed it · used: on a feedback · discarded. */
export type FeedbackUploadStatus = 'issued' | 'checking' | 'used' | 'discarded'

/**
 * Upload URLs issued for feedback pictures, as app.file_uploads is for a business's files: Storage
 * takes an object at feedback/{user_id}/… only while its path is `issued` here and not expired
 * (app.guard_business_file). A person may have no business yet (Smart Setup), so the folder is theirs.
 * RLS: the caller's own rows. At most 10 an hour per person (app.feedback_upload_limits).
 */
export const feedbackUploads = app.table(
  'feedback_uploads',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    path: text('path').notNull(),
    contentType: text('content_type').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    status: text('status').$type<FeedbackUploadStatus>().notNull().default('issued'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('feedback_uploads_path_key').on(t.path),
    index('feedback_uploads_user_idx').on(t.userId, t.createdAt),
    check(
      'feedback_uploads_status_check',
      sql`status in ('issued', 'checking', 'used', 'discarded')`,
    ),
    check(
      'feedback_uploads_path_check',
      sql`starts_with(path, 'feedback/' || user_id::text || '/')`,
    ),
    check(
      'feedback_uploads_type_check',
      sql`content_type in ('image/png', 'image/jpeg', 'image/webp')`,
    ),
  ],
)

/**
 * "Send feedback" (Q4, D-356): what a signed-in person wrote to the operator, from which page. The
 * trigger app.guard_feedback sets the business and member from the request's own context, so a caller
 * cannot name them, and counts the limits. RLS: a caller may only add their own; nobody reads it but
 * app.platform_feedback, for platform admins. Names are read when it is read, so a deleted account
 * leaves none here.
 */
export const feedback = app.table(
  'feedback',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    /** Null: sent from a page outside any business (the account, Smart Setup). */
    fromBusinessId: uuid('from_business_id'),
    fromMemberId: uuid('from_member_id'),
    /** The page's path only: never a query string or a fragment. */
    pagePath: text('page_path').notNull(),
    message: text('message').notNull(),
    imagePath: text('image_path'),
    imageContentType: text('image_content_type'),
    imageSizeBytes: integer('image_size_bytes'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'feedback_business_fk',
      columns: [t.fromBusinessId],
      foreignColumns: [businesses.id],
    }),
    foreignKey({
      name: 'feedback_member_fk',
      columns: [t.fromBusinessId, t.fromMemberId],
      foreignColumns: [businessMembers.businessId, businessMembers.id],
    }),
    index('feedback_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('feedback_image_path_key')
      .on(t.imagePath)
      .where(sql`image_path is not null`),
    check('feedback_message_check', sql`btrim(message) <> '' and char_length(message) <= 4000`),
    check(
      'feedback_page_path_check',
      sql`page_path ~ '^/[A-Za-z0-9._~%/-]*$' and char_length(page_path) <= 300`,
    ),
    check('feedback_member_check', sql`(from_business_id is null) = (from_member_id is null)`),
    check(
      'feedback_image_check',
      sql`(image_path is null) = (image_content_type is null)
        and (image_path is null) = (image_size_bytes is null)
        and (image_path is null or starts_with(image_path, 'feedback/' || user_id::text || '/'))
        and (image_content_type is null or image_content_type in ('image/png', 'image/jpeg', 'image/webp'))
        and (image_size_bytes is null or image_size_bytes > 0)`,
    ),
  ],
)

export type BetaListEntry = typeof betaList.$inferSelect
export type FeedbackUpload = typeof feedbackUploads.$inferSelect
export type Feedback = typeof feedback.$inferSelect
