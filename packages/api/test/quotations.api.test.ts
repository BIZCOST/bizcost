import type { BusinessProfileDto, OrderDto, QuotationDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeText, pdfFullText, pdfText } from '../src/documents/pdf/text-layer'
import { codeOf, ok } from './purchasing'
import { DESIGNER, QuotationScope, QuotationsApi, quoteItem, quoteTyped } from './quotations'

// Quotations (ROADMAP.md M3 Step 7; Q21–Q25; the owner's document requests of 2026-10-16), through the
// API with Quotations previewed (D-125): numbers Q-0001… from document_counters, "Round the total"
// with one VAT rate and with two (D-221's examples), payment stages that add up exactly, revisions that
// keep their history and are frozen once sent, accepting then an order (typed lines stay typed, Q21,
// and carry their share with no materials in the order's profit), the document settings (a series'
// first number only before its first quotation), and the PDF read back (its title, an Arabic customer
// name, the TRN). Every business and customer is fictional.

let api: QuotationsApi

beforeAll(() => {
  api = new QuotationsApi()
})

afterAll(async () => {
  await api.close()
})

/** A VAT-registered fit-out company with its TRN, and a customer. */
async function fitOut() {
  const scope = await QuotationScope.open(api)
  const profile = ok(await scope.run<BusinessProfileDto>('business.profile'))
  ok(
    await scope.run('business.updateProfile', {
      version: profile.version,
      legalName: profile.legalName,
      legalNameAr: 'لمسة عصرية للديكور',
      vatRegistered: true,
      trn: '100123456700003',
    }),
  )
  const customer = await scope.customer({ name: 'خالد المنصوري', phone: '055 555 0123' })
  return { scope, customer }
}

describe('Round the total', () => {
  it('one rate: 1,120.00 → 1,100.00 is −19.05 before VAT with VAT 52.38', async () => {
    const { scope, customer } = await fitOut()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Kitchen cabinets', '1', '1066.67')],
      roundTo: '1100.00',
    })
    expect(quote).toMatchObject({
      adjustment: '-19.05',
      roundingDifference: '0',
      vatTotal: '52.38',
      total: '1100',
      payable: '1100',
      roundTo: '1100',
    })
    expect(quote.vatRates).toEqual([
      { vatCategory: 'standard', vatRate: '5', net: '1047.62', vat: '52.38' },
    ])
  })

  it('two rates: 2,000 at 5 % + 500 at 0 % = 2,600.00 → 2,500.00, VAT 96.15', async () => {
    const { scope, customer } = await fitOut()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [
        quoteTyped('Joinery', '1', '2000'),
        quoteTyped('Export crate', '1', '500', { vatCategory: 'zero_rated' }),
      ],
      roundTo: '2500.00',
    })
    expect(quote).toMatchObject({
      adjustment: '-96.15',
      vatTotal: '96.15',
      netTotal: '2403.85',
      payable: '2500',
    })
    expect(quote.lines.map((l) => l.net)).toEqual(['1923.08', '480.77'])
    expect(quote.vatRates.map((r) => [r.vatCategory, r.net, r.vat])).toEqual([
      ['standard', '1923.08', '96.15'],
      ['zero_rated', '480.77', '0.00'],
    ])
  })

  it('an unreachable total keeps a rounding difference of at most 0.02; nothing to round is refused', async () => {
    const { scope, customer } = await fitOut()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Shelf', '1', '952.48')],
      roundTo: '1000.12',
    })
    expect(quote).toMatchObject({
      total: '1000.11',
      roundingDifference: '0.01',
      payable: '1000.12',
    })
    const empty = await scope.run('quotation.create', {
      id: newId(),
      customerId: customer.id,
      businessDate: await scope.today(),
      roundTo: '100',
    })
    expect(codeOf(empty)).toBe('validation')
  })
})

describe('payment stages', () => {
  it('share the payable total exactly, the last stage the rest', async () => {
    const { scope, customer } = await fitOut()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Villa joinery', '1', '15333.33')],
      roundTo: '16100.00',
      stages: [
        { due: 'Upon signing', percent: '50' },
        { due: 'Upon delivery', percent: '35' },
        { label: 'Handover', due: 'After handover', percent: '15' },
      ],
    })
    expect(quote.payable).toBe('16100')
    expect(quote.stages.map((s) => s.amount)).toEqual(['8050', '5635', '2415'])
    const thirds = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Design', '1', '95.24')],
      stages: [
        { due: 'One', percent: '33.3333' },
        { due: 'Two', percent: '33.3333' },
        { due: 'Three', percent: '33.3334' },
      ],
    })
    expect(thirds.payable).toBe('100')
    expect(thirds.stages.map((s) => s.amount)).toEqual(['33.33', '33.33', '33.34'])
    const wrong = await scope.run('quotation.create', {
      id: newId(),
      customerId: customer.id,
      businessDate: await scope.today(),
      lines: [quoteTyped('Design', '1', '100')],
      stages: [{ due: 'Now', percent: '60' }],
    })
    expect(codeOf(wrong)).toBe('validation')
  })
})

describe('revisions, answers and an order', () => {
  it('keeps every revision: the first frozen once sent, superseded by the next one sent', async () => {
    const { scope, customer } = await fitOut()
    const product = await scope.service('800')
    const first = await scope.quote({
      customerId: customer.id,
      customerRef: 'ENQ-118',
      site: 'Villa 12, Al Barsha',
      lines: [
        quoteTyped('Wall cladding', '18.5', '650', {
          area: 'MAJLIS',
          unit: 'm2',
          details: 'MDF with oak veneer\nHidden door',
          note: '* Marble priced separately',
        }),
        quoteItem(product.id, '1', '800', { area: 'MAJLIS' }),
        quoteTyped('Dining cabinet', '4.2', '1450', { area: 'Dining room', unit: 'm' }),
      ],
      roundTo: '15000.00',
    })
    expect(first).toMatchObject({
      number: 'Q-0001',
      revision: 1,
      status: 'draft',
      payable: '15000',
    })
    expect(first.lines.map((l) => l.typed)).toEqual([true, false, true])
    expect(first.lines[0]).toMatchObject({
      area: 'MAJLIS',
      details: 'MDF with oak veneer\nHidden door',
      note: '* Marble priced separately',
      unit: 'm2',
    })

    const sent = await scope.send(first)
    expect(sent.status).toBe('sent')
    expect(await scope.send(sent)).toMatchObject({ status: 'sent', version: sent.version })
    const frozen = await scope.run('quotation.update', {
      id: sent.id,
      version: sent.version,
      customerId: customer.id,
      businessDate: sent.businessDate,
      lines: [],
    })
    expect(codeOf(frozen)).toBe('quotation_frozen')

    const second = await scope.revise(sent)
    expect(second).toMatchObject({ number: 'Q-0001', revision: 2, status: 'draft', latest: true })
    expect(second.lines.map((l) => l.description)).toEqual(sent.lines.map((l) => l.description))
    const stillSent = await scope.getQuote(sent.id)
    expect(stillSent).toMatchObject({ status: 'sent', latest: false })
    const reviseOld = await scope.run('quotation.revise', { id: sent.id, newId: newId() })
    expect(codeOf(reviseOld)).toBe('quotation_superseded')

    const secondSent = await scope.send(second)
    expect((await scope.getQuote(sent.id)).status).toBe('superseded')
    const accepted = await scope.accept(secondSent, 'Signed on site')
    expect(accepted).toMatchObject({ status: 'accepted', acceptNote: 'Signed on site' })
    expect(await scope.accept(accepted)).toMatchObject({ status: 'accepted' })
    expect(
      codeOf(await scope.run('quotation.decline', { id: accepted.id, version: accepted.version })),
    ).toBe('quotation_decided')

    const list = await scope.quotes()
    const listed = list.items.filter((q) => q.number === 'Q-0001')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ revision: 2, listStatus: 'accepted' })

    const { orderId, orderNumber, quotation } = await scope.toOrder(accepted)
    expect(orderNumber).toBe('#1001')
    expect(quotation.orderId).toBe(orderId)
    const again = ok(
      await scope.run<{ orderId: string }>('quotation.toOrder', {
        id: accepted.id,
        orderId: newId(),
      }),
    )
    expect(again.orderId).toBe(orderId)
    const order = ok(await scope.run<{ data: OrderDto }>('order.get', { id: orderId })).data
    expect(order).toMatchObject({
      customerId: customer.id,
      customerRef: 'ENQ-118',
      payable: '15000',
      adjustment: accepted.adjustment,
    })
    expect(order.lines.map((l) => [l.typed, l.description])).toEqual([
      [true, 'Wall cladding'],
      [false, product.name],
      [true, 'Dining cabinet'],
    ])

    const history = await scope.history(accepted.id)
    const kinds = history.events.map((e) => `${e.kind}:${e.revision}`)
    for (const event of [
      'created:1',
      'sent:1',
      'revised:2',
      'superseded:1',
      'sent:2',
      'accepted:2',
      'ordered:2',
    ]) {
      expect(kinds).toContain(event)
    }
    expect(history.events.find((e) => e.kind === 'ordered')?.reference).toBe('#1001')
  })

  it('a typed line counts in sales with its share and no materials, and the profit says so', async () => {
    const { scope, customer } = await fitOut()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Site visit and design', '1', '1000')],
    })
    const accepted = await scope.accept(await scope.send(quote))
    const { orderId } = await scope.toOrder(accepted)
    const order = ok(await scope.run<{ data: OrderDto }>('order.get', { id: orderId })).data
    const delivered = await scope.deliver(order)
    expect(delivered.status).toBe('delivered')
    expect(delivered.profit).toMatchObject({ sales: '1000', typedSales: '1000', materials: '0' })
    expect(delivered.profit?.reasons ?? []).not.toContain('no_recipe')
  })

  it('a draft is discarded with its number kept; a sent one is not', async () => {
    const { scope, customer } = await fitOut()
    const draft = await scope.quote({ customerId: customer.id, lines: [quoteTyped('A', '1', '1')] })
    ok(await scope.run('quotation.discard', { id: draft.id, version: draft.version }))
    expect(codeOf(await scope.run('quotation.get', { id: draft.id }))).toBe('not_found')
    const next = await scope.quote({ customerId: customer.id, lines: [quoteTyped('B', '1', '1')] })
    expect(next.number).toBe('Q-0002')
    const sent = await scope.send(next)
    expect(
      codeOf(await scope.run('quotation.discard', { id: sent.id, version: sent.version })),
    ).toBe('quotation_frozen')
  })

  it('copies a revision into a new quotation with its own number', async () => {
    const { scope, customer } = await fitOut()
    const other = await scope.customer({ name: 'Sara Haddad' })
    const source = await scope.send(
      await scope.quote({
        customerId: customer.id,
        lines: [quoteTyped('Wardrobe', '2', '3000')],
        stages: [{ due: 'Upon signing', percent: '100' }],
      }),
    )
    const copy = ok(
      await scope.run<QuotationDto>('quotation.copy', {
        id: source.id,
        newId: newId(),
        customerId: other.id,
      }),
    )
    expect(copy).toMatchObject({
      number: 'Q-0002',
      revision: 1,
      status: 'draft',
      customerId: other.id,
      copiedFromId: source.id,
      copiedFromNumber: 'Q-0001',
      payable: source.payable,
    })
    expect(copy.stages.map((s) => s.due)).toEqual(['Upon signing'])
  })
})

describe('numbers', () => {
  it('parallel creates are Q-0001… once each; a replay takes no number; businesses count apart', async () => {
    const { scope, customer } = await fitOut()
    const { scope: other, customer: theirs } = await fitOut()
    const today = await scope.today()
    const inputs = Array.from({ length: 20 }, () => ({
      id: newId(),
      customerId: customer.id,
      businessDate: today,
      lines: [quoteTyped('Item', '1', '10')],
    }))
    const results = await Promise.all([
      ...inputs.map((input) => scope.run<QuotationDto>('quotation.create', input)),
      scope.run<QuotationDto>('quotation.create', inputs[0]),
      other.run<QuotationDto>('quotation.create', {
        id: newId(),
        customerId: theirs.id,
        businessDate: today,
        lines: [],
      }),
    ])
    const numbers = results.slice(0, 20).map((r) => ok(r).number)
    expect(new Set(numbers).size).toBe(20)
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `Q-${String(i + 1).padStart(4, '0')}`),
    )
    expect(ok(results[20]!).number).toBe(numbers[0])
    expect(ok(results[21]!).number).toBe('Q-0001')
    const next = await scope.quote({ customerId: customer.id })
    expect(next.number).toBe('Q-0021')
  })

  it('a series starts where the business says until its first document, and prefixes renumber nothing', async () => {
    const { scope, customer } = await fitOut()
    const before = await scope.documentSettings()
    expect(before.series.find((s) => s.series === 'quotation')).toMatchObject({
      prefix: 'Q-',
      padding: 4,
      firstNo: 1,
      nextNo: 1,
      started: false,
      example: 'Q-0001',
    })
    ok(
      await scope.updateDocumentSettings({
        series: [{ series: 'quotation', prefix: 'Q-', padding: 4, firstNo: 501 }],
      }),
    )
    const first = await scope.quote({ customerId: customer.id })
    expect(first.number).toBe('Q-0501')
    const started = await scope.updateDocumentSettings({
      series: [{ series: 'quotation', prefix: 'Q-', padding: 4, firstNo: 900 }],
    })
    expect(codeOf(started)).toBe('series_started')
    const changed = ok(
      await scope.updateDocumentSettings({
        series: [{ series: 'quotation', prefix: 'QT/', padding: 0 }],
        accent: 'black',
        watermark: false,
        quotationValidDays: 7,
        footer: 'Bank: Sample Bank\nIBAN: AE00 0000',
      }),
    )
    expect(changed.series.find((s) => s.series === 'quotation')).toMatchObject({
      prefix: 'QT/',
      started: true,
      example: 'QT/502',
    })
    expect(changed).toMatchObject({ accent: 'black', watermark: false, quotationValidDays: 7 })
    expect((await scope.getQuote(first.id)).number).toBe('Q-0501')
    const second = await scope.quote({ customerId: customer.id })
    expect(second.number).toBe('QT/502')
    const days = (Date.parse(second.validUntil!) - Date.parse(second.businessDate)) / 86_400_000
    expect(days).toBe(7)
  })
})

describe('the PDF', () => {
  it('reads «عرض سعر», the Arabic customer name in logical order and the TRN left to right', async () => {
    const { scope, customer } = await fitOut()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('<b>Cabinet</b> #read("/etc/passwd")', '1', '1000')],
    })
    const pdf = await scope.pdf(quote.id)
    // A draft's file says so (D-296): never taken for the one sent.
    expect(pdf).toMatchObject({
      contentType: 'application/pdf',
      fileName: 'Q-0001-draft.pdf',
      pages: 1,
    })
    const bytes = new Uint8Array(Buffer.from(pdf.base64, 'base64'))
    expect(bytes.byteLength).toBe(pdf.bytes)
    const text = await pdfFullText(bytes)
    expect(text).toContain('عرض سعر')
    expect(text).toContain(normalizeText('خالد المنصوري'))
    expect(text).toContain('100123456700003')
    expect(text).toContain('<b>Cabinet</b> #read("/etc/passwd")')
    expect(text).toContain('DRAFT')
    const sent = await scope.send(quote)
    expect((await scope.pdf(sent.id)).fileName).toBe('Q-0001.pdf')
    expect((await scope.pdf((await scope.revise(sent)).id)).fileName).toBe('Q-0001-R2-draft.pdf')
  })

  it('200 lines paginate', async () => {
    const { scope, customer } = await fitOut()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: Array.from({ length: 200 }, (_, i) => quoteTyped(`Item ${i + 1}`, '1', '10')),
    })
    const pdf = await scope.pdf(quote.id)
    expect(pdf.pages).toBeGreaterThanOrEqual(4)
    const pages = await pdfText(new Uint8Array(Buffer.from(pdf.base64, 'base64')))
    expect(pages.length).toBe(pdf.pages)
  })

  it('for a business not registered for VAT: no VAT and no TRN', async () => {
    const scope = await QuotationScope.open(api, DESIGNER)
    const customer = await scope.customer({ name: 'Noor Studio' })
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Logo design', '1', '2500')],
    })
    expect(quote).toMatchObject({ vatRegistered: false, vatTotal: '0', vatRates: [] })
    const text = await pdfFullText(
      new Uint8Array(Buffer.from((await scope.pdf(quote.id)).base64, 'base64')),
    )
    expect(text).not.toContain('VAT')
    expect(text).toContain('2,500.00')
  })
})

describe('areas (D-299: the owner sets which lines each area holds)', () => {
  it('saves each area’s lines together, in one spelling, whatever order they are sent in', async () => {
    const { scope, customer } = await fitOut()
    const [a1, none, b1, a2] = [
      quoteTyped('Wall cladding', '1', '100', { area: 'Majlis' }),
      quoteTyped('Site visit', '1', '50'),
      quoteTyped('Pantry cabinets', '1', '300', { area: 'Pantry' }),
      quoteTyped('TV unit', '1', '200', { area: 'MAJLIS ' }),
    ]
    const quote = await scope.quote({ customerId: customer.id, lines: [a1, none, b1, a2] })
    expect(quote.lines.map((l) => [l.id, l.area])).toEqual([
      [a1.id, 'Majlis'],
      [a2.id, 'Majlis'],
      [none.id, null],
      [b1.id, 'Pantry'],
    ])

    // A line moved to another area joins it, after its lines; the order is kept by every save.
    const moved = ok(
      await scope.run<QuotationDto>('quotation.update', {
        id: quote.id,
        version: quote.version,
        customerId: customer.id,
        businessDate: quote.businessDate,
        lines: [a1, none, a2, { ...b1, area: 'Majlis' }],
      }),
    )
    expect(moved.lines.map((l) => [l.id, l.area])).toEqual([
      [a1.id, 'Majlis'],
      [a2.id, 'Majlis'],
      [b1.id, 'Majlis'],
      [none.id, null],
    ])
    // The PDF names the area once, in one cell beside its three lines.
    const pdf = await scope.pdf(moved.id)
    const text = await pdfFullText(new Uint8Array(Buffer.from(pdf.base64, 'base64')))
    expect(text.split('Majlis').length - 1).toBe(1)

    // A revision and the order keep that order.
    const revised = await scope.revise(await scope.send(moved))
    expect(revised.lines.map((l) => [l.description, l.area])).toEqual([
      ['Wall cladding', 'Majlis'],
      ['TV unit', 'Majlis'],
      ['Pantry cabinets', 'Majlis'],
      ['Site visit', null],
    ])
    const accepted = await scope.accept(await scope.send(revised))
    const { orderId } = await scope.toOrder(accepted)
    const order = ok(await scope.run<{ data: OrderDto }>('order.get', { id: orderId })).data
    expect(order.lines.map((l) => l.description)).toEqual([
      'Wall cladding',
      'TV unit',
      'Pantry cabinets',
      'Site visit',
    ])
  })

  it('an area’s name is at most 40 characters (it prints up its lines’ side)', async () => {
    const { scope, customer } = await fitOut()
    const long = await scope.run('quotation.create', {
      id: newId(),
      customerId: customer.id,
      businessDate: await scope.today(),
      lines: [quoteTyped('Shelf', '1', '10', { area: 'غ'.repeat(41) })],
    })
    expect(codeOf(long)).toBe('validation')
    const fits = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Shelf', '1', '10', { area: 'غ'.repeat(40) })],
    })
    expect(fits.lines[0]!.area).toBe('غ'.repeat(40))
  })

  it('an area’s name needs something to see: only invisible characters are refused (D-299)', async () => {
    const { scope, customer } = await fitOut()
    for (const blank of ['​', '⁠‎', '́']) {
      const refused = await scope.run('quotation.create', {
        id: newId(),
        customerId: customer.id,
        businessDate: await scope.today(),
        lines: [quoteTyped('Shelf', '1', '10', { area: blank })],
      })
      expect(codeOf(refused), JSON.stringify(blank)).toBe('validation')
    }
    const named = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Shelf', '1', '10', { area: 'مَجلس' })],
    })
    expect(named.lines[0]!.area).toBe('مَجلس')
  })
})
