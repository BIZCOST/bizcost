import type { CreditNoteDto, InvoiceDto, QuotationDto, SaleListItemDto } from '@bizcost/contracts'
import {
  compareDecimal,
  newId,
  plusDays,
  proportionOf,
  subtractDecimals,
  sumDecimals,
} from '@bizcost/domain'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeText, pdfFullText } from '../src/documents/pdf/text-layer'
import { FACTORY } from './orders'
import { codeOf, ok } from './purchasing'
import { InvoiceScope, InvoicesApi, typed } from './invoices'

// The rules of invoices and credit notes through the API (ROADMAP.md M3 Step 8, the plan's tests):
// VAT once per rate on every issued invoice (PINT-AE aligned-ibrp-s-09) and every line mapping as
// IBR-147-AE reads it, a property; deposits (deposit VAT + final VAT = the work's VAT, a property);
// counting once (Q3) and one owed figure; closed books (an issue is never blocked while a day is
// open: only its sale moves); the issue's preconditions (B16, C5) and its warnings (IBR-143-AE,
// IBR-144-AE, the 14-day note); a copy to a quotation sent again; the customer's statement PDF.

const api = new InvoicesApi()
afterAll(() => api.close())

const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))

/** |a − b| ≤ `slack`. */
function within(a: string, b: string, slack: string): boolean {
  const difference = subtractDecimals(a, b)
  return compareDecimal(difference, slack) <= 0 && compareDecimal(difference, `-${slack}`) >= 0
}

/** VAT once per rate (S-09) and the lines adding up, on an issued invoice. */
function expectVatPerRate(invoice: InvoiceDto) {
  const items = invoice.lines.filter((l) => l.kind !== 'deduction')
  expect(sumDecimals(invoice.lines.map((l) => l.net)), 'net').toBe(sumDecimals([invoice.netTotal]))
  expect(sumDecimals(invoice.lines.map((l) => l.vat)), 'vat').toBe(sumDecimals([invoice.vatTotal]))
  expect(sumDecimals(invoice.vatRates.map((r) => r.vat))).toBe(sumDecimals([invoice.vatTotal]))
  expect(sumDecimals(invoice.vatRates.map((r) => r.net))).toBe(sumDecimals([invoice.netTotal]))
  for (const rate of invoice.vatRates) {
    const percent = rate.vatRate ?? '0'
    // PINT-AE allows 0.02; BizCost holds it within a fils (prices that include VAT).
    expect(
      within(rate.vat, proportionOf(rate.net, percent, '100', 2), '0.01'),
      `${percent} %`,
    ).toBe(true)
    const ofRate = items.filter(
      (l) => l.vatCategory === rate.vatCategory && (l.vatRate ?? null) === (rate.vatRate ?? null),
    )
    expect(sumDecimals(ofRate.map((l) => l.vat)), `lines of ${percent} %`).toBe(
      sumDecimals([rate.vat]),
    )
  }
  // IBR-147-AE: a line priced before VAT maps its own price for 1 (its net = qty × price less its
  // allowances); a price that includes VAT maps its net for the line's quantity when not exact.
  for (const line of items) {
    expect(compareDecimal(line.net, '0'), line.description).toBeGreaterThanOrEqual(0)
    if (!line.priceIncludesVat || (line.vatRate ?? '0') === '0') {
      expect(sumDecimals([line.subtotal]), line.description).toBe(
        sumDecimals([proportionOf(line.qty, line.unitPrice, '1', 2)]),
      )
      expect(compareDecimal(line.net, line.subtotal)).toBeLessThanOrEqual(0)
    }
  }
  expect(sumDecimals([invoice.netTotal, invoice.vatTotal])).toBe(sumDecimals([invoice.total]))
}

describe('VAT once per rate and IBR-147-AE on every issued invoice (a property)', () => {
  let scope: InvoiceScope
  let customerId: string
  beforeAll(async () => {
    scope = await InvoiceScope.open(api)
    await scope.taxReady()
    customerId = (await scope.buyer()).id
  })

  const line = fc.record({
    qty: fc.constantFrom('1', '2', '2.5', '0.75', '3', '12', '1.333'),
    unitPrice: fc
      .integer({ min: 1, max: 250_000 })
      .map((fils) => proportionOf(String(fils), '1', '100', 2)),
    priceIncludesVat: fc.boolean(),
    vatCategory: fc.constantFrom('standard', 'standard', 'zero_rated', 'exempt'),
    discount: fc.option(fc.constantFrom({ percent: '10' }, { percent: '2.5' }, { amount: '0.5' }), {
      nil: undefined,
    }),
  })

  it('S-09 within a fils, the lines adding up to each rate, every line mapping', async () => {
    let made = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(line, { minLength: 1, maxLength: 5 }),
        fc.option(fc.constantFrom({ percent: '5' }, { amount: '1.25' }), { nil: undefined }),
        async (lines, discount) => {
          made += 1
          const result = await scope.as<InvoiceDto>(scope.owner, 'invoice.create', {
            id: newId(),
            customerId,
            ...(discount ? { discount } : {}),
            lines: lines.map((l, i) =>
              typed(`Item ${made}.${i + 1}`, l.qty, l.unitPrice, {
                priceIncludesVat: l.priceIncludesVat,
                vatCategory: l.vatCategory,
                ...(l.discount ? { discount: l.discount } : {}),
              }),
            ),
          })
          // A discount larger than a line is refused as typed: nothing to issue.
          if (result.error) {
            expect(codeOf(result), result.raw).toBe('validation')
            return
          }
          const issued = await scope.issue(result.data!)
          expect(issued.kind).toBe('tax_invoice')
          expectVatPerRate(issued)
        },
      ),
      { numRuns: 12 },
    )
  }, 180_000)
})

describe('deposits: the deposit VAT and the final VAT are the VAT on the work (a property)', () => {
  it('for any work and any deposit, VAT and what is owed are counted once', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const channelId = await scope.channelId()
    const service = await scope.service('1')
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10_000, max: 5_000_000 }),
        fc.integer({ min: 1, max: 99 }),
        async (workFils, share) => {
          const price = proportionOf(String(workFils), '1', '100', 2)
          const order = await scope.order({
            customerId: customer.id,
            channelId,
            lines: [
              { kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: price },
            ],
          })
          const amount = proportionOf(order.payable, String(share), '100', 2)
          const deposit = await scope.issue(
            await scope.fromOrder(order.id, { bills: 'part', part: { amount }, isDeposit: true }),
          )
          expect(deposit).toMatchObject({ isDeposit: true, payable: sumDecimals([amount]) })
          const delivered = await scope.deliver(await scope.getOrder(order.id))
          const final = await scope.issue(await scope.fromOrder(delivered.id, { bills: 'rest' }))
          const deduction = final.lines.filter((l) => l.kind === 'deduction')
          expect(deduction.map((l) => l.depositInvoiceNumber)).toEqual([deposit.number])
          expect(sumDecimals([deposit.vatTotal, final.vatTotal])).toBe(
            sumDecimals([order.vatTotal]),
          )
          expect(sumDecimals([deposit.payable, final.payable])).toBe(sumDecimals([order.payable]))
          expectVatPerRate(deposit)
          expect(final.vatRates.every((r) => compareDecimal(r.vat, '0') >= 0)).toBe(true)
        },
      ),
      { numRuns: 6 },
    )
  }, 240_000)
})

describe('counting once (Q3) and one owed figure', () => {
  it('a sale for an invoice that counts; none for one from an order, a deposit or one already counted; a credit note takes back once', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const channelId = await scope.channelId()
    const service = await scope.service('1000')
    const salesOf = async (source: string): Promise<SaleListItemDto[]> =>
      (await scope.sales({ source })).items.filter((s) => s.status === 'posted')

    // No recorded sales yet: not asked; the invoice counts (its sale posted, AED 1,050).
    const first = await scope.issued({
      customerId: customer.id,
      lines: [typed('Survey', '1', '1000')],
    })
    expect(first).toMatchObject({ counts: true, asksCountedElsewhere: false })
    expect((await salesOf('invoice')).map((s) => s.total)).toEqual(['1050'])

    // Recorded sales now exist (One sale): the question must be answered, never preselected.
    await scope.sell({
      businessDate: await scope.today(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '1000' }],
    })
    const asked = await scope.invoice({
      customerId: customer.id,
      lines: [typed('Catering', '1', '400')],
    })
    expect(asked).toMatchObject({ asksCountedElsewhere: true, countedElsewhere: null })
    expect(codeOf(await scope.issueRaw(asked))).toBe('validation')
    const answered = ok(
      await scope.as<InvoiceDto>(scope.owner, 'invoice.update', {
        id: asked.id,
        version: asked.version,
        customerId: customer.id,
        countedElsewhere: true,
      }),
    )
    const elsewhere = await scope.issue(answered)
    expect(elsewhere).toMatchObject({ counts: false, countedElsewhere: true })

    // An order's invoice and its deposit: the order's delivery is its sale.
    const order = await scope.order({
      customerId: customer.id,
      channelId,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '2', unitPrice: '1000' }],
    })
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { percent: '50' }, isDeposit: true }),
    )
    const delivered = await scope.deliver(await scope.getOrder(order.id))
    const final = await scope.issue(await scope.fromOrder(delivered.id, { bills: 'rest' }))
    for (const invoice of [deposit, final]) expect(invoice.counts).toBe(false)
    expect((await salesOf('invoice')).map((s) => s.total)).toEqual(['1050'])
    expect((await salesOf('order')).map((s) => s.total)).toEqual(['2100'])

    // A credit note of the invoice that counted takes its share back once (a sale of its own).
    const note = await scope.credit(first.id, {
      by: 'amount',
      lines: [{ invoiceLineId: first.lines[0]!.id, amount: '200' }],
    })
    expect(note).toMatchObject({ counts: true, total: '210' })
    expect((await salesOf('credit_note')).map((s) => s.total)).toEqual(['-210'])
    // One of the invoice counted elsewhere asks again, and one of an order's invoice counts.
    const draft = await scope.as<CreditNoteDto>(scope.owner, 'creditNote.create', {
      id: newId(),
      invoiceId: elsewhere.id,
      eventDate: await scope.today(),
      reason: 'price_changed',
      reasonText: 'Fewer guests',
      by: 'amount',
      lines: [{ invoiceLineId: elsewhere.lines[0]!.id, amount: '100' }],
    })
    expect(ok(draft)).toMatchObject({ asksCountedElsewhere: true })
    expect(codeOf(await scope.as(scope.owner, 'creditNote.issue', draft.data!))).toBe('validation')

    // One owed figure: the invoices, never their order (A2).
    const owed = await scope.receivables({ customerId: customer.id })
    const documents = owed.groups.flatMap((g) => g.documents)
    expect(documents.every((d) => d.kind === 'invoice')).toBe(true)
    expect(documents.map((d) => d.number).sort()).toEqual(
      [first.number, elsewhere.number, deposit.number, final.number].sort(),
    )
    expect(owed.owed).toBe(
      sumDecimals([
        subtractDecimals(first.payable, note.total),
        elsewhere.payable,
        deposit.payable,
        final.payable,
      ]),
    )
  }, 120_000)
})

describe('closed books never block an issue while a day is open (H5)', () => {
  it('a supply on a closed day counts on the first open one; closed through today: BOOKS_CLOSED, no number', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const today = await scope.today()
    const yesterday = plusDays(today, -1)
    const service = await scope.service('500')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '500' }],
    })
    const delivered = await scope.deliver(order)
    ok(await scope.run('books.close', { closedThrough: yesterday }))

    const first = await scope.issued({
      customerId: customer.id,
      supplyDate: yesterday,
      lines: [typed('Installation', '1', '300')],
    })
    expect(first).toMatchObject({ number: 'INV-0001', supplyDate: yesterday, countedOn: today })
    const [sale] = (await scope.sales({ source: 'invoice' })).items
    expect(sale).toMatchObject({ businessDate: today, total: '315' })

    const counting = await scope.invoice({
      customerId: customer.id,
      lines: [typed('Repair', '1', '100')],
    })
    const fromOrder = await scope.fromOrder(delivered.id)
    ok(await scope.run('books.close', { closedThrough: today }))
    expect(codeOf(await scope.issueRaw(counting))).toBe('books_closed')
    // The order's invoice posts nothing: it issues, with the next number.
    expect((await scope.issue(fromOrder)).number).toBe('INV-0002')
    const note = await scope.creditDraft(first.id, {
      by: 'amount',
      lines: [{ invoiceLineId: first.lines[0]!.id, amount: '50' }],
    })
    expect(codeOf(await scope.as(scope.owner, 'creditNote.issue', note))).toBe('books_closed')

    ok(await scope.run('books.close', { closedThrough: yesterday }))
    expect((await scope.issueCredit(note)).number).toBe('CN-0001')
    expect((await scope.issue(await scope.getInvoice(counting.id))).number).toBe('INV-0003')
  }, 60_000)
})

describe("an issue's preconditions (B16, C5) and its warnings", () => {
  it('a tax invoice needs the business TRN and address, a registered customer’s address; a refused issue takes no number', async () => {
    const scope = await InvoiceScope.open(api)
    const customer = await scope.buyer()
    const draft = await scope.invoice({
      customerId: customer.id,
      lines: [typed('Desk', '1', '700')],
    })
    expect(draft.missing).toEqual(expect.arrayContaining(['business_address']))
    expect(codeOf(await scope.issueRaw(draft))).toBe('details_missing')
    // An address without its emirate: the issue goes, with IBR-143-AE named (it binds later).
    await scope.taxReady({ emirate: null })
    const partly = await scope.getInvoice(draft.id)
    expect(partly.missing).toEqual([])
    expect(partly.warnings).toContain('ibr_143_ae')
    await scope.taxReady()
    const issued = await scope.issue(await scope.getInvoice(draft.id))
    expect(issued.number).toBe('INV-0001')
    expect(issued.warnings).toEqual([])
  })

  it('a business customer without a full address: IBR-144-AE named, never blocking', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const company = await scope.customer({ kind: 'business', name: 'Palm Interiors LLC' })
    const draft = await scope.invoice({
      customerId: company.id,
      lines: [typed('Chair', '4', '120')],
    })
    expect(draft.warnings).toEqual(['ibr_144_ae'])
    expect((await scope.issue(draft)).number).toBe('INV-0001')
  })

  it('a supply more than 14 days old: the 14-day note (VAT DL Art. 67(1)), and for a credit note (Art. 62(2))', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const today = await scope.today()
    const supply = plusDays(today, -15)
    const draft = await scope.invoice({
      customerId: customer.id,
      supplyDate: supply,
      lines: [typed('Cabinet', '1', '900')],
    })
    expect(draft).toMatchObject({ taxInvoiceDueBy: plusDays(supply, 14) })
    expect(draft.warnings).toContain('late')
    const onTime = await scope.invoice({
      customerId: customer.id,
      supplyDate: plusDays(today, -14),
      lines: [typed('Cabinet', '1', '900')],
    })
    expect(onTime.warnings).not.toContain('late')
    const issued = await scope.issue(draft)
    const note = await scope.creditDraft(issued.id, {
      eventDate: supply,
      by: 'amount',
      lines: [{ invoiceLineId: issued.lines[0]!.id, amount: '100' }],
    })
    expect(note).toMatchObject({ late: true, dueBy: plusDays(supply, 14) })
  })
})

describe('an invoice copied to a quotation', () => {
  it('sent again: the same quotation; another invoice under its id: CONFLICT', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const invoice = await scope.issued({
      customerId: customer.id,
      lpoReference: 'LPO-7781',
      lines: [typed('Kitchen units', '3', '1200', { unit: 'm' }), typed('Fitting', '1', '400')],
    })
    const newQuotationId = newId()
    const input = { id: invoice.id, newId: newQuotationId }
    const copy = ok(await scope.as<QuotationDto>(scope.owner, 'invoice.copyToQuotation', input))
    expect(copy).toMatchObject({
      status: 'draft',
      customerId: customer.id,
      customerRef: 'LPO-7781',
    })
    expect(copy.lines.map((l) => [l.description, l.qty, l.unitPrice])).toEqual([
      ['Kitchen units', '3', '1200'],
      ['Fitting', '1', '400'],
    ])
    const again = ok(await scope.as<QuotationDto>(scope.owner, 'invoice.copyToQuotation', input))
    expect(again).toEqual(copy)
    const other = await scope.issued({ customerId: customer.id, lines: [typed('Door', '1', '90')] })
    const clash = await scope.as(scope.owner, 'invoice.copyToQuotation', {
      id: other.id,
      newId: newQuotationId,
    })
    expect(codeOf(clash)).toBe('conflict')
  })
})

describe("a customer's statement on the letterhead (Q27)", () => {
  it('the period, what was invoiced, credited and paid, and what is still owed', async () => {
    const scope = await InvoiceScope.open(api, FACTORY)
    await scope.taxReady()
    const customer = await scope.buyer({ name: 'Coral Bay Hotel LLC' })
    const invoice = await scope.issued({
      customerId: customer.id,
      countedElsewhere: false,
      lpoReference: 'PO-5520',
      lines: [typed('Steel railings', '1', '4000')],
    })
    await scope.credit(invoice.id, {
      by: 'amount',
      lines: [{ invoiceLineId: invoice.lines[0]!.id, amount: '400' }],
    })
    await scope.payInvoice(invoice.id, '1000')
    const today = await scope.today()
    const from = `${today.slice(0, 8)}01`
    const statement = await scope.statement(customer.id, from, today)
    expect(statement).toMatchObject({
      opening: '0',
      invoiced: '4200',
      credited: '420',
      paid: '1000',
    })
    expect(statement.closing).toBe('2780')
    const pdf = ok(
      await scope.as<{ base64: string; fileName: string }>(scope.owner, 'customer.statementPdf', {
        customerId: customer.id,
        from,
        to: today,
      }),
    )
    const text = await pdfFullText(decode(pdf.base64))
    expect(text).toContain('Statement of Account')
    expect(text).toContain(normalizeText('كشف حساب'))
    expect(text).toContain('Coral Bay Hotel LLC')
    expect(text).toContain(invoice.number!)
    expect(text).toContain('4,200.00')
    expect(text).toContain('2,780.00')
  })
})
