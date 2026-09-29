import { isUuid, STANDARD_UNITS } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { demoId } from './costing'
import type { DemoCosting, DemoMaterial, DemoProduct } from './costing-data'
import { DEMO_PERSONAS } from './personas'

// The demo's Costing Core data (demo/costing-data.ts) holds together before it reaches the API: every
// reference names a record of the same business, units are the material's, documents follow what
// they refer to, and purchases go back far enough for the 3-month running-cost rate (D-116) and come
// up close enough to today that the month in progress is not short of them once it counts.

/** Days back of the oldest purchase so that 3 full months have passed after its month, any day. */
const OLDEST_PURCHASE_DAYS = 124
/** Days back of the latest purchase at most (a business buys again in its last week). */
const LATEST_PURCHASE_DAYS = 7

function materialsOf(data: DemoCosting): Map<string, Pick<DemoMaterial, 'packs'>> {
  const materials = new Map<string, Pick<DemoMaterial, 'packs'>>()
  for (const m of data.materials ?? []) materials.set(m.key, m)
  for (const p of data.products ?? []) if (p.resale) materials.set(p.resale.key, p.resale)
  return materials
}

function unique(keys: readonly string[]): boolean {
  return new Set(keys).size === keys.length
}

describe('demoId', () => {
  it('is a stable UUID for a business and a key', () => {
    const id = demoId('01a0e033-b29b-70e6-81a9-aec7fde1e699', 'purchase:r1')
    expect(isUuid(id)).toBe(true)
    expect(demoId('01a0e033-b29b-70e6-81a9-aec7fde1e699', 'purchase:r1')).toBe(id)
    expect(demoId('01a0e033-b29b-70e6-81a9-aec7fde1e699', 'purchase:r2')).not.toBe(id)
    expect(demoId('01a0e033-b11f-7310-85aa-904322b2a1c9', 'purchase:r1')).not.toBe(id)
  })
})

describe.each(DEMO_PERSONAS.filter((p) => p.costing).map((p) => [p.title, p] as const))(
  'demo costing data: %s',
  (_title, persona) => {
    const data = persona.costing!
    const materials = materialsOf(data)
    const purchases = new Map((data.purchases ?? []).map((p) => [p.key, p]))
    const expenses = new Map((data.expenses ?? []).map((e) => [e.key, e]))
    const products = new Map<string, DemoProduct>((data.products ?? []).map((p) => [p.key, p]))
    const suppliers = new Set((data.suppliers ?? []).map((s) => s.key))
    const joined = new Set((persona.team ?? []).filter((m) => m.joined).map((m) => m.email))

    const checkUnit = (material: string, unit: string) => {
      expect(materials.has(material), material).toBe(true)
      if (unit in STANDARD_UNITS) return
      expect(
        materials.get(material)?.packs?.map((p) => p.key),
        `${material} ${unit}`,
      ).toContain(unit)
    }

    it('has unique keys of each kind', () => {
      expect(unique([...materials.keys()])).toBe(true)
      for (const list of [
        data.suppliers,
        data.products,
        data.purchases,
        data.returns,
        data.payments,
        data.runningCosts,
        data.expenses,
      ]) {
        expect(unique((list ?? []).map((x) => x.key))).toBe(true)
      }
      for (const m of [
        ...(data.materials ?? []),
        ...(data.products ?? []).flatMap((p) => p.resale ?? []),
      ]) {
        const packs = m.packs ?? []
        expect(unique(packs.map((p) => p.key))).toBe(true)
        for (const p of packs)
          expect(p.of in STANDARD_UNITS || packs.some((q) => q.key === p.of)).toBe(true)
      }
    })

    it('uses only materials, packs and products it defines', () => {
      for (const r of data.recipes ?? []) {
        expect(products.get(r.product)?.resale, r.product).toBeUndefined()
        expect(unique(r.lines.map(([material]) => material))).toBe(true)
        for (const [material, , unit] of r.lines) checkUnit(material, unit)
      }
      for (const p of data.purchases ?? []) {
        if (p.supplier) expect(suppliers.has(p.supplier), p.supplier).toBe(true)
        expect(unique(p.lines.map(([material]) => material))).toBe(true)
        for (const [material, , unit] of p.lines) checkUnit(material, unit)
      }
      for (const e of data.expenses ?? []) {
        if (e.supplier) expect(suppliers.has(e.supplier), e.supplier).toBe(true)
      }
    })

    it('dates documents in the past, after what they follow', () => {
      const days = (data.purchases ?? []).map((p) => p.daysAgo)
      if (days.length > 0) {
        expect(Math.max(...days)).toBeGreaterThanOrEqual(OLDEST_PURCHASE_DAYS)
        expect(Math.min(...days)).toBeLessThanOrEqual(LATEST_PURCHASE_DAYS)
      }
      for (const d of [...days, ...(data.expenses ?? []).map((e) => e.daysAgo)]) {
        expect(d).toBeGreaterThanOrEqual(0)
      }
      for (const r of data.returns ?? []) {
        const purchase = purchases.get(r.purchase)
        expect(purchase, r.key).toBeDefined()
        expect(r.daysAgo).toBeLessThanOrEqual(purchase!.daysAgo)
        for (const [material] of r.lines) {
          expect(
            purchase!.lines.some(([m]) => m === material),
            `${r.key} ${material}`,
          ).toBe(true)
        }
      }
      for (const pay of data.payments ?? []) {
        const document = pay.purchase
          ? purchases.get(pay.purchase)
          : expenses.get(pay.expense ?? '')
        expect(document, pay.key).toBeDefined()
        expect(pay.daysAgo).toBeLessThanOrEqual(document!.daysAgo)
        expect(pay.daysAgo).toBeGreaterThanOrEqual(0)
        // Only what was bought on credit or paid by a member is owed.
        expect(['supplier_credit', 'paid_by_member']).toContain(document!.payment)
      }
    })

    it('names only members who joined, and only with a team', () => {
      for (const e of data.expenses ?? []) {
        const approver = typeof e.approval === 'object' ? e.approval.by : undefined
        for (const email of [e.paidBy, e.enteredBy, approver]) {
          if (email) expect(joined.has(email), email).toBe(true)
        }
        expect(e.payment === 'paid_by_member').toBe(e.paidBy !== undefined)
        // Sent for approval by a member who entered it: approval needs a team (D-164).
        if (e.approval) expect(e.enteredBy, e.key).toBeDefined()
      }
      // The owner's time counts only without a team (D-119).
      const timed =
        data.ownerHourlyRate !== undefined || [...products.values()].some((p) => p.ownerMinutes)
      if (timed) expect(persona.answers.team).toBe('alone')
    })
  },
)
