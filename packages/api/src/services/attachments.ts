import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_URL_TTL_SECONDS,
  ATTACHMENTS_PER_RECORD_MAX,
  type addAttachmentInput,
  type AttachmentContentType,
  type AttachmentDto,
  type attachmentIdInput,
  type attachmentListInput,
  type AttachmentListDto,
  type AttachmentResultDto,
  type attachmentUploadUrlInput,
  type AttachmentUploadUrlDto,
  type OkDto,
} from '@bizcost/contracts'
import { attachments, fileUploads, type Tx } from '@bizcost/db'
import { newId, type AttachmentEntity } from '@bizcost/domain'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { z } from 'zod'
import {
  createSignedUpload,
  downloadObject,
  removeObjects,
  signedDownloadUrls,
} from '../admin/storage-admin'
import type { BusinessCtx } from '../business-context'
import type { ApiConfig } from '../deps'
import { AppError } from '../errors'
import { isoOf } from './stock'

// Attachments (ROADMAP.md M2 Step 3; DATA_MODEL.md §6 Files; D-030, D-085): files attached to a
// record (a purchase's or an expense's receipts, M2 Steps 3 and 5), in the private bucket
// business-files. As for the logo, the API
// first registers the path {business_id}/{entity}/{uuidv7}.{ext} in app.file_uploads (at most 100
// attachment uploads per business an hour, in the database), then returns Storage's signed upload URL;
// Storage accepts a file only at an open registered path. `attachment.add` then checks the object
// (size, stored type, extension, first bytes: PNG, JPEG, WebP or PDF, up to 10 MB), closes the upload
// and attaches it; a refused object is removed. Downloads are signed URLs of 10 minutes, issued only to
// members who may see supplier prices (a receipt shows them). Removing an attachment soft-deletes the
// row and removes the object. Only this service, the account service and the business profile service
// may use the secret-key admin client (lint).

type UploadInput = z.output<typeof attachmentUploadUrlInput>
type AddInput = z.output<typeof addAttachmentInput>
type ListInput = z.output<typeof attachmentListInput>
type IdInput = z.output<typeof attachmentIdInput>

const EXTENSION_OF: Readonly<Record<AttachmentContentType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

/** The table of each kind of record files are attached to. */
const RECORD_TABLES: Readonly<Record<AttachmentEntity, ReturnType<typeof sql.raw>>> = {
  purchase: sql.raw('app.purchases'),
  expense: sql.raw('app.expenses'),
}

/** Storage's signed upload URLs work for 2 hours; the registry closes the path at the same time. */
const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000

/** {business_id}/{entity}/{uuidv7}.{png|jpg|webp|pdf}, all lowercase. */
function attachmentPathPattern(businessId: string, entity: AttachmentEntity): RegExp {
  return new RegExp(
    `^${businessId}/${entity}/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(png|jpg|webp|pdf)$`,
  )
}

/** The type the first bytes show (PNG, JPEG, WebP or PDF), else null. */
export function sniffAttachmentType(bytes: Uint8Array): AttachmentContentType | null {
  const starts = (signature: readonly number[], offset = 0) =>
    signature.every((byte, i) => bytes[offset + i] === byte)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  return null
}

/**
 * The record must be a live record of this business (NOT_FOUND otherwise). With `lock`, its row is
 * locked FOR NO KEY UPDATE until the transaction ends: a discard of it (FOR UPDATE, then the files it
 * sees) and other attaches to it wait, or this waits for them and then finds a discarded record. With
 * `change` (a file added or taken off), an expense sent for approval or approved is refused
 * (EXPENSE_IN_APPROVAL): what the approver looks at, its receipts included, is what is approved
 * (D-164, D-176). With `ownOnly` too (a member who may not see supplier prices), an expense's files
 * change only on an expense the caller entered, while it is a draft or rejected (FORBIDDEN otherwise,
 * D-184): never another member's, never a final one's.
 */
async function assertRecord(
  tx: Tx,
  businessId: string,
  entity: AttachmentEntity,
  id: string,
  {
    lock = false,
    change = false,
    ownOnly = false,
  }: { lock?: boolean; change?: boolean; ownOnly?: boolean } = {},
) {
  // The attachments table's trigger checks the same (DATA_MODEL.md §6).
  const table = RECORD_TABLES[entity]
  if (!table) throw new AppError('not_found')
  const [row] = (await tx.execute(sql`
    select r.id, r.status, coalesce(r.created_by = app.current_user_id(), false) as mine
      from ${table} r
     where r.business_id = ${businessId} and r.id = ${id} and r.deleted_at is null
     ${lock ? sql`for no key update` : sql``}
  `)) as unknown as { id: string; status: string; mine: boolean }[]
  if (!row) throw new AppError('not_found')
  if (change && entity === 'expense' && (row.status === 'submitted' || row.status === 'approved')) {
    throw new AppError('expense_in_approval')
  }
  if (
    change &&
    ownOnly &&
    entity === 'expense' &&
    (!row.mine || (row.status !== 'draft' && row.status !== 'rejected'))
  ) {
    throw new AppError('forbidden')
  }
}

/** Whether the caller changes only their own expenses' files (no supplier prices, D-184). */
const ownOnly = (ctx: BusinessCtx) => !ctx.access.visibleCategories.has('supplier_price')

async function countOn(tx: Tx, businessId: string, entity: AttachmentEntity, id: string) {
  const [row] = (await tx.execute(sql`
    select count(*)::int as n from app.attachments a
     where a.business_id = ${businessId} and a.entity = ${entity} and a.entity_id = ${id}
       and a.deleted_at is null
  `)) as unknown as { n: number }[]
  return row?.n ?? 0
}

/** Removes objects; a failure only leaves them for a later clean-up (false). */
async function removeQuietly(config: ApiConfig, paths: readonly string[]): Promise<boolean> {
  try {
    await removeObjects(config, paths)
    return true
  } catch {
    return false
  }
}

function closeUploads(
  tx: Tx,
  businessId: string,
  paths: readonly string[],
  status: 'used' | 'discarded',
) {
  return tx
    .update(fileUploads)
    .set({ status })
    .where(
      and(
        eq(fileUploads.businessId, businessId),
        inArray(fileUploads.path, [...paths]),
        isNull(fileUploads.deletedAt),
      ),
    )
}

/**
 * `attachment.uploadUrl` (the record's "manage" key: purchases.documents.manage or
 * expenses.documents.manage): where to upload one file for the record. The
 * path is registered first (RATE_LIMITED after 100 in an hour); at most ATTACHMENTS_PER_RECORD_MAX
 * files per record (VALIDATION). Uploads of the business that expired unused are removed on the way.
 */
export async function attachmentUploadUrl(
  ctx: BusinessCtx,
  input: UploadInput,
): Promise<AttachmentUploadUrlDto> {
  const path = `${ctx.businessId}/${input.entity}/${newId()}.${EXTENSION_OF[input.contentType]}`
  const expired = await ctx.tx(async (tx) => {
    await assertRecord(tx, ctx.businessId, input.entity, input.entityId, {
      change: true,
      ownOnly: ownOnly(ctx),
    })
    if (
      (await countOn(tx, ctx.businessId, input.entity, input.entityId)) >=
      ATTACHMENTS_PER_RECORD_MAX
    ) {
      throw new AppError('validation', { message: 'too many files on this record' })
    }
    await tx.insert(fileUploads).values({
      id: newId(),
      businessId: ctx.businessId,
      path,
      purpose: 'attachment',
      contentType: input.contentType,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_MS),
    })
    const rows = await tx
      .select({ path: fileUploads.path })
      .from(fileUploads)
      .where(
        and(
          eq(fileUploads.businessId, ctx.businessId),
          eq(fileUploads.status, 'issued'),
          lt(fileUploads.expiresAt, sql`now()`),
          isNull(fileUploads.deletedAt),
        ),
      )
      .limit(20)
    return rows.map((row) => row.path)
  })
  if (expired.length > 0 && (await removeQuietly(ctx.config, expired))) {
    await ctx.tx((tx) => closeUploads(tx, ctx.businessId, expired, 'discarded'))
  }
  const { signedUrl, token } = await createSignedUpload(ctx.config, path)
  return { path, uploadUrl: signedUrl, token, maxBytes: ATTACHMENT_MAX_BYTES }
}

interface AttachmentRecord extends Record<string, unknown> {
  id: string
  entity: AttachmentEntity
  entity_id: string
  path: string
  file_name: string
  content_type: AttachmentContentType
  size_bytes: number
  created_at: Date | string
}

async function recordsOf(
  tx: Tx,
  businessId: string,
  where: ReturnType<typeof sql>,
): Promise<AttachmentRecord[]> {
  return (await tx.execute(sql`
    select a.id, a.entity, a.entity_id, a.path, a.file_name, a.content_type, a.size_bytes,
           a.created_at
      from app.attachments a
     where a.business_id = ${businessId} and a.deleted_at is null and ${where}
     order by a.created_at, a.id
  `)) as unknown as AttachmentRecord[]
}

/**
 * Signed download URLs of the business's own attachment paths, only for a member who may see
 * supplier prices (the redactor removes `url` for the others anyway). Storage failing leaves them
 * null (reported).
 */
async function urlsFor(ctx: BusinessCtx, records: readonly AttachmentRecord[]) {
  if (records.length === 0 || !ctx.access.visibleCategories.has('supplier_price')) return new Map()
  const own = records
    .filter((r) => attachmentPathPattern(ctx.businessId, r.entity).test(r.path))
    .map((r) => r.path)
  try {
    return await signedDownloadUrls(ctx.config, own, ATTACHMENT_URL_TTL_SECONDS)
  } catch (error) {
    ctx.reportError(error)
    return new Map<string, string>()
  }
}

function toDto(record: AttachmentRecord, urls: Map<string, string>): AttachmentDto {
  return {
    id: record.id,
    entity: record.entity,
    entityId: record.entity_id,
    fileName: record.file_name,
    contentType: record.content_type,
    sizeBytes: record.size_bytes,
    url: urls.get(record.path) ?? null,
    createdAt: isoOf(record.created_at),
  }
}

/** `attachment.list` (the record's "view" key): the record's files, oldest first. */
export async function listAttachments(
  ctx: BusinessCtx,
  input: ListInput,
): Promise<AttachmentListDto> {
  const records = await ctx.tx(async (tx) => {
    await assertRecord(tx, ctx.businessId, input.entity, input.entityId)
    return recordsOf(
      tx,
      ctx.businessId,
      sql`a.entity = ${input.entity} and a.entity_id = ${input.entityId}`,
    )
  })
  const urls = await urlsFor(ctx, records)
  return { data: { items: records.map((r) => toDto(r, urls)) }, meta: { redacted: [] } }
}

/** A refused upload: its path is closed and its object removed. */
async function discard(ctx: BusinessCtx, path: string): Promise<void> {
  await ctx.tx((tx) => closeUploads(tx, ctx.businessId, [path], 'discarded'))
  await removeQuietly(ctx.config, [path])
}

/**
 * `attachment.add` (the record's "manage" key): attaches an uploaded file. The path must be an
 * attachment path of this business for this kind of record (VALIDATION) that attachment.uploadUrl
 * issued and that was not attached or refused since; the object must exist, be at most 10 MB and be a
 * PNG, JPEG, WebP or PDF whose first bytes, stored type and extension agree (ATTACHMENT_INVALID
 * otherwise, and the object is removed).
 */
export async function addAttachment(
  ctx: BusinessCtx,
  input: AddInput,
): Promise<AttachmentResultDto> {
  const match = attachmentPathPattern(ctx.businessId, input.entity).exec(input.path)
  if (!match) throw new AppError('validation', { message: 'path: not an attachment path here' })
  const [upload] = await ctx.tx(async (tx) => {
    await assertRecord(tx, ctx.businessId, input.entity, input.entityId, {
      change: true,
      ownOnly: ownOnly(ctx),
    })
    return tx
      .select({ status: fileUploads.status, purpose: fileUploads.purpose })
      .from(fileUploads)
      .where(
        and(
          eq(fileUploads.businessId, ctx.businessId),
          eq(fileUploads.path, input.path),
          isNull(fileUploads.deletedAt),
        ),
      )
  })
  if (upload?.status !== 'issued' || upload.purpose !== 'attachment') {
    throw new AppError('attachment_invalid', { message: 'not an open upload of this business' })
  }
  const object = await downloadObject(ctx.config, input.path)
  if (!object) throw new AppError('attachment_invalid', { message: 'no uploaded object' })
  const sniffed = sniffAttachmentType(object.bytes)
  const storedType = object.contentType.split(';')[0]?.trim().toLowerCase()
  if (
    object.bytes.byteLength === 0 ||
    object.bytes.byteLength > ATTACHMENT_MAX_BYTES ||
    !sniffed ||
    EXTENSION_OF[sniffed] !== match[1] ||
    storedType !== sniffed
  ) {
    await discard(ctx, input.path)
    throw new AppError('attachment_invalid', { message: 'not an allowed file' })
  }
  const records = await ctx.tx(async (tx) => {
    // The upload is closed only while it is still open: two adds of one path wait for each other
    // here, and the second finds it closed. Refused later, the transaction reopens it.
    const closed = await tx
      .update(fileUploads)
      .set({ status: 'used' })
      .where(
        and(
          eq(fileUploads.businessId, ctx.businessId),
          eq(fileUploads.path, input.path),
          eq(fileUploads.purpose, 'attachment'),
          eq(fileUploads.status, 'issued'),
          isNull(fileUploads.deletedAt),
        ),
      )
      .returning({ id: fileUploads.id })
    if (closed.length === 0) {
      throw new AppError('attachment_invalid', { message: 'not an open upload of this business' })
    }
    // Then the record, locked until the attachment is committed: a discard in flight has taken it
    // out (NOT_FOUND), or waits and takes this file with it (D-139, D-145). The lock also makes the
    // count below exact.
    await assertRecord(tx, ctx.businessId, input.entity, input.entityId, {
      lock: true,
      change: true,
      ownOnly: ownOnly(ctx),
    })
    if (
      (await countOn(tx, ctx.businessId, input.entity, input.entityId)) >=
      ATTACHMENTS_PER_RECORD_MAX
    ) {
      throw new AppError('validation', { message: 'too many files on this record' })
    }
    const id = newId()
    await tx.insert(attachments).values({
      id,
      businessId: ctx.businessId,
      entity: input.entity,
      entityId: input.entityId,
      path: input.path,
      fileName: input.fileName,
      contentType: sniffed,
      sizeBytes: object.bytes.byteLength,
    })
    return recordsOf(tx, ctx.businessId, sql`a.id = ${id}`)
  })
  const urls = await urlsFor(ctx, records)
  return { data: toDto(records[0]!, urls), meta: { redacted: [] } }
}

/**
 * Takes every file off a record that is being discarded (a draft purchase or expense), in the caller's
 * transaction: the rows are soft-deleted and their uploads closed. Returns their paths, for
 * removeStoredFiles once the transaction has committed.
 */
export async function detachAll(
  tx: Tx,
  businessId: string,
  entity: AttachmentEntity,
  entityId: string,
): Promise<string[]> {
  const rows = await tx
    .update(attachments)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(attachments.businessId, businessId),
        eq(attachments.entity, entity),
        eq(attachments.entityId, entityId),
        isNull(attachments.deletedAt),
      ),
    )
    .returning({ path: attachments.path })
  const paths = rows.map((row) => row.path)
  if (paths.length > 0) await closeUploads(tx, businessId, paths, 'discarded')
  return paths
}

/** Removes the objects of files taken off (detachAll); a failure leaves them for a later clean-up. */
export async function removeStoredFiles(ctx: BusinessCtx, paths: readonly string[]): Promise<void> {
  if (paths.length > 0) await removeQuietly(ctx.config, paths)
}

/**
 * `attachment.remove`: the file is taken off and deleted. `mayManage` checks the caller may change the
 * record the file is on (FORBIDDEN otherwise), once its kind is known; EXPENSE_IN_APPROVAL while the
 * expense it is on is reviewed.
 */
export async function removeAttachment(
  ctx: BusinessCtx,
  input: IdInput,
  mayManage: (entity: AttachmentEntity) => void,
): Promise<OkDto> {
  const path = await ctx.tx(async (tx) => {
    const [found] = await tx
      .select({ entity: attachments.entity, entityId: attachments.entityId })
      .from(attachments)
      .where(
        and(
          eq(attachments.businessId, ctx.businessId),
          eq(attachments.id, input.id),
          isNull(attachments.deletedAt),
        ),
      )
    if (!found) throw new AppError('not_found')
    mayManage(found.entity)
    // The record locked first (as a discard or an approval locks it), then refused while it is
    // reviewed (an expense sent for approval or approved, D-176).
    await assertRecord(tx, ctx.businessId, found.entity, found.entityId, {
      lock: true,
      change: true,
      ownOnly: ownOnly(ctx),
    })
    const [row] = await tx
      .update(attachments)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(attachments.businessId, ctx.businessId),
          eq(attachments.id, input.id),
          isNull(attachments.deletedAt),
        ),
      )
      .returning({ path: attachments.path })
    if (!row) throw new AppError('not_found')
    await closeUploads(tx, ctx.businessId, [row.path], 'discarded')
    return row.path
  })
  await removeQuietly(ctx.config, [path])
  return { ok: true as const }
}
