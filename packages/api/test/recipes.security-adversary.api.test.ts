import type { MaterialDto, ProductCostsDto, ProductDto, RecipeResultDto } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  connectAdmin,
  connectApi,
  handlerFor,
  mutate,
  SECRET_KEY,
  type Admin,
  type CallResult,
} from './helpers'
import {
  codeOf,
  ok,
  purchaseInput,
  PurchasingApi,
  Scope,
  type Handler,
  type Person,
} from './purchasing'
import { WORKSHOP } from './settings'

// Security and costing review of M2 Step 4 (recipes / product cost), the adversary's findings. Each
// test states the secure outcome and fails while the issue stands.
//
//   1. product.costs needs only products.items.view (every template, Sales and Employee included),
//      and only its totals are `cost`. A member who may not see what goes into a product
//      (products.recipes.view: recipe.get is FORBIDDEN) nor any cost reads, for every product, how many
//      materials its recipe has (lineCount), how many of them were never bought (unpricedLines,
//      complete) and, for an item bought ready to sell, whether and when it was bought (basis:
//      within 90 days, only earlier, never): purchasing facts the member has no permission to see.
//   2. recipe.save locks FOR SHARE only the materials its lines name NOW. A line moved from material X
//      to material Y leaves X unlocked, so material.update(X) runs alongside it: its recompute of X's
//      recipe lines (D-148) reads the line as it was (still X, uncommitted move), converts it with X's
//      units, and its UPDATE matches the line by id alone. Once the save commits, that UPDATE goes
//      through and writes an X base quantity onto a line that now names Y (grams onto a millilitre
//      line): the recipe says 200 ml, its base quantity (and so its cost) says 500.

let api: PurchasingApi
let a: Scope
let today: string
let sales: Person

beforeAll(async () => {
  api = new PurchasingApi()
  a = await Scope.open(api, WORKSHOP)
  today = await a.today()
  // Sales may not see what goes into a product (Employee may since the owner's answers of
  // 2026-09-29, D-179: its quantities, without costs).
  sales = await api.member({ id: a.id, owner: a.owner }, 'sales')
}, 60_000)

afterAll(async () => {
  await api.close()
})

async function material(unit: string, extra: object = {}): Promise<MaterialDto> {
  return ok(
    await a.run<MaterialDto>('material.create', {
      id: newId(),
      name: `Material ${newId().slice(-10)}`,
      unit,
      ...extra,
    }),
  )
}

async function product(extra: object = {}): Promise<ProductDto> {
  return ok(
    await a.run<ProductDto>('product.create', {
      id: newId(),
      name: `Product ${newId().slice(-10)}`,
      type: 'product',
      unit: 'piece',
      ...extra,
    }),
  )
}

function materialLine(materialId: string, qty: string, unitPrice: string, unit: object) {
  return { kind: 'material', id: newId(), materialId, qty, unitPrice, ...unit }
}

describe('product.costs and members who may see neither recipes nor costs', () => {
  it('Sales and Employee do not learn a recipe’s size or which of its materials were bought', async () => {
    const beans = await material('kg')
    const milk = await material('l')
    const cup = await material('piece')
    const latte = await product()
    ok(
      await a.run<RecipeResultDto>('recipe.save', {
        productId: latte.id,
        version: 0,
        lines: [
          { id: newId(), materialId: beans.id, qty: '18', unit: 'g' },
          { id: newId(), materialId: milk.id, qty: '200', unit: 'ml' },
          { id: newId(), materialId: cup.id, qty: '1', unit: 'piece' },
        ],
      }),
    )
    // Only the beans were bought.
    await a.buy(purchaseInput(today, [materialLine(beans.id, '1', '60', { unit: 'kg' })]))
    // Bought ready to sell, bought once.
    const cola = await product({ resale: { materialId: newId() } })
    await a.buy(
      purchaseInput(today, [materialLine(cola.resaleMaterialId!, '24', '1.5', { unit: 'piece' })]),
    )

    for (const [template, person] of [['sales', sales]] as const) {
      // The premise: the member may not see what goes into a product.
      expect(codeOf(await a.as(person, 'recipe.get', { productId: latte.id })), template).toBe(
        'forbidden',
      )
      const result = await a.as<ProductCostsDto>(person, 'product.costs', {
        ids: [latte.id, cola.id],
      })
      if (codeOf(result) === 'forbidden') continue // refused outright: nothing learnt
      const [recipe, resale] = ok(result).data.items
      // What the member reads today: lineCount 3, unpricedLines 2, complete false for the latte;
      // basis 'purchases_90_days', complete true for the cola.
      expect(
        {
          lineCount: recipe?.lineCount,
          unpricedLines: recipe?.cost.unpricedLines,
          complete: recipe?.cost.complete,
          resaleBasis: resale?.basis,
          resaleComplete: resale?.cost.complete,
        },
        template,
      ).toEqual({
        lineCount: undefined,
        unpricedLines: undefined,
        complete: undefined,
        resaleBasis: undefined,
        resaleComplete: undefined,
      })
    }
  })
})

describe('a recipe line moved to another material while the old one’s units change (D-148)', () => {
  let dbs: Db[]
  let handlers: Handler[]
  let holder: Admin

  beforeAll(() => {
    dbs = [connectApi(), connectApi()]
    handlers = dbs.map((db) => handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY }))
    holder = connectAdmin()
  })

  afterAll(async () => {
    await holder.end()
    for (const db of dbs) await db.$client.end()
  })

  /** A mutation as the owner on API instance `i` (each instance has its own connection). */
  function on<T>(i: number, path: string, input: object): Promise<CallResult<T>> {
    return mutate<T>(handlers[i]!, path, { token: a.owner.token, businessId: a.id, input })
  }

  /**
   * Waits until at least `backends` backends are blocked on a lock while running a statement like
   * `pattern`.
   */
  async function waitForLockWait(pattern: string, backends = 1) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const [row] = await api.admin<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where wait_event_type = 'Lock' and query ilike ${pattern}`
      if ((row?.n ?? 0) >= backends) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`nothing waited on a lock for ${pattern}`)
  }

  /**
   * Holds an uncommitted recipe_lines row with id `lineId` (triggers off, so no FK or audit) until
   * `release()`, then rolls it back: a save that adds a line with that id waits at its INSERT, after
   * it has updated the lines it keeps. This only lengthens the window between the save's UPDATE of a
   * moved line and its COMMIT, which the save already leaves open (it reads the costs back after).
   */
  async function holdLineId(lineId: string) {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let taken!: () => void
    const held = new Promise<void>((resolve) => {
      taken = resolve
    })
    const rollback = new Error('rollback')
    const done = holder
      .begin(async (sql) => {
        await sql`set local session_replication_role = replica`
        await sql`
          insert into app.recipe_lines
            (id, business_id, recipe_id, position, material_id, qty, unit, base_qty, created_by)
          values (${lineId}, ${a.id}, ${newId()}, 0, ${newId()}, 1, 'g', 1, ${a.owner.user.id})`
        taken()
        await released
        throw rollback
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error
      })
    await held
    return {
      release: async () => {
        release()
        await done
      },
    }
  }

  it('keeps each line’s base quantity in the units of the material it names', async () => {
    const bag = newId()
    const beans = await material('kg', {
      packs: [{ id: bag, name: 'bag', qty: '1', ofUnit: 'kg' }],
    })
    const milk = await material('l')
    const cup = await material('piece')
    const latte = await product()
    const lineId = newId()
    const first = ok(
      await a.run<RecipeResultDto>('recipe.save', {
        productId: latte.id,
        version: 0,
        lines: [{ id: lineId, materialId: beans.id, qty: '1', packId: bag }],
      }),
    ).data
    expect(first.lines[0]?.baseQty).toBe('1000')

    // The recipe's author changes the line from 1 bag of beans to 200 ml of milk and adds a cup.
    const cupLine = newId()
    const lock = await holdLineId(cupLine)
    const saving = on<RecipeResultDto>(0, 'recipe.save', {
      productId: latte.id,
      version: first.version,
      lines: [
        { id: lineId, materialId: milk.id, qty: '200', unit: 'ml' },
        { id: cupLine, materialId: cup.id, qty: '1', unit: 'piece' },
      ],
    })
    await waitForLockWait('%insert into "app"."recipe_lines"%')

    // Meanwhile another member makes the beans' bag 0.5 kg: beans are not locked by the save (the
    // line no longer names them), and the recompute finds the line still on beans.
    const changing = on<MaterialDto>(1, 'material.update', {
      id: beans.id,
      version: beans.version,
      name: beans.name,
      unit: 'kg',
      packs: [{ id: bag, name: 'bag', qty: '0.5', ofUnit: 'kg' }],
    })
    // The update waits on the moved line's row (the save holds it), whichever statement of its
    // recompute reads or writes it: two backends now wait on recipe_lines.
    await waitForLockWait('%"app"."recipe_lines"%', 2)
    await lock.release()
    const saved = await saving
    const changed = await changing
    expect(saved.error, saved.raw).toBeUndefined()

    const after = ok(await a.run<RecipeResultDto>('recipe.get', { productId: latte.id })).data
    const moved = after.lines.find((l) => l.id === lineId)
    // Secure outcomes: the material change is refused (UNIT_IN_USE/CONFLICT) or it goes through; either
    // way the line on milk holds 200 ml. Today it holds 500: half a kilogram bag of beans, in grams.
    expect({
      materialId: moved?.materialId,
      qty: moved?.qty,
      unit: moved?.unit,
      baseQty: moved?.baseQty,
      update: ['ok', 'unit_in_use', 'conflict'].includes(codeOf(changed) ?? 'ok'),
    }).toEqual({
      materialId: milk.id,
      qty: '200',
      unit: 'ml',
      baseQty: '200',
      update: true,
    })
  })
})
