import {
  QUOTATION_HISTORY_MAX,
  type acceptQuotationInput,
  type copyQuotationInput,
  type createQuotationInput,
  type declineQuotationInput,
  type OkDto,
  type QuotationDto,
  type QuotationEventKind,
  type QuotationHistoryDto,
  type quotationIdInput,
  type QuotationLineDto,
  type quotationListInput,
  type QuotationListDto,
  type QuotationOrderDto,
  type quotationToOrderInput,
  type quotationVersionInput,
  type reviseQuotationInput,
  type updateQuotationInput,
} from '@bizcost/contracts'
import { quotationLines, quotations, quotationStages, type Tx } from '@bizcost/db'
import {
  groupByArea,
  newId,
  paymentStageAmounts,
  paymentStagesError,
  phoneLast4,
  quotationListStatus,
  quotationTransition,
  type Money,
  type Percent,
  type QuotationAction,
  type QuotationStatus,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertModuleActive, assertPermission } from '../trpc'
import { detachAll } from './attachments'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { resolveCustomer } from './customers'
import {
  copyLinePictures,
  linePictureUrls,
  removeDocumentObjects,
  type PictureCopy,
} from './document-files'
import { takeNumber } from './numbering'
import { insertOrder, visibleOrders, type OrderFields } from './orders'
import { resolveLocation } from './purchases'
import {
  assertInScope,
  discountOf,
  lineValues,
  productsOf,
  roundedAmountsOf,
  saleContextOf,
  toLineDiscount,
  totalsOf,
  type InputLine,
  type PricedLine,
  type StoredVat,
} from './sales'
import { isoOf, uuidArray } from './stock'

// Quotations (ROADMAP.md M3 Step 7; DATA_MODEL.md §6; the owner's answers Q21–Q25 of D-218). Module
// `quotations` (planned until Release B, M3 Step 9: served under the dev-only preview, D-125).
// `quotations.documents.view` sees every quotation of the business, within one's branches (Q12; a
// quotation out of sight is NOT_FOUND, as if it did not exist); `.manage` prepares, sends, revises,
// copies, discards and makes an order of an accepted one; `.decide` records the customer's answer (the
// router checks the keys).
//
// Numbers: a quotation's first revision takes the next number of the series `quotation` (Q-0001…,
// numbering.ts: the counter row is the last lock of its transaction, a replay is answered before a
// number is taken); a discarded draft keeps its number (numbers may skip, Q25). Every revision keeps
// the number: `root_id` is the first revision, `revision` counts up. A draft changes freely (every save
// checks the whole quotation and stores the sales engine's amounts, D-220, with "Round the total",
// D-221, and the payment stages); sending freezes it (the trigger guard_quotation), and the revision
// before it becomes superseded. Accepting and declining record the customer's answer; an accepted
// revision becomes one order (its typed lines stay typed, Q21). Repeated sends, answers and orders
// return the recorded result.
//
// Lock order: the quotation's first revision (FOR UPDATE: every change of one number waits for the
// others), then the revision acted on, then (orders) what order.create locks, the counter last.

type CreateInput = z.output<typeof createQuotationInput>
type UpdateInput = z.output<typeof updateQuotationInput>
type Fields = Omit<CreateInput, 'id'>
type InputQuotationLine = Fields['lines'][number]
type IdInput = z.output<typeof quotationIdInput>
type VersionInput = z.output<typeof quotationVersionInput>
type AcceptInput = z.output<typeof acceptQuotationInput>
type DeclineInput = z.output<typeof declineQuotationInput>
type ReviseInput = z.output<typeof reviseQuotationInput>
type CopyInput = z.output<typeof copyQuotationInput>
type ToOrderInput = z.output<typeof quotationToOrderInput>
type ListInput = z.output<typeof quotationListInput>

const invalid = (message: string) => new AppError('validation', { message })
const where = (parts: readonly SQL[]) => sql.join([...parts], sql` and `)

/**
 * The quotations the caller may see (alias `q`, or `alias`): within their branches when limited
 * (Q12). Every revision is checked on its own: a draft revision moved to another branch is out of
 * sight there, in the revisions and the history too (D-296).
 */
function visible(ctx: BusinessCtx, alias = 'q'): SQL[] {
  const scope = ctx.access.locationScope
  return scope.all ? [] : [sql`${sql.raw(alias)}.location_id = any(${uuidArray([...scope.ids])})`]
}

/** ` and …` for a join: the conditions of `parts`, or nothing. */
const andAll = (parts: readonly SQL[]) =>
  parts.length === 0 ? sql`` : sql` and ${sql.join([...parts], sql` and `)}`

/**
 * The order made from a quotation, joined as `o` only when the caller may see it (Orders' own rules:
 * every order or their own, within their branches); else its number is not shown.
 */
const seenOrder = (ctx: BusinessCtx) => andAll(visibleOrders(ctx))

/** A member's name in the business now (null for a user who is no member). */
const memberName = (user: SQL) => sql`(
  select bm.display_name from app.business_members bm
   where bm.business_id = q.business_id and bm.user_id = ${user} and bm.kind = 'account'
   order by (bm.status = 'active') desc, bm.created_at desc
   limit 1)`

/** Today in the business's time zone. */
const TODAY = sql`(select (now() at time zone b.timezone)::date from app.businesses b
  where b.id = q.business_id)`

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

interface HeadRecord extends Record<string, unknown> {
  id: string
  root_id: string
  seq: number
  number: string
  revision: number
  status: QuotationStatus
  customer_id: string
  customer_name: string
  customer_phone: string | null
  location_id: string
  location_name: string
  business_date: string
  valid_until: string | null
  customer_ref: string | null
  site: string | null
  vat_registered: boolean
  currency: string
  discount_percent: string | null
  discount_amount: string | null
  round_to: string | null
  adjustment: string
  rounding_difference: string
  subtotal: string
  discount_total: string
  net_total: string
  vat_total: string
  total: string
  payable: string
  vat_rates: QuotationDto['vatRates']
  greeting: string | null
  intro: string | null
  terms: string | null
  notes: string | null
  sent_at: Date | string | null
  accepted_at: Date | string | null
  accept_note: string | null
  declined_at: Date | string | null
  decline_reason: string | null
  superseded_at: Date | string | null
  order_id: string | null
  order_number: string | null
  copied_from_id: string | null
  copied_from_number: string | null
  latest: boolean
  other_has_order: boolean
  today: string
  entered_by_name: string | null
  mine: boolean
  created_at: Date | string
  updated_at: Date | string
  version: number
}

export interface LineRecord extends Record<string, unknown> {
  id: string
  position: number
  product_id: string | null
  area: string | null
  description: string
  details: string | null
  note: string | null
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
  picture_id: string | null
  picture_path: string | null
  picture_name: string | null
  picture_type: string | null
  picture_size: number | null
}

export interface StageRecord extends Record<string, unknown> {
  id: string
  label: string | null
  due: string
  percent: string
  amount: string
}

const HEAD_COLUMNS = sql`
  q.id, q.root_id, q.seq, q.number, q.revision, q.status, q.customer_id, cu.name as customer_name,
  cu.phone as customer_phone, q.location_id, l.name as location_name,
  q.business_date::text as business_date, q.valid_until::text as valid_until, q.customer_ref, q.site,
  q.vat_registered, trim(q.currency) as currency,
  trim_scale(q.discount_percent)::text as discount_percent,
  trim_scale(q.discount_amount)::text as discount_amount, trim_scale(q.round_to)::text as round_to,
  trim_scale(q.adjustment)::text as adjustment,
  trim_scale(q.rounding_difference)::text as rounding_difference,
  trim_scale(q.subtotal)::text as subtotal, trim_scale(q.discount_total)::text as discount_total,
  trim_scale(q.net_total)::text as net_total, trim_scale(q.vat_total)::text as vat_total,
  trim_scale(q.total)::text as total, trim_scale(q.payable)::text as payable, q.vat_rates,
  q.greeting, q.intro, q.terms, q.notes, q.sent_at, q.accepted_at, q.accept_note, q.declined_at,
  q.decline_reason, q.superseded_at, q.order_id, o.number as order_number, q.copied_from_id,
  cf.number as copied_from_number,
  not exists (select 1 from app.quotations r
               where r.business_id = q.business_id and r.root_id = q.root_id
                 and r.revision > q.revision and r.deleted_at is null) as latest,
  exists (select 1 from app.quotations r
           where r.business_id = q.business_id and r.root_id = q.root_id and r.id <> q.id
             and r.order_id is not null) as other_has_order,
  ${TODAY}::text as today, ${memberName(sql`q.created_by`)} as entered_by_name,
  q.created_by = app.current_user_id() as mine, q.created_at, q.updated_at, q.version`

async function headOf(tx: Tx, ctx: BusinessCtx, id: string): Promise<HeadRecord> {
  const [head] = (await tx.execute(sql`
    select ${HEAD_COLUMNS}
      from app.quotations q
      join app.customers cu on cu.business_id = q.business_id and cu.id = q.customer_id
      join app.locations l on l.business_id = q.business_id and l.id = q.location_id
      left join app.orders o on o.business_id = q.business_id and o.id = q.order_id ${seenOrder(ctx)}
      left join app.quotations cf on cf.business_id = q.business_id and cf.id = q.copied_from_id
                ${andAll(visible(ctx, 'cf'))}
     where ${where([
       sql`q.business_id = ${ctx.businessId}`,
       sql`q.id = ${id}`,
       sql`q.deleted_at is null`,
       ...visible(ctx),
     ])}
  `)) as unknown as HeadRecord[]
  if (!head) throw new AppError('not_found')
  return head
}

/** A revision's live lines, in order, each with its picture (its first image attachment). */
export async function linesOf(tx: Tx, businessId: string, quotationId: string) {
  return (await tx.execute(sql`
    select l.id, l.position, l.product_id, l.area, l.description, l.details, l.note,
           trim_scale(l.qty)::text as qty, l.unit, trim_scale(l.unit_price)::text as unit_price,
           l.price_includes_vat, trim_scale(l.discount_percent)::text as discount_percent,
           trim_scale(l.discount_amount)::text as discount_amount, l.vat_category,
           trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.subtotal)::text as subtotal,
           trim_scale(l.discount)::text as discount, trim_scale(l.net)::text as net,
           trim_scale(l.vat)::text as vat, trim_scale(l.total)::text as total,
           p.id as picture_id, p.path as picture_path, p.file_name as picture_name,
           p.content_type as picture_type, p.size_bytes as picture_size
      from app.quotation_lines l
      left join lateral (
        select a.id, a.path, a.file_name, a.content_type, a.size_bytes from app.attachments a
         where a.business_id = l.business_id and a.entity = 'quotation_line' and a.entity_id = l.id
           and a.deleted_at is null
         order by a.created_at, a.id
         limit 1
      ) p on true
     where l.business_id = ${businessId} and l.quotation_id = ${quotationId} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as LineRecord[]
}

export async function stagesOf(tx: Tx, businessId: string, quotationId: string) {
  return (await tx.execute(sql`
    select s.id, s.label, s.due, trim_scale(s.percent)::text as percent,
           trim_scale(s.amount)::text as amount
      from app.quotation_stages s
     where s.business_id = ${businessId} and s.quotation_id = ${quotationId}
       and s.deleted_at is null
     order by s.position, s.id
  `)) as unknown as StageRecord[]
}

interface ReadQuotation {
  readonly dto: QuotationDto
  /** The lines' picture paths (the caller signs them once the transaction is over). */
  readonly picturePaths: readonly string[]
}

/** The revision as the API returns it (its pictures' URLs still unsigned): NOT_FOUND unless seen. */
async function readQuotation(tx: Tx, ctx: BusinessCtx, id: string): Promise<ReadQuotation> {
  const head = await headOf(tx, ctx, id)
  const lines = await linesOf(tx, ctx.businessId, id)
  const stages = await stagesOf(tx, ctx.businessId, id)
  const revisions = (await tx.execute(sql`
    select q.id, q.revision, q.status, q.business_date::text as business_date, q.sent_at,
           trim_scale(q.payable)::text as payable
      from app.quotations q
     where ${where([
       sql`q.business_id = ${ctx.businessId}`,
       sql`q.root_id = ${head.root_id}`,
       sql`q.deleted_at is null`,
       ...visible(ctx),
     ])}
     order by q.revision
  `)) as unknown as {
    id: string
    revision: number
    status: QuotationStatus
    business_date: string
    sent_at: Date | string | null
    payable: string
  }[]
  const team = ctx.access.capabilities.has_team
  const dto: QuotationDto = {
    id: head.id,
    rootId: head.root_id,
    number: head.number,
    seq: head.seq,
    revision: head.revision,
    status: head.status,
    listStatus: quotationListStatus(head.status, head.valid_until, head.today),
    latest: head.latest,
    customerId: head.customer_id,
    customerName: head.customer_name,
    customerPhoneLast4: phoneLast4(head.customer_phone),
    locationId: head.location_id,
    locationName: head.location_name,
    businessDate: head.business_date,
    validUntil: head.valid_until,
    customerRef: head.customer_ref,
    site: head.site,
    vatRegistered: head.vat_registered,
    currency: head.currency,
    discount: discountOf(head.discount_percent, head.discount_amount),
    roundTo: head.round_to,
    adjustment: head.adjustment,
    roundingDifference: head.rounding_difference,
    subtotal: head.subtotal,
    discountTotal: head.discount_total,
    netTotal: head.net_total,
    vatTotal: head.vat_total,
    total: head.total,
    payable: head.payable,
    vatRates: head.vat_rates,
    greeting: head.greeting,
    intro: head.intro,
    terms: head.terms,
    notes: head.notes,
    lines: lines.map((l): QuotationLineDto => ({
      id: l.id,
      productId: l.product_id,
      typed: l.product_id === null,
      area: l.area,
      description: l.description,
      details: l.details,
      note: l.note,
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
      picture:
        l.picture_id === null
          ? null
          : { id: l.picture_id, fileName: l.picture_name ?? '', url: l.picture_path },
    })),
    stages: stages.map((s) => ({
      id: s.id,
      label: s.label,
      due: s.due,
      percent: s.percent,
      amount: s.amount,
    })),
    revisions: revisions.map((r) => ({
      id: r.id,
      revision: r.revision,
      status: r.status,
      businessDate: r.business_date,
      sentAt: isoOf(r.sent_at),
      payable: r.payable,
    })),
    sentAt: isoOf(head.sent_at),
    acceptedAt: isoOf(head.accepted_at),
    acceptNote: head.accept_note,
    declinedAt: isoOf(head.declined_at),
    declineReason: head.decline_reason,
    supersededAt: isoOf(head.superseded_at),
    orderId: head.order_id,
    orderNumber: head.order_number,
    otherHasOrder: head.other_has_order,
    copiedFromId: head.copied_from_id,
    copiedFromNumber: head.copied_from_number,
    enteredByName: team ? head.entered_by_name : null,
    mine: head.mine,
    createdAt: isoOf(head.created_at),
    version: head.version,
  }
  return {
    dto,
    picturePaths: lines.flatMap((l) => (l.picture_path ? [l.picture_path] : [])),
  }
}

/** Signs the lines' picture URLs (after the transaction: Storage is never called inside one). */
async function signed(ctx: BusinessCtx, read: ReadQuotation): Promise<QuotationDto> {
  const urls = await linePictureUrls(ctx, read.picturePaths)
  return {
    ...read.dto,
    lines: read.dto.lines.map((line) =>
      line.picture
        ? { ...line, picture: { ...line.picture, url: urls.get(line.picture.url ?? '') ?? null } }
        : line,
    ),
  }
}

/** `quotation.get`. */
export async function getQuotation(ctx: BusinessCtx, input: IdInput): Promise<QuotationDto> {
  return signed(ctx, await ctx.tx((tx) => readQuotation(tx, ctx, input.id)))
}

/** The list's order (one text, ascending): newest date first, then the highest number. */
const SORT_KEY = sql`(99999999 - to_char(q.business_date, 'YYYYMMDD')::int)::text || '|'
  || lpad((999999999999 - q.seq)::text, 12, '0')`

/**
 * `quotation.list`: the latest revision of each quotation (a draft revision counts), newest first; the
 * status filter (expired: sent and past its validity, today in the business's time zone); a search in
 * the number, the customer's reference and the customer's name.
 */
export function listQuotations(ctx: BusinessCtx, input: ListInput): Promise<QuotationListDto> {
  const filters: SQL[] = [
    sql`q.business_id = ${ctx.businessId}`,
    sql`q.deleted_at is null`,
    sql`not exists (select 1 from app.quotations r
          where r.business_id = q.business_id and r.root_id = q.root_id
            and r.revision > q.revision and r.deleted_at is null)`,
    ...visible(ctx),
  ]
  if (input.status === 'expired') {
    filters.push(sql`q.status = 'sent' and q.valid_until < ${TODAY}`)
  } else if (input.status === 'sent') {
    filters.push(sql`q.status = 'sent' and (q.valid_until is null or q.valid_until >= ${TODAY})`)
  } else if (input.status !== 'all') {
    filters.push(sql`q.status = ${input.status}`)
  }
  if (input.customerId) filters.push(sql`q.customer_id = ${input.customerId}`)
  if (input.search) {
    const pattern = containsPattern(input.search)
    filters.push(sql`(q.number ilike ${pattern} or q.customer_ref ilike ${pattern}
      or cu.name ilike ${pattern})`)
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    filters.push(sql`(${SORT_KEY}, q.id) > (${cursor.key}, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    if (input.customerId) {
      const [customer] = (await tx.execute(sql`
        select c.id from app.customers c
         where c.business_id = ${ctx.businessId} and c.id = ${input.customerId}
           and c.deleted_at is null
      `)) as unknown as { id: string }[]
      if (!customer) throw new AppError('not_found')
    }
    const rows = (await tx.execute(sql`
      select ${SORT_KEY} as sort_key, q.id, q.root_id, q.number, q.revision, q.status,
             q.customer_id, cu.name as customer_name, q.customer_ref, q.site,
             q.business_date::text as business_date, q.valid_until::text as valid_until,
             trim(q.currency) as currency, trim_scale(q.payable)::text as payable,
             (select count(*)::int from app.quotation_lines l
               where l.business_id = q.business_id and l.quotation_id = q.id
                 and l.deleted_at is null) as line_count,
             array(select l.description from app.quotation_lines l
                    where l.business_id = q.business_id and l.quotation_id = q.id
                      and l.deleted_at is null
                    order by l.position, l.id limit 2) as line_titles,
             q.order_id, ${memberName(sql`q.created_by`)} as entered_by_name,
             q.created_by = app.current_user_id() as mine, q.version, ${TODAY}::text as today
        from app.quotations q
        join app.customers cu on cu.business_id = q.business_id and cu.id = q.customer_id
       where ${where(filters)}
       order by ${SORT_KEY}, q.id
       limit ${input.limit + 1}
    `)) as unknown as {
      sort_key: string
      id: string
      root_id: string
      number: string
      revision: number
      status: QuotationStatus
      customer_id: string
      customer_name: string
      customer_ref: string | null
      site: string | null
      business_date: string
      valid_until: string | null
      currency: string
      payable: string
      line_count: number
      line_titles: string[]
      order_id: string | null
      entered_by_name: string | null
      mine: boolean
      version: number
      today: string
    }[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    const team = ctx.access.capabilities.has_team
    return {
      items: page.map((r) => ({
        id: r.id,
        rootId: r.root_id,
        number: r.number,
        revision: r.revision,
        status: r.status,
        listStatus: quotationListStatus(r.status, r.valid_until, r.today),
        customerId: r.customer_id,
        customerName: r.customer_name,
        customerRef: r.customer_ref,
        site: r.site,
        businessDate: r.business_date,
        validUntil: r.valid_until,
        currency: r.currency,
        payable: r.payable,
        lineCount: r.line_count,
        lineTitles: r.line_titles,
        orderId: r.order_id,
        enteredByName: team ? r.entered_by_name : null,
        mine: r.mine,
        version: r.version,
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: last.sort_key, id: last.id })
          : null,
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// Drafts: their checks and amounts
// ---------------------------------------------------------------------------------------------------

/** What a save keeps of the revision it changes. */
interface Stored {
  readonly customerId: string
  readonly productIds: ReadonlySet<string>
  readonly validUntil: string | null
  readonly terms: string | null
  readonly vatRegistered: boolean
  /** Each kept line's VAT basis as saved, used while the VAT registration is the same (send). */
  readonly vat?: ReadonlyMap<string, StoredVat>
}

/** The business's settings a new quotation starts from. */
interface QuotationDefaults {
  readonly validDays: number
  readonly terms: string | null
}

async function defaultsOf(tx: Tx, businessId: string): Promise<QuotationDefaults> {
  const [row] = (await tx.execute(sql`
    select b.quotation_valid_days, b.quotation_terms from app.businesses b where b.id = ${businessId}
  `)) as unknown as { quotation_valid_days: number; quotation_terms: string | null }[]
  return { validDays: row?.quotation_valid_days ?? 30, terms: row?.quotation_terms ?? null }
}

/** YYYY-MM-DD + `days`. */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Checks a quotation's day, customer, location and products, and works out its amounts (the sales
 * engine with the discount and "Round the total") and its payment stages. Returns the columns of the
 * quotation, of each line and of each stage. Its day is never after today (FUTURE_DATE); its customer a
 * live one of the business (an archived one only when it already has it, VALIDATION); a line's product
 * the business's (NOT_FOUND; an archived one only when it already has it); a typed line's "price
 * includes VAT" needs VAT registration (CAPABILITY_DISABLED); stages add up to 100 % (VALIDATION).
 * Its lines are saved with each area's lines together (D-299: groupByArea, the areas in the order
 * each first comes), so the PDF's area cell spans exactly the lines of its area.
 */
async function prepareQuotation(
  tx: Tx,
  ctx: BusinessCtx,
  sent: Fields,
  stored: Stored | null,
  defaults: QuotationDefaults | null,
) {
  const input: Fields = { ...sent, lines: groupByArea(sent.lines) }
  const biz = await saleContextOf(tx, ctx.businessId)
  if (input.businessDate > biz.today) throw new AppError('future_date')
  // A typed line's VAT is as typed: without VAT registration only a plain price (D-121, D-206).
  if (
    !biz.vatRegistered &&
    input.lines.some(
      (l) => l.productId === null && (l.priceIncludesVat || l.vatCategory !== 'standard'),
    )
  ) {
    throw new AppError('capability_disabled', { message: 'VAT needs a VAT-registered business' })
  }
  assertModuleActive(ctx, 'customers')
  const customerId = await resolveCustomer(
    tx,
    ctx.businessId,
    input.customerId,
    stored?.customerId ?? null,
  )
  if (customerId === null) throw invalid('customerId: required')
  const locationId = await resolveLocation(tx, ctx, input.locationId, biz.defaultLocationId)
  assertInScope(ctx, locationId)
  const productLines = input.lines.filter((l) => l.productId !== null)
  if (productLines.length > 0) assertModuleActive(ctx, 'products')
  const products = await productsOf(
    tx,
    ctx.businessId,
    productLines.map((l) => l.productId!),
  )
  for (const line of productLines) {
    const product = products.get(line.productId!)
    if (!product) throw new AppError('not_found')
    if (product.archived && !stored?.productIds.has(product.id)) {
      throw invalid('lines: a product was archived')
    }
  }
  const sameRegistration = stored !== null && stored.vatRegistered === biz.vatRegistered
  const priced: PricedLine[] = input.lines.map((line) => {
    if (line.productId === null) {
      return {
        line: {
          kind: 'typed',
          id: line.id,
          description: line.description ?? '',
          qty: line.qty,
          unit: line.unit,
          unitPrice: line.unitPrice,
          priceIncludesVat: line.priceIncludesVat,
          vatCategory: line.vatCategory,
          discount: line.discount,
        },
        product: null,
      }
    }
    return {
      line: {
        kind: 'item',
        id: line.id,
        productId: line.productId,
        description: line.description,
        qty: line.qty,
        unitPrice: line.unitPrice,
        discount: line.discount,
      },
      product: products.get(line.productId) ?? null,
      vat: sameRegistration ? stored.vat?.get(line.id) : undefined,
    }
  })
  const { amounts, adjustment, roundingDifference } = roundedAmountsOf(
    priced,
    biz.vatRegistered,
    biz.currency,
    toLineDiscount(input.discount),
    input.roundTo,
  )
  const payable = amounts?.payable ?? '0'
  const stageError = paymentStagesError(input.stages.map((s) => s.percent as Percent))
  if (stageError) throw invalid(`stages: ${stageError.code}`)
  const stageAmounts = paymentStageAmounts(
    payable as Money,
    input.stages.map((s) => s.percent as Percent),
    biz.currency,
  )
  const validUntil =
    input.validUntil !== undefined
      ? input.validUntil
      : stored
        ? stored.validUntil
        : addDays(input.businessDate, defaults?.validDays ?? 30)
  if (validUntil !== null && validUntil < input.businessDate) {
    throw invalid('validUntil: before the quotation’s date')
  }
  const header = {
    customerId,
    locationId,
    businessDate: input.businessDate,
    validUntil,
    customerRef: input.customerRef,
    site: input.site,
    vatRegistered: biz.vatRegistered,
    currency: biz.currency,
    discountPercent: input.discount && 'percent' in input.discount ? input.discount.percent : null,
    discountAmount: input.discount && 'amount' in input.discount ? input.discount.amount : null,
    roundTo: input.roundTo,
    adjustment,
    roundingDifference,
    ...totalsOf(amounts),
    payable,
    vatRates: biz.vatRegistered && amounts ? amounts.rates.map((r) => ({ ...r })) : [],
    greeting: input.greeting,
    intro: input.intro,
    terms:
      input.terms !== undefined ? input.terms : stored ? stored.terms : (defaults?.terms ?? null),
    notes: input.notes,
  }
  const lines = lineValues(ctx.businessId, priced, amounts, biz.vatRegistered).map((line, i) => {
    const source = input.lines[i]!
    return {
      id: line.id!,
      businessId: ctx.businessId,
      position: i,
      productId: line.productId ?? null,
      area: source.area,
      description: line.description ?? source.description ?? '',
      details: source.details,
      note: source.note,
      qty: line.qty,
      unit: line.unit ?? null,
      unitPrice: line.unitPrice,
      priceIncludesVat: line.priceIncludesVat ?? false,
      discountPercent: line.discountPercent ?? null,
      discountAmount: line.discountAmount ?? null,
      vatCategory: line.vatCategory ?? null,
      vatRate: line.vatRate ?? null,
      subtotal: line.subtotal ?? '0',
      discount: line.discount ?? '0',
      net: line.net ?? '0',
      vat: line.vat ?? '0',
      total: line.total ?? '0',
    }
  })
  const stages = input.stages.map((stage, i) => ({
    id: newId(),
    businessId: ctx.businessId,
    position: i,
    label: stage.label,
    due: stage.due ?? '',
    percent: stage.percent,
    amount: stageAmounts[i]!,
  }))
  return { header, lines, stages }
}

/** A revision's saved lines and stages as a quotation's input (send, revise, copy). */
function fieldsOf(
  head: HeadRecord,
  lines: readonly LineRecord[],
  stages: readonly StageRecord[],
): Fields {
  return {
    customerId: head.customer_id,
    locationId: head.location_id,
    businessDate: head.business_date,
    validUntil: head.valid_until,
    customerRef: head.customer_ref,
    site: head.site,
    discount: discountOf(head.discount_percent, head.discount_amount),
    roundTo: head.round_to,
    greeting: head.greeting,
    intro: head.intro,
    terms: head.terms,
    notes: head.notes,
    lines: lines.map((l): InputQuotationLine => ({
      id: l.id,
      productId: l.product_id,
      area: l.area,
      description: l.description,
      details: l.details,
      note: l.note,
      qty: l.qty,
      unit: l.unit,
      unitPrice: l.unit_price,
      priceIncludesVat: l.price_includes_vat,
      vatCategory: l.vat_category ?? 'standard',
      discount: discountOf(l.discount_percent, l.discount_amount),
    })),
    stages: stages.map((s) => ({ label: s.label, due: s.due, percent: s.percent })),
  }
}

/** Each saved product line's VAT basis (a send keeps what the member saw). */
function storedVatOf(lines: readonly LineRecord[]): Map<string, StoredVat> {
  return new Map(
    lines
      .filter((l) => l.product_id !== null)
      .map((l) => [
        l.id,
        { priceIncludesVat: l.price_includes_vat, vatCategory: l.vat_category ?? 'standard' },
      ]),
  )
}

/** The create's fingerprint: every field as sent. */
function hashOf(input: object): string {
  const rest: Record<string, unknown> = { ...input }
  delete rest.id
  return requestHashOf(rest)
}

/** Answers a replayed create of `id` (one made by this caller with the same payload), else null. */
async function replayed(
  tx: Tx,
  ctx: BusinessCtx,
  id: string,
  requestHash: string,
): Promise<ReadQuotation | null> {
  await tx.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`quotation:${id}`}, 0))
  `)
  const [existing] = (await tx.execute(sql`
    select q.request_hash, q.created_by = app.current_user_id() as mine,
           q.deleted_at is not null as discarded
      from app.quotations q where q.business_id = ${ctx.businessId} and q.id = ${id}
  `)) as unknown as { request_hash: string | null; mine: boolean; discarded: boolean }[]
  if (!existing) return null
  if (existing.request_hash !== requestHash || !existing.mine || existing.discarded) {
    throw new AppError('conflict')
  }
  return readQuotation(tx, ctx, id)
}

/**
 * `quotation.create` (quotations.documents.manage): a draft numbered Q-0001…, idempotent on the
 * client's id (a replay is answered before a number is taken; an id used otherwise is CONFLICT). Its
 * validity and terms start from the business's (Settings → Documents) unless given.
 */
export async function createQuotation(ctx: BusinessCtx, input: CreateInput): Promise<QuotationDto> {
  const { id, ...fields } = input
  const requestHash = hashOf(input)
  const read = await ctx.tx(async (tx) => {
    const replay = await replayed(tx, ctx, id, requestHash)
    if (replay) return replay
    const defaults = await defaultsOf(tx, ctx.businessId)
    const { header, lines, stages } = await prepareQuotation(tx, ctx, fields, null, defaults)
    const { seq, number } = await takeNumber(tx, ctx.businessId, 'quotation')
    await tx.insert(quotations).values({
      id,
      businessId: ctx.businessId,
      seq,
      number,
      rootId: id,
      revision: 1,
      status: 'draft',
      ...header,
      requestHash,
    })
    await insertChildren(tx, id, lines, stages)
    return readQuotation(tx, ctx, id)
  })
  return signed(ctx, read)
}

async function insertChildren(
  tx: Tx,
  quotationId: string,
  lines: readonly Omit<typeof quotationLines.$inferInsert, 'quotationId'>[],
  stages: readonly Omit<typeof quotationStages.$inferInsert, 'quotationId'>[],
) {
  if (lines.length > 0) {
    await tx.insert(quotationLines).values(lines.map((line) => ({ ...line, quotationId })))
  }
  if (stages.length > 0) {
    await tx.insert(quotationStages).values(stages.map((stage) => ({ ...stage, quotationId })))
  }
}

// ---------------------------------------------------------------------------------------------------
// Locks and transitions
// ---------------------------------------------------------------------------------------------------

/**
 * The revision `id`, after its quotation's first revision (FOR UPDATE: changes of one number wait for
 * each other) and the revision itself are locked; NOT_FOUND when not live or not in the caller's
 * branches.
 */
async function lockRevision(tx: Tx, ctx: BusinessCtx, id: string): Promise<HeadRecord> {
  const [found] = (await tx.execute(sql`
    select q.root_id from app.quotations q
     where ${where([
       sql`q.business_id = ${ctx.businessId}`,
       sql`q.id = ${id}`,
       sql`q.deleted_at is null`,
       ...visible(ctx),
     ])}
  `)) as unknown as { root_id: string }[]
  if (!found) throw new AppError('not_found')
  await tx.execute(sql`
    select 1 from app.quotations q
     where q.business_id = ${ctx.businessId} and q.id = ${found.root_id} for update
  `)
  await tx.execute(sql`
    select 1 from app.quotations q where q.business_id = ${ctx.businessId} and q.id = ${id} for update
  `)
  return headOf(tx, ctx, id)
}

function transition(action: QuotationAction, head: HeadRecord) {
  const result = quotationTransition(action, {
    status: head.status,
    latest: head.latest,
    hasOrder: head.order_id !== null,
    otherHasOrder: head.other_has_order,
  })
  if (!result.ok) throw new AppError(result.refusal)
  return result
}

const byId = (businessId: string, id: string) =>
  and(eq(quotations.businessId, businessId), eq(quotations.id, id))

/** Writes a draft's lines (matched by id: new ones added, changed ones updated, missing ones taken
 * out with their pictures) and replaces its stages. Returns the paths of pictures taken off. */
async function writeChildren(
  tx: Tx,
  businessId: string,
  quotationId: string,
  lines: Awaited<ReturnType<typeof prepareQuotation>>['lines'],
  stages: Awaited<ReturnType<typeof prepareQuotation>>['stages'],
): Promise<string[]> {
  const live = (await tx.execute(sql`
    select l.id from app.quotation_lines l
     where l.business_id = ${businessId} and l.quotation_id = ${quotationId} and l.deleted_at is null
  `)) as unknown as { id: string }[]
  const liveIds = new Set(live.map((l) => l.id))
  const kept = new Set(lines.map((l) => l.id))
  const removed = [...liveIds].filter((lineId) => !kept.has(lineId))
  const paths: string[] = []
  for (const lineId of removed) {
    paths.push(...(await detachAll(tx, businessId, 'quotation_line', lineId)))
  }
  if (removed.length > 0) {
    await tx
      .update(quotationLines)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(quotationLines.businessId, businessId),
          eq(quotationLines.quotationId, quotationId),
          inArray(quotationLines.id, removed),
        ),
      )
  }
  const added = lines.filter((line) => !liveIds.has(line.id))
  if (added.length > 0) {
    await tx.insert(quotationLines).values(added.map((line) => ({ ...line, quotationId })))
  }
  for (const line of lines.filter((l) => liveIds.has(l.id))) {
    const values: Partial<typeof line> = { ...line }
    delete values.id
    delete values.businessId
    await tx
      .update(quotationLines)
      .set(values)
      .where(
        and(
          eq(quotationLines.businessId, businessId),
          eq(quotationLines.quotationId, quotationId),
          eq(quotationLines.id, line.id),
        ),
      )
  }
  await tx
    .update(quotationStages)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(quotationStages.businessId, businessId),
        eq(quotationStages.quotationId, quotationId),
        sql`${quotationStages.deletedAt} is null`,
      ),
    )
  if (stages.length > 0) {
    await tx.insert(quotationStages).values(stages.map((stage) => ({ ...stage, quotationId })))
  }
  return paths
}

/**
 * `quotation.update` (a draft): the whole quotation, `version` as read (CONFLICT otherwise). Lines are
 * matched by id: new ids added, changed ones updated, missing ones taken out (with their pictures).
 */
export async function updateQuotation(ctx: BusinessCtx, input: UpdateInput): Promise<QuotationDto> {
  const { id, version, ...fields } = input
  const { read, removed } = await ctx.tx(async (tx) => {
    const head = await lockRevision(tx, ctx, id)
    transition('update', head)
    if (head.version !== version) throw new AppError('conflict')
    // A revision is the same quotation for the same customer: another customer is a copy (D-296).
    if (head.revision > 1 && fields.customerId !== head.customer_id) {
      throw invalid('customerId: a revision keeps its customer (copy it for another customer)')
    }
    const live = await linesOf(tx, ctx.businessId, id)
    const { header, lines, stages } = await prepareQuotation(
      tx,
      ctx,
      fields,
      {
        customerId: head.customer_id,
        productIds: new Set(live.flatMap((l) => (l.product_id ? [l.product_id] : []))),
        validUntil: head.valid_until,
        terms: head.terms,
        vatRegistered: head.vat_registered,
      },
      null,
    )
    await tx.update(quotations).set(header).where(byId(ctx.businessId, id))
    const removed = await writeChildren(tx, ctx.businessId, id, lines, stages)
    return { read: await readQuotation(tx, ctx, id), removed }
  })
  await removeDocumentObjects(ctx, removed)
  return signed(ctx, read)
}

/**
 * `quotation.discard` (a draft, `version` as read): it is taken out with its files (a first revision
 * keeps its number: numbers may skip, Q25). A sent revision is QUOTATION_FROZEN.
 */
export async function discardQuotation(ctx: BusinessCtx, input: VersionInput): Promise<OkDto> {
  const paths = await ctx.tx(async (tx) => {
    const head = await lockRevision(tx, ctx, input.id)
    transition('discard', head)
    if (head.version !== input.version) throw new AppError('conflict')
    const lines = await linesOf(tx, ctx.businessId, input.id)
    const paths: string[] = []
    // Their files first: a line's picture is taken off only while its quotation is a live draft.
    for (const line of lines) {
      paths.push(...(await detachAll(tx, ctx.businessId, 'quotation_line', line.id)))
    }
    paths.push(...(await detachAll(tx, ctx.businessId, 'quotation', input.id)))
    await tx
      .update(quotations)
      .set({ deletedAt: sql`now()` })
      .where(byId(ctx.businessId, input.id))
    return paths
  })
  await removeDocumentObjects(ctx, paths)
  return { ok: true as const }
}

/**
 * `quotation.send` (a draft, `version` as read): it is checked and worked out once more (each line
 * keeps the VAT basis it was saved with while the VAT registration is the same), then frozen as sent;
 * the revision it replaces (the latest one sent before it) becomes superseded. A repeated send returns
 * it as recorded. Nothing to send without a line (VALIDATION).
 */
export async function sendQuotation(ctx: BusinessCtx, input: VersionInput): Promise<QuotationDto> {
  const read = await ctx.tx(async (tx) => {
    const head = await lockRevision(tx, ctx, input.id)
    const next = transition('send', head)
    if (!next.changes) return readQuotation(tx, ctx, input.id)
    if (head.version !== input.version) throw new AppError('conflict')
    const lines = await linesOf(tx, ctx.businessId, input.id)
    if (lines.length === 0) throw invalid('lines: a quotation needs a line to send')
    const stages = await stagesOf(tx, ctx.businessId, input.id)
    const prepared = await prepareQuotation(
      tx,
      ctx,
      fieldsOf(head, lines, stages),
      {
        customerId: head.customer_id,
        productIds: new Set(lines.flatMap((l) => (l.product_id ? [l.product_id] : []))),
        validUntil: head.valid_until,
        terms: head.terms,
        vatRegistered: head.vat_registered,
        vat: storedVatOf(lines),
      },
      null,
    )
    await tx.update(quotations).set(prepared.header).where(byId(ctx.businessId, input.id))
    await writeChildren(tx, ctx.businessId, input.id, prepared.lines, prepared.stages)
    await tx
      .update(quotations)
      .set({ status: 'sent', sentAt: sql`now()`, sentBy: sql`app.current_user_id()` })
      .where(byId(ctx.businessId, input.id))
    await tx.execute(sql`
      update app.quotations r
         set status = 'superseded', superseded_at = now()
       where r.business_id = ${ctx.businessId} and r.root_id = ${head.root_id}
         and r.id <> ${input.id} and r.status in ('sent', 'accepted', 'declined')
         and r.deleted_at is null
    `)
    return readQuotation(tx, ctx, input.id)
  })
  return signed(ctx, read)
}

/**
 * `quotation.accept` (quotations.documents.decide; a sent revision, `version` as read): the customer
 * accepted it, with an optional note (the signed copy is attached to the quotation). A repeated accept
 * returns it as recorded; a declined or superseded one is refused. Accepting one past its validity is
 * allowed (the business decides).
 */
export async function acceptQuotation(ctx: BusinessCtx, input: AcceptInput): Promise<QuotationDto> {
  const read = await ctx.tx(async (tx) => {
    const head = await lockRevision(tx, ctx, input.id)
    const next = transition('accept', head)
    if (next.changes) {
      if (head.version !== input.version) throw new AppError('conflict')
      await tx
        .update(quotations)
        .set({
          status: 'accepted',
          acceptedAt: sql`now()`,
          acceptedBy: sql`app.current_user_id()`,
          acceptNote: input.note,
        })
        .where(byId(ctx.businessId, input.id))
    }
    return readQuotation(tx, ctx, input.id)
  })
  return signed(ctx, read)
}

/** `quotation.decline` (as accept): the customer declined it, with an optional reason. */
export async function declineQuotation(
  ctx: BusinessCtx,
  input: DeclineInput,
): Promise<QuotationDto> {
  const read = await ctx.tx(async (tx) => {
    const head = await lockRevision(tx, ctx, input.id)
    const next = transition('decline', head)
    if (next.changes) {
      if (head.version !== input.version) throw new AppError('conflict')
      await tx
        .update(quotations)
        .set({
          status: 'declined',
          declinedAt: sql`now()`,
          declinedBy: sql`app.current_user_id()`,
          declineReason: input.reason,
        })
        .where(byId(ctx.businessId, input.id))
    }
    return readQuotation(tx, ctx, input.id)
  })
  return signed(ctx, read)
}

/** The pictures of `lines` to copy onto the lines of a new revision or copy (same positions). */
function pictureCopies(lines: readonly LineRecord[], newLineIds: readonly string[]): PictureCopy[] {
  return lines.flatMap((line, i) =>
    line.picture_path && newLineIds[i]
      ? [
          {
            fromPath: line.picture_path,
            toLineId: newLineIds[i],
            fileName: line.picture_name ?? 'picture',
            contentType: line.picture_type ?? 'image/jpeg',
            sizeBytes: line.picture_size ?? 1,
          },
        ]
      : [],
  )
}

/**
 * Writes a new draft from a revision's saved lines and stages (revise and copy), dated today; its
 * validity runs the business's number of days from today when the source had one.
 */
async function draftFrom(
  tx: Tx,
  ctx: BusinessCtx,
  source: HeadRecord,
  overrides: { customerId: string; customerChanged: boolean },
) {
  const lines = await linesOf(tx, ctx.businessId, source.id)
  const stages = await stagesOf(tx, ctx.businessId, source.id)
  const defaults = await defaultsOf(tx, ctx.businessId)
  const biz = await saleContextOf(tx, ctx.businessId)
  const fields = fieldsOf(source, lines, stages)
  const newLineIds = lines.map(() => newId())
  const prepared = await prepareQuotation(
    tx,
    ctx,
    {
      ...fields,
      customerId: overrides.customerId,
      businessDate: biz.today,
      validUntil: source.valid_until === null ? null : addDays(biz.today, defaults.validDays),
      lines: fields.lines.map((line, i) => ({ ...line, id: newLineIds[i]! })),
    },
    {
      customerId: overrides.customerChanged ? '' : source.customer_id,
      productIds: new Set(lines.flatMap((l) => (l.product_id ? [l.product_id] : []))),
      validUntil: source.valid_until,
      terms: source.terms,
      vatRegistered: source.vat_registered,
    },
    defaults,
  )
  return { prepared, copies: pictureCopies(lines, newLineIds) }
}

/**
 * `quotation.revise` (the latest revision, once sent): a new draft revision `newId` under the same
 * number, a copy of it dated today (its lines' pictures copied too), which supersedes it once sent.
 * Extra work on an accepted quotation is a revision accepted again (Q22). Idempotent on `newId`.
 */
export async function reviseQuotation(ctx: BusinessCtx, input: ReviseInput): Promise<QuotationDto> {
  const requestHash = requestHashOf({ revise: input.id })
  const { read, copies } = await ctx.tx(async (tx) => {
    const replay = await replayed(tx, ctx, input.newId, requestHash)
    if (replay) return { read: replay, copies: [] }
    const source = await lockRevision(tx, ctx, input.id)
    transition('revise', source)
    const { prepared, copies } = await draftFrom(tx, ctx, source, {
      customerId: source.customer_id,
      customerChanged: false,
    })
    // n + 1 over the live revisions: a discarded draft revision's number is used again (D-296).
    const [last] = (await tx.execute(sql`
      select max(r.revision)::int as revision from app.quotations r
       where r.business_id = ${ctx.businessId} and r.root_id = ${source.root_id}
         and r.deleted_at is null
    `)) as unknown as { revision: number }[]
    await tx.insert(quotations).values({
      id: input.newId,
      businessId: ctx.businessId,
      seq: source.seq,
      number: source.number,
      rootId: source.root_id,
      revision: (last?.revision ?? source.revision) + 1,
      status: 'draft',
      ...prepared.header,
      requestHash,
    })
    await insertChildren(tx, input.newId, prepared.lines, prepared.stages)
    return { read: await readQuotation(tx, ctx, input.newId), copies }
  })
  await copyLinePictures(ctx, copies)
  return copies.length > 0 ? getQuotation(ctx, { id: read.dto.id }) : signed(ctx, read)
}

/**
 * `quotation.copy`: a new quotation `newId` (its own number, taken last) from any revision, for its
 * customer or `customerId`, dated today, with its lines, stages, terms and pictures. Idempotent on
 * `newId`.
 */
export async function copyQuotation(ctx: BusinessCtx, input: CopyInput): Promise<QuotationDto> {
  const requestHash = requestHashOf({ copy: input.id, customerId: input.customerId ?? null })
  const { read, copies } = await ctx.tx(async (tx) => {
    const replay = await replayed(tx, ctx, input.newId, requestHash)
    if (replay) return { read: replay, copies: [] }
    const source = await headOf(tx, ctx, input.id)
    transition('copy', source)
    const customerId = input.customerId ?? source.customer_id
    const { prepared, copies } = await draftFrom(tx, ctx, source, {
      customerId,
      customerChanged: customerId !== source.customer_id,
    })
    const { seq, number } = await takeNumber(tx, ctx.businessId, 'quotation')
    await tx.insert(quotations).values({
      id: input.newId,
      businessId: ctx.businessId,
      seq,
      number,
      rootId: input.newId,
      revision: 1,
      status: 'draft',
      copiedFromId: source.id,
      ...prepared.header,
      requestHash,
    })
    await insertChildren(tx, input.newId, prepared.lines, prepared.stages)
    return { read: await readQuotation(tx, ctx, input.newId), copies }
  })
  await copyLinePictures(ctx, copies)
  return copies.length > 0 ? getQuotation(ctx, { id: read.dto.id }) : signed(ctx, read)
}

/**
 * `quotation.toOrder` (quotations.documents.manage; Orders on and orders.documents.manage): a pending
 * order `orderId` from an accepted revision, dated today, with its customer, reference, lines (a typed
 * line stays typed, Q21), discount and "Round the total", through `channelId` (null: the only active
 * channel), numbered #1001… (order.create's rules: the counter is the last lock). Once per quotation:
 * a repeat returns the order made (another revision's order: QUOTATION_HAS_ORDER).
 */
export async function quotationToOrder(
  ctx: BusinessCtx,
  input: ToOrderInput,
): Promise<QuotationOrderDto> {
  assertModuleActive(ctx, 'orders')
  assertPermission(ctx, 'orders.documents.manage')
  const read = await ctx.tx(async (tx) => {
    const head = await lockRevision(tx, ctx, input.id)
    const next = transition('to_order', head)
    if (next.changes) {
      const [taken] = (await tx.execute(sql`
        select 1 from app.orders o where o.business_id = ${ctx.businessId} and o.id = ${input.orderId}
      `)) as unknown as unknown[]
      if (taken) throw new AppError('conflict')
      const lines = await linesOf(tx, ctx.businessId, input.id)
      const biz = await saleContextOf(tx, ctx.businessId)
      const orderLineIds = lines.map(() => newId())
      const orderLines: OrderFields['lines'] = lines.map((l, i): InputLine =>
        l.product_id === null
          ? {
              kind: 'typed',
              id: orderLineIds[i]!,
              description: l.description,
              qty: l.qty,
              unit: l.unit,
              unitPrice: l.unit_price,
              priceIncludesVat: l.price_includes_vat,
              vatCategory: l.vat_category ?? 'standard',
              discount: discountOf(l.discount_percent, l.discount_amount),
            }
          : {
              kind: 'item',
              id: orderLineIds[i]!,
              productId: l.product_id,
              description: l.description,
              qty: l.qty,
              unitPrice: l.unit_price,
              discount: discountOf(l.discount_percent, l.discount_amount),
            },
      ) as OrderFields['lines']
      await insertOrder(
        tx,
        ctx,
        input.orderId,
        {
          customerId: head.customer_id,
          customerRef: head.customer_ref,
          businessDate: biz.today,
          dueDate: input.dueDate,
          locationId: head.location_id,
          channelId: input.channelId,
          discount: discountOf(head.discount_percent, head.discount_amount),
          roundTo: head.round_to,
          deliveryNeeded: false,
          deliveryArea: null,
          deliveryCost: undefined,
          notes: head.notes,
          lines: orderLines,
        },
        requestHashOf({ quotation: input.id, ...input }),
        {
          // What the customer accepted (D-296): its customer and products even when archived since,
          // and each product line's VAT basis as sent while the VAT registration is the same (as a
          // delivery keeps an order's), so the order's amounts are the accepted revision's.
          stored: {
            channelId: '',
            customerId: head.customer_id,
            productIds: new Set(lines.flatMap((l) => (l.product_id ? [l.product_id] : []))),
            deliveryCost: null,
            roundTo: head.round_to,
            vat:
              head.vat_registered === biz.vatRegistered
                ? new Map(
                    lines.flatMap((l, i) =>
                      l.product_id === null
                        ? []
                        : [
                            [
                              orderLineIds[i]!,
                              {
                                priceIncludesVat: l.price_includes_vat,
                                vatCategory: l.vat_category ?? 'standard',
                              },
                            ] as const,
                          ],
                    ),
                  )
                : undefined,
          },
        },
      )
      await tx
        .update(quotations)
        .set({ orderId: input.orderId })
        .where(byId(ctx.businessId, input.id))
    }
    return readQuotation(tx, ctx, input.id)
  })
  const quotation = await signed(ctx, read)
  return {
    quotation,
    orderId: quotation.orderId ?? input.orderId,
    orderNumber: quotation.orderNumber ?? '',
  }
}

// ---------------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------------

/**
 * `quotation.history`: what happened to the quotation's revisions, newest first: created, copied,
 * revised, edited (each save of a draft), sent, accepted, declined, superseded, discarded and the
 * order made, read from the revisions' own columns, with who and when from the audit log (its actor and
 * time only, never its row data). Names only with a team (a solo business is its owner).
 */
export async function quotationHistory(
  ctx: BusinessCtx,
  input: IdInput,
): Promise<QuotationHistoryDto> {
  return ctx.tx(async (tx) => {
    const head = await headOf(tx, ctx, input.id)
    const rows = (await tx.execute(sql`
      with rev as (
        select q.* from app.quotations q
         where ${where([
           sql`q.business_id = ${ctx.businessId}`,
           sql`q.root_id = ${head.root_id}`,
           ...visible(ctx),
         ])}
      ),
      audit as (
        select a.entity_id, a.actor_user_id, a.created_at, a.action
          from app.audit_log a
         where a.business_id = ${ctx.businessId} and a.entity = 'quotations'
           and a.entity_id in (select rev.id from rev)
      ),
      events as (
        select case when q.revision = 1 and q.copied_from_id is not null then 'copied'
                    when q.revision = 1 then 'created' else 'revised' end as kind,
               q.revision, q.created_at as at, q.created_by as by_user, null::text as note,
               cf.number as reference
          from rev q
          left join app.quotations cf on cf.business_id = q.business_id and cf.id = q.copied_from_id
                    ${andAll(visible(ctx, 'cf'))}
        union all
        select 'edited', q.revision, a.created_at, a.actor_user_id, null, null
          from rev q join audit a on a.entity_id = q.id and a.action = 'update'
         where a.created_at > q.created_at
           and a.created_at < coalesce(q.sent_at, q.deleted_at, 'infinity'::timestamptz)
        union all
        select 'sent', q.revision, q.sent_at, q.sent_by, null, null from rev q
         where q.sent_at is not null
        union all
        select 'accepted', q.revision, q.accepted_at, q.accepted_by, q.accept_note, null from rev q
         where q.accepted_at is not null
        union all
        select 'declined', q.revision, q.declined_at, q.declined_by, q.decline_reason, null from rev q
         where q.declined_at is not null
        union all
        select 'superseded', q.revision, q.superseded_at,
               (select a.actor_user_id from audit a
                 where a.entity_id = q.id and a.created_at = q.superseded_at limit 1), null, null
          from rev q where q.superseded_at is not null
        union all
        select 'discarded', q.revision, q.deleted_at,
               (select a.actor_user_id from audit a
                 where a.entity_id = q.id and a.created_at = q.deleted_at limit 1), null, null
          from rev q where q.deleted_at is not null
        union all
        select 'ordered', q.revision, o.created_at, o.created_by, null, o.number
          from rev q join app.orders o on o.business_id = q.business_id and o.id = q.order_id
                     ${seenOrder(ctx)}
      )
      select e.kind, e.revision, e.at, e.note, e.reference,
             (select bm.display_name from app.business_members bm
               where bm.business_id = ${ctx.businessId} and bm.user_id = e.by_user
                 and bm.kind = 'account'
               order by (bm.status = 'active') desc, bm.created_at desc limit 1) as by_name
        from events e
       order by e.at desc, e.revision desc, e.kind
       limit ${QUOTATION_HISTORY_MAX}
    `)) as unknown as {
      kind: QuotationEventKind
      revision: number
      at: Date | string
      note: string | null
      reference: string | null
      by_name: string | null
    }[]
    const team = ctx.access.capabilities.has_team
    return {
      events: rows.map((row) => ({
        kind: row.kind,
        revision: row.revision,
        at: isoOf(row.at),
        byName: team ? row.by_name : null,
        note: row.note,
        reference: row.reference,
      })),
    }
  })
}

export { headOf as quotationHeadOf, type HeadRecord as QuotationHeadRecord }
