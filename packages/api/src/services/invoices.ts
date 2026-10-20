import {
  INVOICE_HISTORY_MAX,
  type createInvoiceInput,
  type DepositsWithoutInvoiceDto,
  type invoiceCopyToQuotationInput,
  type InvoiceDto,
  type InvoiceEventKind,
  type invoiceFromOrderInput,
  type invoiceFromQuotationInput,
  type invoiceFromSaleInput,
  type InvoiceHistoryDto,
  type invoiceIdInput,
  type InvoiceLineDto,
  type invoiceListInput,
  type InvoiceListDto,
  type InvoicePartyDto,
  type invoiceVersionInput,
  type ISSUE_MISSING,
  type ISSUE_WARNINGS,
  type QuotationDto,
  type updateInvoiceInput,
} from '@bizcost/contracts'
import { invoiceLines, invoices, saleLines, sales, type Tx } from '@bizcost/db'
import {
  applyDeductions,
  billingError,
  billPart,
  compareDecimal,
  deductionsOf,
  derivedId,
  groupByArea,
  invoiceAsksCountedElsewhere,
  invoiceCounts,
  invoiceCreditState,
  invoiceKindFor,
  invoiceOverdue,
  newId,
  partOfRates,
  phoneLast4,
  rateKey,
  restOfRates,
  subtractDecimals,
  sumDecimals,
  taxDocumentDueBy,
  taxDocumentLate,
  TAX_INVOICE_CURRENCY,
  type CustomerKind,
  type DocumentRate,
  type Emirate,
  type InvoiceBills,
  type InvoiceKind,
  type InvoiceLineKind,
  type InvoiceStatus,
  type Money,
  type Percent,
  type SaleAmounts,
  type SaleLineAmounts,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { resources, type Messages } from '@bizcost/i18n'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertModuleActive, assertPermission } from '../trpc'
import { detachAll } from './attachments'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { resolveCustomer, seesCustomers } from './customers'
import { linePictureUrls, removeDocumentObjects } from './document-files'
import { takeNumber } from './numbering'
import { visibleOrders } from './orders'
import { resolveLocation } from './purchases'
import { createQuotation } from './quotations'
import { obligationsOf as obligationsSubquery, paymentStateOf, readObligation } from './receivables'
import {
  assertInScope,
  discountOf,
  freezeAndPost,
  lineValues,
  productsOf,
  resolveChannel,
  roundedAmountsOf,
  saleContextOf,
  seesPayments,
  toLineDiscount,
  totalsOf,
  visibleTo,
  type InputLine,
  type PricedLine,
  type StoredVat,
} from './sales'
import { isoOf, lockPostingBusiness, reversalDateOf, uuidArray } from './stock'

// Invoices (ROADMAP.md M3 Step 8; DATA_MODEL.md §6; the owner's answers Q3, Q17, Q22, Q24–Q27 of
// D-218). Module `invoices` (planned until Release B, M3 Step 9: served under the dev-only preview,
// D-125). `invoices.documents.view` sees every invoice of the business within one's branches (Q12; one
// out of sight is NOT_FOUND); `.manage` prepares drafts (from scratch, an accepted quotation, an order
// or a recorded sale) and copies one to a quotation; `.issue` issues (the router checks the keys).
//
// A draft has no number. Issuing (one transaction) takes the gapless number of the series `invoice`
// LAST (numbering.ts: a replayed issue is answered from the issued invoice before a number is taken; a
// refused issue rolls back and takes none), dates it today (numbers and dates rise together), sets its
// kind by the VAT registration (Q26: a tax invoice in AED, or a plain invoice) and freezes the seller's
// and the customer's particulars (D-002). Counting once (Q3): issuing posts its sale on its supply date
// (sales of source `invoice`, its cost frozen then, D-222) unless its order, its sale, the final invoice
// or recorded sales count it; closed books never block an issue (H5): only its sale moves to the first
// open day (`counted_on`), and when the books are closed through today the issue waits (BOOKS_CLOSED).
//
// Billing (Q22): a draft made from a source bills everything (nothing billed yet), a part (a stage or
// a deposit: one line per VAT rate, priced with VAT, its VAT rounded on the running total of the parts,
// documents/invoice.ts) or the rest (what is left of each rate exactly; after deposit invoices, the
// source's lines with one deduction per deposit invoice and rate, so VAT is charged once). A draft made
// from a source keeps its lines; issuing checks the source again under its lock (CONFLICT when it
// changed since the draft was made).
//
// Lock order: the invoice (FOR UPDATE: a replayed issue waits here and is answered from the issued
// invoice), its source (the quotation's first revision, the order or the sale, FOR UPDATE), the business
// row (FOR SHARE), the cost rows of what its sale sold (posting), the counter LAST.

type CreateInput = z.output<typeof createInvoiceInput>
type UpdateInput = z.output<typeof updateInvoiceInput>
type IdInput = z.output<typeof invoiceIdInput>
type VersionInput = z.output<typeof invoiceVersionInput>
type FromQuotationInput = z.output<typeof invoiceFromQuotationInput>
type FromOrderInput = z.output<typeof invoiceFromOrderInput>
type FromSaleInput = z.output<typeof invoiceFromSaleInput>
type CopyToQuotationInput = z.output<typeof invoiceCopyToQuotationInput>
type ListInput = z.output<typeof invoiceListInput>
type ScratchLine = CreateInput['lines'][number]
type Missing = (typeof ISSUE_MISSING)[number]
type Warning = (typeof ISSUE_WARNINGS)[number]

const invalid = (message: string) => new AppError('validation', { message })
const where = (parts: readonly SQL[]) => sql.join([...parts], sql` and `)
const zero = (value: string) => compareDecimal(value, '0') === 0
/** A decimal as people write it: no trailing zeros ("30.000000" → "30"). */
const trimZeros = (value: string) =>
  value.includes('.') ? value.replace(/0+$/, '').replace(/.$/, '') : value

/** The invoices the caller may see (alias `i`): within their branches when limited (Q12). */
export function visibleInvoices(ctx: BusinessCtx, alias = 'i'): SQL[] {
  const scope = ctx.access.locationScope
  return scope.all ? [] : [sql`${sql.raw(alias)}.location_id = any(${uuidArray([...scope.ids])})`]
}

/** A member's name in the business now (null for a user who is no member). */
const memberName = (user: SQL) => sql`(
  select bm.display_name from app.business_members bm
   where bm.business_id = i.business_id and bm.user_id = ${user} and bm.kind = 'account'
   order by (bm.status = 'active') desc, bm.created_at desc
   limit 1)`

/** Today in the business's time zone. */
const TODAY = sql`(select (now() at time zone b.timezone)::date from app.businesses b
  where b.id = i.business_id)`

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

export interface InvoiceRecord extends Record<string, unknown> {
  id: string
  seq: number | null
  number: string | null
  kind: InvoiceKind
  status: InvoiceStatus
  customer_id: string
  live_name: string
  live_kind: CustomerKind
  live_phone: string | null
  live_trn: string | null
  live_licence: string | null
  live_address: string | null
  live_city: string | null
  live_emirate: Emirate | null
  live_country: string
  location_id: string
  location_name: string
  channel_id: string | null
  issue_date: string | null
  supply_date: string | null
  due_date: string | null
  lpo_reference: string | null
  vat_registered: boolean
  currency: string
  quotation_id: string | null
  quotation_number: string | null
  quotation_root_id: string | null
  order_id: string | null
  order_number: string | null
  sale_id: string | null
  bills: InvoiceBills
  bill_percent: string | null
  bill_amount: string | null
  bill_stage: number | null
  is_deposit: boolean
  site: string | null
  counted_elsewhere: boolean | null
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
  vat_rates: InvoiceDto['vatRates']
  terms: string | null
  notes: string | null
  counted_on: string | null
  issued_at: Date | string | null
  /** issued_at as Postgres prints it (to the microsecond): "as it stood at its issue". */
  issued_at_text: string | null
  /** Its order's delivery day, once delivered (its sale counted then, Q3). */
  order_delivered_on: string | null
  customer_name: string | null
  customer_phone: string | null
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
  letterhead: Record<string, unknown> | null
  pdf_upload_id: string | null
  credited: string
  has_recorded_sales: boolean
  today: string
  entered_by_name: string | null
  mine: boolean
  created_at: Date | string
  updated_at: Date | string
  version: number
}

const HEAD_COLUMNS = sql`
  i.id, i.seq, i.number, i.kind, i.status, i.customer_id, cu.name as live_name, cu.kind as live_kind,
  cu.phone as live_phone, cu.trn as live_trn, cu.trade_licence_no as live_licence,
  cu.address_line as live_address, cu.city as live_city, cu.emirate as live_emirate,
  trim(cu.country) as live_country, i.location_id, l.name as location_name, i.channel_id,
  i.issue_date::text as issue_date, i.supply_date::text as supply_date, i.due_date::text as due_date,
  i.lpo_reference, i.vat_registered, trim(i.currency) as currency, i.quotation_id,
  q.number as quotation_number, q.root_id as quotation_root_id, i.order_id, o.number as order_number,
  i.sale_id, i.bills, trim_scale(i.bill_percent)::text as bill_percent,
  trim_scale(i.bill_amount)::text as bill_amount, i.bill_stage, i.is_deposit, i.site,
  i.counted_elsewhere,
  trim_scale(i.discount_percent)::text as discount_percent,
  trim_scale(i.discount_amount)::text as discount_amount, trim_scale(i.round_to)::text as round_to,
  trim_scale(i.adjustment)::text as adjustment,
  trim_scale(i.rounding_difference)::text as rounding_difference,
  trim_scale(i.subtotal)::text as subtotal, trim_scale(i.discount_total)::text as discount_total,
  trim_scale(i.net_total)::text as net_total, trim_scale(i.vat_total)::text as vat_total,
  trim_scale(i.total)::text as total, trim_scale(i.payable)::text as payable, i.vat_rates, i.terms,
  i.notes, i.counted_on::text as counted_on, i.issued_at, i.issued_at::text as issued_at_text,
  case when o.status = 'delivered' then o.delivered_on::text end as order_delivered_on,
  i.customer_name, i.customer_phone, i.customer_kind,
  i.customer_trn, i.customer_trade_licence, i.customer_address_line, i.customer_city,
  i.customer_emirate, trim(i.customer_country) as customer_country, i.seller_name, i.seller_name_ar,
  i.seller_trn, i.seller_trade_licence, i.seller_trade_licence_authority, i.seller_address_line,
  i.seller_city, i.seller_emirate, i.letterhead, i.pdf_upload_id,
  trim_scale(coalesce((select sum(c.total) from app.credit_notes c
     where c.business_id = i.business_id and c.invoice_id = i.id and c.status = 'issued'
       and c.deleted_at is null), 0))::text as credited,
  exists (select 1 from app.sales s
           where s.business_id = i.business_id and s.status = 'posted' and s.deleted_at is null
             and s.source in ('day_sheet', 'single', 'import')) as has_recorded_sales,
  ${TODAY}::text as today, ${memberName(sql`i.created_by`)} as entered_by_name,
  i.created_by = app.current_user_id() as mine, i.created_at, i.updated_at, i.version`

const HEAD_FROM = sql`
  from app.invoices i
  join app.customers cu on cu.business_id = i.business_id and cu.id = i.customer_id
  join app.locations l on l.business_id = i.business_id and l.id = i.location_id
  left join app.quotations q on q.business_id = i.business_id and q.id = i.quotation_id
  left join app.orders o on o.business_id = i.business_id and o.id = i.order_id`

/** The invoice (NOT_FOUND unless a live one of this business the caller may see). */
export async function invoiceHeadOf(tx: Tx, ctx: BusinessCtx, id: string): Promise<InvoiceRecord> {
  const [head] = (await tx.execute(sql`
    select ${HEAD_COLUMNS} ${HEAD_FROM}
     where ${where([
       sql`i.business_id = ${ctx.businessId}`,
       sql`i.id = ${id}`,
       sql`i.deleted_at is null`,
       ...visibleInvoices(ctx),
     ])}
  `)) as unknown as InvoiceRecord[]
  if (!head) throw new AppError('not_found')
  return head
}

export interface InvoiceLineRecord extends Record<string, unknown> {
  id: string
  position: number
  kind: InvoiceLineKind
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
  deposit_invoice_id: string | null
  deposit_number: string | null
  sale_line_id: string | null
  credited_qty: string
  credited_net: string
  credited_vat: string
  credited_total: string
  picture_id: string | null
  picture_path: string | null
  picture_name: string | null
}

/** An invoice's live lines in order, with what issued credit notes took of each and its picture. */
export async function invoiceLinesOf(tx: Tx, businessId: string, invoiceId: string) {
  return (await tx.execute(sql`
    select l.id, l.position, l.kind, l.product_id, l.area, l.description, l.details, l.note,
           trim_scale(l.qty)::text as qty, l.unit, trim_scale(l.unit_price)::text as unit_price,
           l.price_includes_vat, trim_scale(l.discount_percent)::text as discount_percent,
           trim_scale(l.discount_amount)::text as discount_amount, l.vat_category,
           trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.subtotal)::text as subtotal,
           trim_scale(l.discount)::text as discount, trim_scale(l.net)::text as net,
           trim_scale(l.vat)::text as vat, trim_scale(l.total)::text as total,
           l.deposit_invoice_id, dep.number as deposit_number, l.sale_line_id,
           trim_scale(coalesce(c.qty, 0))::text as credited_qty,
           trim_scale(coalesce(c.net, 0))::text as credited_net,
           trim_scale(coalesce(c.vat, 0))::text as credited_vat,
           trim_scale(coalesce(c.total, 0))::text as credited_total,
           p.id as picture_id, p.path as picture_path, p.file_name as picture_name
      from app.invoice_lines l
      left join app.invoices dep on dep.business_id = l.business_id and dep.id = l.deposit_invoice_id
      left join (
        select cl.invoice_line_id,
               sum(cl.qty) filter (where cn.credit_by = 'quantity') as qty,
               sum(cl.net) as net, sum(cl.vat) as vat, sum(cl.total) as total
          from app.credit_note_lines cl
          join app.credit_notes cn on cn.business_id = cl.business_id and cn.id = cl.credit_note_id
         where cl.business_id = ${businessId} and cn.invoice_id = ${invoiceId}
           and cn.status = 'issued' and cn.deleted_at is null and cl.deleted_at is null
         group by cl.invoice_line_id
      ) c on c.invoice_line_id = l.id
      left join lateral (
        select a.id, a.path, a.file_name from app.attachments a
         where a.business_id = l.business_id and a.entity = 'invoice_line' and a.entity_id = l.id
           and a.deleted_at is null
         order by a.created_at, a.id
         limit 1
      ) p on true
     where l.business_id = ${businessId} and l.invoice_id = ${invoiceId} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as InvoiceLineRecord[]
}

/** What the business is now, for an issue's checks and a draft's notes. */
export interface IssuingBusiness extends Record<string, unknown> {
  legal_name: string
  legal_name_ar: string | null
  default_locale: string
  vat_registered: boolean
  trn: string | null
  currency: string
  address_line: string | null
  city: string | null
  emirate: Emirate | null
  trade_licence_no: string | null
  trade_licence_authority: string | null
  active_channels: number
}

export async function issuingBusinessOf(tx: Tx, businessId: string): Promise<IssuingBusiness> {
  const [row] = (await tx.execute(sql`
    select b.legal_name, b.legal_name_ar, b.default_locale, b.vat_registered, b.trn,
           trim(b.currency) as currency, b.address_line, b.city, b.emirate, b.trade_licence_no,
           b.trade_licence_authority,
           (select count(*)::int from app.sales_channels c
             where c.business_id = b.id and c.deleted_at is null and c.archived_at is null)
             as active_channels
      from app.businesses b where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as IssuingBusiness[]
  if (!row) throw new AppError('forbidden')
  return row
}

const present = (value: string | null) => value !== null && value.trim() !== ''

/** Who makes the invoice count once (Q3). */
function countingOf(
  head: Pick<
    InvoiceRecord,
    'order_id' | 'sale_id' | 'is_deposit' | 'counted_elsewhere' | 'has_recorded_sales'
  >,
) {
  const base = {
    fromOrder: head.order_id !== null,
    fromSale: head.sale_id !== null,
    isDeposit: head.is_deposit,
  }
  return {
    asks: invoiceAsksCountedElsewhere({ ...base, hasRecordedSales: head.has_recorded_sales }),
    counts: invoiceCounts({ ...base, countedElsewhere: head.counted_elsewhere }),
  }
}

/**
 * The customer as printed: frozen once issued (the document's particulars), live on a draft. A draft's
 * live particulars (TRN, trade licence, address) only for a member who sees customers (D-263): one who
 * names a customer without customers.items.view gets their name and kind (M3 Step 8 review, D-313).
 */
export function customerOf(head: InvoiceRecord, seesDetails: boolean): InvoicePartyDto {
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

function sellerOf(head: InvoiceRecord): InvoicePartyDto | null {
  if (head.status !== 'issued' || head.seller_name === null) return null
  return {
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
}

/**
 * What would stop an issue (`missing`, DETAILS_MISSING: the business's TRN and address and AED for a
 * tax invoice, a VAT-registered customer's address, B16, C5; a channel for its sale when the business
 * has several) and what only warns (PINT-AE IBR-143-AE and IBR-144-AE, which bind from the connector
 * milestone; a supply more than 14 days old, VAT DL Art. 67(1)).
 */
export function issueChecks(
  business: IssuingBusiness,
  customer: InvoicePartyDto,
  invoice: {
    readonly supplyDate: string
    readonly counts: boolean
    readonly channelId: string | null
  },
  today: string,
): { missing: Missing[]; warnings: Warning[] } {
  const missing: Missing[] = []
  const warnings: Warning[] = []
  if (business.vat_registered) {
    if (!present(business.trn)) missing.push('business_trn')
    if (!present(business.address_line) && !present(business.city)) missing.push('business_address')
    if (business.currency !== TAX_INVOICE_CURRENCY) missing.push('currency_aed')
    if (present(customer.trn) && !present(customer.addressLine) && !present(customer.city)) {
      missing.push('customer_address')
    }
    if (!present(business.address_line) || !present(business.city) || business.emirate === null) {
      warnings.push('ibr_143_ae')
    }
    if (taxDocumentLate(invoice.supplyDate, today)) warnings.push('late')
  }
  if (
    (customer.kind === 'business' || customer.kind === 'government') &&
    (!present(customer.addressLine) || !present(customer.city) || customer.emirate === null)
  ) {
    warnings.push('ibr_144_ae')
  }
  if (invoice.counts && invoice.channelId === null && business.active_channels > 1) {
    missing.push('channel')
  }
  return { missing, warnings }
}

function lineDto(line: InvoiceLineRecord): InvoiceLineDto {
  const deduction = line.kind === 'deduction'
  const credited = {
    qty: line.credited_qty,
    net: line.credited_net,
    vat: line.credited_vat,
    total: line.credited_total,
  }
  return {
    id: line.id,
    kind: line.kind,
    productId: line.product_id,
    typed: line.product_id === null,
    area: line.area,
    description: line.description,
    details: line.details,
    note: line.note,
    qty: line.qty,
    unit: line.unit,
    unitPrice: line.unit_price,
    priceIncludesVat: line.price_includes_vat,
    discount: discountOf(line.discount_percent, line.discount_amount),
    vatCategory: line.vat_category,
    vatRate: line.vat_rate,
    subtotal: line.subtotal,
    lineDiscount: line.discount,
    net: line.net,
    vat: line.vat,
    total: line.total,
    depositInvoiceId: line.deposit_invoice_id,
    depositInvoiceNumber: line.deposit_number,
    credited,
    left: deduction
      ? { qty: '0', net: '0', vat: '0', total: '0' }
      : {
          qty: subtractDecimals(line.qty, line.credited_qty),
          net: subtractDecimals(line.net, line.credited_net),
          vat: subtractDecimals(line.vat, line.credited_vat),
          total: subtractDecimals(line.total, line.credited_total),
        },
    picture:
      line.picture_id === null
        ? null
        : { id: line.picture_id, fileName: line.picture_name ?? '', url: line.picture_path },
  }
}

interface ReadInvoice {
  readonly dto: InvoiceDto
  readonly picturePaths: readonly string[]
}

/** The invoice as the API returns it (its pictures' URLs still unsigned). */
export async function readInvoice(tx: Tx, ctx: BusinessCtx, id: string): Promise<ReadInvoice> {
  const head = await invoiceHeadOf(tx, ctx, id)
  const lines = await invoiceLinesOf(tx, ctx.businessId, id)
  const creditNotes = (await tx.execute(sql`
    select c.id, c.number, c.status, c.issue_date::text as issue_date,
           trim_scale(c.total)::text as total
      from app.credit_notes c
     where c.business_id = ${ctx.businessId} and c.invoice_id = ${id} and c.deleted_at is null
     order by c.seq nulls last, c.created_at
  `)) as unknown as {
    id: string
    number: string | null
    status: InvoiceStatus
    issue_date: string | null
    total: string
  }[]
  const issued = head.status === 'issued'
  const obligation =
    issued && seesPayments(ctx) ? await readObligation(tx, ctx.businessId, 'invoice', id) : null
  const payment = obligation ? paymentStateOf(obligation) : null
  const counting = countingOf(head)
  const customer = customerOf(head, seesCustomers(ctx))
  // A draft left empty is dated as its issue would date it now (its 14-day note, VAT DL Art. 67(1)).
  const supply =
    head.supply_date ??
    head.issue_date ??
    (await sourceSupplyDayOf(
      tx,
      ctx.businessId,
      { orderId: head.order_id, saleId: head.sale_id },
      head.is_deposit,
      head.today,
    )) ??
    head.today
  const checks = issued
    ? { missing: [] as Missing[], warnings: [] as Warning[] }
    : issueChecks(
        await issuingBusinessOf(tx, ctx.businessId),
        customerOf(head, true),
        { supplyDate: supply, counts: counting.counts, channelId: head.channel_id },
        head.today,
      )
  const team = ctx.access.capabilities.has_team
  const dto: InvoiceDto = {
    id: head.id,
    number: head.number,
    seq: head.seq,
    kind: head.kind,
    status: head.status,
    customerId: head.customer_id,
    customerPhoneLast4: phoneLast4(head.live_phone),
    customer,
    seller: sellerOf(head),
    locationId: head.location_id,
    locationName: head.location_name,
    channelId: head.channel_id,
    issueDate: head.issue_date,
    supplyDate: head.supply_date,
    dueDate: head.due_date,
    lpoReference: head.lpo_reference,
    vatRegistered: head.vat_registered,
    currency: head.currency,
    quotationId: head.quotation_id,
    quotationNumber: head.quotation_number,
    orderId: head.order_id,
    orderNumber: head.order_number,
    orderDeliveredOn: head.order_delivered_on,
    saleId: head.sale_id,
    site: head.site,
    billStage: head.bill_stage,
    bills: head.bills,
    part:
      head.bill_percent !== null
        ? { percent: head.bill_percent }
        : head.bill_amount !== null
          ? { amount: head.bill_amount }
          : null,
    isDeposit: head.is_deposit,
    countedElsewhere: head.counted_elsewhere,
    asksCountedElsewhere: counting.asks,
    counts: issued ? head.counted_on !== null : counting.counts,
    countedOn: head.counted_on,
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
    terms: head.terms,
    notes: head.notes,
    lines: lines.map(lineDto),
    creditNotes: creditNotes.map((c) => ({
      id: c.id,
      number: c.number,
      status: c.status,
      issueDate: c.issue_date,
      total: c.total,
    })),
    credited: head.credited,
    creditState: invoiceCreditState(head.total, head.credited),
    payment,
    overdue: payment ? invoiceOverdue(head.due_date, payment.owed, head.today) : null,
    taxInvoiceDueBy: head.kind === 'tax_invoice' ? taxDocumentDueBy(supply) : null,
    missing: checks.missing,
    warnings: checks.warnings,
    pdfStored: head.pdf_upload_id !== null,
    issuedAt: isoOf(head.issued_at),
    enteredByName: team ? head.entered_by_name : null,
    mine: head.mine,
    createdAt: isoOf(head.created_at),
    version: head.version,
  }
  return { dto, picturePaths: lines.flatMap((l) => (l.picture_path ? [l.picture_path] : [])) }
}

/** Signs the lines' picture URLs (after the transaction: Storage is never called inside one). */
async function signed(ctx: BusinessCtx, read: ReadInvoice): Promise<InvoiceDto> {
  if (read.picturePaths.length === 0) return read.dto
  const urls = await linePictureUrls(ctx, read.picturePaths, 'invoice_line')
  return {
    ...read.dto,
    lines: read.dto.lines.map((line) =>
      line.picture
        ? { ...line, picture: { ...line.picture, url: urls.get(line.picture.url ?? '') ?? null } }
        : line,
    ),
  }
}

/** `invoice.get`. */
export async function getInvoice(ctx: BusinessCtx, input: IdInput): Promise<InvoiceDto> {
  return signed(ctx, await ctx.tx((tx) => readInvoice(tx, ctx, input.id)))
}

/** The list's order (one text, ascending): drafts first by when made, then issued, newest first. */
const SORT_KEY = sql`case when i.status = 'draft'
    then '0|' || to_char(i.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
    else '1|' || lpad((999999999999 - i.seq)::text, 12, '0') end`

/**
 * `invoice.list`: drafts first (newest), then issued ones by number, newest first; filters by status
 * (owed, overdue and paid: what each still owes, with payments.customers.view, FORBIDDEN otherwise),
 * customer, order or quotation; a search in the number, the LPO and the customer's name.
 */
export function listInvoices(ctx: BusinessCtx, input: ListInput): Promise<InvoiceListDto> {
  const paymentsSeen = seesPayments(ctx)
  if (['owed', 'overdue', 'paid'].includes(input.status) && !paymentsSeen) {
    throw new AppError('forbidden', { message: 'what an invoice owes needs payments seen' })
  }
  const filters: SQL[] = [
    sql`i.business_id = ${ctx.businessId}`,
    sql`i.deleted_at is null`,
    ...visibleInvoices(ctx),
  ]
  if (input.status === 'draft') filters.push(sql`i.status = 'draft'`)
  else if (input.status !== 'all') filters.push(sql`i.status = 'issued'`)
  if (input.status === 'owed') filters.push(sql`coalesce(d.left_n, 0) > 0`)
  if (input.status === 'paid') filters.push(sql`coalesce(d.left_n, 0) <= 0`)
  if (input.status === 'overdue') {
    filters.push(sql`coalesce(d.left_n, 0) > 0 and i.due_date < ${TODAY}`)
  }
  if (input.status === 'credited') {
    filters.push(sql`exists (select 1 from app.credit_notes c
      where c.business_id = i.business_id and c.invoice_id = i.id and c.status = 'issued'
        and c.deleted_at is null)`)
  }
  if (input.customerId) filters.push(sql`i.customer_id = ${input.customerId}`)
  if (input.orderId) filters.push(sql`i.order_id = ${input.orderId}`)
  if (input.quotationId) {
    filters.push(sql`i.quotation_id in (select r.id from app.quotations r
      where r.business_id = i.business_id and r.root_id = (
        select x.root_id from app.quotations x where x.business_id = i.business_id
           and x.id = ${input.quotationId}))`)
  }
  if (input.search) {
    const pattern = containsPattern(input.search)
    filters.push(sql`(i.number ilike ${pattern} or i.lpo_reference ilike ${pattern}
      or cu.name ilike ${pattern})`)
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    filters.push(sql`(${SORT_KEY}, i.id) > (${cursor.key}, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    await assertListed(tx, ctx.businessId, {
      customers: input.customerId,
      orders: input.orderId,
      quotations: input.quotationId,
    })
    const rows = (await tx.execute(sql`
      select ${SORT_KEY} as sort_key, i.id, i.number, i.kind, i.status, i.customer_id,
             coalesce(i.customer_name, cu.name) as customer_name,
             i.issue_date::text as issue_date, i.supply_date::text as supply_date,
             i.due_date::text as due_date, i.lpo_reference, trim(i.currency) as currency,
             trim_scale(i.payable)::text as payable, trim_scale(i.total)::text as total,
             i.is_deposit, i.bill_stage, i.order_id,
             o.number as order_number, i.quotation_id, q.number as quotation_number,
             (select count(*)::int from app.invoice_lines l
               where l.business_id = i.business_id and l.invoice_id = i.id
                 and l.deleted_at is null) as line_count,
             array(select l.description from app.invoice_lines l
                    where l.business_id = i.business_id and l.invoice_id = i.id
                      and l.deleted_at is null and l.kind <> 'deduction'
                    order by l.position, l.id limit 2) as line_titles,
             trim_scale(coalesce((select sum(c.total) from app.credit_notes c
                where c.business_id = i.business_id and c.invoice_id = i.id
                  and c.status = 'issued' and c.deleted_at is null), 0))::text as credited,
             trim_scale(greatest(d.left_n, 0))::text as owed,
             trim_scale(d.total_n)::text as ob_total, trim_scale(d.credited_n)::text as ob_credited,
             trim_scale(d.paid_n - d.refunded_n)::text as ob_paid,
             ${memberName(sql`i.created_by`)} as entered_by_name,
             i.created_by = app.current_user_id() as mine, i.created_at, i.version,
             ${TODAY}::text as today
        from app.invoices i
        join app.customers cu on cu.business_id = i.business_id and cu.id = i.customer_id
        left join app.orders o on o.business_id = i.business_id and o.id = i.order_id
        left join app.quotations q on q.business_id = i.business_id and q.id = i.quotation_id
        left join ${obligationsSubquery(ctx.businessId)} d on d.kind = 'invoice' and d.id = i.id
       where ${where(filters)}
       order by ${SORT_KEY}, i.id
       limit ${input.limit + 1}
    `)) as unknown as {
      sort_key: string
      id: string
      number: string | null
      kind: InvoiceKind
      status: InvoiceStatus
      customer_id: string
      customer_name: string
      issue_date: string | null
      supply_date: string | null
      due_date: string | null
      lpo_reference: string | null
      currency: string
      payable: string
      total: string
      is_deposit: boolean
      bill_stage: number | null
      order_id: string | null
      order_number: string | null
      quotation_id: string | null
      quotation_number: string | null
      line_count: number
      line_titles: string[]
      credited: string
      owed: string | null
      ob_total: string | null
      ob_credited: string | null
      ob_paid: string | null
      entered_by_name: string | null
      mine: boolean
      created_at: Date | string
      version: number
      today: string
    }[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    const team = ctx.access.capabilities.has_team
    return {
      items: page.map((r) => {
        const issued = r.status === 'issued' && paymentsSeen && r.owed !== null
        return {
          id: r.id,
          number: r.number,
          kind: r.kind,
          status: r.status,
          customerId: r.customer_id,
          customerName: r.customer_name,
          issueDate: r.issue_date,
          supplyDate: r.supply_date,
          dueDate: r.due_date,
          lpoReference: r.lpo_reference,
          currency: r.currency,
          payable: r.payable,
          lineCount: r.line_count,
          lineTitles: r.line_titles,
          isDeposit: r.is_deposit,
          billStage: r.bill_stage,
          orderId: r.order_id,
          orderNumber: r.order_number,
          quotationId: r.quotation_id,
          quotationNumber: r.quotation_number,
          credited: r.credited,
          creditState: invoiceCreditState(r.total, r.credited),
          owed: issued ? r.owed : null,
          paymentState: issued ? paymentStateFor(r.ob_total, r.ob_credited, r.ob_paid) : null,
          overdue: issued ? invoiceOverdue(r.due_date, r.owed ?? '0', r.today) : null,
          enteredByName: team ? r.entered_by_name : null,
          mine: r.mine,
          createdAt: isoOf(r.created_at),
          version: r.version,
        }
      }),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: last.sort_key, id: last.id })
          : null,
    }
  })
}

/**
 * A list's filters name rows of the business (NOT_FOUND otherwise): its customer, order, quotation or
 * invoice.
 */
export async function assertListed(
  tx: Tx,
  businessId: string,
  refs: Partial<Record<'customers' | 'orders' | 'quotations' | 'invoices', string | undefined>>,
): Promise<void> {
  for (const [table, id] of Object.entries(refs)) {
    if (id === undefined) continue
    const [found] = (await tx.execute(sql`
      select r.id from ${sql.raw(`app.${table}`)} r
       where r.business_id = ${businessId} and r.id = ${id} and r.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!found) throw new AppError('not_found')
  }
}

function paymentStateFor(total: string | null, credited: string | null, paid: string | null) {
  const left = subtractDecimals(total ?? '0', credited ?? '0', paid ?? '0')
  if (compareDecimal(left, '0') < 0) return 'overpaid' as const
  if (compareDecimal(left, '0') === 0) return 'paid' as const
  return compareDecimal(paid ?? '0', '0') > 0 ? ('deposit' as const) : ('unpaid' as const)
}

// ---------------------------------------------------------------------------------------------------
// Drafts from scratch
// ---------------------------------------------------------------------------------------------------

type Fields = Omit<CreateInput, 'id'>

/** What a save keeps of the draft it changes. */
interface StoredDraft {
  readonly customerId: string
  readonly productIds: ReadonlySet<string>
  readonly channelId: string | null
  readonly vatRegistered: boolean
  /** Each kept line's VAT basis as saved, used while the VAT registration is the same (issue). */
  readonly vat?: ReadonlyMap<string, StoredVat>
}

/** The header columns every draft shares (dates, LPO, channel, counting, terms and notes). */
async function headerOf(
  tx: Tx,
  ctx: BusinessCtx,
  input: Pick<
    Fields,
    | 'locationId'
    | 'channelId'
    | 'supplyDate'
    | 'dueDate'
    | 'lpoReference'
    | 'countedElsewhere'
    | 'terms'
    | 'notes'
    | 'site'
  >,
  stored: { channelId: string | null } | null,
  biz: Awaited<ReturnType<typeof saleContextOf>>,
) {
  if (input.supplyDate !== null && input.supplyDate > biz.today) throw new AppError('future_date')
  if (input.dueDate !== null && input.dueDate < (input.supplyDate ?? biz.today)) {
    throw invalid('dueDate: before the date of supply')
  }
  const locationId = await resolveLocation(tx, ctx, input.locationId, biz.defaultLocationId)
  assertInScope(ctx, locationId)
  const channelId =
    input.channelId === null
      ? null
      : (await resolveChannel(tx, ctx.businessId, input.channelId, stored?.channelId ?? null)).id
  return {
    locationId,
    channelId,
    supplyDate: input.supplyDate,
    dueDate: input.dueDate,
    lpoReference: input.lpoReference,
    countedElsewhere: input.countedElsewhere,
    terms: input.terms,
    notes: input.notes,
    site: input.site,
  }
}

/**
 * Checks a draft made from scratch (its customer, location, products, typed lines) and works out its
 * amounts (the sales engine with the discount and "Round the total", D-220, D-221); returns the invoice's
 * columns and its lines'. Its lines are saved with each area's lines together (D-299).
 */
async function prepareScratch(tx: Tx, ctx: BusinessCtx, sent: Fields, stored: StoredDraft | null) {
  const input: Fields = { ...sent, lines: groupByArea(sent.lines) }
  const biz = await saleContextOf(tx, ctx.businessId)
  if (
    !biz.vatRegistered &&
    input.lines.some(
      (l) => l.productId === null && (l.priceIncludesVat || l.vatCategory !== 'standard'),
    )
  ) {
    throw new AppError('capability_disabled', { message: 'VAT needs a VAT-registered business' })
  }
  const customerId = await resolveCustomer(
    tx,
    ctx.businessId,
    input.customerId,
    stored?.customerId ?? null,
  )
  if (customerId === null) throw invalid('customerId: required')
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
  const priced: PricedLine[] = input.lines.map((line) =>
    line.productId === null
      ? {
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
      : {
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
        },
  )
  const { amounts, adjustment, roundingDifference } = roundedAmountsOf(
    priced,
    biz.vatRegistered,
    biz.currency,
    toLineDiscount(input.discount),
    input.roundTo,
  )
  const header = {
    ...(await headerOf(tx, ctx, input, stored, biz)),
    customerId,
    kind: invoiceKindFor(biz.vatRegistered),
    vatRegistered: biz.vatRegistered,
    currency: biz.currency,
    discountPercent: input.discount && 'percent' in input.discount ? input.discount.percent : null,
    discountAmount: input.discount && 'amount' in input.discount ? input.discount.amount : null,
    roundTo: input.roundTo,
    adjustment,
    roundingDifference,
    ...totalsOf(amounts),
    payable: amounts?.payable ?? '0',
    vatRates: biz.vatRegistered && amounts ? amounts.rates.map((r) => ({ ...r })) : [],
  }
  const lines = lineValues(ctx.businessId, priced, amounts, biz.vatRegistered).map((line, i) => {
    const source = input.lines[i]!
    return {
      id: line.id!,
      businessId: ctx.businessId,
      position: i,
      kind: 'item' as const,
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
      depositInvoiceId: null,
      saleLineId: null,
    }
  })
  return { header, lines }
}

type LineRow = Omit<typeof invoiceLines.$inferInsert, 'invoiceId'> & { id: string }

/** The create's fingerprint: every field as sent. */
function hashOf(input: object): string {
  const rest: Record<string, unknown> = { ...input }
  delete rest.id
  delete rest.newId
  return requestHashOf(rest)
}

/** Answers a replayed create of `id` (one made by this caller with the same payload), else null. */
async function replayed(
  tx: Tx,
  ctx: BusinessCtx,
  id: string,
  requestHash: string,
): Promise<ReadInvoice | null> {
  await tx.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`invoice:${id}`}, 0))
  `)
  const [existing] = (await tx.execute(sql`
    select i.request_hash, i.created_by = app.current_user_id() as mine,
           i.deleted_at is not null as discarded
      from app.invoices i where i.business_id = ${ctx.businessId} and i.id = ${id}
  `)) as unknown as { request_hash: string | null; mine: boolean; discarded: boolean }[]
  if (!existing) return null
  if (existing.request_hash !== requestHash || !existing.mine || existing.discarded) {
    throw new AppError('conflict')
  }
  return readInvoice(tx, ctx, id)
}

async function insertLines(tx: Tx, invoiceId: string, lines: readonly LineRow[]) {
  if (lines.length > 0) {
    await tx.insert(invoiceLines).values(lines.map((line) => ({ ...line, invoiceId })))
  }
}

/**
 * `invoice.create` (invoices.documents.manage): a draft from scratch (no number until issued),
 * idempotent on the client's id; its kind is the one it would take now (set again at issue).
 */
export async function createInvoice(ctx: BusinessCtx, input: CreateInput): Promise<InvoiceDto> {
  const { id, ...fields } = input
  const requestHash = hashOf(input)
  const read = await ctx.tx(async (tx) => {
    const replay = await replayed(tx, ctx, id, requestHash)
    if (replay) return replay
    assertModuleActive(ctx, 'customers')
    const { header, lines } = await prepareScratch(tx, ctx, fields, null)
    await tx.insert(invoices).values({
      id,
      businessId: ctx.businessId,
      status: 'draft',
      bills: 'everything',
      ...header,
      requestHash,
    })
    await insertLines(tx, id, lines)
    return readInvoice(tx, ctx, id)
  })
  return signed(ctx, read)
}

interface LockedInvoice extends Record<string, unknown> {
  id: string
  status: InvoiceStatus
  version: number
}

/** The invoice locked FOR UPDATE (NOT_FOUND unless live and in the caller's branches). */
async function lockInvoice(tx: Tx, ctx: BusinessCtx, id: string): Promise<InvoiceRecord> {
  const [row] = (await tx.execute(sql`
    select i.id from app.invoices i
     where ${where([
       sql`i.business_id = ${ctx.businessId}`,
       sql`i.id = ${id}`,
       sql`i.deleted_at is null`,
       ...visibleInvoices(ctx),
     ])}
       for update
  `)) as unknown as LockedInvoice[]
  if (!row) throw new AppError('not_found')
  return invoiceHeadOf(tx, ctx, id)
}

const byId = (businessId: string, id: string) =>
  and(eq(invoices.businessId, businessId), eq(invoices.id, id))

/** A sourced draft: made from a quotation, an order or a sale (its lines are the source's). */
const sourced = (head: InvoiceRecord) =>
  head.quotation_id !== null || head.order_id !== null || head.sale_id !== null

/** Replaces a draft's lines (matched by id) and returns the pictures' paths taken off. */
async function writeLines(
  tx: Tx,
  businessId: string,
  invoiceId: string,
  lines: readonly LineRow[],
): Promise<string[]> {
  const live = (await tx.execute(sql`
    select l.id from app.invoice_lines l
     where l.business_id = ${businessId} and l.invoice_id = ${invoiceId} and l.deleted_at is null
  `)) as unknown as { id: string }[]
  const liveIds = new Set(live.map((l) => l.id))
  const kept = new Set(lines.map((l) => l.id))
  const removed = [...liveIds].filter((lineId) => !kept.has(lineId))
  const paths: string[] = []
  for (const lineId of removed) {
    paths.push(...(await detachAll(tx, businessId, 'invoice_line', lineId)))
  }
  if (removed.length > 0) {
    await tx
      .update(invoiceLines)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(invoiceLines.businessId, businessId),
          eq(invoiceLines.invoiceId, invoiceId),
          inArray(invoiceLines.id, removed),
        ),
      )
  }
  const added = lines.filter((line) => !liveIds.has(line.id))
  await insertLines(tx, invoiceId, added)
  for (const line of lines.filter((l) => liveIds.has(l.id))) {
    const values: Partial<LineRow> = { ...line }
    delete values.id
    delete values.businessId
    await tx
      .update(invoiceLines)
      .set(values)
      .where(
        and(
          eq(invoiceLines.businessId, businessId),
          eq(invoiceLines.invoiceId, invoiceId),
          eq(invoiceLines.id, line.id),
        ),
      )
  }
  return paths
}

/** A draft's saved lines as a scratch invoice's input. */
function scratchLinesOf(lines: readonly InvoiceLineRecord[]): ScratchLine[] {
  return lines.map((l) => ({
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
  }))
}

/**
 * `invoice.update` (a draft, `version` as read): its header whole. A draft from scratch also takes its
 * customer, lines (matched by id), discount and "Round the total" (left out: kept); a draft made from a
 * quotation, an order or a sale keeps its customer and lines (VALIDATION when sent).
 */
export async function updateInvoice(ctx: BusinessCtx, input: UpdateInput): Promise<InvoiceDto> {
  const { id, version } = input
  const { read, removed } = await ctx.tx(async (tx) => {
    const head = await lockInvoice(tx, ctx, id)
    if (head.status !== 'draft') throw new AppError('document_posted')
    if (head.version !== version) throw new AppError('conflict')
    const live = await invoiceLinesOf(tx, ctx.businessId, id)
    let removed: string[] = []
    if (sourced(head)) {
      if (
        input.lines !== undefined ||
        input.discount !== undefined ||
        input.roundTo !== undefined ||
        (input.customerId !== undefined && input.customerId !== head.customer_id)
      ) {
        throw invalid('lines: an invoice made from a quotation, an order or a sale keeps its lines')
      }
      // It keeps its source's branch too (Q12: its payments and the sales its credit notes take
      // back are of that branch; the issue checks it again).
      if (input.locationId !== null && input.locationId !== head.location_id) {
        throw invalid(
          'locationId: an invoice made from a quotation, an order or a sale keeps its branch',
        )
      }
      const biz = await saleContextOf(tx, ctx.businessId)
      const header = await headerOf(
        tx,
        ctx,
        { ...input, locationId: head.location_id },
        { channelId: head.channel_id },
        biz,
      )
      const counting = countingOf({ ...head, counted_elsewhere: header.countedElsewhere })
      await tx
        .update(invoices)
        .set({ ...header, countedElsewhere: counting.asks ? header.countedElsewhere : null })
        .where(byId(ctx.businessId, id))
    } else {
      const fields: Fields = {
        customerId: input.customerId ?? head.customer_id,
        locationId: input.locationId,
        channelId: input.channelId,
        supplyDate: input.supplyDate,
        dueDate: input.dueDate,
        lpoReference: input.lpoReference,
        countedElsewhere: input.countedElsewhere,
        terms: input.terms,
        notes: input.notes,
        site: input.site,
        discount:
          input.discount === undefined
            ? discountOf(head.discount_percent, head.discount_amount)
            : (input.discount ?? null),
        roundTo: input.roundTo === undefined ? head.round_to : (input.roundTo ?? null),
        lines: input.lines ?? scratchLinesOf(live),
      }
      const { header, lines } = await prepareScratch(tx, ctx, fields, {
        customerId: head.customer_id,
        productIds: new Set(live.flatMap((l) => (l.product_id ? [l.product_id] : []))),
        channelId: head.channel_id,
        vatRegistered: head.vat_registered,
      })
      const counting = countingOf({ ...head, counted_elsewhere: header.countedElsewhere })
      await tx
        .update(invoices)
        .set({ ...header, countedElsewhere: counting.asks ? header.countedElsewhere : null })
        .where(byId(ctx.businessId, id))
      removed = await writeLines(tx, ctx.businessId, id, lines)
    }
    return { read: await readInvoice(tx, ctx, id), removed }
  })
  await removeDocumentObjects(ctx, removed)
  return signed(ctx, read)
}

/**
 * `invoice.discard` (a draft, `version` as read): it is taken out with its files. It never had a number
 * (numbers are taken at issue). An issued invoice is DOCUMENT_POSTED: only a credit note corrects it.
 */
export async function discardInvoice(ctx: BusinessCtx, input: VersionInput): Promise<{ ok: true }> {
  const paths = await ctx.tx(async (tx) => {
    const head = await lockInvoice(tx, ctx, input.id)
    if (head.status !== 'draft') throw new AppError('document_posted')
    if (head.version !== input.version) throw new AppError('conflict')
    const lines = await invoiceLinesOf(tx, ctx.businessId, input.id)
    const paths: string[] = []
    for (const line of lines) {
      paths.push(...(await detachAll(tx, ctx.businessId, 'invoice_line', line.id)))
    }
    paths.push(...(await detachAll(tx, ctx.businessId, 'invoice', input.id)))
    await tx
      .update(invoices)
      .set({ deletedAt: sql`now()` })
      .where(byId(ctx.businessId, input.id))
    return paths
  })
  await removeDocumentObjects(ctx, paths)
  return { ok: true as const }
}

// ---------------------------------------------------------------------------------------------------
// Sources: an accepted quotation, an order, a recorded sale (Q22)
// ---------------------------------------------------------------------------------------------------

type SourceKind = 'quotation' | 'order' | 'sale'

interface SourceLine {
  readonly kind: 'item' | 'delivery'
  readonly productId: string | null
  readonly area: string | null
  readonly description: string
  readonly details: string | null
  readonly note: string | null
  readonly qty: string
  readonly unit: StandardUnit | null
  readonly unitPrice: string
  readonly priceIncludesVat: boolean
  readonly discountPercent: string | null
  readonly discountAmount: string | null
  readonly vatCategory: VatCategory | null
  readonly vatRate: string | null
  readonly subtotal: string
  readonly discount: string
  readonly net: string
  readonly vat: string
  readonly total: string
  /** The sale line it counted in (an order's delivered sale, a recorded sale). */
  readonly saleLineId: string | null
}

export interface Source {
  readonly kind: SourceKind
  /** The revision, order or sale. */
  readonly id: string
  /** The quotation's first revision (its family), else the id. */
  readonly rootId: string
  readonly number: string | null
  readonly customerId: string | null
  readonly locationId: string
  readonly channelId: string | null
  readonly lpo: string | null
  readonly vatRegistered: boolean
  readonly currency: string
  readonly discountPercent: string | null
  readonly discountAmount: string | null
  readonly roundTo: string | null
  readonly adjustment: string
  readonly roundingDifference: string
  readonly subtotal: string
  readonly discountTotal: string
  readonly netTotal: string
  readonly vatTotal: string
  readonly total: string
  readonly payable: string
  readonly lines: readonly SourceLine[]
  readonly stages: readonly {
    label: string | null
    due: string | null
    amount: string
    percent: string
  }[]
  /** A quotation's project or site. */
  readonly site: string | null
}

/** The VAT breakdown of a source's lines (Σ per rate: computeSale split each rate's VAT over them). */
function ratesOf(lines: readonly SourceLine[]): DocumentRate[] {
  const sums = new Map<string, DocumentRate>()
  for (const line of lines) {
    const key = rateKey(line)
    const sum = sums.get(key)
    sums.set(key, {
      vatCategory: line.vatCategory,
      vatRate: line.vatRate as Percent | null,
      net: sumDecimals([sum?.net ?? '0', line.net]) as Money,
      vat: sumDecimals([sum?.vat ?? '0', line.vat]) as Money,
    })
  }
  return [...sums.values()]
}

const SOURCE_LINE_COLUMNS = sql`trim_scale(l.qty)::text as qty, l.unit,
  trim_scale(l.unit_price)::text as unit_price, l.price_includes_vat,
  trim_scale(l.discount_percent)::text as discount_percent,
  trim_scale(l.discount_amount)::text as discount_amount, l.vat_category,
  trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.subtotal)::text as subtotal,
  trim_scale(l.discount)::text as discount, trim_scale(l.net)::text as net,
  trim_scale(l.vat)::text as vat, trim_scale(l.total)::text as total`

interface SourceLineRecord extends Record<string, unknown> {
  kind: 'item' | 'delivery'
  product_id: string | null
  area: string | null
  description: string | null
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
  sale_line_id: string | null
}

const SOURCE_HEAD_COLUMNS = (alias: string) => {
  const a = sql.raw(alias)
  return sql`trim_scale(${a}.discount_percent)::text as discount_percent,
    trim_scale(${a}.discount_amount)::text as discount_amount,
    trim_scale(${a}.round_to)::text as round_to, trim_scale(${a}.adjustment)::text as adjustment,
    trim_scale(${a}.rounding_difference)::text as rounding_difference,
    trim_scale(${a}.subtotal)::text as subtotal,
    trim_scale(${a}.discount_total)::text as discount_total,
    trim_scale(${a}.net_total)::text as net_total, trim_scale(${a}.vat_total)::text as vat_total,
    trim_scale(${a}.total)::text as total, ${a}.vat_registered, trim(${a}.currency) as currency`
}

interface SourceHeadRecord extends Record<string, unknown> {
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
  vat_registered: boolean
  currency: string
}

function sourceLines(rows: readonly SourceLineRecord[], deliveryName: string): SourceLine[] {
  return rows.map((l) => ({
    kind: l.kind,
    productId: l.product_id,
    area: l.area,
    description: l.description ?? deliveryName,
    details: l.details,
    note: l.note,
    qty: l.qty,
    unit: l.unit,
    unitPrice: l.unit_price,
    priceIncludesVat: l.price_includes_vat,
    discountPercent: l.discount_percent,
    discountAmount: l.discount_amount,
    vatCategory: l.vat_category,
    vatRate: l.vat_rate,
    subtotal: l.subtotal,
    discount: l.discount,
    net: l.net,
    vat: l.vat,
    total: l.total,
    saleLineId: l.sale_line_id,
  }))
}

function sourceHead(head: SourceHeadRecord) {
  return {
    vatRegistered: head.vat_registered,
    currency: head.currency,
    discountPercent: head.discount_percent,
    discountAmount: head.discount_amount,
    roundTo: head.round_to,
    adjustment: head.adjustment,
    roundingDifference: head.rounding_difference,
    subtotal: head.subtotal,
    discountTotal: head.discount_total,
    netTotal: head.net_total,
    vatTotal: head.vat_total,
    total: head.total,
    payable: sumDecimals([head.total, head.rounding_difference]),
  }
}

/** The business's documents' messages, in its language. */
function invoiceMessages(locale: string): Messages {
  return resources[locale === 'ar' ? 'ar' : 'en'].documents
}

function message(messages: Messages, path: string, values: Readonly<Record<string, string>> = {}) {
  let node: Messages | string | undefined = messages
  for (const part of path.split('.')) {
    if (typeof node !== 'object') break
    node = node[part]
  }
  if (typeof node !== 'string') throw new Error(`documents.${path} is missing`)
  return node.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match)
}

/**
 * Locks and reads a source (FOR UPDATE: two issues or drafts of one source wait for each other): an
 * accepted quotation revision (its first revision locked; the latest revision, with no order made from
 * it: invoice the order instead), an order (Orders' own rules of who sees which; not cancelled, naming
 * its customer, without refunds that stand) or a finalized One sale (naming its customer, without
 * refunds that stand). NOT_FOUND when the caller may not see it; VALIDATION when it cannot be invoiced.
 */
export async function lockSource(
  tx: Tx,
  ctx: BusinessCtx,
  kind: SourceKind,
  id: string,
  locale: string,
): Promise<Source> {
  const deliveryName = message(invoiceMessages(locale), 'invoiceLines.delivery')
  if (kind === 'quotation') {
    assertModuleActive(ctx, 'quotations')
    assertPermission(ctx, 'quotations.documents.view')
    const scope = visibleInvoices(ctx, 'q')
    const [found] = (await tx.execute(sql`
      select q.root_id from app.quotations q
       where ${where([sql`q.business_id = ${ctx.businessId}`, sql`q.id = ${id}`, sql`q.deleted_at is null`, ...scope])}
    `)) as unknown as { root_id: string }[]
    if (!found) throw new AppError('not_found')
    await tx.execute(sql`
      select 1 from app.quotations q
       where q.business_id = ${ctx.businessId} and q.id = ${found.root_id} for update
    `)
    const [head] = (await tx.execute(sql`
      select q.id, q.root_id, q.number, q.status, q.customer_id, q.location_id, q.customer_ref,
             q.site, ${SOURCE_HEAD_COLUMNS('q')},
             not exists (select 1 from app.quotations r
                          where r.business_id = q.business_id and r.root_id = q.root_id
                            and r.revision > q.revision and r.deleted_at is null) as latest,
             exists (select 1 from app.quotations r
                      where r.business_id = q.business_id and r.root_id = q.root_id
                        and r.order_id is not null) as has_order
        from app.quotations q
       where q.business_id = ${ctx.businessId} and q.id = ${id}
    `)) as unknown as (SourceHeadRecord & {
      id: string
      root_id: string
      number: string
      status: string
      customer_id: string
      location_id: string
      customer_ref: string | null
      site: string | null
      latest: boolean
      has_order: boolean
    })[]
    if (!head) throw new AppError('not_found')
    if (head.status !== 'accepted') throw new AppError('quotation_not_accepted')
    if (!head.latest) throw new AppError('quotation_superseded')
    if (head.has_order) throw invalid('quotation: it became an order; invoice the order instead')
    const lines = (await tx.execute(sql`
      select 'item'::text as kind, l.product_id, l.area, l.description, l.details, l.note,
             ${SOURCE_LINE_COLUMNS}, null::uuid as sale_line_id
        from app.quotation_lines l
       where l.business_id = ${ctx.businessId} and l.quotation_id = ${id} and l.deleted_at is null
       order by l.position, l.id
    `)) as unknown as SourceLineRecord[]
    const stages = (await tx.execute(sql`
      select s.label, s.due, trim_scale(s.amount)::text as amount,
             trim_scale(s.percent)::text as percent
        from app.quotation_stages s
       where s.business_id = ${ctx.businessId} and s.quotation_id = ${id} and s.deleted_at is null
       order by s.position, s.id
    `)) as unknown as {
      label: string | null
      due: string | null
      amount: string
      percent: string
    }[]
    return {
      kind,
      id,
      rootId: head.root_id,
      number: head.number,
      customerId: head.customer_id,
      locationId: head.location_id,
      channelId: null,
      lpo: head.customer_ref,
      ...sourceHead(head),
      lines: sourceLines(lines, deliveryName),
      stages,
      site: head.site,
    }
  }
  if (kind === 'order') {
    assertModuleActive(ctx, 'orders')
    const [head] = (await tx.execute(sql`
      select o.id, o.number, o.status, o.customer_id, o.location_id, o.channel_id, o.customer_ref,
             o.sale_id, ${SOURCE_HEAD_COLUMNS('o')}
        from app.orders o
       where ${where([sql`o.business_id = ${ctx.businessId}`, sql`o.id = ${id}`, sql`o.deleted_at is null`, ...visibleOrders(ctx)])}
         for update
    `)) as unknown as (SourceHeadRecord & {
      id: string
      number: string
      status: string
      customer_id: string | null
      location_id: string
      channel_id: string
      customer_ref: string | null
      sale_id: string | null
    })[]
    if (!head) throw new AppError('not_found')
    if (head.status === 'cancelled') throw new AppError('order_cancelled')
    if (head.customer_id === null) throw invalid('order: an invoice names its customer')
    if (head.sale_id !== null) await assertNoRefunds(tx, ctx.businessId, head.sale_id)
    const lines = (await tx.execute(sql`
      select l.kind, l.product_id, null::text as area,
             coalesce(l.description, p.name) as description, null::text as details,
             null::text as note, ${SOURCE_LINE_COLUMNS}, sl.id as sale_line_id
        from app.order_lines l
        left join app.products_services p on p.business_id = l.business_id and p.id = l.product_id
        left join lateral (
          select x.id from app.sale_lines x
           where x.business_id = l.business_id and x.sale_id = ${head.sale_id}::uuid
             and x.deleted_at is null and x.position = (
               select count(*) from app.order_lines y
                where y.business_id = l.business_id and y.order_id = l.order_id
                  and y.deleted_at is null and (y.position, y.id) < (l.position, l.id))
           limit 1
        ) sl on true
       where l.business_id = ${ctx.businessId} and l.order_id = ${id} and l.deleted_at is null
       order by l.position, l.id
    `)) as unknown as SourceLineRecord[]
    return {
      kind,
      id,
      rootId: id,
      number: head.number,
      customerId: head.customer_id,
      locationId: head.location_id,
      channelId: head.channel_id,
      lpo: head.customer_ref,
      ...sourceHead(head),
      lines: sourceLines(lines, deliveryName),
      stages: [],
      site: null,
    }
  }
  // A recorded sale is Sales' record: read and billed only with Sales on, as an order with Orders and a
  // quotation with Quotations (Invoices needs Sales too; Release B review).
  assertModuleActive(ctx, 'sales')
  const [head] = (await tx.execute(sql`
    select s.id, s.status, s.source, s.customer_id, s.location_id, s.channel_id,
           s.business_date::text as business_date, null::text as discount_percent, null::text as discount_amount, null::text as round_to,
           '0' as adjustment, '0' as rounding_difference,
           trim_scale(s.subtotal)::text as subtotal,
           trim_scale(s.discount_total)::text as discount_total,
           trim_scale(s.net_total)::text as net_total, trim_scale(s.vat_total)::text as vat_total,
           trim_scale(s.total)::text as total, s.vat_registered, trim(s.currency) as currency
      from app.sales s
     where ${where([sql`s.business_id = ${ctx.businessId}`, sql`s.id = ${id}`, sql`s.deleted_at is null`, ...visibleTo(ctx)])}
       for update
  `)) as unknown as (SourceHeadRecord & {
    id: string
    status: string
    source: string
    customer_id: string | null
    location_id: string
    channel_id: string
    business_date: string
  })[]
  if (!head) throw new AppError('not_found')
  if (head.status !== 'posted') throw new AppError('document_not_posted')
  if (head.source !== 'single') throw invalid('saleId: only One sale is invoiced from a sale')
  if (head.customer_id === null) throw invalid('sale: an invoice names its customer')
  await assertNoRefunds(tx, ctx.businessId, id)
  const lines = (await tx.execute(sql`
    select l.kind, l.product_id, null::text as area,
           coalesce(l.description, p.name) as description, null::text as details,
           null::text as note, ${SOURCE_LINE_COLUMNS}, l.id as sale_line_id
      from app.sale_lines l
      left join app.products_services p on p.business_id = l.business_id and p.id = l.product_id
     where l.business_id = ${ctx.businessId} and l.sale_id = ${id} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as SourceLineRecord[]
  // A sale's document discount is folded into its lines' nets (sales carry none apart).
  return {
    kind,
    id,
    rootId: id,
    number: null,
    customerId: head.customer_id,
    locationId: head.location_id,
    channelId: head.channel_id,
    lpo: null,
    ...sourceHead(head),
    lines: sourceLines(lines, deliveryName),
    stages: [],
    site: null,
  }
}

/** An order's sale or a sale with refunds that stand is not invoiced (refund it after, by a credit note). */
async function assertNoRefunds(tx: Tx, businessId: string, saleId: string) {
  const [row] = (await tx.execute(sql`
    select exists (select 1 from app.sales r
                    where r.business_id = ${businessId} and r.refund_of_id = ${saleId}
                      and r.status = 'posted' and r.deleted_at is null) as refunded
  `)) as unknown as { refunded: boolean }[]
  if (row?.refunded) {
    throw invalid('the sale has refunds; invoice what was sold before its refunds, or reverse them')
  }
}

/** An issued invoice of a source, as its billing reads it. */
interface Billed {
  readonly id: string
  readonly number: string
  readonly payable: string
  readonly isDeposit: boolean
  readonly roundingDifference: string
  readonly rates: DocumentRate[]
}

/**
 * A credit note (alias `c`) that only billed less (D-305): issued before the work its invoice bills had
 * counted (a deposit invoice before its final invoice, an order's invoice before the delivery), so it
 * posted no sale (`counted_on` null) without being asked "already in your recorded sales?". What it took
 * back is billed again by the source's later invoices.
 */
const UNBILLED = sql`c.status = 'issued' and c.deleted_at is null and c.counted_on is null
  and c.counted_elsewhere is null`

/**
 * The issued invoices of a source (a quotation's: of any of its revisions), oldest first, each as it
 * still bills the source: its lines' net and VAT per rate and its payable, less the credit notes that
 * only billed less (D-305).
 */
async function billedOf(tx: Tx, businessId: string, source: Source): Promise<Billed[]> {
  const filter =
    source.kind === 'quotation'
      ? sql`i.quotation_id in (select r.id from app.quotations r
             where r.business_id = ${businessId} and r.root_id = ${source.rootId})`
      : source.kind === 'order'
        ? sql`i.order_id = ${source.id}`
        : sql`i.sale_id = ${source.id}`
  const rows = (await tx.execute(sql`
    select i.id, i.number, i.is_deposit,
           trim_scale(i.payable - coalesce((
             select sum(c.total) from app.credit_notes c
              where c.business_id = i.business_id and c.invoice_id = i.id and ${UNBILLED}), 0))::text
             as payable,
           trim_scale(i.rounding_difference)::text as rounding_difference, i.vat_registered,
           (select coalesce(jsonb_agg(jsonb_build_object(
              'vatCategory', r.vat_category, 'vatRate', trim_scale(r.vat_rate)::text,
              'net', trim_scale(r.net)::text, 'vat', trim_scale(r.vat)::text)), '[]'::jsonb)
              from (
                select x.vat_category, x.vat_rate, sum(x.net) as net, sum(x.vat) as vat
                  from (
                    select l.vat_category, l.vat_rate, l.net, l.vat from app.invoice_lines l
                     where l.business_id = i.business_id and l.invoice_id = i.id
                       and l.deleted_at is null
                    union all
                    select cl.vat_category, cl.vat_rate, -cl.net, -cl.vat
                      from app.credit_note_lines cl
                      join app.credit_notes c
                        on c.business_id = cl.business_id and c.id = cl.credit_note_id
                     where cl.business_id = i.business_id and c.invoice_id = i.id
                       and cl.deleted_at is null and ${UNBILLED}
                  ) x
                 group by x.vat_category, x.vat_rate
              ) r) as lines
      from app.invoices i
     where i.business_id = ${businessId} and i.status = 'issued' and i.deleted_at is null
       and ${filter}
     order by i.seq
  `)) as unknown as {
    id: string
    number: string
    payable: string
    is_deposit: boolean
    rounding_difference: string
    lines: { vatCategory: VatCategory | null; vatRate: string | null; net: string; vat: string }[]
  }[]
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    payable: r.payable,
    isDeposit: r.is_deposit,
    roundingDifference: r.rounding_difference,
    rates: r.lines.map((l) => ({
      vatCategory: l.vatCategory,
      vatRate: l.vatRate as Percent | null,
      net: l.net as Money,
      vat: l.vat as Money,
    })),
  }))
}

/** What a draft bills of its source: the request, as the invoice stores it. */
interface BillRequest {
  readonly bills: InvoiceBills
  readonly part: { percent: string } | { amount: string } | null
  readonly isDeposit: boolean
  /** A quotation's payment stage (0-based), billing its stored amount. */
  readonly stage: number | null
}

/** The invoice a source bills: its lines and header amounts. */
interface Bill {
  readonly bills: InvoiceBills
  readonly billPercent: string | null
  readonly billAmount: string | null
  readonly isDeposit: boolean
  readonly lines: Omit<LineRow, 'businessId'>[]
  readonly header: {
    discountPercent: string | null
    discountAmount: string | null
    roundTo: string | null
    adjustment: string
    roundingDifference: string
    subtotal: string
    discountTotal: string
    netTotal: string
    vatTotal: string
    total: string
    payable: string
    vatRates: DocumentRate[]
  }
}

const vatOf = (rates: readonly DocumentRate[], registered: boolean) =>
  registered ? rates.map((r) => ({ ...r })) : []

function copyLine(line: SourceLine, position: number): Omit<LineRow, 'businessId'> {
  return {
    id: newId(),
    position,
    kind: line.kind,
    productId: line.productId,
    area: line.area,
    description: line.description.slice(0, 200),
    details: line.details,
    note: line.note,
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
    depositInvoiceId: null,
    saleLineId: line.saleLineId,
  }
}

/** A source's name in a line's description: "quotation Q-0001", "order #1001". */
function sourceName(messages: Messages, source: Source): string {
  return source.kind === 'quotation'
    ? message(messages, 'invoiceLines.ofQuotation', { number: source.number ?? '' })
    : source.kind === 'order'
      ? message(messages, 'invoiceLines.ofOrder', { number: source.number ?? '' })
      : ''
}

/** "… – VAT 5%" after a part's line when the source has several rates. */
function withRate(messages: Messages, line: string, rate: DocumentRate, several: boolean) {
  if (!several || rate.vatCategory === null) return line
  if (rate.vatCategory === 'exempt') return message(messages, 'invoiceLines.exempt', { line })
  if (rate.vatCategory === 'zero_rated')
    return message(messages, 'invoiceLines.zeroRated', { line })
  return message(messages, 'invoiceLines.rate', {
    line,
    rate: trimZeros(rate.vatRate ?? '0'),
  })
}

/**
 * The invoice that bills `request` of `source` after the invoices `billed` (Q22): everything (nothing
 * billed yet), a part (one line per rate priced with VAT, partOfRates), the rest (restOfRates; after
 * deposit invoices: the source's lines with one deduction per deposit invoice and rate). A source billed
 * in stages takes no deposit invoice and one billed by deposits no stage (VALIDATION).
 */
export function planBill(
  source: Source,
  billed: readonly Billed[],
  request: BillRequest,
  locale: string,
): Bill {
  const currency = source.currency as Parameters<typeof billPart>[3]
  const messages = invoiceMessages(locale)
  const rates = ratesOf(source.lines)
  const deposits = billed.filter((b) => b.isDeposit)
  const stages = billed.filter((b) => !b.isDeposit)
  const name = sourceName(messages, source)
  const everything = (): Bill => ({
    bills: 'everything',
    billPercent: null,
    billAmount: null,
    isDeposit: false,
    lines: source.lines.map((line, i) => copyLine(line, i)),
    header: {
      discountPercent: source.discountPercent,
      discountAmount: source.discountAmount,
      roundTo: source.roundTo,
      adjustment: source.adjustment,
      roundingDifference: source.roundingDifference,
      subtotal: source.subtotal,
      discountTotal: source.discountTotal,
      netTotal: source.netTotal,
      vatTotal: source.vatTotal,
      total: source.total,
      payable: source.payable,
      vatRates: vatOf(rates, source.vatRegistered),
    },
  })
  if (source.lines.length === 0) throw invalid('lines: nothing to invoice')

  let bills = request.bills
  let part = request.part
  let stageLabel: string | null = null
  let stageShare: string | null = null
  if (request.stage !== null) {
    const stage = source.stages[request.stage]
    if (!stage) throw invalid('stage: the quotation has no such payment stage')
    // Stages are billed in their order, each once (the last bills the rest).
    if (request.stage !== stages.length) {
      throw invalid(`stage: the next payment stage to bill is ${stages.length + 1}`)
    }
    stageLabel =
      stage.label ??
      message(messages, 'invoiceLines.stageLabel', {
        n: String(request.stage + 1),
        count: String(source.stages.length),
      })
    const percent = `${trimZeros(stage.percent)}%`
    stageShare = stage.due?.trim()
      ? message(messages, 'invoiceLines.shareDue', { share: percent, due: stage.due.trim() })
      : percent
    if (request.stage === source.stages.length - 1) {
      bills = 'rest'
      part = null
    } else {
      bills = 'part'
      part = { amount: stage.amount }
    }
  }
  if (request.isDeposit && stages.length > 0) {
    throw invalid('isDeposit: the source is billed in stages')
  }
  if (bills === 'everything') {
    if (billed.length > 0) throw invalid('bills: part of it was billed already: bill the rest')
    return everything()
  }
  const billedPayables = billed.map((b) => b.payable as Money)
  if (bills === 'part') {
    if (part === null) throw invalid('part: required')
    if (!request.isDeposit && deposits.length > 0) {
      throw invalid('bills: after a deposit invoice the final invoice bills the rest')
    }
    const asked =
      'percent' in part ? { percent: part.percent as Percent } : { amount: part.amount as Money }
    const error = billingError(source.payable as Money, billedPayables, asked, currency)
    if (error) throw invalid(`part: ${error}`)
    const plan = billPart(source.payable as Money, billedPayables, asked, currency)
    if (plan.last) {
      // It comes to all that is left: it bills the rest (below).
      if (request.isDeposit) throw invalid('part: a deposit is not all that is left')
    } else {
      const billedRates = billed.flatMap((b) => b.rates)
      let shares: ReturnType<typeof partOfRates>
      try {
        shares = partOfRates(rates, billedRates, plan.amount, currency)
      } catch {
        throw invalid('part: bill the rest instead')
      }
      const share = stageShare ?? ('percent' in part ? `${trimZeros(part.percent)}%` : null)
      const base = request.isDeposit
        ? message(messages, share ? 'invoiceLines.deposit' : 'invoiceLines.depositNoShare', {
            share: share ?? '',
            source: name,
          })
        : stageLabel !== null
          ? message(messages, share ? 'invoiceLines.stage' : 'invoiceLines.stageNoShare', {
              stage: stageLabel,
              share: share ?? '',
              source: name,
            })
          : message(messages, share ? 'invoiceLines.part' : 'invoiceLines.partNoShare', {
              share: share ?? '',
              source: name,
            })
      const several = shares.length > 1
      const work = workOf(messages, source)
      const lines = shares.map((r, i) =>
        partLine(withRate(messages, base, r, several), r, source.vatRegistered, i, work),
      )
      const total = sumDecimals(shares.map((r) => r.gross))
      return {
        bills: 'part',
        billPercent: 'percent' in part ? part.percent : null,
        billAmount: 'amount' in part ? part.amount : null,
        isDeposit: request.isDeposit,
        lines,
        header: {
          discountPercent: null,
          discountAmount: null,
          roundTo: null,
          adjustment: '0',
          roundingDifference: '0',
          subtotal: total,
          discountTotal: '0',
          netTotal: sumDecimals(shares.map((r) => r.net)),
          vatTotal: sumDecimals(shares.map((r) => r.vat)),
          total,
          payable: total,
          vatRates: vatOf(shares, source.vatRegistered),
        },
      }
    }
  }
  // The rest.
  if (billed.length === 0) return everything()
  if (request.isDeposit) throw invalid('isDeposit: a deposit is a part')
  if (deposits.length > 0) {
    // The final invoice: the whole work, less each deposit invoice's net and VAT at each rate.
    const deductions = deductionsOf(deposits.map((d) => ({ id: d.id, rates: d.rates })))
    const after = applyDeductions(rates, deductions, currency)
    if (typeof after === 'string') throw invalid(`deposits: ${after}`)
    const several = rates.length > 1
    const work = source.lines.map((line, i) => copyLine(line, i))
    const numbers = new Map(deposits.map((d) => [d.id, d.number] as const))
    const deductionLines = deductions.map((d, k) =>
      deductionLine(
        withRate(
          messages,
          message(messages, 'invoiceLines.deduction', {
            number: numbers.get(d.depositInvoiceId) ?? '',
          }),
          d,
          several,
        ),
        d,
        work.length + k,
      ),
    )
    const total = sumDecimals([after.total])
    return {
      bills: 'rest',
      billPercent: null,
      billAmount: null,
      isDeposit: false,
      lines: [...work, ...deductionLines],
      header: {
        discountPercent: source.discountPercent,
        discountAmount: source.discountAmount,
        roundTo: source.roundTo,
        adjustment: source.adjustment,
        roundingDifference: source.roundingDifference,
        subtotal: sumDecimals([source.subtotal, ...deductionLines.map((l) => l.subtotal ?? '0')]),
        discountTotal: source.discountTotal,
        netTotal: after.net,
        vatTotal: after.vat,
        total,
        payable: sumDecimals([total, source.roundingDifference]),
        vatRates: vatOf(after.rates, source.vatRegistered),
      },
    }
  }
  // The last stage: what is left of each rate, exactly, with the rounding difference left.
  let left: ReturnType<typeof restOfRates>
  try {
    left = restOfRates(
      rates,
      billed.flatMap((b) => b.rates),
      currency,
    )
  } catch {
    throw invalid('bills: the source changed since it was billed')
  }
  const roundingLeft = subtractDecimals(
    source.roundingDifference,
    ...billed.map((b) => b.roundingDifference),
  )
  const base =
    stageLabel !== null
      ? stageShare !== null
        ? message(messages, 'invoiceLines.stage', {
            stage: stageLabel,
            share: stageShare,
            source: name,
          })
        : message(messages, 'invoiceLines.stageNoShare', { stage: stageLabel, source: name })
      : message(messages, 'invoiceLines.rest', { source: name })
  const several = left.length > 1
  const work = workOf(messages, source)
  const lines = left.map((r, i) =>
    partLine(withRate(messages, base, r, several), r, source.vatRegistered, i, work),
  )
  const total = sumDecimals(left.map((r) => r.gross))
  const payable = sumDecimals([total, roundingLeft])
  if (lines.length === 0) throw invalid('bills: nothing is left to bill')
  return {
    bills: 'rest',
    billPercent: null,
    billAmount: null,
    isDeposit: false,
    lines,
    header: {
      discountPercent: null,
      discountAmount: null,
      roundTo: zero(roundingLeft) ? null : payable,
      adjustment: '0',
      roundingDifference: roundingLeft,
      subtotal: total,
      discountTotal: '0',
      netTotal: sumDecimals(left.map((r) => r.net)),
      vatTotal: sumDecimals(left.map((r) => r.vat)),
      total,
      payable,
      vatRates: vatOf(left, source.vatRegistered),
    },
  }
}

/**
 * Whether a draft made from a source still bills exactly what the source bills now (`again`, planned
 * again under the source's lock at issue): the same lines in the same order (kind, quantity, price,
 * net, VAT, total, the deposit invoice a deduction takes off) and the same totals. A source changed
 * since, another invoice of it issued since, or a part's VAT worked out again on a new running total,
 * all differ: the draft is made again (CONFLICT), never issued with amounts the source no longer gives.
 */
function sameBill(
  again: Bill,
  head: Pick<InvoiceRecord, 'net_total' | 'vat_total' | 'payable'>,
  lines: readonly InvoiceLineRecord[],
): boolean {
  const same = (a: string | null | undefined, b: string | null) =>
    a === null || a === undefined || b === null ? (a ?? null) === b : compareDecimal(a, b) === 0
  if (
    again.lines.length !== lines.length ||
    !same(again.header.netTotal, head.net_total) ||
    !same(again.header.vatTotal, head.vat_total) ||
    !same(again.header.payable, head.payable)
  ) {
    return false
  }
  return again.lines.every((line, i) => {
    const stored = lines[i]!
    return (
      line.kind === stored.kind &&
      same(line.qty, stored.qty) &&
      same(line.unitPrice, stored.unit_price) &&
      same(line.net ?? '0', stored.net) &&
      same(line.vat ?? '0', stored.vat) &&
      same(line.total ?? '0', stored.total) &&
      (line.depositInvoiceId ?? null) === stored.deposit_invoice_id
    )
  })
}

/**
 * What a part of a source bills, said on its line (VAT ER Art. 59(1)(g): a description of the goods or
 * services supplied): "For: Ceiling and lights, Partitions and 3 more", from the source's lines.
 */
function workOf(messages: Messages, source: Source): string | null {
  const titles = source.lines
    .filter((l) => l.kind === 'item')
    .map((l) => l.description.replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '')
  if (titles.length === 0) return null
  const separator = message(messages, 'invoiceLines.workSeparator')
  const shown: string[] = []
  for (const title of titles) {
    if (shown.length >= 8 || [...shown, title].join(separator).length > 600) break
    shown.push(title)
  }
  if (shown.length === 0) shown.push(titles[0]!.slice(0, 600))
  const more = titles.length - shown.length
  const work = shown.join(separator)
  return (
    more > 0
      ? message(messages, 'invoiceLines.workMore', { work, count: String(more) })
      : message(messages, 'invoiceLines.work', { work })
  ).slice(0, 2000)
}

/** A part's line at one rate: qty 1, priced with VAT (VAT taken out as the part worked it out). */
function partLine(
  description: string,
  rate: {
    vatCategory: VatCategory | null
    vatRate: string | null
    net: string
    vat: string
    gross: string
  },
  registered: boolean,
  position: number,
  work: string | null = null,
): Omit<LineRow, 'businessId'> {
  const taxed = registered && rate.vatRate !== null && compareDecimal(rate.vatRate, '0') > 0
  return {
    id: newId(),
    position,
    kind: 'item',
    productId: null,
    area: null,
    description: description.slice(0, 200),
    details: work,
    note: null,
    qty: '1',
    unit: null,
    unitPrice: rate.gross,
    priceIncludesVat: taxed,
    discountPercent: null,
    discountAmount: null,
    vatCategory: registered ? rate.vatCategory : null,
    vatRate: registered ? rate.vatRate : null,
    subtotal: rate.gross,
    discount: '0',
    net: rate.net,
    vat: rate.vat,
    total: rate.gross,
    depositInvoiceId: null,
    saleLineId: null,
  }
}

/** A final invoice's deduction of one deposit invoice at one rate: qty −1, negative amounts. */
function deductionLine(
  description: string,
  d: {
    vatCategory: VatCategory | null
    vatRate: string | null
    net: string
    vat: string
    depositInvoiceId: string
  },
  position: number,
): Omit<LineRow, 'businessId'> {
  const neg = (v: string) => subtractDecimals('0', v)
  return {
    id: newId(),
    position,
    kind: 'deduction',
    productId: null,
    area: null,
    description: description.slice(0, 200),
    details: null,
    note: null,
    qty: '-1',
    unit: null,
    unitPrice: d.net,
    priceIncludesVat: false,
    discountPercent: null,
    discountAmount: null,
    vatCategory: d.vatCategory,
    vatRate: d.vatRate,
    subtotal: neg(d.net),
    discount: '0',
    net: neg(d.net),
    vat: neg(d.vat),
    total: neg(sumDecimals([d.net, d.vat])),
    depositInvoiceId: d.depositInvoiceId,
    saleLineId: null,
  }
}

/** The business's language (the descriptions of a part's lines). */
async function localeOf(tx: Tx, businessId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select b.default_locale from app.businesses b where b.id = ${businessId}
  `)) as unknown as { default_locale: string }[]
  return row?.default_locale ?? 'en'
}

/**
 * The day of the first payment toward a pending order that no issued invoice of it covers yet (a
 * deposit received: its tax point, VAT DL Art. 26), or null.
 */
async function depositDayOf(tx: Tx, businessId: string, orderId: string): Promise<string | null> {
  const [row] = (await tx.execute(sql`
    with paid as (
      select p.business_date, p.amount,
             sum(case p.kind when 'refund' then -p.amount else p.amount end)
               over (order by p.business_date, p.created_at, p.id) as running
        from app.customer_payments p
       where p.business_id = ${businessId} and p.order_id = ${orderId}
         and p.reversed_at is null and p.deleted_at is null
    )
    select min(p.business_date)::text as day from paid p
     where p.amount > 0 and p.running > coalesce((
       select sum(i.payable - coalesce((select sum(c.total) from app.credit_notes c
                where c.business_id = i.business_id and c.invoice_id = i.id and ${UNBILLED}), 0))
         from app.invoices i
        where i.business_id = ${businessId} and i.order_id = ${orderId} and i.status = 'issued'
          and i.deleted_at is null), 0)
  `)) as unknown as { day: string | null }[]
  return row?.day ?? null
}

/**
 * The date of supply a draft takes from its source when it has none of its own (ER Art. 59(1)(f), VAT
 * DL Arts 25, 26): a delivered order's delivery day, a recorded sale's day, and for a deposit of an
 * order the day its first payment not covered by an issued invoice was received when that is earlier
 * (the earliest is the tax point). Read when the draft is made, when it is read (its 14-day note) and
 * again at its issue (a deposit received or an order delivered since the draft). Null: none (the issue
 * date); never after `today`.
 */
async function sourceSupplyDayOf(
  tx: Tx,
  businessId: string,
  source: { readonly orderId: string | null; readonly saleId: string | null },
  isDeposit: boolean,
  today: string,
): Promise<string | null> {
  let day: string | null = null
  if (source.orderId !== null) {
    const [order] = (await tx.execute(sql`
      select case when o.status = 'delivered' then o.delivered_on::text end as delivered_on
        from app.orders o where o.business_id = ${businessId} and o.id = ${source.orderId}
    `)) as unknown as { delivered_on: string | null }[]
    day = order?.delivered_on ?? null
    if (isDeposit) {
      const paid = await depositDayOf(tx, businessId, source.orderId)
      if (paid !== null && (day === null || paid < day)) day = paid
    }
  } else if (source.saleId !== null) {
    const [sale] = (await tx.execute(sql`
      select s.business_date::text as day from app.sales s
       where s.business_id = ${businessId} and s.id = ${source.saleId}
    `)) as unknown as { day: string }[]
    day = sale?.day ?? null
  }
  return day !== null && day <= today ? day : null
}

/** Writes a draft `id` billing `request` of a source (create from a quotation, an order or a sale). */
async function draftFromSource(
  ctx: BusinessCtx,
  id: string,
  kind: SourceKind,
  sourceId: string,
  request: BillRequest,
  requestHash: string,
): Promise<InvoiceDto> {
  const read = await ctx.tx(async (tx) => {
    const replay = await replayed(tx, ctx, id, requestHash)
    if (replay) return replay
    assertModuleActive(ctx, 'customers')
    const locale = await localeOf(tx, ctx.businessId)
    const source = await lockSource(tx, ctx, kind, sourceId, locale)
    const biz = await saleContextOf(tx, ctx.businessId)
    if (source.vatRegistered !== biz.vatRegistered) {
      throw invalid('the VAT registration changed since it was made; make a new one')
    }
    if (source.currency !== biz.currency) throw invalid('currency: not the business’s')
    assertInScope(ctx, source.locationId)
    const billed = await billedOf(tx, ctx.businessId, source)
    const bill = planBill(source, billed, request, locale)
    // Its date of supply as its source gives it (ER Art. 59(1)(f), VAT DL Arts 25, 26): the delivery
    // of a delivered order, a recorded sale's day, a deposit's received day; editable on the draft.
    const supplyDate = await sourceSupplyDayOf(
      tx,
      ctx.businessId,
      { orderId: kind === 'order' ? source.id : null, saleId: kind === 'sale' ? source.id : null },
      bill.isDeposit,
      biz.today,
    )
    await tx.insert(invoices).values({
      id,
      businessId: ctx.businessId,
      kind: invoiceKindFor(biz.vatRegistered),
      status: 'draft',
      customerId: source.customerId!,
      locationId: source.locationId,
      channelId: source.channelId,
      supplyDate,
      dueDate: null,
      lpoReference: source.lpo,
      vatRegistered: biz.vatRegistered,
      currency: biz.currency,
      quotationId: kind === 'quotation' ? source.id : null,
      orderId: kind === 'order' ? source.id : null,
      saleId: kind === 'sale' ? source.id : null,
      bills: bill.bills,
      billPercent: bill.billPercent,
      billAmount: bill.billAmount,
      billStage: request.stage,
      isDeposit: bill.isDeposit,
      site: source.site,
      countedElsewhere: null,
      ...bill.header,
      vatRates: bill.header.vatRates,
      requestHash,
    })
    await insertLines(
      tx,
      id,
      bill.lines.map((line) => ({ ...line, businessId: ctx.businessId })),
    )
    return readInvoice(tx, ctx, id)
  })
  return signed(ctx, read)
}

/**
 * `invoice.fromQuotation` (invoices.documents.manage, Quotations on and seen): a draft from an accepted
 * quotation revision (the latest; one that became an order is invoiced from its order). Idempotent.
 */
export function invoiceFromQuotation(ctx: BusinessCtx, input: FromQuotationInput) {
  return draftFromSource(
    ctx,
    input.newId,
    'quotation',
    input.id,
    { bills: input.bills, part: input.part, isDeposit: input.isDeposit, stage: input.stage },
    requestHashOf({ fromQuotation: input }),
  )
}

/** `invoice.fromOrder` (invoices.documents.manage, Orders on and the order seen). Idempotent. */
export function invoiceFromOrder(ctx: BusinessCtx, input: FromOrderInput) {
  return draftFromSource(
    ctx,
    input.newId,
    'order',
    input.orderId,
    { bills: input.bills, part: input.part, isDeposit: input.isDeposit, stage: null },
    requestHashOf({ fromOrder: input }),
  )
}

/** `invoice.fromSale` (invoices.documents.manage, the sale seen): everything of a One sale. Idempotent. */
export function invoiceFromSale(ctx: BusinessCtx, input: FromSaleInput) {
  return draftFromSource(
    ctx,
    input.newId,
    'sale',
    input.saleId,
    { bills: 'everything', part: null, isDeposit: false, stage: null },
    requestHashOf({ fromSale: input }),
  )
}

// ---------------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------------

/** A sale's amounts as an issued invoice already worked them out (its lines, deductions left out). */
function amountsOfLines(lines: readonly InvoiceLineRecord[], vatRegistered: boolean): SaleAmounts {
  const amounts: SaleLineAmounts[] = lines.map((l) => ({
    kind: 'item',
    vatCategory: l.vat_category,
    vatRate: l.vat_rate as Percent | null,
    priceIncludesVat: l.price_includes_vat,
    subtotal: l.subtotal as Money,
    discount: l.discount as Money,
    documentDiscount: subtractDecimals(l.subtotal, l.discount, l.net) as Money,
    adjustment: '0' as Money,
    net: l.net as Money,
    vat: l.vat as Money,
    total: l.total as Money,
  }))
  const net = sumDecimals(lines.map((l) => l.net)) as Money
  const vat = sumDecimals(lines.map((l) => l.vat)) as Money
  const total = sumDecimals(lines.map((l) => l.total)) as Money
  return {
    vatRegistered,
    lines: amounts,
    rates: ratesOf(
      lines.map((l) => ({
        kind: 'item',
        productId: l.product_id,
        area: null,
        description: l.description,
        details: null,
        note: null,
        qty: l.qty,
        unit: l.unit,
        unitPrice: l.unit_price,
        priceIncludesVat: l.price_includes_vat,
        discountPercent: null,
        discountAmount: null,
        vatCategory: l.vat_category,
        vatRate: l.vat_rate,
        subtotal: l.subtotal,
        discount: l.discount,
        net: l.net,
        vat: l.vat,
        total: l.total,
        saleLineId: null,
      })),
    ),
    documentDiscount: '0' as Money,
    adjustment: '0' as Money,
    net,
    vat,
    total,
    roundingDifference: '0' as Money,
    payable: total,
  }
}

/** The frozen print settings of an issued document (its letterhead as it is now). */
export async function letterheadNow(tx: Tx, businessId: string): Promise<Record<string, unknown>> {
  const [row] = (await tx.execute(sql`
    select b.legal_name, b.legal_name_ar, b.default_locale, b.vat_registered, b.trn, b.phone,
           b.phone_2, b.email, b.address_line, b.city, b.emirate, b.trade_licence_no,
           b.document_accent, b.document_watermark, b.document_whole_amounts,
           b.document_signatory, b.document_footer, b.logo_path, b.document_signature_path,
           b.document_stamp_path
      from app.businesses b where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as Record<string, unknown>[]
  if (!row) throw new AppError('forbidden')
  return row
}

/**
 * `invoice.issue` (invoices.documents.issue; a draft, `version` as read): see above. A repeated issue
 * returns it as issued (its number is never taken twice). Refused, taking no number: a draft with no
 * line (VALIDATION), what VAT ER Art. 59(1) asks missing (DETAILS_MISSING, B16, C5), the "already in
 * your recorded sales?" question unanswered (VALIDATION), a supply day after today (FUTURE_DATE), a due
 * date before today (VALIDATION), a source that changed since the draft (CONFLICT), the books closed
 * through today when its sale must count (BOOKS_CLOSED).
 */
export async function issueInvoice(ctx: BusinessCtx, input: VersionInput): Promise<InvoiceDto> {
  const read = await ctx.tx(async (tx) => {
    const head = await lockInvoice(tx, ctx, input.id)
    if (head.status === 'issued') return readInvoice(tx, ctx, input.id)
    if (head.version !== input.version) throw new AppError('conflict')
    const lines = await invoiceLinesOf(tx, ctx.businessId, input.id)
    if (lines.length === 0) throw invalid('lines: an invoice needs a line to issue')
    const locale = await localeOf(tx, ctx.businessId)

    // The source again, under its lock: what the draft bills must still be what it would bill now.
    let source: Source | null = null
    let again: Bill | null = null
    if (sourced(head)) {
      const kind: SourceKind = head.quotation_id ? 'quotation' : head.order_id ? 'order' : 'sale'
      const sourceId = head.quotation_id ?? head.order_id ?? head.sale_id ?? ''
      // The source's issued invoices first (by id), as an invoice is locked before its order or sale
      // everywhere: a credit note of one of them (it locks its invoice) and this issue wait for each
      // other, so this one bills what that credit note took back, or that one counts (D-305).
      await tx.execute(sql`
        select i.id from app.invoices i
         where i.business_id = ${ctx.businessId} and i.status = 'issued' and i.deleted_at is null
           and ${
             kind === 'quotation'
               ? sql`i.quotation_id in (select r.id from app.quotations r
                      where r.business_id = ${ctx.businessId} and r.root_id = (
                        select x.root_id from app.quotations x
                         where x.business_id = ${ctx.businessId} and x.id = ${sourceId}))`
               : kind === 'order'
                 ? sql`i.order_id = ${sourceId}`
                 : sql`i.sale_id = ${sourceId}`
           }
         order by i.id
           for update
      `)
      source = await lockSource(tx, ctx, kind, sourceId, locale)
      // Issued from its source's branch (Q12): a source moved since is made again.
      if (head.location_id !== source.locationId) {
        throw new AppError('conflict', { message: 'the source is of another branch now' })
      }
      const billed = await billedOf(tx, ctx.businessId, source)
      // A stage is billed in its order, once.
      if (
        head.bill_stage !== null &&
        billed.filter((b) => !b.isDeposit).length !== head.bill_stage
      ) {
        throw new AppError('conflict', {
          message: 'stage: billed already, or an earlier one is not',
        })
      }
      const request: BillRequest = {
        bills: head.bills === 'everything' && billed.length === 0 ? 'everything' : head.bills,
        part:
          head.bill_percent !== null
            ? { percent: head.bill_percent }
            : head.bill_amount !== null
              ? { amount: head.bill_amount }
              : null,
        isDeposit: head.is_deposit,
        stage: null,
      }
      try {
        again = planBill(source, billed, request, locale)
      } catch (error) {
        if (error instanceof AppError) {
          throw new AppError('conflict', { message: 'the source changed', cause: error })
        }
        throw error
      }
      if (!sameBill(again, head, lines)) {
        throw new AppError('conflict', { message: 'the source changed since the draft was made' })
      }
      // The quotation names its first invoice (written now, before the business row and the counter:
      // the counter stays last).
      if (head.quotation_id !== null) {
        await tx.execute(sql`
          update app.quotations set invoice_id = ${head.id}
           where business_id = ${ctx.businessId} and id = ${head.quotation_id} and invoice_id is null
        `)
      }
    }

    // Lock 2: the business row (the books-closed date, VAT registration, currency).
    const business = await lockPostingBusiness(tx, ctx.businessId)
    const issuing = await issuingBusinessOf(tx, ctx.businessId)
    if (head.vat_registered !== business.vatRegistered) {
      if (source !== null)
        throw invalid('the VAT registration changed since the draft; make it again')
      throw invalid('the VAT registration changed since the draft was saved; save it again')
    }
    // Left empty: the date of supply its source gives now (an order delivered since the draft was
    // made, a recorded sale, a deposit received since: under the source's lock), else the issue date.
    const supplyDate =
      head.supply_date ??
      (source === null
        ? null
        : await sourceSupplyDayOf(
            tx,
            ctx.businessId,
            { orderId: head.order_id, saleId: head.sale_id },
            head.is_deposit,
            business.today,
          )) ??
      business.today
    if (supplyDate > business.today) throw new AppError('future_date')
    if (head.due_date !== null && head.due_date < business.today) {
      throw invalid('dueDate: before the issue date')
    }
    const counting = countingOf(head)
    if (counting.asks && head.counted_elsewhere === null) {
      throw invalid('countedElsewhere: required')
    }
    // The customer as it is now (frozen below).
    const [customer] = (await tx.execute(sql`
      select c.name, c.kind, c.trn, c.trade_licence_no, c.address_line, c.city, c.emirate,
             trim(c.country) as country, c.phone
        from app.customers c where c.business_id = ${ctx.businessId} and c.id = ${head.customer_id}
    `)) as unknown as {
      name: string
      kind: CustomerKind
      phone: string | null
      trn: string | null
      trade_licence_no: string | null
      address_line: string | null
      city: string | null
      emirate: Emirate | null
      country: string
    }[]
    if (!customer) throw new AppError('not_found')
    const party: InvoicePartyDto = {
      name: customer.name,
      kind: customer.kind,
      nameAr: null,
      trn: customer.trn,
      tradeLicence: customer.trade_licence_no,
      tradeLicenceAuthority: null,
      addressLine: customer.address_line,
      city: customer.city,
      emirate: customer.emirate,
      country: customer.country,
    }
    let channelId = head.channel_id
    if (counting.counts && channelId === null && issuing.active_channels === 1) {
      channelId = (await resolveChannel(tx, ctx.businessId, null, null)).id
    }
    const { missing } = issueChecks(
      issuing,
      party,
      { supplyDate, counts: counting.counts, channelId },
      business.today,
    )
    if (missing.length > 0) throw new AppError('details_missing', { names: missing })

    // Counting once (Q3): its sale on its supply date, or the first open day (H5).
    let countedOn: string | null = null
    if (counting.counts) {
      countedOn = reversalDateOf(business, supplyDate)
      const items = lines.filter((l) => l.kind !== 'deduction')
      const productIds = items.flatMap((l) => (l.product_id ? [l.product_id] : []))
      if (productIds.length > 0) assertModuleActive(ctx, 'products')
      const products = await productsOf(tx, ctx.businessId, productIds)
      if (productIds.some((pid) => !products.has(pid))) {
        throw invalid('lines: a product was removed')
      }
      const saleId = newId()
      const saleLineIds = items.map(() => newId())
      const asLines: InputLine[] = items.map((l, i): InputLine =>
        l.product_id === null
          ? {
              kind: 'typed',
              id: saleLineIds[i]!,
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
              id: saleLineIds[i]!,
              productId: l.product_id,
              description: l.description,
              qty: l.qty,
              unitPrice: l.unit_price,
              discount: discountOf(l.discount_percent, l.discount_amount),
            },
      )
      const priced: PricedLine[] = asLines.map((line, i) => ({
        line,
        product: line.kind === 'item' ? (products.get(line.productId) ?? null) : null,
        vat:
          line.kind === 'item'
            ? {
                priceIncludesVat: items[i]!.price_includes_vat,
                vatCategory: items[i]!.vat_category ?? 'standard',
              }
            : undefined,
      }))
      const amounts = amountsOfLines(items, business.vatRegistered)
      const [channel] = channelId === null ? [] : [channelId]
      if (!channel) throw new AppError('details_missing', { names: ['channel'] })
      await tx.insert(sales).values({
        id: saleId,
        businessId: ctx.businessId,
        source: 'invoice',
        businessDate: countedOn,
        locationId: head.location_id,
        channelId: channel,
        vatRegistered: business.vatRegistered,
        currency: business.currency,
        ...totalsOf(amounts),
        customerId: head.customer_id,
        invoiceId: head.id,
      })
      await tx.insert(saleLines).values(
        lineValues(ctx.businessId, priced, amounts, business.vatRegistered).map((line) => ({
          ...line,
          saleId,
        })),
      )
      await freezeAndPost(tx, ctx, {
        saleId,
        day: countedOn,
        stored: asLines,
        priced,
        products,
        amounts,
        business,
      })
      for (const [i, l] of items.entries()) {
        await tx
          .update(invoiceLines)
          .set({ saleLineId: saleLineIds[i]! })
          .where(and(eq(invoiceLines.businessId, ctx.businessId), eq(invoiceLines.id, l.id)))
      }
    } else if (again !== null) {
      // A copy of its order's or its recorded sale's lines names the sale lines they counted in (its
      // order may have been delivered since the draft), so a credit note takes their cost back; a
      // part's lines name none (sameBill matched the draft's lines to these one by one).
      for (const [i, l] of lines.entries()) {
        const counted = again.lines[i]?.saleLineId ?? null
        if (counted !== null && l.sale_line_id === null) {
          await tx
            .update(invoiceLines)
            .set({ saleLineId: counted })
            .where(and(eq(invoiceLines.businessId, ctx.businessId), eq(invoiceLines.id, l.id)))
        }
      }
    }
    const letterhead = await letterheadNow(tx, ctx.businessId)
    // The LAST lock: the number.
    const { seq, number } = await takeNumber(tx, ctx.businessId, 'invoice')
    await tx
      .update(invoices)
      .set({
        status: 'issued',
        seq,
        number,
        kind: invoiceKindFor(business.vatRegistered),
        issueDate: business.today,
        supplyDate,
        channelId,
        countedOn,
        countedElsewhere: counting.asks ? head.counted_elsewhere : null,
        issuedAt: sql`now()`,
        issuedBy: sql`app.current_user_id()`,
        customerName: customer.name,
        customerKind: customer.kind,
        customerPhone: customer.phone,
        customerTrn: customer.trn,
        customerTradeLicence: customer.trade_licence_no,
        customerAddressLine: customer.address_line,
        customerCity: customer.city,
        customerEmirate: customer.emirate,
        customerCountry: customer.country,
        sellerName: issuing.legal_name,
        sellerNameAr: issuing.legal_name_ar,
        sellerTrn: issuing.vat_registered ? issuing.trn : null,
        sellerTradeLicence: issuing.trade_licence_no,
        sellerTradeLicenceAuthority: issuing.trade_licence_authority,
        sellerAddressLine: issuing.address_line,
        sellerCity: issuing.city,
        sellerEmirate: issuing.emirate,
        letterhead,
      })
      .where(byId(ctx.businessId, head.id))
    return readInvoice(tx, ctx, input.id)
  })
  return signed(ctx, read)
}

// ---------------------------------------------------------------------------------------------------
// History, copy to a quotation, deposits without an invoice
// ---------------------------------------------------------------------------------------------------

/**
 * `invoice.history`: created, edited, issued, its credit notes issued, its payments (with
 * payments.customers.view) and their reversals, newest first; who and when from the audit log (actor
 * and time only, never its row data); names only with a team.
 */
export function invoiceHistory(ctx: BusinessCtx, input: IdInput): Promise<InvoiceHistoryDto> {
  return ctx.tx(async (tx) => {
    const head = await invoiceHeadOf(tx, ctx, input.id)
    const payments = seesPayments(ctx)
    const rows = (await tx.execute(sql`
      with audit as (
        select a.actor_user_id, a.created_at, a.action from app.audit_log a
         where a.business_id = ${ctx.businessId} and a.entity = 'invoices'
           and a.entity_id = ${head.id}
      ),
      inv as (select i.* from app.invoices i where i.business_id = ${ctx.businessId} and i.id = ${head.id}),
      events as (
        select 'created'::text as kind, i.created_at as at, i.created_by as by_user,
               null::text as reference, null::numeric as amount from inv i
        union all
        select 'edited', a.created_at, a.actor_user_id, null, null
          from inv i join audit a on a.action = 'update'
         where a.created_at > i.created_at
           and a.created_at < coalesce(i.issued_at, i.deleted_at, 'infinity'::timestamptz)
        union all
        select 'issued', i.issued_at, i.issued_by, i.number, null from inv i where i.issued_at is not null
        union all
        select 'discarded', i.deleted_at,
               (select a.actor_user_id from audit a where a.created_at = i.deleted_at limit 1), null, null
          from inv i where i.deleted_at is not null
        union all
        select 'credited', c.issued_at, c.issued_by, c.number, c.total
          from app.credit_notes c
         where c.business_id = ${ctx.businessId} and c.invoice_id = ${head.id}
           and c.status = 'issued' and c.deleted_at is null
        union all
        select 'paid', p.created_at, p.created_by, null, case when ${payments} then p.amount end
          from app.customer_payments p
         where p.business_id = ${ctx.businessId} and p.invoice_id = ${head.id}
           and p.kind = 'payment' and p.deleted_at is null and ${payments}
        union all
        select 'payment_reversed', p.reversed_at, p.reversed_by, null, p.amount
          from app.customer_payments p
         where p.business_id = ${ctx.businessId} and p.invoice_id = ${head.id}
           and p.reversed_at is not null and p.deleted_at is null and ${payments}
      )
      select e.kind, e.at, e.reference, trim_scale(e.amount)::text as amount,
             (select bm.display_name from app.business_members bm
               where bm.business_id = ${ctx.businessId} and bm.user_id = e.by_user
                 and bm.kind = 'account'
               order by (bm.status = 'active') desc, bm.created_at desc limit 1) as by_name
        from events e
       order by e.at desc, e.kind
       limit ${INVOICE_HISTORY_MAX}
    `)) as unknown as {
      kind: InvoiceEventKind
      at: Date | string
      reference: string | null
      amount: string | null
      by_name: string | null
    }[]
    const team = ctx.access.capabilities.has_team
    return {
      events: rows.map((row) => ({
        kind: row.kind,
        at: isoOf(row.at),
        byName: team ? row.by_name : null,
        reference: row.reference,
        amount: row.amount,
      })),
    }
  })
}

/**
 * `invoice.copyToQuotation` (invoices.documents.manage; Quotations on and quotations.documents.manage):
 * a new quotation draft `newId` with the invoice's customer and lines (its deductions left out), dated
 * today, numbered Q-…; idempotent on `newId`. Returns the quotation.
 */
export async function copyInvoiceToQuotation(
  ctx: BusinessCtx,
  input: CopyToQuotationInput,
): Promise<QuotationDto> {
  assertModuleActive(ctx, 'quotations')
  assertPermission(ctx, 'quotations.documents.manage')
  const fields = await ctx.tx(async (tx) => {
    const head = await invoiceHeadOf(tx, ctx, input.id)
    const lines = (await invoiceLinesOf(tx, ctx.businessId, input.id)).filter(
      (l) => l.kind === 'item',
    )
    const biz = await saleContextOf(tx, ctx.businessId)
    // A replay sends the same request: its lines' ids are derived from newId, and its date is the
    // copy's own once made (a replay after midnight).
    const [made] = (await tx.execute(sql`
      select q.business_date::text as business_date from app.quotations q
       where q.business_id = ${ctx.businessId} and q.id = ${input.newId}
    `)) as unknown as { business_date: string }[]
    return {
      customerId: head.customer_id,
      locationId: head.location_id,
      businessDate: made?.business_date ?? biz.today,
      customerRef: head.lpo_reference,
      site: head.site,
      discount: discountOf(head.discount_percent, head.discount_amount),
      roundTo: null,
      greeting: null,
      intro: null,
      notes: head.notes,
      lines: lines.map((l) => ({
        id: derivedId(input.newId, l.id),
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
      stages: [],
    }
  })
  return createQuotation(ctx, { id: input.newId, ...fields } as Parameters<
    typeof createQuotation
  >[1])
}

/**
 * `invoice.depositsWithoutInvoice` (invoices.documents.view with payments.customers.view, a
 * VAT-registered business; M6): each payment towards a pending order not yet covered by its deposit tax
 * invoices (oldest first, payments in the order recorded), with its 14-day deadline (VAT DL Art. 67(1)
 * with Art. 26: a payment received before the supply is a tax point).
 */
export function depositsWithoutInvoice(ctx: BusinessCtx): Promise<DepositsWithoutInvoiceDto> {
  if (!seesPayments(ctx)) throw new AppError('forbidden')
  return ctx.tx(async (tx) => {
    const biz = await saleContextOf(tx, ctx.businessId)
    if (!biz.vatRegistered) return { items: [] }
    const scope = ctx.access.locationScope
    const rows = (await tx.execute(sql`
      with paid as (
        select p.id, p.order_id, p.business_date, p.amount, p.created_at,
               sum(case p.kind when 'refund' then -p.amount else p.amount end)
                 over (partition by p.order_id order by p.business_date, p.created_at, p.id) as running
          from app.customer_payments p
          join app.orders o on o.business_id = p.business_id and o.id = p.order_id
         where p.business_id = ${ctx.businessId} and p.reversed_at is null and p.deleted_at is null
           and o.status = 'pending' and o.deleted_at is null
           ${scope.all ? sql`` : sql`and o.location_id = any(${uuidArray([...scope.ids])})`}
      ),
      -- What the issued invoices of each order still bill (each less its credit notes that only
      -- billed less, D-305): a deposit invoice credited in full covers nothing any more.
      covered as (
        select i.order_id,
               sum(i.payable - coalesce((select sum(c.total) from app.credit_notes c
                 where c.business_id = i.business_id and c.invoice_id = i.id and ${UNBILLED}), 0))
                 as amount
          from app.invoices i
         where i.business_id = ${ctx.businessId} and i.status = 'issued' and i.deleted_at is null
           and i.order_id is not null
         group by i.order_id
      )
      select p.id as payment_id, p.order_id, o.number as order_number, o.customer_id,
             cu.name as customer_name, p.business_date::text as paid_on,
             trim_scale(least(p.amount, p.running - coalesce(c.amount, 0)))::text as amount,
             trim(o.currency) as currency
        from paid p
        join app.orders o on o.business_id = ${ctx.businessId} and o.id = p.order_id
        left join app.customers cu on cu.business_id = o.business_id and cu.id = o.customer_id
        left join covered c on c.order_id = p.order_id
       where p.amount > 0 and p.running - coalesce(c.amount, 0) > 0
       order by p.business_date, p.created_at, p.id
    `)) as unknown as {
      payment_id: string
      order_id: string
      order_number: string
      customer_id: string | null
      customer_name: string | null
      paid_on: string
      amount: string
      currency: string
    }[]
    return {
      items: rows
        .filter((r) => compareDecimal(r.amount, '0') > 0)
        .map((r) => ({
          orderId: r.order_id,
          orderNumber: r.order_number,
          customerId: r.customer_id,
          customerName: r.customer_name,
          paymentId: r.payment_id,
          paidOn: r.paid_on,
          amount: r.amount,
          currency: r.currency,
          dueBy: taxDocumentDueBy(r.paid_on),
          late: taxDocumentLate(r.paid_on, biz.today),
        })),
    }
  })
}
