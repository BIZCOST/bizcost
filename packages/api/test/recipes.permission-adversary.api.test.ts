import type { MaterialDto, ProductDto, RecipeResultDto, RoleDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeOf, ok, purchaseInput, PurchasingApi, Scope, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// Security and costing review of M2 Step 4 (second pass), the adversary's findings. Each test states
// the secure outcome and fails while the issue stands.
//
//   1. products.recipes.view needs only products.items.view (PERMISSION_NEEDS, D-149), so
//      role.updatePermissions accepts a role that may see recipes and costs but not materials. Such a
//      member is refused material.get and material.costs (materials.items.view), yet recipe.get hands
//      them every material of a recipe, its packs and its average (perUnit, perBaseUnit, and lineCost
//      over the visible baseQty): the numbers material.costs refuses them.

let api: PurchasingApi
let a: Scope
let today: string
let employee: Person

beforeAll(async () => {
  api = new PurchasingApi()
  a = await Scope.open(api, WORKSHOP)
  today = await a.today()
  employee = await api.member({ id: a.id, owner: a.owner }, 'employee')
}, 60_000)

afterAll(async () => {
  await api.close()
})

describe('a role that may see recipes and costs but not materials', () => {
  it('does not read a material’s average through a recipe', async () => {
    const roles = ok(await a.run<RoleDto[]>('role.list'))
    const role = roles.find((r) => r.templateKey === 'employee')
    if (!role) throw new Error('no employee role')
    // The owner lets Employee see what goes into each product and its costs, not the materials.
    const saved = await a.run<RoleDto>('role.updatePermissions', {
      id: role.id,
      version: role.version,
      permissionKeys: [
        'dashboard.home.view',
        'products.items.view',
        'products.recipes.view',
        'data.cost.view',
        'data.supplier_price.view',
      ],
    })

    const beans = ok(
      await a.run<MaterialDto>('material.create', {
        id: newId(),
        name: `Beans ${newId().slice(-10)}`,
        unit: 'kg',
      }),
    )
    await a.buy(
      purchaseInput(today, [
        {
          kind: 'material',
          id: newId(),
          materialId: beans.id,
          qty: '1',
          unit: 'kg',
          unitPrice: '60',
        },
      ]),
    )
    const latte = ok(
      await a.run<ProductDto>('product.create', {
        id: newId(),
        name: `Latte ${newId().slice(-10)}`,
        type: 'product',
        unit: 'piece',
      }),
    )
    ok(
      await a.run<RecipeResultDto>('recipe.save', {
        productId: latte.id,
        version: 0,
        lines: [{ id: newId(), materialId: beans.id, qty: '18', unit: 'g' }],
      }),
    )

    // Refused outright: the combination is not a role anyone can hold.
    if (codeOf(saved) === 'validation') return
    expect(saved.error, saved.raw).toBeUndefined()

    // The premise: the member may not see the material or its average.
    expect(codeOf(await a.as(employee, 'material.get', { id: beans.id }))).toBe('forbidden')
    expect(codeOf(await a.as(employee, 'material.costs', { ids: [beans.id] }))).toBe('forbidden')

    const recipe = await a.as<RecipeResultDto>(employee, 'recipe.get', { productId: latte.id })
    if (codeOf(recipe) === 'forbidden') return // refused outright: nothing learnt
    const line = ok(recipe).data.lines[0]
    // What the member reads today: the beans' name, and their average per kg (60), per g (0.06)
    // and the line's cost (1.08 for the visible 18 g, so 0.06 per g again).
    expect({
      perUnit: line?.cost?.perUnit,
      perBaseUnit: line?.cost?.perBaseUnit,
      lineCost: line?.cost?.lineCost,
    }).toEqual({ perUnit: undefined, perBaseUnit: undefined, lineCost: undefined })
  })
})

describe('a member whose own overrides take the materials away', () => {
  it('is refused recipes and product costs (D-155)', async () => {
    // Manager sees recipes, materials and costs; a deny override (stored per member, no screen yet)
    // takes materials.items.view away from this one member only.
    const manager = await api.member({ id: a.id, owner: a.owner }, 'manager')
    const [member] = await api.admin<{ id: string }[]>`
      select id from app.business_members
      where business_id = ${a.id} and user_id = ${manager.user.id} and deleted_at is null`
    if (!member) throw new Error('no member')
    await api.admin`
      insert into app.member_permission_overrides
        (id, business_id, member_id, permission_key, effect, created_by)
      values (${newId()}, ${a.id}, ${member.id}, 'materials.items.view', 'deny', ${a.owner.user.id})`

    const product = ok(
      await a.run<ProductDto>('product.create', {
        id: newId(),
        name: `Mocha ${newId().slice(-10)}`,
        type: 'product',
        unit: 'piece',
      }),
    )
    expect(codeOf(await a.as(manager, 'material.costs', { ids: [] }))).toBe('forbidden')
    expect(codeOf(await a.as(manager, 'recipe.get', { productId: product.id }))).toBe('forbidden')
    expect(
      codeOf(await a.as(manager, 'recipe.save', { productId: product.id, version: 0, lines: [] })),
    ).toBe('forbidden')
    expect(codeOf(await a.as(manager, 'product.costs', { ids: [product.id] }))).toBe('forbidden')
  })
})
