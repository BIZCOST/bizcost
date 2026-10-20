import type { BusinessContextDto, DocumentPdfDto } from '@bizcost/contracts'
import { newId, plusDays } from '@bizcost/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { pdfFullText } from '../src/documents/pdf/text-layer'
import { InvoiceScope, InvoicesApi, typed } from './invoices'
import { codeOf, ok } from './purchasing'
import { DESIGNER } from './quotations'
import { BAKER } from './settings'

// Release B (ROADMAP.md M3 Step 9): Quotations and Invoices released, the API as deployed (nothing
// previewed). A business that invoices without orders gets Invoices in the phone's Sales place and
// "+" for a new quotation and a new invoice; every business with Customers and Payments on gets its
// customers' statements (B10), an orders-only one in its own words ("Orders and sales", "Payments
// and refunds", never invoices or credit notes), on its own letterhead. Every business, customer and
// figure is fictional.

const api = new InvoicesApi()
afterAll(() => api.close())

const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))
const textOf = async (pdf: DocumentPdfDto) => pdfFullText(decode(pdf.base64))
const compact = (text: string) => text.replace(/\s+/g, '')

describe('Release B: Quotations and Invoices are served as deployed', () => {
  it('a designer who quotes and invoices without orders: their sections, "+", and Invoices in the Sales place (Q14)', async () => {
    const scope = await InvoiceScope.open(api, DESIGNER)
    const context = ok(await scope.run<BusinessContextDto>('business.context'))
    expect(context.modules.map((m) => m.id)).toEqual(
      expect.arrayContaining(['quotations', 'invoices']),
    )
    const nav = context.modules.flatMap((m) => m.nav)
    expect(nav.find((entry) => entry.id === 'invoices')?.tab).toBe(2)
    expect(nav.find((entry) => entry.id === 'sales')?.tab).toBeNull()
    expect(nav.find((entry) => entry.id === 'quotations')?.tab).toBeNull()
    const plus = context.modules.flatMap((m) => m.quickActions.map((a) => [a.id, a.path]))
    expect(plus).toEqual(
      expect.arrayContaining([
        ['new_quotation', 'quotations/new'],
        ['new_invoice', 'invoices/new'],
      ]),
    )
    ok(await scope.run('quotation.list'))
    ok(await scope.run('invoice.list'))
    // Customize BizCost: no longer "soon".
    const customization = ok(
      await scope.run<{ modules: { id: string; availability: string }[] }>(
        'business.customization',
      ),
    )
    for (const id of ['quotations', 'invoices']) {
      expect(customization.modules.find((m) => m.id === id)?.availability, id).toBe('released')
    }
  })
})

describe("Release B: every business with Customers on has its customers' statements (B10)", () => {
  it('an orders-only business: its delivered orders and payments, in its own words, on the page and the PDF', async () => {
    // The home baker: Orders, Customers and Payments, no Quotations or Invoices.
    const scope = await InvoiceScope.open(api, BAKER)
    expect(codeOf(await scope.run('invoice.list'))).toBe('module_disabled')
    const customer = await scope.customer({ name: 'Mona Saeed' })
    const cake = await scope.service('250')
    const today = await scope.today()
    const deliveredOn = plusDays(today, -3)
    const order = await scope.order({
      businessDate: deliveredOn,
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: cake.id, qty: '2', unitPrice: '250' }],
    })
    await scope.deliver(order, deliveredOn)
    await scope.pay({ orderId: order.id }, '200')
    const from = plusDays(today, -30)
    const statement = await scope.statement(customer.id, from, today)
    expect(statement).toMatchObject({
      invoicing: false,
      opening: '0',
      invoiced: '500',
      credited: '0',
      paid: '200',
      closing: '300',
    })
    expect(statement.entries.map((e) => [e.kind, e.charge, e.credit, e.owed])).toEqual([
      ['order', '500', '0', '500'],
      ['payment', '0', '200', '300'],
    ])
    const text = compact(
      await textOf(
        ok(
          await scope.run<DocumentPdfDto>('customer.statementPdf', {
            customerId: customer.id,
            from,
            to: today,
          }),
        ),
      ),
    )
    expect(text).toContain(compact('Orders and sales'))
    expect(text).toContain(compact('Payments and refunds'))
    expect(text).toContain(compact('Refunded'))
    expect(text).not.toMatch(/Invoice|Credited|Creditnote|credits/)
  }, 90_000)

  it('a business with Invoices says invoices and credit notes, before its first one too, and after Invoices is switched off for a period that lists one', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const today = await scope.today()
    expect((await scope.statement(customer.id, today, today)).invoicing).toBe(true)
    await scope.issued({ customerId: customer.id, lines: [typed('Site survey', '1', '500')] })
    const text = compact(
      await textOf(
        ok(
          await scope.run<DocumentPdfDto>('customer.statementPdf', {
            customerId: customer.id,
            from: today,
            to: today,
          }),
        ),
      ),
    )
    expect(text).toContain(compact('Invoiced and delivered'))
    expect(text).toContain(compact('Payments and credits'))
    // Invoices switched off: the statement is still served (Customers and Payments), and a period
    // that lists an invoice still says invoices; one that lists none speaks of orders and sales.
    ok(
      await scope.run('business.customize', {
        item: { kind: 'module', id: 'invoices' },
        enabled: false,
      }),
    )
    expect(codeOf(await scope.run('invoice.list'))).toBe('module_disabled')
    expect((await scope.statement(customer.id, today, today)).invoicing).toBe(true)
    const yesterday = plusDays(today, -1)
    expect((await scope.statement(customer.id, yesterday, yesterday)).invoicing).toBe(false)
  }, 90_000)

  it("downloads under the customer's own name, in Arabic too (Release B review)", async () => {
    const scope = await InvoiceScope.open(api, BAKER)
    const today = await scope.today()
    const from = plusDays(today, -30)
    const fileOf = async (name: string) => {
      const customer = await scope.customer({ name })
      return ok(
        await scope.run<DocumentPdfDto>('customer.statementPdf', {
          customerId: customer.id,
          from,
          to: today,
        }),
      ).fileName
    }
    expect(await fileOf('مريم الكعبي')).toBe(`statement-مريم-الكعبي-${from}-${today}.pdf`)
    expect(await fileOf('عائشة النعيمي')).toBe(`statement-عائشة-النعيمي-${from}-${today}.pdf`)
    expect(await fileOf('Brew & Co. Café')).toBe(`statement-Brew-Co-Café-${from}-${today}.pdf`)
  }, 90_000)

  it('needs Payments on and payments and customers seen (D-314)', async () => {
    const scope = await InvoiceScope.open(api, BAKER)
    const customer = await scope.customer({ name: 'Huda Ali' })
    const today = await scope.today()
    ok(
      await scope.run('business.customize', {
        item: { kind: 'module', id: 'payments' },
        enabled: false,
      }),
    )
    expect(
      codeOf(
        await scope.run('customer.statement', { customerId: customer.id, from: today, to: today }),
      ),
    ).toBe('module_disabled')
  })
})
