import type { PurchaseDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { codeOf, line, ok, purchaseInput, PurchasingApi, Scope, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// Security review of M2 Step 3 (redaction): a hidden value must not be derivable from what a member
// may see, errors included (ARCHITECTURE.md §Redaction: "Redaction covers lists, details, reports,
// exports, search, errors…"; "a hidden value cannot be derived from visible ones").
//
// A member who may manage purchase drafts but may not see supplier prices (a Manager with a deny
// override on data.supplier_price.view, or on data.cost.view, which hides supplier prices too by the
// grouping rule) must get the same answer from purchaseReturn.create whatever the hidden line amount
// is. EXCEEDS_PURCHASE answered "is X more than the line's hidden net?", so a binary search recovered
// the price paid to the supplier exactly; since D-142 writing a credit note needs supplier prices
// visible (FORBIDDEN before any amount is checked).

let api: PurchasingApi
let a: Scope
let today: string
let purchase: PurchaseDto
let blindToPrices: Person
let blindToCosts: Person

/** The hidden net of the purchase's only line: 10 L at 6.37. */
const HIDDEN_NET = '63.7'

beforeAll(async () => {
  api = new PurchasingApi()
  a = await Scope.open(api, WORKSHOP)
  today = await a.today()
  const milk = await a.material()
  purchase = await a.buy(purchaseInput(today, [line(milk.id, '10', '6.37')]))
  blindToPrices = await api.person()
  await addMember(api.db, a.owner.user, a.id, blindToPrices.user, {
    template: 'manager',
    overrides: [{ key: 'data.supplier_price.view', effect: 'deny' }],
  })
  blindToCosts = await api.person()
  await addMember(api.db, a.owner.user, a.id, blindToCosts.user, {
    template: 'manager',
    overrides: [{ key: 'data.cost.view', effect: 'deny' }],
  })
}, 60_000)

afterAll(async () => {
  await api.close()
})

function creditOf(amount: string) {
  return {
    id: newId(),
    purchaseId: purchase.id,
    kind: 'credit_note',
    businessDate: today,
    lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, amount }],
  }
}

function splitCreditOf(amount: string) {
  return {
    id: newId(),
    purchaseId: purchase.id,
    kind: 'credit_note',
    businessDate: today,
    lines: [],
    splitAmount: amount,
  }
}

/** The answer's app code, or 'ok'. */
async function answer(person: Person, input: object): Promise<string> {
  return codeOf(await a.as(person, 'purchaseReturn.create', input)) ?? 'ok'
}

/** Binary search for the largest credit accepted, in cents, as the member. */
async function recover(person: Person, make: (amount: string) => object): Promise<string> {
  let low = 1 // accepted
  let high = 1_000_000 // refused
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    const amount = `${Math.floor(mid / 100)}.${String(mid % 100).padStart(2, '0')}`
    if ((await answer(person, make(amount))) === 'ok') low = mid
    else high = mid
  }
  return `${Math.floor(low / 100)}.${String(low % 100).padStart(2, '0')}`.replace(/\.?0+$/, '')
}

describe('a member who may not see supplier prices cannot read them from credit-note refusals', () => {
  it('the member really may not see the line amount', async () => {
    for (const person of [blindToPrices, blindToCosts]) {
      const got = ok(
        await a.as<{ data: PurchaseDto; meta: { redacted: string[] } }>(person, 'purchase.get', {
          id: purchase.id,
        }),
      )
      expect(got.meta.redacted).toContain('lines.*.net')
      expect(got.data.lines[0]?.net).toBeUndefined()
      expect(JSON.stringify(got)).not.toContain(HIDDEN_NET)
    }
  })

  it('a credit note just under and just over the hidden net get the same answer', async () => {
    for (const person of [blindToPrices, blindToCosts]) {
      const under = await answer(person, creditOf('63.69'))
      const over = await answer(person, creditOf('63.71'))
      expect(
        under,
        `under: ${under}, over: ${over}: EXCEEDS_PURCHASE tells a member without ` +
          'data.supplier_price.view where the hidden price is',
      ).toBe(over)
    }
  })

  it('the same through a split credit note (splitAmount against the hidden net total)', async () => {
    const under = await answer(blindToPrices, splitCreditOf('63.69'))
    const over = await answer(blindToPrices, splitCreditOf('63.71'))
    expect(under).toBe(over)
  })

  it('a binary search over credit notes does not recover the hidden price', async () => {
    // About 20 calls; each accepted one leaves a draft credit note (discardable, never posted).
    const recovered = await recover(blindToPrices, creditOf)
    expect(recovered, `recovered the hidden net ${HIDDEN_NET} = 10 × 6.37`).not.toBe(HIDDEN_NET)
  })
})
