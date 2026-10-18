import {
  DOCUMENT_IMAGE_MAX_BYTES,
  DOCUMENT_IMAGE_URL_TTL_SECONDS,
  type DocumentImageContentType,
  type DocumentImageKind,
  type DocumentImageUploadUrlDto,
} from '@bizcost/contracts'
import { attachments, businesses, fileUploads, type Tx } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { isModuleActive } from '@bizcost/modules'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import {
  copyObject,
  createSignedUpload,
  downloadObject,
  removeObjects,
  signedDownloadUrls,
  uploadObject,
} from '../admin/storage-admin'
import type { BusinessCtx } from '../business-context'
import type { ApiConfig } from '../deps'
import { PdfBusyError, pdfEngine, type PdfImageFile } from '../documents/pdf/engine'
import {
  PDF_IMAGES_MAX_BYTES,
  PDF_IMAGES_MAX_DECODED_BYTES,
  pdfImageInfo,
} from '../documents/pdf/images'
import type { DocumentPdfImage, DocumentPdfInput } from '../documents/pdf/input'
import { AppError } from '../errors'

// The documents' files in the private bucket `business-files` (M3 Step 7; D-085, D-224): the
// signature and the stamp printed on the business's documents (uploaded and checked like the logo),
// the images a PDF prints (read here from the business's own Storage objects, never from a path or URL
// a caller gives), the copies of a quotation's line pictures when it is revised or copied, and the
// server-side upload of an issued document's PDF (Step 8's issued copies). Only this service, the
// account, business profile and attachments services may use the secret-key admin client (lint).

/** Storage's signed upload URLs work for 2 hours; the registry closes the path at the same time. */
const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000

/** A path the server registers for its own write: open only for the moment it writes. */
const SERVER_WRITE_TTL_MS = 10 * 60 * 1000

const IMAGE_EXTENSION: Readonly<Record<DocumentImageContentType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

/** {business_id}/{signature|stamp}/{uuidv7}.{png|jpg|webp}. */
function imagePathPattern(businessId: string, kind: DocumentImageKind): RegExp {
  return new RegExp(`^${businessId}/${kind}/${UUID_V7}\\.(png|jpg|webp)$`)
}

/** {business_id}/{logo|signature|stamp|quotation_line}/{uuidv7}.{png|jpg|webp}: the images a PDF prints. */
function printablePathPattern(businessId: string): RegExp {
  return new RegExp(
    `^${businessId}/(logo|signature|stamp|quotation_line)/${UUID_V7}\\.(png|jpg|webp)$`,
  )
}

const CONTENT_TYPE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const

/**
 * The type of an image a PDF may print, or null (D-295): its structure read as its decoder reads it and
 * its size within the PDFs' limits (pdfImageInfo), then decoded once by the PDF compiler itself, the
 * very decoder its PDFs use (a header that looks right over data that does not decode is refused).
 * Throws AppError RATE_LIMITED while the PDF engine is busy.
 */
export async function printableImageType(
  bytes: Uint8Array,
): Promise<(typeof CONTENT_TYPE)[keyof typeof CONTENT_TYPE] | null> {
  const info = pdfImageInfo(bytes)
  if (!info) return null
  let probed: Awaited<ReturnType<ReturnType<typeof pdfEngine>['probe']>>
  try {
    probed = await pdfEngine().probe({ path: `/img/upload.${info.format}`, bytes })
  } catch (error) {
    if (error instanceof PdfBusyError) throw new AppError('rate_limited', { cause: error })
    throw new AppError('internal', { message: 'the image could not be checked', cause: error })
  }
  return probed.ok ? CONTENT_TYPE[info.format] : null
}

/** Whether the business's documents are served (Quotations or Invoices on): its logo then prints. */
export function documentsServed(ctx: BusinessCtx): boolean {
  return ctx.modules.some(
    (m) =>
      (m.id === 'quotations' || m.id === 'invoices') &&
      isModuleActive(m, ctx.access.enabledModules),
  )
}

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

// ---------------------------------------------------------------------------------------------------
// The signature and the stamp (Settings → Documents)
// ---------------------------------------------------------------------------------------------------

const COLUMN = {
  signature: businesses.documentSignaturePath,
  stamp: businesses.documentStampPath,
} as const

/**
 * `document.imageUploadUrl` (settings.documents.manage): where to upload a new signature or stamp.
 * The path is registered first (RATE_LIMITED after 10 an hour of each, in the database); this business's
 * uploads that expired unused are removed on the way.
 */
export async function documentImageUploadUrl(
  ctx: BusinessCtx,
  kind: DocumentImageKind,
  contentType: DocumentImageContentType,
): Promise<DocumentImageUploadUrlDto> {
  const path = `${ctx.businessId}/${kind}/${newId()}.${IMAGE_EXTENSION[contentType]}`
  const expired = await ctx.tx(async (tx) => {
    await tx.insert(fileUploads).values({
      id: newId(),
      businessId: ctx.businessId,
      path,
      purpose: kind,
      contentType,
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
  return { path, uploadUrl: signedUrl, token, maxBytes: DOCUMENT_IMAGE_MAX_BYTES }
}

/**
 * `document.setImage` (settings.documents.manage): saves an uploaded signature or stamp. The path must
 * be one of this business for that kind (VALIDATION) that imageUploadUrl issued and that was not saved,
 * refused or removed since; the object must exist, be at most DOCUMENT_IMAGE_MAX_BYTES and be a PNG,
 * JPEG or WebP within the PDFs' image limits that the PDF compiler decodes, whose first bytes, stored
 * type and extension agree (FILE_INVALID otherwise, and the object is removed; printableImageType).
 * The previous image's object is removed.
 */
export async function setDocumentImage(
  ctx: BusinessCtx,
  kind: DocumentImageKind,
  path: string,
): Promise<void> {
  const match = imagePathPattern(ctx.businessId, kind).exec(path)
  if (!match)
    throw new AppError('validation', { message: `path: not a ${kind} path of this business` })
  const [upload] = await ctx.tx((tx) =>
    tx
      .select({ status: fileUploads.status, purpose: fileUploads.purpose })
      .from(fileUploads)
      .where(
        and(
          eq(fileUploads.businessId, ctx.businessId),
          eq(fileUploads.path, path),
          isNull(fileUploads.deletedAt),
        ),
      ),
  )
  if (upload?.status !== 'issued' || upload.purpose !== kind) {
    throw new AppError('file_invalid', { message: 'not an open upload of this business' })
  }
  const object = await downloadObject(ctx.config, path)
  if (!object) throw new AppError('file_invalid', { message: 'no uploaded object' })
  const sniffed =
    object.bytes.byteLength > DOCUMENT_IMAGE_MAX_BYTES
      ? null
      : await printableImageType(object.bytes)
  const storedType = object.contentType.split(';')[0]?.trim().toLowerCase()
  if (
    object.bytes.byteLength > DOCUMENT_IMAGE_MAX_BYTES ||
    !sniffed ||
    IMAGE_EXTENSION[sniffed] !== match[1] ||
    storedType !== sniffed
  ) {
    await ctx.tx((tx) => closeUploads(tx, ctx.businessId, [path], 'discarded'))
    await removeQuietly(ctx.config, [path])
    throw new AppError('file_invalid', { message: 'not an allowed image' })
  }
  const previous = await ctx.tx(async (tx) => {
    const [before] = await tx
      .select({ path: COLUMN[kind] })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .for('update')
    await tx
      .update(businesses)
      .set(kind === 'signature' ? { documentSignaturePath: path } : { documentStampPath: path })
      .where(eq(businesses.id, ctx.businessId))
    await closeUploads(tx, ctx.businessId, [path], 'used')
    const replaced = before?.path ?? null
    if (replaced && replaced !== path)
      await closeUploads(tx, ctx.businessId, [replaced], 'discarded')
    return replaced
  })
  if (previous && previous !== path) await removeQuietly(ctx.config, [previous])
}

/** `document.removeImage` (settings.documents.manage): takes the signature or stamp off. */
export async function removeDocumentImage(
  ctx: BusinessCtx,
  kind: DocumentImageKind,
): Promise<void> {
  const previous = await ctx.tx(async (tx) => {
    const [before] = await tx
      .select({ path: COLUMN[kind] })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .for('update')
    if (!before?.path) return null
    await tx
      .update(businesses)
      .set(kind === 'signature' ? { documentSignaturePath: null } : { documentStampPath: null })
      .where(eq(businesses.id, ctx.businessId))
    await closeUploads(tx, ctx.businessId, [before.path], 'discarded')
    return before.path
  })
  if (previous) await removeQuietly(ctx.config, [previous])
}

/**
 * Signed download URLs of the signature and the stamp (Settings → Documents' preview), only for paths
 * in this business's own folders; Storage failing leaves them null (reported).
 */
export async function documentImageUrls(
  ctx: BusinessCtx,
  paths: { signature: string | null; stamp: string | null },
): Promise<{ signatureUrl: string | null; stampUrl: string | null }> {
  const own = (kind: DocumentImageKind) => {
    const path = paths[kind]
    return path && imagePathPattern(ctx.businessId, kind).test(path) ? path : null
  }
  const wanted = [own('signature'), own('stamp')].filter((p): p is string => p !== null)
  if (wanted.length === 0) return { signatureUrl: null, stampUrl: null }
  try {
    const urls = await signedDownloadUrls(ctx.config, wanted, DOCUMENT_IMAGE_URL_TTL_SECONDS)
    const signature = own('signature')
    const stamp = own('stamp')
    return {
      signatureUrl: signature ? (urls.get(signature) ?? null) : null,
      stampUrl: stamp ? (urls.get(stamp) ?? null) : null,
    }
  } catch (error) {
    ctx.reportError(error)
    return { signatureUrl: null, stampUrl: null }
  }
}

/**
 * Signed download URLs of the business's own attachment paths of a quotation's lines (their pictures,
 * seen by whoever sees the quotation). Storage failing leaves them out (reported).
 */
export async function linePictureUrls(
  ctx: BusinessCtx,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const pattern = new RegExp(`^${ctx.businessId}/quotation_line/${UUID_V7}\\.(png|jpg|webp)$`)
  const own = paths.filter((path) => pattern.test(path))
  if (own.length === 0) return new Map()
  try {
    return await signedDownloadUrls(ctx.config, own, DOCUMENT_IMAGE_URL_TTL_SECONDS)
  } catch (error) {
    ctx.reportError(error)
    return new Map()
  }
}

// ---------------------------------------------------------------------------------------------------
// The images a PDF prints
// ---------------------------------------------------------------------------------------------------

/** An image a PDF asks for: its key in the template, and the Storage path it lives at. */
export interface PrintableImage {
  readonly key: string
  readonly path: string
}

/** The images a PDF prints, read and checked: the files mapped for the compiler and their entries. */
export interface PrintableImages {
  readonly files: PdfImageFile[]
  readonly images: Record<string, DocumentPdfImage>
  /** What they take decoded, in bytes (the engine's memory check). */
  readonly decodedBytes: number
}

/**
 * The bytes of the images a PDF prints, read from the business's own Storage objects only (a path
 * outside its logo, signature, stamp and line-picture folders is never read), each checked
 * (pdfImageInfo: PNG, JPEG or WebP read as its decoder reads it, its size and decoded size within the
 * limits) and all together within PDF_IMAGES_MAX_DECODED_BYTES and PDF_IMAGES_MAX_BYTES (the first
 * ones asked for are kept: the logo, signature and stamp, then the lines in order). An image that is
 * missing or fails is left out: the PDF prints without it. Storage failing leaves every image out
 * (reported), so the PDF still renders.
 */
export async function readPrintableImages(
  ctx: BusinessCtx,
  wanted: readonly PrintableImage[],
): Promise<PrintableImages> {
  const pattern = printablePathPattern(ctx.businessId)
  const files: PdfImageFile[] = []
  const images: Record<string, DocumentPdfImage> = {}
  let decoded = 0
  let bytes = 0
  for (const image of wanted) {
    if (!pattern.test(image.path) || !/^[a-z0-9-]+$/.test(image.key)) continue
    let object: Awaited<ReturnType<typeof downloadObject>>
    try {
      object = await downloadObject(ctx.config, image.path)
    } catch (error) {
      ctx.reportError(error)
      break
    }
    if (!object) continue
    const info = pdfImageInfo(object.bytes)
    if (!info) continue
    if (
      decoded + info.decodedBytes > PDF_IMAGES_MAX_DECODED_BYTES ||
      bytes + object.bytes.byteLength > PDF_IMAGES_MAX_BYTES
    ) {
      continue
    }
    decoded += info.decodedBytes
    bytes += object.bytes.byteLength
    const path = `/img/${image.key}.${info.format}`
    files.push({ path, bytes: object.bytes })
    images[image.key] = { path, format: info.format, width: info.width, height: info.height }
  }
  return { files, images, decodedBytes: decoded }
}

/**
 * Renders a document's PDF with its images (D-289, D-295): the images are read and checked
 * (readPrintableImages), the input is built with them (`make`) and rendered. Should the compiler
 * refuse it while it has images, each image is decoded on its own (the engine's probe); the ones that
 * do not decode are left out (reported) and it is rendered once more without them, so an image that
 * fails never stops the document. RATE_LIMITED while the engine is busy; INTERNAL when it still cannot
 * be made.
 */
export async function renderDocumentPdf(
  ctx: BusinessCtx,
  wanted: readonly PrintableImage[],
  make: (images: Readonly<Record<string, DocumentPdfImage>>) => DocumentPdfInput,
): Promise<Uint8Array> {
  const read = await readPrintableImages(ctx, wanted)
  const render = (files: readonly PdfImageFile[], images: Record<string, DocumentPdfImage>) =>
    pdfEngine().render({
      data: JSON.stringify(make(images)),
      images: files,
      decodedBytes: read.decodedBytes,
    })
  const failed: (cause: unknown) => never = (cause) => {
    if (cause instanceof PdfBusyError) throw new AppError('rate_limited', { cause })
    throw new AppError('internal', { message: 'the PDF could not be made', cause })
  }
  try {
    return await render(read.files, read.images)
  } catch (cause) {
    if (cause instanceof PdfBusyError || read.files.length === 0) failed(cause)
    const bad = new Set<string>()
    try {
      for (const file of read.files) {
        if (!(await pdfEngine().probe(file)).ok) bad.add(file.path)
      }
    } catch (probing) {
      failed(probing)
    }
    if (bad.size === 0) failed(cause)
    ctx.reportError(new Error(`a printed image could not be decoded (${bad.size}); left out`))
    const files = read.files.filter((file) => !bad.has(file.path))
    const images = Object.fromEntries(
      Object.entries(read.images).filter(([, image]) => !bad.has(image.path)),
    )
    try {
      return await render(files, images)
    } catch (again) {
      return failed(again)
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Line pictures copied with a revised or copied quotation
// ---------------------------------------------------------------------------------------------------

/** A line's picture to copy onto the new revision's line. */
export interface PictureCopy {
  readonly fromPath: string
  readonly toLineId: string
  readonly fileName: string
  readonly contentType: string
  readonly sizeBytes: number
}

/**
 * Copies line pictures to the lines of a new revision or copy (after its transaction committed): each
 * object is copied in Storage to a new registered path of the business and attached to its new line.
 * A copy that fails is left out (reported): the new revision keeps its lines without that picture.
 */
export async function copyLinePictures(
  ctx: BusinessCtx,
  copies: readonly PictureCopy[],
): Promise<void> {
  const pattern = new RegExp(`^${ctx.businessId}/quotation_line/${UUID_V7}\\.(png|jpg|webp)$`)
  for (const copy of copies) {
    const match = pattern.exec(copy.fromPath)
    if (!match) continue
    const path = `${ctx.businessId}/quotation_line/${newId()}.${match[1]}`
    try {
      await ctx.tx((tx) =>
        tx.insert(fileUploads).values({
          id: newId(),
          businessId: ctx.businessId,
          path,
          purpose: 'attachment',
          contentType: copy.contentType,
          expiresAt: new Date(Date.now() + SERVER_WRITE_TTL_MS),
        }),
      )
      await copyObject(ctx.config, copy.fromPath, path)
      await ctx.tx(async (tx) => {
        await closeUploads(tx, ctx.businessId, [path], 'used')
        await tx.insert(attachments).values({
          id: newId(),
          businessId: ctx.businessId,
          entity: 'quotation_line',
          entityId: copy.toLineId,
          path,
          fileName: copy.fileName,
          contentType: copy.contentType,
          sizeBytes: copy.sizeBytes,
        })
      })
    } catch (error) {
      ctx.reportError(error)
      await ctx.tx((tx) => closeUploads(tx, ctx.businessId, [path], 'discarded')).catch(() => {})
      await removeQuietly(ctx.config, [path])
    }
  }
}

/** Removes the objects of files taken off (after their transaction committed). */
export async function removeDocumentObjects(ctx: BusinessCtx, paths: readonly string[]) {
  if (paths.length > 0) await removeQuietly(ctx.config, paths)
}

// ---------------------------------------------------------------------------------------------------
// An issued document's PDF, stored by the server (Step 8's issued copies)
// ---------------------------------------------------------------------------------------------------

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

/**
 * Stores a PDF the server made under {business_id}/document/{uuidv7}.pdf: the path is registered
 * (purpose `document`, at most 500 an hour, in the database), written once through the secret-key
 * client and closed (`used`). Refuses anything that is not a PDF. Returns the path.
 */
export async function storeDocumentPdf(ctx: BusinessCtx, bytes: Uint8Array): Promise<string> {
  if (!PDF_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    throw new AppError('internal', { message: 'not a PDF' })
  }
  const path = `${ctx.businessId}/document/${newId()}.pdf`
  await ctx.tx((tx) =>
    tx.insert(fileUploads).values({
      id: newId(),
      businessId: ctx.businessId,
      path,
      purpose: 'document',
      contentType: 'application/pdf',
      expiresAt: new Date(Date.now() + SERVER_WRITE_TTL_MS),
    }),
  )
  try {
    await uploadObject(ctx.config, path, bytes, 'application/pdf')
  } catch (error) {
    await ctx.tx((tx) => closeUploads(tx, ctx.businessId, [path], 'discarded'))
    throw error
  }
  await ctx.tx((tx) => closeUploads(tx, ctx.businessId, [path], 'used'))
  return path
}
