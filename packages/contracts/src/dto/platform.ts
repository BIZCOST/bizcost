import { z } from 'zod'
import { zUuid } from '../primitives'
import { CONTROL_CHARACTER } from '../text'

// The closed beta (D-355–D-358): "Send feedback" for any signed-in person, and the owner's beta page
// (the beta list and the feedback), for platform admins only, checked on the server.

const isoTimestamp = z.iso.datetime({ offset: true })

export const FEEDBACK_MESSAGE_MAX_LENGTH = 4000
export const FEEDBACK_PAGE_PATH_MAX_LENGTH = 300
export const BETA_NOTE_MAX_LENGTH = 200
export const BETA_EMAIL_MAX_LENGTH = 254
/** Feedback items per page of the owner's list. */
export const FEEDBACK_PAGE_SIZE = 50

export const FEEDBACK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type FeedbackImageType = (typeof FEEDBACK_IMAGE_TYPES)[number]

/** Control characters but a line break or a tab: a message may have several lines. */
const CONTROL_BUT_NEWLINES = /[^\P{Cc}\n\r\t]/u

/**
 * The page a feedback came from: the path alone (location.pathname). A query string or a fragment can
 * hold things that are not ours to keep (D-356), so they are refused, not dropped.
 */
export const feedbackPagePath = z
  .string()
  .max(FEEDBACK_PAGE_PATH_MAX_LENGTH)
  .regex(/^\/(?!\/)[A-Za-z0-9._~%/-]*$/, { message: 'a path only' })

/** `feedback.imageUploadUrl`: where to upload one picture of this type. */
export const feedbackImageUploadInput = z.object({ contentType: z.enum(FEEDBACK_IMAGE_TYPES) })
export type FeedbackImageUploadInput = z.input<typeof feedbackImageUploadInput>

export const feedbackImageUploadDto = z.object({
  path: z.string(),
  uploadUrl: z.string(),
  token: z.string(),
  maxBytes: z.int().positive(),
})
export type FeedbackImageUploadDto = z.infer<typeof feedbackImageUploadDto>

/** `feedback.send`. The business and member are never in the input: the database reads them. */
export const feedbackSendInput = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(FEEDBACK_MESSAGE_MAX_LENGTH)
    .refine((value) => !CONTROL_BUT_NEWLINES.test(value), { message: 'control character' }),
  pagePath: feedbackPagePath,
  imagePath: z.string().min(1).max(FEEDBACK_PAGE_PATH_MAX_LENGTH).optional(),
})
export type FeedbackSendInput = z.input<typeof feedbackSendInput>

/** `platform.betaAdd`. */
export const betaAddInput = z.object({
  email: z.string().trim().toLowerCase().max(BETA_EMAIL_MAX_LENGTH).pipe(z.email()),
  note: z
    .string()
    .trim()
    .max(BETA_NOTE_MAX_LENGTH)
    .refine((value) => !CONTROL_CHARACTER.test(value), { message: 'control character' })
    .optional(),
})
export type BetaAddInput = z.input<typeof betaAddInput>

/** `platform.betaRemove`. */
export const betaRemoveInput = z.object({ id: zUuid })
export type BetaRemoveInput = z.input<typeof betaRemoveInput>

export const betaEntryDto = z.object({
  id: zUuid,
  email: z.string(),
  note: z.string().nullable(),
  createdAt: isoTimestamp,
})
export type BetaEntryDto = z.infer<typeof betaEntryDto>

export const betaListDto = z.object({ items: z.array(betaEntryDto) })
export type BetaListDto = z.infer<typeof betaListDto>

/** `platform.feedback`: newest first. */
export const platformFeedbackInput = z.object({ cursor: zUuid.nullish() })
export type PlatformFeedbackInput = z.input<typeof platformFeedbackInput>

export const platformFeedbackItemDto = z.object({
  id: zUuid,
  message: z.string(),
  pagePath: z.string(),
  /** Null: sent from outside any business. */
  businessName: z.string().nullable(),
  /** Null when the account was deleted since, or it has no name yet. */
  memberName: z.string().nullable(),
  email: z.string().nullable(),
  /** A signed URL of its picture; null without one, or when Storage did not answer. */
  imageUrl: z.string().nullable(),
  createdAt: isoTimestamp,
})
export type PlatformFeedbackItemDto = z.infer<typeof platformFeedbackItemDto>

export const platformFeedbackDto = z.object({
  items: z.array(platformFeedbackItemDto),
  /** Pass it as `cursor` for the next page; null on the last. */
  nextCursor: zUuid.nullable(),
})
export type PlatformFeedbackDto = z.infer<typeof platformFeedbackDto>

/** `account.acceptTerms`: only the version in force. */
export const acceptTermsInput = z.object({ termsVersion: z.string().max(40) })
export type AcceptTermsInput = z.input<typeof acceptTermsInput>
