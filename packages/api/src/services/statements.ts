import {
  STATEMENT_ENTRIES_MAX,
  type customerStatementInput,
  type CustomerStatementDto,
  type DocumentPdfDto,
  type StatementEntryKind,
} from '@bizcost/contracts'
import { documentRenders, type Tx } from '@bizcost/db'
import {
  newId,
  subtractDecimals,
  sumDecimals,
  type CustomerKind,
  type Emirate,
} from '@bizcost/domain'
import { isModuleActive } from '@bizcost/modules'
import { sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { fileNamePart } from '../documents/file-name'
import { buildStatementPdfInput, type PdfBusiness } from '../documents/pdf/build'
import type { DocumentPdfImage } from '../documents/pdf/input'
import { AppError } from '../errors'
import { renderDocumentPdf, type PrintableImage } from './document-files'
import { letterheadNow } from './invoices'
import { pdfPageCount } from './quotation-pdf'
import { ownCharges, type EntryRecord } from './statement-charges'
import { uuidArray } from './stock'

// Customer statements (ROADMAP.md M3 Step 8; the owner's answer Q27 = A of D-218): one customer's
// period, as a page and as a PDF on the business's letterhead. What it lists, each on its own day and
// as it stood at the end of that day (D-313):
//
//   charges: issued invoices (their payable, less what their order or sale charged on an earlier day),
//            delivered orders (on the delivery day, what their issued invoices did not bill by its end:
//            all of it when none), finalized sales "they'll pay later" (their total, unless invoiced
//            that day), money given back to the customer;
//   credits: issued credit notes (one that only billed less: less what its order owes again), refunds
//            of those orders and sales, payments that stand, and the payment of a sale paid when it
//            was made, on the day its first invoice is issued (it has no payment record).
//
// Owed at the start is every charge less every credit before the period; owed at the end adds the
// period's. An invoice issued after its order's delivery day or its sale's day says what of it was
// owed already through them (`owedThrough`): the work is charged once, a past period never changes
// and each period starts where the one before ended. A pending order is not yet a charge (its deposit
// shows as a payment, paid ahead). A payment, a sale they pay later or a refund reversed on its own day
// is not listed (it never counted); one reversed on a later day (the books closed on its day) stays on
// its day and its reversal is listed on the later day, as the books count it (D-334). A credit note
// that takes back all that was left takes back its invoice's rounding difference; an order's while
// its standing refunds take back all of its sale (D-333). A sale says its first items, a payment how
// it was paid. Since Release B (M3 Step 9) served with Customers and
// Payments for every business, orders-only ones included (B10); who sees them:
// `payments.customers.view` and `customers.items.view` (the router: a statement names the customer's
// particulars). Within one's branches when limited (Q12).

type StatementInput = z.output<typeof customerStatementInput>

const RANK: Readonly<Record<StatementEntryKind, number>> = {
  invoice: 0,
  order: 0,
  sale: 0,
  credit_note: 1,
  refund: 1,
  money_back: 2,
  payment: 3,
}

interface CustomerRow extends Record<string, unknown> {
  name: string
  kind: CustomerKind
  trn: string | null
  trade_licence_no: string | null
  address_line: string | null
  city: string | null
  emirate: Emirate | null
  country: string
  phone: string | null
}

/**
 * Every entry of the customer up to `to` (alias-free), within the caller's branches, each with the
 * order or sale whose own charge it may change (`src_kind`, `src_id`, `src_number`) and, for a credit
 * note, whether it only billed less (D-305). Each entry is as it was on its own day: what happens after
 * `to` never changes it (`ownCharges` shares the charges out).
 */
function entriesSql(ctx: BusinessCtx, customerId: string, to: string) {
  const b = ctx.businessId
  const scope = ctx.access.locationScope
  const inScope = (alias: string) =>
    scope.all ? sql`` : sql` and ${sql.raw(alias)}.location_id = any(${uuidArray([...scope.ids])})`
  const items = (alias: string) => sql`array(
    select coalesce(l.description, p.name, '') from app.sale_lines l
      left join app.products_services p on p.business_id = l.business_id and p.id = l.product_id
     where l.business_id = ${sql.raw(alias)}.business_id and l.sale_id = ${sql.raw(alias)}.id
       and l.kind = 'item' and l.deleted_at is null
     order by l.position, l.id limit 2)`
  const none = sql`'{}'::text[]`
  const srcOf = (alias: string) =>
    sql`case when ${sql.raw(alias)}.order_id is not null then 'order'
             when ${sql.raw(alias)}.sale_id is not null then 'sale' end::text`
  // A sale (or refund) as it stood at the end of its day: finalized, or reversed on a later day (the
  // books closed on its day, D-334: the books keep it there and count its reversal on the later day).
  const stoodOnItsDay = (alias: string) => {
    const a = sql.raw(alias)
    return sql`(${a}.status = 'posted'
      or (${a}.status = 'reversed' and ${a}.reversal_business_date > ${a}.business_date))`
  }
  const reversedLater = (alias: string) => {
    const a = sql.raw(alias)
    return sql`${a}.status = 'reversed' and ${a}.reversal_business_date > ${a}.business_date
      and ${a}.reversal_business_date <= ${to}::date`
  }
  // An order's rounding difference is taken back while the refunds that stand take back all of its
  // sale (D-333, as What customers owe counts it: obligationsOf). So the refund that brings them to all
  // of it credits the 0.01 with its total, and the reversal (on a later day) that takes them below it
  // charges it back with its total; any other refund or reversal moves its total only. The refunds of
  // r's sale that stand at a moment are those posted by then and not reversed by then, among those that
  // count: a refund reversed on its own day never counted (D-334), so it never stood.
  const standingRefunds = (at: SQL) => sql`(
      select coalesce(sum(-x.total), 0) from app.sales x
       where x.business_id = r.business_id and x.refund_of_id = r.refund_of_id
         and x.source = 'refund' and x.deleted_at is null and ${stoodOnItsDay('x')} and ${at})`
  // Just after r was posted (r included), and just before r was reversed (r included).
  const afterPosting = standingRefunds(sql`(x.posted_at, x.id) <= (r.posted_at, r.id)
         and (x.status = 'posted' or x.reversed_at > r.posted_at)`)
  const beforeReversal = standingRefunds(sql`(x.posted_at < r.reversed_at or x.id = r.id)
         and (x.status = 'posted' or (x.reversed_at, x.id) >= (r.reversed_at, r.id))`)
  // All of the sale taken back with r, and not without it (a refund of nothing never takes it twice).
  const roundingWith = (standing: SQL) => sql`case
      when r.order_id is not null and ${standing} = f.total and ${standing} + r.total <> f.total
      then o.rounding_difference else 0 end`
  const refundCredit = sql`-r.total + ${roundingWith(afterPosting)}`
  const reversalCharge = sql`-r.total + ${roundingWith(beforeReversal)}`
  // A payment as it stood at the end of its day: standing, or reversed on a later day.
  const paymentStood = sql`(p.reversed_at is null
    or coalesce(p.reversal_date, p.business_date) > p.business_date)`
  const paymentScope = scope.all
    ? sql``
    : sql`and coalesce(iv.location_id, o.location_id, s.location_id)
            = any(${uuidArray([...scope.ids])})`
  return sql`
    select i.issue_date::text as date, 'invoice'::text as kind, i.id, i.number, null::text as reference,
           trim_scale(i.payable)::text as charge, '0' as credit, false as paid_when_made, i.issued_at as created_at,
           ${none} as item_names, null::text as method, ${srcOf('i')} as src_kind,
           coalesce(i.order_id, i.sale_id) as src_id, o.number as src_number, false as bills_less,
           false as reversal
      from app.invoices i
      left join app.orders o on o.business_id = i.business_id and o.id = i.order_id
     where i.business_id = ${b} and i.customer_id = ${customerId} and i.status = 'issued'
       and i.deleted_at is null and i.issue_date <= ${to}::date${inScope('i')}
    union all
    select c.issue_date::text, 'credit_note', c.id, c.number, i.number, '0',
           trim_scale(c.total + c.rounding_difference)::text,
           false, c.issued_at, ${none}, null, ${srcOf('i')}, coalesce(i.order_id, i.sale_id), o.number,
           c.counted_on is null and c.counted_elsewhere is null, false
      from app.credit_notes c
      join app.invoices i on i.business_id = c.business_id and i.id = c.invoice_id
      left join app.orders o on o.business_id = i.business_id and o.id = i.order_id
     where c.business_id = ${b} and c.customer_id = ${customerId} and c.status = 'issued'
       and c.deleted_at is null and c.issue_date <= ${to}::date${inScope('c')}
    union all
    select o.delivered_on::text, 'order', o.id, o.number, null,
           trim_scale(o.total + o.rounding_difference)::text, '0', false, o.delivered_at, ${none}, null,
           'order', o.id, o.number, false, false
      from app.orders o
     where o.business_id = ${b} and o.customer_id = ${customerId} and o.status = 'delivered'
       and o.deleted_at is null and o.delivered_on <= ${to}::date${inScope('o')}
    union all
    select s.business_date::text, 'sale', s.id, null, null, trim_scale(s.total)::text, '0', false,
           s.posted_at, ${items('s')}, null, 'sale', s.id, null, false, false
      from app.sales s
     where s.business_id = ${b} and s.customer_id = ${customerId} and s.source = 'single'
       and s.pay_later and ${stoodOnItsDay('s')} and s.deleted_at is null
       and s.business_date <= ${to}::date${inScope('s')}
    union all
    -- Its reversal on the later day takes it off (a sale they pay later is reversed once its payments
    -- and refunds are, so nothing else of it changes).
    select s.reversal_business_date::text, 'sale', s.id, null, null, '0', trim_scale(s.total)::text,
           false, s.reversed_at, ${items('s')}, null, null, null, null, false, true
      from app.sales s
     where s.business_id = ${b} and s.customer_id = ${customerId} and s.source = 'single'
       and s.pay_later and ${reversedLater('s')} and s.deleted_at is null${inScope('s')}
    union all
    -- A source with refunds that stand is not invoiced, and an invoiced one is not refunded (D-305).
    select r.business_date::text, 'refund', r.id, o.number, null, '0',
           trim_scale(${refundCredit})::text,
           false, r.posted_at, ${items('r')}, null,
           case when r.order_id is null then 'sale' end::text,
           case when r.order_id is null then r.refund_of_id end, null, false, false
      from app.sales r
      left join app.orders o on o.business_id = r.business_id and o.id = r.order_id
      left join app.sales f on f.business_id = r.business_id and f.id = r.refund_of_id
     where r.business_id = ${b} and r.customer_id = ${customerId} and r.source = 'refund'
       and ${stoodOnItsDay('r')} and r.deleted_at is null and r.business_date <= ${to}::date
       and ((r.order_id is not null and o.status = 'delivered')
         or (r.order_id is null and f.pay_later))${inScope('r')}
    union all
    -- A refund reversed on a later day charges back what it took off as the refunds stood then.
    select r.reversal_business_date::text, 'refund', r.id, o.number, null,
           trim_scale(${reversalCharge})::text, '0',
           false, r.reversed_at, ${items('r')}, null,
           case when r.order_id is null then 'sale' end::text,
           case when r.order_id is null then r.refund_of_id end, null, false, true
      from app.sales r
      left join app.orders o on o.business_id = r.business_id and o.id = r.order_id
      left join app.sales f on f.business_id = r.business_id and f.id = r.refund_of_id
     where r.business_id = ${b} and r.customer_id = ${customerId} and r.source = 'refund'
       and ${reversedLater('r')} and r.deleted_at is null
       and ((r.order_id is not null and o.status = 'delivered')
         or (r.order_id is null and f.pay_later))${inScope('r')}
    union all
    -- A payment reversed on its own day never counted and is not listed; one reversed on a later day
    -- (its day closed) stays on its day, and its reversal is listed on the later day (D-334).
    select p.business_date::text,
           case p.kind when 'refund' then 'money_back' else 'payment' end,
           p.id, null, coalesce(iv.number, o.number),
           case p.kind when 'refund' then trim_scale(p.amount)::text else '0' end,
           case p.kind when 'refund' then '0' else trim_scale(p.amount)::text end,
           false, p.created_at, ${none}, p.method, null, null, null, false, false
      from app.customer_payments p
      left join app.invoices iv on iv.business_id = p.business_id and iv.id = p.invoice_id
      left join app.orders o on o.business_id = p.business_id and o.id = p.order_id
      left join app.sales s on s.business_id = p.business_id and s.id = p.sale_id
     where p.business_id = ${b} and p.customer_id = ${customerId} and ${paymentStood}
       and p.deleted_at is null and p.business_date <= ${to}::date
       ${paymentScope}
    union all
    select p.reversal_date::text,
           case p.kind when 'refund' then 'money_back' else 'payment' end,
           p.id, null, coalesce(iv.number, o.number),
           case p.kind when 'refund' then '0' else trim_scale(p.amount)::text end,
           case p.kind when 'refund' then trim_scale(p.amount)::text else '0' end,
           false, p.reversed_at, ${none}, p.method, null, null, null, false, true
      from app.customer_payments p
      left join app.invoices iv on iv.business_id = p.business_id and iv.id = p.invoice_id
      left join app.orders o on o.business_id = p.business_id and o.id = p.order_id
      left join app.sales s on s.business_id = p.business_id and s.id = p.sale_id
     where p.business_id = ${b} and p.customer_id = ${customerId} and p.reversed_at is not null
       and p.reversal_date > p.business_date and p.reversal_date <= ${to}::date
       and p.deleted_at is null
       ${paymentScope}
    union all
    -- A sale paid when it was made: no charge of its own, so its payment counts on the day its first
    -- invoice is issued (toward that invoice).
    select fi.issue_date::text, 'payment', s.id, null, null, '0',
           trim_scale(s.total - coalesce((select sum(-r.total) from app.sales r
              where r.business_id = s.business_id and r.refund_of_id = s.id
                and r.status = 'posted' and r.deleted_at is null), 0))::text,
           true, fi.issued_at, ${items('s')}, null, null, null, null, false, false
      from app.sales s
      join lateral (
        select x.issue_date, x.issued_at from app.invoices x
         where x.business_id = s.business_id and x.sale_id = s.id and x.status = 'issued'
           and x.deleted_at is null
         order by x.issue_date, x.issued_at, x.id limit 1
      ) fi on true
     where s.business_id = ${b} and s.customer_id = ${customerId} and s.source = 'single'
       and not s.pay_later and s.status = 'posted' and s.deleted_at is null
       and fi.issue_date <= ${to}::date${inScope('s')}`
}

/** The statement's figures (read in `tx`). */
async function statementOf(
  tx: Tx,
  ctx: BusinessCtx,
  input: StatementInput,
): Promise<{ dto: CustomerStatementDto; customer: CustomerRow; today: string }> {
  const [customer] = (await tx.execute(sql`
    select c.name, c.kind, c.trn, c.trade_licence_no, c.address_line, c.city, c.emirate,
           trim(c.country) as country, c.phone
      from app.customers c
     where c.business_id = ${ctx.businessId} and c.id = ${input.customerId} and c.deleted_at is null
  `)) as unknown as CustomerRow[]
  if (!customer) throw new AppError('not_found')
  const [business] = (await tx.execute(sql`
    select trim(b.currency) as currency, (now() at time zone b.timezone)::date::text as today
      from app.businesses b where b.id = ${ctx.businessId}
  `)) as unknown as { currency: string; today: string }[]
  if (!business) throw new AppError('forbidden')
  if (input.to > business.today) throw new AppError('future_date')
  const rows = ownCharges(
    (await tx.execute(sql`
      select e.* from (${entriesSql(ctx, input.customerId, input.to)}) e
       order by e.date, e.created_at, e.id
    `)) as unknown as EntryRecord[],
  )
  rows.sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || RANK[a.kind] - RANK[b.kind],
  )
  const before = rows.filter((r) => r.date < input.from)
  const within = rows.filter((r) => r.date >= input.from)
  if (within.length > STATEMENT_ENTRIES_MAX) {
    throw new AppError('validation', { message: 'period: too many entries; choose a shorter one' })
  }
  const opening = subtractDecimals(
    sumDecimals(before.map((r) => r.charge)),
    sumDecimals(before.map((r) => r.credit)),
  )
  let owed = opening
  const entries = within.map((r) => {
    owed = subtractDecimals(sumDecimals([owed, r.charge]), r.credit)
    return {
      date: r.date,
      kind: r.kind,
      id: r.id,
      number: r.number,
      reference: r.paid_when_made ? null : r.reference,
      paidWhenMade: r.paid_when_made,
      itemNames: r.item_names.filter((name) => name.trim() !== ''),
      method: r.method,
      owedThrough: r.owedThrough,
      reversal: r.reversal,
      charge: r.charge,
      credit: r.credit,
      owed,
    }
  })
  // Invoiced and credited: the documents' charges and credits (a refund reversed later charges again,
  // a sale reversed later credits, D-334); paid: the payments net of money given back.
  const isPayment = (r: { kind: StatementEntryKind }) =>
    r.kind === 'payment' || r.kind === 'money_back'
  const charges = within.filter((r) => !isPayment(r)).map((r) => r.charge)
  const credited = within.filter((r) => !isPayment(r)).map((r) => r.credit)
  const paidRows = within.filter(isPayment)
  const paid = subtractDecimals(
    sumDecimals(paidRows.map((r) => r.credit)),
    sumDecimals(paidRows.map((r) => r.charge)),
  )
  const dto: CustomerStatementDto = {
    customerId: input.customerId,
    customer: {
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
    },
    currency: business.currency,
    from: input.from,
    to: input.to,
    opening,
    entries,
    invoiced: sumDecimals(charges),
    credited: sumDecimals(credited),
    paid,
    closing: owed,
    // It speaks of invoices and credit notes with Invoices on, or when the period lists one (Invoices
    // switched off since): an orders-only business's says "Orders and sales" and "Payments and refunds".
    invoicing:
      ctx.modules.some(
        (m) => m.id === 'invoices' && isModuleActive(m, ctx.access.enabledModules),
      ) || entries.some((e) => e.kind === 'invoice' || e.kind === 'credit_note'),
  }
  return { dto, customer, today: business.today }
}

/** `customer.statement` (payments.customers.view and customers.items.view; every business, B10). */
export function customerStatement(
  ctx: BusinessCtx,
  input: StatementInput,
): Promise<CustomerStatementDto> {
  return ctx.tx(async (tx) => (await statementOf(tx, ctx, input)).dto)
}

/** `customer.statementPdf`: the statement as a PDF on the letterhead (counted first, RATE_LIMITED). */
export async function customerStatementPdf(
  ctx: BusinessCtx,
  input: StatementInput,
): Promise<DocumentPdfDto> {
  const { dto, customer, today, letterhead } = await ctx.tx(async (tx) => {
    const read = await statementOf(tx, ctx, input)
    await tx.insert(documentRenders).values({
      id: newId(),
      businessId: ctx.businessId,
      kind: 'statement',
      documentId: input.customerId,
    })
    return { ...read, letterhead: await letterheadNow(tx, ctx.businessId) }
  })
  const row = letterhead as unknown as {
    legal_name: string
    legal_name_ar: string | null
    default_locale: string
    vat_registered: boolean
    trn: string | null
    phone: string | null
    phone_2: string | null
    email: string | null
    address_line: string | null
    city: string | null
    emirate: Emirate | null
    trade_licence_no: string | null
    document_accent: string
    document_watermark: boolean
    document_signatory: string | null
    document_footer: string | null
    logo_path: string | null
  }
  const business: PdfBusiness = {
    legalName: row.legal_name,
    legalNameAr: row.legal_name_ar,
    locale: row.default_locale === 'ar' ? 'ar' : 'en',
    vatRegistered: row.vat_registered,
    trn: row.trn,
    phone: row.phone,
    phone2: row.phone_2,
    email: row.email,
    addressLine: row.address_line,
    city: row.city,
    emirate: row.emirate,
    tradeLicenceNo: row.trade_licence_no,
    accent: row.document_accent,
    watermark: row.document_watermark,
    wholeAmounts: false,
    signatory: row.document_signatory,
    footer: row.document_footer,
  }
  const wanted: PrintableImage[] = row.logo_path ? [{ key: 'logo', path: row.logo_path }] : []
  const make = (images: Readonly<Record<string, DocumentPdfImage>>) =>
    buildStatementPdfInput({
      business,
      statement: {
        from: dto.from,
        to: dto.to,
        issuedOn: today,
        currency: dto.currency,
        opening: dto.opening,
        invoiced: dto.invoiced,
        credited: dto.credited,
        paid: dto.paid,
        closing: dto.closing,
        invoicing: dto.invoicing,
        issuedAt: new Date(`${today}T00:00:00Z`),
        entries: dto.entries.map((e) => ({
          date: e.date,
          kind: e.kind,
          number: e.number,
          reference: e.reference,
          paidWhenMade: e.paidWhenMade,
          itemNames: e.itemNames,
          method: e.method,
          owedThrough: e.owedThrough,
          reversal: e.reversal,
          charge: e.charge,
          credit: e.credit,
          owed: e.owed,
        })),
      },
      customer: {
        name: customer.name,
        phone: customer.phone,
        trn: customer.trn,
        addressLine: customer.address_line,
        city: customer.city,
        emirate: customer.emirate,
      },
      businessImages: { logo: row.logo_path ? 'logo' : null, signature: null, stamp: null },
      images,
    })
  const pdf = await renderDocumentPdf(ctx, wanted, make)
  // The customer's name in its own script: two Arabic names never download as one (Release B review).
  return {
    fileName: `statement-${fileNamePart(customer.name, 'customer')}-${dto.from}-${dto.to}.pdf`,
    contentType: 'application/pdf',
    base64: Buffer.from(pdf).toString('base64'),
    pages: pdfPageCount(pdf),
    bytes: pdf.byteLength,
  }
}
