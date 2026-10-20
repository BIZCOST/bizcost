import {
  INVOICE_HISTORY_MAX,
  type createCreditNoteInput,
  type CreditNoteDto,
  type CreditNoteEventKind,
  type CreditNoteHistoryDto,
  type creditNoteIdInput,
  type creditNoteListInput,
  type CreditNoteListDto,
  type creditNoteVersionInput,
  type InvoicePartyDto,
  type updateCreditNoteInput,
} from '@bizcost/contracts'
import {
  creditNoteLines,
  creditNotes,
  saleLines,
  sales,
  type NewSaleLine,
  type Tx,
} from '@bizcost/db'
import {
  compareDecimal,
  computeSale,
  creditError,
  creditLeft,
  creditNoteAsksCountedElsewhere,
  creditNoteCounts,
  creditNoteKindOf,
  creditNoteValues,
  creditRateVat,
  currencyMinorUnit,
  CREDIT_REASON_LAW,
  fitCredit,
  isCurrencyCode,
  newId,
  planCredit,
  proportionOf,
  QUANTITY_SCALE,
  rateKey,
  saleError,
  splitByWeights,
  subtractDecimals,
  sumDecimals,
  taxDocumentDueBy,
  taxDocumentLate,
  type CostAmount,
  type CreditBy,
  type CreditCountingContext,
  type CreditLinePlan,
  type CreditMade,
  type CreditNoteKind,
  type CreditReason,
  type CustomerKind,
  type Emirate,
  type InvoiceStatus,
  type Money,
  type Quantity,
  type SaleLineInput as DomainSaleLine,
  type SaleMaterialBasis,
  type StandardUnit,
  type UnitCost,
  type VatCategory,
} from '@bizcost/domain'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { seesCustomers } from './customers'
import {
  assertListed,
  invoiceHeadOf,
  invoiceLinesOf,
  issuingBusinessOf,
  letterheadNow,
  visibleInvoices,
  type InvoiceLineRecord,
  type InvoiceRecord,
} from './invoices'
import { takeNumber } from './numbering'
import { insertMaterialRows, shareCostRows } from './sale-costs'
import { resolveChannel } from './sales'
import { isoOf, lockPostingBusiness, reversalDateOf } from './stock'

// Credit notes (ROADMAP.md M3 Step 8; VAT DL Arts 61, 62; VAT ER Art. 60; MD 243 Art. 6(2)). A credit
// note corrects one issued invoice: a draft (no number) prepared with `invoices.documents.credit`, then
// issued, taking the next number of its own gapless series `credit_note` (CN-0001…) LAST in the issuing
// transaction (a replayed issue is answered from the issued credit note before a number is taken). Its
// kind follows its invoice's (a tax credit note for a tax invoice, a plain one for a plain one, B5). Its
// lines take back the invoice's lines by quantity (goods returned) or by amount (a price cut), never more
// than is left after the credit notes issued before it (EXCEEDS_INVOICE; documents/credit.ts: each later
// credit starts from the value the earlier ones left, ER Art. 60(1)(e)); its amounts are the sales
// engine's under the invoice's VAT registration, stored as positive numbers. Issuing posts a negative
// sale on its issue date (closed books move it to the first open day; books closed through today: the
// issue waits, BOOKS_CLOSED) unless the invoice was a deposit invoice or counted elsewhere and the credit
// note is answered "already in my recorded sales" (Q3); by quantity it takes back the frozen cost of
// the line it counted in (its materials too), by amount none. It freezes the particulars ER Art. 60(1)
// asks: the seller's and the customer's, and the invoice's value of the supply before and after it.
//
// Lock order: the credit note, its invoice (FOR UPDATE: its credit notes and payments wait for each
// other, and an issue of another invoice of its source, which locks the source's issued invoices
// first), its order (FOR SHARE when it issues: its delivery and this credit note wait for each other),
// the business row (FOR SHARE), the cost rows still without a price (FOR SHARE), the counter.

type CreateInput = z.output<typeof createCreditNoteInput>
type UpdateInput = z.output<typeof updateCreditNoteInput>
type IdInput = z.output<typeof creditNoteIdInput>
type VersionInput = z.output<typeof creditNoteVersionInput>
type ListInput = z.output<typeof creditNoteListInput>
type Fields = Omit<CreateInput, 'id' | 'invoiceId'>

const invalid = (message: string) => new AppError('validation', { message })
const where = (parts: readonly SQL[]) => sql.join([...parts], sql` and `)
const negate = (value: string) => subtractDecimals('0', value)
const abs = (value: string) => (value.startsWith('-') ? value.slice(1) : value)

/** A member's name in the business now. */
const memberName = (user: SQL) => sql`(
  select bm.display_name from app.business_members bm
   where bm.business_id = c.business_id and bm.user_id = ${user} and bm.kind = 'account'
   order by (bm.status = 'active') desc, bm.created_at desc
   limit 1)`

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

export interface CreditNoteRecord extends Record<string, unknown> {
  id: string
  seq: number | null
  number: string | null
  kind: CreditNoteKind
  status: InvoiceStatus
  invoice_id: string
  invoice_number: string
  invoice_issue_date: string
  invoice_net: string
  invoice_is_deposit: boolean
  invoice_counted_elsewhere: boolean | null
  customer_id: string
  location_id: string
  issue_date: string | null
  event_date: string
  reason: CreditReason
  reason_text: string
  credit_by: CreditBy
  counted_elsewhere: boolean | null
  vat_registered: boolean
  currency: string
  net_total: string
  vat_total: string
  total: string
  rounding_difference: string
  vat_rates: CreditNoteDto['vatRates']
  value_before: string | null
  value_after: string | null
  earlier_nets: string
  notes: string | null
  counted_on: string | null
  issued_at: Date | string | null
  customer_name: string | null
  customer_kind: CustomerKind | null
  customer_trn: string | null
  customer_trade_licence: string | null
  customer_address_line: string | null
  customer_city: string | null
  customer_emirate: Emirate | null
  customer_country: string | null
  seller_name: string | null
  seller_name_ar: string | null
  seller_trn: string | null
  seller_trade_licence: string | null
  seller_trade_licence_authority: string | null
  seller_address_line: string | null
  seller_city: string | null
  seller_emirate: Emirate | null
  live_name: string
  live_kind: CustomerKind
  live_trn: string | null
  live_licence: string | null
  live_address: string | null
  live_city: string | null
  live_emirate: Emirate | null
  live_country: string
  letterhead: Record<string, unknown> | null
  pdf_upload_id: string | null
  today: string
  entered_by_name: string | null
  mine: boolean
  created_at: Date | string
  version: number
}

const HEAD_COLUMNS = sql`
  c.id, c.seq, c.number, c.kind, c.status, c.invoice_id, i.number as invoice_number,
  i.issue_date::text as invoice_issue_date, trim_scale(i.net_total)::text as invoice_net,
  i.is_deposit as invoice_is_deposit, i.counted_elsewhere as invoice_counted_elsewhere,
  c.customer_id, c.location_id, c.issue_date::text as issue_date, c.event_date::text as event_date,
  c.reason, c.reason_text, c.credit_by, c.counted_elsewhere, c.vat_registered,
  trim(c.currency) as currency, trim_scale(c.net_total)::text as net_total,
  trim_scale(c.vat_total)::text as vat_total, trim_scale(c.total)::text as total, c.vat_rates,
  trim_scale(c.rounding_difference)::text as rounding_difference,
  trim_scale(c.value_before)::text as value_before, trim_scale(c.value_after)::text as value_after,
  trim_scale(coalesce((select sum(e.net_total) from app.credit_notes e
     where e.business_id = c.business_id and e.invoice_id = c.invoice_id and e.status = 'issued'
       and e.deleted_at is null and e.id <> c.id
       and (c.seq is null or e.seq < c.seq)), 0))::text as earlier_nets,
  c.notes, c.counted_on::text as counted_on, c.issued_at, c.customer_name, c.customer_kind,
  c.customer_trn, c.customer_trade_licence, c.customer_address_line, c.customer_city,
  c.customer_emirate, trim(c.customer_country) as customer_country, c.seller_name, c.seller_name_ar,
  c.seller_trn, c.seller_trade_licence, c.seller_trade_licence_authority, c.seller_address_line,
  c.seller_city, c.seller_emirate, cu.name as live_name, cu.kind as live_kind, cu.trn as live_trn,
  cu.trade_licence_no as live_licence, cu.address_line as live_address, cu.city as live_city,
  cu.emirate as live_emirate, trim(cu.country) as live_country, c.letterhead, c.pdf_upload_id,
  (select (now() at time zone b.timezone)::date from app.businesses b
    where b.id = c.business_id)::text as today,
  ${memberName(sql`c.created_by`)} as entered_by_name,
  c.created_by = app.current_user_id() as mine, c.created_at, c.version`

/** The credit note (NOT_FOUND unless live, of this business, its invoice in the caller's branches). */
export async function creditNoteHeadOf(
  tx: Tx,
  ctx: BusinessCtx,
  id: string,
): Promise<CreditNoteRecord> {
  const [head] = (await tx.execute(sql`
    select ${HEAD_COLUMNS}
      from app.credit_notes c
      join app.invoices i on i.business_id = c.business_id and i.id = c.invoice_id
      join app.customers cu on cu.business_id = c.business_id and cu.id = c.customer_id
     where ${where([
       sql`c.business_id = ${ctx.businessId}`,
       sql`c.id = ${id}`,
       sql`c.deleted_at is null`,
       ...visibleInvoices(ctx),
     ])}
  `)) as unknown as CreditNoteRecord[]
  if (!head) throw new AppError('not_found')
  return head
}

export interface CreditNoteLineRecord extends Record<string, unknown> {
  id: string
  invoice_line_id: string
  description: string
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
}

export async function creditNoteLinesOf(tx: Tx, businessId: string, creditNoteId: string) {
  return (await tx.execute(sql`
    select l.id, l.invoice_line_id, l.description, trim_scale(l.qty)::text as qty, l.unit,
           trim_scale(l.unit_price)::text as unit_price, l.price_includes_vat,
           trim_scale(l.discount_amount)::text as discount_amount, l.vat_category,
           trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.subtotal)::text as subtotal,
           trim_scale(l.discount)::text as discount, trim_scale(l.net)::text as net,
           trim_scale(l.vat)::text as vat, trim_scale(l.total)::text as total
      from app.credit_note_lines l
     where l.business_id = ${businessId} and l.credit_note_id = ${creditNoteId}
       and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as CreditNoteLineRecord[]
}

/**
 * The customer as printed: frozen once issued; on a draft, live (its TRN, licence and address only for
 * a member who sees customers, D-263).
 */
function partyOf(head: CreditNoteRecord, seesDetails: boolean): InvoicePartyDto {
  if (head.status === 'issued') {
    return {
      name: head.customer_name ?? head.live_name,
      kind: head.customer_kind,
      nameAr: null,
      trn: head.customer_trn,
      tradeLicence: head.customer_trade_licence,
      tradeLicenceAuthority: null,
      addressLine: head.customer_address_line,
      city: head.customer_city,
      emirate: head.customer_emirate,
      country: head.customer_country,
    }
  }
  return {
    name: head.live_name,
    kind: head.live_kind,
    nameAr: null,
    trn: seesDetails ? head.live_trn : null,
    tradeLicence: seesDetails ? head.live_licence : null,
    tradeLicenceAuthority: null,
    addressLine: seesDetails ? head.live_address : null,
    city: seesDetails ? head.live_city : null,
    emirate: seesDetails ? head.live_emirate : null,
    country: head.live_country,
  }
}

/** ER Art. 60(1)(e): frozen once issued; on a draft, worked out now from the issued ones. */
export function valuesOf(head: CreditNoteRecord) {
  if (head.value_before !== null && head.value_after !== null) {
    return {
      valueBefore: head.value_before,
      valueAfter: head.value_after,
      difference: head.net_total,
      vat: head.vat_total,
    }
  }
  const currency = isCurrencyCode(head.currency) ? head.currency : 'AED'
  const before = subtractDecimals(head.invoice_net, head.earlier_nets)
  try {
    return creditNoteValues(
      head.invoice_net as Money,
      [head.earlier_nets as Money],
      head.net_total as Money,
      head.vat_total as Money,
      currency,
    )
  } catch {
    return {
      valueBefore: before,
      valueAfter: subtractDecimals(before, head.net_total),
      difference: head.net_total,
      vat: head.vat_total,
    }
  }
}

/**
 * What a credit note of an invoice follows for counting once (Q3, D-305): the invoice that counted the
 * work it bills (the invoice itself; a deposit invoice's final invoice, the first issued one that took
 * it off), and whether that work has counted yet: never for a deposit invoice no final invoice took off,
 * an order's invoice only once the order is delivered (its delivery counts), any other always (its own
 * sale, its recorded sale, or recorded sales elsewhere).
 */
export async function creditCountingOf(
  tx: Tx,
  businessId: string,
  invoice: { readonly id: string; readonly isDeposit: boolean },
): Promise<CreditCountingContext & { readonly workInvoiceId: string | null }> {
  const [basis] = (await tx.execute(sql`
    select f.id, f.counted_elsewhere,
           (f.order_id is null or exists (
             select 1 from app.orders o
              where o.business_id = f.business_id and o.id = f.order_id
                and o.status = 'delivered' and o.deleted_at is null)) as work_counted
      from app.invoices f
     where f.business_id = ${businessId} and f.status = 'issued' and f.deleted_at is null
       and ${
         invoice.isDeposit
           ? sql`exists (select 1 from app.invoice_lines l
                          where l.business_id = f.business_id and l.invoice_id = f.id
                            and l.deposit_invoice_id = ${invoice.id} and l.deleted_at is null)`
           : sql`f.id = ${invoice.id}`
       }
     order by f.seq
     limit 1
  `)) as unknown as { id: string; counted_elsewhere: boolean | null; work_counted: boolean }[]
  if (!basis) return { workCounted: false, countedElsewhere: null, workInvoiceId: null }
  return {
    workCounted: basis.work_counted,
    countedElsewhere: basis.counted_elsewhere,
    workInvoiceId: basis.id,
  }
}

async function readCreditNote(tx: Tx, ctx: BusinessCtx, id: string): Promise<CreditNoteDto> {
  const head = await creditNoteHeadOf(tx, ctx, id)
  const lines = await creditNoteLinesOf(tx, ctx.businessId, id)
  const counting = await creditCountingOf(tx, ctx.businessId, {
    id: head.invoice_id,
    isDeposit: head.invoice_is_deposit,
  })
  const issued = head.status === 'issued'
  const team = ctx.access.capabilities.has_team
  return {
    id: head.id,
    number: head.number,
    seq: head.seq,
    kind: head.kind,
    status: head.status,
    invoiceId: head.invoice_id,
    invoiceNumber: head.invoice_number,
    invoiceIssueDate: head.invoice_issue_date,
    customerId: head.customer_id,
    customer: partyOf(head, seesCustomers(ctx)),
    seller:
      issued && head.seller_name !== null
        ? {
            name: head.seller_name,
            kind: null,
            nameAr: head.seller_name_ar,
            trn: head.seller_trn,
            tradeLicence: head.seller_trade_licence,
            tradeLicenceAuthority: head.seller_trade_licence_authority,
            addressLine: head.seller_address_line,
            city: head.seller_city,
            emirate: head.seller_emirate,
            country: 'AE',
          }
        : null,
    locationId: head.location_id,
    issueDate: head.issue_date,
    eventDate: head.event_date,
    dueBy: taxDocumentDueBy(head.event_date),
    late: taxDocumentLate(head.event_date, head.issue_date ?? head.today),
    reason: head.reason,
    reasonText: head.reason_text,
    reasonLaw: { ...CREDIT_REASON_LAW[head.reason] },
    by: head.credit_by,
    countedElsewhere: head.counted_elsewhere,
    asksCountedElsewhere: creditNoteAsksCountedElsewhere(counting),
    counts: issued ? head.counted_on !== null : creditNoteCounts(counting, head.counted_elsewhere),
    countedOn: head.counted_on,
    vatRegistered: head.vat_registered,
    currency: head.currency,
    netTotal: head.net_total,
    vatTotal: head.vat_total,
    total: head.total,
    roundingDifference: head.rounding_difference,
    payable: sumDecimals([head.total, head.rounding_difference]),
    vatRates: head.vat_rates,
    values: valuesOf(head),
    lines: lines.map((l) => ({
      id: l.id,
      invoiceLineId: l.invoice_line_id,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitPrice: l.unit_price,
      priceIncludesVat: l.price_includes_vat,
      vatCategory: l.vat_category,
      vatRate: l.vat_rate,
      net: l.net,
      vat: l.vat,
      total: l.total,
    })),
    notes: head.notes,
    pdfStored: head.pdf_upload_id !== null,
    issuedAt: isoOf(head.issued_at),
    enteredByName: team ? head.entered_by_name : null,
    mine: head.mine,
    createdAt: isoOf(head.created_at),
    version: head.version,
  }
}

/** `creditNote.get`. */
export function getCreditNote(ctx: BusinessCtx, input: IdInput): Promise<CreditNoteDto> {
  return ctx.tx((tx) => readCreditNote(tx, ctx, input.id))
}

const SORT_KEY = sql`case when c.status = 'draft'
    then '0|' || to_char(c.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
    else '1|' || lpad((999999999999 - c.seq)::text, 12, '0') end`

/** `creditNote.list`: drafts first, then issued ones by number, newest first. */
export function listCreditNotes(ctx: BusinessCtx, input: ListInput): Promise<CreditNoteListDto> {
  const filters: SQL[] = [
    sql`c.business_id = ${ctx.businessId}`,
    sql`c.deleted_at is null`,
    ...visibleInvoices(ctx),
  ]
  if (input.status !== 'all') filters.push(sql`c.status = ${input.status}`)
  if (input.invoiceId) filters.push(sql`c.invoice_id = ${input.invoiceId}`)
  if (input.customerId) filters.push(sql`c.customer_id = ${input.customerId}`)
  if (input.search) {
    const pattern = containsPattern(input.search)
    filters.push(
      sql`(c.number ilike ${pattern} or i.number ilike ${pattern} or cu.name ilike ${pattern})`,
    )
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    filters.push(sql`(${SORT_KEY}, c.id) > (${cursor.key}, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    await assertListed(tx, ctx.businessId, {
      invoices: input.invoiceId,
      customers: input.customerId,
    })
    const rows = (await tx.execute(sql`
      select ${SORT_KEY} as sort_key, c.id, c.number, c.kind, c.status, c.invoice_id,
             i.number as invoice_number, c.customer_id,
             coalesce(c.customer_name, cu.name) as customer_name,
             c.issue_date::text as issue_date, c.event_date::text as event_date, c.reason,
             trim(c.currency) as currency, trim_scale(c.total)::text as total,
             c.created_by = app.current_user_id() as mine, c.created_at, c.version
        from app.credit_notes c
        join app.invoices i on i.business_id = c.business_id and i.id = c.invoice_id
        join app.customers cu on cu.business_id = c.business_id and cu.id = c.customer_id
       where ${where(filters)}
       order by ${SORT_KEY}, c.id
       limit ${input.limit + 1}
    `)) as unknown as {
      sort_key: string
      id: string
      number: string | null
      kind: CreditNoteKind
      status: InvoiceStatus
      invoice_id: string
      invoice_number: string
      customer_id: string
      customer_name: string
      issue_date: string | null
      event_date: string
      reason: CreditReason
      currency: string
      total: string
      mine: boolean
      created_at: Date | string
      version: number
    }[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      items: page.map((r) => ({
        id: r.id,
        number: r.number,
        kind: r.kind,
        status: r.status,
        invoiceId: r.invoice_id,
        invoiceNumber: r.invoice_number,
        customerId: r.customer_id,
        customerName: r.customer_name,
        issueDate: r.issue_date,
        eventDate: r.event_date,
        reason: r.reason,
        currency: r.currency,
        total: r.total,
        mine: r.mine,
        createdAt: isoOf(r.created_at),
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
// Working out the lines
// ---------------------------------------------------------------------------------------------------

/** The invoice locked FOR UPDATE (NOT_FOUND unless live and in the caller's branches). */
async function lockInvoiceRow(tx: Tx, ctx: BusinessCtx, id: string): Promise<InvoiceRecord> {
  const [row] = (await tx.execute(sql`
    select i.id from app.invoices i
     where ${where([
       sql`i.business_id = ${ctx.businessId}`,
       sql`i.id = ${id}`,
       sql`i.deleted_at is null`,
       ...visibleInvoices(ctx),
     ])}
       for update
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
  return invoiceHeadOf(tx, ctx, id)
}

/** A credit note's line worked out (positive amounts), and what it takes back of its invoice line. */
interface PlannedLine {
  readonly line: InvoiceLineRecord
  readonly qty: string
  readonly unitPrice: string
  readonly discountAmount: string | null
  readonly subtotal: string
  readonly discount: string
  readonly net: string
  readonly vat: string
  readonly total: string
  /** By quantity: the quantity taken back (its cost goes back with it); by amount: none. */
  readonly takenQty: string | null
}

/**
 * The lines of a credit note of `invoice`: each asked line of the invoice (never a deduction) by
 * quantity or by amount, never more than is left after the issued credit notes (EXCEEDS_INVOICE), worked
 * out as a refund is (documents/credit.ts; computeSale for the parts, VAT once per rate) under the
 * invoice's VAT registration, then made positive.
 */
function planLines(
  invoice: InvoiceRecord,
  lines: readonly InvoiceLineRecord[],
  input: Pick<Fields, 'by' | 'lines'>,
  creditedBefore: ReadonlyMap<string, { net: string; gross: string; vat: string }>,
): PlannedLine[] {
  if (!isCurrencyCode(invoice.currency)) throw invalid('currency: not supported')
  const currency = invoice.currency
  const byId = new Map(lines.map((l) => [l.id, l] as const))
  const planned = input.lines.map((asked) => {
    const line = byId.get(asked.invoiceLineId)
    if (!line) throw new AppError('not_found')
    if (line.kind === 'deduction') throw invalid('lines: a deposit taken off is not credited')
    const credited = {
      qty: line.qty,
      unitPrice: line.unit_price,
      priceIncludesVat: line.price_includes_vat,
      net: line.net,
      vat: line.vat,
      total: line.total,
    }
    const made: CreditMade[] = [
      {
        by: 'quantity',
        qty: line.credited_qty,
        net: line.credited_net,
        vat: line.credited_vat,
        total: line.credited_total,
      },
    ]
    const left = creditLeft(credited, made)
    const request =
      input.by === 'quantity'
        ? { by: 'quantity' as const, qty: asked.qty ?? '0' }
        : { by: 'amount' as const, amount: asked.amount ?? '0' }
    const error = creditError(left, request, currency)
    if (error === 'exceeds_left') throw new AppError('exceeds_invoice')
    if (error) throw invalid(`lines: ${error}`)
    return { line, left, plan: planCredit(credited, left, request, currency), request }
  })
  const partial = planned.flatMap((p, i) => (p.plan.whole ? [] : [{ p, i }]))
  const computeInput = {
    vatRegistered: invoice.vat_registered,
    lines: partial.map(({ p }): DomainSaleLine => {
      const plan = p.plan as CreditLinePlan & { whole: false }
      const base = {
        qty: plan.qty as Quantity,
        unitPrice: plan.unitPrice as Money,
        priceIncludesVat: p.line.price_includes_vat,
        discount: plan.discountAmount ? { amount: plan.discountAmount as Money } : null,
      }
      return p.line.kind === 'delivery'
        ? { kind: 'delivery', ...base }
        : { kind: 'item', ...base, vatCategory: p.line.vat_category ?? 'standard' }
    }),
  }
  if (partial.length > 0) {
    const problem = saleError(computeInput, currency)
    if (problem) throw invalid(`amounts: ${problem.code}`)
  }
  const computed = partial.length > 0 ? computeSale(computeInput, currency) : null
  const amountsAt = new Map(partial.map(({ i }, k) => [i, computed!.lines[k]!] as const))
  const out = planned.map(({ line, left, plan, request }, i): PlannedLine => {
    if (plan.whole) {
      return {
        line,
        qty: abs(plan.qty),
        unitPrice: line.unit_price,
        discountAmount: null,
        subtotal: abs(line.price_includes_vat ? plan.total : plan.net),
        discount: '0',
        net: abs(plan.net),
        vat: abs(plan.vat),
        total: abs(plan.total),
        takenQty: request.by === 'quantity' ? request.qty : null,
      }
    }
    const a = amountsAt.get(i)!
    const fitted = fitCredit(left, a, line.price_includes_vat)
    return {
      line,
      qty: abs(plan.qty),
      unitPrice: plan.unitPrice,
      discountAmount: plan.discountAmount,
      subtotal: abs(a.subtotal),
      discount: abs(a.discount),
      net: abs(fitted.net),
      vat: abs(fitted.vat),
      total: abs(fitted.total),
      takenQty: request.by === 'quantity' ? request.qty : null,
    }
  })
  return invoice.vat_registered
    ? withRateVat(invoice, lines, planned, out, creditedBefore, currency)
    : out
}

/**
 * Each rate's VAT of a credit note worked out once on the running total of its invoice's credit notes
 * (creditRateVat: PINT-AE S-09 on every note, the notes adding up to the invoice's VAT), then shared
 * over its lines at that rate: a line keeps what it takes back as typed (its net, or its total when
 * its price includes VAT), so its VAT and its other amount move together.
 */
function withRateVat(
  invoice: InvoiceRecord,
  lines: readonly InvoiceLineRecord[],
  planned: readonly { line: InvoiceLineRecord; left: { typed: string } }[],
  out: PlannedLine[],
  creditedBefore: ReadonlyMap<string, { net: string; gross: string; vat: string }>,
  currency: Parameters<typeof creditRateVat>[2],
): PlannedLine[] {
  const typedOf = (p: PlannedLine) => (p.line.price_includes_vat ? p.total : p.net)
  const keyOf = (l: Pick<InvoiceLineRecord, 'vat_category' | 'vat_rate'>) =>
    rateKey({ vatCategory: l.vat_category, vatRate: l.vat_rate })
  const result = [...out]
  const keys = [...new Set(out.map((p) => keyOf(p.line)))]
  for (const key of keys) {
    const at = out.flatMap((p, i) => (keyOf(p.line) === key ? [i] : []))
    const first = out[at[0]!]!.line
    if (first.vat_rate === null || compareDecimal(first.vat_rate, '0') <= 0) continue
    const invoiceRate = invoice.vat_rates.find(
      (r) => rateKey({ vatCategory: r.vatCategory, vatRate: r.vatRate }) === key,
    )
    // All that is left of the invoice's lines at this rate is taken back by this note.
    const takesAllLeft = lines
      .filter((l) => l.kind !== 'deduction' && keyOf(l) === key)
      .every((l) => {
        const k = planned.findIndex((p) => p.line.id === l.id)
        const left =
          k >= 0
            ? planned[k]!.left.typed
            : l.price_includes_vat
              ? subtractDecimals(l.total, l.credited_total)
              : subtractDecimals(l.net, l.credited_net)
        const taken = k >= 0 ? typedOf(out[k]!) : '0'
        return compareDecimal(subtractDecimals(left, taken), '0') <= 0
      })
    const shares = creditRateVat(
      {
        vatRate: first.vat_rate,
        invoiceVat: invoiceRate?.vat ?? '0',
        before: creditedBefore.get(key) ?? { net: '0', gross: '0', vat: '0' },
        takesAllLeft,
      },
      at.map((i) => ({
        priceIncludesVat: out[i]!.line.price_includes_vat,
        typed: typedOf(out[i]!),
      })),
      currency,
    )
    at.forEach((i, k) => {
      const p = out[i]!
      const vat = shares[k]!
      result[i] = p.line.price_includes_vat
        ? { ...p, vat, net: subtractDecimals(p.total, vat) }
        : { ...p, vat, total: sumDecimals([p.net, vat]) }
    })
  }
  return result
}

/** The credit note's columns and its lines' (positive), from what was asked of its invoice. */
async function prepare(tx: Tx, ctx: BusinessCtx, invoice: InvoiceRecord, input: Fields) {
  if (invoice.status !== 'issued') throw new AppError('document_not_posted')
  // A plain credit note says nothing of tax (Q26): its reasons are the supply's, never its tax.
  if (
    invoice.kind === 'invoice' &&
    (input.reason === 'tax_treatment_changed' || input.reason === 'tax_charged_in_error')
  ) {
    throw invalid('reason: a plain credit note has no tax reason')
  }
  const [today] = (await tx.execute(sql`
    select (now() at time zone b.timezone)::date::text as today from app.businesses b
     where b.id = ${ctx.businessId}
  `)) as unknown as { today: string }[]
  if (input.eventDate > (today?.today ?? input.eventDate)) throw new AppError('future_date')
  const lines = await invoiceLinesOf(tx, ctx.businessId, invoice.id)
  // What the credit notes issued before took back at each rate (VAT once on the running total).
  const before = (await tx.execute(sql`
    select cl.vat_category, trim_scale(cl.vat_rate)::text as vat_rate,
           trim_scale(coalesce(sum(cl.net) filter (where not cl.price_includes_vat), 0))::text as net,
           trim_scale(coalesce(sum(cl.total) filter (where cl.price_includes_vat), 0))::text as gross,
           trim_scale(coalesce(sum(cl.vat), 0))::text as vat
      from app.credit_note_lines cl
      join app.credit_notes c on c.business_id = cl.business_id and c.id = cl.credit_note_id
     where cl.business_id = ${ctx.businessId} and c.invoice_id = ${invoice.id}
       and c.status = 'issued' and c.deleted_at is null and cl.deleted_at is null
     group by cl.vat_category, cl.vat_rate
  `)) as unknown as {
    vat_category: VatCategory | null
    vat_rate: string | null
    net: string
    gross: string
    vat: string
  }[]
  const creditedBefore = new Map(
    before.map((r) => [
      rateKey({ vatCategory: r.vat_category, vatRate: r.vat_rate }),
      { net: r.net, gross: r.gross, vat: r.vat },
    ]),
  )
  const planned = planLines(invoice, lines, input, creditedBefore)
  // ER Art. 60(1)(e): never more than the invoice's value of the supply left by the credit notes
  // issued before (a final invoice's value is its net after its deposits).
  const [credited] = (await tx.execute(sql`
    select trim_scale(coalesce(sum(c.net_total), 0))::text as net from app.credit_notes c
     where c.business_id = ${ctx.businessId} and c.invoice_id = ${invoice.id}
       and c.status = 'issued' and c.deleted_at is null
  `)) as unknown as { net: string }[]
  const netLeft = subtractDecimals(invoice.net_total, credited?.net ?? '0')
  if (compareDecimal(sumDecimals(planned.map((p) => p.net)), netLeft) > 0) {
    throw new AppError('exceeds_invoice')
  }
  const counting = await creditCountingOf(tx, ctx.businessId, {
    id: invoice.id,
    isDeposit: invoice.is_deposit,
  })
  const asks = creditNoteAsksCountedElsewhere(counting)
  const rates = new Map<
    string,
    { vatCategory: VatCategory | null; vatRate: string | null; net: string; vat: string }
  >()
  for (const p of planned) {
    const key = rateKey({ vatCategory: p.line.vat_category, vatRate: p.line.vat_rate })
    const sum = rates.get(key)
    rates.set(key, {
      vatCategory: p.line.vat_category,
      vatRate: p.line.vat_rate,
      net: sumDecimals([sum?.net ?? '0', p.net]),
      vat: sumDecimals([sum?.vat ?? '0', p.vat]),
    })
  }
  const header = {
    kind: creditNoteKindOf(invoice.kind),
    customerId: invoice.customer_id,
    locationId: invoice.location_id,
    eventDate: input.eventDate,
    reason: input.reason,
    reasonText: input.reasonText ?? '',
    creditBy: input.by,
    countedElsewhere: asks ? input.countedElsewhere : null,
    vatRegistered: invoice.vat_registered,
    currency: invoice.currency,
    netTotal: sumDecimals(planned.map((p) => p.net)),
    vatTotal: sumDecimals(planned.map((p) => p.vat)),
    total: sumDecimals(planned.map((p) => p.total)),
    vatRates: invoice.vat_registered ? [...rates.values()] : [],
    notes: input.notes,
  }
  const rows = planned.map((p, position) => ({
    id: newId(),
    businessId: ctx.businessId,
    position,
    invoiceLineId: p.line.id,
    description: p.line.description,
    qty: p.qty,
    unit: p.line.unit,
    unitPrice: p.unitPrice,
    priceIncludesVat: p.line.price_includes_vat,
    discountAmount: p.discountAmount,
    vatCategory: p.line.vat_category,
    vatRate: p.line.vat_rate,
    subtotal: p.subtotal,
    discount: p.discount,
    net: p.net,
    vat: p.vat,
    total: p.total,
  }))
  return { header, rows, planned, counting, today: today?.today ?? input.eventDate }
}

// ---------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------

/** The create's fingerprint: every field as sent. */
function hashOf(input: object): string {
  const rest: Record<string, unknown> = { ...input }
  delete rest.id
  return requestHashOf(rest)
}

/** Answers a replayed create of `id` (by this caller, the same payload), else null. */
async function replayed(tx: Tx, ctx: BusinessCtx, id: string, requestHash: string) {
  await tx.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`credit_note:${id}`}, 0))
  `)
  const [existing] = (await tx.execute(sql`
    select c.request_hash, c.created_by = app.current_user_id() as mine,
           c.deleted_at is not null as discarded
      from app.credit_notes c where c.business_id = ${ctx.businessId} and c.id = ${id}
  `)) as unknown as { request_hash: string | null; mine: boolean; discarded: boolean }[]
  if (!existing) return null
  if (existing.request_hash !== requestHash || !existing.mine || existing.discarded) {
    throw new AppError('conflict')
  }
  return readCreditNote(tx, ctx, id)
}

/** `creditNote.create` (invoices.documents.credit): a draft of an issued invoice; idempotent on `id`. */
export async function createCreditNote(
  ctx: BusinessCtx,
  input: CreateInput,
): Promise<CreditNoteDto> {
  const { id, invoiceId, ...fields } = input
  const requestHash = hashOf(input)
  return ctx.tx(async (tx) => {
    const replay = await replayed(tx, ctx, id, requestHash)
    if (replay) return replay
    const invoice = await lockInvoiceRow(tx, ctx, invoiceId)
    const { header, rows } = await prepare(tx, ctx, invoice, fields)
    await tx.insert(creditNotes).values({
      id,
      businessId: ctx.businessId,
      invoiceId,
      status: 'draft',
      ...header,
      requestHash,
    })
    await tx.insert(creditNoteLines).values(rows.map((row) => ({ ...row, creditNoteId: id })))
    return readCreditNote(tx, ctx, id)
  })
}

async function lockCreditNote(tx: Tx, ctx: BusinessCtx, id: string): Promise<CreditNoteRecord> {
  const [row] = (await tx.execute(sql`
    select c.id from app.credit_notes c
      join app.invoices i on i.business_id = c.business_id and i.id = c.invoice_id
     where ${where([
       sql`c.business_id = ${ctx.businessId}`,
       sql`c.id = ${id}`,
       sql`c.deleted_at is null`,
       ...visibleInvoices(ctx),
     ])}
       for update of c
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
  return creditNoteHeadOf(tx, ctx, id)
}

const byId = (businessId: string, id: string) =>
  and(eq(creditNotes.businessId, businessId), eq(creditNotes.id, id))

/** Replaces a draft's lines (they are always worked out again whole). */
async function replaceLines(
  tx: Tx,
  businessId: string,
  id: string,
  rows: readonly Omit<typeof creditNoteLines.$inferInsert, 'creditNoteId'>[],
) {
  await tx
    .update(creditNoteLines)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(creditNoteLines.businessId, businessId),
        eq(creditNoteLines.creditNoteId, id),
        sql`${creditNoteLines.deletedAt} is null`,
      ),
    )
  if (rows.length > 0) {
    await tx.insert(creditNoteLines).values(rows.map((row) => ({ ...row, creditNoteId: id })))
  }
}

/** `creditNote.update` (a draft, `version` as read): whole. */
export function updateCreditNote(ctx: BusinessCtx, input: UpdateInput): Promise<CreditNoteDto> {
  const { id, version, ...fields } = input
  return ctx.tx(async (tx) => {
    const head = await lockCreditNote(tx, ctx, id)
    if (head.status !== 'draft') throw new AppError('document_posted')
    if (head.version !== version) throw new AppError('conflict')
    const invoice = await lockInvoiceRow(tx, ctx, head.invoice_id)
    const { header, rows } = await prepare(tx, ctx, invoice, fields)
    await tx.update(creditNotes).set(header).where(byId(ctx.businessId, id))
    await replaceLines(tx, ctx.businessId, id, rows)
    return readCreditNote(tx, ctx, id)
  })
}

/** `creditNote.discard` (a draft, `version` as read). It never had a number. */
export function discardCreditNote(ctx: BusinessCtx, input: VersionInput): Promise<{ ok: true }> {
  return ctx.tx(async (tx) => {
    const head = await lockCreditNote(tx, ctx, input.id)
    if (head.status !== 'draft') throw new AppError('document_posted')
    if (head.version !== input.version) throw new AppError('conflict')
    await tx
      .update(creditNotes)
      .set({ deletedAt: sql`now()` })
      .where(byId(ctx.businessId, input.id))
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------------

interface CountedMaterial extends Record<string, unknown> {
  sale_line_id: string
  material_id: string
  base_qty: string
  unit_cost: string | null
  cost: string | null
  basis: SaleMaterialBasis | null
}

interface CountedLine extends Record<string, unknown> {
  id: string
  qty: string
  cost_basis: NewSaleLine['costBasis']
  cost: string | null
  time_minutes: string | null
  time_cost: string | null
}

/** −(value × part ÷ whole), rounded half away from zero to `places`. */
const shareOf = (value: string, part: string, whole: string, places: number) =>
  negate(proportionOf(value, part, whole, places))

/**
 * `creditNote.issue` (invoices.documents.credit; a draft, `version` as read): see above. A repeated
 * issue returns it as issued; a refused one takes no number.
 */
export function issueCreditNote(ctx: BusinessCtx, input: VersionInput): Promise<CreditNoteDto> {
  return ctx.tx(async (tx) => {
    const head = await lockCreditNote(tx, ctx, input.id)
    if (head.status === 'issued') return readCreditNote(tx, ctx, input.id)
    if (head.version !== input.version) throw new AppError('conflict')
    const invoice = await lockInvoiceRow(tx, ctx, head.invoice_id)
    // Its order next: a delivery of it (the work counting, D-305) and this credit note wait for each
    // other, so it counts or bills less as the order stands.
    if (invoice.order_id !== null) {
      await tx.execute(sql`
        select 1 from app.orders o
         where o.business_id = ${ctx.businessId} and o.id = ${invoice.order_id} for share
      `)
    }
    const lines = await creditNoteLinesOf(tx, ctx.businessId, input.id)
    if (lines.length === 0) throw invalid('lines: a credit note needs a line')
    // Worked out again under the invoice's lock: never more than is left now.
    const fields: Fields = {
      eventDate: head.event_date,
      reason: head.reason,
      reasonText: head.reason_text,
      by: head.credit_by,
      // What each line asked: its quantity, or its amount as the line's prices are typed.
      lines: lines.map((l) =>
        head.credit_by === 'quantity'
          ? { invoiceLineId: l.invoice_line_id, qty: l.qty }
          : { invoiceLineId: l.invoice_line_id, amount: l.price_includes_vat ? l.total : l.net },
      ),
      countedElsewhere: head.counted_elsewhere,
      notes: head.notes,
    }
    const { header, rows, planned, counting } = await prepare(tx, ctx, invoice, fields)
    if (header.countedElsewhere === null && creditNoteAsksCountedElsewhere(counting)) {
      throw invalid('countedElsewhere: required')
    }
    const business = await lockPostingBusiness(tx, ctx.businessId)
    if (head.event_date > business.today) throw new AppError('future_date')
    // Its kind follows its invoice's, whatever the registration is now (a tax invoice is credited by a
    // tax credit note).
    const issuing = await issuingBusinessOf(tx, ctx.businessId)
    // Counting once (Q3): a negative sale once the work counted, else it only bills less (D-305).
    const counts = creditNoteCounts(counting, header.countedElsewhere)
    let countedOn: string | null = null
    if (counts) {
      countedOn = reversalDateOf(business, business.today)
      await postNegativeSale(tx, ctx, head, invoice, planned, countedOn, counting.workInvoiceId)
    }
    await tx.update(creditNotes).set(header).where(byId(ctx.businessId, head.id))
    await replaceLines(tx, ctx.businessId, head.id, rows)
    // ER Art. 60(1)(e): the invoice's value of the supply less the credit notes issued before.
    const [earlier] = (await tx.execute(sql`
      select coalesce(array_agg(trim_scale(c.net_total)::text), '{}') as nets,
             trim_scale(coalesce(sum(c.total), 0))::text as totals,
             trim_scale(coalesce(sum(c.rounding_difference), 0))::text as roundings
        from app.credit_notes c
       where c.business_id = ${ctx.businessId} and c.invoice_id = ${invoice.id}
         and c.status = 'issued' and c.deleted_at is null
    `)) as unknown as { nets: string[]; totals: string; roundings: string }[]
    // The one that leaves nothing of the invoice to credit takes back its rounding difference too
    // (D-221: it sits outside every line), so a document taken back whole owes nothing (D-333).
    const roundingDifference =
      compareDecimal(sumDecimals([earlier?.totals ?? '0', header.total]), invoice.total) === 0
        ? subtractDecimals(invoice.rounding_difference, earlier?.roundings ?? '0')
        : '0'
    const currency = isCurrencyCode(invoice.currency) ? invoice.currency : 'AED'
    let values: ReturnType<typeof creditNoteValues>
    try {
      values = creditNoteValues(
        invoice.net_total as Money,
        (earlier?.nets ?? []) as Money[],
        header.netTotal as Money,
        header.vatTotal as Money,
        currency,
      )
    } catch {
      throw new AppError('exceeds_invoice')
    }
    const [customer] = (await tx.execute(sql`
      select c.name, c.kind, c.trn, c.trade_licence_no, c.address_line, c.city, c.emirate,
             trim(c.country) as country
        from app.customers c where c.business_id = ${ctx.businessId} and c.id = ${invoice.customer_id}
    `)) as unknown as {
      name: string
      kind: CustomerKind
      trn: string | null
      trade_licence_no: string | null
      address_line: string | null
      city: string | null
      emirate: Emirate | null
      country: string
    }[]
    if (!customer) throw new AppError('not_found')
    const letterhead = await letterheadNow(tx, ctx.businessId)
    // The LAST lock: the number of the credit notes' own series.
    const { seq, number } = await takeNumber(tx, ctx.businessId, 'credit_note')
    await tx
      .update(creditNotes)
      .set({
        status: 'issued',
        seq,
        number,
        issueDate: business.today,
        countedOn,
        roundingDifference,
        valueBefore: values.valueBefore,
        valueAfter: values.valueAfter,
        issuedAt: sql`now()`,
        issuedBy: sql`app.current_user_id()`,
        customerName: customer.name,
        customerKind: customer.kind,
        customerTrn: customer.trn,
        customerTradeLicence: customer.trade_licence_no,
        customerAddressLine: customer.address_line,
        customerCity: customer.city,
        customerEmirate: customer.emirate,
        customerCountry: customer.country,
        sellerName: issuing.legal_name,
        sellerNameAr: issuing.legal_name_ar,
        sellerTrn: invoice.kind === 'tax_invoice' ? (invoice.seller_trn ?? issuing.trn) : null,
        sellerTradeLicence: issuing.trade_licence_no,
        sellerTradeLicenceAuthority: issuing.trade_licence_authority,
        sellerAddressLine: issuing.address_line,
        sellerCity: issuing.city,
        sellerEmirate: issuing.emirate,
        letterhead,
      })
      .where(byId(ctx.businessId, head.id))
    return readCreditNote(tx, ctx, input.id)
  })
}

/**
 * Posts the credit note's negative sale on `day` (source `credit_note`, how it credits in `refund_by`):
 * each line the mirror of its credit, taking back by quantity the frozen cost of the sale line its
 * invoice line counted in (its materials too, lock 3 for those still without a price), by amount none.
 */
async function postNegativeSale(
  tx: Tx,
  ctx: BusinessCtx,
  head: CreditNoteRecord,
  invoice: InvoiceRecord,
  planned: readonly PlannedLine[],
  day: string,
  workInvoiceId: string | null,
): Promise<void> {
  // The channel: the invoice's sale's, else its order's or sale's, else the business's only one.
  const [found] = (await tx.execute(sql`
    select coalesce(
             (select s.channel_id from app.sales s
               where s.business_id = ${ctx.businessId} and s.invoice_id = ${invoice.id}
                 and s.deleted_at is null limit 1),
             ${invoice.channel_id}::uuid,
             (select o.channel_id from app.orders o
               where o.business_id = ${ctx.businessId} and o.id = ${invoice.order_id}::uuid),
             (select s.channel_id from app.sales s
               where s.business_id = ${ctx.businessId} and s.id = ${invoice.sale_id}::uuid)) as channel_id
  `)) as unknown as { channel_id: string | null }[]
  let channelId = found?.channel_id ?? null
  if (channelId === null) {
    try {
      channelId = (await resolveChannel(tx, ctx.businessId, null, null)).id
    } catch {
      throw new AppError('details_missing', { names: ['channel'] })
    }
  }
  // The sale lines the invoice's lines counted in (their frozen costs). An invoice issued before its
  // order was delivered names none (its lines are frozen): when it copies the order's lines (everything,
  // or a final invoice's work with its deductions), each copy counted in the order's sale line in the
  // same place.
  const saleLineOf = new Map(planned.map((p) => [p.line.id, p.line.sale_line_id] as const))
  if (
    invoice.order_id !== null &&
    planned.some((p) => p.line.sale_line_id === null && p.line.kind !== 'deduction')
  ) {
    const all = await invoiceLinesOf(tx, ctx.businessId, invoice.id)
    const copies =
      invoice.bills === 'everything' ||
      (invoice.bills === 'rest' && all.some((l) => l.kind === 'deduction'))
    if (copies) {
      const orderLines = (await tx.execute(sql`
        select sl.id from app.orders o
          join app.sale_lines sl on sl.business_id = o.business_id and sl.sale_id = o.sale_id
         where o.business_id = ${ctx.businessId} and o.id = ${invoice.order_id}
           and o.status = 'delivered' and sl.deleted_at is null
         order by sl.position, sl.id
      `)) as unknown as { id: string }[]
      const work = all.filter((l) => l.kind !== 'deduction')
      if (orderLines.length === work.length) {
        for (const [i, l] of work.entries()) {
          if (saleLineOf.has(l.id) && saleLineOf.get(l.id) === null) {
            saleLineOf.set(l.id, orderLines[i]!.id)
          }
        }
      }
    }
  }
  // A deposit invoice credited by quantity once its final invoice took it off (D-305: it follows that
  // invoice): its part line names no goods, so it takes back its share of the work the final invoice
  // counted, line by line: that share of each work line's quantity and frozen cost, and of the
  // deposit's amounts (M3 Step 8 review, D-314).
  const shares = new Map<string, WorkShare[]>()
  if (invoice.is_deposit && workInvoiceId !== null) {
    const work = await workLinesOf(tx, ctx.businessId, workInvoiceId)
    for (const p of planned) {
      if (p.takenQty === null || p.line.product_id !== null || p.line.sale_line_id !== null)
        continue
      const share = shareOfWork(
        p,
        work,
        currencyMinorUnit(isCurrencyCode(invoice.currency) ? invoice.currency : 'AED'),
      )
      if (share) shares.set(p.line.id, share)
    }
  }
  const countedIds = [
    ...new Set([
      ...[...saleLineOf.values()].filter((id): id is string => id !== null),
      ...[...shares.values()].flat().map((w) => w.saleLineId),
    ]),
  ]
  let materials: CountedMaterial[] = []
  let counted: CountedLine[] = []
  if (countedIds.length > 0) {
    const read = async () =>
      (await tx.execute(sql`
        select m.sale_line_id, m.material_id, trim_scale(m.base_qty)::text as base_qty,
               trim_scale(m.unit_cost)::text as unit_cost, trim_scale(m.cost)::text as cost, m.basis
          from app.sale_line_materials m
         where m.business_id = ${ctx.businessId} and m.deleted_at is null
           and m.sale_line_id = any(${`{${countedIds.join(',')}}`}::uuid[])
         order by m.sale_line_id, m.id
      `)) as unknown as CountedMaterial[]
    materials = await read()
    const unpriced = [
      ...new Set(materials.filter((m) => m.cost === null).map((m) => m.material_id)),
    ]
    if (unpriced.length > 0) {
      await shareCostRows(tx, ctx.businessId, unpriced)
      materials = await read()
    }
    counted = (await tx.execute(sql`
      select l.id, trim_scale(l.qty)::text as qty, l.cost_basis, trim_scale(l.cost)::text as cost,
             trim_scale(l.time_minutes)::text as time_minutes,
             trim_scale(l.time_cost)::text as time_cost
        from app.sale_lines l
       where l.business_id = ${ctx.businessId} and l.id = any(${`{${countedIds.join(',')}}`}::uuid[])
    `)) as unknown as CountedLine[]
  }
  const countedById = new Map(counted.map((c) => [c.id, c] as const))
  const saleId = newId()
  const saleRows: NewSaleLine[] = []
  const materialRows: Parameters<typeof insertMaterialRows>[1] = []
  let position = 0
  for (const p of planned) {
    const mapped = shares.get(p.line.id)
    if (mapped) {
      for (const w of mapped) {
        const source = countedById.get(w.saleLineId)
        if (!source) continue
        const lineId = newId()
        const own = materials.filter((m) => m.sale_line_id === source.id)
        const rows = own.map((m) => ({
          id: newId(),
          businessId: ctx.businessId,
          saleId,
          saleLineId: lineId,
          materialId: m.material_id,
          baseQty: shareOf(m.base_qty, w.qty, source.qty, QUANTITY_SCALE),
          unitCost: m.unit_cost as UnitCost | null,
          cost: (m.cost === null
            ? null
            : shareOf(m.cost, w.qty, source.qty, 12)) as CostAmount | null,
          basis: m.basis,
        }))
        materialRows.push(...rows)
        saleRows.push({
          id: lineId,
          businessId: ctx.businessId,
          saleId,
          position: position++,
          kind: 'item',
          productId: w.productId,
          description: w.description,
          qty: negate(w.qty),
          unit: w.unit,
          unitPrice: w.unitPrice,
          priceIncludesVat: w.priceIncludesVat,
          discountPercent: null,
          discountAmount: null,
          vatCategory: p.line.vat_category,
          vatRate: p.line.vat_rate,
          subtotal: negate(w.priceIncludesVat ? w.total : w.net),
          discount: '0',
          net: negate(w.net),
          vat: negate(w.vat),
          total: negate(w.total),
          costBasis: source.cost_basis ?? 'none',
          cost:
            source.cost === null
              ? null
              : rows.length > 0
                ? sumDecimals(rows.map((r) => r.cost ?? '0'))
                : shareOf(source.cost, w.qty, source.qty, 12),
          timeMinutes:
            source.time_minutes === null
              ? null
              : shareOf(source.time_minutes, w.qty, source.qty, 12),
          timeCost:
            source.time_cost === null ? null : shareOf(source.time_cost, w.qty, source.qty, 12),
          refundOfLineId: source.id,
        })
      }
      continue
    }
    const lineId = newId()
    const countedIn = saleLineOf.get(p.line.id) ?? null
    const source = countedIn ? countedById.get(countedIn) : undefined
    let cost: string | null = null
    let costBasis: NewSaleLine['costBasis'] = 'none'
    let timeMinutes: string | null = null
    let timeCost: string | null = null
    if (p.line.kind === 'item') {
      if (source && p.takenQty !== null) {
        const q = p.takenQty
        const own = materials.filter((m) => m.sale_line_id === source.id)
        const rows = own.map((m) => ({
          id: newId(),
          businessId: ctx.businessId,
          saleId,
          saleLineId: lineId,
          materialId: m.material_id,
          baseQty: shareOf(m.base_qty, q, source.qty, QUANTITY_SCALE),
          unitCost: m.unit_cost as UnitCost | null,
          cost: (m.cost === null ? null : shareOf(m.cost, q, source.qty, 12)) as CostAmount | null,
          basis: m.basis,
        }))
        materialRows.push(...rows)
        costBasis = source.cost_basis ?? 'none'
        cost =
          source.cost === null
            ? null
            : rows.length > 0
              ? sumDecimals(rows.map((r) => r.cost ?? '0'))
              : shareOf(source.cost, q, source.qty, 12)
        timeMinutes =
          source.time_minutes === null ? null : shareOf(source.time_minutes, q, source.qty, 12)
        timeCost = source.time_cost === null ? null : shareOf(source.time_cost, q, source.qty, 12)
      } else if (p.line.product_id !== null) {
        // A price cut, or a line whose cost was never counted here: it takes back no cost.
        cost = '0'
        costBasis = source?.cost_basis ?? 'none'
      }
    }
    saleRows.push({
      id: lineId,
      businessId: ctx.businessId,
      saleId,
      position: position++,
      kind: p.line.kind === 'delivery' ? 'delivery' : 'item',
      productId: p.line.product_id,
      description: p.line.description,
      qty: negate(p.line.kind === 'delivery' ? '1' : p.qty),
      unit: p.line.kind === 'delivery' ? null : p.line.unit,
      unitPrice: p.unitPrice,
      priceIncludesVat: p.line.price_includes_vat,
      discountPercent: null,
      discountAmount: p.line.kind === 'delivery' ? null : p.discountAmount,
      vatCategory: p.line.vat_category,
      vatRate: p.line.vat_rate,
      subtotal: negate(p.subtotal),
      discount: negate(p.discount),
      net: negate(p.net),
      vat: negate(p.vat),
      total: negate(p.total),
      costBasis,
      cost,
      timeMinutes,
      timeCost,
      refundOfLineId: countedIn,
    })
  }
  await tx.insert(sales).values({
    id: saleId,
    businessId: ctx.businessId,
    source: 'credit_note',
    businessDate: day,
    locationId: invoice.location_id,
    channelId,
    vatRegistered: invoice.vat_registered,
    currency: invoice.currency,
    subtotal: sumDecimals(saleRows.map((r) => r.subtotal ?? '0')),
    discountTotal: sumDecimals(saleRows.map((r) => r.discount ?? '0')),
    netTotal: sumDecimals(saleRows.map((r) => r.net ?? '0')),
    vatTotal: sumDecimals(saleRows.map((r) => r.vat ?? '0')),
    total: sumDecimals(saleRows.map((r) => r.total ?? '0')),
    customerId: invoice.customer_id,
    creditNoteId: head.id,
    refundBy: head.credit_by,
  })
  await tx.insert(saleLines).values(saleRows)
  await insertMaterialRows(tx, materialRows)
  await tx
    .update(sales)
    .set({ status: 'posted', postedAt: sql`now()`, postedBy: sql`app.current_user_id()` })
    .where(and(eq(sales.businessId, ctx.businessId), eq(sales.id, saleId)))
}

/** A work line of a final invoice as counted: its sale line, product and amounts at its rate. */
interface WorkLine {
  readonly saleLineId: string | null
  readonly kind: string
  readonly productId: string | null
  readonly description: string
  readonly qty: string
  readonly unit: StandardUnit | null
  readonly unitPrice: string
  readonly priceIncludesVat: boolean
  readonly vatKey: string
  readonly net: string
}

/** What a deposit's credit takes back of one work line: its quantity and amounts (positive). */
interface WorkShare {
  readonly saleLineId: string
  readonly productId: string | null
  readonly description: string
  readonly qty: string
  readonly unit: StandardUnit | null
  readonly unitPrice: string
  readonly priceIncludesVat: boolean
  readonly net: string
  readonly vat: string
  readonly total: string
}

/**
 * The work lines of a final invoice (its lines but the deductions), each with the sale line it counted
 * in: its own (named at issue), or, for an invoice of an order delivered after it was issued, the
 * order's delivered sale line in the same place.
 */
async function workLinesOf(tx: Tx, businessId: string, invoiceId: string): Promise<WorkLine[]> {
  const lines = (await tx.execute(sql`
    select l.sale_line_id, l.kind, l.product_id, l.description, trim_scale(l.qty)::text as qty,
           l.unit, trim_scale(l.unit_price)::text as unit_price, l.price_includes_vat,
           l.vat_category, trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.net)::text as net,
           i.order_id
      from app.invoice_lines l
      join app.invoices i on i.business_id = l.business_id and i.id = l.invoice_id
     where l.business_id = ${businessId} and l.invoice_id = ${invoiceId} and l.deleted_at is null
       and l.kind <> 'deduction'
     order by l.position, l.id
  `)) as unknown as {
    sale_line_id: string | null
    kind: string
    product_id: string | null
    description: string
    qty: string
    unit: StandardUnit | null
    unit_price: string
    price_includes_vat: boolean
    vat_category: VatCategory | null
    vat_rate: string | null
    net: string
    order_id: string | null
  }[]
  let orderLines: string[] = []
  const orderId = lines[0]?.order_id ?? null
  if (orderId !== null && lines.some((l) => l.sale_line_id === null)) {
    orderLines = (
      (await tx.execute(sql`
        select sl.id from app.orders o
          join app.sale_lines sl on sl.business_id = o.business_id and sl.sale_id = o.sale_id
         where o.business_id = ${businessId} and o.id = ${orderId} and o.status = 'delivered'
           and sl.deleted_at is null
         order by sl.position, sl.id
      `)) as unknown as { id: string }[]
    ).map((r) => r.id)
  }
  const matched = orderLines.length === lines.length
  return lines.map((l, i) => ({
    saleLineId: l.sale_line_id ?? (matched ? orderLines[i]! : null),
    kind: l.kind,
    productId: l.product_id,
    description: l.description,
    qty: l.qty,
    unit: l.unit,
    unitPrice: l.unit_price,
    priceIncludesVat: l.price_includes_vat,
    vatKey: rateKey({ vatCategory: l.vat_category, vatRate: l.vat_rate }),
    net: l.net,
  }))
}

/**
 * The share of the work at its rate that a deposit's credit line takes back: the work's goods lines
 * each give the fraction (the line's net ÷ the work's net at the rate) of their quantity, and get
 * that share of the line's net, VAT and total (largest remainder). Null when the work has no goods
 * line counted at that rate, or a share would be no quantity at all.
 */
function shareOfWork(
  p: PlannedLine,
  work: readonly WorkLine[],
  digits: number,
): WorkShare[] | null {
  const key = rateKey({ vatCategory: p.line.vat_category, vatRate: p.line.vat_rate })
  const atRate = work.filter((w) => w.vatKey === key)
  const workNet = sumDecimals(atRate.map((w) => w.net))
  const goods = atRate.filter(
    (w) => w.kind === 'item' && w.saleLineId !== null && compareDecimal(w.net, '0') > 0,
  )
  if (goods.length === 0 || compareDecimal(workNet, '0') <= 0) return null
  const qtys = goods.map((w) => proportionOf(w.qty, p.net, workNet, QUANTITY_SCALE))
  if (qtys.some((q) => compareDecimal(q, '0') === 0)) return null
  const weights = goods.map((w) => w.net)
  const nets = splitByWeights(p.net, weights, digits)
  const vats = splitByWeights(p.vat, weights, digits)
  return goods.map((w, k) => ({
    saleLineId: w.saleLineId!,
    productId: w.productId,
    description: w.description,
    qty: qtys[k]!,
    unit: w.unit,
    unitPrice: w.unitPrice,
    priceIncludesVat: w.priceIncludesVat,
    net: nets[k]!,
    vat: vats[k]!,
    total: sumDecimals([nets[k]!, vats[k]!]),
  }))
}

// ---------------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------------

/** `creditNote.history`: created, edited, issued, discarded; who and when from the audit log. */
export function creditNoteHistory(ctx: BusinessCtx, input: IdInput): Promise<CreditNoteHistoryDto> {
  return ctx.tx(async (tx) => {
    const head = await creditNoteHeadOf(tx, ctx, input.id)
    const rows = (await tx.execute(sql`
      with audit as (
        select a.actor_user_id, a.created_at, a.action from app.audit_log a
         where a.business_id = ${ctx.businessId} and a.entity = 'credit_notes'
           and a.entity_id = ${head.id}
      ),
      cn as (select c.* from app.credit_notes c where c.business_id = ${ctx.businessId} and c.id = ${head.id}),
      events as (
        select 'created'::text as kind, c.created_at as at, c.created_by as by_user, null::text as reference from cn c
        union all
        select 'edited', a.created_at, a.actor_user_id, null
          from cn c join audit a on a.action = 'update'
         where a.created_at > c.created_at
           and a.created_at < coalesce(c.issued_at, c.deleted_at, 'infinity'::timestamptz)
        union all
        select 'issued', c.issued_at, c.issued_by, c.number from cn c where c.issued_at is not null
        union all
        select 'discarded', c.deleted_at,
               (select a.actor_user_id from audit a where a.created_at = c.deleted_at limit 1), null
          from cn c where c.deleted_at is not null
      )
      select e.kind, e.at, e.reference,
             (select bm.display_name from app.business_members bm
               where bm.business_id = ${ctx.businessId} and bm.user_id = e.by_user
                 and bm.kind = 'account'
               order by (bm.status = 'active') desc, bm.created_at desc limit 1) as by_name
        from events e
       order by e.at desc, e.kind
       limit ${INVOICE_HISTORY_MAX}
    `)) as unknown as {
      kind: CreditNoteEventKind
      at: Date | string
      reference: string | null
      by_name: string | null
    }[]
    const team = ctx.access.capabilities.has_team
    return {
      events: rows.map((row) => ({
        kind: row.kind,
        at: isoOf(row.at),
        byName: team ? row.by_name : null,
        reference: row.reference,
      })),
    }
  })
}
