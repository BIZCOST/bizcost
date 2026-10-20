import type { BusinessContextDto, InvoiceDto, SaleDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { InvoiceScope, InvoicesApi, typed } from './invoices'
import { codeOf, ok } from './purchasing'
import { DESIGNER } from './quotations'

// Release B (ROADMAP.md M3 Step 9), the permissions and release-gates adversary: what Quotations and
// Invoices reach once they are released for everyone. Each test failed before its fix (D-323, D-324)
// and is kept. Every business, customer and figure is fictional.
//
// 1. Invoices without Sales. Release A made Orders depend on Sales because "a module whose records
//    are another module's records cannot work with that module off" (D-275). An issued invoice is a
//    sale (it posts one, source `invoice`; a credit note posts a negative one; Sales lists them,
//    D-303), and `invoice.fromSale` bills a recorded One sale. `invoices.deps` was products,
//    customers and payments only, so Customize BizCost left Invoices on with Sales off, and
//    `lockSource` checked the source's module for a quotation (Quotations) and an order (Orders) but
//    not for a sale: a sale was read and billed with Sales switched off. Fixed (D-323): Invoices needs
//    Sales, and a sale is billed only with Sales on.
//
// 2. "+" New quotation / New invoice led to an editor whose customer picker the member could not call.
//    `customer.pick` (and `.similar`) answered those who add customers, enter orders or sales, or
//    record customer payments; preparing a quotation or an invoice was not among them. An Accountant
//    whose "See customers" and "Record customer payments" were taken off kept "Prepare invoices" and
//    was offered "+ New invoice", but could not name the customer an invoice must have. Fixed (D-324):
//    preparing quotations or invoices names customers too (masked, as for an Employee).
//
// 3. The picker's keys without their modules (the second review). `customer.pick` took any of its keys
//    (requireAnyPermission), and a member's keys do not depend on which modules are on, so a member
//    whose only picker key was "Prepare quotations" still got customers' names and the phone's last 4
//    digits with Quotations switched off; the web's mayPickCustomers asks for each key's module too.
//    Fixed (D-327): each key opens the picker only while its own module is on (requireAnyAccess).

const api = new InvoicesApi()
afterAll(() => api.close())

const turn = (scope: InvoiceScope, id: string, enabled: boolean) =>
  scope.run('business.customize', { item: { kind: 'module', id }, enabled })

describe('Invoices with Sales switched off (D-275: a module whose records are another module’s)', () => {
  it('a recorded sale is not billed while Sales is off, as an order is not with Orders off', async () => {
    const scope = await InvoiceScope.open(api, DESIGNER)
    const customer = await scope.customer({ name: 'Bloom Florists LLC', kind: 'business' })
    const service = await scope.service('2000')
    const sale: SaleDto = await scope.sell({
      businessDate: await scope.today(),
      customerId: customer.id,
      payLater: true,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '2000' }],
    })
    // A draft made from the sale while Sales was on.
    const draft = await scope.fromSale(sale.id)
    ok(await turn(scope, 'sales', false))
    expect(codeOf(await scope.run('sale.get', { id: sale.id }))).toBe('module_disabled')
    // Billing the sale reads it (lockSource 'sale'): Sales must be on, as Orders for an order
    // (`invoice.fromOrder`) and Quotations for a quotation (`invoice.fromQuotation`).
    const billed = await scope.run<InvoiceDto>('invoice.fromSale', {
      saleId: sale.id,
      newId: newId(),
    })
    expect(codeOf(billed), billed.raw).toBe('module_disabled')
    // Issuing the draft locks and reads the sale again.
    const issued = await scope.issueRaw(draft)
    expect(codeOf(issued), issued.raw).toBe('module_disabled')
  }, 90_000)

  it('Customize turns Invoices off with Sales, as it turns Orders off (an issued invoice is a sale)', async () => {
    const scope = await InvoiceScope.open(api, DESIGNER)
    await scope.channel({ name: 'Studio', kind: 'shop' })
    ok(await turn(scope, 'sales', false))
    const context = ok(await scope.run<BusinessContextDto>('business.context'))
    const on = context.modules.map((m) => m.id)
    expect(on).not.toContain('sales')
    // Before D-323 Invoices stayed on: its editor's channel list (`channel.list`, Sales' own) was
    // MODULE_DISABLED, so with two channels a new invoice could never name one and its issue stopped at
    // "channel missing"; with one channel it was issued and posted a sale into the switched-off module.
    expect(on, 'Invoices goes off with Sales (invoices.deps)').not.toContain('invoices')
    expect(codeOf(await scope.run('invoice.list'))).toBe('module_disabled')
    expect(codeOf(await scope.run('creditNote.list'))).toBe('module_disabled')
    // Turning Invoices on again turns Sales on with it.
    ok(await turn(scope, 'invoices', true))
    const back = ok(await scope.run<BusinessContextDto>('business.context')).modules.map(
      (m) => m.id,
    )
    expect(back).toEqual(expect.arrayContaining(['sales', 'invoices']))
    // With Sales on, the editor lists both channels, and an invoice that names one is issued.
    const channels = ok(
      await scope.run<{ data: { items: { id: string }[] } }>('channel.list', { status: 'active' }),
    ).data.items
    expect(channels.length).toBe(2)
    const customer = await scope.customer({ name: 'Palm Realty', kind: 'business' })
    const draft = await scope.invoice({
      customerId: customer.id,
      channelId: channels[0]!.id,
      lines: [typed('Logo refresh', '1', '1500')],
    })
    const issued = await scope.issueRaw(draft)
    expect(codeOf(issued), issued.raw).toBeUndefined()
  }, 90_000)
})

describe('"+" New quotation and New invoice lead to procedures the member may call', () => {
  it('an Accountant without "See customers" and "Record customer payments" is offered New invoice and can name its customer', async () => {
    const scope = await InvoiceScope.open(api)
    const accountant = await api.member(scope, 'accountant')
    const { version } = ok(
      await scope.run<{ version: number }>('member.permissions', {
        memberId: accountant.memberId,
      }),
    )
    ok(
      await scope.run('member.updatePermissions', {
        memberId: accountant.memberId,
        version,
        overrides: [
          { key: 'customers.items.view', effect: 'deny' },
          { key: 'payments.customers.record', effect: 'deny' },
        ],
      }),
    )
    const context = ok(await scope.as<BusinessContextDto>(accountant, 'business.context'))
    const plus = context.modules.flatMap((m) => m.quickActions.map((a) => a.id))
    // "+" offers New invoice (invoices.documents.manage is kept)…
    expect(plus).toContain('new_invoice')
    await scope.customer({ name: 'Gulf Hotels LLC', kind: 'business' })
    // …and the editor's customer picker answers them (masked, as for an Employee): an invoice cannot
    // be made without its customer.
    const picked = await scope.as<{ items: { name: string; phone: string | null }[] }>(
      accountant,
      'customer.pick',
      { search: 'Gulf' },
    )
    expect(codeOf(picked), picked.raw).toBeUndefined()
    expect(picked.data?.items.map((item) => [item.name, item.phone])).toEqual([
      ['Gulf Hotels LLC', null],
    ])
    expect(
      codeOf(await scope.as(accountant, 'customer.similar', { name: 'Gulf Hotels LLC' })),
    ).toBeUndefined()
    // Seeing customers stays with "See customers".
    expect(codeOf(await scope.as(accountant, 'customer.list', {}))).toBe('forbidden')
  }, 90_000)

  it('a salesperson left with "Prepare quotations" and "Prepare invoices" only names the customer of both', async () => {
    const scope = await InvoiceScope.open(api)
    const sales = await api.member(scope, 'sales')
    const { version } = ok(
      await scope.run<{ version: number }>('member.permissions', { memberId: sales.memberId }),
    )
    ok(
      await scope.run('member.updatePermissions', {
        memberId: sales.memberId,
        version,
        overrides: [
          'customers.items.view',
          'customers.items.manage',
          'orders.documents.manage',
          'sales.documents.manage',
          'payments.customers.record',
        ].map((key) => ({ key, effect: 'deny' })),
      }),
    )
    const context = ok(await scope.as<BusinessContextDto>(sales, 'business.context'))
    const plus = context.modules.flatMap((m) => m.quickActions.map((a) => a.id))
    expect(plus).toEqual(expect.arrayContaining(['new_quotation', 'new_invoice']))
    await scope.customer({ name: 'Marina Towers LLC', kind: 'business' })
    for (const [path, input] of [
      ['customer.pick', { search: 'Marina' }],
      ['customer.similar', { name: 'Marina Towers LLC' }],
    ] as const) {
      const result = await scope.as(sales, path, input)
      expect(codeOf(result), `${path} ${result.raw}`).toBeUndefined()
      // The name and the phone's last 4 digits, never the whole phone.
      expect(result.raw).toContain('4567')
      expect(result.raw).not.toContain('123 4567')
    }
  }, 90_000)
})

describe('The customer picker follows the module of the key that opens it (D-327)', () => {
  it('each key opens customer.pick and .similar only while its own module is on, as the web’s mayPickCustomers', async () => {
    const scope = await InvoiceScope.open(api)
    const sales = await api.member(scope, 'sales')
    await scope.customer({ name: 'Marina Towers LLC', kind: 'business' })
    // Each module switched off in this order leaves the next one on (Sales takes Orders and Invoices
    // off with it, Payments the same two; Quotations and Customers stay on).
    const KEYS = [
      ['quotations', 'quotations.documents.manage'],
      ['invoices', 'invoices.documents.manage'],
      ['orders', 'orders.documents.manage'],
      ['sales', 'sales.documents.manage'],
      ['payments', 'payments.customers.record'],
    ] as const
    const pickerKeys = ['customers.items.view', 'customers.items.manage', ...KEYS.map(([, k]) => k)]
    const picks = [
      ['customer.pick', { search: 'Marina' }],
      ['customer.similar', { name: 'Marina Towers LLC' }],
    ] as const
    for (const [module, key] of KEYS) {
      // The member is left with this one picker key.
      const { version } = ok(
        await scope.run<{ version: number }>('member.permissions', { memberId: sales.memberId }),
      )
      ok(
        await scope.run('member.updatePermissions', {
          memberId: sales.memberId,
          version,
          overrides: pickerKeys
            .filter((other) => other !== key)
            .map((other) => ({ key: other, effect: 'deny' })),
        }),
      )
      for (const [path, input] of picks) {
        const on = await scope.as(sales, path, input)
        expect(codeOf(on), `${path} with ${key}, ${module} on: ${on.raw}`).toBeUndefined()
        expect(on.raw).toContain('Marina Towers LLC')
      }
      ok(await turn(scope, module, false))
      const context = ok(await scope.as<BusinessContextDto>(sales, 'business.context'))
      const active = context.modules.map((m) => m.id)
      expect(active).toContain('customers')
      expect(active).not.toContain(module)
      // Before D-327 both still answered (the name and the phone's last 4 digits).
      for (const [path, input] of picks) {
        const off = await scope.as(sales, path, input)
        expect(codeOf(off), `${path} with ${key}, ${module} off: ${off.raw}`).toBe('forbidden')
        expect(off.raw).not.toContain('Marina Towers LLC')
      }
    }
    // "See customers" is Customers' own key: it opens the picker with the other modules off.
    const { version } = ok(
      await scope.run<{ version: number }>('member.permissions', { memberId: sales.memberId }),
    )
    ok(
      await scope.run('member.updatePermissions', {
        memberId: sales.memberId,
        version,
        overrides: [],
      }),
    )
    const seen = await scope.as(sales, 'customer.pick', { search: 'Marina' })
    expect(codeOf(seen), seen.raw).toBeUndefined()
    expect(seen.raw).toContain('123 4567')
  }, 120_000)
})
