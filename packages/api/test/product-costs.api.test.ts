import type {
  ExpensePaysInput,
  MaterialDto,
  ProductCostBreakdownDto,
  ProductCostListDto,
  ProductCostSettingsDto,
  ProductCostsDto,
  ProductDto,
  RunningCostDto,
} from '@bizcost/contracts'
import { addMonths, costRatio, daysIn, monthOf, newId, sumDecimals } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billOf } from './expenses'
import { addMember, handlerFor } from './helpers'
import { CostScope, ProductCostsApi, tag } from './product-costs'
import { codeOf, ok, purchaseInput, type Person } from './purchasing'
import { BAKER, WORKSHOP } from './settings'

// Product costs (ROADMAP.md M2 Step 6; D-115, D-119, D-121, D-178, D-202), through the API with real
// purchases, recipes, running costs and expenses. Running costs reach every product and service by its
// price (D-202, the owner's decision of 2026-09-30): its price before VAT × the month's costs ÷ the
// month's sales. Sales arrive in Phase 3, so every share is "awaiting sales" (or "no price"), never a
// reason the cost is incomplete, and the total and margin are before running costs. The owner's
// examples with exact numbers:
//   - the Spanish Latte in a café with a team: its materials from real purchases (3.002034632035), its
//     price and margin before VAT, before running costs;
//   - the home baker's chocolate cake slice (she works alone): a cake that makes 12 slices (1.075 a
//     slice) and 10 minutes of her time at AED 45 an hour (7.5).
// Also: the business's costs of the last full month, counted once (a category's bills replace its
// regular amount; running costs for the days they ran; finalized expenses only, in the month they
// belong to; no purchases), each line's states (no price, awaiting sales, no hourly rate, modules
// off), the settings (the hourly rate only), the list's sorting, filters and pages, and who sees and
// may do what (the month's costs only with running costs and expenses, D-202).

/** A coffee shop with a POS and staff, VAT-registered (persona 2): terminology profile `food`. */
const CAFE: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock'],
  sales_channels: ['walk_in', 'online'],
  pos: true,
  vat: 'yes',
}

let api: ProductCostsApi

beforeAll(() => {
  api = new ProductCostsApi()
})

afterAll(async () => {
  await api.close()
})

/** A material line of a purchase in a pack (`packId`) or a unit (`unit`). */
function bought(materialId: string, qty: string, unitPrice: string, unit: object) {
  return { kind: 'material', id: newId(), materialId, qty, unitPrice, ...unit }
}

/** A day of the month `offset` months from today's month (YYYY-MM-DD). */
function dayOfMonth(today: string, offset: number, day = 10): string {
  return `${addMonths(monthOf(today), offset)}-${String(day).padStart(2, '0')}`
}

/** The last full calendar month (YYYY-MM): the month whose costs are shown (D-202). */
const lastMonthOf = (today: string) => addMonths(monthOf(today), -1)

describe('the Spanish Latte in a café with a team', () => {
  let cafe: CostScope
  let today: string
  let latte: ProductDto
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    cafe = await CostScope.open(api, CAFE)
    today = await cafe.today()
    const bag = newId()
    const beans = await cafe.newMaterial({
      name: `Coffee beans ${tag()}`,
      unit: 'kg',
      packs: [{ id: bag, name: 'bag', qty: '1', ofUnit: 'kg' }],
    })
    const bottle = newId()
    const carton = newId()
    const milk = await cafe.newMaterial({
      name: `Milk ${tag()}`,
      unit: 'l',
      packs: [
        { id: bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
        { id: carton, name: 'carton', qty: '12', ofPackId: bottle },
      ],
    })
    const can = newId()
    const box = newId()
    const condensed = await cafe.newMaterial({
      name: `Condensed milk ${tag()}`,
      unit: 'l',
      packs: [
        { id: can, name: 'can', qty: '385', ofUnit: 'ml' },
        { id: box, name: 'box', qty: '24', ofPackId: can },
      ],
    })
    const sleeve = newId()
    const cup = await cafe.newMaterial({
      name: `Cup 12 oz ${tag()}`,
      unit: 'piece',
      packs: [{ id: sleeve, name: 'sleeve', qty: '50', ofUnit: 'piece' }],
    })
    const lidBox = newId()
    const lid = await cafe.newMaterial({
      name: `Lid ${tag()}`,
      unit: 'piece',
      packs: [{ id: lidBox, name: 'box', qty: '100', ofUnit: 'piece' }],
    })
    const strawPack = newId()
    const straw = await cafe.newMaterial({
      name: `Straw ${tag()}`,
      unit: 'piece',
      packs: [{ id: strawPack, name: 'pack', qty: '200', ofUnit: 'piece' }],
    })
    Object.assign(ids, {
      beans: beans.id,
      milk: milk.id,
      condensed: condensed.id,
      cup: cup.id,
      lid: lid.id,
      straw: straw.id,
    })
    // What the café paid (no VAT on the invoice): 2 bags of beans at 65, a carton of milk at 72, a box
    // of condensed milk at 95, 2 sleeves of cups at 12.50, a box of lids at 9, a pack of straws at 7.
    await cafe.buy(
      purchaseInput(today, [
        bought(beans.id, '2', '65', { packId: bag }),
        bought(milk.id, '1', '72', { packId: carton }),
        bought(condensed.id, '1', '95', { packId: box }),
        bought(cup.id, '2', '12.5', { packId: sleeve }),
        bought(lid.id, '1', '9', { packId: lidBox }),
        bought(straw.id, '1', '7', { packId: strawPack }),
      ]),
    )
    latte = await cafe.product({ name: `Spanish Latte ${tag()}`, defaultPrice: '18' })
    await cafe.recipe(latte.id, [
      { id: newId(), materialId: beans.id, qty: '18', unit: 'g' },
      { id: newId(), materialId: milk.id, qty: '200', unit: 'ml' },
      { id: newId(), materialId: condensed.id, qty: '25', unit: 'ml' },
      { id: newId(), materialId: cup.id, qty: '1', unit: 'piece' },
      { id: newId(), materialId: lid.id, qty: '1', unit: 'piece' },
      { id: newId(), materialId: straw.id, qty: '1', unit: 'piece' },
    ])
  }, 90_000)

  it('its materials, and its share of running costs worked out once sales are recorded (D-202)', async () => {
    const cost = await cafe.breakdown(latte.id)
    expect(cost.cost).toEqual({
      materials: '3.002034632035',
      runningCosts: { state: 'awaiting_sales', amount: null },
      ownerTime: { state: 'team', minutes: null, amount: null },
      total: '3.002034632035',
      // Before running costs: never final, and nothing the owner can add for it now.
      beforeRunningCosts: true,
      tooLarge: false,
      reasons: [],
      complete: true,
    })
    expect(cost.price).toEqual({
      defaultPrice: '18',
      includesVat: false,
      vatRate: '0',
      beforeVat: '18',
    })
    // 18 − 3.002034632035; (1 800 − 300.2034632035) ÷ 18: before running costs.
    expect(cost.margin).toEqual({ amount: '14.997965367965', percent: '83.322029822028' })
    // No running cost entered yet: the page asks for them (they are what will be shared); still
    // awaiting sales, never a reason on the product.
    expect(cost.monthCosts).toEqual({
      state: 'awaiting_sales',
      basis: null,
      from: null,
      to: null,
      showsOn: null,
      rate: null,
      sales: null,
      materials: null,
      runningCostsEntered: false,
      month: lastMonthOf(today),
      amountsShown: true,
      total: '0',
      categories: [],
    })
  })

  it('each material line: quantity, its average per unit, the line’s cost and the last price paid', async () => {
    const cost = await cafe.breakdown(latte.id)
    expect(cost.kind).toBe('recipe')
    expect(cost.materials?.yieldQty).toBe('1')
    expect(cost.materials?.averageTo).toBe(today)
    expect(
      cost.materials?.lines.map((line) => ({
        material: line.materialId,
        qty: line.qty,
        unit: line.unit,
        perUnit: line.cost?.perUnit,
        lineCost: line.cost?.lineCost,
        basis: line.cost?.basis,
        last: line.lastPurchase?.pricePerUnit,
        lastDay: line.lastPurchase?.businessDate,
      })),
    ).toEqual([
      {
        material: ids.beans,
        qty: '18',
        unit: 'g',
        perUnit: '65',
        lineCost: '1.17',
        basis: 'purchases_90_days',
        last: '65',
        lastDay: today,
      },
      {
        material: ids.milk,
        qty: '200',
        unit: 'ml',
        perUnit: '6',
        lineCost: '1.2',
        basis: 'purchases_90_days',
        last: '6',
        lastDay: today,
      },
      {
        material: ids.condensed,
        qty: '25',
        unit: 'ml',
        perUnit: '10.281385281385',
        lineCost: '0.257034632035',
        basis: 'purchases_90_days',
        last: '10.281385281385',
        lastDay: today,
      },
      {
        material: ids.cup,
        qty: '1',
        unit: 'piece',
        perUnit: '0.25',
        lineCost: '0.25',
        basis: 'purchases_90_days',
        last: '0.25',
        lastDay: today,
      },
      {
        material: ids.lid,
        qty: '1',
        unit: 'piece',
        perUnit: '0.09',
        lineCost: '0.09',
        basis: 'purchases_90_days',
        last: '0.09',
        lastDay: today,
      },
      {
        material: ids.straw,
        qty: '1',
        unit: 'piece',
        perUnit: '0.035',
        lineCost: '0.035',
        basis: 'purchases_90_days',
        last: '0.035',
        lastDay: today,
      },
    ])
    expect(cost.materials).toMatchObject({
      total: '3.002034632035',
      perUnit: '3.002034632035',
      unpricedLines: 0,
    })
  })

  it('a price that includes VAT loses it for the margin (VAT-registered): 18 → 17.142857142857', async () => {
    const withVat = await cafe.updateProduct(latte, { priceIncludesVat: true })
    const cost = await cafe.breakdown(latte.id)
    expect(cost.price).toEqual({
      defaultPrice: '18',
      includesVat: true,
      vatRate: '5',
      beforeVat: '17.142857142857',
    })
    // 17.142857142857 − 3.002034632035; (1 800 − 3.002034632035 × 105) ÷ 18.
    expect(cost.margin).toEqual({ amount: '14.140822510822', percent: '82.488131313129' })
    latte = await cafe.updateProduct(withVat, { priceIncludesVat: false })
  })

  it('the list says the same, and the breakdown and the list agree on every product', async () => {
    const list = await cafe.costList({ search: 'Spanish Latte' })
    expect(list.items).toHaveLength(1)
    const [row] = list.items
    const cost = await cafe.breakdown(latte.id)
    expect(row).toEqual({
      productId: latte.id,
      name: latte.name,
      type: 'product',
      unit: 'piece',
      kind: 'recipe',
      archived: false,
      yieldQty: '1',
      lineCount: 6,
      unpricedLines: 0,
      price: cost.price,
      cost: cost.cost,
      margin: cost.margin,
    })
    expect(list.monthCosts).toEqual(cost.monthCosts)
    // Awaiting sales puts nothing under "incomplete" (D-202).
    expect(list.counts).toEqual({
      all: 1,
      incomplete: 0,
      loss: 0,
      noTime: 0,
    })
    expect(list.currency).toBe('AED')
    expect(list.today).toBe(today)
    expect(list.ownerTime).toEqual({ applies: false, hourlyRate: null })
  })

  it('an item bought ready to sell costs its material’s average, before running costs', async () => {
    const caseId = newId()
    const water = await cafe.product({
      name: `Water ${tag()}`,
      defaultPrice: '3',
      resale: {
        materialId: newId(),
        packs: [{ id: caseId, name: 'case', qty: '24', ofUnit: 'piece' }],
      },
    })
    await cafe.buy(
      purchaseInput(today, [bought(water.resaleMaterialId!, '2', '24', { packId: caseId })]),
    )
    const cost = await cafe.breakdown(water.id)
    expect(cost.kind).toBe('resale')
    expect(cost.materials?.lines).toMatchObject([
      {
        materialId: water.resaleMaterialId,
        qty: '1',
        unit: 'piece',
        baseQty: '1',
        cost: { basis: 'purchases_90_days', perUnit: '1', lineCost: '1' },
        lastPurchase: { pricePerUnit: '1', businessDate: today },
      },
    ])
    expect(cost.cost).toMatchObject({
      materials: '1',
      runningCosts: { state: 'awaiting_sales', amount: null },
      total: '1',
      beforeRunningCosts: true,
      complete: true,
    })
    expect(cost.margin).toEqual({ amount: '2', percent: '66.666666666667' })
  })

  it('without a price, its share cannot be worked out by it: "add its price", never "awaiting sales"', async () => {
    const cookie = await cafe.product({ name: `Cookie ${tag()}` })
    await cafe.recipe(cookie.id, [{ id: newId(), materialId: ids.beans, qty: '5', unit: 'g' }])
    const cost = await cafe.breakdown(cookie.id)
    expect(cost.cost).toEqual({
      materials: '0.325',
      runningCosts: { state: 'no_price', amount: null },
      ownerTime: { state: 'team', minutes: null, amount: null },
      total: '0.325',
      beforeRunningCosts: true,
      tooLarge: false,
      reasons: ['no_price'],
      complete: false,
    })
    expect(cost.margin).toEqual({ amount: null, percent: null })
    const list = await cafe.costList({ search: cookie.name, filter: 'incomplete' })
    expect(list.items.map((i) => i.productId)).toEqual([cookie.id])
    // With its price: awaiting sales like every other product, and complete.
    await cafe.updateProduct(cookie, { defaultPrice: '6' })
    expect((await cafe.breakdown(cookie.id)).cost).toMatchObject({
      runningCosts: { state: 'awaiting_sales', amount: null },
      reasons: [],
      complete: true,
    })
  })

  it('the café’s owner has no time line (a team), and minutes and the hourly rate are refused while it has one', async () => {
    const result = await cafe.run('product.update', {
      id: latte.id,
      version: latte.version,
      name: latte.name,
      type: 'product',
      unit: 'piece',
      defaultPrice: '18',
      ownerMinutes: '5',
    })
    expect(codeOf(result)).toBe('capability_disabled')
    expect(codeOf(await cafe.run('productCost.updateSettings', { ownerHourlyRate: '40' }))).toBe(
      'capability_disabled',
    )
    // Nothing else to set: the settings say it has a team (D-202).
    expect(ok(await cafe.run<ProductCostSettingsDto>('productCost.settings')).data).toEqual({
      ownerHourlyRate: null,
      hasTeam: true,
      currency: 'AED',
    })
  })
})

describe('the home baker’s cake slice: she works alone, her time counts', () => {
  let baker: CostScope
  let today: string
  let slice: ProductDto

  beforeAll(async () => {
    baker = await CostScope.open(api, BAKER)
    today = await baker.today()
    const flour = await baker.newMaterial({ name: `Flour ${tag()}`, unit: 'kg' })
    const eggs = await baker.newMaterial({ name: `Eggs ${tag()}`, unit: 'piece' })
    const sugar = await baker.newMaterial({ name: `Sugar ${tag()}`, unit: 'kg' })
    const butter = await baker.newMaterial({ name: `Butter ${tag()}`, unit: 'kg' })
    // A 10 kg sack of flour at 50, a tray of 30 eggs at 12, 1 kg of sugar at 4, of butter at 32.
    await baker.buy(
      purchaseInput(today, [
        bought(flour.id, '10', '5', { unit: 'kg' }),
        bought(eggs.id, '30', '0.4', { unit: 'piece' }),
        bought(sugar.id, '1', '4', { unit: 'kg' }),
        bought(butter.id, '1', '32', { unit: 'kg' }),
      ]),
    )
    slice = await baker.product({ name: `Chocolate cake slice ${tag()}`, defaultPrice: '15' })
    // The cake as it is baked: 12 slices.
    await baker.recipe(
      slice.id,
      [
        { id: newId(), materialId: flour.id, qty: '500', unit: 'g' },
        { id: newId(), materialId: eggs.id, qty: '4', unit: 'piece' },
        { id: newId(), materialId: sugar.id, qty: '200', unit: 'g' },
        { id: newId(), materialId: butter.id, qty: '250', unit: 'g' },
      ],
      '12',
    )
    // Electricity 300 and gas 150 a month, a trade licence of 1 200 a year, since 2 months ago.
    const categories = await baker.categories()
    const byName = (name: string) => categories.find((c) => c.name === name)!.id
    for (const [name, categoryId, amount, frequency] of [
      ['Electricity', byName('Electricity'), '300', 'monthly'],
      ['Gas', byName('Other'), '150', 'monthly'],
      ['Trade licence', byName('Licences'), '1200', 'yearly'],
    ] as const) {
      await baker.runningCost({
        id: newId(),
        name,
        categoryId,
        amount,
        frequency,
        startsOn: dayOfMonth(today, -2, 1),
      })
    }
  }, 90_000)

  it('minutes without an hourly rate ask for the rate, never 0', async () => {
    slice = await baker.updateProduct(slice, { ownerMinutes: '10' })
    const cost = await baker.breakdown(slice.id)
    expect(cost.ownerTime).toEqual({ applies: true, hourlyRate: null })
    expect(cost.cost).toEqual({
      materials: '1.075',
      runningCosts: { state: 'awaiting_sales', amount: null },
      ownerTime: { state: 'rate_not_set', minutes: '10', amount: null },
      total: '1.075',
      beforeRunningCosts: true,
      tooLarge: false,
      reasons: ['hourly_rate_not_set'],
      complete: false,
    })
    // product.costs gives the product form the minutes.
    const [forForm] = ok(await baker.run<ProductCostsDto>('product.costs', { ids: [slice.id] }))
      .data.items
    expect(forForm?.ownerMinutes).toBe('10')
  })

  it('10 minutes at AED 45 an hour: 1.075 + 7.5 = 8.575 before running costs, 42.83 % of 15', async () => {
    const settings = await baker.settings({ ownerHourlyRate: '45' })
    expect(settings).toEqual({ ownerHourlyRate: '45', hasTeam: false, currency: 'AED' })
    const cost = await baker.breakdown(slice.id)
    expect(cost.materials).toMatchObject({ yieldQty: '12', total: '12.9', perUnit: '1.075' })
    expect(cost.materials?.lines.map((l) => l.cost?.lineCost)).toEqual(['2.5', '1.6', '0.8', '8'])
    expect(cost.cost).toEqual({
      materials: '1.075',
      runningCosts: { state: 'awaiting_sales', amount: null },
      ownerTime: { state: 'applied', minutes: '10', amount: '7.5' },
      total: '8.575',
      beforeRunningCosts: true,
      tooLarge: false,
      reasons: [],
      complete: true,
    })
    // Not VAT-registered: the price as it is.
    expect(cost.price).toEqual({
      defaultPrice: '15',
      includesVat: false,
      vatRate: '0',
      beforeVat: '15',
    })
    expect(cost.margin).toEqual({ amount: '6.425', percent: '42.833333333333' })
    expect(cost.ownerTime).toEqual({ applies: true, hourlyRate: '45' })
    // Her costs of last month: 300 + 150 + 100 (1 200 a year), from their regular amounts. Her time
    // is not in them (D-119, D-202).
    expect(cost.monthCosts).toMatchObject({
      state: 'awaiting_sales',
      runningCostsEntered: true,
      amountsShown: true,
      total: '550',
    })
    expect(
      cost.monthCosts.categories?.map((c) => [c.name, c.amount, c.lines.map((l) => l.source)]),
    ).toEqual([
      ['Electricity', '300', ['regular']],
      ['Other', '150', ['regular']],
      ['Licences', '100', ['regular']],
    ])
  })

  it('a service without materials: her time, and its share of running costs by its price like any product', async () => {
    const lesson = await baker.product({
      name: `Baking lesson ${tag()}`,
      type: 'service',
      unit: 'h',
      defaultPrice: '100',
      ownerMinutes: '60',
    })
    const cost = await baker.breakdown(lesson.id)
    expect(cost.materials?.lines).toEqual([])
    expect(cost.cost).toEqual({
      materials: null,
      runningCosts: { state: 'awaiting_sales', amount: null },
      ownerTime: { state: 'applied', minutes: '60', amount: '45' },
      total: '45',
      beforeRunningCosts: true,
      tooLarge: false,
      // Its materials are optional (D-186): a hint, its cost complete (D-203).
      reasons: ['no_recipe'],
      complete: true,
    })
    expect(cost.margin).toEqual({ amount: '55', percent: '55' })
    const list = await baker.costList({ search: lesson.name })
    expect(list.counts).toMatchObject({ incomplete: 0 })
  })

  it('minutes are cleared with null, kept when left out, and refused at 0', async () => {
    const pie = await baker.product({ name: `Pie ${tag()}`, ownerMinutes: '12.5' })
    const kept = await baker.updateProduct(pie, { name: `${pie.name} (apple)` })
    expect((await baker.breakdown(kept.id)).cost.ownerTime.minutes).toBe('12.5')
    expect(codeOf(await baker.run('product.update', { ...kept, ownerMinutes: '0' }))).toBe(
      'validation',
    )
    const cleared = await baker.updateProduct(kept, { ownerMinutes: null })
    expect((await baker.breakdown(cleared.id)).cost.ownerTime).toEqual({
      state: 'none',
      minutes: null,
      amount: null,
    })
  })

  it('the hourly rate: Arabic-Indic digits read; more decimals than the currency, 0 or less, or nothing are refused', async () => {
    expect((await baker.settings({ ownerHourlyRate: '٤٥٫٥٠' })).ownerHourlyRate).toBe('45.5')
    for (const value of ['45.555', '0', '-1', '1e3', 45]) {
      expect(
        codeOf(await baker.run('productCost.updateSettings', { ownerHourlyRate: value })),
        String(value),
      ).toBe('validation')
    }
    // Nothing to save, and the estimate of monthly purchases is no setting any more (D-202).
    expect(codeOf(await baker.run('productCost.updateSettings', {}))).toBe('validation')
    expect(
      codeOf(await baker.run('productCost.updateSettings', { estimatedMonthlyPurchases: '2000' })),
    ).toBe('validation')
    // Null clears it.
    expect((await baker.settings({ ownerHourlyRate: null })).ownerHourlyRate).toBeNull()
    await baker.settings({ ownerHourlyRate: '45' })
  })

  it('every change of the settings is audited, by whom and in which request', async () => {
    const result = await baker.run<ProductCostSettingsDto>('productCost.updateSettings', {
      ownerHourlyRate: '46',
    })
    ok(result)
    const rows = await api.admin<{ entity: string; action: string; actor_user_id: string }[]>`
      select entity, action, actor_user_id from app.audit_log
       where request_id = ${result.headers.get('x-request-id') ?? ''}`
    expect(rows).toEqual([
      { entity: 'businesses', action: 'update', actor_user_id: baker.owner.user.id },
    ])
    await baker.settings({ ownerHourlyRate: '45' })
  })
})

describe('the month’s costs: every running cost and expense counted once (D-202)', () => {
  let shop: CostScope
  let today: string
  let lastMonth: string
  let stool: ProductDto
  const CATEGORY_NAMES = ['Rent', 'Electricity', 'Marketing', 'Maintenance', 'Internet'] as const
  const cat = {} as Record<(typeof CATEGORY_NAMES)[number], string>

  /**
   * Rent of 5 000 up to the 15th of last month, then 6 000: each running cost for the days it ran,
   * one division each (D-216): [the new rent, the old rent], and the two together (one line: the
   * same rent changed, D-217).
   */
  const rentLines = (month: string) => {
    const days = daysIn(month)
    return [
      costRatio([String(6000 * (days - 15))], [String(days)])!,
      costRatio([String(5000 * 15)], [String(days)])!,
    ] as const
  }
  const rentOf = (month: string) => sumDecimals([...rentLines(month)])
  let newRent: RunningCostDto
  let power: RunningCostDto

  beforeAll(async () => {
    shop = await CostScope.open(api, WORKSHOP)
    today = await shop.today()
    lastMonth = lastMonthOf(today)
    const categories = await shop.categories()
    for (const name of CATEGORY_NAMES) {
      cat[name] = categories.find((c) => c.name === name)!.id
    }
    const since = dayOfMonth(today, -3, 1)
    // The rent changed on the 16th of last month: counted once, for the days each ran.
    await shop.runningCost({
      id: newId(),
      name: 'Workshop rent',
      categoryId: cat.Rent,
      amount: '5000',
      startsOn: since,
      endsOn: `${lastMonth}-16`,
    })
    newRent = await shop.runningCost({
      id: newId(),
      name: 'Workshop rent',
      categoryId: cat.Rent,
      amount: '6000',
      startsOn: `${lastMonth}-16`,
    })
    power = await shop.runningCost({
      id: newId(),
      name: 'Electricity',
      categoryId: cat.Electricity,
      amount: '900',
      startsOn: since,
    })
    // Last month's electricity bill, billed today: the bill of the electricity (D-216), it replaces
    // its regular 900 (never both).
    const post = async (
      categoryId: string,
      amount: string,
      periodMonth: string,
      pays?: ExpensePaysInput,
    ) =>
      shop.postExpense(
        await shop.expenseDraft(shop.expenseInput(categoryId, today, { amount, periodMonth })),
        pays,
      )
    await post(cat.Electricity, '950', lastMonth, billOf(power))
    // An ad for last month, without a running cost in its category: it counts as itself.
    await post(cat.Marketing, '480', lastMonth)
    // A repair finalized and reversed in last month: as if never posted.
    const repair = await post(cat.Maintenance, '777', lastMonth)
    ok(await shop.run('expense.reverse', { id: repair.id }))
    // Not counted: a draft for last month, this month's bill, and what was bought (materials are
    // each product's own line).
    await shop.expenseDraft(
      shop.expenseInput(cat.Internet, today, { amount: '333', periodMonth: lastMonth }),
    )
    await post(cat.Internet, '222', monthOf(today))
    const steel = await shop.newMaterial({ name: `Steel ${tag()}`, unit: 'kg' })
    await shop.buy(
      purchaseInput(dayOfMonth(today, -1, 5), [bought(steel.id, '100', '9.5', { unit: 'kg' })]),
    )
    stool = await shop.product({ name: `Stool ${tag()}`, defaultPrice: '99' })
    await shop.recipe(stool.id, [{ id: newId(), materialId: steel.id, qty: '2', unit: 'kg' }])
  }, 90_000)

  it('per running cost, its own bills or its regular amount; extras as themselves; the largest first', async () => {
    const rent = rentOf(lastMonth)
    const cost = await shop.breakdown(stool.id)
    const line = (over: object) => ({ regular: null, period: null, takenBack: null, ...over })
    expect(cost.monthCosts).toEqual({
      state: 'awaiting_sales',
      basis: null,
      from: null,
      to: null,
      showsOn: null,
      rate: null,
      sales: null,
      materials: null,
      runningCostsEntered: true,
      month: lastMonth,
      amountsShown: true,
      // Rent + 950 + 480: never 900 + 950 for electricity, and no purchase.
      total: sumDecimals([rent, '950', '480']),
      categories: [
        {
          categoryId: cat.Rent,
          name: 'Rent',
          amount: rent,
          // The rent changed on the 16th (D-176): one running cost that month (D-217), named by
          // the one that runs at its end, with both regular amounts.
          lines: [
            line({
              kind: 'running_cost',
              runningCostId: newRent.id,
              name: 'Workshop rent',
              source: 'regular',
              amount: rent,
              regular: rent,
            }),
          ],
        },
        {
          categoryId: cat.Electricity,
          name: 'Electricity',
          amount: '950',
          lines: [
            line({
              kind: 'running_cost',
              runningCostId: power.id,
              name: 'Electricity',
              source: 'bills',
              amount: '950',
              regular: '900',
            }),
          ],
        },
        {
          categoryId: cat.Marketing,
          name: 'Marketing',
          amount: '480',
          lines: [
            line({
              kind: 'extra',
              runningCostId: null,
              name: null,
              source: 'expenses',
              amount: '480',
            }),
          ],
        },
      ],
    })
    // The product's share still waits for sales: its total is its materials.
    expect(cost.cost).toMatchObject({
      materials: '19',
      runningCosts: { state: 'awaiting_sales', amount: null },
      total: '19',
      beforeRunningCosts: true,
      complete: true,
    })
    expect((await shop.costList({ search: stool.name })).monthCosts).toEqual(cost.monthCosts)
  })

  it('each module counts what it holds: Expenses off, Running Costs off, both off', async () => {
    const customize = (id: string, enabled: boolean) =>
      shop.run('business.customize', { item: { kind: 'module', id }, enabled })
    const rent = rentOf(lastMonth)
    ok(await customize('expenses', false))
    const noBills = (await shop.breakdown(stool.id)).monthCosts
    // Without its bills, electricity is its regular amount again.
    expect(
      noBills.categories?.map((c) => [c.name, c.lines.map((l) => l.source), c.amount]),
    ).toEqual([
      ['Rent', ['regular'], rent],
      ['Electricity', ['regular'], '900'],
    ])
    ok(await customize('expenses', true))
    ok(await customize('running_costs', false))
    const billsOnly = (await shop.breakdown(stool.id)).monthCosts
    expect(billsOnly).toMatchObject({ state: 'awaiting_sales', total: '1430' })
    // Without its running cost, the electricity's bill counts as itself.
    expect(
      billsOnly.categories?.map((c) => [c.name, c.lines.map((l) => [l.kind, l.source]), c.amount]),
    ).toEqual([
      ['Electricity', [['extra', 'expenses']], '950'],
      ['Marketing', [['extra', 'expenses']], '480'],
    ])
    ok(await customize('expenses', false))
    const off = await shop.breakdown(stool.id)
    expect(off.monthCosts).toEqual({
      state: 'off',
      basis: null,
      from: null,
      to: null,
      showsOn: null,
      rate: null,
      sales: null,
      materials: null,
      runningCostsEntered: true,
      month: lastMonth,
      amountsShown: true,
      total: null,
      categories: null,
    })
    // Nothing to share: the total is final.
    expect(off.cost).toMatchObject({
      runningCosts: { state: 'off', amount: null },
      total: '19',
      beforeRunningCosts: false,
      complete: true,
    })
    ok(await customize('expenses', true))
    ok(await customize('running_costs', true))
  })

  it('a yearly running cost and its one bill count once: the bill pays for every month of its year (D-203)', async () => {
    // A trade licence of 1 200 a year from 3 months before last month; its renewal bill is for the
    // month after it started. Last month counts 1 200 ÷ 12 = 100 of it, from the bill (never 100
    // beside the bill), and the month the bill is for counts the same.
    const other = await CostScope.open(api, WORKSHOP)
    const licences = (await other.categories()).find((c) => c.name === 'Licences')!.id
    const first = addMonths(lastMonth, -3)
    const licence = await other.runningCost({
      id: newId(),
      name: 'Trade licence',
      categoryId: licences,
      amount: '1200',
      frequency: 'yearly',
      startsOn: `${first}-01`,
    })
    await other.postExpense(
      await other.expenseDraft(
        other.expenseInput(licences, today, {
          amount: '1200',
          periodMonth: addMonths(first, 1),
        }),
      ),
      billOf(licence),
    )
    const product = await other.product({ name: `Licence shelf ${tag()}`, defaultPrice: '10' })
    const { monthCosts } = await other.breakdown(product.id)
    expect(monthCosts).toMatchObject({ month: lastMonth, total: '100' })
    expect(monthCosts.categories).toEqual([
      {
        categoryId: licences,
        name: 'Licences',
        amount: '100',
        lines: [
          {
            kind: 'running_cost',
            runningCostId: licence.id,
            name: 'Trade licence',
            source: 'bills',
            amount: '100',
            regular: '100',
            period: { from: first, to: addMonths(first, 11), months: 12, bills: '1200' },
            takenBack: null,
          },
        ],
      },
    ])
  })

  it('a reversal counts where its month’s books leave it: in the first open month (D-200)', async () => {
    // A bill for the month before last, finalized, then the books closed through that month's end:
    // its reversal counts back in last month.
    const other = await CostScope.open(api, WORKSHOP)
    const [internet] = (await other.categories()).filter((c) => c.name === 'Internet')
    const before = addMonths(lastMonth, -1)
    const bill = await other.postExpense(
      await other.expenseDraft(
        other.expenseInput(internet!.id, `${lastMonth}-01`, { amount: '300', periodMonth: before }),
      ),
    )
    ok(await other.run('books.close', { closedThrough: `${lastMonth}-01` }))
    // Closed through the 1st: the month before last is closed, last month open.
    ok(await other.run('expense.reverse', { id: bill.id }))
    const product = await other.product({ name: `Shelf ${tag()}`, defaultPrice: '10' })
    const { monthCosts } = await other.breakdown(product.id)
    expect(monthCosts).toMatchObject({ month: lastMonth, total: '-300' })
    // Taken back on its own: it replaces nothing in last month (D-203).
    expect(monthCosts.categories).toEqual([
      {
        categoryId: internet!.id,
        name: 'Internet',
        amount: '-300',
        lines: [
          {
            kind: 'extra',
            runningCostId: null,
            name: null,
            source: 'taken_back',
            amount: '-300',
            regular: null,
            period: null,
            takenBack: '300',
          },
        ],
      },
    ])
  })
})

describe('the Product costs list: sorted, filtered and in pages', () => {
  let shop: CostScope
  const made: Record<string, ProductDto> = {}
  const prefix = `Sorted ${tag()}`

  beforeAll(async () => {
    shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const steel = await shop.newMaterial({ name: `Steel ${tag()}`, unit: 'kg' })
    const paint = await shop.newMaterial({ name: `Paint ${tag()}`, unit: 'l' })
    await shop.buy(purchaseInput(today, [bought(steel.id, '100', '10', { unit: 'kg' })]))
    // A: 2 kg of steel = 20, sold at 50 (margin 30, 60 %); B: 1 kg = 10, sold at 12 (2, 16.67 %);
    // C: 5 kg = 50, sold at 40 (a loss of 10); D: paint never bought (incomplete), sold at 9; E: no
    // recipe and no price; F: 1 kg of steel and paint never bought, sold at 100: incomplete, with a
    // margin of at most 90 (90 %). Every share awaits sales, which changes no order.
    const add = async (key: string, price: string | null, lines: object[]) => {
      made[key] = await shop.product({ name: `${prefix} ${key}`, defaultPrice: price })
      if (lines.length > 0) await shop.recipe(made[key].id, lines)
    }
    await add('A', '50', [{ id: newId(), materialId: steel.id, qty: '2', unit: 'kg' }])
    await add('B', '12', [{ id: newId(), materialId: steel.id, qty: '1', unit: 'kg' }])
    await add('C', '40', [{ id: newId(), materialId: steel.id, qty: '5', unit: 'kg' }])
    await add('D', '9', [{ id: newId(), materialId: paint.id, qty: '1', unit: 'l' }])
    await add('E', null, [])
    await add('F', '100', [
      { id: newId(), materialId: steel.id, qty: '1', unit: 'kg' },
      { id: newId(), materialId: paint.id, qty: '1', unit: 'l' },
    ])
  }, 90_000)

  const names = (list: ProductCostListDto['data']) =>
    list.items.map((item) => item.name.slice(prefix.length + 1))

  it('by name, cost, margin and margin %, either way; nulls last; by margin, incomplete after complete', async () => {
    const by = async (sort: string, direction = 'asc') =>
      names(await shop.costList({ search: prefix, sort, order: direction }))
    expect(await by('name')).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    expect(await by('name', 'desc')).toEqual(['F', 'E', 'D', 'C', 'B', 'A'])
    expect(await by('cost')).toEqual(['B', 'F', 'A', 'C', 'D', 'E'])
    expect(await by('cost', 'desc')).toEqual(['C', 'A', 'B', 'F', 'D', 'E'])
    // F's margin (90) is only "at most": after the complete ones, whichever the direction.
    expect(await by('margin', 'desc')).toEqual(['A', 'B', 'C', 'F', 'D', 'E'])
    expect(await by('margin')).toEqual(['C', 'B', 'A', 'F', 'D', 'E'])
    expect(await by('margin_percent', 'desc')).toEqual(['A', 'B', 'C', 'F', 'D', 'E'])
    expect(await by('margin_percent')).toEqual(['C', 'B', 'A', 'F', 'D', 'E'])
    expect(await by('price')).toEqual(['D', 'B', 'C', 'A', 'F', 'E'])
    const f = (await shop.costList({ search: `${prefix} F` })).items[0]
    expect(f).toMatchObject({
      cost: { materials: '10', total: '10', reasons: ['unpriced_materials'], complete: false },
      margin: { amount: '90', percent: '90' },
    })
    const c = (await shop.costList({ search: `${prefix} C` })).items[0]
    expect(c?.margin).toEqual({ amount: '-10', percent: '-25' })
    expect(c?.cost).toMatchObject({ total: '50', beforeRunningCosts: true, complete: true })
  })

  it('filters: incomplete, at a loss; how many of each, whatever the filter', async () => {
    const incomplete = await shop.costList({ search: prefix, filter: 'incomplete' })
    expect(names(incomplete)).toEqual(['D', 'E', 'F'])
    expect(incomplete.counts).toEqual({
      all: 6,
      incomplete: 3,
      loss: 1,
      noTime: 0,
    })
    const loss = await shop.costList({ search: prefix, filter: 'loss' })
    expect(names(loss)).toEqual(['C'])
    expect(loss.counts).toEqual(incomplete.counts)
    const d = (await shop.costList({ search: `${prefix} D` })).items[0]
    expect(d).toMatchObject({
      lineCount: 1,
      unpricedLines: 1,
      cost: { materials: null, total: null, reasons: ['unpriced_materials'], complete: false },
      margin: { amount: null, percent: null },
    })
    const e = (await shop.costList({ search: `${prefix} E` })).items[0]
    expect(e).toMatchObject({
      lineCount: 0,
      price: { defaultPrice: null, beforeVat: null },
      cost: {
        runningCosts: { state: 'no_price', amount: null },
        total: null,
        reasons: ['no_recipe', 'no_price'],
        complete: false,
      },
      margin: { amount: null, percent: null },
    })
  })

  it('in pages: the cursor follows its own sort and filter only', async () => {
    const first = await shop.costList({ search: prefix, sort: 'cost', limit: 2 })
    expect(names(first)).toEqual(['B', 'F'])
    expect(first.nextCursor).not.toBeNull()
    const second = await shop.costList({
      search: prefix,
      sort: 'cost',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(names(second)).toEqual(['A', 'C'])
    const third = await shop.costList({
      search: prefix,
      sort: 'cost',
      limit: 2,
      cursor: second.nextCursor,
    })
    expect(names(third)).toEqual(['D', 'E'])
    expect(third.nextCursor).toBeNull()
    for (const cursor of [first.nextCursor, 'nope', Buffer.from('[1]').toString('base64url')]) {
      expect(
        codeOf(
          await shop.run('productCost.list', { search: prefix, sort: 'margin', limit: 2, cursor }),
        ),
      ).toBe('validation')
    }
  })

  it('archived products only when asked', async () => {
    ok(await shop.run('product.archive', { id: made.E!.id }))
    expect(names(await shop.costList({ search: prefix }))).toEqual(['A', 'B', 'C', 'D', 'F'])
    expect(names(await shop.costList({ search: prefix, status: 'archived' }))).toEqual(['E'])
    expect(
      (await shop.costList({ search: prefix, status: 'all' })).items.find((i) => i.archived)?.name,
    ).toBe(made.E!.name)
    ok(await shop.run('product.unarchive', { id: made.E!.id }))
  })
})

describe('modules off: no line for them, and nothing counted as 0', () => {
  it('Running Costs and Expenses off: no share; Materials off: no materials, and no recipe asked for', async () => {
    const shop = await CostScope.open(api, BAKER)
    const today = await shop.today()
    const flour = await shop.newMaterial({ name: `Flour ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(today, [bought(flour.id, '1', '6', { unit: 'kg' })]))
    const bread = await shop.product({ name: `Bread ${tag()}`, defaultPrice: '10' })
    await shop.recipe(bread.id, [{ id: newId(), materialId: flour.id, qty: '500', unit: 'g' }])
    const customize = (id: string, enabled: boolean) =>
      shop.run('business.customize', { item: { kind: 'module', id }, enabled })
    ok(await customize('running_costs', false))
    // Expenses alone still hold costs to share.
    expect((await shop.breakdown(bread.id)).cost.runningCosts).toEqual({
      state: 'awaiting_sales',
      amount: null,
    })
    ok(await customize('expenses', false))
    const off = await shop.breakdown(bread.id)
    expect(off.monthCosts).toMatchObject({ state: 'off', total: null, categories: null })
    expect(off.cost).toMatchObject({
      materials: '3',
      runningCosts: { state: 'off', amount: null },
      total: '3',
      beforeRunningCosts: false,
      complete: true,
    })
    ok(await customize('running_costs', true))
    ok(await customize('expenses', true))
    ok(await customize('materials', false))
    const noMaterials = await shop.breakdown(bread.id)
    expect(noMaterials.materials).toBeNull()
    // Its share awaiting sales is the line that will count: nothing missing, nothing counted yet
    // (D-203).
    expect(noMaterials.cost).toMatchObject({
      materials: null,
      runningCosts: { state: 'awaiting_sales', amount: null },
      total: null,
      beforeRunningCosts: true,
      reasons: [],
      complete: true,
    })
    expect(noMaterials.margin).toEqual({ amount: null, percent: null })
    ok(await customize('materials', true))
    // The Cost Engine off: its procedures are off too.
    ok(await customize('cost_engine', false))
    expect(codeOf(await shop.run('productCost.list', {}))).toBe('module_disabled')
    expect(codeOf(await shop.run('productCost.settings'))).toBe('module_disabled')
    ok(await customize('cost_engine', true))
  })
})

/** Every value the owner reads in a breakdown that is sensitive (the others must never get one). */
function ownerValues(data: ProductCostBreakdownDto['data']): string[] {
  const values = [
    data.cost.materials,
    data.cost.ownerTime.minutes,
    data.cost.ownerTime.amount,
    data.cost.total,
    data.margin.amount,
    data.margin.percent,
    data.monthCosts.total,
    ...(data.monthCosts.categories ?? []).flatMap((c) => [
      c.amount,
      ...c.lines.flatMap((l) => [l.amount, l.regular]),
    ]),
    data.ownerTime.hourlyRate,
    data.materials?.total,
    data.materials?.perUnit,
    ...(data.materials?.lines ?? []).flatMap((line) => [
      line.cost?.perUnit,
      line.cost?.lineCost,
      line.lastPurchase?.pricePerUnit,
    ]),
  ]
  return [
    ...new Set(values.filter((v): v is string => typeof v === 'string' && v !== '0' && v !== '1')),
  ]
}

/** What a member who sees no costs, margins or supplier prices gets withheld (a hand-written oracle). */
const COST_PATHS = [
  'beforeRunningCosts',
  'complete',
  'materials',
  'ownerTime.amount',
  'ownerTime.minutes',
  'ownerTime.state',
  'reasons',
  'runningCosts.amount',
  'runningCosts.state',
  'tooLarge',
  'total',
]
const MONTH_PATHS = [
  'monthCosts.basis',
  'monthCosts.categories',
  'monthCosts.materials',
  'monthCosts.rate',
  'monthCosts.runningCostsEntered',
  'monthCosts.sales',
  'monthCosts.state',
  'monthCosts.total',
  'ownerTime.hourlyRate',
]
const LIST_HIDDEN = [
  'counts.incomplete',
  'counts.loss',
  'counts.noTime',
  ...COST_PATHS.map((path) => `items.*.cost.${path}`),
  'items.*.margin.amount',
  'items.*.margin.percent',
  ...MONTH_PATHS,
].sort()
const BREAKDOWN_HIDDEN = [
  ...COST_PATHS.map((path) => `cost.${path}`),
  'margin.amount',
  'margin.percent',
  'materials.lines.*.cost.lineCost',
  'materials.lines.*.cost.perUnit',
  'materials.lines.*.lastPurchase.pricePerUnit',
  'materials.perUnit',
  'materials.total',
  ...MONTH_PATHS,
].sort()

describe('who sees and may do what', () => {
  let shop: CostScope
  let product: ProductDto
  let employee: Person
  let accountant: Person
  let manager: Person
  let noCosts: Person
  let pageOnly: Person

  beforeAll(async () => {
    shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const oak: MaterialDto = await shop.newMaterial({ name: `Oak ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(today, [bought(oak.id, '10', '7.77', { unit: 'kg' })]))
    product = await shop.product({ name: `Stool ${tag()}`, defaultPrice: '99' })
    await shop.recipe(product.id, [{ id: newId(), materialId: oak.id, qty: '3', unit: 'kg' }])
    // Last month's costs: a rent of 15 678 and an ad of 432.19: every line has a value.
    const categories = await shop.categories()
    const byName = (name: string) => categories.find((c) => c.name === name)!.id
    await shop.runningCost({
      id: newId(),
      name: 'Workshop rent',
      categoryId: byName('Rent'),
      amount: '15678',
      startsOn: `${addMonths(monthOf(today), -2)}-01`,
    })
    await shop.postExpense(
      await shop.expenseDraft(
        shop.expenseInput(byName('Marketing'), today, {
          amount: '432.19',
          periodMonth: lastMonthOf(today),
        }),
      ),
    )
    employee = await api.member(shop, 'employee')
    accountant = await api.member(shop, 'accountant')
    manager = await api.member(shop, 'manager')
    // A Manager whose costs are hidden by an override (cost goes with supplier prices, D-144).
    noCosts = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, noCosts.user, {
      template: 'manager',
      overrides: [{ key: 'data.cost.view', effect: 'deny' }],
    })
    // An Employee given the page by an override: it sees the products and locks.
    pageOnly = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, pageOnly.user, {
      template: 'employee',
      overrides: [{ key: 'cost_engine.product_costs.view', effect: 'allow' }],
    })
  }, 90_000)

  it('Owner, Admin, Manager and Accountant see product costs and the month’s costs; Sales, Supervisor and Employee do not', async () => {
    for (const person of [manager, accountant]) {
      const cost = ok(
        await shop.as<ProductCostBreakdownDto>(person, 'productCost.get', {
          productId: product.id,
        }),
      )
      // 3 × 7.77 = 23.31.
      expect(cost.data.cost.materials).toBe('23.31')
      expect(cost.data.monthCosts).toMatchObject({ amountsShown: true, total: '16110.19' })
      expect(cost.meta.redacted).toEqual([])
    }
    for (const template of ['sales', 'supervisor', 'employee'] as const) {
      const person = template === 'employee' ? employee : await api.member(shop, template)
      for (const [path, input] of [
        ['productCost.list', {}],
        ['productCost.get', { productId: product.id }],
        ['productCost.settings', undefined],
        ['productCost.updateSettings', { ownerHourlyRate: '1' }],
      ] as const) {
        const result = await shop.as(person, path, input)
        expect(codeOf(result), `${template} ${path}`).toBe('forbidden')
        expect(result.raw.includes('23.31')).toBe(false)
        expect(result.raw.includes('16110.19')).toBe(false)
      }
    }
  })

  it('the settings: Manager reads them (nothing to set with a team); Accountant only sees product costs', async () => {
    expect(ok(await shop.as<ProductCostSettingsDto>(manager, 'productCost.settings')).data).toEqual(
      { ownerHourlyRate: null, hasTeam: true, currency: 'AED' },
    )
    expect(
      codeOf(await shop.as(manager, 'productCost.updateSettings', { ownerHourlyRate: '50' })),
    ).toBe('capability_disabled')
    expect(codeOf(await shop.as(accountant, 'productCost.settings'))).toBe('forbidden')
    expect(
      codeOf(await shop.as(accountant, 'productCost.updateSettings', { ownerHourlyRate: '1' })),
    ).toBe('forbidden')
    // They need no running costs or purchases any more: nothing of theirs is in them (D-202).
    const person = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, person.user, {
      template: 'manager',
      overrides: [
        { key: 'purchases.documents.view', effect: 'deny' },
        { key: 'running_costs.items.view', effect: 'deny' },
      ],
    })
    ok(await shop.as(person, 'productCost.settings'))
  })

  it('a member who may see the page but not costs: locks, and no sort or filter on hidden values', async () => {
    // What the owner reads: every value the others must not get.
    const owner = await shop.breakdown(product.id)
    const secrets = ownerValues(owner)
    expect(secrets).toEqual(
      expect.arrayContaining(['23.31', '75.69', '15678', '432.19', '16110.19']),
    )
    for (const person of [pageOnly, noCosts]) {
      const list = ok(
        await shop.as<ProductCostListDto>(person, 'productCost.list', { search: product.name }),
      )
      // A hand-written oracle: a tag lost on any of these fails here.
      expect(list.meta.redacted).toEqual(LIST_HIDDEN)
      const [row] = list.data.items
      expect(row?.price.defaultPrice).toBe('99')
      expect(row?.cost.total).toBeUndefined()
      expect(row?.margin.amount).toBeUndefined()
      expect(list.data.counts).toEqual({ all: 1 })
      // Without costs, the month's costs are withheld too (D-202).
      expect(list.data.monthCosts).toEqual({
        month: lastMonthOf(owner.today),
        from: null,
        to: null,
        showsOn: null,
        amountsShown: false,
      })
      for (const value of secrets) {
        expect(JSON.stringify(list.data).includes(`"${value}"`), value).toBe(false)
      }
      for (const input of [
        { sort: 'cost' },
        { sort: 'margin' },
        { sort: 'margin_percent', order: 'desc' },
        { filter: 'incomplete' },
        { filter: 'loss' },
      ]) {
        expect(
          codeOf(await shop.as(person, 'productCost.list', input)),
          JSON.stringify(input),
        ).toBe('forbidden')
      }
      ok(await shop.as(person, 'productCost.list', { sort: 'price', order: 'desc' }))
      const one = ok(
        await shop.as<ProductCostBreakdownDto>(person, 'productCost.get', {
          productId: product.id,
        }),
      )
      expect(one.meta.redacted).toEqual(BREAKDOWN_HIDDEN)
      expect(one.data.materials?.lines[0]?.qty).toBe('3')
      expect(one.data.materials?.lines[0]?.cost?.lineCost).toBeUndefined()
      expect(one.data.materials?.lines[0]?.lastPurchase?.pricePerUnit).toBeUndefined()
      for (const value of [...secrets, '7.77']) {
        expect(JSON.stringify(one.data).includes(`"${value}"`), value).toBe(false)
      }
    }
  })

  it('costs without running costs or expenses: the product’s cost, never the month’s amounts (D-202)', async () => {
    // An Accountant whose own override takes running costs away, and one without expenses.
    for (const key of ['running_costs.items.view', 'expenses.documents.view'] as const) {
      const person = await api.person()
      await addMember(api.db, shop.owner.user, shop.id, person.user, {
        template: 'accountant',
        overrides: [{ key, effect: 'deny' }],
      })
      const one = ok(
        await shop.as<ProductCostBreakdownDto>(person, 'productCost.get', {
          productId: product.id,
        }),
      )
      expect(one.meta.redacted).toEqual([])
      // Its own cost and margin.
      expect(one.data.cost).toMatchObject({ materials: '23.31', total: '23.31' })
      expect(one.data.monthCosts).toEqual({
        state: 'awaiting_sales',
        basis: null,
        from: null,
        to: null,
        showsOn: null,
        rate: null,
        sales: null,
        materials: null,
        runningCostsEntered: true,
        month: lastMonthOf(one.data.today),
        amountsShown: false,
        total: null,
        categories: null,
      })
      const list = ok(
        await shop.as<ProductCostListDto>(person, 'productCost.list', { search: product.name }),
      )
      expect(list.data.monthCosts).toEqual(one.data.monthCosts)
      for (const value of ['15678', '432.19', '16110.19', 'Marketing']) {
        expect(JSON.stringify(list).includes(value), `${key} ${value}`).toBe(false)
        expect(JSON.stringify(one).includes(value), `${key} ${value}`).toBe(false)
      }
    }
  })

  it('a business without a team: the page-only member gets none of the owner’s time either', async () => {
    const solo = await CostScope.open(api, BAKER)
    const today = await solo.today()
    const flour = await solo.newMaterial({ name: `Flour ${tag()}`, unit: 'kg' })
    await solo.buy(purchaseInput(today, [bought(flour.id, '10', '6.13', { unit: 'kg' })]))
    const [category] = await solo.categories()
    await solo.runningCost({
      id: newId(),
      name: 'Gas',
      categoryId: category!.id,
      amount: '432.1',
      startsOn: `${addMonths(monthOf(today), -2)}-01`,
    })
    await solo.settings({ ownerHourlyRate: '43.21' })
    const bread = await solo.product({
      name: `Bread ${tag()}`,
      defaultPrice: '19.99',
      ownerMinutes: '17.25',
    })
    await solo.recipe(bread.id, [{ id: newId(), materialId: flour.id, qty: '500', unit: 'g' }])
    const owner = await solo.breakdown(bread.id)
    // 17.25 minutes at 43.21 an hour = 12.4228750.
    expect(owner.cost.ownerTime).toEqual({
      state: 'applied',
      minutes: '17.25',
      amount: '12.422875',
    })
    expect(owner.ownerTime).toEqual({ applies: true, hourlyRate: '43.21' })
    const secrets = ownerValues(owner)
    expect(secrets).toEqual(expect.arrayContaining(['17.25', '12.422875', '43.21', '432.1']))
    const person = await api.person()
    await addMember(api.db, solo.owner.user, solo.id, person.user, {
      template: 'employee',
      overrides: [{ key: 'cost_engine.product_costs.view', effect: 'allow' }],
    })
    const one = ok(
      await solo.as<ProductCostBreakdownDto>(person, 'productCost.get', { productId: bread.id }),
    )
    expect(one.meta.redacted).toEqual(BREAKDOWN_HIDDEN)
    const list = ok(
      await solo.as<ProductCostListDto>(person, 'productCost.list', { search: bread.name }),
    )
    expect(list.meta.redacted).toEqual(LIST_HIDDEN)
    for (const value of secrets) {
      expect(JSON.stringify(one).includes(`"${value}"`), value).toBe(false)
      expect(JSON.stringify(list).includes(`"${value}"`), value).toBe(false)
    }
    expect(one.data.ownerTime).toEqual({ applies: true })
    expect(one.data.cost.ownerTime).toEqual({})
  })

  it('writing what one cannot see is FORBIDDEN: the hourly rate, a product’s minutes', async () => {
    // The Manager with costs hidden holds cost_engine.settings.manage: refused before the team is.
    expect(
      codeOf(await shop.as(noCosts, 'productCost.updateSettings', { ownerHourlyRate: '1' })),
    ).toBe('forbidden')
    expect(
      codeOf(
        await shop.as(noCosts, 'product.update', {
          id: product.id,
          version: product.version,
          name: product.name,
          type: 'product',
          unit: 'piece',
          defaultPrice: '99',
          ownerMinutes: '5',
        }),
      ),
    ).toBe('forbidden')
    const [row] = await api.admin<{ owner_hourly_rate: string | null }[]>`
      select owner_hourly_rate::text from app.businesses where id = ${shop.id}`
    expect(row?.owner_hourly_rate).toBeNull()
  })

  it('another business’s product is NOT_FOUND', async () => {
    const other = await CostScope.open(api, WORKSHOP)
    expect(codeOf(await other.run('productCost.get', { productId: product.id }))).toBe('not_found')
  })

  it('the Cost Engine is released (M2 Step 7): served without the preview, MODULE_DISABLED only when turned off', async () => {
    const other = await CostScope.open(api, WORKSHOP)
    const released = handlerFor(api.db)
    for (const path of ['productCost.list', 'productCost.settings'] as const) {
      expect((await api.call(other.owner, other.id, path, undefined, released)).error, path).toBe(
        undefined,
      )
    }
    ok(
      await other.run('business.customize', {
        item: { kind: 'module', id: 'cost_engine' },
        enabled: false,
      }),
    )
    for (const path of ['productCost.list', 'productCost.settings'] as const) {
      expect(codeOf(await api.call(other.owner, other.id, path, undefined, released)), path).toBe(
        'module_disabled',
      )
    }
  })
})
