import { createHash } from 'node:crypto'
import type {
  CreateLocationInput,
  LocationDto,
  LocationIdInput,
  OkDto,
  RenameLocationInput,
} from '@bizcost/contracts'
import { businessCapabilities, businesses, insertIdempotent, locations, type Tx } from '@bizcost/db'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'

// Settings → Locations (ROADMAP.md Step 6): only for a business with more than one location
// (capability multi_location, checked by the router) and settings.locations.manage. Smart Setup created
// the default location; the default can move but never be removed, so a business always has one.
// Removing is a soft delete: a member's location scope keeps it (D-054).

const columns = {
  id: locations.id,
  name: locations.name,
  isDefault: locations.isDefault,
  version: locations.version,
}

async function listLocations(tx: Tx, businessId: string): Promise<LocationDto[]> {
  return tx
    .select(columns)
    .from(locations)
    .where(and(eq(locations.businessId, businessId), isNull(locations.deletedAt)))
    .orderBy(desc(locations.isDefault), asc(locations.createdAt), asc(locations.id))
}

async function findLocation(tx: Tx, businessId: string, id: string) {
  const [row] = await tx
    .select(columns)
    .from(locations)
    .where(
      and(eq(locations.businessId, businessId), eq(locations.id, id), isNull(locations.deletedAt)),
    )
  return row
}

/** `location.list`: the default first, then by creation. */
export function listBusinessLocations(ctx: BusinessCtx): Promise<LocationDto[]> {
  return ctx.tx((tx) => listLocations(tx, ctx.businessId))
}

/**
 * `location.create`: idempotent on the client's id (the same name again returns the location; another
 * name, or an id used elsewhere, is CONFLICT). The capability is checked again with the business row
 * locked, so turning multi-location off cannot race a new location.
 */
export async function createLocation(
  ctx: BusinessCtx,
  input: CreateLocationInput,
): Promise<LocationDto> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ name: input.name }))
    .digest('hex')
  return ctx.tx(async (tx) => {
    await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .for('share')
    const [capability] = await tx
      .select({ enabled: businessCapabilities.enabled })
      .from(businessCapabilities)
      .where(
        and(
          eq(businessCapabilities.businessId, ctx.businessId),
          eq(businessCapabilities.key, 'multi_location'),
          isNull(businessCapabilities.deletedAt),
        ),
      )
    if (!capability?.enabled) throw new AppError('capability_disabled')
    const row = await insertIdempotent(tx, locations, {
      id: input.id,
      businessId: ctx.businessId,
      name: input.name,
      isDefault: false,
      requestHash,
    })
    if (row.deletedAt !== null) throw new AppError('conflict', { message: 'location was removed' })
    return { id: row.id, name: row.name, isDefault: row.isDefault, version: row.version }
  })
}

/** `location.rename`: CONFLICT when the location changed since `version`, NOT_FOUND when gone. */
export async function renameLocation(
  ctx: BusinessCtx,
  input: RenameLocationInput,
): Promise<LocationDto> {
  return ctx.tx(async (tx) => {
    const [row] = await tx
      .update(locations)
      .set({ name: input.name })
      .where(
        and(
          eq(locations.businessId, ctx.businessId),
          eq(locations.id, input.id),
          isNull(locations.deletedAt),
          eq(locations.version, input.version),
        ),
      )
      .returning(columns)
    if (row) return row
    if (await findLocation(tx, ctx.businessId, input.id)) throw new AppError('conflict')
    throw new AppError('not_found')
  })
}

/** `location.setDefault`: makes a location the main one; returns the list. */
export async function setDefaultLocation(
  ctx: BusinessCtx,
  input: LocationIdInput,
): Promise<LocationDto[]> {
  return ctx.tx(async (tx) => {
    const target = await findLocation(tx, ctx.businessId, input.id)
    if (!target) throw new AppError('not_found')
    if (!target.isDefault) {
      // One default per business (partial unique index): clear the old one first.
      await tx
        .update(locations)
        .set({ isDefault: false })
        .where(
          and(
            eq(locations.businessId, ctx.businessId),
            eq(locations.isDefault, true),
            isNull(locations.deletedAt),
          ),
        )
      await tx
        .update(locations)
        .set({ isDefault: true })
        .where(and(eq(locations.businessId, ctx.businessId), eq(locations.id, input.id)))
    }
    return listLocations(tx, ctx.businessId)
  })
}

/** `location.remove`: soft delete; the default location cannot be removed (DEFAULT_LOCATION). */
export async function removeLocation(ctx: BusinessCtx, input: LocationIdInput): Promise<OkDto> {
  return ctx.tx(async (tx) => {
    const target = await findLocation(tx, ctx.businessId, input.id)
    if (!target) throw new AppError('not_found')
    if (target.isDefault) throw new AppError('default_location')
    await tx
      .update(locations)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(locations.businessId, ctx.businessId), eq(locations.id, input.id)))
    return { ok: true as const }
  })
}
