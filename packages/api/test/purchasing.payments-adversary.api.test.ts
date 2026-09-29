import type { PurchaseDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope } from './purchasing'
import { WORKSHOP } from './settings'

// Security + money adversary (review of the owner's requests of 2026-09-29, R3/R4), through the real
// fetch handler. "Paid personally by a member" must name an active member of this business: the API
// checks it when a draft is saved (assertPaidBy: NOT_FOUND), but posting reads the stored
// paid_by_member_id and never checks it again, and a correction copies it as it is. A draft saved
// while the member was active is posted after they left (the purchase page's Finalize posts a draft
// without opening the editor, whose payerLeft check is the only one), and the business then owes a
// member who is gone: it appears under "To employees" and can be paid.
//
// These tests fail until posting checks who paid as a save does.

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

type Envelope<T> = { data: T; meta: { redacted: string[] } }

async function leaves(memberId: string) {
  await api.admin`
    update app.business_members set status = 'removed'
     where business_id = ${shop.id} and id = ${memberId}`
}

describe('posting a purchase paid personally by a member who has left', () => {
  it('a draft saved while they were a member is not posted after they left', async () => {
    const leaver = await api.member(shop, 'manager')
    const milk = await shop.material()
    const draft = await shop.draft(
      purchaseInput(today, [line(milk.id, '2', '10')], {
        paymentMethod: 'paid_by_member',
        paidByMemberId: leaver.memberId,
      }),
    )
    await leaves(leaver.memberId)
    // Saving it again is refused, as it should be…
    expect(
      codeOf(
        await shop.run('purchase.update', {
          ...purchaseInput(today, [line(milk.id, '2', '10')], {
            paymentMethod: 'paid_by_member',
            paidByMemberId: leaver.memberId,
          }),
          id: draft.id,
          version: draft.version,
        }),
      ),
    ).toBe('not_found')
    // …but posting it as it is goes through.
    const posted = await shop.run<Envelope<PurchaseDto>>('purchase.post', {
      id: draft.id,
      version: draft.version,
    })
    expect(['not_found', 'validation'], `posted: ${posted.data?.data.status}`).toContain(
      codeOf(posted),
    )
    const after = ok(await shop.run<Envelope<PurchaseDto>>('purchase.get', { id: draft.id })).data
    expect(after.status).toBe('draft')
  })

  it('a correction does not open a copy that is posted to a member who has left', async () => {
    const leaver = await api.member(shop, 'manager')
    const milk = await shop.material()
    const purchase = await shop.buy(
      purchaseInput(today, [line(milk.id, '1', '7')], {
        paymentMethod: 'paid_by_member',
        paidByMemberId: leaver.memberId,
      }),
    )
    await leaves(leaver.memberId)
    const copyId = newId()
    const copy = ok(
      await shop.run<Envelope<PurchaseDto>>('purchase.correct', { id: purchase.id, newId: copyId }),
    ).data
    expect(copy.paidByMemberId).toBe(leaver.memberId)
    const posted = await shop.run<Envelope<PurchaseDto>>('purchase.post', {
      id: copyId,
      version: copy.version,
    })
    expect(['not_found', 'validation'], `posted: ${posted.data?.data.status}`).toContain(
      codeOf(posted),
    )
  })
})
