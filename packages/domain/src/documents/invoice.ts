import type Decimal from 'decimal.js'
import type { VatCategory } from '../catalog/keys'
import { Dec, fixed, toDec } from '../numbers/decimal'
import type { Money, Percent } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'
import { splitDecimals } from './split'
import { vatIn } from './vat'

// Invoices and credit notes (M3 Step 8; the owner's answers Q3, Q17, Q22, Q24–Q27 of D-218; VAT
// Decree-Law Arts 61, 62, 67, 69; VAT Executive Regulation Arts 59 and 60; Ministerial Decision 243 of
// 2025 Art. 6(2); PINT-AE 1.0.4). Pure rules, decimal.js only:
//
//   - **Kinds** (Q26): a VAT-registered business issues a full «فاتورة ضريبية · Tax Invoice» and
//     «إشعار دائن ضريبي · Tax Credit Note» (no simplified ones), in AED; one that is not issues a plain
//     «فاتورة · Invoice» and «إشعار دائن · Credit Note» (never the word "tax"). The kind is set by the
//     VAT registration at issue and frozen.
//   - **Status**: draft → issued. An issued invoice is never edited, reversed or deleted: only a credit
//     note corrects it, even a full cancellation (ER Art. 60). Numbers are taken at issue, gaplessly.
//   - **Billing** (Q22): an invoice bills everything of its source (an accepted quotation, an order or
//     a recorded sale), a part (a stage or a deposit, % or an amount of the source's payable), or the
//     rest. A part prints one line per VAT rate of the source, priced with VAT so it comes to exactly
//     the part (`partOfRates`); the rest takes what is left of each rate's net and VAT exactly
//     (`restOfRates`), so the parts add up to the source to the fils. A final invoice after deposit
//     invoices carries the source's lines and takes each deposit invoice's net and VAT off, one
//     deduction per VAT rate (`applyDeductions`): VAT is charged once, deposit VAT + final VAT = the
//     VAT on the work.
//   - **Counting once** (Q3, `invoiceCounts`): issuing posts the invoice's sale on its supply date,
//     except an invoice made from an order (the delivery counts), from a recorded sale (that sale
//     counts), a deposit invoice (the final invoice counts the whole work) or one answered "already in
//     my recorded sales". A credit note posts a negative sale once the work its invoice bills has
//     counted (`creditNoteCounts`): before that (a deposit invoice no final invoice took off yet, an
//     invoice of an order not delivered yet) it only bills less; on an invoice counted elsewhere it
//     asks the same question.
//   - **What is owed** (A2, `allocatePayments`): once an order or a sale has an issued invoice, what is
//     owed lives on its invoices: its payments count toward them, a deposit invoice first, then by
//     number, each up to what it still needs; the last takes the rest.
//   - **Credit reasons**: one list mapped to VAT DL Art. 61(1) (the tax credit note's reasons today),
//     to PINT-AE's BTAE-03 codes and to MD 243 Art. 6(2) (e-credit notes later).

/** `invoices.status` and `credit_notes.status`. */
export const INVOICE_STATUSES = ['draft', 'issued'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

/** `invoices.kind` (Q26): set by the VAT registration at issue, frozen. */
export const INVOICE_KINDS = ['tax_invoice', 'invoice'] as const
export type InvoiceKind = (typeof INVOICE_KINDS)[number]

/** `credit_notes.kind`: a tax invoice's credit note is a tax credit note, a plain one's plain (B5). */
export const CREDIT_NOTE_KINDS = ['tax_credit_note', 'credit_note'] as const
export type CreditNoteKind = (typeof CREDIT_NOTE_KINDS)[number]

/** What an invoice bills of its source (Q22): everything, a part (% or amount), or the rest. */
export const INVOICE_BILLS = ['everything', 'part', 'rest'] as const
export type InvoiceBills = (typeof INVOICE_BILLS)[number]

/**
 * `invoice_lines.kind`: an `item` (a product or service, or typed: also a stage's or a deposit's line),
 * the `delivery` charged to the customer (from an order), or a `deduction` (a final invoice's line per
 * VAT rate taking a deposit invoice's net and VAT off, naming it; negative).
 */
export const INVOICE_LINE_KINDS = ['item', 'delivery', 'deduction'] as const
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number]

/** The kind an invoice issued now takes. */
export function invoiceKindFor(vatRegistered: boolean): InvoiceKind {
  return vatRegistered ? 'tax_invoice' : 'invoice'
}

/** The kind of a credit note of an invoice of `kind`. */
export function creditNoteKindOf(kind: InvoiceKind): CreditNoteKind {
  return kind === 'tax_invoice' ? 'tax_credit_note' : 'credit_note'
}

/** A tax invoice is in AED (VAT DL Art. 69; ER Art. 59(1)(h), (j), (k)). */
export const TAX_INVOICE_CURRENCY = 'AED'

// ---------------------------------------------------------------------------------------------------
// The 14-day notes (VAT DL Art. 67(1) with ER Art. 59(13); Art. 62(2) as amended by FDL 18/2022)
// ---------------------------------------------------------------------------------------------------

/** Days a tax invoice may follow its supply, and a tax credit note its reason (and a deposit). */
export const TAX_DOCUMENT_DAYS = 14

/** YYYY-MM-DD + `days`. */
export function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a day: "${day}"`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The last day a tax document of an event on `day` is due: `day` + 14. */
export function taxDocumentDueBy(day: string): string {
  return plusDays(day, TAX_DOCUMENT_DAYS)
}

/** Whether a tax document of an event on `day` issued `today` is late (more than 14 days after it). */
export function taxDocumentLate(day: string, today: string): boolean {
  return today > taxDocumentDueBy(day)
}

/**
 * PINT-AE IBT-007 (the VAT point date) of an invoice issued on `issueDate` for a supply on `supplyDate`:
 * the date of supply only when it is earlier than the date of issue (the tax point it then is, VAT DL
 * Art. 25); otherwise none (the issue date, IBT-002, is the tax point).
 */
export function vatPointDateOf(issueDate: string, supplyDate: string | null): string | null {
  return supplyDate !== null && supplyDate < issueDate ? supplyDate : null
}

// ---------------------------------------------------------------------------------------------------
// Credit reasons (VAT DL Art. 61(1); PINT-AE BTAE-03; MD 243 Art. 6(2))
// ---------------------------------------------------------------------------------------------------

/**
 * Why a credit note is issued. One-to-one with VAT DL Art. 61(1) (a)–(e) and PINT-AE's credit reason
 * codes DL8.61.1.A–E (BTAE-03, required once since PINT-AE 1.0.1). PINT-AE's VD (volume discount) is
 * not offered: every BizCost credit note refers to one invoice, which IBR-055-AE requires unless the
 * code is VD.
 */
export const CREDIT_REASONS = [
  'cancelled',
  'tax_treatment_changed',
  'price_changed',
  'goods_returned',
  'tax_charged_in_error',
] as const
export type CreditReason = (typeof CREDIT_REASONS)[number]

/** MD 243 Art. 6(2): the four cases of an electronic credit note. */
export const EINVOICE_CREDIT_CASES = ['cancelled', 'reduced', 'returned', 'error'] as const
export type EInvoiceCreditCase = (typeof EINVOICE_CREDIT_CASES)[number]

/** How each reason reads in each list. */
export const CREDIT_REASON_LAW: Readonly<
  Record<
    CreditReason,
    {
      /** The letter of VAT DL Art. 61(1). */
      readonly vatLaw: 'a' | 'b' | 'c' | 'd' | 'e'
      /** PINT-AE BTAE-03. */
      readonly pintAe: string
      /** MD 243 Art. 6(2): (a) cancelled, (b) consideration reduced, (c) returned, (d) error. */
      readonly md243: EInvoiceCreditCase
    }
  >
> = {
  cancelled: { vatLaw: 'a', pintAe: 'DL8.61.1.A', md243: 'cancelled' },
  tax_treatment_changed: { vatLaw: 'b', pintAe: 'DL8.61.1.B', md243: 'reduced' },
  price_changed: { vatLaw: 'c', pintAe: 'DL8.61.1.C', md243: 'reduced' },
  goods_returned: { vatLaw: 'd', pintAe: 'DL8.61.1.D', md243: 'returned' },
  tax_charged_in_error: { vatLaw: 'e', pintAe: 'DL8.61.1.E', md243: 'error' },
}

// ---------------------------------------------------------------------------------------------------
// Counting once (Q3)
// ---------------------------------------------------------------------------------------------------

/** Where an invoice comes from, for counting once. */
export interface InvoiceCountingContext {
  /** Made from an order: its delivery counts. */
  readonly fromOrder: boolean
  /** Made from a recorded sale: that sale counts. */
  readonly fromSale: boolean
  /** A deposit invoice: the final invoice counts the whole work. */
  readonly isDeposit: boolean
  /** The answer to "Is this sale already in your recorded sales?" (null: not asked). */
  readonly countedElsewhere: boolean | null
}

/** Whether issuing the invoice posts its sale (on its supply date). */
export function invoiceCounts(ctx: InvoiceCountingContext): boolean {
  return !ctx.fromOrder && !ctx.fromSale && !ctx.isDeposit && ctx.countedElsewhere !== true
}

/**
 * Whether the invoice must ask "Is this sale already in your recorded sales (Today's sales, an import
 * or your POS)?": only when such sales exist and it is not made from an order, a sale or a deposit.
 * The answer is required and never preselected.
 */
export function invoiceAsksCountedElsewhere(
  ctx: Omit<InvoiceCountingContext, 'countedElsewhere'> & { readonly hasRecordedSales: boolean },
): boolean {
  return ctx.hasRecordedSales && !ctx.fromOrder && !ctx.fromSale && !ctx.isDeposit
}

/**
 * What a credit note's counting follows (Q3): the invoice that counted the work its invoice bills (the
 * invoice itself, or for a deposit invoice the final invoice that took it off).
 */
export interface CreditCountingContext {
  /**
   * Whether that work has counted in sales yet. False for a deposit invoice no final invoice has taken
   * off yet, and for an invoice of an order not delivered yet (its delivery counts later): a credit
   * note then only bills less (it posts no sale, and the source's later invoices bill it again).
   */
  readonly workCounted: boolean
  /** That invoice's answer to "Is this sale already in your recorded sales?" (null: not asked). */
  readonly countedElsewhere: boolean | null
}

/** Whether a credit note asks the same question: once its work counted, on an invoice counted elsewhere. */
export function creditNoteAsksCountedElsewhere(ctx: CreditCountingContext): boolean {
  return ctx.workCounted && ctx.countedElsewhere === true
}

/**
 * Whether issuing a credit note posts a negative sale (on its issue date): only once its work counted
 * (never on a deposit invoice before its final invoice, nor on an invoice of an order before its
 * delivery); then on an invoice counted elsewhere only when answered "not in my recorded sales", and
 * otherwise always (also on an invoice made from an order or a sale: their sale counted).
 */
export function creditNoteCounts(
  ctx: CreditCountingContext,
  countedElsewhere: boolean | null,
): boolean {
  if (!ctx.workCounted) return false
  if (ctx.countedElsewhere === true) return countedElsewhere === false
  return true
}

// ---------------------------------------------------------------------------------------------------
// Parts of a source: stages, deposits and the rest (Q22)
// ---------------------------------------------------------------------------------------------------

/** One VAT rate of a document: its taxable amount and VAT (ibg-23; null category without VAT). */
export interface DocumentRate {
  readonly vatCategory: VatCategory | null
  readonly vatRate: Percent | null
  readonly net: Money
  readonly vat: Money
}

/** A part's amounts at one rate: with VAT (`gross`), its net and VAT. */
export interface RateAmount extends DocumentRate {
  /** net + VAT: what the part's line of this rate comes to (priced with VAT). */
  readonly gross: Money
}

/** The key of a rate (its category and rate), so the same rate on two documents is one. */
export function rateKey(rate: {
  readonly vatCategory: VatCategory | null
  readonly vatRate: string | null
}): string {
  return `${rate.vatCategory ?? 'none'}|${rate.vatRate === null ? '' : toDec(rate.vatRate).toString()}`
}

/** Σ net and Σ VAT of `rates` by rate. */
function sumsByRate(rates: readonly DocumentRate[]): Map<string, { net: Decimal; vat: Decimal }> {
  const sums = new Map<string, { net: Decimal; vat: Decimal }>()
  for (const rate of rates) {
    const key = rateKey(rate)
    const sum = sums.get(key) ?? { net: toDec('0'), vat: toDec('0') }
    sums.set(key, { net: sum.net.plus(toDec(rate.net)), vat: sum.vat.plus(toDec(rate.vat)) })
  }
  return sums
}

/** What is left of each of the source's rates after `billed` (net, VAT, and with VAT). */
function leftByRate(source: readonly DocumentRate[], billed: readonly DocumentRate[]) {
  const taken = sumsByRate(billed)
  const known = new Set(source.map(rateKey))
  for (const [key, sum] of taken) {
    if (!known.has(key) && (!sum.net.isZero() || !sum.vat.isZero())) {
      throw new RangeError('A bill names a rate the source has not')
    }
  }
  return source.map((rate) => {
    const sum = taken.get(rateKey(rate)) ?? { net: toDec('0'), vat: toDec('0') }
    const net = toDec(rate.net).minus(sum.net)
    const vat = toDec(rate.vat).minus(sum.vat)
    if (net.lt(0) || vat.lt(0)) throw new RangeError('The bills pass a rate of the source')
    return { rate, billed: sum, net, vat, gross: net.plus(vat) }
  })
}

/**
 * A part of `amount` (with VAT: a stage or a deposit of the source's payable) of a source whose rates
 * are `source`, after the parts `billed` before it (their rates). The amount is shared over what is
 * left of each rate (with VAT, largest remainder), so each share is one line priced with VAT and the
 * invoice comes to exactly `amount`. Each share's VAT is rounded on the running total of the source's
 * parts at its rate: VAT(billed before + this share) − the VAT billed before, so no invoice's VAT is
 * ever more than a fils from its net × the rate (PINT-AE S-09 with its 0.02 slack, however many parts)
 * and the parts' VAT adds up to the source's. A share that takes all that is left of its rate takes
 * exactly its net and VAT left, so the last part ("the rest") makes the parts add up to the source to
 * the fils. Rates with nothing in the share are left out. Throws RangeError for a negative amount, more
 * decimals than the currency has, an amount over what is left, or bills that pass the source.
 */
export function partOfRates(
  source: readonly DocumentRate[],
  billed: readonly DocumentRate[],
  amount: Money,
  currency: CurrencyCode,
): RateAmount[] {
  const digits = currencyMinorUnit(currency)
  const left = leftByRate(source, billed)
  const whole = toDec(amount)
  const leftTotal = left.reduce((acc, l) => acc.plus(l.gross), toDec('0'))
  if (whole.gt(leftTotal)) throw new RangeError('A part over what is left of the source')
  const shares = splitDecimals(
    whole,
    left.map((l) => l.gross),
    digits,
  )
  const out: RateAmount[] = []
  for (const [i, l] of left.entries()) {
    const gross = shares[i]!
    if (gross.isZero()) continue
    let net: Decimal
    let vat: Decimal
    if (gross.eq(l.gross)) {
      net = l.net
      vat = l.vat
    } else if (l.rate.vatRate === null || toDec(l.rate.vatRate).isZero()) {
      net = gross
      vat = toDec('0')
    } else {
      const before = l.billed.net.plus(l.billed.vat)
      vat = vatIn(before.plus(gross), l.rate.vatRate, digits).minus(l.billed.vat)
      vat = Dec.min(Dec.max(vat, 0), l.vat)
      net = gross.minus(vat)
      if (net.gt(l.net)) {
        net = l.net
        vat = gross.minus(net)
      }
    }
    out.push({
      vatCategory: l.rate.vatCategory,
      vatRate: l.rate.vatRate,
      net: fixed(net, digits) as Money,
      vat: fixed(vat, digits) as Money,
      gross: fixed(gross, digits) as Money,
    })
  }
  return out
}

/**
 * What is left of each of the source's rates after the invoices billed before (their rates, summed by
 * rate): net left and VAT left, exactly (the last part: "the rest"). A rate with nothing left is left
 * out. Throws RangeError when the bills pass a rate or name one the source has not.
 */
export function restOfRates(
  source: readonly DocumentRate[],
  billed: readonly DocumentRate[],
  currency: CurrencyCode,
): RateAmount[] {
  const digits = currencyMinorUnit(currency)
  return leftByRate(source, billed)
    .filter((l) => !l.net.isZero() || !l.vat.isZero())
    .map((l) => ({
      vatCategory: l.rate.vatCategory,
      vatRate: l.rate.vatRate,
      net: fixed(l.net, digits) as Money,
      vat: fixed(l.vat, digits) as Money,
      gross: fixed(l.gross, digits) as Money,
    }))
}

/** A deposit invoice's rate taken off a final invoice (its net and VAT, positive). */
export interface Deduction extends DocumentRate {
  /** The deposit invoice it takes off. */
  readonly depositInvoiceId: string
}

/** What a final invoice comes to after its deductions. */
export interface DeductedAmounts {
  /** The VAT breakdown after the deductions (each rate's net and VAT less the deposits'). */
  readonly rates: DocumentRate[]
  readonly net: Money
  readonly vat: Money
  readonly total: Money
}

export type DeductionErrorCode = 'deduction_over_net' | 'deduction_unknown_rate'

/**
 * A final invoice's amounts: the source's whole work (`rates`, as computeSale gave them) less each
 * deposit invoice's net and VAT at the same rate, before VAT (Q22, H8): each rate's VAT is the VAT on
 * the work less the VAT the deposits charged, so VAT is charged once and deposit VAT + final VAT =
 * VAT on the work. Returns the error when a deduction passes its rate's net or VAT, or names a rate the
 * work has not.
 */
export function applyDeductions(
  rates: readonly DocumentRate[],
  deductions: readonly Deduction[],
  currency: CurrencyCode,
): DeductedAmounts | DeductionErrorCode {
  const digits = currencyMinorUnit(currency)
  const byKey = new Map<string, { rate: DocumentRate; net: Decimal; vat: Decimal }>(
    rates.map((r) => [rateKey(r), { rate: r, net: toDec(r.net), vat: toDec(r.vat) }]),
  )
  for (const d of deductions) {
    const entry = byKey.get(rateKey(d))
    if (!entry) return 'deduction_unknown_rate'
    entry.net = entry.net.minus(toDec(d.net))
    entry.vat = entry.vat.minus(toDec(d.vat))
    if (entry.net.lt(0) || entry.vat.lt(0)) return 'deduction_over_net'
  }
  const out = [...byKey.values()].map((e) => ({
    vatCategory: e.rate.vatCategory,
    vatRate: e.rate.vatRate,
    net: fixed(e.net, digits) as Money,
    vat: fixed(e.vat, digits) as Money,
  }))
  const net = out.reduce((acc, r) => acc.plus(toDec(r.net)), toDec('0'))
  const vat = out.reduce((acc, r) => acc.plus(toDec(r.vat)), toDec('0'))
  return {
    rates: out,
    net: fixed(net, digits) as Money,
    vat: fixed(vat, digits) as Money,
    total: fixed(net.plus(vat), digits) as Money,
  }
}

/**
 * A final invoice's deductions: one per deposit invoice and VAT rate, each naming its deposit invoice
 * (H8), its net and VAT as that invoice charged them (rates with nothing are left out).
 */
export function deductionsOf(
  deposits: readonly { readonly id: string; readonly rates: readonly DocumentRate[] }[],
): Deduction[] {
  return deposits.flatMap((deposit) =>
    deposit.rates
      .filter((r) => !toDec(r.net).isZero() || !toDec(r.vat).isZero())
      .map((r) => ({ ...r, depositInvoiceId: deposit.id })),
  )
}

// ---------------------------------------------------------------------------------------------------
// What is owed: payments of an order or a sale counted toward its invoices (A2)
// ---------------------------------------------------------------------------------------------------

/** An invoice of one order or sale, in the order its payments go to: deposits first, then by number. */
export interface OwingInvoice {
  /** What it still needs from them: payable − credited − what was paid on the invoice itself. */
  readonly need: string
}

/**
 * How `available` (what was paid on the order or sale, net of money given back; a sale paid when made
 * its total) is counted toward its invoices: each in turn up to what it needs, and the last takes all
 * that is left (paid beyond it shows as money back to the customer on it). Never below zero.
 */
export function allocatePayments(available: string, invoices: readonly OwingInvoice[]): string[] {
  let left = Dec.max(toDec(available), 0)
  return invoices.map((invoice, i) => {
    if (i === invoices.length - 1) {
      const all = left
      left = toDec('0')
      return all.toString()
    }
    const need = Dec.max(toDec(invoice.need), 0)
    const take = Dec.min(need, left)
    left = left.minus(take)
    return take.toString()
  })
}

// ---------------------------------------------------------------------------------------------------
// A credit note's values (ER Art. 60(1)(e))
// ---------------------------------------------------------------------------------------------------

/** The four figures ER Art. 60(1)(e) asks a tax credit note to show, in AED. */
export interface CreditNoteValues {
  /** The value of the supply shown on the invoice, less the earlier credit notes on it. */
  readonly valueBefore: Money
  /** The correct value of the supply after this credit note. */
  readonly valueAfter: Money
  /** The difference (this credit note's net). */
  readonly difference: Money
  /** The VAT that relates to the difference. */
  readonly vat: Money
}

/**
 * ER Art. 60(1)(e): the invoice's value of the supply (its net) less earlier credit notes' nets, the
 * value after this one, the difference and its VAT. Throws RangeError when the credits pass the value.
 */
export function creditNoteValues(
  invoiceNet: Money,
  earlierNets: readonly Money[],
  net: Money,
  vat: Money,
  currency: CurrencyCode,
): CreditNoteValues {
  const digits = currencyMinorUnit(currency)
  const before = earlierNets.reduce((acc, n) => acc.minus(toDec(n)), toDec(invoiceNet))
  const after = before.minus(toDec(net))
  if (after.lt(0)) throw new RangeError('A credit note passes the value of the supply')
  return {
    valueBefore: fixed(before, digits) as Money,
    valueAfter: fixed(after, digits) as Money,
    difference: fixed(toDec(net), digits) as Money,
    vat: fixed(toDec(vat), digits) as Money,
  }
}

/** How much of an invoice its credit notes took back (with VAT): none, a part, or all of it. */
export const INVOICE_CREDIT_STATES = ['none', 'partly', 'credited'] as const
export type InvoiceCreditState = (typeof INVOICE_CREDIT_STATES)[number]

export function invoiceCreditState(total: string, credited: string): InvoiceCreditState {
  const c = toDec(credited)
  if (c.lte(0)) return 'none'
  return c.gte(toDec(total)) ? 'credited' : 'partly'
}

/** An issued invoice is overdue when it still owes something after its due date. */
export function invoiceOverdue(dueDate: string | null, owed: string, today: string): boolean {
  return dueDate !== null && dueDate < today && toDec(owed).gt(0)
}
