import {
  DAY_SHEET_ORDER_DAYS,
  DAY_SHEET_PRODUCTS_MAX,
  type correctSaleInput,
  type createSaleInput,
  type DaySheetDto,
  type daySheetInput,
  type fillDeliveryCostInput,
  type SaleDto,
  type saleIdInput,
  type SaleLineDto,
  type saleListInput,
  type SaleListDto,
  type SaleResultDto,
  type saleVersionInput,
  type updateSaleInput,
  type OkDto,
} from '@bizcost/contracts'
import { createIdempotent, saleLines, sales, type NewSaleLine, type Tx } from '@bizcost/db'
import {
  can,
  canAccessLocation,
  computeSale,
  isCurrencyCode,
  newId,
  saleError,
  saleLineCost,
  sumDecimals,
  type CurrencyCode,
  type LineDiscount,
  type Money,
  type OwnerTimePart,
  type Percent,
  type ProductType,
  type Quantity,
  type SaleAmounts,
  type SaleLineInput as DomainSaleLine,
  type SaleSource,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertModuleActive, assertQueryable, passes } from '../trpc'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { resolveLocation } from './purchases'
import {
  insertMaterialRows,
  itemMaterialsOf,
  lineCostColumns,
  materialRows,
  postedPurchaseLinesOf,
  shareCostRows,
} from './sale-costs'
import { assertPostable, isoOf, lockPostingBusiness, reversalDateOf, uuidArray } from './stock'

// Sales (ROADMAP.md M3 Step 2; DATA_MODEL.md §6; D-219–D-222, D-225–D-232). Module `sales` (planned
// until Release A: served under the dev-only preview only, D-125). sales.documents.view sees every
// sale (and so the sales totals, H1); .manage saves and discards drafts; .post finalizes; .reverse
// reverses; .reverse with .manage corrects (the router checks them). Without .view a member sees,
// changes and finalizes only the sales they entered, and only while nobody else has changed them since
// (D-181, D-214); a member limited to some branches only those branches' (Q12, member_locations,
// D-054). A sale out of sight is NOT_FOUND, as if it did not exist.
//
// A draft changes nothing but itself: every save checks the whole sale (its day, location, channel,
// products) and stores the amounts computeSale gives (VAT once per rate, D-220). Posting (postSale)
// freezes the amounts with the VAT registration of the day, and the cost of what was sold (D-222),
// in the lock order of sale-costs.ts; nothing leaves stock (D-219) and nothing is refused for stock.
// A posted sale is never edited (database triggers), it is reversed (as if never posted in an open
// period; dated the first open day when its day is closed, D-227) or corrected (reversed, and a copy
// opened as a new draft, D-036).

type CreateInput = z.output<typeof createSaleInput>
type UpdateInput = z.output<typeof updateSaleInput>
type Fields = Omit<CreateInput, 'id' | 'source'>
type IdInput = z.output<typeof saleIdInput>
type VersionInput = z.output<typeof saleVersionInput>
type CorrectInput = z.output<typeof correctSaleInput>
type ListInput = z.output<typeof saleListInput>
type DaySheetInput = z.output<typeof daySheetInput>
type FillDeliveryInput = z.output<typeof fillDeliveryCostInput>
type InputLine = Fields['lines'][number]

const invalid = (message: string) => new AppError('validation', { message })

// ---------------------------------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------------------------------

/** The caller sees every sale (and so the sales totals, H1). */
function seesAll(ctx: BusinessCtx): boolean {
  return can(ctx.access.effective, 'sales.documents.view')
}

/** The sales the caller may see (alias `s`): every sale or their own, and only their branches. */
function visibleTo(ctx: BusinessCtx): SQL[] {
  const parts: SQL[] = []
  if (!seesAll(ctx)) parts.push(sql`s.created_by = app.current_user_id()`)
  const scope = ctx.access.locationScope
  if (!scope.all) parts.push(sql`s.location_id = any(${uuidArray([...scope.ids])})`)
  return parts
}

function where(parts: readonly SQL[]): SQL {
  return sql.join([...parts], sql` and `)
}

/** A location the caller may sell at (FORBIDDEN for a branch they are not limited to). */
function assertInScope(ctx: BusinessCtx, locationId: string): void {
  if (!canAccessLocation(ctx.access.locationScope, locationId)) {
    throw new AppError('forbidden', { message: 'not one of your branches' })
  }
}

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

interface SaleRecord extends Record<string, unknown> {
  id: string
  status: SaleDto['status']
  source: SaleSource
  business_date: string
  period_from: string | null
  location_id: string
  location_name: string
  channel_id: string
  channel_name: string
  channel_kind: SaleDto['channelKind']
  vat_registered: boolean
  currency: string
  subtotal: string
  discount_total: string
  net_total: string
  vat_total: string
  total: string
  delivery_needed: boolean
  delivery_area: string | null
  delivery_cost: string | null
  notes: string | null
  entered_by_name: string | null
  mine: boolean
  posted_at: Date | string | null
  reversed_at: Date | string | null
  reversal_business_date: string | null
  copied_from_id: string | null
  created_at: Date | string
  version: number
}

interface LineRecord extends Record<string, unknown> {
  id: string
  kind: SaleLineDto['kind']
  product_id: string | null
  description: string | null
  qty: string
  unit: StandardUnit | null
  unit_price: string
  price_includes_vat: boolean
  discount_percent: string | null
  discount_amount: string | null
  vat_category: VatCategory | null
  vat_rate: string | null
  subtotal: string
  discount: string
  net: string
  vat: string
  total: string
  cost_basis: SaleLineDto['costBasis'] | null
  cost: string | null
  time_minutes: string | null
  time_cost: string | null
  /** An item of a product (not a service, not bought ready to sell) that froze nothing to cost. */
  needs_recipe: boolean
}

interface MaterialRecord extends Record<string, unknown> {
  sale_line_id: string
  material_id: string
  material_name: string
  base_qty: string
  unit_cost: string | null
  cost: string | null
  basis: 'purchases_90_days' | 'last_purchase' | 'first_purchase' | null
}

function discountOf(percent: string | null, amount: string | null) {
  if (percent !== null) return { percent }
  if (amount !== null) return { amount }
  return null
}

/** Who entered a sale: their name in the business now (the member row of `s.created_by`). */
const enteredByName = sql`(
  select bm.display_name from app.business_members bm
   where bm.business_id = s.business_id and bm.user_id = s.created_by and bm.kind = 'account'
   order by (bm.status = 'active') desc, bm.created_at desc
   limit 1)`

/**
 * The sale as the API returns it: NOT_FOUND unless a live sale of this business the caller may see.
 * Its materials only for a member who may see what goes into each product (products.recipes.view,
 * D-150); who entered it only with a team (D-192).
 */
export async function readSale(tx: Tx, ctx: BusinessCtx, id: string): Promise<SaleDto> {
  const [head] = (await tx.execute(sql`
    select s.id, s.status, s.source, s.business_date::text as business_date,
           s.period_from::text as period_from, s.location_id, l.name as location_name,
           s.channel_id, c.name as channel_name, c.kind as channel_kind, s.vat_registered,
           trim(s.currency) as currency, trim_scale(s.subtotal)::text as subtotal,
           trim_scale(s.discount_total)::text as discount_total,
           trim_scale(s.net_total)::text as net_total, trim_scale(s.vat_total)::text as vat_total,
           trim_scale(s.total)::text as total, s.delivery_needed, s.delivery_area,
           trim_scale(s.delivery_cost)::text as delivery_cost, s.notes,
           ${enteredByName} as entered_by_name,
           s.created_by = app.current_user_id() as mine,
           s.posted_at, s.reversed_at, s.reversal_business_date::text as reversal_business_date,
           s.copied_from_id, s.created_at, s.version
      from app.sales s
      join app.locations l on l.business_id = s.business_id and l.id = s.location_id
      join app.sales_channels c on c.business_id = s.business_id and c.id = s.channel_id
     where ${where([
       sql`s.business_id = ${ctx.businessId}`,
       sql`s.id = ${id}`,
       sql`s.deleted_at is null`,
       ...visibleTo(ctx),
     ])}
  `)) as unknown as SaleRecord[]
  if (!head) throw new AppError('not_found')

  const lines = (await tx.execute(sql`
    select l.id, l.kind, l.product_id, l.description, trim_scale(l.qty)::text as qty, l.unit,
           trim_scale(l.unit_price)::text as unit_price, l.price_includes_vat,
           trim_scale(l.discount_percent)::text as discount_percent,
           trim_scale(l.discount_amount)::text as discount_amount, l.vat_category,
           trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.subtotal)::text as subtotal,
           trim_scale(l.discount)::text as discount, trim_scale(l.net)::text as net,
           trim_scale(l.vat)::text as vat, trim_scale(l.total)::text as total, l.cost_basis,
           trim_scale(l.cost)::text as cost, trim_scale(l.time_minutes)::text as time_minutes,
           trim_scale(l.time_cost)::text as time_cost,
           coalesce(l.kind = 'item' and l.cost_basis = 'none' and p.type = 'product'
                    and p.resale_material_id is null, false) as needs_recipe
      from app.sale_lines l
      left join app.products_services p
        on p.business_id = l.business_id and p.id = l.product_id
     where l.business_id = ${ctx.businessId} and l.sale_id = ${id} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as LineRecord[]

  const showsMaterials =
    head.status !== 'draft' && can(ctx.access.effective, 'products.recipes.view')
  const materials = showsMaterials
    ? ((await tx.execute(sql`
        select m.sale_line_id, m.material_id, mat.name as material_name,
               trim_scale(m.base_qty)::text as base_qty, trim_scale(m.unit_cost)::text as unit_cost,
               trim_scale(m.cost)::text as cost, m.basis
          from app.sale_line_materials m
          join app.materials mat on mat.business_id = m.business_id and mat.id = m.material_id
         where m.business_id = ${ctx.businessId} and m.sale_id = ${id} and m.deleted_at is null
         order by m.sale_line_id, m.id
      `)) as unknown as MaterialRecord[])
    : []
  const byLine = new Map<string, MaterialRecord[]>()
  for (const m of materials) byLine.set(m.sale_line_id, [...(byLine.get(m.sale_line_id) ?? []), m])
  // A product sold with nothing to cost while Materials is on: what it used is not known (D-223).
  const materialsOn = passes(ctx, ['materials'])

  return {
    id: head.id,
    status: head.status,
    source: head.source,
    businessDate: head.business_date,
    periodFrom: head.period_from,
    locationId: head.location_id,
    locationName: head.location_name,
    channelId: head.channel_id,
    channelName: head.channel_name,
    channelKind: head.channel_kind,
    vatRegistered: head.vat_registered,
    currency: head.currency,
    subtotal: head.subtotal,
    discountTotal: head.discount_total,
    netTotal: head.net_total,
    vatTotal: head.vat_total,
    total: head.total,
    deliveryNeeded: head.delivery_needed,
    deliveryArea: head.delivery_area,
    deliveryCost: head.delivery_cost,
    ownDeliveryCost: head.mine ? head.delivery_cost : null,
    notes: head.notes,
    lines: lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      productId: l.product_id,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitPrice: l.unit_price,
      priceIncludesVat: l.price_includes_vat,
      discount: discountOf(l.discount_percent, l.discount_amount),
      vatCategory: l.vat_category,
      vatRate: l.vat_rate,
      subtotal: l.subtotal,
      lineDiscount: l.discount,
      net: l.net,
      vat: l.vat,
      total: l.total,
      costBasis: l.cost_basis,
      cost: l.cost,
      timeMinutes: l.time_minutes,
      timeCost: l.time_cost,
      noRecipe: head.status !== 'draft' && materialsOn && l.needs_recipe,
      materials: showsMaterials
        ? (byLine.get(l.id) ?? []).map((m) => ({
            materialId: m.material_id,
            materialName: m.material_name,
            baseQty: m.base_qty,
            unitCost: m.unit_cost,
            cost: m.cost,
            basis: m.basis,
          }))
        : null,
    })),
    enteredByName: ctx.access.capabilities.has_team ? head.entered_by_name : null,
    mine: head.mine,
    postedAt: isoOf(head.posted_at),
    reversedAt: isoOf(head.reversed_at),
    reversalBusinessDate: head.reversal_business_date,
    copiedFromId: head.copied_from_id,
    createdAt: isoOf(head.created_at),
    version: head.version,
  }
}

/** An envelope for redaction (the redact middleware fills meta.redacted). */
function result(data: SaleDto): SaleResultDto {
  return { data, meta: { redacted: [] } }
}

/** `sale.get`. */
export function getSale(ctx: BusinessCtx, input: IdInput): Promise<SaleResultDto> {
  return ctx.tx(async (tx) => result(await readSale(tx, ctx, input.id)))
}

interface ListRecord extends Record<string, unknown> {
  id: string
  status: SaleDto['status']
  source: SaleSource
  business_date: string
  period_from: string | null
  location_id: string
  channel_id: string
  channel_name: string
  currency: string
  net_total: string
  vat_total: string
  total: string
  line_count: number
  item_names: string[]
  entered_by_name: string | null
  mine: boolean
  version: number
}

/** A channel or location a filter names: one of this business's (NOT_FOUND otherwise). */
async function assertListed(
  tx: Tx,
  table: 'sales_channels' | 'locations',
  businessId: string,
  id: string,
) {
  const [row] = (await tx.execute(
    table === 'sales_channels'
      ? sql`select c.id from app.sales_channels c
             where c.business_id = ${businessId} and c.id = ${id} and c.deleted_at is null`
      : sql`select l.id from app.locations l
             where l.business_id = ${businessId} and l.id = ${id} and l.deleted_at is null`,
  )) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
}

/**
 * `sale.list`: newest business day first, with filters and a cursor; only the sales the caller may
 * see. `dayTotals` only for a member who sees every sale (H1): the page's days, and (listing every
 * status) the days between them on which a sale of a closed day was reversed (D-227, D-236).
 */
export function listSales(ctx: BusinessCtx, input: ListInput): Promise<SaleListDto> {
  // Which sales, whatever their day (the day totals count a reversal on its own day).
  const filters = [
    sql`s.business_id = ${ctx.businessId}`,
    sql`s.deleted_at is null`,
    ...visibleTo(ctx),
  ]
  if (input.source) filters.push(sql`s.source = ${input.source}`)
  if (input.channelId) filters.push(sql`s.channel_id = ${input.channelId}`)
  if (input.locationId) filters.push(sql`s.location_id = ${input.locationId}`)
  if (input.search) {
    // The names on its lines, never an amount (D-209).
    const pattern = containsPattern(input.search)
    filters.push(sql`exists (
      select 1 from app.sale_lines sl
       where sl.business_id = s.business_id and sl.sale_id = s.id and sl.deleted_at is null
         and sl.description ilike ${pattern})`)
  }
  const page = [...filters]
  if (input.from) page.push(sql`s.business_date >= ${input.from}::date`)
  if (input.to) page.push(sql`s.business_date <= ${input.to}::date`)
  if (input.status !== 'all') page.push(sql`s.status = ${input.status}`)
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.key)) throw invalid('invalid cursor')
    page.push(sql`(s.business_date, s.id) < (${cursor.key}::date, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    if (input.channelId) await assertListed(tx, 'sales_channels', ctx.businessId, input.channelId)
    if (input.locationId) await assertListed(tx, 'locations', ctx.businessId, input.locationId)
    const rows = (await tx.execute(sql`
      select s.id, s.status, s.source, s.business_date::text as business_date,
             s.period_from::text as period_from, s.location_id, s.channel_id,
             c.name as channel_name, trim(s.currency) as currency,
             trim_scale(s.net_total)::text as net_total, trim_scale(s.vat_total)::text as vat_total,
             trim_scale(s.total)::text as total, s.version,
             s.created_by = app.current_user_id() as mine,
             ${enteredByName} as entered_by_name,
             (select count(*)::int from app.sale_lines l
               where l.business_id = s.business_id and l.sale_id = s.id
                 and l.kind = 'item' and l.deleted_at is null) as line_count,
             array(select coalesce(l.description, '') from app.sale_lines l
                    where l.business_id = s.business_id and l.sale_id = s.id
                      and l.kind = 'item' and l.deleted_at is null
                    order by l.position, l.id
                    limit 2) as item_names
        from app.sales s
        join app.sales_channels c on c.business_id = s.business_id and c.id = s.channel_id
       where ${where(page)}
       order by s.business_date desc, s.id desc
       limit ${input.limit + 1}
    `)) as unknown as ListRecord[]
    const items = rows.slice(0, input.limit)
    const last = items.at(-1)
    const more = rows.length > input.limit
    let dayTotals: SaleListDto['dayTotals'] = null
    if (seesAll(ctx)) {
      const days = new Set(items.map((r) => r.business_date))
      if (input.status === 'all') {
        // The days between this page's and the next's (or the range's ends) on which a sale of a
        // closed day was reversed with no sale of their own listed: each on the one page that spans it.
        const span = [
          ...(input.cursor
            ? [sql`s.reversal_business_date < ${decodeCursor(input.cursor).key}::date`]
            : []),
          ...(more && last ? [sql`s.reversal_business_date > ${last.business_date}::date`] : []),
          ...(input.from ? [sql`s.reversal_business_date >= ${input.from}::date`] : []),
          ...(input.to ? [sql`s.reversal_business_date <= ${input.to}::date`] : []),
        ]
        const reversalDays = (await tx.execute(sql`
          select distinct s.reversal_business_date::text as day
            from app.sales s
           where ${where([
             ...filters,
             sql`s.status = 'reversed'`,
             sql`s.reversal_business_date <> s.business_date`,
             ...span,
           ])}
        `)) as unknown as { day: string }[]
        for (const r of reversalDays) days.add(r.day)
      }
      const sorted = [...days].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      dayTotals = sorted.length === 0 ? [] : await dayTotalsOf(tx, filters, sorted)
    }
    const team = ctx.access.capabilities.has_team
    return {
      items: items.map((r) => ({
        id: r.id,
        status: r.status,
        source: r.source,
        businessDate: r.business_date,
        periodFrom: r.period_from,
        locationId: r.location_id,
        channelId: r.channel_id,
        channelName: r.channel_name,
        currency: r.currency,
        netTotal: r.net_total,
        vatTotal: r.vat_total,
        total: r.total,
        lineCount: r.line_count,
        itemNames: r.item_names,
        enteredByName: team ? r.entered_by_name : null,
        mine: r.mine,
        version: r.version,
      })),
      nextCursor: more && last ? encodeCursor({ key: last.business_date, id: last.id }) : null,
      dayTotals,
    }
  })
}

/**
 * What the finalized sales that match `filters` (which say nothing of their day) came to on each of
 * `days` (D-227): a sale posted that day counts; one reversed in an open period never counted; one
 * whose day was closed when it was reversed still counts on its day and is taken back on the day of
 * its reversal, whatever range its own day is in (D-236).
 */
async function dayTotalsOf(
  tx: Tx,
  filters: readonly SQL[],
  days: readonly string[],
): Promise<NonNullable<SaleListDto['dayTotals']>> {
  const list = sql`array[${sql.join(
    days.map((d) => sql`${d}::date`),
    sql`, `,
  )}]`
  const rows = (await tx.execute(sql`
    with counted as (
      select s.business_date as day, s.net_total as net, s.total, 1 as n
        from app.sales s
       where ${where(filters)}
         and s.business_date = any(${list})
         and (s.status = 'posted'
           or (s.status = 'reversed' and s.reversal_business_date <> s.business_date))
      union all
      select s.reversal_business_date, -s.net_total, -s.total, 0
        from app.sales s
       where ${where(filters)}
         and s.status = 'reversed'
         and s.reversal_business_date <> s.business_date
         and s.reversal_business_date = any(${list})
    )
    select day::text as business_date, trim_scale(sum(net))::text as net_total,
           trim_scale(sum(total))::text as total, sum(n)::int as count
      from counted
     group by day
  `)) as unknown as { business_date: string; net_total: string; total: string; count: number }[]
  const byDay = new Map(rows.map((r) => [r.business_date, r] as const))
  return days.map((day) => ({
    businessDate: day,
    netTotal: byDay.get(day)?.net_total ?? '0',
    total: byDay.get(day)?.total ?? '0',
    count: byDay.get(day)?.count ?? 0,
  }))
}

// ---------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------

/** What a sale's save needs of the business (not locked: posting reads it again under its lock). */
interface SaleContext {
  readonly currency: CurrencyCode
  readonly vatRegistered: boolean
  readonly today: string
  readonly closedThrough: string | null
  readonly defaultLocationId: string | null
}

async function saleContextOf(tx: Tx, businessId: string): Promise<SaleContext> {
  const [row] = (await tx.execute(sql`
    select trim(b.currency) as currency, b.vat_registered,
           (now() at time zone b.timezone)::date::text as today,
           b.books_closed_through::text as closed_through,
           (select l.id from app.locations l
             where l.business_id = b.id and l.is_default and l.deleted_at is null) as default_location_id
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as {
    currency: string
    vat_registered: boolean
    today: string
    closed_through: string | null
    default_location_id: string | null
  }[]
  if (!row) throw new AppError('forbidden')
  if (!isCurrencyCode(row.currency)) throw invalid(`currency: ${row.currency} is not supported`)
  return {
    currency: row.currency,
    vatRegistered: row.vat_registered,
    today: row.today,
    closedThrough: row.closed_through,
    defaultLocationId: row.default_location_id,
  }
}

/**
 * The days of a sale: never after today (FUTURE_DATE), and a sheet for several days starts before
 * its last day, in the same month (VALIDATION; one month: the running-cost rate is monthly, Q9).
 */
function assertDays(businessDate: string, periodFrom: string | null, today: string): void {
  if (businessDate > today) throw new AppError('future_date')
  if (periodFrom === null) return
  if (periodFrom >= businessDate || periodFrom.slice(0, 7) !== businessDate.slice(0, 7)) {
    throw invalid('periodFrom: before the last day, within its month')
  }
}

/**
 * The channel of a sale: one of the business's (NOT_FOUND otherwise). An archived one only when the
 * sale already has it (`current`) or for reading (`archivedToo`); null: its only active channel
 * (VALIDATION when it has several: the screen asks).
 */
async function resolveChannel(
  tx: Tx,
  businessId: string,
  channelId: string | null,
  current: string | null,
  archivedToo = false,
): Promise<{ id: string; name: string }> {
  if (channelId === null) {
    const active = (await tx.execute(sql`
      select c.id, c.name from app.sales_channels c
       where c.business_id = ${businessId} and c.deleted_at is null and c.archived_at is null
       order by c.id
       limit 2
    `)) as unknown as { id: string; name: string }[]
    if (active.length !== 1) throw invalid('channelId: choose the channel')
    return active[0]!
  }
  const [row] = (await tx.execute(sql`
    select c.id, c.name, c.archived_at is not null as archived from app.sales_channels c
     where c.business_id = ${businessId} and c.id = ${channelId} and c.deleted_at is null
  `)) as unknown as { id: string; name: string; archived: boolean }[]
  if (!row) throw new AppError('not_found')
  if (row.archived && row.id !== current && !archivedToo) throw invalid('channelId: archived')
  return { id: row.id, name: row.name }
}

/** A product or service as a sale line copies it. */
interface ProductRecord extends Record<string, unknown> {
  id: string
  name: string
  type: ProductType
  unit: StandardUnit
  price_includes_vat: boolean
  vat_category: VatCategory
  archived: boolean
  resale_material_id: string | null
  owner_minutes: string | null
}

async function productsOf(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, ProductRecord>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select p.id, p.name, p.type, p.unit, p.price_includes_vat, p.vat_category,
           p.archived_at is not null as archived, p.resale_material_id,
           trim_scale(p.owner_minutes)::text as owner_minutes
      from app.products_services p
     where p.business_id = ${businessId} and p.id = any(${uuidArray(unique)})
       and p.deleted_at is null
  `)) as unknown as ProductRecord[]
  return new Map(rows.map((row) => [row.id, row] as const))
}

function toLineDiscount(
  discount: { percent: string } | { amount: string } | null | undefined,
): LineDiscount | null {
  if (!discount) return null
  return 'percent' in discount
    ? { percent: discount.percent as Percent }
    : { amount: discount.amount as Money }
}

/** A stored or typed line, with what computeSale needs of its product. */
interface PricedLine {
  readonly line: InputLine
  readonly product: ProductRecord | null
}

/** The domain's view of the lines (computeSale). */
function domainLines(lines: readonly PricedLine[]): DomainSaleLine[] {
  return lines.map(({ line, product }) =>
    line.kind === 'item'
      ? {
          kind: 'item',
          qty: line.qty as Quantity,
          unitPrice: line.unitPrice as Money,
          priceIncludesVat: product?.price_includes_vat ?? false,
          discount: toLineDiscount(line.discount),
          vatCategory: product?.vat_category ?? 'standard',
        }
      : {
          kind: 'delivery',
          qty: '1' as Quantity,
          unitPrice: line.amount as Money,
          priceIncludesVat: line.amountIncludesVat,
        },
  )
}

/** A sale's amounts (computeSale); VALIDATION with the domain's code when they cannot be computed. */
function amountsOf(
  lines: readonly PricedLine[],
  vatRegistered: boolean,
  currency: CurrencyCode,
): SaleAmounts | null {
  if (lines.length === 0) return null
  const input = { lines: domainLines(lines), vatRegistered }
  const error = saleError(input, currency)
  if (error) {
    const at = error.line === undefined ? '' : ` (line ${error.line + 1})`
    throw invalid(`amounts: ${error.code}${at}`)
  }
  try {
    return computeSale(input, currency)
  } catch (cause) {
    throw new AppError('validation', { message: 'amounts: cannot be computed', cause })
  }
}

/** The header's totals from the lines' amounts (zero without a line). */
function totalsOf(amounts: SaleAmounts | null) {
  if (amounts === null) {
    return { subtotal: '0', discountTotal: '0', netTotal: '0', vatTotal: '0', total: '0' }
  }
  return {
    subtotal: sumDecimals(amounts.lines.map((l) => l.subtotal)),
    discountTotal: sumDecimals([...amounts.lines.map((l) => l.discount), amounts.documentDiscount]),
    netTotal: amounts.net,
    vatTotal: amounts.vat,
    total: amounts.total,
  }
}

/** The sale_lines columns of each line, with its amounts. */
function lineValues(
  businessId: string,
  priced: readonly PricedLine[],
  amounts: SaleAmounts | null,
  vatRegistered: boolean,
): Omit<NewSaleLine, 'saleId'>[] {
  return priced.map(({ line, product }, position) => {
    const a = amounts?.lines[position]
    const common = {
      id: line.id,
      businessId,
      position,
      vatCategory: a?.vatCategory ?? null,
      vatRate: a?.vatRate ?? null,
      subtotal: a?.subtotal ?? '0',
      discount: a?.discount ?? '0',
      net: a?.net ?? '0',
      vat: a?.vat ?? '0',
      total: a?.total ?? '0',
    }
    if (line.kind === 'delivery') {
      return {
        ...common,
        kind: 'delivery' as const,
        productId: null,
        description: line.description,
        qty: '1',
        unit: null,
        unitPrice: line.amount,
        priceIncludesVat: vatRegistered && line.amountIncludesVat,
        discountPercent: null,
        discountAmount: null,
      }
    }
    return {
      ...common,
      kind: 'item' as const,
      productId: line.productId,
      description: line.description ?? product?.name ?? null,
      qty: line.qty,
      unit: product?.unit ?? null,
      unitPrice: line.unitPrice,
      priceIncludesVat: vatRegistered && (product?.price_includes_vat ?? false),
      discountPercent: line.discount && 'percent' in line.discount ? line.discount.percent : null,
      discountAmount: line.discount && 'amount' in line.discount ? line.discount.amount : null,
    }
  })
}

/** What a draft's save keeps of the sale it changes. */
interface StoredDraft {
  readonly channelId: string
  readonly productIds: ReadonlySet<string>
  readonly deliveryCost: string | null
}

/**
 * Checks a draft's days, location, channel and products, and computes its amounts. Returns the
 * columns of the sale and of each line. "Price includes VAT" on a delivery needs VAT registration
 * (CAPABILITY_DISABLED, D-192, D-206); an item names a product or service of the business (NOT_FOUND;
 * an archived one only when the draft already has it, VALIDATION).
 */
async function prepareDraft(
  tx: Tx,
  ctx: BusinessCtx,
  input: Fields,
  source: SaleSource,
  stored: StoredDraft | null,
) {
  const biz = await saleContextOf(tx, ctx.businessId)
  if (input.periodFrom !== null && source !== 'day_sheet') {
    throw invalid('periodFrom: only Today’s sales cover several days')
  }
  if (
    source === 'day_sheet' &&
    (input.deliveryNeeded || input.lines.some((l) => l.kind !== 'item'))
  ) {
    throw invalid('lines: Today’s sales list items only')
  }
  assertDays(input.businessDate, input.periodFrom, biz.today)
  if (!biz.vatRegistered && input.lines.some((l) => l.kind === 'delivery' && l.amountIncludesVat)) {
    throw new AppError('capability_disabled', { message: 'VAT needs a VAT-registered business' })
  }
  const locationId = await resolveLocation(tx, ctx, input.locationId, biz.defaultLocationId)
  assertInScope(ctx, locationId)
  const channel = await resolveChannel(
    tx,
    ctx.businessId,
    input.channelId,
    stored?.channelId ?? null,
  )
  const items = input.lines.flatMap((l) => (l.kind === 'item' ? [l] : []))
  if (items.length > 0) assertModuleActive(ctx, 'products')
  const products = await productsOf(
    tx,
    ctx.businessId,
    items.map((l) => l.productId),
  )
  for (const line of items) {
    const product = products.get(line.productId)
    if (!product) throw new AppError('not_found')
    if (product.archived && !stored?.productIds.has(product.id)) {
      throw invalid('lines: a product was archived')
    }
  }
  const priced: PricedLine[] = input.lines.map((line) => ({
    line,
    product: line.kind === 'item' ? (products.get(line.productId) ?? null) : null,
  }))
  const amounts = amountsOf(priced, biz.vatRegistered, biz.currency)
  const deliveryCost = !input.deliveryNeeded
    ? null
    : input.deliveryCost === undefined
      ? (stored?.deliveryCost ?? null)
      : input.deliveryCost
  const header = {
    businessDate: input.businessDate,
    periodFrom: input.periodFrom,
    locationId,
    channelId: channel.id,
    vatRegistered: biz.vatRegistered,
    currency: biz.currency,
    ...totalsOf(amounts),
    deliveryNeeded: input.deliveryNeeded,
    deliveryArea: input.deliveryNeeded ? input.deliveryArea : null,
    deliveryCost,
    notes: input.notes,
  }
  return { header, lines: lineValues(ctx.businessId, priced, amounts, biz.vatRegistered) }
}

/**
 * `sale.create`: a draft, idempotent on the client's id (the same payload again returns it; an id used
 * by another create or another business is CONFLICT). A second live day sheet of the caller for the
 * same days, channel and location is CONFLICT (`sale.daySheet` opens the one they have).
 */
export function createSale(ctx: BusinessCtx, input: CreateInput): Promise<SaleResultDto> {
  const { id, source, ...fields } = input
  return ctx.tx(async (tx) => {
    const { header, lines } = await prepareDraft(tx, ctx, fields, source, null)
    const { row, created } = await createIdempotent(tx, sales, {
      id,
      businessId: ctx.businessId,
      source,
      ...header,
      requestHash: requestHashOf({ source, ...fields }),
    })
    if (row.deletedAt !== null) throw new AppError('conflict', { message: 'sale was discarded' })
    if (created && lines.length > 0) {
      await tx.insert(saleLines).values(lines.map((line) => ({ ...line, saleId: id })))
    }
    return result(await readSale(tx, ctx, id))
  })
}

interface HeadRecord extends Record<string, unknown> {
  id: string
  status: SaleDto['status']
  version: number
  source: SaleSource
  business_date: string
  location_id: string
  channel_id: string
  delivery_needed: boolean
  delivery_cost: string | null
  /** The caller entered it. */
  entered: boolean
  /**
   * The caller's own: they entered it and wrote it last (`updated_by`, kept by app.touch_row;
   * `created_by` until it is first changed): nobody else changed it since (D-214).
   */
  mine: boolean
}

/** The sale row, locked FOR UPDATE (lock 1); NOT_FOUND when not live or not the caller's to see. */
async function lockSale(tx: Tx, ctx: BusinessCtx, id: string): Promise<HeadRecord> {
  const [row] = (await tx.execute(sql`
    select s.id, s.status, s.version, s.source, s.business_date::text as business_date,
           s.location_id, s.channel_id, s.delivery_needed,
           trim_scale(s.delivery_cost)::text as delivery_cost,
           s.created_by = app.current_user_id() as entered,
           coalesce(s.created_by = app.current_user_id()
             and coalesce(s.updated_by, s.created_by) = app.current_user_id(), false) as mine
      from app.sales s
     where ${where([
       sql`s.business_id = ${ctx.businessId}`,
       sql`s.id = ${id}`,
       sql`s.deleted_at is null`,
       ...visibleTo(ctx),
     ])}
       for update
  `)) as unknown as HeadRecord[]
  if (!row) throw new AppError('not_found')
  return row
}

/**
 * A member who does not see every sale changes and finalizes only their own: those they entered,
 * while nobody else has saved them since (D-181, D-214). FORBIDDEN otherwise, under the row lock.
 */
function assertMayChange(ctx: BusinessCtx, head: HeadRecord): void {
  if (!seesAll(ctx) && !head.mine) throw new AppError('forbidden')
}

/**
 * A delivery cost is a `cost`: a member without the costs switch sets or clears one only on their own
 * sale nobody else changed since (they typed it; D-181, D-214). Left out, it is kept.
 */
function assertDeliveryCostShown(ctx: BusinessCtx, head: HeadRecord, deliveryCost: unknown): void {
  if (deliveryCost === undefined || head.mine) return
  assertQueryable(ctx, [{ name: 'deliveryCost', category: 'cost' }])
}

/** A draft that may still change: DOCUMENT_POSTED once posted, CONFLICT for another version. */
function assertDraft(head: HeadRecord, version: number): void {
  if (head.status !== 'draft') throw new AppError('document_posted')
  if (head.version !== version) throw new AppError('conflict')
}

async function liveLineIds(tx: Tx, businessId: string, saleId: string) {
  return (
    await tx
      .select({ id: saleLines.id, productId: saleLines.productId })
      .from(saleLines)
      .where(
        and(
          eq(saleLines.businessId, businessId),
          eq(saleLines.saleId, saleId),
          isNull(saleLines.deletedAt),
        ),
      )
  ).map((row) => row)
}

/**
 * `sale.update`: the whole draft, `version` as read. Lines are matched by id: new ids are added,
 * changed ones updated, missing ones taken out (soft-deleted). An id used anywhere else is CONFLICT.
 */
export function updateSale(ctx: BusinessCtx, input: UpdateInput): Promise<SaleResultDto> {
  const { id, version, ...fields } = input
  return ctx.tx(async (tx) => {
    const head = await lockSale(tx, ctx, id)
    assertMayChange(ctx, head)
    assertDraft(head, version)
    assertDeliveryCostShown(ctx, head, fields.deliveryCost)
    const live = await liveLineIds(tx, ctx.businessId, id)
    const { header, lines } = await prepareDraft(tx, ctx, fields, head.source, {
      channelId: head.channel_id,
      productIds: new Set(live.flatMap((l) => (l.productId ? [l.productId] : []))),
      deliveryCost: head.delivery_cost,
    })
    await tx
      .update(sales)
      .set(header)
      .where(and(eq(sales.businessId, ctx.businessId), eq(sales.id, id)))
    const liveIds = new Set(live.map((l) => l.id))
    const kept = new Set(lines.map((line) => line.id))
    const removed = [...liveIds].filter((lineId) => !kept.has(lineId))
    if (removed.length > 0) {
      await tx
        .update(saleLines)
        .set({ deletedAt: sql`now()` })
        .where(
          and(
            eq(saleLines.businessId, ctx.businessId),
            eq(saleLines.saleId, id),
            inArray(saleLines.id, removed),
          ),
        )
    }
    const added = lines.filter((line) => !liveIds.has(line.id))
    if (added.length > 0) {
      await tx.insert(saleLines).values(added.map((line) => ({ ...line, saleId: id })))
    }
    for (const line of lines.filter((l) => liveIds.has(l.id))) {
      const values: Partial<NewSaleLine> = { ...line }
      delete values.id
      delete values.businessId
      await tx
        .update(saleLines)
        .set(values)
        .where(
          and(
            eq(saleLines.businessId, ctx.businessId),
            eq(saleLines.saleId, id),
            eq(saleLines.id, line.id),
          ),
        )
    }
    return result(await readSale(tx, ctx, id))
  })
}

/** `sale.discard`: a draft is taken out (soft-deleted, with its lines); never a finalized one. */
export function discardSale(ctx: BusinessCtx, input: VersionInput): Promise<OkDto> {
  return ctx.tx(async (tx) => {
    const head = await lockSale(tx, ctx, input.id)
    assertMayChange(ctx, head)
    assertDraft(head, input.version)
    await tx
      .update(saleLines)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(saleLines.businessId, ctx.businessId),
          eq(saleLines.saleId, input.id),
          isNull(saleLines.deletedAt),
        ),
      )
    await tx
      .update(sales)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(sales.businessId, ctx.businessId), eq(sales.id, input.id)))
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------------

interface DraftLineRecord extends Record<string, unknown> {
  id: string
  kind: 'item' | 'delivery' | 'charge'
  product_id: string | null
  description: string | null
  qty: string
  unit_price: string
  price_includes_vat: boolean
  discount_percent: string | null
  discount_amount: string | null
}

async function draftLines(tx: Tx, businessId: string, saleId: string) {
  return (await tx.execute(sql`
    select l.id, l.kind, l.product_id, l.description, trim_scale(l.qty)::text as qty,
           trim_scale(l.unit_price)::text as unit_price, l.price_includes_vat,
           trim_scale(l.discount_percent)::text as discount_percent,
           trim_scale(l.discount_amount)::text as discount_amount
      from app.sale_lines l
     where l.business_id = ${businessId} and l.sale_id = ${saleId} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as DraftLineRecord[]
}

function asInputLine(line: DraftLineRecord): InputLine {
  if (line.kind === 'item') {
    return {
      kind: 'item',
      id: line.id,
      productId: line.product_id ?? '',
      description: line.description,
      qty: line.qty,
      unitPrice: line.unit_price,
      discount: discountOf(line.discount_percent, line.discount_amount),
    }
  }
  return {
    kind: 'delivery',
    id: line.id,
    description: line.description,
    amount: line.unit_price,
    amountIncludesVat: line.price_includes_vat,
  }
}

/** businesses.owner_hourly_rate, read under the business row's lock of the posting. */
async function hourlyRateOf(tx: Tx, businessId: string): Promise<string | null> {
  const [row] = (await tx.execute(sql`
    select trim_scale(b.owner_hourly_rate)::text as rate from app.businesses b where b.id = ${businessId}
  `)) as unknown as { rate: string | null }[]
  return row?.rate ?? null
}

/**
 * `sale.post`: the draft (its `version` as read) becomes finalized, with its amounts worked out again
 * under the VAT registration of the day (frozen) and the cost of what was sold frozen on its day
 * (D-222): each item line's materials at the 90-day average as of the sale's day, from the purchases
 * posted now ("no price yet" where none prices it, filled once later), and the owner's time without a
 * team. Nothing leaves stock and nothing is refused for stock (D-219). Idempotent: a sale already
 * finalized (or reversed since) is returned as it is. Refused: a day after today (FUTURE_DATE) or on
 * or before the books-closed date (BOOKS_CLOSED), no item (VALIDATION), a location removed since
 * (VALIDATION).
 */
export function postSale(ctx: BusinessCtx, input: VersionInput): Promise<SaleResultDto> {
  return ctx.tx(async (tx) => {
    // Lock 1: the sale.
    const head = await lockSale(tx, ctx, input.id)
    if (head.status !== 'draft') return result(await readSale(tx, ctx, input.id))
    if (head.version !== input.version) throw new AppError('conflict')
    assertMayChange(ctx, head)
    // Lock 2: the business row FOR SHARE (the books-closed date, VAT registration, currency).
    const business = await lockPostingBusiness(tx, ctx.businessId)
    assertPostable(business, head.business_date)
    const [location] = (await tx.execute(sql`
      select l.id from app.locations l
       where l.business_id = ${ctx.businessId} and l.id = ${head.location_id}
         and l.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!location) throw invalid('location: removed since the draft was saved')
    const stored = (await draftLines(tx, ctx.businessId, input.id)).map(asInputLine)
    const items = stored.flatMap((l) => (l.kind === 'item' ? [l] : []))
    if (items.length === 0) throw invalid('lines: a sale needs something sold to finalize')
    assertModuleActive(ctx, 'products')
    const products = await productsOf(
      tx,
      ctx.businessId,
      items.map((l) => l.productId),
    )
    if (items.some((l) => !products.has(l.productId))) throw invalid('lines: a product was removed')
    const priced: PricedLine[] = stored.map((line) => ({
      line,
      product: line.kind === 'item' ? (products.get(line.productId) ?? null) : null,
    }))
    const amounts = amountsOf(priced, business.vatRegistered, business.currency)

    // What each item uses, then lock 3: its materials' cost rows FOR SHARE (created when missing),
    // then one read of the purchases posted now (sale-costs.ts).
    const uses = await itemMaterialsOf(
      tx,
      ctx.businessId,
      [...products.values()].map((p) => ({
        id: p.id,
        unit: p.unit,
        resaleMaterialId: p.resale_material_id,
      })),
      passes(ctx, ['materials']),
    )
    const materialIds = [...uses.values()].flatMap((use) =>
      use.basis === 'recipe'
        ? use.lines.map((l) => l.materialId)
        : use.basis === 'resale'
          ? [use.materialId]
          : [],
    )
    await shareCostRows(tx, ctx.businessId, materialIds)
    const purchases = await postedPurchaseLinesOf(tx, ctx.businessId, materialIds)
    const hourlyRate = ctx.access.capabilities.has_team
      ? null
      : await hourlyRateOf(tx, ctx.businessId)

    const lines = lineValues(ctx.businessId, priced, amounts, business.vatRegistered)
    const rows: ReturnType<typeof materialRows> = []
    const updates = lines.map((line, position) => {
      const source = stored[position]!
      if (source.kind !== 'item') {
        return {
          ...line,
          costBasis: 'none' as const,
          cost: null,
          timeMinutes: null,
          timeCost: null,
        }
      }
      const product = products.get(source.productId)!
      const ownerTime: OwnerTimePart = ctx.access.capabilities.has_team
        ? { state: 'team' }
        : { state: 'solo', minutes: product.owner_minutes, hourlyRate }
      const snapshot = saleLineCost({
        qty: source.qty,
        day: head.business_date,
        materials: uses.get(product.id) ?? { basis: 'none' },
        purchases,
        ownerTime,
      })
      rows.push(...materialRows(ctx.businessId, input.id, source.id, snapshot))
      return { ...line, ...lineCostColumns(snapshot) }
    })
    await tx.execute(sql`
      update app.sale_lines l
         set description = v.description, unit = v.unit, price_includes_vat = v.price_includes_vat,
             vat_category = v.vat_category, vat_rate = v.vat_rate, subtotal = v.subtotal,
             discount = v.discount, net = v.net, vat = v.vat, total = v.total,
             cost_basis = v.cost_basis, cost = v.cost, time_minutes = v.time_minutes,
             time_cost = v.time_cost
        from (values ${sql.join(
          updates.map(
            (u) => sql`(${u.id}::uuid, ${u.description ?? null}::text, ${u.unit ?? null}::text,
              ${u.priceIncludesVat ?? false}::boolean, ${u.vatCategory ?? null}::text,
              ${u.vatRate ?? null}::numeric, ${u.subtotal}::numeric, ${u.discount}::numeric,
              ${u.net}::numeric, ${u.vat}::numeric, ${u.total}::numeric, ${u.costBasis}::text,
              ${u.cost}::numeric, ${u.timeMinutes}::numeric, ${u.timeCost}::numeric)`,
          ),
          sql`, `,
        )}) as v(id, description, unit, price_includes_vat, vat_category, vat_rate, subtotal,
                 discount, net, vat, total, cost_basis, cost, time_minutes, time_cost)
       where l.business_id = ${ctx.businessId} and l.id = v.id
    `)
    await insertMaterialRows(tx, rows)
    await tx
      .update(sales)
      .set({
        status: 'posted',
        postedAt: sql`now()`,
        postedBy: sql`app.current_user_id()`,
        vatRegistered: business.vatRegistered,
        currency: business.currency,
        ...totalsOf(amounts),
      })
      .where(and(eq(sales.businessId, ctx.businessId), eq(sales.id, input.id)))
    return result(await readSale(tx, ctx, input.id))
  })
}

// ---------------------------------------------------------------------------------------------------
// Reversal, correction and the delivery cost
// ---------------------------------------------------------------------------------------------------

/**
 * Reverses a finalized sale in `tx` (already reversed: nothing to do). Only its header changes (the
 * fills never wait on it, sale-costs.ts): in an open period it is as if it was never finalized; when
 * its day is closed the reversal is dated the first open day, and its negative counts in that day's
 * month (D-227; BOOKS_CLOSED when that day is after today).
 */
async function reverseInTx(tx: Tx, ctx: BusinessCtx, id: string): Promise<void> {
  const head = await lockSale(tx, ctx, id)
  if (head.status === 'reversed') return
  if (head.status !== 'posted') throw new AppError('document_not_posted')
  const business = await lockPostingBusiness(tx, ctx.businessId)
  const reversalBusinessDate = reversalDateOf(business, head.business_date)
  await tx
    .update(sales)
    .set({
      status: 'reversed',
      reversedAt: sql`now()`,
      reversedBy: sql`app.current_user_id()`,
      reversalBusinessDate,
    })
    .where(and(eq(sales.businessId, ctx.businessId), eq(sales.id, id)))
}

/** `sale.reverse`: see reverseInTx. Idempotent. */
export function reverseSale(ctx: BusinessCtx, input: IdInput): Promise<SaleResultDto> {
  return ctx.tx(async (tx) => {
    await reverseInTx(tx, ctx, input.id)
    return result(await readSale(tx, ctx, input.id))
  })
}

/**
 * `sale.correct` ("correct" = reverse + a new draft copy, D-036): reverses the sale (when still
 * finalized) and opens a copy of it as a new draft with the client's `newId`, in one transaction, the
 * caller's own. Idempotent on `newId`: the same call again returns the copy; an id used otherwise is
 * CONFLICT. A draft cannot be corrected (DOCUMENT_NOT_POSTED): it is edited. The copy carries the
 * delivery cost only for a member who sees costs (D-231): it is the corrector's own draft, whose
 * delivery cost they would read as theirs.
 */
export function correctSale(ctx: BusinessCtx, input: CorrectInput): Promise<SaleResultDto> {
  return ctx.tx(async (tx) => {
    // The sale first (lock 1 of its reversal): two corrections of one sale wait for each other here,
    // before either inserts a copy that names it.
    const head = await lockSale(tx, ctx, input.id)
    const requestHash = requestHashOf({ correct: input.id })
    const [existing] = (await tx.execute(sql`
      select s.id, s.request_hash, s.created_by = app.current_user_id() as mine, s.deleted_at
        from app.sales s
       where s.business_id = ${ctx.businessId} and s.id = ${input.newId}
    `)) as unknown as {
      id: string
      request_hash: string | null
      mine: boolean
      deleted_at: Date | string | null
    }[]
    if (existing) {
      if (existing.request_hash !== requestHash || !existing.mine || existing.deleted_at) {
        throw new AppError('conflict')
      }
      return result(await readSale(tx, ctx, input.newId))
    }
    if (head.status === 'draft') throw new AppError('document_not_posted')
    const [source] = await tx
      .select()
      .from(sales)
      .where(and(eq(sales.businessId, ctx.businessId), eq(sales.id, input.id)))
    if (!source) throw new AppError('not_found')
    const biz = await saleContextOf(tx, ctx.businessId)
    const [location] = (await tx.execute(sql`
      select l.id from app.locations l
       where l.business_id = ${ctx.businessId} and l.id = ${source.locationId}
         and l.deleted_at is null
    `)) as unknown as { id: string }[]
    // Reversed first: a day sheet's copy takes the key the reversal frees.
    await reverseInTx(tx, ctx, input.id)
    await tx.insert(sales).values({
      id: input.newId,
      businessId: ctx.businessId,
      source: source.source,
      businessDate: source.businessDate,
      periodFrom: source.periodFrom,
      locationId: location?.id ?? biz.defaultLocationId ?? source.locationId,
      channelId: source.channelId,
      vatRegistered: source.vatRegistered,
      currency: biz.currency,
      subtotal: source.subtotal,
      discountTotal: source.discountTotal,
      netTotal: source.netTotal,
      vatTotal: source.vatTotal,
      total: source.total,
      deliveryNeeded: source.deliveryNeeded,
      deliveryArea: source.deliveryArea,
      deliveryCost: ctx.access.visibleCategories.has('cost') ? source.deliveryCost : null,
      notes: source.notes,
      copiedFromId: input.id,
      requestHash,
    })
    const sourceLines = await tx
      .select()
      .from(saleLines)
      .where(
        and(
          eq(saleLines.businessId, ctx.businessId),
          eq(saleLines.saleId, input.id),
          isNull(saleLines.deletedAt),
        ),
      )
      .orderBy(saleLines.position, saleLines.id)
    if (sourceLines.length > 0) {
      await tx.insert(saleLines).values(
        sourceLines.map((line, position) => ({
          id: newId(),
          businessId: ctx.businessId,
          saleId: input.newId,
          position,
          kind: line.kind,
          productId: line.productId,
          description: line.description,
          qty: line.qty,
          unit: line.unit,
          unitPrice: line.unitPrice,
          priceIncludesVat: line.priceIncludesVat,
          discountPercent: line.discountPercent,
          discountAmount: line.discountAmount,
          vatCategory: line.vatCategory,
          vatRate: line.vatRate,
          subtotal: line.subtotal,
          discount: line.discount,
          net: line.net,
          vat: line.vat,
          total: line.total,
        })),
      )
    }
    return result(await readSale(tx, ctx, input.newId))
  })
}

/**
 * `sale.fillDeliveryCost`: what the delivery of a finalized (or reversed) sale actually cost, once,
 * while it is still missing (D-230): the costs switch only (FORBIDDEN before anything is read). Also
 * into a closed month: it completes a cost shown as missing, nothing is posted. A draft is edited
 * instead (DOCUMENT_NOT_POSTED); a sale without delivery is VALIDATION; one whose delivery cost is
 * set already is DOCUMENT_POSTED.
 */
export function fillDeliveryCost(
  ctx: BusinessCtx,
  input: FillDeliveryInput,
): Promise<SaleResultDto> {
  assertQueryable(ctx, [{ name: 'deliveryCost', category: 'cost' }])
  return ctx.tx(async (tx) => {
    const head = await lockSale(tx, ctx, input.id)
    if (head.status === 'draft') throw new AppError('document_not_posted')
    if (!head.delivery_needed) throw invalid('deliveryCost: this sale had no delivery')
    if (head.delivery_cost !== null) throw new AppError('document_posted')
    await tx
      .update(sales)
      .set({ deliveryCost: input.deliveryCost })
      .where(and(eq(sales.businessId, ctx.businessId), eq(sales.id, input.id)))
    return result(await readSale(tx, ctx, input.id))
  })
}

// ---------------------------------------------------------------------------------------------------
// Today's sales
// ---------------------------------------------------------------------------------------------------

interface SheetProductRecord extends Record<string, unknown> {
  id: string
  name: string
  type: ProductType
  unit: StandardUnit
  default_price: string | null
  last_price: string | null
  price_includes_vat: boolean
  vat_category: VatCategory
}

/**
 * `sale.daySheet`: Today's sales of the caller for a day (or several days of one month), a channel and
 * a branch. Their own live sheet when they have one (draft or finalized: asking again opens it, Q10),
 * the branch's products (those sold everywhere or at this location, not archived), the caller's most
 * sold in the last 30 days first and then by name (never by the business's totals), each with the last
 * price the caller sold it at on this channel and branch, else its usual price. A member who sees every
 * sale also gets every live sheet of these days, channel and branch ("2 sheets for Shop on 8 Oct").
 * With branches, the branches the caller may sell at (their picker: members who may not manage
 * locations cannot list them otherwise; a branch name is shown on every sale anyway).
 */
export function daySheet(ctx: BusinessCtx, input: DaySheetInput): Promise<DaySheetDto> {
  return ctx.tx(async (tx) => {
    const biz = await saleContextOf(tx, ctx.businessId)
    assertDays(input.businessDate, input.periodFrom, biz.today)
    const locationId = await resolveLocation(tx, ctx, input.locationId, biz.defaultLocationId)
    assertInScope(ctx, locationId)
    const channel = await resolveChannel(tx, ctx.businessId, input.channelId, null, true)
    const firstDay = input.periodFrom ?? input.businessDate
    const sheetKey = sql`s.business_id = ${ctx.businessId} and s.deleted_at is null
      and s.source = 'day_sheet' and s.status <> 'reversed'
      and s.location_id = ${locationId} and s.channel_id = ${channel.id}
      and s.business_date = ${input.businessDate}::date
      and coalesce(s.period_from, s.business_date) = ${firstDay}::date`
    const [own] = (await tx.execute(sql`
      select s.id from app.sales s where ${sheetKey} and s.created_by = app.current_user_id()
    `)) as unknown as { id: string }[]
    const sheet = own ? await readSale(tx, ctx, own.id) : null
    const orderFrom = new Date(`${biz.today}T00:00:00Z`)
    orderFrom.setUTCDate(orderFrom.getUTCDate() - (DAY_SHEET_ORDER_DAYS - 1))
    const products = (await tx.execute(sql`
      select p.id, p.name, p.type, p.unit, trim_scale(p.default_price)::text as default_price,
             p.price_includes_vat, p.vat_category,
             (select trim_scale(l.unit_price)::text
                from app.sale_lines l
                join app.sales s on s.business_id = l.business_id and s.id = l.sale_id
               where l.business_id = p.business_id and l.product_id = p.id and l.kind = 'item'
                 and l.deleted_at is null and s.deleted_at is null and s.status = 'posted'
                 and s.created_by = app.current_user_id()
                 and s.channel_id = ${channel.id} and s.location_id = ${locationId}
               order by s.business_date desc, s.posted_at desc, l.position
               limit 1) as last_price,
             coalesce((
               select sum(l.qty)
                 from app.sale_lines l
                 join app.sales s on s.business_id = l.business_id and s.id = l.sale_id
                where l.business_id = p.business_id and l.product_id = p.id and l.kind = 'item'
                  and l.deleted_at is null and s.deleted_at is null and s.status = 'posted'
                  and s.created_by = app.current_user_id()
                  and s.business_date between ${orderFrom.toISOString().slice(0, 10)}::date
                                          and ${biz.today}::date
             ), 0) as sold
        from app.products_services p
       where p.business_id = ${ctx.businessId} and p.deleted_at is null and p.archived_at is null
         and (not exists (
                select 1 from app.product_locations pl
                 where pl.business_id = p.business_id and pl.product_id = p.id
                   and pl.deleted_at is null)
              or exists (
                select 1 from app.product_locations pl
                 where pl.business_id = p.business_id and pl.product_id = p.id
                   and pl.location_id = ${locationId} and pl.deleted_at is null))
       order by sold desc, lower(p.name), p.id
       limit ${DAY_SHEET_PRODUCTS_MAX}
    `)) as unknown as SheetProductRecord[]
    let sheets: DaySheetDto['data']['sheets'] = null
    if (seesAll(ctx)) {
      const team = ctx.access.capabilities.has_team
      const rows = (await tx.execute(sql`
        select s.id, s.status, s.created_by = app.current_user_id() as mine,
               ${enteredByName} as entered_by_name
          from app.sales s
         where ${sheetKey}
         order by s.created_at, s.id
      `)) as unknown as {
        id: string
        status: SaleDto['status']
        mine: boolean
        entered_by_name: string | null
      }[]
      sheets = rows.map((r) => ({
        saleId: r.id,
        status: r.status,
        enteredByName: team ? r.entered_by_name : null,
        mine: r.mine,
      }))
    }
    let locations: DaySheetDto['data']['locations'] = null
    if (ctx.access.capabilities.multi_location) {
      const scope = ctx.access.locationScope
      locations = (
        (await tx.execute(sql`
          select l.id, l.name, l.is_default from app.locations l
           where l.business_id = ${ctx.businessId} and l.deleted_at is null
             ${scope.all ? sql`` : sql`and l.id = any(${uuidArray([...scope.ids])})`}
           order by l.is_default desc, lower(l.name), l.id
        `)) as unknown as { id: string; name: string; is_default: boolean }[]
      ).map((l) => ({ id: l.id, name: l.name, isDefault: l.is_default }))
    }
    return {
      data: {
        businessDate: input.businessDate,
        periodFrom: input.periodFrom,
        locationId,
        channelId: channel.id,
        channelName: channel.name,
        today: biz.today,
        closedThrough: biz.closedThrough,
        sheet,
        products: products.map((p) => ({
          productId: p.id,
          name: p.name,
          type: p.type,
          unit: p.unit,
          price: p.last_price ?? p.default_price,
          priceIncludesVat: biz.vatRegistered && p.price_includes_vat,
          vatCategory: biz.vatRegistered ? p.vat_category : null,
        })),
        sheets,
        locations,
      },
      meta: { redacted: [] },
    }
  })
}
