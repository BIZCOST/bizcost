import type { PurchaseDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { line, purchaseInput, PurchasingApi, Scope } from './purchasing'
import { WORKSHOP } from './settings'

// Ledger and costing adversary (M2 Step 8). Each test states what the M2 definition of done promises,
// with the input that breaks it.

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

/** A return of everything each line of `purchase` brought in, posted. */
async function returnAll(purchase: PurchaseDto) {
  await shop.postReturn(
    await shop.returnDraft({
      id: newId(),
      purchaseId: purchase.id,
      kind: 'return',
      businessDate: today,
      lines: purchase.lines.map((l) => ({ id: newId(), purchaseLineId: l.id, qty: l.qty })),
    }),
  )
}

describe('a full return right after its purchase restores the previous average exactly (D-120)', () => {
  // The M2 definition of done: "a full return right after its purchase restores the previous average
  // exactly". The WAC engine restores the state from before a receipt only for a receipt with nothing
  // posted since it (wac.ts: `untouched`). A purchase with two lines of the same material brings two
  // receipts: the second touches the first, so a return of the whole purchase works the average out
  // as (value − returned) ÷ (qty − returned), and when that leaves nothing on hand "the average stays":
  // the cost row keeps the second line's cost per ml (AED 8 for 5 L = 0.008), as if the goods sent back
  // were still the material's price. The same goods on one line come back to no average at all.
  it('one line: before the purchase there was no average, and after the full return there is none', async () => {
    const milk = await shop.material()
    await returnAll(await shop.buy(purchaseInput(today, [line(milk.id, '15', '6.6')])))
    expect(await shop.costRow(milk.id)).toEqual({ qty: '0', value: '0', avg_cost: null })
    await shop.expectRebuildEqualsProjections()
  })

  it('two lines of the same material (10 L at AED 6 and 5 L at AED 8): the same', async () => {
    const milk = await shop.material()
    await returnAll(
      await shop.buy(purchaseInput(today, [line(milk.id, '10', '6'), line(milk.id, '5', '8')])),
    )
    expect(await shop.costRow(milk.id)).toEqual({ qty: '0', value: '0', avg_cost: null })
    await shop.expectRebuildEqualsProjections()
  })
})
