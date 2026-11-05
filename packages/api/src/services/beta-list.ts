import type {
  betaAddInput,
  BetaEntryDto,
  BetaListDto,
  BetaRemoveInput,
  OkDto,
} from '@bizcost/contracts'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { Context } from '../context'
import { AppError } from '../errors'
import { isoOf } from './stock'

// The beta list (Q3, D-355, D-357): who may create an account while sign-up is closed, kept by the
// owner on his beta page. bizcost_api has no way to the table but these functions; the router lets only
// platform admins call them.

interface EntryRow extends Record<string, unknown> {
  id: string
  email: string
  note: string | null
  created_at: Date | string
}

const toEntry = (row: EntryRow): BetaEntryDto => ({
  id: row.id,
  email: row.email,
  note: row.note,
  createdAt: isoOf(row.created_at),
})

export async function betaList(ctx: Context): Promise<BetaListDto> {
  const rows = (await ctx.tenantTx(null, (tx) =>
    tx.execute(sql`select * from app.platform_beta_list()`),
  )) as unknown as EntryRow[]
  return { items: rows.map(toEntry) }
}

/** Adds an address; one already on the list keeps its place, with this note when there is one. */
export async function betaAdd(
  ctx: Context,
  input: z.output<typeof betaAddInput>,
): Promise<BetaEntryDto> {
  const [row] = (await ctx.tenantTx(null, (tx) =>
    tx.execute(
      sql`select * from app.platform_beta_add(${input.email}, ${input.note?.trim() || null})`,
    ),
  )) as unknown as EntryRow[]
  if (!row) throw new AppError('internal', { message: 'beta list: no row after the add' })
  return toEntry(row)
}

/** Takes an address off (NOT_FOUND when it is not on). An account already made stays. */
export async function betaRemove(ctx: Context, input: BetaRemoveInput): Promise<OkDto> {
  const [row] = (await ctx.tenantTx(null, (tx) =>
    tx.execute(sql`select app.platform_beta_remove(${input.id}::uuid) as removed`),
  )) as unknown as { removed: boolean }[]
  if (!row?.removed) throw new AppError('not_found')
  return { ok: true }
}
