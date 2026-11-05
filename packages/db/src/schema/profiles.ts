import { sql } from 'drizzle-orm'
import { check, text, uuid } from 'drizzle-orm/pg-core'
import { app, timestamptz } from './_app'

// One row per auth user (id = auth user id, no FK into `auth`). Upserted by the `me` API procedure,
// anonymized (never deleted) on account deletion. RLS: own row only.
export const profiles = app.table(
  'profiles',
  {
    id: uuid('id').primaryKey(),
    displayName: text('display_name'),
    locale: text('locale').notNull().default('en'),
    lastBusinessId: uuid('last_business_id'),
    anonymizedAt: timestamptz('anonymized_at'),
    // The terms and privacy policy this person accepted, and when (D-358). Asked again when the version
    // changes.
    termsVersion: text('terms_version'),
    termsAcceptedAt: timestamptz('terms_accepted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  () => [
    check('profiles_locale_check', sql`locale in ('en', 'ar')`),
    check('profiles_terms_check', sql`(terms_version is null) = (terms_accepted_at is null)`),
  ],
)

export type Profile = typeof profiles.$inferSelect
export type NewProfile = typeof profiles.$inferInsert
