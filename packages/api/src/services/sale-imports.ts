import type {
  AddImportRowsDto,
  addImportRowsInput,
  createImportInput,
  ImportDayDto,
  importIdInput,
  ImportListDto,
  importListInput,
  ImportMappingDto,
  ImportNameDto,
  importProfileIdInput,
  ImportProfileListDto,
  ImportRowErrorDto,
  importVersionInput,
  matchImportInput,
  OkDto,
  reverseImportInput,
  SaleImportDto,
  SaleImportResultDto,
  setImportOverlapInput,
} from '@bizcost/contracts'
import { CATALOG_NAME_MAX_LENGTH, SALE_LINE_DESCRIPTION_MAX_LENGTH } from '@bizcost/contracts'
import {
  createIdempotent,
  productsServices,
  saleImports,
  sales,
  type NewSale,
  type Tx,
} from '@bizcost/db'
import {
  aliasKeyOfCode,
  aliasKeyOfName,
  can,
  canAccessLocation,
  computeSale,
  costRatio,
  currencyMinorUnit,
  IMPORT_SOURCE_FILE,
  importDayLines,
  isCurrencyCode,
  matchIndexOf,
  matchName,
  nameKey,
  newId,
  suggestionsFor,
  roundDocument,
  saleLineCost,
  sumDecimals,
  type AliasTarget,
  type CurrencyCode,
  type ImportAlias,
  type ImportDayEntry,
  type ImportOverlap,
  type ImportSaleLine,
  type ImportShape,
  type MatchIndex,
  type Money,
  type NameMatch,
  type OwnerTimePart,
  type ProductType,
  type Quantity,
  type SaleAmounts,
  type SaleImportStatus,
  type SaleLineInput,
  type SalesChannelKind,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError, constraintOf, sqlStateOf } from '../errors'
import { assertModuleActive, assertPermission, assertQueryable, passes } from '../trpc'
import { decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { resolveLocation } from './purchases'
import {
  insertMaterialRows,
  itemMaterialsOf,
  lineCostColumns,
  materialRows,
  postedPurchaseLinesOf,
  shareCostRows,
} from './sale-costs'
import {
  assertPostable,
  columnArray,
  isoOf,
  jsonRecords,
  lockPostingBusiness,
  reversalDateOf,
  uuidArray,
  type PostingBusiness,
} from './stock'

// Importing sales from a file (ROADMAP.md M3 Step 4; DATA_MODEL.md §6; the owner's answer Q15 of
// D-218). Module `sales` (planned until Release A: served under the dev-only preview only, D-125) and
// Products & Services; `sales.imports.manage`, which needs sales.documents.manage and .post (the
// router checks them). The file is read in the browser and never sent: only what sale_imports keeps
// and its rows summed into day × item totals (sale_import_rows, staged until it is finalized).
//
//   - Create: one channel and one location (the member's branches, Q12), days within one month and
//     never after today; the same file (its SHA-256) as an import not reversed is ALREADY_IMPORTED
//     (its day and id named); the columns are remembered for the file's layout (import_profiles).
//   - Preview (`get`): its days (already imported by another import: skipped by default or replaced;
//     Today's sales or One sale on the same channel, branch and day: a warning), its names each with
//     how it is matched (matchName: a saved answer, the item code, the name; else "Did you mean …?"),
//     the sales before VAT as they will be posted, and the materials without a price (`cost`).
//   - Match: each answer is saved as an alias (of the name, and of the code), for the next files too;
//     "Add as new" makes the product (products.items.manage).
//   - Post: one sale per day × branch × channel (a summary: one sale on its last day covering its
//     days, Q9), plus the day's refund when more was refunded than sold of something; the cost of
//     what was sold frozen on each day in the lock order of sale-costs.ts; refused while a name is
//     unmatched (IMPORT_UNMATCHED) or a day is in closed books (BOOKS_CLOSED). Days of earlier
//     imports are skipped or replaced: only the days this file posts are replaced (their sales
//     reversed), and a sale of an earlier summary over several days is replaced only when this file
//     posts all of its days (IMPORT_REPLACE_PARTIAL otherwise: its other days would be lost). The fee
//     column becomes the channel's statement for the file's days (STATEMENT_OVERLAP when one covers
//     them). Imports of one channel and branch are finalized one at a time (a transaction lock), so
//     two files of the same day finalized together never both post it. Idempotent.
//   - Reverse: the whole import or one day (each sale as sale.reverse does: as if never finalized, or
//     on the first open day when its day is closed); an import with no finalized day left is reversed
//     (its file may then be imported again) with its statement, while its days are open.
//
// Who sees which import: as sales (D-231): every import with "see every sale", else only one's own;
// a member limited to branches only those branches'. Another's is NOT_FOUND, and never named (its id
// is left out of ALREADY_IMPORTED and of a preview's day). Changing one (rows, answers, overlap,
// discard, finalize) is one's own while nobody else changed it since (D-214), or any for a member who
// sees every sale. Reversing finalized sales, through `reverse` or by replacing days, needs
// sales.documents.reverse as sale.reverse does (the router, and setOverlap/post here: D-260). A fee
// column's statement is a channel statement: it is sent, finalized and reversed only by a member who
// may manage the channel's statements (sales.channels.manage) and sees costs.
//
// Lock order (extends D-228): the import FOR UPDATE → the import lock of its channel and branch (post)
// → the earlier imports it replaces, by ascending id → the sales it reverses, by ascending id → the
// business row FOR SHARE → the cost rows of what it sells FOR SHARE, by ascending material id. A
// reversal of an import takes the import, its sales, then the business row. Imported sales are
// reversed only through their import (sale.reverse and sale.correct refuse them), so a sale is never
// locked before its import.

type CreateInput = z.output<typeof createImportInput>
type RowsInput = z.output<typeof addImportRowsInput>
type IdInput = z.output<typeof importIdInput>
type VersionInput = z.output<typeof importVersionInput>
type MatchInput = z.output<typeof matchImportInput>
type OverlapInput = z.output<typeof setImportOverlapInput>
type ReverseInput = z.output<typeof reverseImportInput>
type ListInput = z.output<typeof importListInput>
type ProfileIdInput = z.output<typeof importProfileIdInput>

const invalid = (message: string) => new AppError('validation', { message })

// ---------------------------------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------------------------------

/** The caller sees every sale (and so every import, and their sales totals, H1). */
function seesAll(ctx: BusinessCtx): boolean {
  return can(ctx.access.effective, 'sales.documents.view')
}

/** The imports the caller may see (alias `i`): every one or their own, and only their branches. */
function visibleTo(ctx: BusinessCtx): SQL[] {
  const parts: SQL[] = []
  if (!seesAll(ctx)) parts.push(sql`i.created_by = app.current_user_id()`)
  const scope = ctx.access.locationScope
  if (!scope.all) parts.push(sql`i.location_id = any(${uuidArray([...scope.ids])})`)
  return parts
}

/** Whether the caller may open import `i`: `visibleTo` as one SQL boolean (alias `i`). */
function visibleSql(ctx: BusinessCtx): SQL {
  const parts = visibleTo(ctx)
  return parts.length === 0 ? sql`true` : sql`(${where(parts)})`
}

/**
 * A fee column's statement is the channel's statement (the plan's Keys): sending, finalizing and
 * reversing it need sales.channels.manage and the costs switch, as channelStatement.* do (FORBIDDEN).
 */
function assertMayManageStatement(ctx: BusinessCtx): void {
  assertQueryable(ctx, [{ name: 'feesTotal', category: 'cost' }])
  assertPermission(ctx, 'sales.channels.manage')
}

/** Reversing finalized sales (the days an import replaces) is sale.reverse's key (D-231, D-260). */
function assertMayReverse(ctx: BusinessCtx): void {
  assertPermission(ctx, 'sales.documents.reverse')
}

const where = (parts: readonly SQL[]) => sql.join([...parts], sql` and `)

/** Who entered it: their name in the business now. */
const enteredByName = sql`(
  select bm.display_name from app.business_members bm
   where bm.business_id = i.business_id and bm.user_id = i.created_by and bm.kind = 'account'
   order by (bm.status = 'active') desc, bm.created_at desc
   limit 1)`

// ---------------------------------------------------------------------------------------------------
// The business
// ---------------------------------------------------------------------------------------------------

interface ImportBusiness {
  readonly currency: CurrencyCode
  readonly vatRegistered: boolean
  readonly today: string
  readonly defaultLocationId: string | null
}

async function businessOf(tx: Tx, businessId: string): Promise<ImportBusiness> {
  const [row] = (await tx.execute(sql`
    select trim(b.currency) as currency, b.vat_registered,
           (now() at time zone b.timezone)::date::text as today,
           (select l.id from app.locations l
             where l.business_id = b.id and l.is_default and l.deleted_at is null) as default_location_id
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as {
    currency: string
    vat_registered: boolean
    today: string
    default_location_id: string | null
  }[]
  if (!row) throw new AppError('forbidden')
  if (!isCurrencyCode(row.currency)) throw invalid(`currency: ${row.currency} is not supported`)
  return {
    currency: row.currency,
    vatRegistered: row.vat_registered,
    today: row.today,
    defaultLocationId: row.default_location_id,
  }
}

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

interface ImportRecord extends Record<string, unknown> {
  id: string
  status: SaleImportStatus
  channel_id: string
  channel_name: string
  channel_kind: SalesChannelKind
  location_id: string
  location_name: string
  file_name: string
  shape: ImportShape
  period_from: string
  period_to: string
  mapping: ImportMappingDto
  amounts_include_vat: boolean
  rows_read: number
  rows_left_out: number
  errors: ImportRowErrorDto[]
  fees_total: string | null
  row_count: number
  rows_received: number
  overlap: ImportOverlap
  replaced_days: string[] | null
  skipped_days: string[] | null
  statement_id: string | null
  entered_by_name: string | null
  mine: boolean
  /** The caller entered it and nobody else changed it since (D-214). */
  own: boolean
  created_at: Date | string
  posted_at: Date | string | null
  reversed_at: Date | string | null
  version: number
}

/** The import row (alias `i`), NOT_FOUND unless a live import the caller may see; FOR UPDATE on ask. */
async function importRecord(
  tx: Tx,
  ctx: BusinessCtx,
  id: string,
  lock: boolean,
): Promise<ImportRecord> {
  // A row lock cannot go with the counts (aggregates): lock the row first, then read it.
  if (lock) {
    const [locked] = (await tx.execute(sql`
      select i.id from app.sale_imports i
       where ${where([sql`i.business_id = ${ctx.businessId}`, sql`i.id = ${id}`, sql`i.deleted_at is null`, ...visibleTo(ctx)])}
         for update
    `)) as unknown as { id: string }[]
    if (!locked) throw new AppError('not_found')
  }
  const [row] = (await tx.execute(sql`
    select i.id, i.status, i.channel_id, c.name as channel_name, c.kind as channel_kind,
           i.location_id, l.name as location_name, i.file_name, i.shape,
           i.period_from::text as period_from, i.period_to::text as period_to, i.mapping,
           i.amounts_include_vat, i.rows_read, i.rows_left_out, i.errors,
           trim_scale(i.fees_total)::text as fees_total, i.row_count,
           (select count(*)::int from app.sale_import_rows r
             where r.business_id = i.business_id and r.import_id = i.id and r.deleted_at is null)
             as rows_received,
           i.overlap, i.replaced_days::text[] as replaced_days,
           i.skipped_days::text[] as skipped_days,
           (select cs.id from app.channel_statements cs
             where cs.business_id = i.business_id and cs.import_id = i.id and cs.deleted_at is null
             limit 1) as statement_id,
           ${enteredByName} as entered_by_name,
           i.created_by = app.current_user_id() as mine,
           coalesce(i.created_by = app.current_user_id()
             and coalesce(i.updated_by, i.created_by) = app.current_user_id(), false) as own,
           i.created_at, i.posted_at, i.reversed_at, i.version
      from app.sale_imports i
      join app.sales_channels c on c.business_id = i.business_id and c.id = i.channel_id
      join app.locations l on l.business_id = i.business_id and l.id = i.location_id
     where ${where([sql`i.business_id = ${ctx.businessId}`, sql`i.id = ${id}`, sql`i.deleted_at is null`, ...visibleTo(ctx)])}
  `)) as unknown as ImportRecord[]
  if (!row) throw new AppError('not_found')
  return row
}

/** The key a name (with its code) is grouped by: its rows of every day together. */
const groupKeyOf = (name: string, code: string | null) =>
  `${nameKey(name)}\u0000${code === null ? '' : aliasKeyOfCode(code)}`

/** A staged row, with the key of its name and code (groupKeyOf) worked out once. */
interface RowRecord extends Record<string, unknown> {
  position: number
  business_date: string
  name: string
  code: string | null
  qty: string
  amount: string
  refunds: string
  file_rows: number
  group: string
}

async function stagedRows(tx: Tx, businessId: string, importId: string): Promise<RowRecord[]> {
  const rows = (await tx.execute(sql`
    select r.position, r.business_date::text as business_date, r.name, r.code,
           trim_scale(r.qty)::text as qty, trim_scale(r.amount)::text as amount,
           trim_scale(r.refunds)::text as refunds, r.file_rows
      from app.sale_import_rows r
     where r.business_id = ${businessId} and r.import_id = ${importId} and r.deleted_at is null
     order by r.position
  `)) as unknown as RowRecord[]
  // A file names each item on many days: each name and code is folded once.
  const keys = new Map<string, string>()
  for (const row of rows) {
    const raw = `${row.name}\u0000${row.code ?? ''}`
    let group = keys.get(raw)
    if (group === undefined) {
      group = groupKeyOf(row.name, row.code)
      keys.set(raw, group)
    }
    row.group = group
  }
  return rows
}

/** A product as an import matches, prices and costs it. */
interface ProductRecord extends Record<string, unknown> {
  id: string
  name: string
  type: ProductType
  unit: StandardUnit
  vat_category: VatCategory
  archived: boolean
  resale_material_id: string | null
  owner_minutes: string | null
}

/** The business's saved answers (source `file`) and its products, as matchName reads them. */
async function matchingOf(
  tx: Tx,
  businessId: string,
): Promise<{ index: MatchIndex; products: Map<string, ProductRecord> }> {
  const aliasRows = (await tx.execute(sql`
    select a.kind, a.key, a.target, a.product_id
      from app.product_aliases a
     where a.business_id = ${businessId} and a.source = ${IMPORT_SOURCE_FILE}
       and a.deleted_at is null
  `)) as unknown as {
    kind: ImportAlias['kind']
    key: string
    target: AliasTarget
    product_id: string | null
  }[]
  const productRows = (await tx.execute(sql`
    select p.id, p.name, p.type, p.unit, p.vat_category, p.archived_at is not null as archived,
           p.resale_material_id, trim_scale(p.owner_minutes)::text as owner_minutes
      from app.products_services p
     where p.business_id = ${businessId} and p.deleted_at is null
     order by lower(p.name), p.id
  `)) as unknown as ProductRecord[]
  const products = new Map(productRows.map((p) => [p.id, p] as const))
  const index = matchIndexOf(
    aliasRows.map((a) => ({
      kind: a.kind,
      key: a.key,
      target: a.target,
      productId: a.product_id,
    })),
    // Names are matched to the products sold now; a saved answer may still name an archived one.
    productRows.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })),
  )
  return { index, products }
}

interface NameGroup {
  name: string
  code: string | null
  fileRows: number
  qty: string
  amount: string
  match: NameMatch
}

/**
 * The rows' names, each with its rows added up and how it is matched ("Did you mean" left empty:
 * suggestionsFor works it out for the names a preview shows, never for every name of a big file).
 */
function nameGroupsOf(rows: readonly RowRecord[], index: MatchIndex): Map<string, NameGroup> {
  const groups = new Map<string, NameGroup & { qtys: string[]; amounts: string[] }>()
  for (const row of rows) {
    const key = row.group
    const group = groups.get(key)
    if (group) {
      group.fileRows += row.file_rows
      group.qtys.push(row.qty)
      group.amounts.push(row.amount)
    } else {
      groups.set(key, {
        name: row.name,
        code: row.code,
        fileRows: row.file_rows,
        qty: '0',
        amount: '0',
        qtys: [row.qty],
        amounts: [row.amount],
        match: matchName({ name: row.name, code: row.code }, index, { suggest: false }),
      })
    }
  }
  const result = new Map<string, NameGroup>()
  for (const [key, g] of groups) {
    result.set(key, {
      name: g.name,
      code: g.code,
      fileRows: g.fileRows,
      qty: sumDecimals(g.qtys),
      amount: sumDecimals(g.amounts),
      match: g.match,
    })
  }
  return result
}

/** One day of an import as it posts: its sale's day, the days it covers, its rows. */
interface PlannedDay {
  readonly day: string
  readonly periodFrom: string | null
  readonly rows: RowRecord[]
}

/** The import's days: a line file's own days, or a summary's one sale on its last day (Q9). */
function daysOf(head: ImportRecord, rows: readonly RowRecord[]): PlannedDay[] {
  if (head.shape === 'summary') {
    return [
      {
        day: head.period_to,
        periodFrom: head.period_from < head.period_to ? head.period_from : null,
        rows: [...rows],
      },
    ]
  }
  const byDay = new Map<string, RowRecord[]>()
  for (const row of rows) {
    const list = byDay.get(row.business_date)
    if (list) list.push(row)
    else byDay.set(row.business_date, [row])
  }
  return [...byDay.keys()].sort().map((day) => ({ day, periodFrom: null, rows: byDay.get(day)! }))
}

/** The entries of a day (its rows with what each is), or null while a name is unmatched. */
function entriesOf(
  rows: readonly RowRecord[],
  groups: ReadonlyMap<string, NameGroup>,
): ImportDayEntry[] | null {
  const entries: ImportDayEntry[] = []
  for (const row of rows) {
    const match = groups.get(row.group)!.match
    if (match.state !== 'matched') return null
    entries.push({
      target: match.target,
      productId: match.productId,
      qty: row.qty,
      amount: row.amount,
    })
  }
  return entries
}

/** The first file name of rows of `target` in a day (a charge's or delivery's line text). */
function firstNameOf(
  rows: readonly RowRecord[],
  groups: ReadonlyMap<string, NameGroup>,
  target: AliasTarget,
): string | null {
  for (const row of rows) {
    const match = groups.get(row.group)!.match
    if (match.state === 'matched' && match.target === target) {
      return row.name.slice(0, SALE_LINE_DESCRIPTION_MAX_LENGTH).trim() || null
    }
  }
  return null
}

/** The domain's view of a day's lines (computeSale). */
function domainLinesOf(
  lines: readonly ImportSaleLine[],
  products: ReadonlyMap<string, ProductRecord>,
  includesVat: boolean,
): SaleLineInput[] {
  return lines.map((line): SaleLineInput => {
    const base = {
      qty: line.qty as Quantity,
      unitPrice: line.unitPrice as Money,
      priceIncludesVat: includesVat,
      discount: line.discountAmount === null ? null : { amount: line.discountAmount as Money },
    }
    if (line.kind === 'item') {
      return { ...base, kind: 'item', vatCategory: products.get(line.productId!)!.vat_category }
    }
    if (line.kind === 'charge') return { ...base, kind: 'charge', vatCategory: 'standard' }
    return { ...base, kind: 'delivery' }
  })
}

/** A day's sale (sold, or its refund) worked out. */
interface DaySale {
  readonly day: PlannedDay
  readonly lines: readonly ImportSaleLine[]
  readonly amounts: SaleAmounts
}

/** The sales of a day: what was sold, and its refund when more was refunded than sold of something. */
function daySalesOf(
  day: PlannedDay,
  entries: readonly ImportDayEntry[],
  products: ReadonlyMap<string, ProductRecord>,
  business: { vatRegistered: boolean; currency: CurrencyCode },
  includesVat: boolean,
): DaySale[] {
  const minor = currencyMinorUnit(business.currency)
  const { sold, returned } = importDayLines(entries, minor)
  const result: DaySale[] = []
  for (const lines of [sold, returned]) {
    if (lines.length === 0) continue
    const input = {
      lines: domainLinesOf(lines, products, includesVat),
      vatRegistered: business.vatRegistered,
    }
    // computeSale refuses (RangeError) what saleError finds: the amounts are worked out once.
    let amounts: SaleAmounts
    try {
      amounts = computeSale(input, business.currency)
    } catch (error) {
      if (error instanceof RangeError) throw invalid(`amounts of ${day.day}: ${error.message}`)
      throw error
    }
    result.push({ day, lines, amounts })
  }
  return result
}

/** Another import's finalized sale on the same channel and branch, and the days it covers. */
interface CoveringSale {
  id: string
  from_day: string
  to_day: string
  import_id: string
  file_name: string
  visible: boolean
}

/**
 * The finalized sales of other imports on the import's channel and branch over its days; with `lock`,
 * only those of `ids`, locked FOR UPDATE by ascending id. `visible`: the caller may open their import.
 */
async function coveringImportSales(
  tx: Tx,
  ctx: BusinessCtx,
  head: Pick<ImportRecord, 'id' | 'channel_id' | 'location_id' | 'period_from' | 'period_to'>,
  lock: { ids: readonly string[] } | null = null,
): Promise<CoveringSale[]> {
  if (lock && lock.ids.length === 0) return []
  return (await tx.execute(sql`
    select s.id, coalesce(s.period_from, s.business_date)::text as from_day,
           s.business_date::text as to_day, s.import_id, i.file_name,
           ${visibleSql(ctx)} as visible
      from app.sales s
      join app.sale_imports i on i.business_id = s.business_id and i.id = s.import_id
     where s.business_id = ${ctx.businessId} and s.deleted_at is null and s.source = 'import'
       and s.status = 'posted' and s.import_id <> ${head.id}
       and s.channel_id = ${head.channel_id} and s.location_id = ${head.location_id}
       and s.business_date >= ${head.period_from}::date
       and coalesce(s.period_from, s.business_date) <= ${head.period_to}::date
       ${lock ? sql`and s.id = any(${uuidArray([...lock.ids])})` : sql``}
     order by s.id
     ${lock ? sql`for update of s` : sql``}
  `)) as unknown as CoveringSale[]
}

const covers = (sale: { from_day: string; to_day: string }, from: string, to: string) =>
  sale.from_day <= to && sale.to_day >= from

/** The days from `from` to `to` (YYYY-MM-DD, both included). */
function daysFrom(from: string, to: string): string[] {
  const days: string[] = []
  const day = new Date(`${from}T00:00:00Z`)
  for (let iso = from; iso <= to; iso = day.toISOString().slice(0, 10)) {
    days.push(iso)
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return days
}

/**
 * The earlier sales "replace" takes back: those of the days this import posts, never others. A sale of
 * an earlier summary over several days is taken back only when this import posts every one of its
 * days (IMPORT_REPLACE_PARTIAL otherwise: its other days' sales would be lost with it).
 */
function salesReplaced(covering: readonly CoveringSale[], toPost: readonly PlannedDay[]) {
  const posts = (day: string) => toPost.some((p) => (p.periodFrom ?? p.day) <= day && day <= p.day)
  const replaced = covering.filter((s) =>
    toPost.some((d) => covers(s, d.periodFrom ?? d.day, d.day)),
  )
  for (const sale of replaced) {
    if (sale.from_day < sale.to_day && !daysFrom(sale.from_day, sale.to_day).every(posts)) {
      throw new AppError('import_replace_partial', { names: [sale.from_day, sale.to_day] })
    }
  }
  return replaced
}

/** The days of Today's sales or One sale finalized on the import's channel and branch. */
async function otherSalesDays(
  tx: Tx,
  businessId: string,
  head: Pick<ImportRecord, 'channel_id' | 'location_id' | 'period_from' | 'period_to'>,
): Promise<{ from_day: string; to_day: string }[]> {
  return (await tx.execute(sql`
    select coalesce(s.period_from, s.business_date)::text as from_day,
           s.business_date::text as to_day
      from app.sales s
     where s.business_id = ${businessId} and s.deleted_at is null
       and s.source in ('day_sheet', 'single') and s.status = 'posted'
       and s.channel_id = ${head.channel_id} and s.location_id = ${head.location_id}
       and s.business_date >= ${head.period_from}::date
       and coalesce(s.period_from, s.business_date) <= ${head.period_to}::date
  `)) as unknown as { from_day: string; to_day: string }[]
}

/** The materials of these products with no standing purchase by `day` (`cost`; Materials on). */
async function unpricedMaterialsOf(
  tx: Tx,
  businessId: string,
  productIds: readonly string[],
  day: string,
): Promise<{ id: string; name: string }[]> {
  if (productIds.length === 0) return []
  return (await tx.execute(sql`
    with used as (
      select l.material_id
        from app.recipes r
        join app.recipe_lines l
          on l.business_id = r.business_id and l.recipe_id = r.id and l.deleted_at is null
       where r.business_id = ${businessId} and r.deleted_at is null
         and r.product_id = any(${uuidArray(productIds)})
      union
      select p.resale_material_id
        from app.products_services p
       where p.business_id = ${businessId} and p.id = any(${uuidArray(productIds)})
         and p.resale_material_id is not null
    )
    select m.id, m.name
      from app.materials m
     where m.business_id = ${businessId} and m.deleted_at is null
       and m.id in (select u.material_id from used u)
       and not exists (
         select 1 from app.stock_movements x
          where x.business_id = m.business_id and x.material_id = m.id and x.kind = 'purchase'
            and x.business_date <= ${day}::date
            and not exists (
              select 1 from app.stock_movements r
               where r.business_id = x.business_id and r.reverses_id = x.id))
     order by lower(m.name), m.id
     limit 20
  `)) as unknown as { id: string; name: string }[]
}

/** "Did you mean …?" is worked out for at most this many names of a preview (the first to settle). */
const SUGGESTED_NAMES = 200

/** A finalized import's sales, by day. */
interface ImportSaleRecord extends Record<string, unknown> {
  id: string
  business_date: string
  period_from: string | null
  status: 'draft' | 'posted' | 'reversed'
  net_total: string
}

/** The import as the API returns it. */
async function readImport(tx: Tx, ctx: BusinessCtx, id: string): Promise<SaleImportDto> {
  const head = await importRecord(tx, ctx, id, false)
  const business = await businessOf(tx, ctx.businessId)
  const costsShown = ctx.access.visibleCategories.has('cost')
  let days: ImportDayDto[]
  let names: ImportNameDto[] = []
  let amount: string
  let refunds: string
  let salesBeforeVat: string | null = null
  let matchedNames = 0
  let totalNames = 0
  let unpriced: { id: string; name: string }[] | null = costsShown ? [] : null

  if (head.status === 'draft') {
    const rows = await stagedRows(tx, ctx.businessId, id)
    const { index, products } = await matchingOf(tx, ctx.businessId)
    const groups = nameGroupsOf(rows, index)
    amount = sumDecimals(rows.map((r) => r.amount))
    refunds = sumDecimals(rows.map((r) => r.refunds))
    const covering = await coveringImportSales(tx, ctx, head)
    const others = await otherSalesDays(tx, ctx.businessId, head)
    const planned = daysOf(head, rows)
    let allMatched = true
    const nets: string[] = []
    days = planned.map((day) => {
      const from = day.periodFrom ?? day.day
      const by = covering.find((s) => covers(s, from, day.day))
      const entries = entriesOf(day.rows, groups)
      // Once its names are settled, a day says what it will post (before VAT for a VAT-registered
      // business, without what is not sold); until then what its rows add up to.
      let amount = sumDecimals(day.rows.map((r) => r.amount))
      if (entries === null) allMatched = false
      else {
        const dayNets = daySalesOf(day, entries, products, business, head.amounts_include_vat).map(
          (sale) => sale.amounts.net,
        )
        nets.push(...dayNets)
        amount = sumDecimals(dayNets)
      }
      return {
        businessDate: day.day,
        periodFrom: day.periodFrom,
        amount,
        settled: entries !== null,
        names: new Set(day.rows.map((r) => r.group)).size,
        state: by ? 'imported' : 'new',
        // An import the caller cannot open is never named (D-231): the day only says "imported".
        importedBy: by?.visible ? { id: by.import_id, fileName: by.file_name } : null,
        otherSales: others.some((s) => covers(s, from, day.day)),
        saleIds: [],
        refundIds: [],
      }
    })
    if (allMatched && rows.length === head.row_count) salesBeforeVat = sumDecimals(nets)
    const list = [...groups.values()]
    totalNames = list.length
    matchedNames = list.filter((g) => g.match.state === 'matched').length
    names = list
      .map((g): ImportNameDto => ({
        name: g.name,
        code: g.code,
        fileRows: g.fileRows,
        qty: g.qty,
        amount: g.amount,
        match:
          g.match.state === 'matched'
            ? {
                state: 'matched',
                via: g.match.via,
                target: g.match.target,
                productId: g.match.productId,
                productName:
                  g.match.productId === null
                    ? null
                    : (products.get(g.match.productId)?.name ?? null),
              }
            : { state: 'unmatched', suggestions: null },
      }))
      .sort(
        (a, b) =>
          Number(a.match.state === 'matched') - Number(b.match.state === 'matched') ||
          a.name.localeCompare(b.name),
      )
      // "Did you mean …?" for the first names to settle (shown first), never for every name of a big
      // file: each compares the name with every product. The others say they were not looked for.
      .map((entry, position) =>
        entry.match.state === 'unmatched' && position < SUGGESTED_NAMES
          ? {
              ...entry,
              match: { state: 'unmatched', suggestions: [...suggestionsFor(entry.name, index)] },
            }
          : entry,
      )
    if (costsShown && passes(ctx, ['materials'])) {
      const productIds = [
        ...new Set(
          list.flatMap((g) =>
            g.match.state === 'matched' && g.match.productId ? [g.match.productId] : [],
          ),
        ),
      ]
      unpriced = await unpricedMaterialsOf(tx, ctx.businessId, productIds, head.period_to)
    }
  } else {
    const saleRows = (await tx.execute(sql`
      select s.id, s.business_date::text as business_date, s.period_from::text as period_from,
             s.status, trim_scale(s.net_total)::text as net_total
        from app.sales s
       where s.business_id = ${ctx.businessId} and s.import_id = ${id} and s.deleted_at is null
       order by s.business_date, s.net_total desc, s.id
    `)) as unknown as ImportSaleRecord[]
    const byDay = new Map<string, ImportSaleRecord[]>()
    for (const sale of saleRows) {
      const list = byDay.get(sale.business_date)
      if (list) list.push(sale)
      else byDay.set(sale.business_date, [sale])
    }
    const posted = saleRows.filter((s) => s.status === 'posted')
    amount = sumDecimals(posted.map((s) => s.net_total))
    refunds = sumDecimals(
      posted.filter((s) => s.net_total.startsWith('-')).map((s) => s.net_total.slice(1)),
    )
    salesBeforeVat = amount
    days = [
      ...[...byDay.entries()].map(([day, list]): ImportDayDto => {
        const live = list.filter((s) => s.status === 'posted')
        return {
          businessDate: day,
          periodFrom: list[0]!.period_from,
          amount: sumDecimals(live.length > 0 ? live.map((s) => s.net_total) : ['0']),
          settled: true,
          names: 0,
          state: live.length > 0 ? 'posted' : 'reversed',
          importedBy: null,
          otherSales: false,
          saleIds: list.map((s) => s.id),
          // The day's refund (more refunded than sold of something): a sale of negative amounts.
          refundIds: list.filter((s) => s.net_total.startsWith('-')).map((s) => s.id),
        }
      }),
      ...(head.skipped_days ?? []).map((day): ImportDayDto => ({
        businessDate: day,
        periodFrom: null,
        amount: '0',
        settled: true,
        names: 0,
        state: 'skipped',
        importedBy: null,
        otherSales: false,
        saleIds: [],
        refundIds: [],
      })),
    ].sort((a, b) =>
      a.businessDate < b.businessDate ? -1 : a.businessDate > b.businessDate ? 1 : 0,
    )
    unpriced = costsShown ? [] : null
  }

  return {
    id: head.id,
    status: head.status,
    channelId: head.channel_id,
    channelName: head.channel_name,
    channelKind: head.channel_kind,
    locationId: head.location_id,
    locationName: head.location_name,
    fileName: head.file_name,
    shape: head.shape,
    periodFrom: head.period_from,
    periodTo: head.period_to,
    mapping: head.mapping,
    amountsIncludeVat: head.amounts_include_vat,
    vatRegistered: business.vatRegistered,
    currency: business.currency,
    rowsRead: head.rows_read,
    rowsLeftOut: head.rows_left_out,
    errors: head.errors,
    feesTotal: head.fees_total,
    rowCount: head.row_count,
    rowsReceived: head.rows_received,
    overlap: head.overlap,
    amount,
    refunds,
    salesBeforeVat,
    days,
    names,
    matchedNames,
    totalNames,
    unpricedMaterials: unpriced,
    statementId: head.statement_id,
    replacedDays: head.replaced_days ?? [],
    enteredByName: ctx.access.capabilities.has_team ? head.entered_by_name : null,
    mine: head.mine,
    createdAt: isoOf(head.created_at),
    postedAt: isoOf(head.posted_at),
    reversedAt: isoOf(head.reversed_at),
    version: head.version,
  }
}

function result(data: SaleImportDto): SaleImportResultDto {
  return { data, meta: { redacted: [] } }
}

/** `saleImport.get`: the preview of a draft, or what a finalized import posted. */
export function getImport(ctx: BusinessCtx, input: IdInput): Promise<SaleImportResultDto> {
  return ctx.tx(async (tx) => result(await readImport(tx, ctx, input.id)))
}

// ---------------------------------------------------------------------------------------------------
// A draft: create, rows, answers, overlap, discard
// ---------------------------------------------------------------------------------------------------

/** A location the caller may sell at (FORBIDDEN for a branch they are not limited to). */
function assertInScope(ctx: BusinessCtx, locationId: string): void {
  if (!canAccessLocation(ctx.access.locationScope, locationId)) {
    throw new AppError('forbidden', { message: 'not one of your branches' })
  }
}

/**
 * ALREADY_IMPORTED for a file (its hash) of an import not reversed, anyone's in the business: its
 * names are the day it was imported, its id when the caller may open it ('' otherwise: another
 * member's or another branch's import is never named, D-231), and whether it is a draft or posted.
 */
async function assertNewFile(tx: Tx, ctx: BusinessCtx, fileHash: string, id: string) {
  const [other] = (await tx.execute(sql`
    select i.id, i.status, coalesce(i.posted_at, i.created_at) as at, ${visibleSql(ctx)} as visible
      from app.sale_imports i
     where i.business_id = ${ctx.businessId} and i.file_hash = ${fileHash} and i.id <> ${id}
       and i.status <> 'reversed' and i.deleted_at is null
     limit 1
  `)) as unknown as { id: string; status: SaleImportStatus; at: Date | string; visible: boolean }[]
  if (other) {
    throw new AppError('already_imported', {
      names: [isoOf(other.at), other.visible ? other.id : '', other.status],
    })
  }
}

/**
 * `saleImport.create`: a draft for a file read in the browser (see above), idempotent on the client's
 * id. A fee column's total is a `cost`: only a member who sees costs sends it (FORBIDDEN otherwise).
 * The columns are remembered for the file's layout.
 */
export function createImport(ctx: BusinessCtx, input: CreateInput): Promise<SaleImportResultDto> {
  // The fee column becomes the channel's statement: only who may manage its statements sends it.
  if (input.feesTotal !== null) assertMayManageStatement(ctx)
  const { id, ...fields } = input
  return ctx.tx(async (tx) => {
    const business = await businessOf(tx, ctx.businessId)
    // "Do these amounts include VAT?" is asked only of a VAT-registered business (D-192, D-206).
    if (input.amountsIncludeVat && !business.vatRegistered) {
      throw new AppError('capability_disabled', { message: 'VAT needs a VAT-registered business' })
    }
    if (input.periodTo > business.today) throw new AppError('future_date')
    const locationId = await resolveLocation(tx, ctx, input.locationId, business.defaultLocationId)
    assertInScope(ctx, locationId)
    const [channel] = (await tx.execute(sql`
      select c.id, c.archived_at is not null as archived from app.sales_channels c
       where c.business_id = ${ctx.businessId} and c.id = ${input.channelId} and c.deleted_at is null
    `)) as unknown as { id: string; archived: boolean }[]
    if (!channel) throw new AppError('not_found')
    if (channel.archived) throw invalid('channelId: archived')
    await assertNewFile(tx, ctx, input.fileHash, id)
    let created: boolean
    try {
      const made = await createIdempotent(tx, saleImports, {
        id,
        businessId: ctx.businessId,
        channelId: channel.id,
        locationId,
        fileName: input.fileName,
        fileHash: input.fileHash,
        fingerprint: input.fingerprint,
        shape: input.shape,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        mapping: input.mapping,
        amountsIncludeVat: input.amountsIncludeVat,
        rowsRead: input.rowsRead,
        rowsLeftOut: input.rowsLeftOut,
        errors: input.errors,
        feesTotal: input.feesTotal,
        rowCount: input.rowCount,
        requestHash: requestHashOf(fields),
      })
      if (made.row.deletedAt !== null) {
        throw new AppError('conflict', { message: 'import was discarded' })
      }
      created = made.created
    } catch (error) {
      if (sqlStateOf(error) === '23505' && constraintOf(error) === 'sale_imports_file_key') {
        await assertNewFile(tx, ctx, input.fileHash, id)
      }
      throw error
    }
    // The file's layout keeps its columns (one click the next time); a replay writes nothing.
    if (created) {
      await tx.execute(sql`
      insert into app.import_profiles (id, business_id, source, fingerprint, mapping, last_used_at)
      values (${newId()}, ${ctx.businessId}, ${IMPORT_SOURCE_FILE}, ${input.fingerprint},
              ${JSON.stringify(input.mapping)}::text::jsonb, now())
      on conflict (business_id, source, fingerprint) where deleted_at is null
      do update set mapping = excluded.mapping, last_used_at = now()
    `)
    }
    return result(await readImport(tx, ctx, id))
  })
}

/** A draft the caller may change: their own nobody else changed since, or any with every sale seen. */
function assertMayChange(ctx: BusinessCtx, head: Pick<ImportRecord, 'own'>): void {
  if (!seesAll(ctx) && !head.own) throw new AppError('forbidden')
}

function assertDraft(head: Pick<ImportRecord, 'status' | 'version'>, version?: number): void {
  if (head.status !== 'draft') throw new AppError('document_posted')
  if (version !== undefined && head.version !== version) throw new AppError('conflict')
}

/**
 * The import row's few columns a chunk of rows needs, locked FOR UPDATE (NOT_FOUND as importRecord):
 * a file sends tens of chunks, each without the counts and names of the whole import.
 */
async function lockedHead(tx: Tx, ctx: BusinessCtx, id: string) {
  const [row] = (await tx.execute(sql`
    select i.status, i.version, i.row_count, i.shape, i.period_from::text as period_from,
           i.period_to::text as period_to,
           coalesce(i.created_by = app.current_user_id()
             and coalesce(i.updated_by, i.created_by) = app.current_user_id(), false) as own
      from app.sale_imports i
     where ${where([sql`i.business_id = ${ctx.businessId}`, sql`i.id = ${id}`, sql`i.deleted_at is null`, ...visibleTo(ctx)])}
       for update
  `)) as unknown as Pick<
    ImportRecord,
    'status' | 'version' | 'row_count' | 'shape' | 'period_from' | 'period_to' | 'own'
  >[]
  if (!row) throw new AppError('not_found')
  return row
}

/**
 * `saleImport.addRows`: up to IMPORT_ROWS_CHUNK staged rows of a draft (its own days; a summary's rows
 * on its last day). A position already received is kept as it is (a chunk sent again adds nothing).
 */
export function addImportRows(ctx: BusinessCtx, input: RowsInput): Promise<AddImportRowsDto> {
  return ctx.tx(async (tx) => {
    const head = await lockedHead(tx, ctx, input.id)
    assertMayChange(ctx, head)
    assertDraft(head)
    for (const row of input.rows) {
      if (row.position >= head.row_count) throw invalid('rows: a position past the row count')
      if (row.businessDate < head.period_from || row.businessDate > head.period_to) {
        throw invalid('rows: a day outside the import')
      }
      if (head.shape === 'summary' && row.businessDate !== head.period_to) {
        throw invalid('rows: a summary posts on its last day')
      }
      if (compareSign(row.refunds) < 0) throw invalid('rows: refunds')
    }
    await tx.execute(sql`
      insert into app.sale_import_rows
             (id, business_id, import_id, position, business_date, name, code, qty, amount, refunds,
              file_rows)
      select v.id, ${ctx.businessId}::uuid, ${input.id}::uuid, v.position, v.business_date, v.name,
             v.code, v.qty, v.amount, v.refunds, v.file_rows
        from unnest(${columnArray(
          input.rows.map(() => newId()),
          'uuid',
        )}, ${columnArray(
          input.rows.map((r) => String(r.position)),
          'int',
        )}, ${columnArray(
          input.rows.map((r) => r.businessDate),
          'date',
        )}, ${columnArray(
          input.rows.map((r) => r.name),
          'text',
        )}, ${columnArray(
          input.rows.map((r) => r.code),
          'text',
        )}, ${columnArray(
          input.rows.map((r) => r.qty),
          'numeric',
        )}, ${columnArray(
          input.rows.map((r) => r.amount),
          'numeric',
        )}, ${columnArray(
          input.rows.map((r) => r.refunds),
          'numeric',
        )}, ${columnArray(
          input.rows.map((r) => String(r.fileRows)),
          'int',
        )}) as v(id, position, business_date, name, code, qty, amount, refunds, file_rows)
      on conflict (business_id, import_id, position) do nothing
    `)
    const [count] = (await tx.execute(sql`
      select count(*)::int as n from app.sale_import_rows r
       where r.business_id = ${ctx.businessId} and r.import_id = ${input.id} and r.deleted_at is null
    `)) as unknown as { n: number }[]
    return { received: count?.n ?? 0, expected: head.row_count }
  })
}

const compareSign = (value: string) =>
  value.startsWith('-') && !/^-0*(?:\.0*)?$/.test(value) ? -1 : 1

/**
 * `saleImport.match`: answers for names of a draft import, each saved as the source's alias of its
 * item code (a code tells sizes of one name apart: its answer is the code's alone), or of its name when
 * it has no code, so the next files match them too. `new` makes the product first (named as the file
 * names it, sold by the piece at the file's average price; products.items.manage): one product per
 * name and code, named with its code ("Milk · 111") when the file gives its name several codes or a
 * product already has its name (another size answered before: D-262).
 */
export function matchImport(ctx: BusinessCtx, input: MatchInput): Promise<SaleImportResultDto> {
  return ctx.tx(async (tx) => {
    const head = await importRecord(tx, ctx, input.id, true)
    assertMayChange(ctx, head)
    assertDraft(head)
    const productIds = input.answers.flatMap((a) =>
      a.target === 'product' && a.productId ? [a.productId] : [],
    )
    if (productIds.length > 0) {
      const found = (await tx.execute(sql`
        select p.id from app.products_services p
         where p.business_id = ${ctx.businessId} and p.id = any(${uuidArray([...new Set(productIds)])})
           and p.deleted_at is null
      `)) as unknown as { id: string }[]
      if (found.length !== new Set(productIds).size) throw new AppError('not_found')
    }
    // "Add as new": one product per name and code of the file (an answer given twice makes one).
    const madeFor = new Map<string, string>()
    const added = input.answers.filter((a) => a.target === 'new')
    if (added.length > 0) {
      assertModuleActive(ctx, 'products')
      assertPermission(ctx, 'products.items.manage')
      const rows = await stagedRows(tx, ctx.businessId, input.id)
      const business = await businessOf(tx, ctx.businessId)
      // The rows of each name and code, and the names the file gives more than one code.
      const sums = new Map<string, { qtys: string[]; amounts: string[] }>()
      const codesOf = new Map<string, Set<string>>()
      for (const row of rows) {
        const group = row.group
        const sum = sums.get(group) ?? { qtys: [], amounts: [] }
        sum.qtys.push(row.qty)
        sum.amounts.push(row.amount)
        sums.set(group, sum)
        const key = nameKey(row.name)
        codesOf.set(key, (codesOf.get(key) ?? new Set()).add(row.code ?? ''))
      }
      // The plain names of coded answers a product already has (as the unique name key reads them).
      const plainName = (name: string) => name.slice(0, CATALOG_NAME_MAX_LENGTH).trim()
      const coded = added.filter((a) => a.code !== null).map((a) => plainName(a.name))
      const taken = new Set(
        coded.length === 0
          ? []
          : (
              (await tx.execute(sql`
                select x.name from unnest(${columnArray(coded, 'text')}) as x(name)
                 where exists (
                   select 1 from app.products_services p
                    where p.business_id = ${ctx.businessId} and p.deleted_at is null
                      and lower(p.name) = lower(x.name))
              `)) as unknown as { name: string }[]
            ).map((r) => r.name),
      )
      for (const answer of added) {
        const group = groupKeyOf(answer.name, answer.code)
        if (madeFor.has(group)) continue
        madeFor.set(group, answer.productId!)
        const key = nameKey(answer.name)
        const own = sums.get(group) ?? { qtys: [], amounts: [] }
        const price = averagePrice(
          sumDecimals(own.amounts),
          sumDecimals(own.qtys),
          business.currency,
        )
        // A code tells sizes of one name apart: its product carries it when the name is not its own.
        const shared =
          answer.code !== null &&
          ((codesOf.get(key)?.size ?? 0) > 1 || taken.has(plainName(answer.name)))
        const name = (shared ? `${answer.name.trim()} · ${answer.code}` : answer.name)
          .slice(0, CATALOG_NAME_MAX_LENGTH)
          .trim()
        try {
          const { row } = await createIdempotent(tx, productsServices, {
            id: answer.productId!,
            businessId: ctx.businessId,
            name,
            description: null,
            type: 'product',
            unit: 'piece',
            defaultPrice: price,
            vatCategory: 'standard',
            priceIncludesVat: business.vatRegistered && head.amounts_include_vat,
            resaleMaterialId: null,
            requestHash: requestHashOf({ importNew: group }),
          })
          if (row.deletedAt !== null) throw new AppError('conflict')
        } catch (error) {
          if (
            sqlStateOf(error) === '23505' &&
            constraintOf(error) === 'products_services_name_key'
          ) {
            throw new AppError('name_taken', { cause: error, names: [name] })
          }
          throw error
        }
      }
    }
    const aliases = input.answers.map((a) => {
      const target: AliasTarget = a.target === 'new' ? 'product' : a.target
      const productId =
        a.target === 'new'
          ? (madeFor.get(groupKeyOf(a.name, a.code)) ?? null)
          : target === 'product'
            ? a.productId
            : null
      const code = a.code === null ? '' : aliasKeyOfCode(a.code)
      return code === ''
        ? { kind: 'name', key: aliasKeyOfName(a.name), raw: a.name, target, product_id: productId }
        : { kind: 'code', key: code, raw: a.code!, target, product_id: productId }
    })
    // One answer a key: the last given.
    const byKey = new Map(
      aliases.filter((a) => a.key !== '').map((a) => [`${a.kind}\u0000${a.key}`, a] as const),
    )
    await tx.execute(sql`
      insert into app.product_aliases (id, business_id, source, kind, key, raw, target, product_id)
      select v.id, v.business_id, v.source, v.kind, v.key, v.raw, v.target, v.product_id
        from jsonb_to_recordset(${jsonRecords(
          [...byKey.values()].map((a) => ({
            id: newId(),
            business_id: ctx.businessId,
            source: IMPORT_SOURCE_FILE,
            kind: a.kind,
            key: a.key,
            raw: a.raw,
            target: a.target,
            product_id: a.product_id,
          })),
        )}) as v(id uuid, business_id uuid, source text, kind text, key text, raw text, target text,
                 product_id uuid)
      on conflict (business_id, source, kind, key) where deleted_at is null
      do update set raw = excluded.raw, target = excluded.target, product_id = excluded.product_id
    `)
    // The draft changed (its names), so a form opened before sees a new version.
    await tx.execute(sql`
      update app.sale_imports set updated_at = now()
       where business_id = ${ctx.businessId} and id = ${input.id}
    `)
    return result(await readImport(tx, ctx, input.id))
  })
}

/** amount ÷ qty to the minor unit (a new product's usual price); null without a quantity. */
function averagePrice(amount: string, qty: string, currency: CurrencyCode): string | null {
  if (amount.startsWith('-')) return null
  const ratio = costRatio([amount], [qty])
  return ratio === null ? null : roundDocument(ratio, currency)
}

/**
 * `saleImport.setOverlap`: days already imported are skipped (the default) or replaced. Replacing
 * reverses the earlier sales of those days: it needs sales.documents.reverse (FORBIDDEN), and never
 * reaches an import the caller cannot open.
 */
export function setImportOverlap(
  ctx: BusinessCtx,
  input: OverlapInput,
): Promise<SaleImportResultDto> {
  return ctx.tx(async (tx) => {
    const head = await importRecord(tx, ctx, input.id, true)
    assertMayChange(ctx, head)
    assertDraft(head, input.version)
    if (input.overlap === 'replace') {
      assertMayReverse(ctx)
      const covering = await coveringImportSales(tx, ctx, head)
      if (covering.some((sale) => !sale.visible)) throw new AppError('forbidden')
    }
    await tx.execute(sql`
      update app.sale_imports set overlap = ${input.overlap}
       where business_id = ${ctx.businessId} and id = ${input.id}
    `)
    return result(await readImport(tx, ctx, input.id))
  })
}

/** `saleImport.discard`: a draft is taken out with its staged rows; a finalized one never is. */
export function discardImport(ctx: BusinessCtx, input: VersionInput): Promise<OkDto> {
  return ctx.tx(async (tx) => {
    const head = await importRecord(tx, ctx, input.id, true)
    assertMayChange(ctx, head)
    assertDraft(head, input.version)
    await tx.execute(sql`
      delete from app.sale_import_rows
       where business_id = ${ctx.businessId} and import_id = ${input.id}
    `)
    await tx.execute(sql`
      update app.sale_imports set deleted_at = now()
       where business_id = ${ctx.businessId} and id = ${input.id}
    `)
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------------------------------------------
// Finalizing
// ---------------------------------------------------------------------------------------------------

/** businesses.owner_hourly_rate, read under the business row's lock of the posting. */
async function hourlyRateOf(tx: Tx, businessId: string): Promise<string | null> {
  const [row] = (await tx.execute(sql`
    select trim_scale(b.owner_hourly_rate)::text as rate from app.businesses b where b.id = ${businessId}
  `)) as unknown as { rate: string | null }[]
  return row?.rate ?? null
}

/** Reverses `list` (locked) in `tx`, each on its own day or the first open one (D-227). */
async function reverseSalesIn(
  tx: Tx,
  businessId: string,
  business: PostingBusiness,
  list: readonly { id: string; business_date: string }[],
): Promise<void> {
  if (list.length === 0) return
  await tx.execute(sql`
    update app.sales s
       set status = 'reversed', reversed_at = now(), reversed_by = app.current_user_id(),
           reversal_business_date = v.day
      from jsonb_to_recordset(${jsonRecords(
        list.map((s) => ({ id: s.id, day: reversalDateOf(business, s.business_date) })),
      )}) as v(id uuid, day date)
     where s.business_id = ${businessId} and s.id = v.id and s.status = 'posted'
  `)
}

/**
 * Imports with no finalized sale left become reversed (their file may be imported again), with the
 * statement made from their fee column while its days are open (a statement's days obey the
 * books-closed date; its fees then stay with the sales of those closed days). Reversing a statement is
 * the channel's statements' (FORBIDDEN without sales.channels.manage and the costs switch: the whole
 * reversal is refused, never an import reversed with its statement left behind).
 */
async function settleReversedImports(
  tx: Tx,
  ctx: BusinessCtx,
  business: PostingBusiness,
  importIds: readonly string[],
): Promise<void> {
  if (importIds.length === 0) return
  const done = (await tx.execute(sql`
    update app.sale_imports i
       set status = 'reversed', reversed_at = now(), reversed_by = app.current_user_id()
     where i.business_id = ${ctx.businessId} and i.id = any(${uuidArray([...importIds])})
       and i.status = 'posted'
       and not exists (
         select 1 from app.sales s
          where s.business_id = i.business_id and s.import_id = i.id and s.status = 'posted'
            and s.deleted_at is null)
    returning i.id
  `)) as unknown as { id: string }[]
  if (done.length === 0) return
  const statements = (await tx.execute(sql`
    update app.channel_statements cs
       set status = 'reversed', reversed_at = now(), reversed_by = app.current_user_id()
     where cs.business_id = ${ctx.businessId}
       and cs.import_id = any(${uuidArray(done.map((d) => d.id))})
       and cs.status = 'posted' and cs.deleted_at is null
       and (${business.closedThrough}::date is null
         or cs.period_from > ${business.closedThrough}::date)
    returning cs.id
  `)) as unknown as { id: string }[]
  if (statements.length > 0) assertMayManageStatement(ctx)
}

/** A line of the sales posted, as insertSaleLines writes it (decimals as strings). */
interface SaleLineRow {
  id: string
  sale_id: string
  position: string
  kind: ImportSaleLine['kind']
  product_id: string | null
  description: string | null
  qty: string
  unit: StandardUnit | null
  unit_price: string
  price_includes_vat: boolean
  discount_amount: string | null
  vat_category: VatCategory | null
  vat_rate: string | null
  subtotal: string
  discount: string
  net: string
  vat: string
  total: string
  cost_basis: string
  cost: string | null
  time_minutes: string | null
  time_cost: string | null
}

/**
 * The sale_lines rows of the sales posted, inserted in one statement, each column as one array
 * parameter (columnArray: a month of a shop's items is tens of thousands of lines).
 */
async function insertSaleLines(
  tx: Tx,
  businessId: string,
  rows: readonly SaleLineRow[],
): Promise<void> {
  if (rows.length === 0) return
  const column = (key: keyof SaleLineRow, type: Parameters<typeof columnArray>[1]) =>
    columnArray(
      rows.map((row) => row[key]),
      type,
    )
  await tx.execute(sql`
    insert into app.sale_lines
           (id, business_id, sale_id, position, kind, product_id, description, qty, unit, unit_price,
            price_includes_vat, discount_amount, vat_category, vat_rate, subtotal, discount, net, vat,
            total, cost_basis, cost, time_minutes, time_cost)
    select v.id, ${businessId}::uuid, v.sale_id, v.position, v.kind, v.product_id, v.description,
           v.qty, v.unit, v.unit_price, v.price_includes_vat, v.discount_amount, v.vat_category,
           v.vat_rate, v.subtotal, v.discount, v.net, v.vat, v.total, v.cost_basis, v.cost,
           v.time_minutes, v.time_cost
      from unnest(${column('id', 'uuid')}, ${column('sale_id', 'uuid')}, ${column('position', 'int')},
                  ${column('kind', 'text')}, ${column('product_id', 'uuid')},
                  ${column('description', 'text')}, ${column('qty', 'numeric')},
                  ${column('unit', 'text')}, ${column('unit_price', 'numeric')},
                  ${column('price_includes_vat', 'boolean')}, ${column('discount_amount', 'numeric')},
                  ${column('vat_category', 'text')}, ${column('vat_rate', 'numeric')},
                  ${column('subtotal', 'numeric')}, ${column('discount', 'numeric')},
                  ${column('net', 'numeric')}, ${column('vat', 'numeric')},
                  ${column('total', 'numeric')}, ${column('cost_basis', 'text')},
                  ${column('cost', 'numeric')}, ${column('time_minutes', 'numeric')},
                  ${column('time_cost', 'numeric')})
             as v(id, sale_id, position, kind, product_id, description, qty, unit, unit_price,
                  price_includes_vat, discount_amount, vat_category, vat_rate, subtotal, discount,
                  net, vat, total, cost_basis, cost, time_minutes, time_cost)
  `)
}

/** A date[] for raw SQL (null when empty). */
const dateArray = (days: readonly string[]) =>
  days.length === 0 ? sql`null::date[]` : sql`${`{${days.join(',')}}`}::text::date[]`

/**
 * `saleImport.post` ("Finalize"): see the top of this file. Every staged row must have arrived and
 * every name be settled (IMPORT_UNMATCHED); the days to post must be open and not after today. One
 * transaction; idempotent (a finalized import is returned as it is).
 */
export function postImport(ctx: BusinessCtx, input: VersionInput): Promise<SaleImportResultDto> {
  return ctx.tx(async (tx) => {
    // Lock 1: the import.
    const head = await importRecord(tx, ctx, input.id, true)
    if (head.status !== 'draft') return result(await readImport(tx, ctx, input.id))
    if (head.version !== input.version) throw new AppError('conflict')
    assertMayChange(ctx, head)
    assertModuleActive(ctx, 'products')
    // Its fee column becomes the channel's statement (the one finalizing may not be who sent it).
    if (head.fees_total !== null) assertMayManageStatement(ctx)
    if (head.rows_received !== head.row_count) throw invalid('rows: not all of them arrived')
    const rows = await stagedRows(tx, ctx.businessId, input.id)
    const { index, products } = await matchingOf(tx, ctx.businessId)
    const groups = nameGroupsOf(rows, index)
    if ([...groups.values()].some((g) => g.match.state !== 'matched')) {
      throw new AppError('import_unmatched')
    }
    const planned = daysOf(head, rows)

    // Lock 2: the imports of this channel and branch are finalized one at a time, so two files of the
    // same day finalized at once never both post it: the second reads the first's sales below.
    const lockKey = `app.sale_imports:${ctx.businessId}:${head.channel_id}:${head.location_id}`
    await tx.execute(sql`
      select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))
    `)

    // The days other imports already have: skipped, or replaced (their imports, then their sales,
    // locked in that order before the business row). Replacing takes back only the days this file
    // posts (salesReplaced), with sale.reverse's key, and never an import the caller cannot open.
    const covering = await coveringImportSales(tx, ctx, head)
    const coveredDay = (day: PlannedDay) =>
      covering.some((s) => covers(s, day.periodFrom ?? day.day, day.day))
    const replacing = head.overlap === 'replace'
    const toPost = replacing ? planned : planned.filter((day) => !coveredDay(day))
    const skipped = replacing ? [] : planned.filter(coveredDay).map((d) => d.day)
    if (toPost.length === 0) throw invalid('every day is imported already: choose to replace them')
    let replacedSales: CoveringSale[] = []
    const toReplace = replacing ? salesReplaced(covering, toPost) : []
    if (toReplace.length > 0) {
      assertMayReverse(ctx)
      if (toReplace.some((sale) => !sale.visible)) throw new AppError('forbidden')
      const earlier = [...new Set(toReplace.map((s) => s.import_id))].sort()
      await tx.execute(sql`
        select i.id from app.sale_imports i
         where i.business_id = ${ctx.businessId} and i.id = any(${uuidArray(earlier)})
         order by i.id
           for update
      `)
      replacedSales = await coveringImportSales(tx, ctx, head, { ids: toReplace.map((s) => s.id) })
    }

    // Lock 2: the business row (the books-closed date, VAT registration, currency).
    const business = await lockPostingBusiness(tx, ctx.businessId)
    for (const day of toPost) assertPostable(business, day.day)
    const [location] = (await tx.execute(sql`
      select l.id from app.locations l
       where l.business_id = ${ctx.businessId} and l.id = ${head.location_id}
         and l.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!location) throw invalid('location: removed since the import was made')

    // Each day's sales, worked out as the preview showed them.
    const includesVat = business.vatRegistered && head.amounts_include_vat
    const daySales = toPost.flatMap((day) =>
      daySalesOf(day, entriesOf(day.rows, groups)!, products, business, includesVat).map(
        (sale) => ({
          ...sale,
          chargeName: firstNameOf(day.rows, groups, 'charge'),
          deliveryName: firstNameOf(day.rows, groups, 'delivery'),
        }),
      ),
    )

    // What each product sold uses, then lock 3: the materials' cost rows FOR SHARE (sale-costs.ts),
    // then one read of the purchases posted now.
    const sold = [
      ...new Set(
        daySales.flatMap((s) => s.lines.flatMap((l) => (l.productId ? [l.productId] : []))),
      ),
    ].map((id) => products.get(id)!)
    const uses = await itemMaterialsOf(
      tx,
      ctx.businessId,
      sold.map((p) => ({ id: p.id, unit: p.unit, resaleMaterialId: p.resale_material_id })),
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

    // The sales (as drafts first: their lines are written while they are drafts), their lines with
    // the cost of what was sold frozen on their day, their materials; then finalized together.
    const saleRows: NewSale[] = []
    const lineRows: SaleLineRow[] = []
    const materials: ReturnType<typeof materialRows> = []
    for (const sale of daySales) {
      const saleId = newId()
      const { amounts } = sale
      saleRows.push({
        id: saleId,
        businessId: ctx.businessId,
        source: 'import',
        businessDate: sale.day.day,
        periodFrom: sale.day.periodFrom,
        locationId: head.location_id,
        channelId: head.channel_id,
        vatRegistered: business.vatRegistered,
        currency: business.currency,
        subtotal: sumDecimals(amounts.lines.map((l) => l.subtotal)),
        discountTotal: sumDecimals([
          ...amounts.lines.map((l) => l.discount),
          amounts.documentDiscount,
        ]),
        netTotal: amounts.net,
        vatTotal: amounts.vat,
        total: amounts.total,
        deliveryNeeded: sale.lines.some((l) => l.kind === 'delivery'),
        importId: head.id,
      })
      sale.lines.forEach((line, position) => {
        const a = amounts.lines[position]!
        const lineId = newId()
        let costs: ReturnType<typeof lineCostColumns> = {
          costBasis: 'none',
          cost: null,
          timeMinutes: null,
          timeCost: null,
        }
        const product = line.productId === null ? null : products.get(line.productId)!
        if (product) {
          const ownerTime: OwnerTimePart = ctx.access.capabilities.has_team
            ? { state: 'team' }
            : { state: 'solo', minutes: product.owner_minutes, hourlyRate }
          const snapshot = saleLineCost({
            qty: line.qty,
            day: sale.day.day,
            materials: uses.get(product.id) ?? { basis: 'none' },
            purchases,
            ownerTime,
          })
          materials.push(...materialRows(ctx.businessId, saleId, lineId, snapshot))
          costs = lineCostColumns(snapshot)
        }
        const description = product
          ? product.name
          : line.kind === 'charge'
            ? (sale.chargeName ?? sale.deliveryName)
            : sale.deliveryName
        lineRows.push({
          id: lineId,
          sale_id: saleId,
          position: String(position),
          kind: line.kind,
          product_id: line.productId,
          description,
          qty: line.qty,
          unit: product ? product.unit : null,
          unit_price: line.unitPrice,
          price_includes_vat: a.priceIncludesVat,
          discount_amount: line.discountAmount,
          vat_category: a.vatCategory,
          vat_rate: a.vatRate,
          subtotal: a.subtotal,
          discount: a.discount,
          net: a.net,
          vat: a.vat,
          total: a.total,
          cost_basis: costs.costBasis,
          cost: costs.cost,
          time_minutes: costs.timeMinutes,
          time_cost: costs.timeCost,
        })
      })
    }
    await tx.insert(sales).values(saleRows)
    await insertSaleLines(tx, ctx.businessId, lineRows)
    await insertMaterialRows(tx, materials)
    await tx.execute(sql`
      update app.sales
         set status = 'posted', posted_at = now(), posted_by = app.current_user_id()
       where business_id = ${ctx.businessId}
         and id = any(${uuidArray(saleRows.map((s) => s.id))})
    `)

    // "Replace": the earlier imports' sales of these days are reversed; an import left with none is.
    await reverseSalesIn(
      tx,
      ctx.businessId,
      business,
      replacedSales.map((s) => ({ id: s.id, business_date: s.to_day })),
    )
    await settleReversedImports(tx, ctx, business, [
      ...new Set(replacedSales.map((s) => s.import_id)),
    ])

    // The fee column: the channel's statement for the file's days (Q8, B9).
    if (head.fees_total !== null) {
      try {
        await tx.execute(sql`
          insert into app.channel_statements
                 (id, business_id, channel_id, period_from, period_to, sales, commission, status,
                  posted_at, posted_by, import_id)
          values (${newId()}, ${ctx.businessId}, ${head.channel_id}, ${head.period_from}::date,
                  ${head.period_to}::date,
                  ${sumDecimals(saleRows.map((s) => s.netTotal ?? '0'))}::numeric,
                  ${head.fees_total}::numeric, 'posted', now(), app.current_user_id(), ${head.id})
        `)
      } catch (error) {
        if (sqlStateOf(error) === '23P01') {
          throw new AppError('statement_overlap', { cause: error })
        }
        throw error
      }
    }

    // The import: finalized, the days it replaced and skipped kept, its staged rows cleared.
    const replacedDays = [...new Set(replacedSales.map((s) => s.to_day))].sort()
    await tx.execute(sql`
      update app.sale_imports
         set status = 'posted', posted_at = now(), posted_by = app.current_user_id(),
             replaced_days = ${dateArray(replacedDays)},
             skipped_days = ${dateArray(skipped)}
       where business_id = ${ctx.businessId} and id = ${head.id}
    `)
    await tx.execute(sql`
      delete from app.sale_import_rows
       where business_id = ${ctx.businessId} and import_id = ${head.id}
    `)
    return result(await readImport(tx, ctx, input.id))
  })
}

// ---------------------------------------------------------------------------------------------------
// Reversing and lists
// ---------------------------------------------------------------------------------------------------

/**
 * `saleImport.reverse`: the whole import (`day` null) or one of its days. Each sale as `sale.reverse`
 * does it, with its key (sales.documents.reverse, which needs to see every sale: the router checks it
 * too); an import with no finalized day left is reversed (see settleReversedImports). Idempotent.
 */
export function reverseImport(ctx: BusinessCtx, input: ReverseInput): Promise<SaleImportResultDto> {
  assertMayReverse(ctx)
  return ctx.tx(async (tx) => {
    const head = await importRecord(tx, ctx, input.id, true)
    if (head.status === 'draft') throw new AppError('document_not_posted')
    if (head.status === 'reversed') return result(await readImport(tx, ctx, input.id))
    const list = (await tx.execute(sql`
      select s.id, s.business_date::text as business_date
        from app.sales s
       where s.business_id = ${ctx.businessId} and s.import_id = ${input.id}
         and s.deleted_at is null and s.status = 'posted'
         ${input.day === null ? sql`` : sql`and s.business_date = ${input.day}::date`}
       order by s.id
         for update
    `)) as unknown as { id: string; business_date: string }[]
    if (input.day !== null && list.length === 0) throw new AppError('not_found')
    const business = await lockPostingBusiness(tx, ctx.businessId)
    await reverseSalesIn(tx, ctx.businessId, business, list)
    await settleReversedImports(tx, ctx, business, [input.id])
    return result(await readImport(tx, ctx, input.id))
  })
}

interface ListRecord extends Record<string, unknown> {
  id: string
  status: SaleImportStatus
  file_name: string
  channel_id: string
  channel_name: string
  location_id: string
  location_name: string
  shape: ImportShape
  period_from: string
  period_to: string
  rows_read: number
  net_total: string | null
  days_posted: number
  days_reversed: number
  entered_by_name: string | null
  mine: boolean
  created_at: string
  posted_at: Date | string | null
  version: number
}

/** `saleImport.list`: the imports the caller may see, newest first. */
export function listImports(ctx: BusinessCtx, input: ListInput): Promise<ImportListDto> {
  const filters = [
    sql`i.business_id = ${ctx.businessId}`,
    sql`i.deleted_at is null`,
    ...visibleTo(ctx),
  ]
  if (input.status !== 'all') filters.push(sql`i.status = ${input.status}`)
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    if (Number.isNaN(Date.parse(cursor.key))) throw invalid('invalid cursor')
    filters.push(sql`(i.created_at, i.id) < (${cursor.key}::timestamptz, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    const rows = (await tx.execute(sql`
      select i.id, i.status, i.file_name, i.channel_id, c.name as channel_name, i.location_id,
             l.name as location_name, i.shape, i.period_from::text as period_from,
             i.period_to::text as period_to, i.rows_read,
             (select trim_scale(sum(s.net_total))::text from app.sales s
               where s.business_id = i.business_id and s.import_id = i.id
                 and s.status = 'posted' and s.deleted_at is null) as net_total,
             (select count(distinct d.day)::int from app.sales s
                cross join lateral generate_series(coalesce(s.period_from, s.business_date),
                                                   s.business_date, interval '1 day') as d(day)
               where s.business_id = i.business_id and s.import_id = i.id
                 and s.status = 'posted' and s.deleted_at is null) as days_posted,
             (select count(distinct d.day)::int from app.sales s
                cross join lateral generate_series(coalesce(s.period_from, s.business_date),
                                                   s.business_date, interval '1 day') as d(day)
               where s.business_id = i.business_id and s.import_id = i.id
                 and s.status = 'reversed' and s.deleted_at is null) as days_reversed,
             ${enteredByName} as entered_by_name,
             i.created_by = app.current_user_id() as mine,
             to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               as created_at,
             i.posted_at, i.version
        from app.sale_imports i
        join app.sales_channels c on c.business_id = i.business_id and c.id = i.channel_id
        join app.locations l on l.business_id = i.business_id and l.id = i.location_id
       where ${where(filters)}
       order by i.created_at desc, i.id desc
       limit ${input.limit + 1}
    `)) as unknown as ListRecord[]
    const items = rows.slice(0, input.limit)
    const last = items.at(-1)
    const team = ctx.access.capabilities.has_team
    return {
      items: items.map((r) => ({
        id: r.id,
        status: r.status,
        fileName: r.file_name,
        channelId: r.channel_id,
        channelName: r.channel_name,
        locationId: r.location_id,
        locationName: r.location_name,
        shape: r.shape,
        periodFrom: r.period_from,
        periodTo: r.period_to,
        rowsRead: r.rows_read,
        netTotal: r.status === 'draft' || !(seesAll(ctx) || r.mine) ? null : (r.net_total ?? '0'),
        daysPosted: r.days_posted,
        daysReversed: r.days_reversed,
        enteredByName: team ? r.entered_by_name : null,
        mine: r.mine,
        createdAt: isoOf(r.created_at),
        postedAt: isoOf(r.posted_at),
        version: r.version,
      })),
      // The cursor keeps the microseconds of created_at (an ISO string from JS keeps only ms).
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: last.created_at, id: last.id })
          : null,
    }
  })
}

/** `importProfile.list`: the layouts remembered (the general importer's), the latest used first. */
export function listImportProfiles(ctx: BusinessCtx): Promise<ImportProfileListDto> {
  return ctx.tx(async (tx) => {
    const rows = (await tx.execute(sql`
      select p.id, trim(p.fingerprint) as fingerprint, p.mapping, p.last_used_at
        from app.import_profiles p
       where p.business_id = ${ctx.businessId} and p.source = ${IMPORT_SOURCE_FILE}
         and p.deleted_at is null
       order by p.last_used_at desc, p.id
       limit 200
    `)) as unknown as {
      id: string
      fingerprint: string
      mapping: ImportMappingDto
      last_used_at: Date | string
    }[]
    return {
      items: rows.map((r) => ({
        id: r.id,
        fingerprint: r.fingerprint,
        mapping: r.mapping,
        lastUsedAt: isoOf(r.last_used_at),
      })),
    }
  })
}

/** `importProfile.remove`: a layout is forgotten (soft-deleted); NOT_FOUND when not one. */
export function removeImportProfile(ctx: BusinessCtx, input: ProfileIdInput): Promise<OkDto> {
  return ctx.tx(async (tx) => {
    const removed = (await tx.execute(sql`
      update app.import_profiles set deleted_at = now()
       where business_id = ${ctx.businessId} and id = ${input.id}
         and source = ${IMPORT_SOURCE_FILE} and deleted_at is null
      returning id
    `)) as unknown as { id: string }[]
    if (removed.length === 0) throw new AppError('not_found')
    return { ok: true as const }
  })
}
