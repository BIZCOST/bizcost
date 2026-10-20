import type {
  CustomerDto,
  DocumentPdfDto,
  InvoiceDto,
  MaterialDto,
  ProductDto,
  PurchaseDto,
  QuotationDto,
  SaleDto,
} from '@bizcost/contracts'
import { SALE_LINES_MAX } from '@bizcost/contracts'
import { createDb } from '@bizcost/db'
import { newId, SALE_LINE_QTY_MAX } from '@bizcost/domain'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../../src'
import { normalizeText, pdfFullText } from '../../src/documents/pdf/text-layer'
import { inputLeaves, inputSchemaOf, optionsOf, parseLeaf, unwrapped } from '../hardening/schema'
import { addMember, handlerFor, SECRET_KEY, type CallResult } from '../helpers'
import { BUYER_TRN, InvoicesApi, InvoiceScope } from '../invoices'
import { tag } from '../product-costs'
import { codeOf, line, ok, purchaseInput, type Person } from '../purchasing'
import { FIT_OUT } from '../quotations'

// ADVERSARY REVIEW of M3 (Step 10): the closing review the plan asks for, its findings kept as tests.
//
// 1. D-209 through fills, imports, deliveries and issues. A member without the costs switch (a
//    Manager with data.cost.view denied, as the M2 and M3 Step 2 reviews' attacker) chooses what a
//    posting sells and what a purchase costs; the cost frozen at posting, and the cost a first
//    purchase fills in later, is qty × a recipe's base quantity × averages they cannot see. Every
//    such posting gets the same answer for a product of a cheap material and one of a dear one,
//    however large: a sale's posting (Step 2's case) and the purchase that fills it, an import's
//    finalizing, an order's delivery, an invoice issued from scratch. The owner reads the huge cost.
//
// 2. Hostile text in every PDF field. Every free-text field a quotation, an invoice, a credit note or
//    a customer's statement prints (walked from the input schemas of what feeds them: a field added
//    without a classification fails) is filled with Typst markup and code, HTML and escapes: each
//    prints as typed, word for word, in the PDF's text layer, and nothing is evaluated (the template
//    reads the values as JSON data, never as markup, D-224); a field classified as not printed is in
//    no PDF.
//
// 3. What an invoice owes or was paid is no filter, and in no answer, for a member who sees invoices
//    but not payments (a Sales member whose payments were taken away in Settings → Team).
//
// 4. A fill's statements stay far within the statement timeout however many rows wait (D-331: it
//    failed with INTERNAL before).

let api: InvoicesApi
let shop: InvoiceScope
let today: string
let attacker: Person

beforeAll(async () => {
  api = new InvoicesApi()
  shop = await InvoiceScope.open(api, FIT_OUT)
  today = await shop.today()
  await shop.taxReady()
  attacker = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, attacker.user, {
    template: 'manager',
    overrides: [{ key: 'data.cost.view', effect: 'deny' }],
  })
}, 120_000)

afterAll(async () => {
  await api.close()
})

// ---------------------------------------------------------------------------------------------------
// 1. D-209 through fills, imports, deliveries and issues
// ---------------------------------------------------------------------------------------------------

/** About the largest recipe quantity a line takes (its base quantity is numeric(24,6) in ml). */
const HUGE_RECIPE_QTY = '999999999999'
/** The largest quantity an import's row takes (numeric(24,6)). */
const IMPORT_QTY_MAX = '999999999999999999'

interface Twin {
  /** The material the attacker cannot price: bought by the owner at a cheap or a dear price. */
  hidden: MaterialDto
  /** A material nobody bought yet: its first purchase fills what waits for it. */
  waiting: MaterialDto
  product: ProductDto
}

/** A product of a lot of `hidden` (bought at `price` a litre) and a litre of a material not bought. */
async function twin(price: string): Promise<Twin> {
  const hidden = await shop.material()
  const waiting = await shop.material()
  await shop.buy(purchaseInput(today, [line(hidden.id, '1', price)]))
  const product = await shop.product({ name: `Probe ${tag()}`, defaultPrice: '0' })
  await shop.recipe(product.id, [
    { id: newId(), materialId: hidden.id, qty: HUGE_RECIPE_QTY, unit: 'l' },
    { id: newId(), materialId: waiting.id, qty: '1', unit: 'l' },
  ])
  return { hidden, waiting, product }
}

/** What the attacker is answered: the code, and the values that do not name the record itself. */
function answerOf(result: CallResult<unknown>, pick: (data: never) => unknown) {
  const body = result.data as { meta?: { redacted?: string[] } } | undefined
  return {
    code: codeOf(result) ?? 'ok',
    redacted: body?.meta?.redacted ?? null,
    data: result.data === undefined ? null : pick(result.data as never),
  }
}

interface SaleBody {
  data: SaleDto
}
const saleShape = ({ data }: SaleBody) => ({
  status: data.status,
  netTotal: data.netTotal,
  total: data.total,
  lines: data.lines.map((l) => ({ qty: l.qty, net: l.net, cost: l.cost ?? null })),
})

describe('1. no answer of a fill, an import, a delivery or an issue depends on a hidden cost (D-209)', () => {
  let cheap: Twin
  let dear: Twin

  beforeAll(async () => {
    cheap = await twin('0.0001')
    dear = await twin('9999999999999')
    const context = ok(await shop.as<{ visibleCategories: string[] }>(attacker, 'business.context'))
    expect(context.visibleCategories).toEqual([]) // the premise: no costs
  }, 120_000)

  it('a sale waiting for a price, then the first purchase that fills it: the same answers', async () => {
    const sell = async (t: Twin) => {
      const draft = ok(
        await shop.as<SaleBody>(attacker, 'sale.create', {
          id: newId(),
          source: 'single',
          businessDate: today,
          channelId: await shop.channelId(),
          lines: [
            {
              kind: 'item',
              id: newId(),
              productId: t.product.id,
              qty: SALE_LINE_QTY_MAX,
              unitPrice: '0',
            },
          ],
        }),
      ).data
      return shop.as<SaleBody>(attacker, 'sale.post', { id: draft.id, version: draft.version })
    }
    const fill = async (t: Twin) => {
      const draft = ok(
        await shop.as<{ data: PurchaseDto }>(
          attacker,
          'purchase.create',
          purchaseInput(today, [line(t.waiting.id, '1', '1')]),
        ),
      ).data
      return shop.as<{ data: PurchaseDto }>(attacker, 'purchase.post', {
        id: draft.id,
        version: draft.version,
      })
    }
    const purchaseShape = ({ data }: { data: PurchaseDto }) => ({
      status: data.status,
      lines: data.lines.map((l) => ({ qty: l.qty, unit: l.unit })),
    })
    const soldCheap = await sell(cheap)
    const soldDear = await sell(dear)
    expect(answerOf(soldCheap, saleShape)).toMatchObject({ code: 'ok' })
    expect(answerOf(soldDear, saleShape)).toEqual(answerOf(soldCheap, saleShape))
    const filledCheap = await fill(cheap)
    const filledDear = await fill(dear)
    expect(answerOf(filledCheap, purchaseShape)).toMatchObject({ code: 'ok' })
    expect(answerOf(filledDear, purchaseShape)).toEqual(answerOf(filledCheap, purchaseShape))
    // Read again by the attacker after the fills: the same.
    const read = (id: string) => shop.as<SaleBody>(attacker, 'sale.get', { id })
    const cheapAfter = await read(soldCheap.data!.data.id)
    const dearAfter = await read(soldDear.data!.data.id)
    expect(answerOf(dearAfter, saleShape)).toEqual(answerOf(cheapAfter, saleShape))
    // The owner sees both filled, the dear one about 10^25 of materials a unit.
    const owners = ok(await shop.run<SaleBody>('sale.get', { id: soldDear.data!.data.id })).data
    expect(owners.lines[0]?.cost).toMatch(/^\d{30,}(?:\.\d+)?$/)
    const ownersCheap = ok(
      await shop.run<SaleBody>('sale.get', { id: soldCheap.data!.data.id }),
    ).data
    expect(ownersCheap.lines[0]?.cost).not.toBeNull()
  }, 120_000)

  it('an import’s finalizing: the same answer for a product of a cheap and of a dear material', async () => {
    const imported = async (t: Twin) => {
      // A channel of its own each (two imports of one channel and day would overlap).
      const channel = ok(
        await shop.run<{ data: { id: string } }>('channel.create', {
          id: newId(),
          name: `File ${tag()}`,
          kind: 'marketplace',
        }),
      ).data
      const draft = ok(
        await shop.as<{ data: { id: string; version: number } }>(attacker, 'saleImport.create', {
          id: newId(),
          channelId: channel.id,
          fileName: 'probe.csv',
          fileHash: randomBytes(32).toString('hex'),
          fingerprint: randomBytes(32).toString('hex'),
          shape: 'summary',
          periodFrom: today,
          periodTo: today,
          mapping: {
            headerRow: 0,
            columns: { name: 0, qty: 1, total: 2 },
            headers: {},
            dateOrder: 'dmy',
          },
          amountsIncludeVat: false,
          rowsRead: 1,
          rowsLeftOut: 0,
          rowCount: 1,
        }),
      ).data
      ok(
        await shop.as(attacker, 'saleImport.addRows', {
          id: draft.id,
          rows: [
            {
              position: 0,
              businessDate: today,
              name: t.product.name,
              qty: IMPORT_QTY_MAX,
              amount: '0',
              fileRows: 1,
            },
          ],
        }),
      )
      return shop.as(attacker, 'saleImport.post', { id: draft.id, version: draft.version })
    }
    const importShape = ({ data }: { data: Record<string, unknown> }) => ({
      status: data.status,
      amount: data.amount,
      salesBeforeVat: data.salesBeforeVat,
      matchedNames: data.matchedNames,
      totalNames: data.totalNames,
      unpricedMaterials: data.unpricedMaterials ?? null,
    })
    const onCheap = await imported(cheap)
    const onDear = await imported(dear)
    expect(answerOf(onCheap, importShape)).toMatchObject({ code: 'ok', data: { status: 'posted' } })
    expect(answerOf(onDear, importShape)).toEqual(answerOf(onCheap, importShape))
  }, 120_000)

  it('an order’s delivery: the same answer for a product of a cheap and of a dear material', async () => {
    const customer = await shop.customer({ name: `Probe buyer ${tag()}` })
    const delivered = async (t: Twin) => {
      const order = ok(
        await shop.as<{ data: { id: string; version: number } }>(attacker, 'order.create', {
          id: newId(),
          customerId: customer.id,
          businessDate: today,
          channelId: await shop.channelId(),
          lines: [
            {
              kind: 'item',
              id: newId(),
              productId: t.product.id,
              qty: SALE_LINE_QTY_MAX,
              unitPrice: '0',
            },
          ],
        }),
      ).data
      return shop.as(attacker, 'order.deliver', { id: order.id, version: order.version })
    }
    const orderShape = ({ data }: { data: Record<string, unknown> }) => ({
      status: data.status,
      total: data.total,
    })
    const onCheap = await delivered(cheap)
    const onDear = await delivered(dear)
    expect(answerOf(onCheap, orderShape)).toMatchObject({
      code: 'ok',
      data: { status: 'delivered' },
    })
    expect(answerOf(onDear, orderShape)).toEqual(answerOf(onCheap, orderShape))
  }, 120_000)

  it('an invoice issued from scratch (it posts its own sale): the same answer for both', async () => {
    const buyer = await shop.buyer({ name: `Probe company ${tag()}` })
    const issued = async (t: Twin) => {
      const draft = ok(
        await shop.as<InvoiceDto>(attacker, 'invoice.create', {
          id: newId(),
          customerId: buyer.id,
          channelId: await shop.channelId(),
          countedElsewhere: false,
          lines: [{ id: newId(), productId: t.product.id, qty: SALE_LINE_QTY_MAX, unitPrice: '0' }],
        }),
      )
      return shop.as<InvoiceDto>(attacker, 'invoice.issue', {
        id: draft.id,
        version: draft.version,
      })
    }
    const invoiceShape = (data: InvoiceDto) => ({
      status: data.status,
      kind: data.kind,
      total: data.total,
      vatTotal: data.vatTotal,
    })
    const onCheap = await issued(cheap)
    const onDear = await issued(dear)
    expect(answerOf(onCheap, invoiceShape)).toMatchObject({
      code: 'ok',
      data: { status: 'issued' },
    })
    expect(answerOf(onDear, invoiceShape)).toEqual(answerOf(onCheap, invoiceShape))
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------------
// 2. Hostile text in every PDF field
// ---------------------------------------------------------------------------------------------------

type Printed = 'quotation' | 'invoice' | 'credit_note' | 'statement'
const ALL: Printed[] = ['quotation', 'invoice', 'credit_note', 'statement']
const DOCUMENTS: Printed[] = ['quotation', 'invoice', 'credit_note']

interface Prints {
  prints: Printed[]
}
interface NotFree {
  /** A field whose own format refuses markup (a TRN's digits): never printed as typed text. */
  format: string
}
interface NeverPrinted {
  never: string
}
type PdfField = Prints | NotFree | NeverPrinted

/** The procedures whose free text a document prints, and what each field is. */
const PDF_FIELDS: Record<string, PdfField> = {
  'business.updateProfile legalName': { prints: ALL },
  'business.updateProfile legalNameAr': { prints: ALL },
  'business.updateProfile trn': { format: 'a TRN: 15 digits' },
  'business.updateProfile letterhead.addressLine': { prints: ALL },
  'business.updateProfile letterhead.city': { prints: ALL },
  'business.updateProfile letterhead.tradeLicenceNo': { prints: ALL },
  'business.updateProfile letterhead.tradeLicenceAuthority': {
    never: 'who issued the trade licence: kept for e-invoicing (PINT-AE), not printed',
  },
  // A document's number: on it, and on the statement that lists it.
  'document.updateSettings series.*.prefix': { prints: ALL },
  // The bank details: on what is to be paid (a credit note asks for no payment).
  'document.updateSettings footer': { prints: ['quotation', 'invoice', 'statement'] },
  // The terms of a quotation without its own.
  'document.updateSettings quotationTerms': { prints: ['quotation'] },
  'document.updateSettings signatory': { prints: DOCUMENTS },
  'customer.create name': { prints: ALL },
  'customer.create trn': { format: 'a TRN: 15 digits' },
  'customer.create tradeLicenceNo': {
    never:
      'the buyer’s trade licence: kept for e-invoicing (PINT-AE’s buyer legal id), not printed',
  },
  'customer.create addressLine': { prints: ALL },
  'customer.create city': { prints: ALL },
  'customer.create notes': { never: 'the business’s own notes about the customer' },
  'product.create name': { prints: DOCUMENTS },
  'product.create description': { never: 'a product’s own description (a line prints its name)' },
  'product.create resale.packs.*.name': { never: 'a pack bought from a supplier' },
  'quotation.create customerRef': { prints: ['quotation'] },
  'quotation.create site': { prints: ['quotation'] },
  'quotation.create greeting': { prints: ['quotation'] },
  'quotation.create intro': { prints: ['quotation'] },
  'quotation.create terms': { prints: ['quotation'] },
  'quotation.create notes': { prints: ['quotation'] },
  'quotation.create lines.*.area': { prints: ['quotation'] },
  'quotation.create lines.*.description': { prints: ['quotation'] },
  'quotation.create lines.*.details': { prints: ['quotation'] },
  'quotation.create lines.*.note': { prints: ['quotation'] },
  'quotation.create stages.*.label': { prints: ['quotation'] },
  'quotation.create stages.*.due': { prints: ['quotation'] },
  'invoice.create lpoReference': { prints: ['invoice'] },
  'invoice.create site': { prints: ['invoice'] },
  'invoice.create terms': { prints: ['invoice'] },
  'invoice.create notes': { prints: ['invoice'] },
  'invoice.create lines.*.area': { prints: ['invoice'] },
  'invoice.create lines.*.description': { prints: ['invoice', 'credit_note'] },
  'invoice.create lines.*.details': { prints: ['invoice'] },
  'invoice.create lines.*.note': { prints: ['invoice'] },
  'creditNote.create reasonText': { prints: ['credit_note'] },
  'creditNote.create notes': { prints: ['credit_note'] },
  'customerPayment.record note': {
    never:
      'a payment’s note: an issued invoice prints what it was paid when it was issued (what its ' +
      'order or sale paid, by its number; D-306), and a statement names a payment by its document',
  },
  // An order's and a sale's lines print on the invoice made of them, and a sale "they'll pay later"
  // on the customer's statement (its first items).
  // The customer's LPO: the invoice made of the order carries it.
  'order.create customerRef': { prints: ['invoice'] },
  'order.create deliveryArea': { never: 'where an order is delivered (Orders’ own)' },
  'order.create notes': { never: 'the order’s own notes' },
  'order.create lines.*.description': { prints: ['invoice'] },
  'order.create payment.note': { never: 'a payment’s note (as above)' },
  'sale.create deliveryArea': { never: 'where a sale was delivered (Sales’ own)' },
  'sale.create notes': { never: 'the sale’s own notes' },
  'sale.create lines.*.description': { prints: ['invoice', 'statement'] },
}

/** The procedures whose input feeds the PDFs (their updates write the same columns). */
const PDF_SOURCES = [
  'business.updateProfile',
  'document.updateSettings',
  'customer.create',
  'product.create',
  'quotation.create',
  'invoice.create',
  'creditNote.create',
  'customerPayment.record',
  'order.create',
  'sale.create',
]

/** Every free-text leaf of a procedure's input: takes words, is not one of a few options. */
function freeTextLeaves(path: string) {
  const schema = inputSchemaOf(appRouter, path)
  return (schema ? inputLeaves(schema) : []).filter(
    (leaf) =>
      unwrapped(leaf.schema)._zod.def.type === 'string' &&
      parseLeaf(leaf.schema, 'Words here').ok &&
      !optionsOf(leaf.schema),
  )
}

/**
 * A field's text: Typst code and markup, HTML and escapes, each word carrying the field's own name
 * ("Hz07q"), so each field's words are found where it prints (fewer where the field is short). Each
 * word is short enough not to wrap in the narrowest cell (a payment stage's, 12 letters).
 */
function payloadOf(n: number, leaf: ReturnType<typeof freeTextLeaves>[number]): string {
  const name = `Hz${String(n).padStart(2, '0')}q`
  const all = [
    name,
    '#read("x")',
    `#${name}()`,
    `$${name}^2$`,
    `*${name}*`,
    `_${name}_`,
    `<${name}>`,
    `@${name}`,
    `[${name}]`,
    `\\${name}`,
  ]
  const fewer = [name, `#${name}`, `$${name}$`, `[${name}]`]
  for (const words of [all, fewer, [`#${name}`, `[${name}]`]]) {
    const text = words.join(' ')
    if (parseLeaf(leaf.schema, text).ok) return text
  }
  throw new Error(`${leaf.path} takes no hostile text: classify it as a format`)
}

describe('2. hostile text in every field a PDF prints is printed as typed, never run', () => {
  it('every free-text field of what feeds the PDFs is classified', () => {
    const found = PDF_SOURCES.flatMap((path) =>
      freeTextLeaves(path).map((leaf) => `${path} ${leaf.path}`),
    )
    expect(found.sort()).toEqual(Object.keys(PDF_FIELDS).sort())
  })

  it('a quotation, an invoice, its credit note and the customer’s statement print every field as typed', async () => {
    const texts = new Map<string, string>()
    let n = 0
    for (const path of PDF_SOURCES) {
      for (const leaf of freeTextLeaves(path)) {
        const key = `${path} ${leaf.path}`
        const field = PDF_FIELDS[key]
        // Fields never printed get hostile text too: each must then be in no PDF.
        if (field && !('format' in field)) texts.set(key, payloadOf((n += 1), leaf))
      }
    }
    const text = (field: string) => {
      const value = texts.get(field)
      if (value === undefined) throw new Error(`${field} takes no text`)
      return value
    }
    // The business and its letterhead, Settings → Documents, a customer and a product.
    const profile = ok(
      await shop.run<{ version: number; vatRegistered: boolean; trn: string | null }>(
        'business.profile',
      ),
    )
    ok(
      await shop.run('business.updateProfile', {
        version: profile.version,
        legalName: text('business.updateProfile legalName'),
        legalNameAr: text('business.updateProfile legalNameAr'),
        vatRegistered: profile.vatRegistered,
        trn: profile.trn,
        letterhead: {
          phone: '+971 4 555 0142',
          email: 'hello@moderntouch.example',
          addressLine: text('business.updateProfile letterhead.addressLine'),
          city: text('business.updateProfile letterhead.city'),
          emirate: 'dubai',
          tradeLicenceNo: text('business.updateProfile letterhead.tradeLicenceNo'),
          tradeLicenceAuthority: text('business.updateProfile letterhead.tradeLicenceAuthority'),
        },
      }),
    )
    const prefix = text('document.updateSettings series.*.prefix')
    ok(
      await shop.updateDocumentSettings({
        series: ['quotation', 'invoice', 'credit_note'].map((series) => ({
          series,
          prefix,
          padding: 4,
        })),
        footer: text('document.updateSettings footer'),
        quotationTerms: text('document.updateSettings quotationTerms'),
        signatory: text('document.updateSettings signatory'),
      }),
    )
    const customer: CustomerDto = await shop.customer({
      kind: 'business',
      name: text('customer.create name'),
      trn: BUYER_TRN,
      tradeLicenceNo: text('customer.create tradeLicenceNo'),
      addressLine: text('customer.create addressLine'),
      city: text('customer.create city'),
      emirate: 'dubai',
      notes: text('customer.create notes'),
    })
    const product = await shop.product({
      name: text('product.create name'),
      description: text('product.create description'),
      defaultPrice: '45',
    })
    const typedLine = (procedure: 'quotation.create' | 'invoice.create') => ({
      id: newId(),
      productId: null,
      area: text(`${procedure} lines.*.area`),
      description: text(`${procedure} lines.*.description`),
      details: text(`${procedure} lines.*.details`),
      note: text(`${procedure} lines.*.note`),
      qty: '120',
      unit: 'm2',
      unitPrice: '45',
    })

    // A quotation with every field typed.
    const quotation: QuotationDto = await shop.quote({
      customerId: customer.id,
      customerRef: text('quotation.create customerRef'),
      site: text('quotation.create site'),
      greeting: text('quotation.create greeting'),
      intro: text('quotation.create intro'),
      terms: text('quotation.create terms'),
      notes: text('quotation.create notes'),
      lines: [
        { id: newId(), productId: product.id, qty: '2', unitPrice: '45' },
        typedLine('quotation.create'),
      ],
      stages: [
        {
          label: text('quotation.create stages.*.label'),
          due: text('quotation.create stages.*.due'),
          percent: '100',
        },
      ],
    })
    // And one without terms of its own: it prints the business's.
    const plain = await shop.quote({
      customerId: customer.id,
      lines: [{ id: newId(), productId: product.id, qty: '1', unitPrice: '45' }],
    })
    const pdfs: Record<Printed, DocumentPdfDto[]> = {
      quotation: [await shop.pdf(quotation.id), await shop.pdf(plain.id)],
      invoice: [],
      credit_note: [],
      statement: [],
    }

    // A tax invoice from scratch, paid in part, and a credit note of it.
    const invoice = await shop.issued({
      customerId: customer.id,
      channelId: await shop.channelId(),
      countedElsewhere: false,
      lpoReference: text('invoice.create lpoReference'),
      site: text('invoice.create site'),
      terms: text('invoice.create terms'),
      notes: text('invoice.create notes'),
      lines: [
        { id: newId(), productId: product.id, qty: '2', unitPrice: '45' },
        typedLine('invoice.create'),
      ],
    })
    await shop.payInvoice(invoice.id, '100', { note: text('customerPayment.record note') })
    pdfs.invoice.push(await shop.invoicePdf(invoice.id))
    const note = await shop.credit(invoice.id, {
      reasonText: text('creditNote.create reasonText'),
      notes: text('creditNote.create notes'),
      by: 'quantity',
      lines: [
        { invoiceLineId: invoice.lines[0]!.id, qty: '1' },
        { invoiceLineId: invoice.lines[1]!.id, qty: '20' },
      ],
    })
    pdfs.credit_note.push(await shop.creditNotePdf(note.id))

    // An order of the customer with every field typed, delivered and invoiced; a sale "they'll pay
    // later" invoiced, and another left owed (the statement lists it).
    const item = () => ({
      kind: 'item',
      id: newId(),
      productId: product.id,
      description: text('sale.create lines.*.description'),
      qty: '1',
      unitPrice: '45',
    })
    const order = await shop.order({
      customerId: customer.id,
      channelId: await shop.channelId(),
      customerRef: text('order.create customerRef'),
      deliveryNeeded: true,
      deliveryArea: text('order.create deliveryArea'),
      notes: text('order.create notes'),
      lines: [{ ...item(), description: text('order.create lines.*.description') }],
      payment: {
        id: newId(),
        method: 'cash',
        amount: '5',
        note: text('order.create payment.note'),
      },
    })
    await shop.deliver(order)
    pdfs.invoice.push(await shop.invoicePdf((await shop.issue(await shop.fromOrder(order.id))).id))
    const owedSale = async () =>
      shop.sell({
        businessDate: today,
        channelId: await shop.channelId(),
        customerId: customer.id,
        payLater: true,
        deliveryNeeded: true,
        deliveryArea: text('sale.create deliveryArea'),
        notes: text('sale.create notes'),
        lines: [item()],
      })
    const invoicedSale = await owedSale()
    pdfs.invoice.push(
      await shop.invoicePdf((await shop.issue(await shop.fromSale(invoicedSale.id))).id),
    )
    await owedSale()
    pdfs.statement.push(
      ok(
        await shop.run<DocumentPdfDto>('customer.statementPdf', {
          customerId: customer.id,
          from: `${today.slice(0, 7)}-01`,
          to: today,
        }),
      ),
    )

    // Each kind's words, without the spaces a cell's wrapping adds or takes.
    const words = new Map<Printed, string>()
    for (const kind of ALL) {
      let all = ''
      for (const pdf of pdfs[kind]) {
        const full = await pdfFullText(new Uint8Array(Buffer.from(pdf.base64, 'base64')))
        // Nothing was read from the server's files.
        expect(full).not.toMatch(/root:|\/bin\/(?:ba)?sh/)
        all += full.replace(/\s+/g, '')
      }
      words.set(kind, all)
    }
    const missing: string[] = []
    const strays: string[] = []
    for (const [key, value] of texts) {
      const field = PDF_FIELDS[key]!
      const printed = 'prints' in field ? field.prints : []
      for (const kind of ALL) {
        const found = value
          .split(' ')
          .filter((word) => words.get(kind)!.includes(normalizeText(word).replace(/\s+/g, '')))
        // Where it prints, every word of it; anywhere else, not its name (the classification holds).
        if (printed.includes(kind)) {
          const lost = value.split(' ').filter((word) => !found.includes(word))
          if (lost.length > 0) missing.push(`${kind}: ${key} ${JSON.stringify(lost)}`)
        } else if (words.get(kind)!.includes(value.split(' ')[0]!.replace(/\W/g, ''))) {
          strays.push(`${kind}: ${key}`)
        }
      }
    }
    expect(missing).toEqual([])
    expect(strays, 'a field printed where PDF_FIELDS says it is not').toEqual([])
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------
// 3. What is owed or paid is no filter for a member who does not see payments
// ---------------------------------------------------------------------------------------------------
//
// invoice.list filters by what each invoice still owes (owed, overdue, paid): "with
// payments.customers.view, FORBIDDEN otherwise" (services/invoices.ts). Every template that sees
// invoices sees payments, so only a member whose own access takes payments away (Settings → Team, as
// invoices.documents.view does not need it) reaches the refusal; no test held it. Every option of
// every business query that filters by a payment is listed here (a new one fails the first test).

const PAYMENT_FILTERS = [
  'invoice.list status=owed',
  'invoice.list status=overdue',
  'invoice.list status=paid',
]
const PAYMENT_WORD = /owed|overdue|paid|unpaid|outstanding|deposit/i

describe('3. filtering invoices by what they owe needs payments seen (FORBIDDEN otherwise)', () => {
  it('the only options of a business query about payments are PAYMENT_FILTERS', () => {
    const procedures = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string } }
    >
    const found = Object.entries(procedures)
      .filter(([, procedure]) => procedure._def.type === 'query')
      .flatMap(([path]) => {
        const schema = inputSchemaOf(appRouter, path)
        return (schema ? inputLeaves(schema) : []).flatMap((leaf) =>
          (optionsOf(leaf.schema) ?? [])
            .filter((option) => PAYMENT_WORD.test(option))
            .map((option) => `${path} ${leaf.path}=${option}`),
        )
      })
    expect(found.sort()).toEqual([...PAYMENT_FILTERS].sort())
  })

  it('a member who sees invoices but not payments is refused each, with nothing; the owner is served', async () => {
    const buyer = await shop.buyer({ name: `Payer ${tag()}` })
    const invoice = await shop.issued({
      customerId: buyer.id,
      channelId: await shop.channelId(),
      countedElsewhere: false,
      lines: [{ id: newId(), productId: null, description: 'Fitting', qty: '1', unitPrice: '700' }],
    })
    await shop.payInvoice(invoice.id, '100')
    const clerk = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, clerk.user, {
      template: 'sales',
      overrides: [{ key: 'payments.customers.view', effect: 'deny' }],
    })
    const context = ok(
      await shop.as<{ permissions: { keys: string[] } }>(clerk, 'business.context'),
    )
    // The premise: invoices seen, payments not.
    expect(context.permissions.keys).toContain('invoices.documents.view')
    expect(context.permissions.keys).not.toContain('payments.customers.view')
    for (const option of PAYMENT_FILTERS) {
      const status = option.split('=')[1]
      const refused = await shop.as(clerk, 'invoice.list', { status, customerId: buyer.id })
      expect(codeOf(refused), `${option}: ${refused.raw}`).toBe('forbidden')
      expect(refused.raw).not.toContain(invoice.id)
      const owners = await shop.as(shop.owner, 'invoice.list', { status, customerId: buyer.id })
      expect(owners.error, owners.raw).toBeUndefined()
    }
    // What is owed (700 + VAT 35 − 100 paid = 635) is in the owner's list, never in theirs.
    const theirs = ok(
      await shop.as<{ items: { id: string; owed: string | null; paymentState: string | null }[] }>(
        clerk,
        'invoice.list',
        { status: 'issued', customerId: buyer.id },
      ),
    )
    expect(theirs.items).toEqual([
      expect.objectContaining({ id: invoice.id, owed: null, paymentState: null }),
    ])
    const owners = ok(
      await shop.as<{ items: { owed: string | null }[] }>(shop.owner, 'invoice.list', {
        status: 'owed',
        customerId: buyer.id,
      }),
    )
    expect(owners.items.map((i) => i.owed)).toEqual(['635'])
  }, 120_000)
})

describe('3b. what an invoice was paid and still owes reaches no answer of a member who does not see payments', () => {
  it('every business query and the invoice’s PDF, as a Sales member with payments taken away', async () => {
    const buyer = await shop.buyer({ name: `Sweep ${tag()}` })
    const invoice = await shop.issued({
      customerId: buyer.id,
      channelId: await shop.channelId(),
      countedElsewhere: false,
      lines: [{ id: newId(), productId: null, description: 'Fitting', qty: '1', unitPrice: '700' }],
    })
    // 735.00 with VAT; 123.45 paid, 611.55 owed: amounts nothing else of the business holds.
    const PAID = '123.45'
    const OWED = '611.55'
    await shop.payInvoice(invoice.id, PAID)
    const clerk = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, clerk.user, {
      template: 'sales',
      overrides: [{ key: 'payments.customers.view', effect: 'deny' }],
    })
    const inputs: Record<string, unknown> = {
      'invoice.get': { id: invoice.id },
      'invoice.history': { id: invoice.id },
      'invoice.list': { customerId: buyer.id },
      'customer.get': { id: buyer.id },
      'customer.statement': { customerId: buyer.id, from: today, to: today },
      'customerPayment.list': { invoiceId: invoice.id },
      'receivable.list': { customerId: buyer.id },
      'sale.list': {},
      'sale.get': { id: invoice.saleId },
      'profit.summary': { from: today, to: today, groupBy: 'order' },
    }
    const procedures = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string; inputs: unknown[] } }
    >
    const queries = Object.entries(procedures)
      .filter(([path, p]) => p._def.type === 'query' && !['health', 'me'].includes(path))
      .filter(([path]) => !path.startsWith('account.') && path !== 'invitation.preview')
    const seen: string[] = []
    let served = 0
    for (const [path] of queries) {
      const input = inputs[path] ?? (inputSchemaOf(appRouter, path) ? {} : undefined)
      const result = await shop.as(clerk, path, input)
      if (!result.error) served += 1
      for (const amount of [PAID, OWED])
        if (result.raw.includes(amount)) seen.push(`${path}: ${amount}`)
    }
    const pdf = ok(await shop.as<DocumentPdfDto>(clerk, 'invoice.pdf', { id: invoice.id }))
    const text = await pdfFullText(new Uint8Array(Buffer.from(pdf.base64, 'base64')))
    for (const amount of [PAID, OWED])
      if (text.includes(amount)) seen.push(`invoice.pdf: ${amount}`)
    expect(served).toBeGreaterThanOrEqual(15)
    expect(seen).toEqual([])
    // The control: the owner reads both.
    const owners = await shop.as(shop.owner, 'invoice.get', { id: invoice.id })
    expect(owners.raw).toContain(PAID)
    expect(owners.raw).toContain(OWED)
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------------
// 4. A fill's statements stay far within the statement timeout (D-331)
// ---------------------------------------------------------------------------------------------------
//
// security/m3-step2-costing-adversary's first purchase that fills 21,600 rows waiting for a price kept
// failing with INTERNAL (the 15 s statement timeout) in loaded full runs after D-328: its one update
// of every material row took 1.6 s alone and more than 15 s with the machine loaded. However many
// sales wait (Q5: weeks of them before the first supplier bill), no statement may grow with them. Here
// the API answers on a connection whose statement timeout is a fifth of the deployed one (3 s), and
// twice as many rows wait (6 sales × 300 lines × 24 materials = 43,200): it posts, and fills them all.

const TIGHT_TIMEOUT_MS = 3000

describe('4. the first purchase that 43,200 waiting material rows wait for posts with every statement under 3 s', () => {
  it('posted on a connection with a 3 s statement timeout, every line filled once', async () => {
    const tightDb = createDb(`${process.env.DATABASE_URL}?statement_timeout=${TIGHT_TIMEOUT_MS}`)
    const tight = handlerFor(tightDb, undefined, { supabaseSecretKey: SECRET_KEY })
    try {
      const parts: MaterialDto[] = []
      for (let i = 0; i < 24; i++) {
        parts.push(await shop.newMaterial({ name: `Part ${i} ${tag()}`, unit: 'kg', packs: [] }))
      }
      const platter = await shop.product({ name: `Platter ${tag()}`, defaultPrice: '10' })
      await shop.recipe(
        platter.id,
        parts.map((m) => ({ id: newId(), materialId: m.id, qty: '1', unit: 'g' })),
      )
      const sales: SaleDto[] = []
      for (let i = 0; i < 6; i++) {
        sales.push(
          await shop.sell({
            businessDate: today,
            channelId: await shop.channelId(),
            lines: Array.from({ length: SALE_LINES_MAX }, () => ({
              kind: 'item',
              id: newId(),
              productId: platter.id,
              qty: '1',
              unitPrice: '10',
            })),
          }),
        )
      }
      expect(sales.every((s) => s.lines.every((l) => l.cost === null))).toBe(true)
      const draft = await shop.draft(
        purchaseInput(
          today,
          parts.map((m) => line(m.id, '1', '10', { unit: 'kg' })),
        ),
      )
      const posted = await api.call<{ data: PurchaseDto }>(
        shop.owner,
        shop.id,
        'purchase.post',
        { id: draft.id, version: draft.version },
        tight,
      )
      expect(posted.error?.data.appCode, posted.raw.slice(0, 300)).toBeUndefined()
      // 24 materials × 1 g at 0.01 a gram: 0.24 a platter, on every line of every sale.
      for (const sale of [sales[0]!, sales[5]!]) {
        const lines = (await shop.sale(sale.id)).lines
        expect(lines).toHaveLength(SALE_LINES_MAX)
        expect(lines.every((l) => l.cost === '0.24')).toBe(true)
      }
    } finally {
      await tightDb.$client.end()
    }
  }, 600_000)
})
