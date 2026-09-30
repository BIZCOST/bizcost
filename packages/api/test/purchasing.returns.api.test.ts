import type { PurchaseDto, PurchaseReturnDto, PurchaseReturnListDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope } from './purchasing'
import { WORKSHOP } from './settings'

// Supplier returns and credit notes through the API (ROADMAP.md M2 Step 3; D-120): draft → post →
// reverse, linked to a posted purchase; a return takes goods out at the price paid for them and the
// average moves back; a full return right after its purchase restores the previous average exactly; a
// credit note lowers the value of the credited goods still on hand (all of them in M2: nothing uses
// stock yet); neither goes beyond what is left of the purchase line; a purchase is reversed only after
// its returns and credit notes are; the books-closed date applies to their own day. After each case,
// a rebuild of the ledger equals the projections. (Usage from Phase 3 — returns and credits after part
// of the stock was used — is covered in the domain engine's tests: wac.returns.test.ts.)

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

/** The owner's example: 50 L at 6, then 100 L at 7 of a new material. */
async function ownerExample(scope = shop) {
  const milk = await scope.material()
  const first = await scope.buy(purchaseInput(today, [line(milk.id, '50', '6')]))
  const second = await scope.buy(purchaseInput(today, [line(milk.id, '100', '7')]))
  return { milk, first, second, secondLine: second.lines[0]!.id }
}

function returnInput(purchase: PurchaseDto, lines: object[], extra: object = {}) {
  return {
    id: newId(),
    purchaseId: purchase.id,
    kind: 'return',
    businessDate: today,
    lines,
    ...extra,
  }
}

function creditInput(purchase: PurchaseDto, lines: object[], extra: object = {}) {
  return {
    id: newId(),
    purchaseId: purchase.id,
    kind: 'credit_note',
    businessDate: today,
    lines,
    ...extra,
  }
}

const qtyLine = (purchaseLineId: string, qty: string) => ({ id: newId(), purchaseLineId, qty })
const amountLine = (purchaseLineId: string, amount: string) => ({
  id: newId(),
  purchaseLineId,
  amount,
})

describe('supplier returns (D-120 rule 2)', () => {
  it('takes goods out at the price paid for them; the average moves back', async () => {
    const { milk, second, secondLine } = await ownerExample()
    const draft = await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '20')]))
    expect(draft).toMatchObject({ status: 'draft', kind: 'return', netTotal: '140', total: '140' })
    // A draft changes nothing.
    expect(await shop.costRow(milk.id)).toMatchObject({ qty: '150000', value: '1000' })
    const posted = await shop.postReturn(draft)
    expect(posted).toMatchObject({ status: 'posted', costTotal: '140' })
    expect(posted.lines[0]).toMatchObject({ qty: '20', baseQty: '20000', cost: '140' })
    expect(await shop.costRow(milk.id)).toEqual({
      qty: '130000',
      value: '860',
      avg_cost: '0.006615384615',
    })
    // The 90-day average counts the return against its purchase line (D-115, D-120 rule 4).
    expect((await shop.costs([milk.id]))[0]?.average).toMatchObject({ perUnit: '6.615384615385' })
    const purchase = ok(
      await shop.run<{ data: PurchaseDto }>('purchase.get', { id: second.id }),
    ).data
    expect(purchase.lines[0]?.returnedQty).toBe('20')
    expect(purchase.returns.map((r) => [r.id, r.kind, r.status])).toEqual([
      [draft.id, 'return', 'posted'],
    ])
    await shop.expectRebuildEqualsProjections()
  })

  it('a full return right after its purchase restores the previous average exactly', async () => {
    const { milk, second, secondLine } = await ownerExample()
    await shop.postReturn(await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '100')])))
    expect(await shop.costRow(milk.id)).toEqual({ qty: '50000', value: '300', avg_cost: '0.006' })
    const [cost] = await shop.costs([milk.id])
    expect(cost?.average?.perUnit).toBe('6')
    // The last purchase that still has goods is the first one.
    expect(cost?.lastPurchase?.pricePerUnit).toBe('6')
    await shop.expectRebuildEqualsProjections()
  })

  it('never more than was bought minus what was returned (at save and again at posting)', async () => {
    const { second, secondLine } = await ownerExample()
    expect(
      codeOf(
        await shop.run(
          'purchaseReturn.create',
          returnInput(second, [qtyLine(secondLine, '100.5')]),
        ),
      ),
    ).toBe('exceeds_purchase')
    const a = await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '60')]))
    const b = await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '60')]))
    await shop.postReturn(a)
    expect(codeOf(await shop.run('purchaseReturn.post', { id: b.id, version: b.version }))).toBe(
      'exceeds_purchase',
    )
    // 40 left: all of it goes.
    const rest = await shop.postReturn(
      await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '40')])),
    )
    expect(rest.lines[0]).toMatchObject({ baseQty: '40000', cost: '280' })
  })

  it('a purchase is reversed only after its returns; a reversed return is as if never posted', async () => {
    const { milk, second, secondLine } = await ownerExample()
    const posted = await shop.postReturn(
      await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '30')])),
    )
    expect(codeOf(await shop.run('purchase.reverse', { id: second.id }))).toBe(
      'purchase_has_returns',
    )
    const reversed = ok(
      await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.reverse', { id: posted.id }),
    ).data
    expect(reversed).toMatchObject({ status: 'reversed', reversalDate: today })
    expect(await shop.costRow(milk.id)).toEqual({
      qty: '150000',
      value: '1000',
      avg_cost: '0.006666666667',
    })
    // Reversing again changes nothing; then the purchase can go.
    expect(
      ok(await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.reverse', { id: posted.id }))
        .data.version,
    ).toBe(reversed.version)
    await shop.reverse(second.id)
    expect(await shop.costRow(milk.id)).toEqual({ qty: '50000', value: '300', avg_cost: '0.006' })
    await shop.expectRebuildEqualsProjections()
  })

  it('only for a posted purchase, only its own lines', async () => {
    const { milk, first, second } = await ownerExample()
    const draft = await shop.draft(purchaseInput(today, [line(milk.id, '1', '1')]))
    expect(
      codeOf(
        await shop.run(
          'purchaseReturn.create',
          returnInput(draft, [qtyLine(draft.lines[0]!.id, '1')]),
        ),
      ),
    ).toBe('document_not_posted')
    // A line of another purchase.
    expect(
      codeOf(
        await shop.run(
          'purchaseReturn.create',
          returnInput(second, [qtyLine(first.lines[0]!.id, '1')]),
        ),
      ),
    ).toBe('not_found')
    // A return takes quantities, a credit note amounts.
    expect(
      codeOf(
        await shop.run(
          'purchaseReturn.create',
          returnInput(second, [amountLine(second.lines[0]!.id, '1')]),
        ),
      ),
    ).toBe('validation')
    const reversed = await shop.buy(purchaseInput(today, [line(milk.id, '1', '1')]))
    await shop.reverse(reversed.id)
    expect(
      codeOf(
        await shop.run(
          'purchaseReturn.create',
          returnInput(reversed, [qtyLine(reversed.lines[0]!.id, '1')]),
        ),
      ),
    ).toBe('document_not_posted')
  })

  it('a draft is saved again with its own line ids; one line per purchase line; never before the purchase', async () => {
    const milk = await shop.material()
    const cream = await shop.material()
    const purchase = await shop.buy(
      purchaseInput(today, [line(milk.id, '10', '6'), line(cream.id, '10', '8')]),
    )
    const [milkLine, creamLine] = purchase.lines.map((l) => l.id)
    const first = qtyLine(milkLine!, '2')
    const draft = await shop.returnDraft(returnInput(purchase, [first]))
    // The same line id again, with another quantity, and a new line beside it.
    const second = qtyLine(creamLine!, '1')
    const saved = ok(
      await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.update', {
        id: draft.id,
        version: draft.version,
        businessDate: today,
        lines: [{ ...first, qty: '3' }, second],
      }),
    ).data
    expect(saved.lines.map((l) => [l.id, l.qty, l.net])).toEqual([
      [first.id, '3', '18'],
      [second.id, '1', '8'],
    ])
    // Taken out, then brought back by its id.
    const shorter = ok(
      await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.update', {
        id: draft.id,
        version: saved.version,
        businessDate: today,
        lines: [second],
      }),
    ).data
    expect(shorter.lines.map((l) => l.id)).toEqual([second.id])
    const back = ok(
      await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.update', {
        id: draft.id,
        version: shorter.version,
        businessDate: today,
        lines: [first, second],
      }),
    ).data
    expect(back.lines.map((l) => [l.id, l.qty])).toEqual([
      [first.id, '2'],
      [second.id, '1'],
    ])
    const posted = await shop.postReturn(back)
    expect(posted.lines.map((l) => l.baseQty)).toEqual(['2000', '1000'])

    // One line per purchase line.
    expect(
      codeOf(
        await shop.run(
          'purchaseReturn.create',
          returnInput(purchase, [qtyLine(milkLine!, '1'), qtyLine(milkLine!, '1')]),
        ),
      ),
    ).toBe('validation')
    // Never dated before its purchase.
    const yesterday = new Date(`${today}T00:00:00Z`)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    expect(
      codeOf(
        await shop.run('purchaseReturn.create', {
          ...returnInput(purchase, [qtyLine(milkLine!, '1')]),
          businessDate: yesterday.toISOString().slice(0, 10),
        }),
      ),
    ).toBe('validation')
    await shop.expectRebuildEqualsProjections()
  })

  it('is posted on its own day: it must be open, the purchase’s own day may be closed', async () => {
    const scope = await Scope.open(api, WORKSHOP)
    const milk = await scope.material()
    const yesterday = new Date(`${today}T00:00:00Z`)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const day = yesterday.toISOString().slice(0, 10)
    const purchase = await scope.buy(purchaseInput(day, [line(milk.id, '10', '5')]))
    ok(await scope.run('books.close', { closedThrough: day }))
    const lineId = purchase.lines[0]!.id
    const closed = await scope.returnDraft({
      ...returnInput(purchase, [qtyLine(lineId, '1')]),
      businessDate: day,
    })
    expect(
      codeOf(await scope.run('purchaseReturn.post', { id: closed.id, version: closed.version })),
    ).toBe('books_closed')
    const open = await scope.postReturn(
      await scope.returnDraft(returnInput(purchase, [qtyLine(lineId, '2')])),
    )
    expect(open.status).toBe('posted')
    expect(await scope.costRow(milk.id)).toMatchObject({ qty: '8000', value: '40' })
  })
})

describe('credit notes (D-120 rule 3)', () => {
  it('lower the value of the credited goods on hand: the average falls (nothing is used in M2)', async () => {
    const { milk, second, secondLine } = await ownerExample()
    const credit = await shop.postReturn(
      await shop.returnDraft(creditInput(second, [amountLine(secondLine, '100')])),
    )
    expect(credit).toMatchObject({ kind: 'credit_note', netTotal: '100', costTotal: '100' })
    expect(await shop.costRow(milk.id)).toEqual({ qty: '150000', value: '900', avg_cost: '0.006' })
    expect((await shop.costs([milk.id]))[0]).toMatchObject({
      average: { perUnit: '6' },
      lastPurchase: { purchaseId: second.id, pricePerUnit: '6' },
    })
    const purchase = ok(
      await shop.run<{ data: PurchaseDto }>('purchase.get', { id: second.id }),
    ).data
    expect(purchase.lines[0]?.creditedAmount).toBe('100')

    // Reversed: as if never posted.
    ok(await shop.run('purchaseReturn.reverse', { id: credit.id }))
    expect(await shop.costRow(milk.id)).toEqual({
      qty: '150000',
      value: '1000',
      avg_cost: '0.006666666667',
    })
    await shop.expectRebuildEqualsProjections()
  })

  it('after a partial return: on what is left of the line, never more', async () => {
    const { milk, second, secondLine } = await ownerExample()
    await shop.postReturn(await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '40')])))
    // 60 L left, worth 420.
    expect(
      codeOf(
        await shop.run(
          'purchaseReturn.create',
          creditInput(second, [amountLine(secondLine, '420.01')]),
        ),
      ),
    ).toBe('exceeds_purchase')
    await shop.postReturn(
      await shop.returnDraft(creditInput(second, [amountLine(secondLine, '120')])),
    )
    // (300 + 700 − 280 − 120) ÷ (50 + 60) L
    expect(await shop.costRow(milk.id)).toEqual({
      qty: '110000',
      value: '600',
      avg_cost: '0.005454545455',
    })
    // Then a return of all that is left takes the credited price: 300 back out.
    const rest = await shop.postReturn(
      await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '60')])),
    )
    expect(rest.lines[0]).toMatchObject({ net: '300', cost: '300' })
    expect(await shop.costRow(milk.id)).toEqual({ qty: '50000', value: '300', avg_cost: '0.006' })
    await shop.expectRebuildEqualsProjections()
  })

  it('then a return: goods go back at the credited price, on the document and in stock', async () => {
    const { milk, second, secondLine } = await ownerExample()
    await shop.postReturn(
      await shop.returnDraft(creditInput(second, [amountLine(secondLine, '100')])),
    )
    // 100 L now carry 600: half of them go back for 300.
    const half = await shop.postReturn(
      await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '50')])),
    )
    expect(half.lines[0]).toMatchObject({ net: '300', baseQty: '50000', cost: '300' })
    expect(await shop.costRow(milk.id)).toEqual({ qty: '100000', value: '600', avg_cost: '0.006' })
    await shop.expectRebuildEqualsProjections()
  })

  it('one amount split over the lines by what is left of their net (largest remainder)', async () => {
    const milk = await shop.material()
    const cream = await shop.material()
    const purchase = await shop.buy(
      purchaseInput(today, [line(milk.id, '30', '10'), line(cream.id, '10', '10')]),
    )
    const credit = await shop.postReturn(
      await shop.returnDraft(creditInput(purchase, [], { splitAmount: '40.01' })),
    )
    expect(credit.lines.map((l) => [l.materialId, l.amount])).toEqual([
      [milk.id, '30.01'],
      [cream.id, '10'],
    ])
    expect(credit).toMatchObject({ splitAmount: '40.01', netTotal: '40.01' })
    expect(await shop.costRow(milk.id)).toMatchObject({ value: '269.99' })
    expect(await shop.costRow(cream.id)).toMatchObject({ value: '90' })
    expect(
      codeOf(
        await shop.run('purchaseReturn.create', creditInput(purchase, [], { splitAmount: '400' })),
      ),
    ).toBe('exceeds_purchase')
    expect(
      codeOf(
        await shop.run('purchaseReturn.create', {
          ...returnInput(purchase, []),
          splitAmount: '1',
        }),
      ),
    ).toBe('validation')
  })

  it('carry the purchase’s VAT treatment: VAT that was part of the cost comes off with the credit', async () => {
    // A purchase drafted while the business was VAT-registered, posted after it no longer is (a
    // business that is not registered types what it paid, without VAT, since M2 Step 7).
    const baker = await Scope.open(api, WORKSHOP)
    const flour = await baker.material({ id: newId(), name: 'Flour', unit: 'kg', packs: [] })
    const draft = await baker.draft(
      purchaseInput(today, [line(flour.id, '10', '10', { unit: 'kg', vatRate: '5' })], {
        documentType: 'tax_invoice',
      }),
    )
    await baker.deregisterVat()
    const purchase = await baker.post(draft)
    expect(purchase).toMatchObject({ vatInCost: true, costTotal: '105' })
    const credit = await baker.postReturn(
      await baker.returnDraft(creditInput(purchase, [amountLine(purchase.lines[0]!.id, '20')])),
    )
    expect(credit).toMatchObject({ netTotal: '20', vatTotal: '1', total: '21', costTotal: '21' })
    expect(await baker.costRow(flour.id)).toMatchObject({ qty: '10000', value: '84' })
  })
})

describe('the list', () => {
  it('lists returns and credit notes by purchase, kind and status', async () => {
    const { second, secondLine } = await ownerExample()
    const ret = await shop.returnDraft(returnInput(second, [qtyLine(secondLine, '1')]))
    const credit = await shop.postReturn(
      await shop.returnDraft(creditInput(second, [amountLine(secondLine, '1')])),
    )
    const all = ok(
      await shop.run<PurchaseReturnListDto>('purchaseReturn.list', { purchaseId: second.id }),
    ).data.items
    expect(all.map((r) => r.id).sort()).toEqual([ret.id, credit.id].sort())
    const credits = ok(
      await shop.run<PurchaseReturnListDto>('purchaseReturn.list', {
        purchaseId: second.id,
        kind: 'credit_note',
        status: 'posted',
      }),
    ).data.items
    expect(credits.map((r) => [r.id, r.total])).toEqual([[credit.id, '1']])
    // A draft is discarded, never a posted one.
    ok(await shop.run('purchaseReturn.discard', { id: ret.id, version: ret.version }))
    expect(
      codeOf(await shop.run('purchaseReturn.discard', { id: credit.id, version: credit.version })),
    ).toBe('document_posted')
  })
})
