import type {
  CustomerDto,
  CustomerPaymentListDto,
  CustomerStatementDto,
  DocumentPdfDto,
  InvoiceDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { removeObjects } from '../src/admin/storage-admin'
import { pdfFullText } from '../src/documents/pdf/text-layer'
import { SECRET_KEY, testConfig } from './helpers'
import { BUYER_TRN, InvoiceScope, InvoicesApi, typed } from './invoices'
import { codeOf, ok, type Person } from './purchasing'

// Security adversary of M3 Step 8 (invoices, credit notes, payments on invoices, statements), through
// the API with Invoices previewed (D-125). Each test states the secure outcome and fails while the
// issue stands; nothing here is fixed by the test.
//
//   1. customer.statement / customer.statementPdf need only payments.customers.view (D-308), yet hand a
//      member who may not see customers (D-2504: name and the phone's last 4 digits only) the
//      customer's TRN, trade licence and address, and print their whole phone.
//   2. invoice.get of a draft returns the customer's live TRN, trade licence and address to a member
//      with invoices.documents.view/manage but without customers.items.view (an Employee preparing
//      invoices): a draft for any customer they can pick reads that customer's particulars back.
//   3. A draft made from an order keeps its customer and lines but not its branch: invoice.update moves
//      it to another branch, and once issued a member limited to that branch reads the other branch's
//      order payments (customerPayment.list on the invoice) — Q12.
//   4. An issued invoice's PDF, rendered again when its stored copy is gone (D-307: "it comes out the
//      same"), prints the customer's phone as it is now: the customer's phone is not frozen at issue.
//   5. (A guard, latent today.) invoice.pdf is served with invoices.documents.view alone and prints
//      what the invoice was paid before it ("Paid before this invoice", "Balance due", D-307), while
//      invoice.get/list/history hide payments without payments.customers.view (D-306). It passes now
//      only because the "as of its issue" read cuts issued_at to milliseconds and never prints the
//      row (invoices.compliance-adversary 8); once that is fixed, this test must still pass.
//   6. invoices.documents.view needs nothing (PERMISSION_NEEDS), while orders.documents.view and
//      payments.customers.view need sales.documents.view (H1: seeing every one is seeing every sale).
//      An Employee, who sees only the sales they entered (D-181), given "see invoices" reads every
//      invoice: the invoiced sales of everyone, with their lines, prices and totals.
//
// Every business, customer and figure is fictional.

const api = new InvoicesApi()
afterAll(() => api.close())

const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))
const compact = (text: string) => text.replace(/\s+/g, '')
const storageAdmin = { ...testConfig, supabaseSecretKey: SECRET_KEY }

/** Sets a member's own changes to their role (the owner, through the API). */
async function overrides(
  scope: InvoiceScope,
  member: { memberId: string },
  changes: { key: string; effect: 'allow' | 'deny' }[],
): Promise<void> {
  const current = ok(
    await scope.run<{ version: number }>('member.permissions', { memberId: member.memberId }),
  )
  ok(
    await scope.run('member.updatePermissions', {
      memberId: member.memberId,
      version: current.version,
      overrides: changes,
    }),
  )
}

/** A VAT-registered fit-out company ready to issue tax invoices, with a registered buyer. */
async function opened(buyer: object = {}) {
  const scope = await InvoiceScope.open(api)
  await scope.taxReady()
  const customer = await scope.buyer({
    name: `Gulf Horizon ${newId().slice(-6)}`,
    phone: '050 987 6543',
    tradeLicenceNo: 'DED-55501',
    ...buyer,
  })
  return { scope, customer }
}

describe('1. a customer statement for a member who may not see customers', () => {
  it('gives no TRN, trade licence, address or whole phone to a payments viewer without customers.items.view', async () => {
    const { scope, customer } = await opened()
    await scope.issued({ customerId: customer.id, lines: [typed('Gypsum partition', '1', '1000')] })
    // A Sales member whose owner took "see customers" away (Sales keeps payments.customers.view).
    const member = await scope.api.member({ id: scope.id, owner: scope.owner }, 'sales')
    await overrides(scope, member, [
      { key: 'customers.items.view', effect: 'deny' },
      { key: 'customers.items.manage', effect: 'deny' },
    ])
    // The premise: they may not read the customer, and What customers owe names them only.
    expect(codeOf(await scope.as(member, 'customer.get', { id: customer.id }))).toBe('forbidden')
    const owed = ok(
      await scope.as<{ groups: { customerId: string | null }[] }>(member, 'receivable.list', {}),
    )
    expect(owed.groups.some((g) => g.customerId === customer.id)).toBe(true)

    const today = await scope.today()
    const period = { customerId: customer.id, from: `${today.slice(0, 8)}01`, to: today }
    const read = await scope.as<CustomerStatementDto>(member, 'customer.statement', period)
    if (codeOf(read) === 'forbidden') return
    const statement = ok(read)
    expect(statement.customer).toMatchObject({
      trn: null,
      tradeLicence: null,
      addressLine: null,
      city: null,
      emirate: null,
    })
    const pdf = ok(await scope.as<DocumentPdfDto>(member, 'customer.statementPdf', period))
    const text = compact(await pdfFullText(decode(pdf.base64)))
    expect(text).not.toContain(BUYER_TRN)
    expect(text).not.toContain('MarinaPlaza')
    // The whole phone (more than its last 4 digits).
    expect(text).not.toContain('9876543')
  }, 90_000)
})

describe('2. a draft invoice for a member who may not see customers', () => {
  it("does not read a customer's TRN, licence and address back through invoice.get", async () => {
    const { scope, customer } = await opened()
    // An Employee (adds customers, names them by name and the phone's last 4 digits only) whom the
    // owner lets prepare invoices (seeing every invoice needs seeing every sale, test 6: allowed too).
    const employee = await scope.api.member({ id: scope.id, owner: scope.owner }, 'employee')
    await overrides(scope, employee, [
      { key: 'sales.documents.view', effect: 'allow' },
      { key: 'invoices.documents.view', effect: 'allow' },
      { key: 'invoices.documents.manage', effect: 'allow' },
    ])
    expect(codeOf(await scope.as(employee, 'customer.get', { id: customer.id }))).toBe('forbidden')
    const picked = ok(
      await scope.as<{ items: { id: string; phone: string | null }[] }>(employee, 'customer.pick', {
        search: customer.name,
      }),
    )
    expect(picked.items.find((c) => c.id === customer.id)?.phone).toBeNull()

    const draft = ok(
      await scope.as<InvoiceDto>(employee, 'invoice.create', {
        id: newId(),
        customerId: customer.id,
        lines: [typed('Site visit', '1', '100')],
      }),
    )
    const read = ok(await scope.as<InvoiceDto>(employee, 'invoice.get', { id: draft.id }))
    expect(read.customer.trn).not.toBe(BUYER_TRN)
    expect(read.customer.tradeLicence).not.toBe('DED-55501')
    expect(read.customer.addressLine).toBeNull()
  }, 90_000)
})

describe('3. a draft made from an order keeps its branch (Q12)', () => {
  it("a branch-limited member never reads another branch's order payments through its invoice", async () => {
    const { scope, customer } = await opened()
    const service = await scope.service('10000')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '10000' }],
      payment: {
        id: newId(),
        method: 'bank_transfer',
        amount: '1234.5',
        note: 'Deposit of the main branch',
      },
    })
    const branch = ok(
      await scope.run<{ id: string }>('location.create', { id: newId(), name: 'Fictional Marina' }),
    )
    const limited = await scope.api.member({ id: scope.id, owner: scope.owner }, 'sales')
    const locations = ok(
      await scope.run<{ version: number }>('member.locations', { memberId: limited.memberId }),
    )
    ok(
      await scope.run('member.updateLocations', {
        memberId: limited.memberId,
        version: locations.version,
        locationIds: [branch.id],
      }),
    )
    // The premise: the order (main branch) is out of their sight.
    expect(codeOf(await scope.as(limited, 'order.get', { id: order.id }))).toBe('not_found')

    const draft = await scope.fromOrder(order.id)
    expect(draft.locationId).toBe(order.locationId)
    const moved = await scope.as<InvoiceDto>(scope.owner, 'invoice.update', {
      id: draft.id,
      version: draft.version,
      locationId: branch.id,
      channelId: draft.channelId,
    })
    // Secure: a sourced draft keeps its source's branch (refused, or kept).
    if (codeOf(moved) === 'validation') return
    const kept = ok(moved)
    if (kept.locationId === order.locationId) return
    const issued = await scope.issue(kept)
    const payments = ok(
      await scope.as<CustomerPaymentListDto>(limited, 'customerPayment.list', {
        invoiceId: issued.id,
      }),
    )
    expect(JSON.stringify(payments.items)).not.toContain('Deposit of the main branch')
    expect(payments.items.filter((p) => p.documentKind === 'order')).toEqual([])
  }, 90_000)
})

describe('4. an issued invoice renders again as it was issued (D-307)', () => {
  it("its PDF made again prints the customer's phone as at issue, not as it is now", async () => {
    const { scope, customer } = await opened()
    const invoice = await scope.issued({
      customerId: customer.id,
      lines: [typed('Gypsum partition', '1', '1000')],
    })
    expect(invoice.pdfStored).toBe(true)
    const first = compact(await pdfFullText(decode((await scope.invoicePdf(invoice.id)).base64)))
    expect(first).toContain('9876543')

    // The customer's phone changes after the invoice was issued.
    const now = ok(await scope.run<CustomerDto>('customer.get', { id: customer.id }))
    ok(
      await scope.run('customer.update', {
        id: now.id,
        version: now.version,
        name: now.name,
        kind: now.kind,
        phone: '050 111 2222',
        email: now.email,
        trn: now.trn,
        tradeLicenceNo: now.tradeLicenceNo,
        addressLine: now.addressLine,
        city: now.city,
        emirate: now.emirate,
        country: now.country,
        notes: now.notes,
      }),
    )
    // The stored copy is gone (Storage lost it): invoice.pdf makes it again "from the same frozen
    // values".
    const [stored] = await api.admin<{ path: string }[]>`
      select u.path from app.invoices i
        join app.file_uploads u on u.business_id = i.business_id and u.id = i.pdf_upload_id
       where i.business_id = ${scope.id} and i.id = ${invoice.id}`
    expect(stored?.path).toBeDefined()
    await removeObjects(storageAdmin, [stored!.path])
    const again = compact(await pdfFullText(decode((await scope.invoicePdf(invoice.id)).base64)))
    expect(again).toContain('9876543')
    expect(again).not.toContain('1112222')
  }, 90_000)
})

describe('5. an invoice PDF for a member who may not see payments', () => {
  it('does not print what the invoice was paid when invoice.get hides it', async () => {
    const { scope, customer } = await opened()
    const service = await scope.service('10000')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '10000' }],
      payment: { id: newId(), method: 'bank_transfer', amount: '1234.5' },
    })
    const invoice = await scope.issue(await scope.fromOrder(order.id))
    expect(invoice.payment).toMatchObject({ paid: '1234.5' })
    // A Sales member whose owner took "see what customers pay" away (still sees and prepares invoices).
    const member: Person & { memberId: string } = await scope.api.member(
      { id: scope.id, owner: scope.owner },
      'sales',
    )
    await overrides(scope, member, [
      { key: 'payments.customers.view', effect: 'deny' },
      { key: 'payments.customers.record', effect: 'deny' },
    ])
    // The premise: the API hides what it was paid from them.
    const seen = await scope.getInvoice(invoice.id, member)
    expect(seen.payment).toBeNull()
    expect(codeOf(await scope.as(member, 'customerPayment.list', { invoiceId: invoice.id }))).toBe(
      'forbidden',
    )

    const pdf = await scope.invoicePdf(invoice.id, member)
    const text = await pdfFullText(decode(pdf.base64))
    expect(text).not.toContain('1,234.50')
  }, 90_000)
})

describe('6. seeing every invoice is seeing every sale (H1)', () => {
  it('invoices.documents.view is not granted to a member who sees only their own sales', async () => {
    const { scope, customer } = await opened()
    // The owner's own recorded sale, invoiced.
    const service = await scope.service('3000')
    const sale = await scope.sell({
      businessDate: await scope.today(),
      customerId: customer.id,
      channelId: await scope.channelId(),
      payLater: true,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '3000' }],
    })
    const invoice = await scope.issue(await scope.fromSale(sale.id))
    // An Employee sees only the sales they entered (D-181): not the owner's.
    const employee = await scope.api.member({ id: scope.id, owner: scope.owner }, 'employee')
    expect(codeOf(await scope.as(employee, 'sale.get', { id: sale.id }))).toBeDefined()
    const own = ok(await scope.as<{ items: { id: string }[] }>(employee, 'sale.list', {}))
    expect(own.items.map((s) => s.id)).not.toContain(sale.id)
    // orders.documents.view and payments.customers.view need sales.documents.view (H1); the owner
    // lets the Employee see invoices.
    const current = ok(
      await scope.run<{ version: number }>('member.permissions', { memberId: employee.memberId }),
    )
    const saved = await scope.run('member.updatePermissions', {
      memberId: employee.memberId,
      version: current.version,
      overrides: [{ key: 'invoices.documents.view', effect: 'allow' }],
    })
    // Secure: refused (the key needs sales.documents.view), or granting nothing.
    if (codeOf(saved) === 'validation') return
    ok(saved)
    const list = await scope.as<{ items: { id: string; payable: string }[] }>(
      employee,
      'invoice.list',
      {},
    )
    if (codeOf(list) === 'forbidden') return
    expect(ok(list).items.map((i) => i.id)).not.toContain(invoice.id)
  }, 90_000)
})
