import type {
  MaterialDto,
  ProductCostsDto,
  ProductDto,
  RecipeResultDto,
  RoleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { SetupAnswers } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  codeOf,
  milkInput,
  ok,
  purchaseInput,
  PurchasingApi,
  Scope,
  type Person,
} from './purchasing'

// Recipes and product cost (ROADMAP.md M2 Step 4; D-115, D-117, D-146–D-152), through the API with
// real purchases. The owner's Spanish Latte: beans 18 g from 1 kg bags, milk 200 ml from the carton
// (1 carton = 12 bottles × 1 L for AED 72: AED 0.006 per ml, AED 1.20 for 200 ml), condensed milk
// 25 ml from a box of 24 cans of 385 ml, a cup, a lid and a straw. Every cost is Σ base quantity × the
// material's average (its purchases of the last 90 days, D-115), one division rounded once to 12
// decimals, never to the currency; a material never bought has no price (null, never 0) and the
// total says it is incomplete. Also: the owner's WAC example through a recipe, versions, units that
// change under a recipe, services with materials, an item bought ready to sell and who sees what.

/** A coffee shop with a POS and staff (PRODUCT.md §6.11 persona 2): terminology profile `food`. */
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

/** A retail shop with stock (persona 6): terminology profile `retail` (D-117). */
const SHOP: SetupAnswers = {
  what_you_do: ['sell_products'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['salaries', 'staff_cash'],
  work_setup: ['stock', 'vehicles'],
  sales_channels: ['walk_in', 'messages'],
  pos: true,
  vat: 'yes',
}

let api: PurchasingApi
let cafe: Scope
let today: string

beforeAll(async () => {
  api = new PurchasingApi()
  cafe = await Scope.open(api, CAFE)
  today = await cafe.today()
}, 60_000)

afterAll(async () => {
  await api.close()
})

const tag = () => newId().slice(-8)

async function material(scope: Scope, input: object): Promise<MaterialDto> {
  return ok(await scope.run<MaterialDto>('material.create', { id: newId(), ...input }))
}

async function product(scope: Scope, input: object = {}): Promise<ProductDto> {
  return ok(
    await scope.run<ProductDto>('product.create', {
      id: newId(),
      name: `Product ${tag()}`,
      type: 'product',
      unit: 'piece',
      ...input,
    }),
  )
}

/** A material line of a purchase in a pack (`packId`) or a unit (`unit`). */
function bought(materialId: string, qty: string, unitPrice: string, unit: object) {
  return { kind: 'material', id: newId(), materialId, qty, unitPrice, ...unit }
}

async function save(scope: Scope, productId: string, version: number, lines: object[]) {
  return scope.run<RecipeResultDto>('recipe.save', { productId, version, lines })
}

async function recipeOf(scope: Scope, productId: string) {
  return ok(await scope.run<RecipeResultDto>('recipe.get', { productId })).data
}

async function costsOf(scope: Scope, ids: string[]) {
  return ok(await scope.run<ProductCostsDto>('product.costs', { ids })).data.items
}

describe('the Spanish Latte, from real purchases', () => {
  let latte: ProductDto
  let straw: MaterialDto
  let strawPack: string
  let version: number

  beforeAll(async () => {
    const bag = newId()
    const beans = await material(cafe, {
      name: `Coffee beans ${tag()}`,
      unit: 'kg',
      packs: [{ id: bag, name: 'bag', qty: '1', ofUnit: 'kg' }],
    })
    const milk = milkInput(`Milk ${tag()}`)
    const milkMaterial = await cafe.material(milk.input)
    const can = newId()
    const box = newId()
    const condensed = await material(cafe, {
      name: `Condensed milk ${tag()}`,
      unit: 'l',
      packs: [
        { id: can, name: 'can', qty: '385', ofUnit: 'ml' },
        { id: box, name: 'box', qty: '24', ofPackId: can },
      ],
    })
    const sleeve = newId()
    const cup = await material(cafe, {
      name: `Cup 12 oz ${tag()}`,
      unit: 'piece',
      packs: [{ id: sleeve, name: 'sleeve', qty: '50', ofUnit: 'piece' }],
    })
    const lidBox = newId()
    const lid = await material(cafe, {
      name: `Lid ${tag()}`,
      unit: 'piece',
      packs: [{ id: lidBox, name: 'box', qty: '100', ofUnit: 'piece' }],
    })
    strawPack = newId()
    straw = await material(cafe, {
      name: `Straw ${tag()}`,
      unit: 'piece',
      packs: [{ id: strawPack, name: 'pack', qty: '200', ofUnit: 'piece' }],
    })
    latte = await product(cafe, { name: `Spanish Latte ${tag()}`, defaultPrice: '18' })

    // What the café paid (no VAT on the invoice): 2 bags of beans at 65, a carton of milk at 72, a
    // box of condensed milk at 95, 2 sleeves of cups at 12.50 and a box of lids at 9. No straws yet.
    await cafe.buy(
      purchaseInput(today, [
        bought(beans.id, '2', '65', { packId: bag }),
        bought(milkMaterial.id, '1', '72', { packId: milk.carton }),
        bought(condensed.id, '1', '95', { packId: box }),
        bought(cup.id, '2', '12.5', { packId: sleeve }),
        bought(lid.id, '1', '9', { packId: lidBox }),
      ]),
    )

    const saved = ok(
      await save(cafe, latte.id, 0, [
        { id: newId(), materialId: beans.id, qty: '18', unit: 'g' },
        { id: newId(), materialId: milkMaterial.id, qty: '200', unit: 'ml' },
        { id: newId(), materialId: condensed.id, qty: '25', unit: 'ml' },
        { id: newId(), materialId: cup.id, qty: '1', unit: 'piece' },
        { id: newId(), materialId: lid.id, qty: '1', unit: 'piece' },
        { id: newId(), materialId: straw.id, qty: '1', unit: 'piece' },
      ]),
    ).data
    version = saved.version
  }, 60_000)

  it('costs each line at its base quantity × the average, never rounded', async () => {
    const recipe = await recipeOf(cafe, latte.id)
    expect(recipe.version).toBe(version)
    expect(recipe.productUnit).toBe('piece')
    expect(
      recipe.lines.map((line) => ({
        qty: line.qty,
        unit: line.unit,
        baseQty: line.baseQty,
        perUnit: line.cost?.perUnit ?? null,
        perBaseUnit: line.cost?.perBaseUnit ?? null,
        lineCost: line.cost?.lineCost ?? null,
        basis: line.cost?.basis ?? null,
      })),
    ).toEqual([
      // 130 for 2 000 g: 65 a kg, 0.065 a gram; 18 g = 1.17.
      {
        qty: '18',
        unit: 'g',
        baseQty: '18',
        perUnit: '65',
        perBaseUnit: '0.065',
        lineCost: '1.17',
        basis: 'purchases_90_days',
      },
      // The carton: 72 for 12 000 ml, 0.006 a ml; 200 ml = 1.20.
      {
        qty: '200',
        unit: 'ml',
        baseQty: '200',
        perUnit: '6',
        perBaseUnit: '0.006',
        lineCost: '1.2',
        basis: 'purchases_90_days',
      },
      // 95 for 24 × 385 = 9 240 ml: 25 × 95 ÷ 9 240, rounded once to 12 decimals.
      {
        qty: '25',
        unit: 'ml',
        baseQty: '25',
        perUnit: '10.281385281385',
        perBaseUnit: '0.010281385281',
        lineCost: '0.257034632035',
        basis: 'purchases_90_days',
      },
      // 25 for 100 cups; 9 for 100 lids.
      {
        qty: '1',
        unit: 'piece',
        baseQty: '1',
        perUnit: '0.25',
        perBaseUnit: '0.25',
        lineCost: '0.25',
        basis: 'purchases_90_days',
      },
      {
        qty: '1',
        unit: 'piece',
        baseQty: '1',
        perUnit: '0.09',
        perBaseUnit: '0.09',
        lineCost: '0.09',
        basis: 'purchases_90_days',
      },
      // Never bought: no price yet (null, never 0).
      {
        qty: '1',
        unit: 'piece',
        baseQty: '1',
        perUnit: null,
        perBaseUnit: null,
        lineCost: null,
        basis: null,
      },
    ])
    expect(recipe.lines.at(-1)?.cost).toBeNull()
    // The total of the lines with a price, marked incomplete.
    expect(recipe.cost).toEqual({
      total: '2.967034632035',
      perUnit: '2.967034632035',
      tooLarge: false,
      unpricedLines: 1,
      complete: false,
    })
    expect(recipe.averageTo).toBe(today)
  })

  it('product.costs says the same for the products list', async () => {
    const [cost] = await costsOf(cafe, [latte.id])
    expect(cost).toEqual({
      productId: latte.id,
      kind: 'recipe',
      unit: 'piece',
      yieldQty: '1',
      lineCount: 6,
      basis: null,
      cost: {
        total: '2.967034632035',
        perUnit: '2.967034632035',
        tooLarge: false,
        unpricedLines: 1,
        complete: false,
      },
    })
  })

  it('is complete once the straws are bought: AED 3.002034632035, shown AED 3.00', async () => {
    await cafe.buy(purchaseInput(today, [bought(straw.id, '1', '7', { packId: strawPack })]))
    const recipe = await recipeOf(cafe, latte.id)
    expect(recipe.lines.at(-1)?.cost?.lineCost).toBe('0.035')
    expect(recipe.cost).toEqual({
      total: '3.002034632035',
      perUnit: '3.002034632035',
      tooLarge: false,
      unpricedLines: 0,
      complete: true,
    })
    const [cost] = await costsOf(cafe, [latte.id])
    expect(cost?.cost).toEqual({
      total: '3.002034632035',
      perUnit: '3.002034632035',
      tooLarge: false,
      unpricedLines: 0,
      complete: true,
    })
  })
})

describe('the owner’s WAC example through a recipe', () => {
  it('50 L at 6, then 100 L at 7: 1 L costs 6.666666666667; reversing the second gives exactly 6', async () => {
    const milk = await cafe.material(milkInput(`Milk ${tag()}`).input)
    const shake = await product(cafe, { name: `Milkshake ${tag()}` })
    ok(await save(cafe, shake.id, 0, [{ id: newId(), materialId: milk.id, qty: '1', unit: 'l' }]))
    await cafe.buy(purchaseInput(today, [bought(milk.id, '50', '6', { unit: 'l' })]))
    const second = await cafe.buy(
      purchaseInput(today, [bought(milk.id, '100', '7', { unit: 'l' })]),
    )
    expect((await recipeOf(cafe, shake.id)).cost.total).toBe('6.666666666667')
    await cafe.reverse(second.id)
    expect((await recipeOf(cafe, shake.id)).cost.total).toBe('6')
  })
})

describe('saving a recipe', () => {
  it('keeps each line as typed and in base units: packs, other units, a conversion', async () => {
    const milk = milkInput(`Milk ${tag()}`)
    const milkMaterial = await cafe.material(milk.input)
    // Oil used by weight, bought in litres: 1 L = 920 g.
    const oil = await material(cafe, {
      name: `Oil ${tag()}`,
      unit: 'kg',
      crossFactors: [{ id: newId(), unit: 'l', qty: '920', ofUnit: 'g' }],
    })
    const cake = await product(cafe)
    const recipe = ok(
      await save(cafe, cake.id, 0, [
        { id: newId(), materialId: milkMaterial.id, qty: '0.5', packId: milk.bottle },
        { id: newId(), materialId: oil.id, qty: '50', unit: 'ml' },
      ]),
    ).data
    expect(
      recipe.lines.map((l) => [l.qty, l.unit, l.packId, l.packName, l.baseQty, l.materialUnit]),
    ).toEqual([
      ['0.5', null, milk.bottle, 'bottle', '500', 'l'],
      ['50', 'ml', null, null, '46', 'kg'],
    ])
    // Nothing bought: no total, and incomplete.
    expect(recipe.cost).toEqual({
      total: null,
      perUnit: null,
      tooLarge: false,
      unpricedLines: 2,
      complete: false,
    })
  })

  it('is versioned: a stale version or a second first save is CONFLICT', async () => {
    const sugar = await material(cafe, { name: `Sugar ${tag()}`, unit: 'kg' })
    const tea = await product(cafe)
    const line = { id: newId(), materialId: sugar.id, qty: '5', unit: 'g' }
    const first = ok(await save(cafe, tea.id, 0, [line])).data
    expect(codeOf(await save(cafe, tea.id, 0, [line]))).toBe('conflict')
    const second = ok(await save(cafe, tea.id, first.version, [{ ...line, qty: '6' }])).data
    expect(second.version).toBe(first.version + 1)
    expect(codeOf(await save(cafe, tea.id, first.version, [{ ...line, qty: '7' }]))).toBe(
      'conflict',
    )
    expect((await recipeOf(cafe, tea.id)).lines[0]?.qty).toBe('6')
    // Taking every line out leaves an empty recipe (no total).
    const empty = ok(await save(cafe, tea.id, second.version, [])).data
    expect(empty.lines).toEqual([])
    expect(empty.cost).toEqual({
      total: null,
      perUnit: null,
      tooLarge: false,
      unpricedLines: 0,
      complete: false,
    })
    const [cost] = await costsOf(cafe, [tea.id])
    expect(cost?.lineCount).toBe(0)
  })

  it('refuses units the material does not have, a pack of another material and zero', async () => {
    const milk = milkInput(`Milk ${tag()}`)
    const milkMaterial = await cafe.material(milk.input)
    const flour = await material(cafe, { name: `Flour ${tag()}`, unit: 'kg' })
    const bread = await product(cafe)
    const line = (extra: object) => ({ id: newId(), materialId: flour.id, qty: '1', ...extra })
    // Litres of flour: no conversion.
    expect(codeOf(await save(cafe, bread.id, 0, [line({ unit: 'l' })]))).toBe('validation')
    // The milk's bottle on the flour's line.
    expect(codeOf(await save(cafe, bread.id, 0, [line({ packId: milk.bottle })]))).toBe(
      'validation',
    )
    expect(codeOf(await save(cafe, bread.id, 0, [line({ unit: 'g', qty: '0' })]))).toBe(
      'validation',
    )
    // One line per material.
    expect(codeOf(await save(cafe, bread.id, 0, [line({ unit: 'g' }), line({ unit: 'kg' })]))).toBe(
      'validation',
    )
    // Nothing was saved.
    expect((await recipeOf(cafe, bread.id)).version).toBe(0)
    expect(milkMaterial.id).toBeTruthy()
  })

  it('a service has materials too (what one hour of the service uses)', async () => {
    const soap = await material(cafe, { name: `Soap ${tag()}`, unit: 'l' })
    const wash = await product(cafe, { name: `Deep clean ${tag()}`, type: 'service', unit: 'h' })
    await cafe.buy(purchaseInput(today, [bought(soap.id, '5', '20', { unit: 'l' })]))
    const recipe = ok(
      await save(cafe, wash.id, 0, [{ id: newId(), materialId: soap.id, qty: '250', unit: 'ml' }]),
    ).data
    expect(recipe.productUnit).toBe('h')
    // 100 for 5 000 ml: 250 ml = 5.
    expect(recipe.cost).toEqual({
      total: '5',
      perUnit: '5',
      tooLarge: false,
      unpricedLines: 0,
      complete: true,
    })
  })

  it('is audited: the recipe row and its lines, with the caller', async () => {
    const salt = await material(cafe, { name: `Salt ${tag()}`, unit: 'kg' })
    const soup = await product(cafe)
    const result = await save(cafe, soup.id, 0, [
      { id: newId(), materialId: salt.id, qty: '2', unit: 'g' },
    ])
    ok(result)
    const rows = await api.admin<{ entity: string; action: string; actor_user_id: string }[]>`
      select entity, action, actor_user_id from app.audit_log
       where request_id = ${result.headers.get('x-request-id') ?? ''} order by id`
    expect(rows.map((r) => `${r.entity} ${r.action}`).sort()).toEqual([
      'recipe_lines insert',
      'recipes insert',
    ])
    for (const row of rows) expect(row.actor_user_id).toBe(cafe.owner.user.id)
  })

  it('writes nothing when nothing changed: same version, no audit row', async () => {
    const pepper = await material(cafe, { name: `Pepper ${tag()}`, unit: 'kg' })
    const oil = await material(cafe, { name: `Oil ${tag()}`, unit: 'l' })
    const salad = await product(cafe)
    const pepperLine = { id: newId(), materialId: pepper.id, qty: '1.50', unit: 'g' }
    const oilLine = { id: newId(), materialId: oil.id, qty: '10', unit: 'ml' }
    const lines = [pepperLine, oilLine]
    const first = ok(await save(cafe, salad.id, 0, lines)).data
    // The same lines ("1.50" and "1.5" are one quantity): nothing to write.
    const again = await save(cafe, salad.id, first.version, [
      { ...pepperLine, qty: '1.5' },
      oilLine,
    ])
    expect(ok(again).data).toEqual(first)
    const rows = await api.admin<{ entity: string }[]>`
      select entity from app.audit_log
       where request_id = ${again.headers.get('x-request-id') ?? ''}`
    expect(rows).toEqual([])
    // A stale version is still CONFLICT, and a new order is a change.
    expect(codeOf(await save(cafe, salad.id, first.version - 1, lines))).toBe('conflict')
    const reordered = ok(await save(cafe, salad.id, first.version, [oilLine, pepperLine])).data
    expect(reordered.version).toBe(first.version + 1)
    expect(reordered.lines.map((l) => l.materialId)).toEqual([oil.id, pepper.id])
  })
})

// The owner's answer of 2026-09-29 (A1, D-178): a recipe can say how many of the product's unit it
// makes; one unit sold costs the recipe's total ÷ that, never rounded (12 decimals), shown rounded.
describe('a recipe that makes several units (yield)', () => {
  let cake: ProductDto
  let lines: object[]

  beforeAll(async () => {
    const flour = await material(cafe, { name: `Flour ${tag()}`, unit: 'kg' })
    const eggs = await material(cafe, { name: `Eggs ${tag()}`, unit: 'piece' })
    const sugar = await material(cafe, { name: `Sugar ${tag()}`, unit: 'kg' })
    const butter = await material(cafe, { name: `Butter ${tag()}`, unit: 'kg' })
    // A 10 kg sack of flour at 50, a tray of 30 eggs at 12, 1 kg of sugar at 4, of butter at 32.
    await cafe.buy(
      purchaseInput(today, [
        bought(flour.id, '10', '5', { unit: 'kg' }),
        bought(eggs.id, '30', '0.4', { unit: 'piece' }),
        bought(sugar.id, '1', '4', { unit: 'kg' }),
        bought(butter.id, '1', '32', { unit: 'kg' }),
      ]),
    )
    cake = await product(cafe, { name: `Chocolate cake slice ${tag()}` })
    lines = [
      { id: newId(), materialId: flour.id, qty: '500', unit: 'g' },
      { id: newId(), materialId: eggs.id, qty: '4', unit: 'piece' },
      { id: newId(), materialId: sugar.id, qty: '200', unit: 'g' },
      { id: newId(), materialId: butter.id, qty: '250', unit: 'g' },
    ]
  })

  it('a cake that makes 12 slices: the whole cake costs 12.9, one slice 1.075 (shown 1.08)', async () => {
    const saved = ok(
      await cafe.run<RecipeResultDto>('recipe.save', {
        productId: cake.id,
        version: 0,
        yieldQty: '12',
        lines,
      }),
    ).data
    expect(saved.yieldQty).toBe('12')
    expect(saved.lines.map((l) => l.cost?.lineCost)).toEqual(['2.5', '1.6', '0.8', '8'])
    expect(saved.cost).toEqual({
      total: '12.9',
      perUnit: '1.075',
      tooLarge: false,
      unpricedLines: 0,
      complete: true,
    })
    expect(await recipeOf(cafe, cake.id)).toEqual(saved)
    const [cost] = await costsOf(cafe, [cake.id])
    expect(cost).toMatchObject({ yieldQty: '12', cost: { total: '12.9', perUnit: '1.075' } })
  })

  it('the yield alone is a new version, audited; the same yield writes nothing; omitted keeps it', async () => {
    const before = await recipeOf(cafe, cake.id)
    // Arabic-Indic digits and trailing zeros are the same yield: nothing to write.
    const same = await cafe.run<RecipeResultDto>('recipe.save', {
      productId: cake.id,
      version: before.version,
      yieldQty: '١٢.000',
      lines,
    })
    expect(ok(same).data).toEqual(before)
    // A yield of 10: 12.9 ÷ 10.
    const ten = await cafe.run<RecipeResultDto>('recipe.save', {
      productId: cake.id,
      version: before.version,
      yieldQty: '10',
      lines,
    })
    const tenData = ok(ten).data
    expect(tenData.version).toBe(before.version + 1)
    expect(tenData.cost.perUnit).toBe('1.29')
    const rows = await api.admin<{ entity: string; action: string; actor_user_id: string }[]>`
      select entity, action, actor_user_id from app.audit_log
       where request_id = ${ten.headers.get('x-request-id') ?? ''}`
    expect(rows.map((r) => `${r.entity} ${r.action}`)).toEqual(['recipes update'])
    expect(rows[0]?.actor_user_id).toBe(cafe.owner.user.id)
    // A save without a yield (a line changed) keeps the recipe's.
    const kept = ok(
      await save(cafe, cake.id, tenData.version, [{ ...lines[0], qty: '600' }, ...lines.slice(1)]),
    ).data
    expect(kept.yieldQty).toBe('10')
    expect(kept.cost.total).toBe('13.4')
    expect(kept.cost.perUnit).toBe('1.34')
    // Back to the cake as the owner wrote it.
    ok(
      await cafe.run<RecipeResultDto>('recipe.save', {
        productId: cake.id,
        version: kept.version,
        yieldQty: '12',
        lines,
      }),
    )
  })

  it('refuses a yield of zero or less, and more decimals than a quantity has', async () => {
    const { version } = await recipeOf(cafe, cake.id)
    for (const yieldQty of ['0', '-12', '0.0000001', 'twelve']) {
      expect(
        codeOf(await cafe.run('recipe.save', { productId: cake.id, version, yieldQty, lines })),
        yieldQty,
      ).toBe('validation')
    }
    expect((await recipeOf(cafe, cake.id)).yieldQty).toBe('12')
  })

  it('a recipe that makes one (the default) costs its total per unit, as before', async () => {
    const tea = await product(cafe)
    const recipe = ok(await save(cafe, tea.id, 0, [{ ...lines[2], id: newId() }])).data
    expect(recipe.yieldQty).toBe('1')
    expect(recipe.cost).toMatchObject({ total: '0.8', perUnit: '0.8' })
    // No recipe yet: it makes one, with no total.
    const empty = await recipeOf(cafe, (await product(cafe)).id)
    expect(empty).toMatchObject({ version: 0, yieldQty: '1' })
    expect(empty.cost).toMatchObject({ total: null, perUnit: null })
  })

  it('an employee reads the quantities and the yield, never a cost (D-179)', async () => {
    const employee = await api.member({ id: cafe.id, owner: cafe.owner }, 'employee')
    const result = await cafe.as<RecipeResultDto>(employee, 'recipe.get', { productId: cake.id })
    const seen = ok(result)
    expect(seen.data.yieldQty).toBe('12')
    expect(seen.data.lines.map((l) => [l.qty, l.unit, l.materialName.startsWith('Flour')])).toEqual(
      [
        ['500', 'g', true],
        ['4', 'piece', false],
        ['200', 'g', false],
        ['250', 'g', false],
      ],
    )
    expect(seen.data.cost).toEqual({ unpricedLines: 0, complete: true })
    expect(seen.meta.redacted).toEqual([
      'cost.perUnit',
      'cost.tooLarge',
      'cost.total',
      'lines.*.cost.lineCost',
      'lines.*.cost.perBaseUnit',
      'lines.*.cost.perUnit',
    ])
    expect(result.raw).not.toContain('1.075')
    expect(result.raw).not.toContain('12.9')
    const costs = ok(await cafe.as<ProductCostsDto>(employee, 'product.costs', { ids: [cake.id] }))
    expect(costs.data.items[0]?.cost).toEqual({ unpricedLines: 0, complete: true })
    // Changing it stays with "change what goes into it".
    expect(
      codeOf(
        await cafe.as(employee, 'recipe.save', {
          productId: cake.id,
          version: seen.data.version,
          yieldQty: '6',
          lines,
        }),
      ),
    ).toBe('forbidden')
  })
})

describe('a material’s units change under a recipe', () => {
  it('works the lines out again, refuses a pack a recipe uses (naming the product) and keeps the kind of measure', async () => {
    const milk = milkInput(`Milk ${tag()}`)
    const milkMaterial = await cafe.material(milk.input)
    const flat = await product(cafe, { name: `Flat white ${tag()}` })
    ok(
      await save(cafe, flat.id, 0, [
        { id: newId(), materialId: milkMaterial.id, qty: '0.5', packId: milk.bottle },
      ]),
    )
    // The bottle becomes 1.5 L: the line's base quantity follows (0.5 bottle = 750 ml).
    const [bottle, carton] = milkMaterial.packs
    const changed = ok(
      await cafe.run<MaterialDto>('material.update', {
        id: milkMaterial.id,
        version: milkMaterial.version,
        name: milkMaterial.name,
        unit: 'l',
        packs: [
          { ...bottle, qty: '1.5' },
          { ...carton, ofUnit: null },
        ],
      }),
    )
    expect((await recipeOf(cafe, flat.id)).lines[0]?.baseQty).toBe('750')

    // Taking the bottle out: the recipe uses it. UNIT_IN_USE, naming the product.
    const refused = await cafe.run('material.update', {
      id: milkMaterial.id,
      version: changed.version,
      name: milkMaterial.name,
      unit: 'l',
      packs: [],
    })
    expect(codeOf(refused)).toBe('unit_in_use')
    expect(refused.error?.data.names).toEqual([flat.name])

    // Another kind of measure: MATERIAL_IN_USE.
    expect(
      codeOf(
        await cafe.run('material.update', {
          id: milkMaterial.id,
          version: changed.version,
          name: milkMaterial.name,
          unit: 'kg',
          packs: [],
        }),
      ),
    ).toBe('material_in_use')
  })

  it('does not name the products to a member who may not see recipes', async () => {
    const roles = ok(await cafe.run<RoleDto[]>('role.list'))
    const manager = roles.find((role) => role.templateKey === 'manager')!
    ok(
      await cafe.run('role.updatePermissions', {
        id: manager.id,
        version: manager.version,
        permissionKeys: manager.permissionKeys.filter((key) => !key.startsWith('products.recipes')),
      }),
    )
    const person: Person = await api.member({ id: cafe.id, owner: cafe.owner }, 'manager')
    const milk = milkInput(`Milk ${tag()}`)
    const milkMaterial = await cafe.material(milk.input)
    const flat = await product(cafe)
    ok(
      await save(cafe, flat.id, 0, [
        { id: newId(), materialId: milkMaterial.id, qty: '1', packId: milk.carton },
      ]),
    )
    const refused = await cafe.as(person, 'material.update', {
      id: milkMaterial.id,
      version: milkMaterial.version,
      name: milkMaterial.name,
      unit: 'l',
      packs: [milkMaterial.packs[0]],
    })
    expect(codeOf(refused)).toBe('unit_in_use')
    expect(refused.error?.data.names).toBeUndefined()
    expect(refused.raw).not.toContain(flat.name)
    expect(codeOf(await cafe.as(person, 'recipe.get', { productId: flat.id }))).toBe('forbidden')
  })
})

describe('an item bought ready to sell (D-117)', () => {
  let shop: Scope
  let water: ProductDto
  let carton: string

  beforeAll(async () => {
    shop = await Scope.open(api, SHOP)
    carton = newId()
    water = await product(shop, {
      name: `Water 500 ml ${tag()}`,
      unit: 'piece',
      defaultPrice: '2',
      resale: {
        materialId: newId(),
        packs: [{ id: carton, name: 'carton', qty: '24', ofUnit: 'piece' }],
      },
    })
  }, 60_000)

  it('is one product and its material, one name, and has no recipe', async () => {
    const context = ok(await shop.run<{ terminologyProfile: string }>('business.context'))
    expect(context.terminologyProfile).toBe('retail')
    expect(water.resaleMaterialId).toBeTruthy()
    const goods = ok(await shop.run<MaterialDto>('material.get', { id: water.resaleMaterialId }))
    expect(goods).toMatchObject({
      name: water.name,
      unit: 'piece',
      resaleProductId: water.id,
    })
    expect(goods.packs.map((p) => [p.name, p.qty])).toEqual([['carton', '24']])
    expect(codeOf(await shop.run('recipe.get', { productId: water.id }))).toBe('validation')
    expect(
      codeOf(
        await save(shop, water.id, 0, [
          { id: newId(), materialId: water.resaleMaterialId, qty: '1', unit: 'piece' },
        ]),
      ),
    ).toBe('validation')
  })

  it('costs its material’s average for one unit sold: no price until bought', async () => {
    const [before] = await costsOf(shop, [water.id])
    expect(before).toEqual({
      productId: water.id,
      kind: 'resale',
      unit: 'piece',
      yieldQty: '1',
      lineCount: 1,
      basis: null,
      cost: { total: null, perUnit: null, tooLarge: false, unpricedLines: 1, complete: false },
    })
    // 3 cartons of 24 at 18: 54 for 72 bottles, 0.75 a bottle.
    await shop.buy(
      purchaseInput(today, [bought(water.resaleMaterialId!, '3', '18', { packId: carton })]),
    )
    const [after] = await costsOf(shop, [water.id])
    expect(after).toMatchObject({
      kind: 'resale',
      basis: 'purchases_90_days',
      cost: { total: '0.75', perUnit: '0.75', tooLarge: false, unpricedLines: 0, complete: true },
    })
  })

  it('renames and archives both together, and stays a product', async () => {
    const renamed = ok(
      await shop.run<ProductDto>('product.update', {
        id: water.id,
        version: water.version,
        name: `${water.name} (still)`,
        type: 'product',
        unit: 'piece',
        defaultPrice: '2',
      }),
    )
    const goods = ok(await shop.run<MaterialDto>('material.get', { id: water.resaleMaterialId }))
    expect(goods.name).toBe(renamed.name)
    expect(
      codeOf(
        await shop.run('product.update', {
          id: water.id,
          version: renamed.version,
          name: renamed.name,
          type: 'service',
          unit: 'piece',
        }),
      ),
    ).toBe('validation')
    ok(await shop.run('product.archive', { id: water.id }))
    const archived = ok(await shop.run<MaterialDto>('material.get', { id: water.resaleMaterialId }))
    expect(archived.archivedAt).not.toBeNull()
    ok(await shop.run('product.unarchive', { id: water.id }))
  })
})

describe('an item bought ready to sell, kept in step from either side (D-117, D-153)', () => {
  let shop: Scope
  let manager: RoleDto
  let person: Person

  /** A new item bought ready to sell, counted in `unit`, with no packs. */
  async function item(unit = 'piece', name = `Item ${tag()}`) {
    return product(shop, { name, unit, resale: { materialId: newId() } })
  }

  async function goodsOf(product: ProductDto) {
    return ok(await shop.run<MaterialDto>('material.get', { id: product.resaleMaterialId }))
  }

  /** The Manager role (the person's) with `drop` taken out and `add` given. */
  async function managerWith(drop: string[], add: string[] = []) {
    const keys = manager.permissionKeys.filter((key) => !drop.includes(key))
    manager = ok(
      await shop.run<RoleDto>('role.updatePermissions', {
        id: manager.id,
        version: manager.version,
        permissionKeys: [...new Set([...keys, ...add])],
      }),
    )
  }

  beforeAll(async () => {
    shop = await Scope.open(api, SHOP)
    const roles = ok(await shop.run<RoleDto[]>('role.list'))
    manager = roles.find((role) => role.templateKey === 'manager')!
    person = await api.member({ id: shop.id, owner: shop.owner }, 'manager')
  }, 60_000)

  it('a new name or unit of its material is its product’s too; archiving either takes both', async () => {
    const soap = await item('l')
    const goods = await goodsOf(soap)
    const renamed = ok(
      await shop.run<MaterialDto>('material.update', {
        id: goods.id,
        version: goods.version,
        name: `${soap.name} (lemon)`,
        unit: 'ml',
        packs: [],
      }),
    )
    const after = ok(await shop.run<ProductDto>('product.get', { id: soap.id }))
    expect(after).toMatchObject({ name: renamed.name, unit: 'ml', version: soap.version + 1 })

    ok(await shop.run('material.archive', { id: goods.id }))
    expect(ok(await shop.run<ProductDto>('product.get', { id: soap.id })).archivedAt).not.toBeNull()
    ok(await shop.run('material.unarchive', { id: goods.id }))
    expect(ok(await shop.run<ProductDto>('product.get', { id: soap.id })).archivedAt).toBeNull()
  })

  it('is made once: a retry returns it, and a name any material has is NAME_TAKEN', async () => {
    const input = {
      id: newId(),
      name: `Juice ${tag()}`,
      type: 'product',
      unit: 'piece',
      resale: { materialId: newId() },
    }
    const made = ok(await shop.run<ProductDto>('product.create', input))
    const again = ok(await shop.run<ProductDto>('product.create', input))
    expect(again).toEqual(made)
    expect(made.resaleMaterialId).toBe(input.resale.materialId)

    // A supply with that name already exists: neither the product nor its material is made.
    const tape = await material(shop, { name: `Tape ${tag()}`, unit: 'piece' })
    const clash = { ...input, id: newId(), name: tape.name, resale: { materialId: newId() } }
    expect(codeOf(await shop.run('product.create', clash))).toBe('name_taken')
    expect(codeOf(await shop.run('product.get', { id: clash.id }))).toBe('not_found')
    expect(codeOf(await shop.run('material.get', { id: clash.resale.materialId }))).toBe(
      'not_found',
    )
  })

  it('keeps its kind of measure once bought (MATERIAL_IN_USE), not before', async () => {
    const rice = await item('kg')
    // Nothing uses it yet: the product and its material both move to litres.
    const inLitres = ok(
      await shop.run<ProductDto>('product.update', {
        id: rice.id,
        version: rice.version,
        name: rice.name,
        type: 'product',
        unit: 'l',
      }),
    )
    expect(await goodsOf(rice)).toMatchObject({ unit: 'l', dimension: 'volume' })
    await shop.buy(purchaseInput(today, [bought(rice.resaleMaterialId!, '10', '4', { unit: 'l' })]))
    expect(
      codeOf(
        await shop.run('product.update', {
          id: rice.id,
          version: inLitres.version,
          name: rice.name,
          type: 'product',
          unit: 'kg',
        }),
      ),
    ).toBe('material_in_use')
    expect(await goodsOf(rice)).toMatchObject({ unit: 'l', dimension: 'volume' })
    // The same kind of measure stays open: 1 unit sold is now 1 ml.
    ok(
      await shop.run('product.update', {
        id: rice.id,
        version: inLitres.version,
        name: rice.name,
        type: 'product',
        unit: 'ml',
      }),
    )
    const [cost] = await costsOf(shop, [rice.id])
    expect(cost).toMatchObject({ unit: 'ml', cost: { total: '0.004', complete: true } })
  })

  it('changing the pair needs both permissions: products and materials', async () => {
    const tea = await item()
    const goods = await goodsOf(tea)

    // May add products, not materials: no item bought ready to sell, no new name, no archiving.
    await managerWith(['materials.items.manage'])
    expect(
      codeOf(
        await shop.as(person, 'product.create', {
          id: newId(),
          name: `Tea ${tag()}`,
          type: 'product',
          unit: 'piece',
          resale: { materialId: newId() },
        }),
      ),
    ).toBe('forbidden')
    const rename = {
      id: tea.id,
      version: tea.version,
      name: `${tea.name} (green)`,
      type: 'product',
      unit: 'piece',
    }
    expect(codeOf(await shop.as(person, 'product.update', rename))).toBe('forbidden')
    expect(codeOf(await shop.as(person, 'product.archive', { id: tea.id }))).toBe('forbidden')
    // Its price alone is the product's.
    ok(await shop.as(person, 'product.update', { ...rename, name: tea.name, defaultPrice: '3' }))

    // May change materials, not products: its material keeps the product's name and stays active.
    await managerWith(['products.items.manage'], ['materials.items.manage'])
    const current = await goodsOf(tea)
    expect(
      codeOf(
        await shop.as(person, 'material.update', {
          id: goods.id,
          version: current.version,
          name: `${tea.name} (black)`,
          unit: 'piece',
          packs: [],
        }),
      ),
    ).toBe('forbidden')
    expect(codeOf(await shop.as(person, 'material.archive', { id: goods.id }))).toBe('forbidden')
    expect(await goodsOf(tea)).toMatchObject({ name: tea.name, archivedAt: null })
    expect(ok(await shop.run<ProductDto>('product.get', { id: tea.id }))).toMatchObject({
      name: tea.name,
      archivedAt: null,
      defaultPrice: '3',
    })
  })
})

describe('who sees product costs', () => {
  it('Supervisor sees the recipe and its quantities without any cost; Sales sees neither', async () => {
    const milk = milkInput(`Milk ${tag()}`)
    const milkMaterial = await cafe.material(milk.input)
    const latte = await product(cafe)
    await cafe.buy(
      purchaseInput(today, [bought(milkMaterial.id, '1', '72', { packId: milk.carton })]),
    )
    ok(
      await save(cafe, latte.id, 0, [
        { id: newId(), materialId: milkMaterial.id, qty: '200', unit: 'ml' },
      ]),
    )
    const supervisor = await api.member({ id: cafe.id, owner: cafe.owner }, 'supervisor')
    const seen = ok(
      await cafe.as<RecipeResultDto>(supervisor, 'recipe.get', { productId: latte.id }),
    )
    expect(seen.data.lines[0]).toMatchObject({ qty: '200', unit: 'ml', baseQty: '200' })
    expect(seen.data.lines[0]?.cost).toEqual({ basis: 'purchases_90_days' })
    expect(seen.data.cost).toEqual({ unpricedLines: 0, complete: true })
    expect(seen.meta.redacted).toEqual([
      'cost.perUnit',
      'cost.tooLarge',
      'cost.total',
      'lines.*.cost.lineCost',
      'lines.*.cost.perBaseUnit',
      'lines.*.cost.perUnit',
    ])
    const sales = await api.member({ id: cafe.id, owner: cafe.owner }, 'sales')
    expect(codeOf(await cafe.as(sales, 'recipe.get', { productId: latte.id }))).toBe('forbidden')
    expect(codeOf(await cafe.as(sales, 'product.costs', { ids: [latte.id] }))).toBe('forbidden')
    expect(
      codeOf(
        await cafe.as(supervisor, 'recipe.save', { productId: latte.id, version: 1, lines: [] }),
      ),
    ).toBe('forbidden')
  })
})
