import type {
  MinePayableListDto,
  PayableListDto,
  PurchaseDto,
  PurchasePaymentsDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// "Money back from the supplier" on Purchases (M3 Step 5, Q18; D-162, D-181): it ships at once, so
// this runs on a released business without any preview. A purchase paid beyond what it came to after
// a return is overpaid; the money the supplier gives back (purchasePayment.record, kind refund)
// settles it, never more; when a member received it for the business, it counts against what the
// business owes that member (payable.list, payable.mine).

let api: PurchasingApi
let shop: Scope
let today: string
let member: Person & { memberId: string }

type Envelope<T> = { data: T; meta: { redacted: string[] } }

beforeAll(async () => {
  api = new PurchasingApi()
  shop = await Scope.open(api, WORKSHOP)
  today = await shop.today()
  member = await api.member(shop, 'admin')
}, 60_000)

afterAll(async () => {
  await api.close()
})

/** A tax invoice for 10 × 10 at 5 % VAT (105 in all), bought as `extra` says. */
async function bought(extra: object): Promise<PurchaseDto> {
  const milk = await shop.material()
  return shop.buy(
    purchaseInput(today, [line(milk.id, '10', '10', { vatRate: '5' })], {
      documentType: 'tax_invoice',
      ...extra,
    }),
  )
}

/** A purchase on credit paid in full, then one piece returned: 10.50 overpaid. */
async function overpaid(): Promise<PurchaseDto> {
  const supplier = await shop.supplier()
  const purchase = await bought({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })
  ok(await shop.run('purchasePayment.record', pay(purchase.id, '105')))
  await shop.postReturn(
    await shop.returnDraft({
      id: newId(),
      purchaseId: purchase.id,
      kind: 'return',
      businessDate: today,
      lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, qty: '1' }],
    }),
  )
  return purchase
}

function pay(purchaseId: string, amount: string, extra: object = {}) {
  return { id: newId(), purchaseId, businessDate: today, method: 'cash', amount, ...extra }
}

async function payments(purchaseId: string) {
  return ok(
    await shop.run<Envelope<PurchasePaymentsDto['data']>>('purchasePayment.list', { purchaseId }),
  ).data
}

describe('money back from the supplier', () => {
  it('settles what was paid beyond, never more, and its reversal brings it back', async () => {
    const purchase = await overpaid()
    expect(await payments(purchase.id)).toMatchObject({ overpaid: '10.5', moneyBack: '0' })
    // More than was overpaid, or on a purchase not overpaid: refused.
    expect(
      codeOf(
        await shop.run('purchasePayment.record', pay(purchase.id, '10.51', { kind: 'refund' })),
      ),
    ).toBe('exceeds_outstanding')
    const settled = await bought({
      supplierId: (await shop.supplier()).id,
      paymentMethod: 'supplier_credit',
    })
    expect(
      codeOf(await shop.run('purchasePayment.record', pay(settled.id, '1', { kind: 'refund' }))),
    ).toBe('exceeds_outstanding')
    // Who received it goes only with money back.
    expect(
      codeOf(
        await shop.run(
          'purchasePayment.record',
          pay(purchase.id, '1', { receivedByMemberId: member.memberId }),
        ),
      ),
    ).toBe('validation')

    const back = pay(purchase.id, '10.5', { kind: 'refund' })
    ok(await shop.run('purchasePayment.record', back))
    // A retry is answered as recorded.
    ok(await shop.run('purchasePayment.record', back))
    const after = await payments(purchase.id)
    expect(after).toMatchObject({
      total: '105',
      returned: '10.5',
      paid: '105',
      moneyBack: '10.5',
      outstanding: '0',
      overpaid: '0',
    })
    expect(after.payments.find((p) => p.id === back.id)).toMatchObject({
      kind: 'refund',
      amount: '10.5',
      receivedBy: null,
    })
    // Nothing more comes back.
    expect(
      codeOf(
        await shop.run('purchasePayment.record', pay(purchase.id, '0.01', { kind: 'refund' })),
      ),
    ).toBe('exceeds_outstanding')

    ok(await shop.run('purchasePayment.reverse', { id: back.id }))
    expect(await payments(purchase.id)).toMatchObject({ moneyBack: '0', overpaid: '10.5' })
  })

  it('received by a member, counts against what the business owes them', async () => {
    // The member paid a purchase from their own money: the business owes them 105.
    await bought({ paymentMethod: 'paid_by_member', paidByMemberId: member.memberId })
    // The supplier of an overpaid purchase gives 10.50 back, to the member.
    const purchase = await overpaid()
    // Only an active member of this business receives it.
    expect(
      codeOf(
        await shop.run(
          'purchasePayment.record',
          pay(purchase.id, '10.5', { kind: 'refund', receivedByMemberId: newId() }),
        ),
      ),
    ).toBe('not_found')
    const back = pay(purchase.id, '10.5', { kind: 'refund', receivedByMemberId: member.memberId })
    ok(await shop.run('purchasePayment.record', back))
    expect(
      (await payments(purchase.id)).payments.find((p) => p.id === back.id)?.receivedBy,
    ).toMatchObject({ memberId: member.memberId })

    const owed = ok(
      await shop.run<Envelope<PayableListDto['data']>>('payable.list', { party: 'member' }),
    ).data
    expect(owed.moneyBackTotal).toBe('10.5')
    expect(owed.groups.find((g) => g.partyId === member.memberId)).toMatchObject({
      outstanding: '105',
      moneyBack: '10.5',
      owedAfterMoneyBack: '94.5',
    })

    const mine = ok(await shop.as<MinePayableListDto>(member, 'payable.mine', {}))
    expect(mine).toMatchObject({
      outstanding: '105',
      moneyBack: '10.5',
      owedAfterMoneyBack: '94.5',
    })

    // Reversed, it no longer counts.
    ok(await shop.run('purchasePayment.reverse', { id: back.id }))
    const again = ok(await shop.as<MinePayableListDto>(member, 'payable.mine', {}))
    expect(again).toMatchObject({ moneyBack: '0', owedAfterMoneyBack: '105' })
  })
})
