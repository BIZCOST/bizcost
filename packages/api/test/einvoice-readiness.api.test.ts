import type { CreditNoteDto, InvoiceDto } from '@bizcost/contracts'
import {
  CREDIT_REASON_LAW,
  CREDIT_REASONS,
  isUuid,
  plusDays,
  TAX_INVOICE_CURRENCY,
  vatPointDateOf,
} from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoiceScope, InvoicesApi, typed } from './invoices'

// E-invoicing readiness (ROADMAP.md M3 Step 8; the plan's open item on the UAE e-invoicing system,
// D-301, D-309): BizCost does not build the Accredited Service Provider connector yet, but every
// PINT-AE field it owns has a column now, filled and frozen at issue, so the connector milestone maps
// documents already issued without asking anyone again. The fields BizCost does not own are named
// below as connector-milestone fields. Checked: each owned field's column exists and is filled on an
// issued tax invoice and tax credit note; the credit reasons map one-to-one onto PINT-AE's BTAE-03
// codes DL8.61.1.A–E (VD never: a BizCost credit note refers to one invoice, IBR-055-AE); IBT-007
// carries the date of supply only when it is earlier than the date of issue; BTAE-07 is the
// invoice's UUID.

interface Owned {
  table: 'invoices' | 'invoice_lines' | 'credit_notes' | 'credit_note_lines'
  column: string
  /** Filled on every issued tax document (else: when it applies). */
  always?: boolean
}

/** The PINT-AE fields BizCost owns, and their columns. */
const OWNED: Record<string, Owned> = {
  // The invoice.
  'IBT-001 invoice number': { table: 'invoices', column: 'number', always: true },
  'IBT-002 issue date': { table: 'invoices', column: 'issue_date', always: true },
  'IBT-003 type code (tax invoice; 381 for a credit note)': {
    table: 'invoices',
    column: 'kind',
    always: true,
  },
  'IBT-005 currency (AED)': { table: 'invoices', column: 'currency', always: true },
  'IBT-007 VAT point date (the supply, only when earlier: vatPointDateOf)': {
    table: 'invoices',
    column: 'supply_date',
    always: true,
  },
  'IBT-009 payment due date': { table: 'invoices', column: 'due_date' },
  'IBT-013 purchase order reference (LPO)': { table: 'invoices', column: 'lpo_reference' },
  'IBT-022 note': { table: 'invoices', column: 'notes' },
  'BTAE-07 the invoice UUID': { table: 'invoices', column: 'id', always: true },
  // The seller and the buyer, frozen at issue.
  'IBT-027 seller name': { table: 'invoices', column: 'seller_name', always: true },
  // Its identifier type (BTAE-15) is TL, a trade licence: the only kind BizCost keeps.
  'IBT-030 seller legal registration (trade licence)': {
    table: 'invoices',
    column: 'seller_trade_licence',
    always: true,
  },
  'BTAE-12 the authority that issued the seller licence': {
    table: 'invoices',
    column: 'seller_trade_licence_authority',
    always: true,
  },
  'IBT-031 seller VAT identifier (TRN)': { table: 'invoices', column: 'seller_trn', always: true },
  'IBT-035 seller address line': { table: 'invoices', column: 'seller_address_line', always: true },
  'IBT-037 seller city': { table: 'invoices', column: 'seller_city', always: true },
  'IBT-039 seller emirate': { table: 'invoices', column: 'seller_emirate', always: true },
  'IBT-044 buyer name': { table: 'invoices', column: 'customer_name', always: true },
  // Its identifier type (BTAE-16) is TL when given.
  'IBT-047 buyer legal registration (trade licence)': {
    table: 'invoices',
    column: 'customer_trade_licence',
  },
  'IBT-048 buyer VAT identifier (TRN)': { table: 'invoices', column: 'customer_trn' },
  'IBT-050 buyer address line': { table: 'invoices', column: 'customer_address_line' },
  'IBT-052 buyer city': { table: 'invoices', column: 'customer_city' },
  'IBT-054 buyer emirate': { table: 'invoices', column: 'customer_emirate' },
  'IBT-055 buyer country': { table: 'invoices', column: 'customer_country' },
  // Totals and VAT, once per rate (S-09).
  'IBT-106 sum of line nets': { table: 'invoices', column: 'net_total', always: true },
  'IBT-107 document allowances (its discount)': {
    table: 'invoices',
    column: 'discount_total',
    always: true,
  },
  'IBT-110 total VAT': { table: 'invoices', column: 'vat_total', always: true },
  'IBT-112 total with VAT (BTAE-20 too: it is in AED)': {
    table: 'invoices',
    column: 'total',
    always: true,
  },
  'IBT-114 rounding amount': { table: 'invoices', column: 'rounding_difference', always: true },
  'IBT-115 amount due': { table: 'invoices', column: 'payable', always: true },
  'IBG-23 VAT breakdown (IBT-116 to IBT-119, per rate)': {
    table: 'invoices',
    column: 'vat_rates',
    always: true,
  },
  // Lines (IBR-147-AE maps each through pintLineOf).
  'IBT-126 line id': { table: 'invoice_lines', column: 'id', always: true },
  'IBT-129 quantity': { table: 'invoice_lines', column: 'qty', always: true },
  'IBT-130 unit': { table: 'invoice_lines', column: 'unit' },
  'IBT-131 line net': { table: 'invoice_lines', column: 'net', always: true },
  'IBT-136 line allowance (its discount)': {
    table: 'invoice_lines',
    column: 'discount',
    always: true,
  },
  'IBT-146 net price': { table: 'invoice_lines', column: 'unit_price', always: true },
  'IBT-151 VAT category': { table: 'invoice_lines', column: 'vat_category', always: true },
  'IBT-152 VAT rate': { table: 'invoice_lines', column: 'vat_rate', always: true },
  'IBT-153 item name': { table: 'invoice_lines', column: 'description', always: true },
  'IBT-154 item description': { table: 'invoice_lines', column: 'details' },
  // Credit notes.
  'IBT-001 credit note number': { table: 'credit_notes', column: 'number', always: true },
  'IBT-002 credit note issue date': { table: 'credit_notes', column: 'issue_date', always: true },
  'IBT-025 preceding invoice (its number through it)': {
    table: 'credit_notes',
    column: 'invoice_id',
    always: true,
  },
  'BTAE-03 credit note reason code (CREDIT_REASON_LAW)': {
    table: 'credit_notes',
    column: 'reason',
    always: true,
  },
  'credit note reason text (ER Art. 60(1)(f))': {
    table: 'credit_notes',
    column: 'reason_text',
    always: true,
  },
  'the event date of the reason': { table: 'credit_notes', column: 'event_date', always: true },
  'ER Art. 60(1)(e) the value before': {
    table: 'credit_notes',
    column: 'value_before',
    always: true,
  },
  'ER Art. 60(1)(e) the correct value': {
    table: 'credit_notes',
    column: 'value_after',
    always: true,
  },
  'IBT-129 credited quantity': { table: 'credit_note_lines', column: 'qty', always: true },
  'IBT-131 credited line net': { table: 'credit_note_lines', column: 'net', always: true },
}

/**
 * Named for the connector milestone (not owned now): what the ASP's connector derives, asks or adds
 * when it is built (D-301).
 */
const CONNECTOR_FIELDS = [
  'the TIN (the participant identifier) derived from the TRN',
  'buyer legal identifier types other than a trade licence (BizCost never stores an Emirates ID or a passport number)',
  'BTAE-11 the authority that issued the buyer licence (IBR-101-AE; customers keep the licence number only)',
  'BTAE-02 the transaction type code, and type code 480 for a plain invoice with IBR-136-AE (the buyer legal id)',
  'BTAE-04, BTAE-08 and BTAE-10: amounts in AED and the exchange rate (a tax invoice is in AED)',
  'the payment means and the bank account (the footer prints them as text)',
  'the e-invoice and e-credit note cases of MD 243 Art. 6(2) (EINVOICE_CREDIT_CASES)',
]

const api = new InvoicesApi()
afterAll(() => api.close())

describe('e-invoicing readiness: each PINT-AE field BizCost owns maps to a column', () => {
  let scope: InvoiceScope
  let invoice: InvoiceDto
  let note: CreditNoteDto
  let today: string
  beforeAll(async () => {
    scope = await InvoiceScope.open(api)
    await scope.taxReady()
    today = await scope.today()
    const customer = await scope.buyer({
      name: 'Al Wasl Offices LLC',
      tradeLicenceNo: 'DED-660031',
    })
    invoice = await scope.issued({
      customerId: customer.id,
      supplyDate: plusDays(today, -3),
      dueDate: plusDays(today, 30),
      lpoReference: 'LPO-AW-118',
      notes: 'Phase one',
      lines: [
        typed('Glass partition', '12.5', '310', { unit: 'm2', details: 'Tempered, 10 mm' }),
        typed('Site survey', '1', '450', { vatCategory: 'zero_rated' }),
      ],
    })
    note = await scope.credit(invoice.id, {
      by: 'quantity',
      reason: 'goods_returned',
      reasonText: 'Two panels returned',
      lines: [{ invoiceLineId: invoice.lines[0]!.id, qty: '2' }],
    })
  }, 60_000)

  it('every owned field has its column', async () => {
    const columns = await api.admin<{ table_name: string; column_name: string }[]>`
      select table_name::text, column_name::text from information_schema.columns
       where table_schema = 'app'
         and table_name in ('invoices', 'invoice_lines', 'credit_notes', 'credit_note_lines')`
    const have = new Set(columns.map((c) => `${c.table_name}.${c.column_name}`))
    const missing = Object.entries(OWNED)
      .filter(([, field]) => !have.has(`${field.table}.${field.column}`))
      .map(([id]) => id)
    expect(missing).toEqual([])
    expect(CONNECTOR_FIELDS.length).toBeGreaterThan(0)
  })

  it('an issued tax invoice and its credit note fill every field that always applies', async () => {
    const ids: Record<Owned['table'], string[]> = {
      invoices: [invoice.id],
      invoice_lines: invoice.lines.map((l) => l.id),
      credit_notes: [note.id],
      credit_note_lines: note.lines.map((l) => l.id),
    }
    const empty: string[] = []
    for (const [id, field] of Object.entries(OWNED)) {
      if (!field.always) continue
      const rows = await api.admin<{ value: unknown }[]>`
        select to_jsonb(t) -> ${field.column} as value from ${api.admin(`app.${field.table}`)} t
         where t.id = any(${ids[field.table]}::uuid[])`
      expect(rows.length, id).toBe(ids[field.table].length)
      if (rows.some((r) => r.value === null)) empty.push(id)
    }
    expect(empty).toEqual([])
    // The fields that apply to this invoice are filled too (its LPO, due date, buyer's licence).
    const [row] = await api.admin<Record<string, string | null>[]>`
      select lpo_reference, due_date::text, customer_trn, customer_trade_licence, customer_city,
             customer_country, currency, kind from app.invoices where id = ${invoice.id}`
    expect(row).toMatchObject({
      lpo_reference: 'LPO-AW-118',
      due_date: plusDays(today, 30),
      customer_trade_licence: 'DED-660031',
      currency: TAX_INVOICE_CURRENCY,
      kind: 'tax_invoice',
    })
  })

  it('BTAE-07 is the invoice’s UUID; IBT-007 is the supply day only when it is earlier', async () => {
    expect(isUuid(invoice.id)).toBe(true)
    expect(invoice.number).toBe('INV-0001')
    expect(vatPointDateOf(invoice.issueDate!, invoice.supplyDate)).toBe(plusDays(today, -3))
    const sameDay = await scope.issued({
      customerId: invoice.customerId,
      lines: [typed('Door handle', '4', '35')],
    })
    expect(sameDay.supplyDate).toBe(sameDay.issueDate)
    expect(vatPointDateOf(sameDay.issueDate!, sameDay.supplyDate)).toBeNull()
  })

  it('the credit reasons map one-to-one onto BTAE-03 DL8.61.1.A–E (no VD), as each credit note says', () => {
    const codes = CREDIT_REASONS.map((reason) => CREDIT_REASON_LAW[reason].pintAe)
    expect([...codes].sort()).toEqual([
      'DL8.61.1.A',
      'DL8.61.1.B',
      'DL8.61.1.C',
      'DL8.61.1.D',
      'DL8.61.1.E',
    ])
    expect(new Set(codes).size).toBe(CREDIT_REASONS.length)
    expect(codes).not.toContain('VD')
    // The VAT DL Art. 61(1) cases (a)–(e), one each.
    expect(CREDIT_REASONS.map((reason) => CREDIT_REASON_LAW[reason].vatLaw).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ])
    expect(note.reasonLaw).toEqual(CREDIT_REASON_LAW.goods_returned)
    expect(note).toMatchObject({ kind: 'tax_credit_note', number: 'CN-0001', currency: 'AED' })
  })
})
