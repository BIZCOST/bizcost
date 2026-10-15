import type {
  ChannelStatementDto,
  ChannelStatementListDto,
  ChannelStatementResultDto,
  createStatementInput,
  OkDto,
  statementIdInput,
  statementListInput,
  statementVersionInput,
  updateStatementInput,
} from '@bizcost/contracts'
import { channelStatements, createIdempotent, type Tx } from '@bizcost/db'
import { sumDecimals, type SaleImportStatus } from '@bizcost/domain'
import { and, eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError, sqlStateOf } from '../errors'
import { assertQueryable } from '../trpc'
import { requestHashOf } from './catalog'
import { isoOf, lockPostingBusiness } from './stock'

// A sales channel's statements (ROADMAP.md M3 Step 4; the owner's answer Q8 of D-218; D-223): a
// delivery app's or a marketplace's statement for some days, with what it kept (commission, payment
// fees, other fees, ads and refunds charged: together its fees for those days) and, for information,
// the sales it lists and its payout. Typed in a form, imported from the statement template, or made
// from an import's fee column (services/sale-imports.ts). Module `sales`; sales.channels.manage and
// the costs switch (every amount is `cost`, D-187: FORBIDDEN before anything is read).
//
// A posted statement replaces the channel's marked fee expenses and its commission % for the days it
// covers (channelFeesOf; a statement over two months is split between them by days, statementParts).
// Posted statements of a channel never cover the same day twice (an exclusion constraint:
// STATEMENT_OVERLAP); posting and reversing obey the books-closed date for every day they cover
// (BOOKS_CLOSED; the database refuses it too). A posted statement is never edited: it is reversed.

type CreateInput = z.output<typeof createStatementInput>
type UpdateInput = z.output<typeof updateStatementInput>
type IdInput = z.output<typeof statementIdInput>
type VersionInput = z.output<typeof statementVersionInput>
type ListInput = z.output<typeof statementListInput>

/** Every amount of a statement is `cost` (D-187): FORBIDDEN without the costs switch. */
function assertCostsShown(ctx: BusinessCtx): void {
  assertQueryable(ctx, [{ name: 'fees', category: 'cost' }])
}

interface StatementRecord extends Record<string, unknown> {
  id: string
  channel_id: string
  channel_name: string
  status: SaleImportStatus
  period_from: string
  period_to: string
  sales: string | null
  commission: string
  payment_fees: string
  other_fees: string
  ads: string
  refunds_charged: string
  payout: string | null
  notes: string | null
  import_id: string | null
  posted_at: Date | string | null
  reversed_at: Date | string | null
  created_at: Date | string
  version: number
}

const columns = sql`
  s.id, s.channel_id, c.name as channel_name, s.status, s.period_from::text as period_from,
  s.period_to::text as period_to, trim_scale(s.sales)::text as sales,
  trim_scale(s.commission)::text as commission, trim_scale(s.payment_fees)::text as payment_fees,
  trim_scale(s.other_fees)::text as other_fees, trim_scale(s.ads)::text as ads,
  trim_scale(s.refunds_charged)::text as refunds_charged, trim_scale(s.payout)::text as payout,
  s.notes, s.import_id, s.posted_at, s.reversed_at, s.created_at, s.version`

function dtoOf(row: StatementRecord): ChannelStatementDto {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    status: row.status,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    sales: row.sales,
    commission: row.commission,
    paymentFees: row.payment_fees,
    otherFees: row.other_fees,
    ads: row.ads,
    refundsCharged: row.refunds_charged,
    fees: sumDecimals([
      row.commission,
      row.payment_fees,
      row.other_fees,
      row.ads,
      row.refunds_charged,
    ]),
    payout: row.payout,
    notes: row.notes,
    importId: row.import_id,
    postedAt: isoOf(row.posted_at),
    reversedAt: isoOf(row.reversed_at),
    createdAt: isoOf(row.created_at),
    version: row.version,
  }
}

async function readStatement(tx: Tx, businessId: string, id: string): Promise<ChannelStatementDto> {
  const [row] = (await tx.execute(sql`
    select ${columns}
      from app.channel_statements s
      join app.sales_channels c on c.business_id = s.business_id and c.id = s.channel_id
     where s.business_id = ${businessId} and s.id = ${id} and s.deleted_at is null
  `)) as unknown as StatementRecord[]
  if (!row) throw new AppError('not_found')
  return dtoOf(row)
}

function result(data: ChannelStatementDto): ChannelStatementResultDto {
  return { data, meta: { redacted: [] } }
}

/** A channel of the business (NOT_FOUND); an archived one only for one that already names it. */
async function assertChannel(tx: Tx, businessId: string, channelId: string, current?: string) {
  const [row] = (await tx.execute(sql`
    select c.id, c.archived_at is not null as archived from app.sales_channels c
     where c.business_id = ${businessId} and c.id = ${channelId} and c.deleted_at is null
  `)) as unknown as { id: string; archived: boolean }[]
  if (!row) throw new AppError('not_found')
  if (row.archived && row.id !== current) {
    throw new AppError('validation', { message: 'channelId: archived' })
  }
}

/** `channelStatement.list`: a channel's statements, the latest days first. */
export function listStatements(
  ctx: BusinessCtx,
  input: ListInput,
): Promise<ChannelStatementListDto> {
  assertCostsShown(ctx)
  return ctx.tx(async (tx) => {
    const [channel] = (await tx.execute(sql`
      select c.id from app.sales_channels c
       where c.business_id = ${ctx.businessId} and c.id = ${input.channelId}
         and c.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!channel) throw new AppError('not_found')
    const rows = (await tx.execute(sql`
      select ${columns}
        from app.channel_statements s
        join app.sales_channels c on c.business_id = s.business_id and c.id = s.channel_id
       where s.business_id = ${ctx.businessId} and s.channel_id = ${input.channelId}
         and s.deleted_at is null
         ${input.status === 'all' ? sql`` : sql`and s.status = ${input.status}`}
       order by s.period_from desc, s.created_at desc, s.id desc
       limit 500
    `)) as unknown as StatementRecord[]
    return { data: { items: rows.map(dtoOf) }, meta: { redacted: [] } }
  })
}

/** `channelStatement.get`. */
export function getStatement(ctx: BusinessCtx, input: IdInput): Promise<ChannelStatementResultDto> {
  assertCostsShown(ctx)
  return ctx.tx(async (tx) => result(await readStatement(tx, ctx.businessId, input.id)))
}

/** The columns a draft saves. */
function fieldsOf(input: Omit<CreateInput, 'id' | 'channelId'>) {
  return {
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    sales: input.sales,
    commission: input.commission,
    paymentFees: input.paymentFees,
    otherFees: input.otherFees,
    ads: input.ads,
    refundsCharged: input.refundsCharged,
    payout: input.payout,
    notes: input.notes,
  }
}

/** A statement covers a year at most (the column's CHECK says it too). */
function assertPeriod(from: string, to: string): void {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  if (days >= 366)
    throw new AppError('validation', { message: 'a statement covers a year at most' })
}

/** `channelStatement.create`: a draft, idempotent on the client's id. */
export function createStatement(
  ctx: BusinessCtx,
  input: CreateInput,
): Promise<ChannelStatementResultDto> {
  assertCostsShown(ctx)
  assertPeriod(input.periodFrom, input.periodTo)
  const { id, channelId, ...fields } = input
  return ctx.tx(async (tx) => {
    await assertChannel(tx, ctx.businessId, channelId)
    const { row } = await createIdempotent(tx, channelStatements, {
      id,
      businessId: ctx.businessId,
      channelId,
      ...fieldsOf(fields),
      requestHash: requestHashOf({ channelId, ...fields }),
    })
    if (row.deletedAt !== null)
      throw new AppError('conflict', { message: 'statement was discarded' })
    return result(await readStatement(tx, ctx.businessId, id))
  })
}

interface HeadRecord extends Record<string, unknown> {
  id: string
  status: SaleImportStatus
  channel_id: string
  period_from: string
  period_to: string
  import_id: string | null
  version: number
}

/** The statement row FOR UPDATE; NOT_FOUND when not a live one of the business. */
async function lockStatement(tx: Tx, businessId: string, id: string): Promise<HeadRecord> {
  const [row] = (await tx.execute(sql`
    select s.id, s.status, s.channel_id, s.period_from::text as period_from,
           s.period_to::text as period_to, s.import_id, s.version
      from app.channel_statements s
     where s.business_id = ${businessId} and s.id = ${id} and s.deleted_at is null
       for update
  `)) as unknown as HeadRecord[]
  if (!row) throw new AppError('not_found')
  return row
}

function assertDraft(head: HeadRecord, version: number): void {
  if (head.status !== 'draft') throw new AppError('document_posted')
  if (head.version !== version) throw new AppError('conflict')
}

/** `channelStatement.update`: the whole draft, `version` as read. */
export function updateStatement(
  ctx: BusinessCtx,
  input: UpdateInput,
): Promise<ChannelStatementResultDto> {
  assertCostsShown(ctx)
  assertPeriod(input.periodFrom, input.periodTo)
  const { id, version, ...fields } = input
  return ctx.tx(async (tx) => {
    const head = await lockStatement(tx, ctx.businessId, id)
    assertDraft(head, version)
    await tx
      .update(channelStatements)
      .set(fieldsOf(fields))
      .where(and(eq(channelStatements.businessId, ctx.businessId), eq(channelStatements.id, id)))
    return result(await readStatement(tx, ctx.businessId, id))
  })
}

/** `channelStatement.discard`: a draft is taken out; a finalized one is reversed instead. */
export function discardStatement(ctx: BusinessCtx, input: VersionInput): Promise<OkDto> {
  assertCostsShown(ctx)
  return ctx.tx(async (tx) => {
    const head = await lockStatement(tx, ctx.businessId, input.id)
    assertDraft(head, input.version)
    await tx
      .update(channelStatements)
      .set({ deletedAt: sql`now()` })
      .where(
        and(eq(channelStatements.businessId, ctx.businessId), eq(channelStatements.id, input.id)),
      )
    return { ok: true as const }
  })
}

/** Its days must be open (every day it covers: its first is the earliest). */
function assertOpen(closedThrough: string | null, periodFrom: string): void {
  if (closedThrough !== null && periodFrom <= closedThrough) throw new AppError('books_closed')
}

/**
 * `channelStatement.post`: the draft (its `version` as read) becomes final: its fees replace the
 * channel's marked fee expenses and commission % for its days. STATEMENT_OVERLAP when a final
 * statement of the channel covers one of them; BOOKS_CLOSED in closed books. Idempotent.
 */
export function postStatement(
  ctx: BusinessCtx,
  input: VersionInput,
): Promise<ChannelStatementResultDto> {
  assertCostsShown(ctx)
  return ctx.tx(async (tx) => {
    const head = await lockStatement(tx, ctx.businessId, input.id)
    if (head.status !== 'draft') return result(await readStatement(tx, ctx.businessId, input.id))
    if (head.version !== input.version) throw new AppError('conflict')
    const business = await lockPostingBusiness(tx, ctx.businessId)
    // A statement is for days that are over (never after today), all of them open.
    if (head.period_to > business.today) throw new AppError('future_date')
    assertOpen(business.closedThrough, head.period_from)
    try {
      await tx.execute(sql`
        update app.channel_statements
           set status = 'posted', posted_at = now(), posted_by = app.current_user_id()
         where business_id = ${ctx.businessId} and id = ${input.id}
      `)
    } catch (error) {
      if (sqlStateOf(error) === '23P01') throw new AppError('statement_overlap', { cause: error })
      throw error
    }
    return result(await readStatement(tx, ctx.businessId, input.id))
  })
}

/**
 * `channelStatement.reverse`: a final statement is taken back (its days fall back to the marked fee
 * expenses or the commission %), only while its days are open (BOOKS_CLOSED). Idempotent.
 */
export function reverseStatement(
  ctx: BusinessCtx,
  input: IdInput,
): Promise<ChannelStatementResultDto> {
  assertCostsShown(ctx)
  return ctx.tx(async (tx) => {
    const head = await lockStatement(tx, ctx.businessId, input.id)
    if (head.status === 'reversed') return result(await readStatement(tx, ctx.businessId, input.id))
    if (head.status !== 'posted') throw new AppError('document_not_posted')
    const business = await lockPostingBusiness(tx, ctx.businessId)
    assertOpen(business.closedThrough, head.period_from)
    await tx.execute(sql`
      update app.channel_statements
         set status = 'reversed', reversed_at = now(), reversed_by = app.current_user_id()
       where business_id = ${ctx.businessId} and id = ${input.id}
    `)
    return result(await readStatement(tx, ctx.businessId, input.id))
  })
}
