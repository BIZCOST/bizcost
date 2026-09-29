import type {
  MaterialDto,
  ProductCostBreakdownDto,
  ProductCostListDto,
  ProductCostSettingsDto,
  ProductCostsDto,
  ProductDto,
  PurchaseDto,
  PurchaseReturnDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember, handlerFor } from './helpers'
import { CostScope, ProductCostsApi, tag } from './product-costs'
import { codeOf, ok, purchaseInput, type Person } from './purchasing'
import { BAKER, WORKSHOP } from './settings'

// Product costs (ROADMAP.md M2 Step 6; D-115, D-116, D-119, D-121, D-178), through the API with real
// purchases, recipes and running costs. The owner's two examples with exact numbers:
//   - the Spanish Latte in a café with a team: its materials from real purchases (3.002034632035),
//     running costs of 15 000 a month over the owner's estimate of 30 000 of purchases a month (each
//     dirham of materials carries 0.50: 1.501017316018), its price and margin before VAT;
//   - the home baker's chocolate cake slice (she works alone): a cake that makes 12 slices (1.075 a
//     slice), running costs of 550 a month over an estimate of 2 000 (0.295625), 10 minutes of her
//     time at AED 45 an hour (7.5).
// Also: the last 3 full months of purchases replacing the estimate (net of returns, reversals left
// out), each line's states (not set, no materials, no hourly rate, modules off), the settings, the
// list's sorting, filters and pages, and who sees and may do what.

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
  const year = Number.parseInt(today.slice(0, 4), 10)
  const month = Number.parseInt(today.slice(5, 7), 10) - 1 + offset
  const y = year + Math.floor(month / 12)
  const m = ((month % 12) + 12) % 12
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

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
    // Rent 12 000 and electricity 3 000 a month: 15 000 of running costs a month.
    const categories = await cafe.categories()
    const rent = categories.find((c) => c.name === 'Rent')!
    const electricity = categories.find((c) => c.name === 'Electricity')!
    await cafe.runningCost({
      id: newId(),
      name: 'Shop rent',
      categoryId: rent.id,
      amount: '12000',
      startsOn: today,
    })
    await cafe.runningCost({
      id: newId(),
      name: 'Electricity',
      categoryId: electricity.id,
      amount: '3000',
      startsOn: today,
    })
  }, 90_000)

  it('without an estimate and 3 full months of purchases, the share is "not set yet", never 0', async () => {
    const cost = await cafe.breakdown(latte.id)
    expect(cost.rate).toEqual({
      state: 'not_set',
      totalsShown: true,
      monthlyRunningCosts: '15000',
      purchases: {
        source: null,
        monthly: null,
        from: dayOfMonth(today, -3, 1),
        to: expect.stringMatching(new RegExp(`^${dayOfMonth(today, -1, 1).slice(0, 8)}`)),
        average: null,
        estimate: null,
        // The first purchase is this month: its 3 full months have passed 4 months from now.
        countsFrom: dayOfMonth(today, 4, 1),
        monthsBought: 0,
        ready: false,
      },
      rate: null,
    })
    expect(cost.cost).toEqual({
      materials: '3.002034632035',
      runningCosts: { state: 'not_set', share: null },
      ownerTime: { state: 'team', minutes: null, amount: null },
      total: '3.002034632035',
      tooLarge: false,
      reasons: ['running_costs_not_set'],
      complete: false,
    })
    // The margin on what is known, marked incomplete with the cost.
    expect(cost.margin).toEqual({ amount: '14.997965367965', percent: '83.322029822028' })
  })

  it('with the owner’s estimate of 30 000 a month: each dirham of materials carries 0.50', async () => {
    const settings = await cafe.settings({ estimatedMonthlyPurchases: '30000' })
    expect(settings.estimatedMonthlyPurchases).toBe('30000')
    expect(settings.hasTeam).toBe(true)
    expect(settings.rate).toMatchObject({
      state: 'ready',
      monthlyRunningCosts: '15000',
      purchases: { source: 'estimate', monthly: '30000', estimate: '30000', ready: false },
      rate: '0.5',
    })
    const cost = await cafe.breakdown(latte.id)
    expect(cost.rate.rate).toBe('0.5')
    // 3.002034632035 × 15 000 ÷ 30 000 = 1.5010173160175, rounded once to 12 decimals.
    expect(cost.cost).toEqual({
      materials: '3.002034632035',
      runningCosts: { state: 'applied', share: '1.501017316018' },
      ownerTime: { state: 'team', minutes: null, amount: null },
      total: '4.503051948053',
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
    // 18 − 4.503051948053; (1 800 − 450.3051948053) ÷ 18.
    expect(cost.margin).toEqual({ amount: '13.496948051947', percent: '74.983044733039' })
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
    // 17.142857142857 − 4.503051948053; (1 800 − 4.503051948053 × 105) ÷ 18 = 1 327.179545454435 ÷ 18.
    expect(cost.margin).toEqual({ amount: '12.639805194804', percent: '73.732196969691' })
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
    expect(list.rate).toEqual(cost.rate)
    expect(list.counts).toMatchObject({ all: 1, incomplete: 0, loss: 0, noTime: 0 })
    expect(list.currency).toBe('AED')
    expect(list.today).toBe(today)
    expect(list.ownerTime).toEqual({ applies: false, hourlyRate: null })
  })

  it('an item bought ready to sell costs its material’s average, with its running-cost share', async () => {
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
      runningCosts: { state: 'applied', share: '0.5' },
      total: '1.5',
      complete: true,
    })
    expect(cost.margin).toEqual({ amount: '1.5', percent: '50' })
  })

  it('the café’s owner has no time line (a team), and minutes are refused while it has one', async () => {
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
    // Electricity 300 and gas 150 a month, a trade licence of 1 200 a year: 550 a month.
    const categories = await baker.categories()
    const byName = (name: string) => categories.find((c) => c.name === name)!.id
    for (const [name, categoryId, amount, frequency] of [
      ['Electricity', byName('Electricity'), '300', 'monthly'],
      ['Gas', byName('Other'), '150', 'monthly'],
      ['Trade licence', byName('Licences'), '1200', 'yearly'],
    ] as const) {
      await baker.runningCost({ id: newId(), name, categoryId, amount, frequency, startsOn: today })
    }
    await baker.settings({ estimatedMonthlyPurchases: '2000' })
  }, 90_000)

  it('minutes without an hourly rate ask for the rate, never 0', async () => {
    slice = await baker.updateProduct(slice, { ownerMinutes: '10' })
    const cost = await baker.breakdown(slice.id)
    expect(cost.ownerTime).toEqual({ applies: true, hourlyRate: null })
    expect(cost.cost).toEqual({
      materials: '1.075',
      runningCosts: { state: 'applied', share: '0.295625' },
      ownerTime: { state: 'rate_not_set', minutes: '10', amount: null },
      total: '1.370625',
      tooLarge: false,
      reasons: ['hourly_rate_not_set'],
      complete: false,
    })
    // product.costs gives the product form the minutes.
    const [forForm] = ok(await baker.run<ProductCostsDto>('product.costs', { ids: [slice.id] }))
      .data.items
    expect(forForm?.ownerMinutes).toBe('10')
  })

  it('10 minutes at AED 45 an hour: 1.075 + 0.295625 + 7.5 = 8.870625, 40.8625 % of 15', async () => {
    const settings = await baker.settings({ ownerHourlyRate: '45' })
    expect(settings).toMatchObject({
      estimatedMonthlyPurchases: '2000',
      ownerHourlyRate: '45',
      hasTeam: false,
      rate: {
        state: 'ready',
        monthlyRunningCosts: '550',
        purchases: { source: 'estimate', monthly: '2000' },
        rate: '0.275',
      },
    })
    const cost = await baker.breakdown(slice.id)
    expect(cost.materials).toMatchObject({ yieldQty: '12', total: '12.9', perUnit: '1.075' })
    expect(cost.materials?.lines.map((l) => l.cost?.lineCost)).toEqual(['2.5', '1.6', '0.8', '8'])
    expect(cost.cost).toEqual({
      materials: '1.075',
      runningCosts: { state: 'applied', share: '0.295625' },
      ownerTime: { state: 'applied', minutes: '10', amount: '7.5' },
      total: '8.870625',
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
    expect(cost.margin).toEqual({ amount: '6.129375', percent: '40.8625' })
    expect(cost.ownerTime).toEqual({ applies: true, hourlyRate: '45' })
  })

  it('a service without materials: her time only, and running costs cannot reach it (a known limit)', async () => {
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
      runningCosts: { state: 'no_materials', share: null },
      ownerTime: { state: 'applied', minutes: '60', amount: '45' },
      total: '45',
      tooLarge: false,
      reasons: ['no_recipe', 'running_costs_need_materials'],
      complete: false,
    })
    expect(cost.margin).toEqual({ amount: '55', percent: '55' })
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

  it('Arabic-Indic digits are read; more decimals than the currency has are refused', async () => {
    expect((await baker.settings({ ownerHourlyRate: '٤٥٫٥٠' })).ownerHourlyRate).toBe('45.5')
    expect(
      codeOf(await baker.run('productCost.updateSettings', { ownerHourlyRate: '45.555' })),
    ).toBe('validation')
    for (const value of ['0', '-1', '1e3', 45]) {
      expect(
        codeOf(await baker.run('productCost.updateSettings', { estimatedMonthlyPurchases: value })),
        String(value),
      ).toBe('validation')
    }
    expect(codeOf(await baker.run('productCost.updateSettings', {}))).toBe('validation')
    await baker.settings({ ownerHourlyRate: '45' })
  })

  it('every change of the settings is audited, by whom and in which request', async () => {
    const result = await baker.run<ProductCostSettingsDto>('productCost.updateSettings', {
      estimatedMonthlyPurchases: '2100',
    })
    ok(result)
    const rows = await api.admin<{ entity: string; action: string; actor_user_id: string }[]>`
      select entity, action, actor_user_id from app.audit_log
       where request_id = ${result.headers.get('x-request-id') ?? ''}`
    expect(rows).toEqual([
      { entity: 'businesses', action: 'update', actor_user_id: baker.owner.user.id },
    ])
    await baker.settings({ estimatedMonthlyPurchases: '2000' })
  })
})

describe('monthly purchases: the last 3 full months once they count, else the estimate', () => {
  it('3 full months after the first purchase’s month: their average, net of returns, reversals left out', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const wood = await shop.newMaterial({ name: `Wood ${tag()}`, unit: 'kg' })
    const buy = (offset: number, qty: string, price: string, day = 10) =>
      shop.buy(
        purchaseInput(dayOfMonth(today, offset, day), [
          bought(wood.id, qty, price, { unit: 'kg' }),
        ]),
      )
    // The first purchase, 4 months ago: not counted (its month is before the 3 months).
    await buy(-4, '10', '100')
    await buy(-3, '20', '100')
    const second: PurchaseDto = await buy(-2, '30', '100')
    await buy(-1, '40', '100')
    // Reversed: left out.
    const wrong = await buy(-1, '9.99', '100', 20)
    await shop.reverse(wrong.id)
    // This month's: not a full month yet.
    await buy(0, '50', '100', 1)
    // 3 kg of the second one sent back today: 300 less for its month.
    const draft = ok(
      await shop.run<{ data: PurchaseReturnDto }>('purchaseReturn.create', {
        id: newId(),
        purchaseId: second.id,
        kind: 'return',
        businessDate: today,
        lines: [{ id: newId(), purchaseLineId: second.lines[0]?.id, qty: '3' }],
      }),
    ).data
    await shop.postReturn(draft)
    // A running cost to share, and an estimate the purchases now replace.
    const [category] = await shop.categories()
    await shop.runningCost({
      id: newId(),
      name: 'Workshop rent',
      categoryId: category!.id,
      amount: '5800',
      startsOn: today,
    })
    const settings = await shop.settings({ estimatedMonthlyPurchases: '10000' })
    // (2 000 + 2 700 + 4 000) ÷ 3 = 2 900 a month; 5 800 ÷ 2 900 = 2.
    expect(settings.rate).toEqual({
      state: 'ready',
      totalsShown: true,
      monthlyRunningCosts: '5800',
      purchases: {
        source: 'last_3_months',
        monthly: '2900',
        from: dayOfMonth(today, -3, 1),
        to: expect.stringMatching(new RegExp(`^${dayOfMonth(today, -1, 1).slice(0, 8)}`)),
        average: '2900',
        estimate: '10000',
        countsFrom: dayOfMonth(today, 0, 1),
        monthsBought: 3,
        ready: true,
      },
      rate: '2',
    })
  })

  it('a month of the 3 without a purchase keeps the estimate (D-186): old invoices typed in on day one', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const wood = await shop.newMaterial({ name: `Wood ${tag()}`, unit: 'kg' })
    const buy = (offset: number, qty: string) =>
      shop.buy(
        purchaseInput(offset === 0 ? today : dayOfMonth(today, offset), [
          bought(wood.id, qty, '30', { unit: 'kg' }),
        ]),
      )
    // Two old invoices (4 and 2 months ago), then this month's real buying.
    await buy(-4, '1')
    await buy(-2, '1')
    await buy(0, '1000')
    const [category] = await shop.categories()
    await shop.runningCost({
      id: newId(),
      name: 'Workshop rent',
      categoryId: category!.id,
      amount: '15000',
      startsOn: today,
    })
    const early = await shop.settings({ estimatedMonthlyPurchases: '30000' })
    expect(early.rate.purchases).toMatchObject({
      source: 'estimate',
      monthly: '30000',
      average: null,
      countsFrom: dayOfMonth(today, 0, 1),
      monthsBought: 1,
      ready: false,
    })
    expect(early.rate.rate).toBe('0.5')
    // The two months without a purchase get one: the 3 months count, and their average replaces it.
    await buy(-3, '1')
    await buy(-1, '1')
    const counted = await shop.settings({ estimatedMonthlyPurchases: '30000' })
    // 90 ÷ 3 = 30 a month.
    expect(counted.rate.purchases).toMatchObject({
      source: 'last_3_months',
      monthly: '30',
      monthsBought: 3,
      ready: true,
    })
    expect(counted.rate.rate).toBe('500')
  })

  it('until then the estimate, and the day the purchases will count', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const wood = await shop.newMaterial({ name: `Wood ${tag()}`, unit: 'kg' })
    await shop.buy(
      purchaseInput(dayOfMonth(today, -3, 28), [bought(wood.id, '10', '100', { unit: 'kg' })]),
    )
    const settings = await shop.settings({ estimatedMonthlyPurchases: '4000' })
    expect(settings.rate.purchases).toMatchObject({
      source: 'estimate',
      monthly: '4000',
      average: null,
      countsFrom: dayOfMonth(today, 1, 1),
      monthsBought: 1,
      ready: false,
    })
    // No running cost entered yet: "not entered yet", never 0 (D-186).
    expect(settings.rate).toMatchObject({
      state: 'not_entered',
      monthlyRunningCosts: '0',
      rate: null,
    })
    const stool = await shop.product({ name: `Stool ${tag()}`, defaultPrice: '99' })
    await shop.recipe(stool.id, [{ id: newId(), materialId: wood.id, qty: '1', unit: 'kg' }])
    expect((await shop.breakdown(stool.id)).cost).toMatchObject({
      materials: '100',
      runningCosts: { state: 'not_entered', share: null },
      total: '100',
      reasons: ['running_costs_not_entered'],
      complete: false,
    })
    // One that ended: entered, none paid now: nothing to share, 0 and complete.
    const [category] = await shop.categories()
    await shop.runningCost({
      id: newId(),
      name: 'Old rent',
      categoryId: category!.id,
      amount: '1000',
      startsOn: dayOfMonth(today, -2, 1),
      endsOn: dayOfMonth(today, -1, 1),
    })
    const ended = await shop.breakdown(stool.id)
    expect(ended.rate).toMatchObject({ state: 'none', monthlyRunningCosts: '0', rate: '0' })
    expect(ended.cost).toMatchObject({
      runningCosts: { state: 'none', share: '0' },
      total: '100',
      complete: true,
    })
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
    // Running costs entered, none paid now: every share is 0.
    const [category] = await shop.categories()
    await shop.runningCost({
      id: newId(),
      name: 'Old rent',
      categoryId: category!.id,
      amount: '1000',
      startsOn: dayOfMonth(today, -2, 1),
      endsOn: dayOfMonth(today, -1, 1),
    })
    // A: 2 kg of steel = 20, sold at 50 (margin 30, 60 %); B: 1 kg = 10, sold at 12 (2, 16.67 %);
    // C: 5 kg = 50, sold at 40 (a loss of 10); D: paint never bought (incomplete), sold at 9; E: no
    // recipe and no price; F: 1 kg of steel and paint never bought, sold at 100: incomplete, with a
    // margin of at most 90 (90 %).
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
    expect(c?.cost.total).toBe('50')
  })

  it('filters: incomplete, at a loss; how many of each, whatever the filter', async () => {
    const incomplete = await shop.costList({ search: prefix, filter: 'incomplete' })
    expect(names(incomplete)).toEqual(['D', 'E', 'F'])
    expect(incomplete.counts).toEqual({ all: 6, incomplete: 3, loss: 1, noTime: 0 })
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
      cost: { total: null, reasons: ['no_recipe'], complete: false },
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
  it('Running Costs off: no share; Materials off: no materials, and no recipe asked for', async () => {
    const shop = await CostScope.open(api, BAKER)
    const today = await shop.today()
    const flour = await shop.newMaterial({ name: `Flour ${tag()}`, unit: 'kg' })
    await shop.buy(purchaseInput(today, [bought(flour.id, '1', '6', { unit: 'kg' })]))
    const bread = await shop.product({ name: `Bread ${tag()}`, defaultPrice: '10' })
    await shop.recipe(bread.id, [{ id: newId(), materialId: flour.id, qty: '500', unit: 'g' }])
    const [category] = await shop.categories()
    await shop.runningCost({
      id: newId(),
      name: 'Oven gas',
      categoryId: category!.id,
      amount: '100',
      startsOn: today,
    })
    const customize = (id: string, enabled: boolean) =>
      shop.run('business.customize', { item: { kind: 'module', id }, enabled })
    ok(await customize('running_costs', false))
    const off = await shop.breakdown(bread.id)
    expect(off.rate).toMatchObject({ state: 'off', monthlyRunningCosts: null, rate: null })
    expect(off.cost).toMatchObject({
      materials: '3',
      runningCosts: { state: 'off', share: null },
      total: '3',
      complete: true,
    })
    ok(await customize('running_costs', true))
    ok(await customize('materials', false))
    const noMaterials = await shop.breakdown(bread.id)
    expect(noMaterials.materials).toBeNull()
    expect(noMaterials.cost).toMatchObject({
      materials: null,
      runningCosts: { state: 'no_materials', share: null },
      total: null,
      reasons: ['running_costs_need_materials'],
      complete: false,
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
    data.cost.runningCosts.share,
    data.cost.ownerTime.minutes,
    data.cost.ownerTime.amount,
    data.cost.total,
    data.margin.amount,
    data.margin.percent,
    data.rate.monthlyRunningCosts,
    data.rate.purchases.monthly,
    data.rate.purchases.average,
    data.rate.purchases.estimate,
    data.rate.rate,
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
  'complete',
  'materials',
  'ownerTime.amount',
  'ownerTime.minutes',
  'ownerTime.state',
  'reasons',
  'runningCosts.share',
  'runningCosts.state',
  'tooLarge',
  'total',
]
const RATE_PATHS = [
  'ownerTime.hourlyRate',
  'rate.monthlyRunningCosts',
  'rate.purchases.average',
  'rate.purchases.estimate',
  'rate.purchases.monthly',
  'rate.purchases.source',
  'rate.rate',
  'rate.state',
]
const LIST_HIDDEN = [
  'counts.incomplete',
  'counts.loss',
  'counts.noTime',
  ...COST_PATHS.map((path) => `items.*.cost.${path}`),
  'items.*.margin.amount',
  'items.*.margin.percent',
  ...RATE_PATHS,
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
  ...RATE_PATHS,
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
    // Running costs of 15 678 a month over an estimate of 31 234 a month: every line has a value.
    const [category] = await shop.categories()
    await shop.runningCost({
      id: newId(),
      name: 'Workshop rent',
      categoryId: category!.id,
      amount: '15678',
      startsOn: today,
    })
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

  it('Owner, Admin, Manager and Accountant see product costs; Sales, Supervisor and Employee do not', async () => {
    for (const person of [manager, accountant]) {
      const cost = ok(
        await shop.as<ProductCostBreakdownDto>(person, 'productCost.get', {
          productId: product.id,
        }),
      )
      // 3 × 7.77 = 23.31.
      expect(cost.data.cost.materials).toBe('23.31')
      expect(cost.meta.redacted).toEqual([])
    }
    for (const template of ['sales', 'supervisor', 'employee'] as const) {
      const person = template === 'employee' ? employee : await api.member(shop, template)
      for (const [path, input] of [
        ['productCost.list', {}],
        ['productCost.get', { productId: product.id }],
        ['productCost.settings', undefined],
        ['productCost.updateSettings', { estimatedMonthlyPurchases: '1' }],
      ] as const) {
        const result = await shop.as(person, path, input)
        expect(codeOf(result), `${template} ${path}`).toBe('forbidden')
        expect(result.raw.includes('23.31')).toBe(false)
      }
    }
  })

  it('the settings: Manager changes them; Accountant only sees product costs', async () => {
    ok(await shop.as(manager, 'productCost.updateSettings', { estimatedMonthlyPurchases: '5000' }))
    expect(codeOf(await shop.as(accountant, 'productCost.settings'))).toBe('forbidden')
    expect(
      codeOf(
        await shop.as(accountant, 'productCost.updateSettings', { estimatedMonthlyPurchases: '1' }),
      ),
    ).toBe('forbidden')
  })

  it('a member who may see the page but not costs: locks, and no sort or filter on hidden values', async () => {
    await shop.settings({ estimatedMonthlyPurchases: '31234' })
    // What the owner reads: every value the others must not get.
    const owner = await shop.breakdown(product.id)
    const secrets = ownerValues(owner)
    expect(secrets).toEqual(
      expect.arrayContaining(['23.31', '11.700524428507', '15678', '31234', '63.989475571493']),
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
      // Without running costs and purchases, their totals are withheld too (D-186).
      expect(list.data.rate.totalsShown).toBe(person !== pageOnly)
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

  it('costs without running costs or purchases: the rate alone, never their monthly totals (D-186)', async () => {
    await shop.settings({ estimatedMonthlyPurchases: '31234' })
    // An Accountant whose own override takes running costs away, and one without purchases.
    for (const key of ['running_costs.items.view', 'purchases.documents.view'] as const) {
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
      // Its own cost, share and rate: 23.31 × 15 678 ÷ 31 234.
      expect(one.data.cost.runningCosts.share).toBe('11.700524428507')
      expect(one.data.rate).toMatchObject({
        state: 'ready',
        totalsShown: false,
        monthlyRunningCosts: null,
        purchases: { source: 'estimate', monthly: null, average: null, estimate: null },
        rate: '0.501952999936',
      })
      const list = ok(
        await shop.as<ProductCostListDto>(person, 'productCost.list', { search: product.name }),
      )
      expect(list.data.rate).toEqual(one.data.rate)
      for (const value of ['15678', '31234']) {
        expect(JSON.stringify(list).includes(value), `${key} ${value}`).toBe(false)
        expect(JSON.stringify(one).includes(value), `${key} ${value}`).toBe(false)
      }
    }
    // The settings need them: the estimate and the rate it gives reveal the running costs.
    const manager = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, manager.user, {
      template: 'manager',
      overrides: [{ key: 'purchases.documents.view', effect: 'deny' }],
    })
    expect(codeOf(await shop.as(manager, 'productCost.settings'))).toBe('forbidden')
    expect(
      codeOf(
        await shop.as(manager, 'productCost.updateSettings', { estimatedMonthlyPurchases: '1' }),
      ),
    ).toBe('forbidden')
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
      startsOn: today,
    })
    await solo.settings({ estimatedMonthlyPurchases: '2345.67', ownerHourlyRate: '43.21' })
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
    expect(secrets).toEqual(expect.arrayContaining(['17.25', '12.422875', '43.21', '2345.67']))
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

  it('writing what one cannot see is FORBIDDEN: the settings, a product’s minutes', async () => {
    // As the Manager left it.
    await shop.as(manager, 'productCost.updateSettings', { estimatedMonthlyPurchases: '5000' })
    // The Manager with costs hidden holds cost_engine.settings.manage.
    expect(
      codeOf(
        await shop.as(noCosts, 'productCost.updateSettings', { estimatedMonthlyPurchases: '1' }),
      ),
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
    const [row] = await api.admin<{ estimated_monthly_purchases: string }[]>`
      select trim_scale(estimated_monthly_purchases)::text as estimated_monthly_purchases
        from app.businesses where id = ${shop.id}`
    expect(row?.estimated_monthly_purchases).toBe('5000')
  })

  it('another business’s product is NOT_FOUND', async () => {
    const other = await CostScope.open(api, WORKSHOP)
    expect(codeOf(await other.run('productCost.get', { productId: product.id }))).toBe('not_found')
  })

  it('the Cost Engine is not released: MODULE_DISABLED without the dev-only preview', async () => {
    const released = handlerFor(api.db)
    for (const path of ['productCost.list', 'productCost.settings'] as const) {
      expect(codeOf(await api.call(shop.owner, shop.id, path, undefined, released))).toBe(
        'module_disabled',
      )
    }
  })
})
