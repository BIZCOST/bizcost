import type { DashboardChecklistDto } from '@bizcost/contracts'
import type { Tx } from '@bizcost/db'
import { can } from '@bizcost/domain'
import { checklistItemIds, checklistItems, type ChecklistFacts } from '@bizcost/modules'
import { sql } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'

// Dashboard (ROADMAP.md Step 7, docs/PRODUCT.md §10): the getting-started checklist from real data.
// Which steps a member sees follows the business's capabilities and the member's permissions
// (checklistItemIds, @bizcost/modules); their state follows the business's data (checklistItems).

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

/**
 * `dashboard.checklist` (dashboard.home.view): the steps this member can act on, with their state,
 * without the milestones the business reached before they joined. A member who can act on none gets
 * no steps, and the database is not read.
 */
export async function getChecklist(ctx: BusinessCtx): Promise<DashboardChecklistDto> {
  const ids = checklistItemIds(ctx.access.capabilities, (key) => can(ctx.access.effective, key))
  if (ids.length === 0) return { items: [] }
  const facts = await ctx.tx((tx) => readFacts(tx, ctx.businessId, ctx.access.memberId))
  return { items: checklistItems(ids, facts) }
}
