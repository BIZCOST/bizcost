import { createHash } from 'node:crypto'
import type {
  CreateLocationInput,
  LocationDto,
  LocationIdInput,
  OkDto,
  RenameLocationInput,
} from '@bizcost/contracts'
import { businesses, insertIdempotent, locations, productLocations, type Tx } from '@bizcost/db'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { capabilityOnNow } from './customize'

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
    if (!(await capabilityOnNow(tx, ctx.businessId, 'multi_location'))) {
      throw new AppError('capability_disabled')
    }
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

/**
 * `location.remove`: soft delete; the default location cannot be removed (DEFAULT_LOCATION). The
 * location leaves the list of every product sold there, in the same transaction (D-129). A product or
 * service sold only there would then be sold everywhere, so the removal is refused while one is
 * (ONLY_LOCATION_OF_PRODUCTS): the owner picks other branches for it first. Likewise while it is the
 * only live branch a member works in or a pending invitation gives (ONLY_BRANCH_OF_MEMBERS).
 */
export async function removeLocation(ctx: BusinessCtx, input: LocationIdInput): Promise<OkDto> {
  return ctx.tx(async (tx) => {
    // Locked first: a product save that names this location (FOR SHARE) finishes before the check
    // below, or waits and then finds it gone.
    const [target] = await tx
      .select(columns)
      .from(locations)
      .where(
        and(
          eq(locations.businessId, ctx.businessId),
          eq(locations.id, input.id),
          isNull(locations.deletedAt),
        ),
      )
      .for('update')
    if (!target) throw new AppError('not_found')
    if (target.isDefault) throw new AppError('default_location')
    const soleLocation = await tx.execute(sql`
      select 1
        from app.product_locations pl
        join app.products_services p
          on p.business_id = pl.business_id and p.id = pl.product_id and p.deleted_at is null
       where pl.business_id = ${ctx.businessId}
         and pl.location_id = ${input.id}
         and pl.deleted_at is null
         and not exists (
           select 1
             from app.product_locations other
             join app.locations l
               on l.business_id = other.business_id and l.id = other.location_id
              and l.deleted_at is null
            where other.business_id = pl.business_id
              and other.product_id = pl.product_id
              and other.location_id <> pl.location_id
              and other.deleted_at is null)
       limit 1`)
    if (soleLocation.length > 0) throw new AppError('only_location_of_products')
    // A member limited to branches ("Branches they work in", Q12) keeps a removed one in their scope
    // (D-054: an empty scope would mean every branch), so a member whose only live branch this is
    // would be shut out of every branch (M3 Step 6 review). Refused while one is, or a pending
    // invitation would make one: the owner changes the branches they work in first
    // (ONLY_BRANCH_OF_MEMBERS). Branches stay on while anyone is limited (BRANCH_LIMITS_IN_USE).
    const soleBranch = await tx.execute(sql`
      select 1
        from app.member_locations ml
        join app.business_members m
          on m.business_id = ml.business_id and m.id = ml.member_id
         and m.deleted_at is null and m.status <> 'removed'
       where ml.business_id = ${ctx.businessId}
         and ml.location_id = ${input.id}
         and ml.deleted_at is null
         and not exists (
           select 1
             from app.member_locations other
             join app.locations l
               on l.business_id = other.business_id and l.id = other.location_id
              and l.deleted_at is null
            where other.business_id = ml.business_id
              and other.member_id = ml.member_id
              and other.location_id <> ml.location_id
              and other.deleted_at is null)
      union all
      select 1
        from app.business_invitations i
       where i.business_id = ${ctx.businessId}
         and i.status = 'pending'
         and i.deleted_at is null
         and ${input.id}::uuid = any(i.location_ids)
         and not exists (
           select 1
             from app.locations l
            where l.business_id = i.business_id
              and l.id = any(i.location_ids)
              and l.id <> ${input.id}::uuid
              and l.deleted_at is null)
       limit 1`)
    if (soleBranch.length > 0) throw new AppError('only_branch_of_members')
    await tx
      .update(productLocations)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(productLocations.businessId, ctx.businessId),
          eq(productLocations.locationId, input.id),
          isNull(productLocations.deletedAt),
        ),
      )
    await tx
      .update(locations)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(locations.businessId, ctx.businessId), eq(locations.id, input.id)))
    return { ok: true as const }
  })
}
