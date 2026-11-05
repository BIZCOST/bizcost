import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_URL_TTL_SECONDS,
  FEEDBACK_PAGE_SIZE,
  type FeedbackImageType,
  type FeedbackImageUploadDto,
  type FeedbackImageUploadInput,
  type feedbackSendInput,
  type OkDto,
  type PlatformFeedbackDto,
  type PlatformFeedbackInput,
} from '@bizcost/contracts'
import {
  businesses,
  businessMembers,
  feedback,
  feedbackUploads,
  profiles,
  type Tx,
} from '@bizcost/db'
import { isUuid, newId } from '@bizcost/domain'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  createSignedUpload,
  downloadObject,
  removeObjects,
  signedDownloadUrls,
} from '../admin/storage-admin'
import type { AuthUser } from '../auth'
import type { Context } from '../context'
import { feedbackEmail } from '../email/feedback'
import { AppError } from '../errors'
import { sniffAttachmentType } from './attachments'
import { printableImageType } from './document-files'
import { withPictureCheckSlot } from './picture-check-slot'
import { isoOf } from './stock'

// "Send feedback" (Q4, D-356): any signed-in person, on any page, in a business or not. What they wrote
// and the page's path are saved first; the owner's email goes after the commit, and a failure to send it
// is reported, never the sender's problem: the beta page holds everything. A picture goes straight to
// the private bucket under a folder of the sender's (a person may have no business yet) through an
// upload registry of its own (app.feedback_uploads), then is checked as a line's picture is: its size,
// stored type, extension and first bytes, and decoded by the PDF compiler within the same limits. A send
// claims its upload first (issued → checking, D-362), so one URL sent many times costs one download and
// one place in the compiler's queue, and nothing can overwrite the object under its check. The limits
// are in the database (BZ429 → RATE_LIMITED), and so is who sent it (app.guard_feedback).

const EXTENSION_OF: Readonly<Record<FeedbackImageType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

/** feedback/{user_id}/{uuidv7}.{png|jpg|webp}: only the caller's own folder. */
const picturePattern = (userId: string) =>
  new RegExp(`^feedback/${userId}/${UUID_V7}\\.(png|jpg|webp)$`)

/** As for a business's files: Storage's signed upload URLs work for 2 hours. */
const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000

/** The language of the owner's email. */
const OWNER_LOCALE = 'ar'

async function removeQuietly(ctx: Context, paths: readonly string[]): Promise<boolean> {
  try {
    await removeObjects(ctx.config, paths)
    return true
  } catch {
    return false
  }
}

function discardUploads(tx: Tx, userId: string, paths: readonly string[]) {
  return tx
    .update(feedbackUploads)
    .set({ status: 'discarded' })
    .where(and(eq(feedbackUploads.userId, userId), inArray(feedbackUploads.path, [...paths])))
}

/**
 * `feedback.imageUploadUrl`: where to upload one picture. The path is registered first (RATE_LIMITED
 * after 10 in an hour); the caller's uploads that expired unused are removed on the way.
 */
export async function feedbackImageUploadUrl(
  ctx: Context,
  auth: AuthUser,
  input: FeedbackImageUploadInput,
): Promise<FeedbackImageUploadDto> {
  const path = `feedback/${auth.userId}/${newId()}.${EXTENSION_OF[input.contentType]}`
  const expired = await ctx.tenantTx(null, async (tx) => {
    await tx.insert(feedbackUploads).values({
      id: newId(),
      userId: auth.userId,
      path,
      contentType: input.contentType,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_MS),
    })
    const rows = await tx
      .select({ path: feedbackUploads.path })
      .from(feedbackUploads)
      .where(
        and(
          eq(feedbackUploads.userId, auth.userId),
          // `checking` too: a function stopped in the middle of a check never finished it.
          inArray(feedbackUploads.status, ['issued', 'checking']),
          lt(feedbackUploads.expiresAt, sql`now()`),
        ),
      )
      .limit(20)
    return rows.map((row) => row.path)
  })
  if (expired.length > 0 && (await removeQuietly(ctx, expired))) {
    await ctx.tenantTx(null, (tx) => discardUploads(tx, auth.userId, expired))
  }
  const { signedUrl, token } = await createSignedUpload(ctx.config, path)
  return { path, uploadUrl: signedUrl, token, maxBytes: ATTACHMENT_MAX_BYTES }
}

/** The one send that may check this upload, or attachment_invalid when it is not open. */
async function claimUpload(ctx: Context, auth: AuthUser, path: string): Promise<void> {
  const claimed = await ctx.tenantTx(null, (tx) =>
    tx
      .update(feedbackUploads)
      .set({ status: 'checking' })
      .where(
        and(
          eq(feedbackUploads.userId, auth.userId),
          eq(feedbackUploads.path, path),
          eq(feedbackUploads.status, 'issued'),
        ),
      )
      .returning({ id: feedbackUploads.id }),
  )
  if (claimed.length === 0) {
    throw new AppError('attachment_invalid', { message: 'not an open upload of this person' })
  }
}

/** The check could not finish, through no fault of the picture: the person may send it again. */
async function releaseUpload(ctx: Context, auth: AuthUser, path: string): Promise<void> {
  await ctx.tenantTx(null, (tx) =>
    tx
      .update(feedbackUploads)
      .set({ status: 'issued' })
      .where(
        and(
          eq(feedbackUploads.userId, auth.userId),
          eq(feedbackUploads.path, path),
          eq(feedbackUploads.status, 'checking'),
        ),
      ),
  )
}

/**
 * A refused picture: its path is closed and its object removed, only by the send that holds the claim:
 * the one refused must not take another's file.
 */
async function discard(ctx: Context, auth: AuthUser, path: string): Promise<void> {
  const closed = await ctx.tenantTx(null, (tx) =>
    tx
      .update(feedbackUploads)
      .set({ status: 'discarded' })
      .where(
        and(
          eq(feedbackUploads.userId, auth.userId),
          eq(feedbackUploads.path, path),
          eq(feedbackUploads.status, 'checking'),
        ),
      )
      .returning({ id: feedbackUploads.id }),
  )
  if (closed.length > 0) await removeQuietly(ctx, [path])
}

/**
 * The picture named: the caller's open upload, claimed by this send, whose object passes a line
 * picture's checks. Refused for what it is, it is removed; stopped for a reason of the server's (the
 * compiler busy, Storage down), it opens again.
 */
async function checkedPicture(ctx: Context, auth: AuthUser, path: string) {
  const match = picturePattern(auth.userId).exec(path)
  if (!match) throw new AppError('validation', { message: 'imagePath: not a path of this person' })
  await claimUpload(ctx, auth, path)
  try {
    return await withPictureCheckSlot(auth.userId, async () => {
      const object = await downloadObject(ctx.config, path)
      if (!object) throw new AppError('attachment_invalid', { message: 'no uploaded object' })
      const sniffed = sniffAttachmentType(object.bytes)
      const storedType = object.contentType.split(';')[0]?.trim().toLowerCase()
      if (
        object.bytes.byteLength === 0 ||
        object.bytes.byteLength > ATTACHMENT_MAX_BYTES ||
        sniffed === null ||
        sniffed === 'application/pdf' ||
        EXTENSION_OF[sniffed] !== match[1] ||
        storedType !== sniffed ||
        (await printableImageType(object.bytes)) !== sniffed
      ) {
        await discard(ctx, auth, path)
        throw new AppError('attachment_invalid', { message: 'not an allowed picture' })
      }
      return { path, contentType: sniffed, sizeBytes: object.bytes.byteLength }
    })
  } catch (error) {
    if (!(error instanceof AppError && error.appCode === 'attachment_invalid')) {
      await releaseUpload(ctx, auth, path)
    }
    throw error
  }
}

/** The business the request names (x-business-id), if any. The database checks the membership. */
function businessOfRequest(ctx: Context): string | null {
  const header = ctx.req.headers.get('x-business-id')?.trim()
  if (!header) return null
  if (!isUuid(header)) throw new AppError('validation', { message: 'x-business-id must be a UUID' })
  return header.toLowerCase()
}

/** Who it came from, for the email: read in this request's own context. */
async function senderOf(tx: Tx, auth: AuthUser, businessId: string | null) {
  if (businessId === null) {
    const [profile] = await tx
      .select({ name: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, auth.userId))
    return { businessName: null, memberName: profile?.name ?? null }
  }
  const [row] = await tx
    .select({ businessName: businesses.legalName, memberName: businessMembers.displayName })
    .from(businessMembers)
    .innerJoin(businesses, eq(businesses.id, businessMembers.businessId))
    .where(
      and(
        eq(businessMembers.businessId, businessId),
        eq(businessMembers.userId, auth.userId),
        isNull(businessMembers.deletedAt),
      ),
    )
  return { businessName: row?.businessName ?? null, memberName: row?.memberName ?? null }
}

/**
 * `feedback.send`. FORBIDDEN when the request names a business the caller is not an active member of;
 * RATE_LIMITED past the limits. The upload is closed in the same transaction, so a picture goes on one
 * feedback only.
 */
export async function sendFeedback(
  ctx: Context,
  auth: AuthUser,
  input: z.output<typeof feedbackSendInput>,
): Promise<OkDto> {
  const businessId = businessOfRequest(ctx)
  const picture = input.imagePath ? await checkedPicture(ctx, auth, input.imagePath) : null
  const sender = await ctx
    .tenantTx(businessId, async (tx) => {
      if (picture) {
        const closed = await tx
          .update(feedbackUploads)
          .set({ status: 'used' })
          .where(
            and(
              eq(feedbackUploads.userId, auth.userId),
              eq(feedbackUploads.path, picture.path),
              eq(feedbackUploads.status, 'checking'),
            ),
          )
          .returning({ id: feedbackUploads.id })
        if (closed.length === 0) {
          throw new AppError('attachment_invalid', { message: 'not an open upload of this person' })
        }
      }
      await tx.insert(feedback).values({
        id: newId(),
        userId: auth.userId,
        pagePath: input.pagePath,
        message: input.message,
        imagePath: picture?.path ?? null,
        imageContentType: picture?.contentType ?? null,
        imageSizeBytes: picture?.sizeBytes ?? null,
      })
      return senderOf(tx, auth, businessId)
    })
    .catch(async (error: unknown) => {
      // Refused (the limits, a business not the caller's): the picture goes too, or the same file could
      // be sent to be checked again and again past the limit. A new upload URL has a limit of its own.
      if (picture) await discard(ctx, auth, picture.path)
      throw error
    })
  const to = ctx.config.feedbackEmail
  if (to) {
    try {
      await ctx.email.send(
        feedbackEmail({
          locale: OWNER_LOCALE,
          to,
          message: input.message,
          pagePath: input.pagePath,
          businessName: sender.businessName,
          memberName: sender.memberName,
          email: auth.email,
          hasImage: picture !== null,
          link: `${ctx.config.appUrl}/platform`,
        }),
      )
    } catch (error) {
      // Saved already: the owner reads it on the beta page.
      ctx.reportError(error)
    }
  }
  return { ok: true }
}

interface FeedbackRow extends Record<string, unknown> {
  id: string
  message: string
  page_path: string
  image_path: string | null
  created_at: Date | string
  business_name: string | null
  member_name: string | null
  email: string | null
}

/** `platform.feedback`: newest first, with a signed URL of each picture (null when Storage fails). */
export async function platformFeedback(
  ctx: Context,
  input: PlatformFeedbackInput,
): Promise<PlatformFeedbackDto> {
  const rows = (await ctx.tenantTx(null, (tx) =>
    tx.execute(
      sql`select * from app.platform_feedback(${input.cursor ?? null}::uuid, ${FEEDBACK_PAGE_SIZE + 1}::int)`,
    ),
  )) as unknown as FeedbackRow[]
  const page = rows.slice(0, FEEDBACK_PAGE_SIZE)
  const paths = page.flatMap((row) => (row.image_path ? [row.image_path] : []))
  let urls = new Map<string, string>()
  if (paths.length > 0) {
    try {
      urls = await signedDownloadUrls(ctx.config, paths, ATTACHMENT_URL_TTL_SECONDS)
    } catch (error) {
      ctx.reportError(error)
    }
  }
  return {
    items: page.map((row) => ({
      id: row.id,
      message: row.message,
      pagePath: row.page_path,
      businessName: row.business_name,
      memberName: row.member_name,
      email: row.email,
      imageUrl: row.image_path ? (urls.get(row.image_path) ?? null) : null,
      createdAt: isoOf(row.created_at),
    })),
    nextCursor: rows.length > FEEDBACK_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
  }
}
