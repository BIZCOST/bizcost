import type { BusinessProfileDto, OrderDto, ProductDto, QuotationDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeOf, ok } from './purchasing'
import { QuotationScope, QuotationsApi, quoteItem, quoteTyped } from './quotations'

// Money and rules adversary of M3 Step 7 (Q21, Q22, Q25; D-283–D-286, review fixes D-296), through the
// API with Quotations previewed (D-125): an accepted quotation becomes an order with the lines, prices,
// VAT, customer and products the customer accepted; revisions count n + 1 under the same number and keep
// their customer; declined extra work (a new revision of an accepted quotation, Q22) keeps the first
// acceptance in the history and a revision without it becomes the order (D-283); a branch-limited member
// sees only the revisions of their branches. Every business and customer is fictional (the demo fit-out
// persona's kind of work).

let api: QuotationsApi

beforeAll(() => {
  api = new QuotationsApi()
})

afterAll(async () => {
  await api.close()
})

/** A VAT-registered fit-out company, a customer and a service priced before VAT. */
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
  const customer = await scope.customer({ name: 'Mariam Al Ketbi' })
  const service = await scope.service('1000')
  return { scope, customer, service }
}

async function orderOf(scope: QuotationScope, orderId: string): Promise<OrderDto> {
  return ok(await scope.run<{ data: OrderDto }>('order.get', { id: orderId })).data
}

describe('accept → order: the order carries what the customer accepted', () => {
  it('a product line keeps the VAT basis it was sent with, after the product’s VAT setting changes', async () => {
    const { scope, customer, service } = await fitOut()
    // Sent at 1,000.00 before VAT: VAT 50.00, total 1,050.00.
    const sent = await scope.send(
      await scope.quote({
        customerId: customer.id,
        lines: [quoteItem(service.id, '1', '1000')],
      }),
    )
    expect(sent).toMatchObject({ netTotal: '1000', vatTotal: '50', payable: '1050' })
    // Later the owner says the service's price includes VAT (for new sales and quotations).
    await scope.updateProduct(service as ProductDto, { priceIncludesVat: true })
    const accepted = await scope.accept(sent)
    expect(accepted.payable).toBe('1050')
    const { orderId } = await scope.toOrder(accepted)
    const order = await orderOf(scope, orderId)
    // The order is worked out again from the product as it is now: 1,000.00 including VAT 47.62.
    expect(order).toMatchObject({ netTotal: '1000', vatTotal: '50', payable: '1050' })
  })

  it('a product line whose product was archived after the quotation was sent still becomes an order', async () => {
    const { scope, customer, service } = await fitOut()
    const accepted = await scope.accept(
      await scope.send(
        await scope.quote({
          customerId: customer.id,
          lines: [quoteItem(service.id, '2', '1000'), quoteTyped('Site visit', '1', '250')],
        }),
      ),
    )
    // The service is no longer offered for new work; the customer had already accepted it.
    ok(await scope.run('product.archive', { id: service.id }))
    const made = await scope.run('quotation.toOrder', { id: accepted.id, orderId: newId() })
    // prepareOrder is given no stored product ids: "lines: a product was archived" (VALIDATION).
    expect(codeOf(made)).toBeUndefined()
  })
})

describe('revisions count n + 1 under the same number', () => {
  it('a discarded draft revision does not use up its revision number', async () => {
    const { scope, customer } = await fitOut()
    const sent = await scope.send(
      await scope.quote({ customerId: customer.id, lines: [quoteTyped('Wardrobe', '1', '3000')] }),
    )
    const draft = await scope.revise(sent)
    expect(draft.revision).toBe(2)
    ok(await scope.run('quotation.discard', { id: draft.id, version: draft.version }))
    // Revision 1 is the latest live revision again: the next one is revision 2, not 3 (the customer
    // would otherwise get Q-0001 then Q-0001-R3 with no revision 2 ever sent).
    const again = await scope.revise(sent)
    expect(again).toMatchObject({ number: sent.number, revision: 2 })
  })
})

describe('a revision is the same quotation for the same customer', () => {
  it('a revision draft cannot be moved to another customer (that is a copy)', async () => {
    const { scope, customer } = await fitOut()
    const other = await scope.customer({ name: 'Sara Haddad' })
    const accepted = await scope.accept(
      await scope.send(
        await scope.quote({ customerId: customer.id, lines: [quoteTyped('Kitchen', '1', '9000')] }),
      ),
    )
    const draft = await scope.revise(accepted)
    const moved = await scope.run<QuotationDto>('quotation.update', {
      id: draft.id,
      version: draft.version,
      customerId: other.id,
      businessDate: draft.businessDate,
      lines: [quoteTyped('Kitchen', '1', '9000')],
    })
    // Saved: Q-0001 revision 2 is now Sara's, and sending it supersedes Mariam's accepted revision 1.
    expect(codeOf(moved)).toBe('validation')
  })
})

describe('extra work on an accepted quotation (Q22)', () => {
  it('declined extra work: the first acceptance stays in the history, and a revision without the extra work becomes the order', async () => {
    const { scope, customer } = await fitOut()
    const majlis = quoteTyped('Majlis wall cladding', '18.5', '650', { area: 'MAJLIS' })
    const accepted: QuotationDto = await scope.accept(
      await scope.send(await scope.quote({ customerId: customer.id, lines: [majlis] })),
    )
    const asInput = (quote: QuotationDto) =>
      quote.lines.map((l) => ({
        id: l.id,
        productId: null,
        area: l.area,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unitPrice: l.unitPrice,
      }))
    // Extra work: revision 2 with one more line, sent to the customer, who declines the extra.
    const extra = await scope.revise(accepted)
    ok(
      await scope.run('quotation.update', {
        id: extra.id,
        version: extra.version,
        customerId: customer.id,
        businessDate: extra.businessDate,
        lines: [...asInput(extra), quoteTyped('Extra TV unit', '1', '4200', { area: 'MAJLIS' })],
      }),
    )
    const declined = await scope.decline(await scope.send(await scope.getQuote(extra.id)))
    expect(declined.status).toBe('declined')
    // D-283: once revision 2 was sent, revision 1 is superseded; its acceptance is kept in the history.
    expect((await scope.getQuote(accepted.id)).status).toBe('superseded')
    const events = (await scope.history(accepted.id)).events
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'accepted', revision: 1 })]),
    )
    // The way out (D-283): revision 3 without the extra work, sent, accepted again, then the order.
    const third = await scope.revise(declined)
    expect(third.revision).toBe(3)
    ok(
      await scope.run('quotation.update', {
        id: third.id,
        version: third.version,
        customerId: customer.id,
        businessDate: third.businessDate,
        lines: asInput(third).filter((l) => l.description !== 'Extra TV unit'),
      }),
    )
    const again = await scope.accept(await scope.send(await scope.getQuote(third.id)))
    expect(again.payable).toBe(accepted.payable)
    const { orderId } = await scope.toOrder(again)
    expect((await orderOf(scope, orderId)).payable).toBe(accepted.payable)
  })
})

describe('accept → order keeps what was accepted (more)', () => {
  it('a product made zero-rated after sending: the order keeps the 5 % the customer accepted', async () => {
    const { scope, customer, service } = await fitOut()
    const sent = await scope.send(
      await scope.quote({ customerId: customer.id, lines: [quoteItem(service.id, '1', '1000')] }),
    )
    await scope.updateProduct(service as ProductDto, { vatCategory: 'zero_rated' })
    const { orderId } = await scope.toOrder(await scope.accept(sent))
    expect(await orderOf(scope, orderId)).toMatchObject({
      netTotal: '1000',
      vatTotal: '50',
      payable: '1050',
    })
  })

  it('an amount discount still becomes an order after one product switched to prices with VAT', async () => {
    const { scope, customer, service } = await fitOut()
    const other = await scope.service('500')
    const sent = await scope.send(
      await scope.quote({
        customerId: customer.id,
        lines: [quoteItem(service.id, '1', '1000'), quoteItem(other.id, '1', '500')],
        discount: { amount: '100' },
      }),
    )
    expect(sent.payable).toBe('1470')
    await scope.updateProduct(other as ProductDto, { priceIncludesVat: true })
    const { orderId } = await scope.toOrder(await scope.accept(sent))
    expect((await orderOf(scope, orderId)).payable).toBe('1470')
  })

  it('a customer archived after accepting still gets the order', async () => {
    const { scope, customer } = await fitOut()
    const accepted = await scope.accept(
      await scope.send(
        await scope.quote({
          customerId: customer.id,
          lines: [quoteTyped('Wardrobe', '1', '3000')],
        }),
      ),
    )
    ok(await scope.run('customer.archive', { id: customer.id }))
    const made = await scope.run('quotation.toOrder', { id: accepted.id, orderId: newId() })
    expect(codeOf(made)).toBeUndefined()
  })
})

describe('a branch-limited member sees only the revisions in their branches (Q12)', () => {
  it('a revision moved to another branch: not in the revisions, not in the history, nor its order', async () => {
    const { scope, customer } = await fitOut()
    const branch = ok(
      await scope.run<{ id: string }>('location.create', { id: newId(), name: 'Fictional Marina' }),
    )
    const limited = await scope.api.member({ id: scope.id, owner: scope.owner }, 'sales')
    const current = ok(
      await scope.run<{ version: number }>('member.locations', { memberId: limited.memberId }),
    )
    const main = (
      await scope.quote({ customerId: customer.id, lines: [quoteTyped('Wardrobe', '1', '1000')] })
    ).locationId
    ok(
      await scope.run('member.updateLocations', {
        memberId: limited.memberId,
        version: current.version,
        locationIds: [main],
      }),
    )
    const first = await scope.send(
      await scope.quote({ customerId: customer.id, lines: [quoteTyped('Wardrobe', '1', '1000')] }),
    )
    const second = await scope.revise(first)
    ok(
      await scope.run('quotation.update', {
        id: second.id,
        version: second.version,
        customerId: customer.id,
        businessDate: second.businessDate,
        locationId: branch.id,
        lines: [quoteTyped('Wardrobe XL', '1', '7777')],
      }),
    )
    const accepted = await scope.accept(
      await scope.send(await scope.getQuote(second.id)),
      'a note of the other branch',
    )
    await scope.toOrder(accepted)
    expect(codeOf(await scope.as(limited, 'quotation.get', { id: second.id }))).toBe('not_found')
    const seen = await scope.getQuote(first.id, limited)
    expect(seen.revisions.map((r) => r.revision)).toEqual([1])
    const events = (await scope.history(first.id, limited)).events
    expect(events.every((e) => e.revision === 1)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('a note of the other branch')
    expect(events.some((e) => e.kind === 'ordered')).toBe(false)
    // The owner sees both, and the order.
    const owners = (await scope.history(first.id)).events
    expect(owners.some((e) => e.kind === 'ordered' && e.revision === 2)).toBe(true)
  })
})
