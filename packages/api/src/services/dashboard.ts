import { productCostListInput, type DashboardChecklistDto } from '@bizcost/contracts'
import type { Tx } from '@bizcost/db'
import { can } from '@bizcost/domain'
import {
  checklistItemIds,
  checklistItems,
  costStepIds,
  costSteps,
  type ChecklistFacts,
  type CostFacts,
  type PermissionKey,
} from '@bizcost/modules'
import { sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { passes } from '../trpc'
import { listProductCostsIn } from './product-costs'

// Dashboard (ROADMAP.md Step 7, docs/PRODUCT.md §10): the getting-started checklists from real data.
// Which steps a member sees follows the business's capabilities, the modules it has on and the
// member's permissions (checklistItemIds, costStepIds in @bizcost/modules); their state follows the
// business's data (checklistItems, costSteps).
//   - "Finish setting up" (M1): the profile, the TRN, the first team member, the second branch.
//   - "Let's find the real cost of what you sell" (M2 Step 7): what you sell → what you use to make
//     it → purchase prices → your regular running costs → your time (without a team) → your product
//     costs. What the last step counts (costs still incomplete) is the Product costs page's own count
//     (productCost.list), read only for a member who sees costs, in the same transaction, without
//     the services that miss only their optional materials (D-200). Running costs reach every product
//     and service by its price (D-202), so every business is asked for them, one that sells only
//     services too.

/**
 * Whether the business sells only services (D-200): every product or service in use (not archived) is
 * a service; with none in use yet, it was set up as a services business (businesses.business_type).
 * business.context says it (the words about what it sells) and the cost steps follow it.
 */
export async function sellsOnlyServices(tx: Tx, businessId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select case
             when exists (select 1 from app.products_services p
                           where p.business_id = b.id and p.deleted_at is null
                             and p.archived_at is null)
             then not exists (select 1 from app.products_services p
                               where p.business_id = b.id and p.deleted_at is null
                                 and p.archived_at is null and p.type <> 'service')
             else coalesce(b.business_type = 'services', false)
           end as services_only
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as { services_only: boolean }[]
  return row?.services_only === true
}

interface FactsRow extends Record<string, unknown> {
  legal_name: string
  legal_name_ar: string | null
  has_logo: boolean
  trn: string | null
  active_members: number
  pending_invitations: number
  locations: number
  team_before_member: boolean
  second_branch_before_member: boolean
}

/**
 * What the business's data says about the steps, in one statement; the milestones are compared with
 * when the caller's membership was created.
 */
async function readFacts(tx: Tx, businessId: string, memberId: string): Promise<ChecklistFacts> {
  const rows = (await tx.execute(sql`
    select
      b.legal_name,
      b.legal_name_ar,
      b.logo_path is not null as has_logo,
      b.trn,
      (select count(*)::int from app.business_members m
        where m.business_id = b.id and m.status = 'active' and m.deleted_at is null) as active_members,
      (select count(*)::int from app.business_invitations i
        where i.business_id = b.id and i.status = 'pending' and i.expires_at > now()
          and i.deleted_at is null) as pending_invitations,
      (select count(*)::int from app.locations l
        where l.business_id = b.id and l.deleted_at is null) as locations,
      exists (select 1 from app.business_members o
        where o.business_id = b.id and o.id <> me.id and o.created_at < me.created_at)
        as team_before_member,
      coalesce((select l.created_at < me.created_at from app.locations l
        where l.business_id = b.id and l.deleted_at is null
        order by l.created_at, l.id offset 1 limit 1), false) as second_branch_before_member
    from app.businesses b
    join app.business_members me on me.id = ${memberId} and me.business_id = b.id
    where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as FactsRow[]
  const row = rows[0]
  if (!row) throw new AppError('forbidden')
  return {
    legalName: row.legal_name,
    legalNameAr: row.legal_name_ar,
    hasLogo: row.has_logo,
    trn: row.trn,
    activeMembers: row.active_members,
    pendingInvitations: row.pending_invitations,
    locations: row.locations,
    teamBeforeMember: row.team_before_member,
    secondBranchBeforeMember: row.second_branch_before_member,
  }
}

interface CostFactsRow extends Record<string, unknown> {
  items: number
  made_products: number
  made_without_recipe: number
  used_materials: number
  unpriced_materials: number
  running_costs_entered: boolean
  hourly_rate_set: boolean
  items_with_minutes: number
}

/**
 * What the business's data says about the cost steps: the items in use (products and services not
 * archived), which of them are made here (products, not bought ready to sell, D-117) and have nothing
 * in what goes into them yet, the materials they use (their recipes' lines and what items bought
 * ready to sell are bought as) and of those the ones never bought ("no price yet": no posted purchase
 * that stands, D-147), whether a running cost was ever entered (removed ones aside, D-186), the
 * owner's hourly rate and the items with the owner's minutes (D-119). With `costs`, the Product costs
 * page's own reading: how many items' costs are incomplete.
 */
async function readCostFacts(tx: Tx, ctx: BusinessCtx, costs: boolean): Promise<CostFacts> {
  const businessId = ctx.businessId
  const [row] = (await tx.execute(sql`
    with items as (
      select p.id, p.type, p.resale_material_id, p.owner_minutes
        from app.products_services p
       where p.business_id = ${businessId} and p.deleted_at is null and p.archived_at is null
    ),
    lines as (
      select r.product_id, l.material_id
        from app.recipes r
        join app.recipe_lines l
          on l.business_id = r.business_id and l.recipe_id = r.id and l.deleted_at is null
       where r.business_id = ${businessId} and r.deleted_at is null
         and r.product_id in (select i.id from items i)
    ),
    used as (
      select l.material_id from lines l
      union
      select i.resale_material_id from items i where i.resale_material_id is not null
    )
    select
      (select count(*)::int from items) as items,
      (select count(*)::int from items i
        where i.type = 'product' and i.resale_material_id is null) as made_products,
      (select count(*)::int from items i
        where i.type = 'product' and i.resale_material_id is null
          and not exists (select 1 from lines l where l.product_id = i.id)) as made_without_recipe,
      (select count(*)::int from used) as used_materials,
      (select count(*)::int from used u
        where not exists (
          select 1 from app.stock_movements m
           where m.business_id = ${businessId} and m.material_id = u.material_id
             and m.kind = 'purchase'
             and not exists (
               select 1 from app.stock_movements r
                where r.business_id = m.business_id and r.reverses_id = m.id))) as unpriced_materials,
      exists (select 1 from app.running_costs rc
        where rc.business_id = ${businessId} and rc.deleted_at is null) as running_costs_entered,
      b.owner_hourly_rate is not null as hourly_rate_set,
      (select count(*)::int from items i where i.owner_minutes is not null) as items_with_minutes
    from app.businesses b
    where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as CostFactsRow[]
  if (!row) throw new AppError('forbidden')
  let incompleteCosts = 0
  if (costs) {
    const page = await listProductCostsIn(tx, ctx, productCostListInput.parse({ limit: 1 }))
    // Services that miss only their optional materials are complete there (D-203).
    incompleteCosts = page.data.counts.incomplete ?? 0
  }
  return {
    items: row.items,
    madeProducts: row.made_products,
    madeWithoutRecipe: row.made_without_recipe,
    usedMaterials: row.used_materials,
    unpricedMaterials: row.unpriced_materials,
    runningCostsEntered: row.running_costs_entered,
    hourlyRateSet: row.hourly_rate_set,
    itemsWithMinutes: row.items_with_minutes,
    incompleteCosts,
  }
}

/**
 * `dashboard.checklist` (dashboard.home.view): the steps of both checklists this member can act on,
 * with their state, without the milestones the business reached before they joined. A member who can
 * act on none gets no steps, and the database is not read.
 */
export async function getChecklist(ctx: BusinessCtx): Promise<DashboardChecklistDto> {
  const holds = (key: PermissionKey) => can(ctx.access.effective, key)
  const ids = checklistItemIds(ctx.access.capabilities, holds)
  const costIds = costStepIds({
    active: (id) => passes(ctx, [id]),
    can: holds,
    visible: ctx.access.visibleCategories,
    capabilities: ctx.access.capabilities,
  })
  if (ids.length === 0 && costIds.length === 0) return { items: [], costSteps: [] }
  // The Product costs page's count is read only for the step that shows it (costs visible there).
  const costs = costIds.includes('product_costs')
  return ctx.tx(async (tx) => ({
    items:
      ids.length === 0
        ? []
        : checklistItems(ids, await readFacts(tx, ctx.businessId, ctx.access.memberId)),
    costSteps: costIds.length === 0 ? [] : costSteps(costIds, await readCostFacts(tx, ctx, costs)),
  }))
}
