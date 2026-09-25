import {
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  LOGO_URL_TTL_SECONDS,
  type BusinessProfileDto,
  type LogoContentType,
  type LogoUploadUrlDto,
  type LogoUploadUrlInput,
  type SetDefaultLocaleInput,
  type SetLogoInput,
  type UpdateBusinessProfileDto,
  type UpdateBusinessProfileInput,
} from '@bizcost/contracts'
import { businesses, fileUploads, type Tx } from '@bizcost/db'
import { isLocale, newId, parseTrn } from '@bizcost/domain'
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import {
  createSignedUpload,
  downloadObject,
  removeObjects,
  signedDownloadUrl,
} from '../admin/storage-admin'
import type { BusinessCtx } from '../business-context'
import type { ApiConfig } from '../deps'
import { AppError } from '../errors'
import { applySwitch, readBusinessState } from './customize'

// Settings → Business profile and Business language (ROADMAP.md Step 6): legal names, VAT and TRN,
// the business's default language, and the logo in the private bucket (docs/ARCHITECTURE.md §Storage):
// the API registers and issues a signed upload URL for a new object under {business_id}/logo/ (at most
// 10 an hour per business, counted in the database), checks the uploaded object (its place, size,
// stored type and first bytes) before it saves the path, and returns a short-lived signed download URL
// with the profile. Storage accepts a file only at a path still open in app.file_uploads, so an upload
// URL cannot write again once its file was saved, refused or removed. Only this service (and the
// account service) may use the secret-key admin client (lint).

const profileColumns = {
  id: businesses.id,
  legalName: businesses.legalName,
  legalNameAr: businesses.legalNameAr,
  logoPath: businesses.logoPath,
  currency: businesses.currency,
  country: businesses.country,
  timezone: businesses.timezone,
  vatRegistered: businesses.vatRegistered,
  trn: businesses.trn,
  defaultLocale: businesses.defaultLocale,
  version: businesses.version,
}

type ProfileRow = {
  id: string
  legalName: string
  legalNameAr: string | null
  logoPath: string | null
  currency: string
  country: string
  timezone: string
  vatRegistered: boolean
  trn: string | null
  defaultLocale: string
  version: number
}

async function readProfile(tx: Tx, businessId: string): Promise<ProfileRow> {
  const [row] = await tx
    .select(profileColumns)
    .from(businesses)
    .where(and(eq(businesses.id, businessId), isNull(businesses.deletedAt)))
  if (!row) throw new AppError('forbidden')
  return row
}

async function toProfileDto(config: ApiConfig, row: ProfileRow): Promise<BusinessProfileDto> {
  return {
    id: row.id,
    legalName: row.legalName,
    legalNameAr: row.legalNameAr,
    logoUrl: row.logoPath
      ? await signedDownloadUrl(config, row.logoPath, LOGO_URL_TTL_SECONDS)
      : null,
    currency: row.currency.trim(),
    country: row.country.trim(),
    timezone: row.timezone,
    vatRegistered: row.vatRegistered,
    trn: row.trn,
    defaultLocale: isLocale(row.defaultLocale) ? row.defaultLocale : 'en',
    version: row.version,
  }
}

/** `business.profile` (settings.business.view). */
export async function getProfile(ctx: BusinessCtx): Promise<BusinessProfileDto> {
  const row = await ctx.tx((tx) => readProfile(tx, ctx.businessId))
  return toProfileDto(ctx.config, row)
}

function invalid(message: string): AppError {
  return new AppError('validation', { message })
}

/** The TRN to store: 15 digits exactly when VAT registered, else none. */
function trnFor(input: UpdateBusinessProfileInput): string | null {
  const typed = input.trn?.trim() ?? ''
  if (!input.vatRegistered) {
    if (typed !== '') throw invalid('trn: only for a VAT-registered business')
    return null
  }
  const parsed = parseTrn(typed)
  if (!parsed.ok) throw invalid(`trn: ${parsed.error}`)
  return parsed.value
}

/**
 * `business.updateProfile` (settings.business.edit): names, VAT and TRN. `version` must be the
 * version read (CONFLICT otherwise). Switching VAT follows the Customize BizCost rules and reports the
 * modules it turned on or off.
 */
export async function updateProfile(
  ctx: BusinessCtx,
  input: UpdateBusinessProfileInput,
): Promise<UpdateBusinessProfileDto> {
  const trn = trnFor(input)
  const legalNameAr = input.legalNameAr?.trim() ? input.legalNameAr.trim() : null
  const { row, turnedOn, turnedOff } = await ctx.tx(async (tx) => {
    const before = await readBusinessState(tx, ctx.businessId, { lock: true })
    const current = await readProfile(tx, ctx.businessId)
    if (current.version !== input.version) {
      throw new AppError('conflict', { message: 'the profile was changed meanwhile' })
    }
    let modulesOn: string[] = []
    let modulesOff: string[] = []
    if (before.vatRegistered !== input.vatRegistered) {
      const result = await applySwitch(
        tx,
        ctx,
        before,
        { kind: 'capability', key: 'vat_registered' },
        input.vatRegistered,
      )
      modulesOn = result.turnedOn.flatMap((item) => (item.kind === 'module' ? [item.id] : []))
      modulesOff = result.turnedOff.flatMap((item) => (item.kind === 'module' ? [item.id] : []))
    }
    await tx
      .update(businesses)
      .set({
        legalName: input.legalName,
        legalNameAr,
        vatRegistered: input.vatRegistered,
        trn,
      })
      .where(eq(businesses.id, ctx.businessId))
    return {
      row: await readProfile(tx, ctx.businessId),
      turnedOn: modulesOn,
      turnedOff: modulesOff,
    }
  })
  return { profile: await toProfileDto(ctx.config, row), turnedOn, turnedOff }
}

/** `business.setDefaultLocale` (settings.business.edit): the business's language. */
export async function setDefaultLocale(
  ctx: BusinessCtx,
  input: SetDefaultLocaleInput,
): Promise<BusinessProfileDto> {
  const row = await ctx.tx(async (tx) => {
    await tx
      .update(businesses)
      .set({ defaultLocale: input.defaultLocale })
      .where(eq(businesses.id, ctx.businessId))
    return readProfile(tx, ctx.businessId)
  })
  return toProfileDto(ctx.config, row)
}

// ---------------------------------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------------------------------

const EXTENSION_OF: Readonly<Record<LogoContentType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** {business_id}/logo/{uuidv7}.{png|jpg|webp}, all lowercase. */
function logoPathPattern(businessId: string): RegExp {
  return new RegExp(
    `^${businessId}/logo/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(png|jpg|webp)$`,
  )
}

/** The image type the first bytes show (PNG, JPEG or WebP), else null. */
export function sniffImageType(bytes: Uint8Array): LogoContentType | null {
  const starts = (signature: readonly number[], offset = 0) =>
    signature.every((byte, i) => bytes[offset + i] === byte)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

/** Storage's signed upload URLs work for 2 hours; the registry closes the path at the same time. */
const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000

/** Removes objects; a failure only leaves them for a later clean-up (false). */
async function removeQuietly(config: ApiConfig, paths: readonly string[]): Promise<boolean> {
  try {
    await removeObjects(config, paths)
    return true
  } catch {
    return false
  }
}

/** Closes uploads for good: Storage no longer accepts a file at their paths. */
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

/** A refused upload: its path is closed and its object removed. */
async function discard(ctx: BusinessCtx, path: string): Promise<void> {
  await ctx.tx((tx) => closeUploads(tx, ctx.businessId, [path], 'discarded'))
  await removeQuietly(ctx.config, [path])
}

/**
 * `business.logoUploadUrl` (settings.business.edit): where to upload a new logo. The path is registered
 * first (RATE_LIMITED after 10 in an hour); this business's uploads that expired unused are removed on
 * the way (M1 has no background jobs).
 */
export async function logoUploadUrl(
  ctx: BusinessCtx,
  input: LogoUploadUrlInput,
): Promise<LogoUploadUrlDto> {
  const path = `${ctx.businessId}/logo/${newId()}.${EXTENSION_OF[input.contentType]}`
  const expired = await ctx.tx(async (tx) => {
    await tx.insert(fileUploads).values({
      id: newId(),
      businessId: ctx.businessId,
      path,
      purpose: 'logo',
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
  return { path, uploadUrl: signedUrl, token, maxBytes: LOGO_MAX_BYTES }
}

/**
 * `business.setLogo` (settings.business.edit): saves an uploaded logo. The path must be a logo path of
 * this business (VALIDATION otherwise) that logoUploadUrl issued and that was not saved, refused or
 * removed since; the object must exist, be at most LOGO_MAX_BYTES, and be a PNG, JPEG or WebP whose
 * first bytes, stored type and extension agree (FILE_INVALID otherwise, and the object is removed).
 * The previous logo object is removed.
 */
export async function setLogo(ctx: BusinessCtx, input: SetLogoInput): Promise<BusinessProfileDto> {
  const match = logoPathPattern(ctx.businessId).exec(input.path)
  if (!match) throw invalid('path: not a logo path of this business')
  const [upload] = await ctx.tx((tx) =>
    tx
      .select({ status: fileUploads.status })
      .from(fileUploads)
      .where(
        and(
          eq(fileUploads.businessId, ctx.businessId),
          eq(fileUploads.path, input.path),
          isNull(fileUploads.deletedAt),
        ),
      ),
  )
  if (upload?.status !== 'issued') {
    throw new AppError('file_invalid', { message: 'not an open upload of this business' })
  }
  const object = await downloadObject(ctx.config, input.path)
  if (!object) throw new AppError('file_invalid', { message: 'no uploaded object' })
  const sniffed = sniffImageType(object.bytes)
  const expected = LOGO_CONTENT_TYPES.find((type) => EXTENSION_OF[type] === match[1])
  const storedType = object.contentType.split(';')[0]?.trim().toLowerCase()
  if (
    object.bytes.byteLength > LOGO_MAX_BYTES ||
    !sniffed ||
    sniffed !== expected ||
    storedType !== sniffed
  ) {
    await discard(ctx, input.path)
    throw new AppError('file_invalid', { message: 'not an allowed image' })
  }

  const { row, previous } = await ctx.tx(async (tx) => {
    const [before] = await tx
      .select({ logoPath: businesses.logoPath })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .for('update')
    await tx
      .update(businesses)
      .set({ logoPath: input.path })
      .where(eq(businesses.id, ctx.businessId))
    await closeUploads(tx, ctx.businessId, [input.path], 'used')
    const replaced = before?.logoPath ?? null
    if (replaced && replaced !== input.path) {
      await closeUploads(tx, ctx.businessId, [replaced], 'discarded')
    }
    return { row: await readProfile(tx, ctx.businessId), previous: replaced }
  })
  if (previous && previous !== input.path) await removeQuietly(ctx.config, [previous])
  return toProfileDto(ctx.config, row)
}

/** `business.removeLogo` (settings.business.edit). */
export async function removeLogo(ctx: BusinessCtx): Promise<BusinessProfileDto> {
  const { row, previous } = await ctx.tx(async (tx) => {
    const [before] = await tx
      .select({ logoPath: businesses.logoPath })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .for('update')
    if (before?.logoPath) {
      await tx.update(businesses).set({ logoPath: null }).where(eq(businesses.id, ctx.businessId))
      await closeUploads(tx, ctx.businessId, [before.logoPath], 'discarded')
    }
    return { row: await readProfile(tx, ctx.businessId), previous: before?.logoPath ?? null }
  })
  if (previous) await removeQuietly(ctx.config, [previous])
  return toProfileDto(ctx.config, row)
}
