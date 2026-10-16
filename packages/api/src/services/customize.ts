import type {
  BusinessItemDto,
  CustomizationDto,
  CustomizeDto,
  CustomizeInput,
} from '@bizcost/contracts'
import {
  businessCapabilities,
  businesses,
  businessInvitations,
  businessMembers,
  businessModules,
  locations,
  type Tx,
} from '@bizcost/db'
import { newId } from '@bizcost/domain'
import {
  ALWAYS_ENABLED_MODULE_IDS,
  businessStateOf,
  CAPABILITY_KEYS,
  changedCapabilities,
  changedModules,
  MODULES,
  resolveCapabilities,
  resolveEnabledModules,
  toggleBusinessItem,
  type ModuleManifest,
  type SetupItem,
  type SetupState,
} from '@bizcost/modules'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'

// Customize BizCost (docs/PRODUCT.md §5, ROADMAP.md Step 6): one switch at a time, with the same rules
// as the Smart Setup review (toggleBusinessItem in @bizcost/modules), from the business's saved state.
// Rules that need data are checked here: the team cannot be turned off while it has other members or
// pending invitations, nor more than one location while the business has several or while a member
// works only at some branches (or a pending invitation would make one): a limit never outlives the
// branches (M3 Step 6 review). Disabling hides a module; its data stays. Dashboard and Settings are
// always on; VAT is switched in the profile.

/**
 * The business's switches. With `lock`, the business row is locked (FOR UPDATE) first, so switches,
 * the checks that depend on them and new invitations or locations (which lock it FOR SHARE) run one
 * after the other.
 */
export async function readBusinessState(
  tx: Tx,
  businessId: string,
  { lock }: { lock: boolean },
): Promise<SetupState> {
  const query = tx
    .select({ vatRegistered: businesses.vatRegistered })
    .from(businesses)
    .where(and(eq(businesses.id, businessId), isNull(businesses.deletedAt)))
  const [business] = lock ? await query.for('update') : await query
  if (!business) throw new AppError('forbidden')
  const moduleRows = await tx
    .select({ key: businessModules.moduleKey, enabled: businessModules.enabled })
    .from(businessModules)
    .where(and(eq(businessModules.businessId, businessId), isNull(businessModules.deletedAt)))
  const capabilityRows = await tx
    .select({ key: businessCapabilities.key, enabled: businessCapabilities.enabled })
    .from(businessCapabilities)
    .where(
      and(eq(businessCapabilities.businessId, businessId), isNull(businessCapabilities.deletedAt)),
    )
  return businessStateOf({
    enabledModules: resolveEnabledModules(moduleRows),
    capabilities: resolveCapabilities({
      stored: capabilityRows,
      derived: { vat_registered: business.vatRegistered },
    }),
  })
}

/**
 * Whether a stored capability is on as the database has it now: called with the business row locked
 * FOR SHARE (new invitations, locations and branch limits), so a switch committed after the request
 * read its access is seen, and one that comes later waits for this transaction.
 */
export async function capabilityOnNow(
  tx: Tx,
  businessId: string,
  key: 'has_team' | 'multi_location',
): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: businessCapabilities.enabled })
    .from(businessCapabilities)
    .where(
      and(
        eq(businessCapabilities.businessId, businessId),
        eq(businessCapabilities.key, key),
        isNull(businessCapabilities.deletedAt),
      ),
    )
  return row?.enabled === true
}

interface Usage {
  /** More than one member (not removed), or pending invitations. */
  readonly teamInUse: boolean
  /** More than one location. */
  readonly locationsInUse: boolean
  /**
   * A member (not removed) works only at some branches ("Branches they work in", Q12), or a pending
   * invitation would make one. A removed branch counts: it keeps a limit a limit (D-054).
   */
  readonly branchLimitsInUse: boolean
}

async function usageOf(tx: Tx, businessId: string): Promise<Usage> {
  const [counts] = await tx.execute<{
    members: number
    invitations: number
    locations: number
    limited: boolean
  }>(sql`
    select
      (select count(*)::int from ${businessMembers} m
        where m.business_id = ${businessId} and m.deleted_at is null and m.status <> 'removed')
        as members,
      (select count(*)::int from ${businessInvitations} i
        where i.business_id = ${businessId} and i.deleted_at is null and i.status = 'pending')
        as invitations,
      (select count(*)::int from ${locations} l
        where l.business_id = ${businessId} and l.deleted_at is null) as locations,
      (exists (
         select 1 from app.member_locations ml
           join ${businessMembers} m
             on m.business_id = ml.business_id and m.id = ml.member_id
            and m.deleted_at is null and m.status <> 'removed'
          where ml.business_id = ${businessId} and ml.deleted_at is null)
       or exists (
         select 1 from ${businessInvitations} i
          where i.business_id = ${businessId} and i.deleted_at is null and i.status = 'pending'
            and cardinality(i.location_ids) > 0)) as limited
  `)
  return {
    teamInUse: (counts?.members ?? 0) > 1 || (counts?.invitations ?? 0) > 0,
    locationsInUse: (counts?.locations ?? 0) > 1,
    branchLimitsInUse: counts?.limited === true,
  }
}

/** `registry` is the server's (ctx.modules): the dev-only preview shows a module as released (D-125). */
function customizationOf(
  state: SetupState,
  usage: Usage,
  registry: readonly ModuleManifest[] = MODULES,
): CustomizationDto {
  const capabilities: Record<string, boolean> = {}
  for (const key of CAPABILITY_KEYS) {
    capabilities[key] = key === 'vat_registered' ? state.vatRegistered : state.capabilities[key]
  }
  return {
    modules: registry
      .filter((m) => !ALWAYS_ENABLED_MODULE_IDS.includes(m.id))
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        availability: m.availability,
        enabled: state.modules.has(m.id),
      })),
    capabilities,
    teamInUse: usage.teamInUse,
    locationsInUse: usage.locationsInUse,
    branchLimitsInUse: usage.branchLimitsInUse,
  }
}

function toItemDto(item: SetupItem): BusinessItemDto {
  return item.kind === 'module'
    ? { kind: 'module', id: item.id }
    : { kind: 'capability', key: item.key }
}

/** Unknown ids pass through: toggleBusinessItem refuses them (VALIDATION). */
function toSetupItem(item: BusinessItemDto): SetupItem {
  return item.kind === 'module'
    ? ({ kind: 'module', id: item.id } as SetupItem)
    : ({ kind: 'capability', key: item.key } as SetupItem)
}

export interface SwitchResult {
  readonly state: SetupState
  readonly turnedOn: readonly SetupItem[]
  readonly turnedOff: readonly SetupItem[]
}

/**
 * Flips one switch inside the caller's transaction and writes what changed: business_modules rows
 * (explicit on/off), business_capabilities rows (source `user`) and businesses.vat_registered.
 * `before` must come from readBusinessState(tx, …, { lock: true }) in the same transaction.
 */
export async function applySwitch(
  tx: Tx,
  ctx: Pick<BusinessCtx, 'businessId' | 'auth'>,
  before: SetupState,
  item: SetupItem,
  enabled: boolean,
): Promise<SwitchResult> {
  const result = toggleBusinessItem(before, item, enabled)
  if (!result.ok) {
    throw new AppError('validation', { message: `${result.issue}: ${result.item}` })
  }
  const after = result.state
  const { businessId } = ctx

  if (before.capabilities.has_team && !after.capabilities.has_team) {
    if ((await usageOf(tx, businessId)).teamInUse) throw new AppError('team_in_use')
  }
  if (before.capabilities.multi_location && !after.capabilities.multi_location) {
    const usage = await usageOf(tx, businessId)
    if (usage.locationsInUse) throw new AppError('locations_in_use')
    // "Branches they work in" goes with the branches, while a limit would still keep the member's
    // real profit to their branches and team changes within them (M3 Step 6 review). Limits are added
    // under this business row's lock (member.updateLocations, invitation.create), so none slips in
    // after this check.
    if (usage.branchLimitsInUse) throw new AppError('branch_limits_in_use')
  }

  for (const { id, enabled: on } of changedModules(before, after)) {
    await tx
      .insert(businessModules)
      .values({
        id: newId(),
        businessId,
        moduleKey: id,
        enabled: on,
        enabledAt: sql`now()`,
        enabledBy: ctx.auth.userId,
      })
      .onConflictDoUpdate({
        target: [businessModules.businessId, businessModules.moduleKey],
        set: { enabled: on, enabledAt: sql`now()`, enabledBy: ctx.auth.userId, deletedAt: null },
      })
  }
  for (const { key, enabled: on } of changedCapabilities(before, after)) {
    await tx
      .insert(businessCapabilities)
      .values({ id: newId(), businessId, key, enabled: on, source: 'user' })
      .onConflictDoUpdate({
        target: [businessCapabilities.businessId, businessCapabilities.key],
        set: { enabled: on, source: 'user', deletedAt: null },
      })
  }
  if (before.vatRegistered !== after.vatRegistered) {
    await tx
      .update(businesses)
      .set({ vatRegistered: after.vatRegistered })
      .where(eq(businesses.id, businessId))
  }
  return { state: after, turnedOn: result.turnedOn, turnedOff: result.turnedOff }
}

/** `business.customization`: the switches, and whether the team or the locations are in use. */
export async function getCustomization(ctx: BusinessCtx): Promise<CustomizationDto> {
  return ctx.tx(async (tx) => {
    const state = await readBusinessState(tx, ctx.businessId, { lock: false })
    return customizationOf(state, await usageOf(tx, ctx.businessId), ctx.modules)
  })
}

/** `business.customize`: one switch (not VAT, and not Dashboard or Settings). */
export async function customize(ctx: BusinessCtx, input: CustomizeInput): Promise<CustomizeDto> {
  if (input.item.kind === 'capability' && input.item.key === 'vat_registered') {
    throw new AppError('validation', { message: 'VAT is switched in the business profile' })
  }
  return ctx.tx(async (tx) => {
    const before = await readBusinessState(tx, ctx.businessId, { lock: true })
    const result = await applySwitch(tx, ctx, before, toSetupItem(input.item), input.enabled)
    return {
      customization: customizationOf(result.state, await usageOf(tx, ctx.businessId), ctx.modules),
      turnedOn: result.turnedOn.map(toItemDto),
      turnedOff: result.turnedOff.map(toItemDto),
    }
  })
}
