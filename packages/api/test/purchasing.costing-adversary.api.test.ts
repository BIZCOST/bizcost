import type { PurchaseDto, PurchaseReturnDto } from '@bizcost/contracts'
import { compareDecimal, newId, sumDecimals } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope } from './purchasing'
import { WORKSHOP } from './settings'

// Costing adversary (M2 Step 3 review, accountant's view). Each case below was a real error in what
// the API stored or showed; D-142 fixed them (a later return is reversed first, largest-remainder
// splits, credits in the currency's minor unit). After each case the ledger's rebuild is still
// compared with the projections.

let api: PurchasingApi
let shop: Scope
let today: string

beforeAll(async () => {
  api = new PurchasingApi()
  shop = await Scope.open(api, WORKSHOP)
  today = await shop.today()
}, 60_000)

afterAll(async () => {
  await api.close()
})

const qtyLine = (purchaseLineId: string, qty: string) => ({ id: newId(), purchaseLineId, qty })
const amountLine = (purchaseLineId: string, amount: string) => ({
  id: newId(),
  purchaseLineId,
  amount,
})

function documentInput(
  purchase: PurchaseDto,
  kind: 'return' | 'credit_note',
  lines: object[],
  extra: object = {},
) {
  return { id: newId(), purchaseId: purchase.id, kind, businessDate: today, lines, ...extra }
}

describe('reversing a credit note after a later return of the same line (D-120 rules 1–3)', () => {
  it('the goods left never carry more than was paid for them once the credit is gone', async () => {
    const milk = await shop.material()
    // The only purchase of this material: 10 L at AED 10.
    const purchase = await shop.buy(purchaseInput(today, [line(milk.id, '10', '10')]))
    const lineId = purchase.lines[0]!.id
    // A credit note of AED 20: the 10 L now carry 80 (AED 8 per L).
    const credit = await shop.postReturn(
      await shop.returnDraft(documentInput(purchase, 'credit_note', [amountLine(lineId, '20')])),
    )
    // Half goes back at the credited price: 5 L for 40. 5 L left, worth 40.
    const back = await shop.postReturn(
      await shop.returnDraft(documentInput(purchase, 'return', [qtyLine(lineId, '5')])),
    )
    expect(back.lines[0]).toMatchObject({ net: '40', cost: '40' })

    // The credit note was a mistake: it is reversed "as if never posted".
    const reversal = await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.reverse', {
      id: credit.id,
    })
    if (reversal.error) {
      // Refusing it while a later return of the line stands (reverse the return first) is a correct
      // fix too (D-142, the one built): nothing moves, and once the return is reversed the credit
      // goes as well, leaving the 10 L at the only price ever paid.
      expect(codeOf(reversal)).toBe('has_later_returns')
      expect(await shop.costRow(milk.id)).toEqual({ qty: '5000', value: '40', avg_cost: '0.008' })
      ok(await shop.run('purchaseReturn.reverse', { id: back.id }))
      ok(await shop.run('purchaseReturn.reverse', { id: credit.id }))
      expect(await shop.costRow(milk.id)).toEqual({ qty: '10000', value: '100', avg_cost: '0.01' })
      const [cost] = await shop.costs([milk.id])
      expect(cost?.average?.perUnit, '90-day average').toBe('10')
      expect(cost?.lastPurchase?.pricePerUnit, 'last purchase price').toBe('10')
      await shop.expectRebuildEqualsProjections()
      return
    }
    // Had the credit never been posted, the return would have taken 5 L out at 10 each, and the 5 L
    // left would carry 50: AED 10 per L, the only price ever paid. Current code: the return keeps the
    // 40 it was posted with, so the 5 L left carry 60, AED 12 per L — more than the supplier was ever
    // paid — on the stock-based average, on the 90-day average and as the "last purchase price".
    const row = await shop.costRow(milk.id)
    expect(row, 'stock-based average').toEqual({ qty: '5000', value: '50', avg_cost: '0.01' })
    const [cost] = await shop.costs([milk.id])
    expect(cost?.average?.perUnit, '90-day average').toBe('10')
    expect(cost?.lastPurchase?.pricePerUnit, 'last purchase price').toBe('10')
    await shop.expectRebuildEqualsProjections()
  })

  it('the same rule for an earlier return with a credit before a later return, and a full return', async () => {
    const milk = await shop.material()
    const purchase = await shop.buy(purchaseInput(today, [line(milk.id, '10', '10')]))
    const lineId = purchase.lines[0]!.id
    const first = await shop.postReturn(
      await shop.returnDraft(documentInput(purchase, 'return', [qtyLine(lineId, '2')])),
    )
    await shop.postReturn(
      await shop.returnDraft(documentInput(purchase, 'credit_note', [amountLine(lineId, '8')])),
    )
    await shop.postReturn(
      await shop.returnDraft(documentInput(purchase, 'return', [qtyLine(lineId, '3')])),
    )
    const before = await shop.costRow(milk.id)
    expect(codeOf(await shop.run('purchaseReturn.reverse', { id: first.id }))).toBe(
      'has_later_returns',
    )
    expect(await shop.costRow(milk.id)).toEqual(before)

    // A credit, then everything that is left goes back: the credit is not reversed under it.
    const cream = await shop.material()
    const second = await shop.buy(purchaseInput(today, [line(cream.id, '10', '10')]))
    const secondLine = second.lines[0]!.id
    const credit = await shop.postReturn(
      await shop.returnDraft(documentInput(second, 'credit_note', [amountLine(secondLine, '20')])),
    )
    await shop.postReturn(
      await shop.returnDraft(documentInput(second, 'return', [qtyLine(secondLine, '10')])),
    )
    expect(codeOf(await shop.run('purchaseReturn.reverse', { id: credit.id }))).toBe(
      'has_later_returns',
    )
    await shop.expectRebuildEqualsProjections()
  })
})

describe('a credit note entered as one amount (D-120 rule 3, split by largest remainder, D-142)', () => {
  it('credits exactly the amount typed: AED 1.50 over 20 lines of AED 10', async () => {
    const milk = await shop.material()
    const purchase = await shop.buy(
      purchaseInput(
        today,
        Array.from({ length: 20 }, () => line(milk.id, '1', '10')),
      ),
    )
    expect(purchase.costTotal).toBe('200')
    const created = await shop.run<{ data: PurchaseReturnDto }>(
      'purchaseReturn.create',
      documentInput(purchase, 'credit_note', [], { splitAmount: '1.50' }),
    )
    const draft = ok(created).data
    // Current code: each share of 0.075 rounds up to 0.08 and the remainder (−0.10) lands on the first
    // line, which gets −0.02 and is then dropped: 19 × 0.08 = 1.52 is credited for 1.50 typed.
    expect(draft.splitAmount).toBe('1.5')
    expect(sumDecimals(draft.lines.map((l) => l.amount ?? '0')), 'lines add up').toBe('1.5')
    expect(draft.netTotal, 'document net').toBe('1.5')
    const posted = await shop.postReturn(draft)
    expect(posted.costTotal, 'taken off the goods').toBe('1.5')
    expect(await shop.costRow(milk.id)).toMatchObject({ value: '198.5' })
    await shop.expectRebuildEqualsProjections()
  })
})

describe('free goods with delivery on the same invoice (D-114 rule 4)', () => {
  it('a draft that saves also posts: 20 lines at 100 % off the whole purchase, AED 1.50 delivery', async () => {
    const milk = await shop.material()
    const draft = await shop.draft(
      purchaseInput(
        today,
        [
          ...Array.from({ length: 20 }, () => line(milk.id, '1', '10')),
          { kind: 'delivery', id: newId(), description: 'Delivery', amount: '1.50', vatRate: '0' },
        ],
        { discount: { percent: '100' } },
      ),
    )
    expect(draft).toMatchObject({ status: 'draft', netTotal: '1.5', total: '1.5' })
    // Current code: line 1's delivery share is −0.02, so its goods "cost" −0.02; wacReceive refuses a
    // negative receipt value and the posting fails with INTERNAL, so this purchase can never post.
    const result = await shop.run<{ data: PurchaseDto }>('purchase.post', {
      id: draft.id,
      version: draft.version,
    })
    expect(codeOf(result), result.raw).toBeUndefined()
    const posted = ok(result).data
    expect(posted.costTotal).toBe('1.5')
    for (const l of posted.lines.filter((x) => x.kind === 'material')) {
      expect(compareDecimal(l.cost ?? '0', '0'), `line cost ${l.cost}`).toBeGreaterThanOrEqual(0)
    }
    await shop.expectRebuildEqualsProjections()
  })
})

describe('credit note amounts are document amounts (D-107: rounded to the currency)', () => {
  it('a credit of AED 10.005 is not booked with a fraction of a fils', async () => {
    const milk = await shop.material()
    const purchase = await shop.buy(purchaseInput(today, [line(milk.id, '10', '10')]))
    const created = await shop.run<{ data: PurchaseReturnDto }>(
      'purchaseReturn.create',
      documentInput(purchase, 'credit_note', [amountLine(purchase.lines[0]!.id, '10.005')]),
    )
    if (created.error) {
      // Refusing an amount finer than the currency's minor unit is a correct fix too.
      expect(codeOf(created)).toBe('validation')
      return
    }
    const draft = created.data!.data
    // Current code: stored and posted as 10.005 (AED has 2 decimals), and the goods' value falls by
    // 10.005; every later return of the line then carries sub-fils amounts on its document.
    expect(draft.netTotal).toMatch(/^\d+(\.\d{1,2})?$/)
    const posted = await shop.postReturn(draft)
    expect(posted.costTotal).toMatch(/^\d+(\.\d{1,2})?$/)
  })
})
