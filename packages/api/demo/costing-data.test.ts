import { isUuid, STANDARD_UNITS, STARTER_SALES_CHANNELS } from '@bizcost/domain'
import { starterSalesChannels } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import { demoId } from './costing'
import type { DemoCategory, DemoCosting, DemoMaterial, DemoProduct, DemoSale } from './costing-data'
import {
  addDays,
  dayOf,
  daysBetween,
  lastMonth,
  lastMonthOf,
  monthStart,
  type DemoDay,
} from './days'
import { beforeVatFils, filsOf, importDays, percentOf, readSalesFile, salesFile } from './files'
import { DEMO_PERSONAS } from './personas'

// The demo's data (demo/costing-data.ts) holds together before it reaches the API: every reference
// names a record of the same business, units are the material's, documents follow what they refer
// to on any day the seed runs, purchases go back further than the 90-day average (D-115) and come up
// close enough to today that the average has recent prices, and every sales file reads the way the
// import screen reads it.

/** Days back of the oldest purchase at least: older than the 90 days the average covers (D-115). */
const OLDEST_PURCHASE_DAYS = 91
/** Days back of the latest purchase at most (a business buys again in its last week). */
const LATEST_PURCHASE_DAYS = 7

/**
 * Seed days the data must hold on: a month's 1st (after a short month), its last day, a 2nd, a
 * mid-month day, and the end of a 31-day month after a 30-day one.
 */
const SEED_DAYS = ['2026-03-01', '2026-03-31', '2026-01-02', '2026-10-16', '2026-08-31']

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

describe('the demo days', () => {
  it('counts back from the seed day, last month on its own days, never after the seed day', () => {
    expect(dayOf(0, '2026-03-01')).toBe('2026-03-01')
    expect(dayOf(3, '2026-03-01')).toBe('2026-02-26')
    expect(lastMonthOf('2026-03-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    // A later day of a shorter month is its last day; `plus` moves it, never past the seed day.
    expect(dayOf(lastMonth(31), '2026-03-15')).toBe('2026-02-28')
    expect(dayOf(lastMonth(4, -3), '2026-10-16')).toBe('2026-09-01')
    expect(dayOf(lastMonth(1, -10), '2026-10-16')).toBe('2026-08-22')
    expect(dayOf(lastMonth(28, 5), '2026-10-01')).toBe('2026-10-01')
    expect(monthStart('2026-01-02', -1)).toBe('2025-12-01')
    expect(daysBetween('2026-02-27', addDays('2026-02-27', 3))).toBe(3)
  })
})

describe('the sales files', () => {
  it('works out amounts in fils: before VAT, a percentage', () => {
    expect(beforeVatFils(filsOf('18'))).toBe(1714n)
    expect(beforeVatFils(filsOf('21.00'))).toBe(2000n)
    expect(percentOf(filsOf('100'), '17')).toBe(1700n)
    expect(percentOf(filsOf('10.01'), '2.5')).toBe(25n)
  })

  it('covers last month whole, and this month up to the day before the seed day', () => {
    expect(importDays({ month: 'last' }, '2026-03-01')).toHaveLength(28)
    expect(importDays({ month: 'this' }, '2026-03-01')).toEqual([])
    expect(importDays({ month: 'this' }, '2026-03-03')).toEqual(['2026-03-01', '2026-03-02'])
  })
})

/** The day `when` stands for on `today`. */
const on = (when: DemoDay, today: string) => dayOf(when, today)

/** A sale's day on `today`: a sheet of several days on its last day (null: none that month). */
function saleDayOf(sale: DemoSale, today: string): string | null {
  if (sale.covers === 'month_before') return addDays(monthStart(today, -1), -1)
  if (sale.covers === 'last_month') return lastMonthOf(today).to
  if (sale.covers === 'this_month') {
    const yesterday = addDays(today, -1)
    return yesterday < monthStart(today, 0) ? null : yesterday
  }
  return on(sale.daysAgo, today)
}

describe.each(DEMO_PERSONAS.filter((p) => p.costing).map((p) => [p.title, p] as const))(
  'demo data: %s',
  (_title, persona) => {
    const data = persona.costing!
    const materials = materialsOf(data)
    const purchases = new Map((data.purchases ?? []).map((p) => [p.key, p]))
    const expenses = new Map((data.expenses ?? []).map((e) => [e.key, e]))
    const products = new Map<string, DemoProduct>((data.products ?? []).map((p) => [p.key, p]))
    const suppliers = new Set((data.suppliers ?? []).map((s) => s.key))
    const customers = new Set((data.customers ?? []).map((c) => c.key))
    const joined = new Set((persona.team ?? []).filter((m) => m.joined).map((m) => m.email))
    const added = new Set((data.channels ?? []).map((c) => c.key))
    // The starter channels of its Smart Setup answers, by kind ("Direct" when it named none).
    const starters = new Set(
      starterSalesChannels(persona.answers).map(
        (key) => STARTER_SALES_CHANNELS.find((c) => c.key === key)!.kind as string,
      ),
    )
    const channelOk = (key: string) => added.has(key) || starters.has(key)

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
        data.channels,
        data.sales,
        data.imports,
        data.statements,
        data.customers,
        data.orders,
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
      for (const document of [...(data.sales ?? []), ...(data.orders ?? [])]) {
        expect(unique((document.payments ?? []).map((p) => p.key)), document.key).toBe(true)
        expect(unique(document.lines.map(([product]) => product)), document.key).toBe(true)
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
        if (p.branch) expect(persona.branches ?? [], p.key).toContain(p.branch)
        expect(unique(p.lines.map(([material]) => material))).toBe(true)
        for (const [material, , unit] of p.lines) checkUnit(material, unit)
      }
      for (const e of data.expenses ?? []) {
        if (e.supplier) expect(suppliers.has(e.supplier), e.supplier).toBe(true)
      }
      for (const document of [...(data.sales ?? []), ...(data.orders ?? [])]) {
        expect(document.lines.length, document.key).toBeGreaterThan(0)
        for (const [product] of document.lines) expect(products.has(product), product).toBe(true)
      }
    })

    it('says what an expense pays exactly when its category has a running cost (D-216)', () => {
      // The owner finalizes each one saying it: the bill of one of its category's running costs, or
      // an extra on top of them; an expense in a category without running costs says nothing.
      const sameCategory = (a: DemoCategory, b: DemoCategory) =>
        typeof a === 'string' ? a === b : typeof b !== 'string' && a.name === b.name
      for (const e of data.expenses ?? []) {
        const running = (data.runningCosts ?? []).filter((r) =>
          sameCategory(r.category, e.category),
        )
        // A channel's app fees (M3 Step 3, Q8) fit any category: a channel it adds or starts with.
        if (typeof e.pays === 'object' && 'channelFees' in e.pays) {
          expect(channelOk(e.pays.channelFees), e.key).toBe(true)
          continue
        }
        if (running.length === 0) expect(e.pays, e.key).toBeUndefined()
        else expect(e.pays, e.key).toBeDefined()
        if (e.pays !== undefined && e.pays !== 'extra') {
          expect(
            running.map((r) => r.key),
            e.key,
          ).toContain(e.pays.runningCost)
        }
        if (e.monthsBack !== undefined) {
          expect(e.monthsBack, e.key).toBeGreaterThanOrEqual(0)
          expect(e.monthsBack, e.key).toBeLessThanOrEqual(12)
        }
      }
    })

    it.each(SEED_DAYS)(
      'dates documents in the past, after what they follow (seeded on %s)',
      (today) => {
        const days = (data.purchases ?? []).map((p) => daysBetween(on(p.daysAgo, today), today))
        if (days.length > 0) {
          expect(Math.max(...days)).toBeGreaterThanOrEqual(OLDEST_PURCHASE_DAYS)
          expect(Math.min(...days)).toBeLessThanOrEqual(LATEST_PURCHASE_DAYS)
        }
        for (const d of [...(data.purchases ?? []), ...(data.expenses ?? [])]) {
          expect(on(d.daysAgo, today) <= today, d.key).toBe(true)
        }
        for (const r of data.returns ?? []) {
          const purchase = purchases.get(r.purchase)
          expect(purchase, r.key).toBeDefined()
          expect(on(r.daysAgo, today) >= on(purchase!.daysAgo, today), r.key).toBe(true)
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
          expect(on(pay.daysAgo, today) >= on(document!.daysAgo, today), pay.key).toBe(true)
          // Only what was bought on credit or paid by a member is owed.
          expect(['supplier_credit', 'paid_by_member']).toContain(document!.payment)
        }
        // What is sold is priced: each recipe material and item bought ready to sell was bought by
        // the day of the first sale (the month before last's first day, at the latest).
        const firstSale = monthStart(today, -2)
        const bought = new Set(
          (data.purchases ?? [])
            .filter((p) => on(p.daysAgo, today) <= firstSale)
            .flatMap((p) => p.lines.map(([material]) => material)),
        )
        const sold = new Set([
          ...(data.recipes ?? []).flatMap((r) => r.lines.map(([material]) => material)),
          ...(data.products ?? []).flatMap((p) => (p.resale ? [p.resale.key] : [])),
        ])
        for (const material of sold) expect(bought.has(material), material).toBe(true)
        // Orders: delivered or cancelled on or after the day they were entered, then paid, then
        // refunded; sales paid on or after their day.
        for (const o of data.orders ?? []) {
          const entered = on(o.daysAgo, today)
          for (const step of [o.deliveredDaysAgo, o.cancelledDaysAgo]) {
            if (step !== undefined) expect(on(step, today) >= entered, o.key).toBe(true)
          }
          const done = o.deliveredDaysAgo ?? o.cancelledDaysAgo
          for (const pay of o.payments ?? []) {
            expect(on(pay.daysAgo, today) >= entered, `${o.key} ${pay.key}`).toBe(true)
            if (done !== undefined) {
              expect(on(pay.daysAgo, today) >= on(done, today), `${o.key} ${pay.key}`).toBe(true)
            }
          }
          if (o.refund) {
            expect(on(o.refund.daysAgo, today) >= on(o.deliveredDaysAgo!, today), o.key).toBe(true)
          }
        }
        for (const sale of data.sales ?? []) {
          const day = saleDayOf(sale, today)
          if (day === null) continue
          expect(day <= today, sale.key).toBe(true)
          for (const pay of sale.payments ?? []) {
            expect(on(pay.daysAgo, today) >= day, `${sale.key} ${pay.key}`).toBe(true)
          }
        }
      },
    )

    it('sells in channels it has, as each way of selling allows (M3 Steps 2 and 5)', () => {
      for (const sale of data.sales ?? []) {
        if (sale.channel) expect(channelOk(sale.channel), sale.key).toBe(true)
        // A sheet of several days is Today's sales, dated by what it covers; delivery, a customer
        // and paying later go with One sale.
        if (sale.covers) {
          expect(sale.source, sale.key).toBe('day_sheet')
          expect(sale.daysAgo, sale.key).toBe(0)
        }
        if (sale.delivery || sale.customer || sale.payLater) {
          expect(sale.source, sale.key).toBe('single')
        }
        if (sale.customer) expect(customers.has(sale.customer), sale.key).toBe(true)
        // Paid later needs its customer; payments come only on a sale paid later.
        if (sale.payLater) expect(sale.customer, sale.key).toBeDefined()
        if (sale.payments?.length) expect(sale.payLater, sale.key).toBe(true)
        if (sale.branch) expect(persona.branches ?? [], sale.key).toContain(sale.branch)
      }
    })

    it.each(SEED_DAYS)(
      'reads every sales file cleanly, as the import screen does (seeded on %s)',
      (today) => {
        const vatRegistered = persona.answers.vat === 'yes'
        for (const imp of data.imports ?? []) {
          expect(channelOk(imp.channel), imp.key).toBe(true)
          if (imp.branch) expect(persona.branches ?? [], imp.key).toContain(imp.branch)
          if (imp.enteredBy) expect(joined.has(imp.enteredBy), imp.enteredBy).toBe(true)
          // Tips are a POS's; a fee column a marketplace's; codes those of the layouts with codes.
          if (imp.tips) expect(imp.layout, imp.key).toBe('pos')
          expect(imp.feePercent !== undefined, imp.key).toBe(imp.layout === 'marketplace')
          const coded = imp.layout === 'marketplace' || imp.layout === 'pos_codes'
          for (const item of imp.items) {
            expect(products.has(item.product), `${imp.key} ${item.product}`).toBe(true)
            expect(item.code !== undefined, `${imp.key} ${item.product}`).toBe(coded)
            expect(item.perDay, `${imp.key} ${item.product}`).toBeGreaterThan(0)
          }
          // Each name (or code) answers one product.
          const names = imp.items.map((i) =>
            coded ? i.code! : (i.name ?? products.get(i.product)!.name),
          )
          expect(unique(names), imp.key).toBe(true)
          const file = salesFile(imp, products, today)
          if (imp.month === 'this' && today.endsWith('-01')) {
            expect(file, imp.key).toBeNull()
            continue
          }
          expect(file, imp.key).not.toBeNull()
          const { read } = readSalesFile(file!, vatRegistered)
          expect(
            { problem: read.problem, leftOut: read.rowsLeftOut, total: read.totalRows },
            imp.key,
          ).toEqual({ problem: null, leftOut: 0, total: 0 })
          expect(read.shape, imp.key).toBe('lines')
          expect(read.period?.from, imp.key).toBe(importDays(imp, today)[0])
          // A VAT-registered business's amounts are before VAT or include it as asked; the fee column
          // is the app's statement.
          expect(read.fees !== null, imp.key).toBe(imp.feePercent !== undefined)
          expect(read.amountsIncludeVat, imp.key).toBe(vatRegistered && imp.layout !== 'pos')
        }
        // Files of one channel and branch never cover the same day twice.
        const covered = new Set<string>()
        for (const imp of data.imports ?? []) {
          for (const day of importDays(imp, today)) {
            const key = `${imp.channel} ${imp.branch ?? ''} ${day}`
            expect(covered.has(key), key).toBe(false)
            covered.add(key)
          }
        }
        // Today's sales and One sale stay off the days a file covers for their channel and branch.
        for (const sale of data.sales ?? []) {
          const day = saleDayOf(sale, today)
          if (day === null) continue
          const key = `${sale.channel ?? ''} ${sale.branch ?? ''} ${day}`
          expect(covered.has(key), `${sale.key}: ${key}`).toBe(false)
        }
      },
    )

    it('finalizes app statements of last month for a channel it imports', () => {
      for (const s of data.statements ?? []) {
        expect(added.has(s.channel), s.key).toBe(true)
        expect(
          (data.imports ?? []).some((i) => i.channel === s.channel && i.month === 'last'),
          s.key,
        ).toBe(true)
        expect(s.days[0], s.key).toBeGreaterThanOrEqual(1)
        expect(s.days[1], s.key).toBeGreaterThanOrEqual(s.days[0])
        expect(s.days[1], s.key).toBeLessThanOrEqual(31)
      }
      // Never two statements of a channel on the same day.
      for (const channel of added) {
        const days = (data.statements ?? [])
          .filter((s) => s.channel === channel)
          .flatMap((s) =>
            Array.from({ length: s.days[1] - s.days[0] + 1 }, (_, i) => s.days[0] + i),
          )
        expect(unique(days.map(String)), channel).toBe(true)
      }
    })

    it('orders name its customers, and their steps follow each other (M3 Step 5)', () => {
      expect(unique([...customers])).toBe(true)
      for (const c of data.customers ?? []) {
        if (c.trn) expect(c.trn, c.key).toMatch(/^\d{15}$/)
        // A trade licence is a company's or a government body's.
        if (c.tradeLicenceNo) expect(c.kind ?? 'individual', c.key).not.toBe('individual')
      }
      for (const o of data.orders ?? []) {
        expect(customers.has(o.customer), o.key).toBe(true)
        // Delivered or cancelled, not both.
        expect(o.deliveredDaysAgo !== undefined && o.cancelledDaysAgo !== undefined, o.key).toBe(
          false,
        )
        for (const pay of o.payments ?? []) {
          // Money given back only on a cancelled order here (a refund carries its own).
          if (pay.kind === 'refund') expect(o.cancelledDaysAgo, o.key).toBeDefined()
          else expect(o.cancelledDaysAgo, o.key).toBeUndefined()
        }
        if (o.refund) {
          expect(o.deliveredDaysAgo, o.key).toBeDefined()
          expect(
            o.lines.some(([product]) => product === o.refund!.product),
            o.key,
          ).toBe(true)
        }
        // A member who enters an order records no deposit (the owner records what customers pay).
        if (o.enteredBy) expect(o.deposit, o.key).toBeUndefined()
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
      for (const document of [
        ...(data.sales ?? []),
        ...(data.orders ?? []),
        ...(data.imports ?? []),
      ]) {
        if (document.enteredBy)
          expect(joined.has(document.enteredBy), document.enteredBy).toBe(true)
      }
      // The owner's time counts only without a team (D-119).
      const timed =
        data.ownerHourlyRate !== undefined || [...products.values()].some((p) => p.ownerMinutes)
      if (timed) expect(persona.answers.team).toBe('alone')
    })
  },
)
