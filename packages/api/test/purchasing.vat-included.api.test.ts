import type { PurchaseDto, PurchaseReturnDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope } from './purchasing'
import { BAKER, WORKSHOP } from './settings'

// Prices typed with their VAT (the owner's request of 2026-09-29) through the real fetch handler: the
// purchase keeps the choice and the prices as typed, its amounts are stored before VAT, VAT and total
// (105 including 5 % is 100 + 5), and posting brings into stock exactly what the same goods typed
// before VAT would; returns and "correct" read the purchase the same way.

let api: PurchasingApi
let shop: Scope
let today: string

type Envelope<T> = { data: T; meta: { redacted: string[] } }

beforeAll(async () => {
  api = new PurchasingApi()
  shop = await Scope.open(api, WORKSHOP)
  today = await shop.today()
}, 60_000)

afterAll(async () => {
  await api.close()
})

describe('prices including VAT', () => {
  it('105 including 5 % is 100 + 5, and the goods cost what they would typed before VAT', async () => {
    const milk = await shop.material()
    const draft = await shop.draft(
      purchaseInput(today, [line(milk.id, '1', '105', { vatRate: '5' })], {
        documentType: 'tax_invoice',
        pricesIncludeVat: true,
      }),
    )
    expect(draft).toMatchObject({
      pricesIncludeVat: true,
      subtotal: '100',
      netTotal: '100',
      vatTotal: '5',
      total: '105',
    })
    expect(draft.lines[0]).toMatchObject({
      unitPrice: '105',
      taxable: '100',
      vat: '5',
      total: '105',
    })
    const posted = await shop.post(draft)
    expect(posted).toMatchObject({ vatInCost: false, costTotal: '100', netTotal: '100' })
    expect(posted.lines[0]).toMatchObject({ cost: '100', baseQty: '1000' })

    const before = await shop.buy(
      purchaseInput(today, [line(milk.id, '1', '100', { vatRate: '5' })], {
        documentType: 'tax_invoice',
      }),
    )
    expect(before).toMatchObject({ pricesIncludeVat: false, costTotal: '100', total: '105' })
    const [receipts] = await api.admin<{ values: string[] }[]>`
      select array_agg(trim_scale(m.value)::text order by m.seq) as values
        from app.stock_movements m
        join app.purchase_lines l on l.id = m.purchase_line_id
       where l.purchase_id in (${posted.id}, ${before.id}) and m.kind = 'purchase'`
    expect(receipts?.values).toEqual(['100', '100'])
    await shop.expectRebuildEqualsProjections()
  })

  it('a line discount and the document discount come off the price with its VAT', async () => {
    const milk = await shop.material()
    // 10 × 10.50 = 105.00 − 10 % = 94.50; 94.50 + 105.00 = 199.50 − 19.95 (10 %) = 179.55.
    const purchase = await shop.draft(
      purchaseInput(
        today,
        [
          line(milk.id, '10', '10.5', { vatRate: '5', discount: { percent: '10' } }),
          line(milk.id, '1', '105', { vatRate: '5' }),
        ],
        { documentType: 'tax_invoice', pricesIncludeVat: true, discount: { percent: '10' } },
      ),
    )
    expect(purchase.lines.map((l) => [l.total, l.vat, l.taxable])).toEqual([
      ['85.05', '4.05', '81'],
      ['94.5', '4.5', '90'],
    ])
    expect(purchase).toMatchObject({ netTotal: '171', vatTotal: '8.55', total: '179.55' })
  })

  it('a business that is not VAT-registered types what it paid: no VAT, the same amounts', async () => {
    const baker = await Scope.open(api, BAKER)
    const flour = await baker.material({ id: newId(), name: 'Flour', unit: 'kg', packs: [] })
    const purchase = await baker.buy(
      purchaseInput(await baker.today(), [line(flour.id, '10', '5.25', { unit: 'kg' })], {
        pricesIncludeVat: true,
      }),
    )
    expect(purchase).toMatchObject({
      netTotal: '52.5',
      vatTotal: '0',
      total: '52.5',
      costTotal: '52.5',
    })
  })

  it('left out, prices are before VAT; a return and "correct" keep the choice', async () => {
    const milk = await shop.material()
    const plain = await shop.draft(purchaseInput(today, [line(milk.id, '1', '1')]))
    expect(plain.pricesIncludeVat).toBe(false)

    const purchase = await shop.buy(
      purchaseInput(today, [line(milk.id, '2', '10.5', { vatRate: '5' })], {
        documentType: 'tax_invoice',
        pricesIncludeVat: true,
      }),
    )
    expect(purchase).toMatchObject({ netTotal: '20', vatTotal: '1', total: '21' })
    const returned = await shop.postReturn(
      await shop.returnDraft({
        id: newId(),
        purchaseId: purchase.id,
        kind: 'return',
        businessDate: today,
        lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, qty: '1' }],
      }),
    )
    expect(returned).toMatchObject<Partial<PurchaseReturnDto>>({
      netTotal: '10',
      vatTotal: '0.5',
      total: '10.5',
    })
    expect(codeOf(await shop.run('purchase.correct', { id: purchase.id, newId: newId() }))).toBe(
      'purchase_has_returns',
    )

    const other = await shop.buy(
      purchaseInput(today, [line(milk.id, '1', '21', { vatRate: '5' })], {
        documentType: 'tax_invoice',
        pricesIncludeVat: true,
      }),
    )
    const copy = ok(
      await shop.run<Envelope<PurchaseDto>>('purchase.correct', { id: other.id, newId: newId() }),
    ).data
    expect(copy).toMatchObject({
      status: 'draft',
      pricesIncludeVat: true,
      netTotal: '20',
      vatTotal: '1',
      total: '21',
    })
    expect(copy.lines[0]?.unitPrice).toBe('21')
  })
})
