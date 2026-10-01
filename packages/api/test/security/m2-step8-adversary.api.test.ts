import type { PurchaseDto, RunningCostDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from '../expenses'
import { addMember } from '../helpers'
import { codeOf, line, ok, purchaseInput, type Person } from '../purchasing'
import { WORKSHOP } from '../settings'

// ADVERSARY (M2 Step 8, fresh eyes over all of M2). Failing tests for real issues, kept as regression
// tests once fixed. The attacker is the member D-200 and the redaction oracle name: a Manager with the
// costs switch off (a deny override on data.cost.view, so withNeededKeys also takes supplier prices
// and margins away). They still enter, post and reverse purchases and change running costs.

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let attacker: Person

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  attacker = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, attacker.user, {
    template: 'manager',
    overrides: [{ key: 'data.cost.view', effect: 'deny' }],
  })
}, 60_000)

afterAll(async () => {
  await api.close()
})

describe('posting a purchase is no oracle for a hidden stock value (ARCHITECTURE §Redaction)', () => {
  // A material's stock value was numeric(28,12) (material_costs.value): the database refused the
  // posting (22003, answered INTERNAL) when the stock value + the receipt's value reached 10^16. A
  // purchase line may cost up to numeric(20,4) (just under 10^16 too), so a
  // member who may not see costs chooses its price P: the posting fails exactly when the material's
  // hidden stock value is more than 10^16 − P. Posting and reversing (both theirs) a binary search of
  // P (about 60 tries, each successful probe reversed: a reversal right after its receipt restores the
  // state exactly) gives the stock value to 0.0001; the stock quantity is Σ the visible baseQty of the
  // purchase lines less returns, so value ÷ quantity is the hidden average (`cost`) and, read before
  // and after a purchase, that purchase's hidden price (D-144). The same purchase must get the same
  // answer whatever the hidden value.
  it('the same purchase gets the same answer for two materials whose only difference is hidden', async () => {
    const context = ok(await shop.as<{ visibleCategories: string[] }>(attacker, 'business.context'))
    expect(context.visibleCategories).toEqual([]) // the premise: no costs, no supplier prices
    const cheaper = await shop.material()
    const dearer = await shop.material()
    // Everything the attacker sees is the same: 10 L each, no supplier, no-invoice, cash, today.
    await shop.buy(purchaseInput(today, [line(cheaper.id, '10', '7.25')])) // stock value 72.50
    await shop.buy(purchaseInput(today, [line(dearer.id, '10', '7.26')])) // stock value 72.60

    // 72.50 + P fits numeric(28,12); 72.60 + P does not.
    const probePrice = '9999999999999927.45'
    const probe = async (materialId: string) => {
      const draft = ok(
        await shop.as<Envelope<PurchaseDto>>(
          attacker,
          'purchase.create',
          purchaseInput(today, [line(materialId, '1', probePrice)]),
        ),
      ).data
      return shop.as<Envelope<PurchaseDto>>(attacker, 'purchase.post', {
        id: draft.id,
        version: draft.version,
      })
    }
    const onCheaper = await probe(cheaper.id)
    const onDearer = await probe(dearer.id)
    // Before D-209: 'ok' on the cheaper one, 'internal' on the dearer one: the answer told them apart.
    expect({ dearer: codeOf(onDearer) ?? 'ok' }).toEqual({ dearer: codeOf(onCheaper) ?? 'ok' })
  })
})

describe('saving a recipe is no oracle for a material’s hidden average (D-178, ARCHITECTURE §Redaction)', () => {
  // recipe.save refuses a changed yield when one unit's cost does not fit a cost amount (VALIDATION
  // "yieldQty: too small for what this recipe costs", D-178). One unit's cost is Σ base quantity ×
  // the materials' hidden averages ÷ the yield, and the quantities and the yield are the caller's to
  // choose (numeric(24,6) each), so the refusal says whether average ≥ 10^16 × yield ÷ quantity. A
  // member who may manage recipes but not see costs (the Manager template with the costs switch off;
  // products.recipes.manage needs only products.recipes.view) binary-searches the quantity in a few
  // dozen saves on a product of their own and reads every material's average to 12 digits. The same
  // save must get the same answer whatever the hidden average.
  it('the same recipe gets the same answer for two materials whose only difference is hidden', async () => {
    const cheaper = await shop.material()
    const dearer = await shop.material()
    await shop.buy(purchaseInput(today, [line(cheaper.id, '10', '7.25')])) // 0.00725 per ml
    await shop.buy(purchaseInput(today, [line(dearer.id, '10', '7.26')])) // 0.00726 per ml
    // 1 378 000 000 L ÷ a yield of 0.000001: 9.9905e15 at the cheaper average (fits), 1.000428e16 at
    // the dearer one (does not).
    const save = async (materialId: string) => {
      const product = ok(
        await shop.as<{ id: string }>(attacker, 'product.create', {
          id: newId(),
          name: `Probe ${newId().slice(-8)}`,
          type: 'product',
          unit: 'piece',
        }),
      )
      return shop.as(attacker, 'recipe.save', {
        productId: product.id,
        version: 0,
        yieldQty: '0.000001',
        lines: [{ id: newId(), materialId, qty: '1378000000', unit: 'l' }],
      })
    }
    const onCheaper = await save(cheaper.id)
    const onDearer = await save(dearer.id)
    // Before D-209: 'ok' with the cheaper material, 'validation' with the dearer one.
    expect({ dearer: codeOf(onDearer) ?? 'ok' }).toEqual({ dearer: codeOf(onCheaper) ?? 'ok' })
  })
})

describe('a member who may not see costs never overwrites or removes a running cost (D-200)', () => {
  // D-200 ("changing what one cannot see"): a member who may not see supplier prices changes only the
  // purchase and expense drafts they entered, since a whole save replaces amounts they never read and a
  // discard takes out what they cannot check. A running cost's amounts are `cost` (D-165), and
  // runningCost.update is a whole save of them, yet any holder of running_costs.items.manage (the
  // Manager template, which keeps it with the costs switch off: PERMISSION_NEEDS asks only
  // running_costs.items.view) replaces or removes the owner's rent or salaries blind. productCost.
  // updateSettings and product.ownerMinutes already refuse a member who cannot see what they write.
  let rent: RunningCostDto

  beforeAll(async () => {
    const category = await shop.category()
    rent = await shop.runningCost({
      id: newId(),
      name: 'Rent',
      categoryId: category.id,
      amount: '12000',
      frequency: 'monthly',
      startsOn: today,
    })
  })

  it('the member reads the running cost without its amount (the premise)', async () => {
    const seen = ok(
      await shop.as<Envelope<RunningCostDto>>(attacker, 'runningCost.get', { id: rent.id }),
    )
    expect(seen.meta.redacted).toEqual(expect.arrayContaining(['amount', 'monthlyAmount']))
    expect(seen.data.amount).toBeUndefined()
  })

  it('runningCost.update of the owner’s running cost is FORBIDDEN, and nothing changes', async () => {
    const result = await shop.as<Envelope<RunningCostDto>>(attacker, 'runningCost.update', {
      id: rent.id,
      version: rent.version,
      name: rent.name,
      categoryId: rent.categoryId,
      amount: '1',
      frequency: rent.frequency,
      startsOn: rent.startsOn,
      endsOn: rent.endsOn,
      notes: rent.notes,
    })
    expect(codeOf(result)).toBe('forbidden')
    const after = ok(await shop.run<Envelope<RunningCostDto>>('runningCost.get', { id: rent.id }))
    expect(after.data.amount).toBe('12000')
  })

  it('runningCost.remove of the owner’s running cost is FORBIDDEN, and it stays', async () => {
    const current = ok(
      await shop.run<Envelope<RunningCostDto>>('runningCost.get', { id: rent.id }),
    ).data
    const result = await shop.as(attacker, 'runningCost.remove', {
      id: rent.id,
      version: current.version,
    })
    expect(codeOf(result)).toBe('forbidden')
    ok(await shop.run<Envelope<RunningCostDto>>('runningCost.get', { id: rent.id }))
  })
})
