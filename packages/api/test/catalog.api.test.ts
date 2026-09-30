import type {
  BusinessContextDto,
  CustomizationDto,
  LocationDto,
  MaterialDto,
  MaterialListDto,
  ProductDto,
  ProductListDto,
  RoleDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../src'
import {
  connectAdmin,
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  query,
  type Admin,
  type CallResult,
  type TestUser,
} from './helpers'
import { appCode, BAKER, join, setupBusiness, WORKSHOP } from './settings'

// Materials and Products & Services through the real fetch handler (ROADMAP.md M2 Step 2; D-121–
// D-125): the module gate (released with the Costing Core in Step 7, no preview needed), the
// permission keys of each role template, the owner's carton example with its units checked by the
// domain engine, idempotent creates, versions, names, archiving, lists with search and cursors, and
// where a product is sold. The database is checked as postgres.

let db: Db
let admin: Admin
/** The API as released code has it (the Costing Core is released since M2 Step 7). */
let handler: ReturnType<typeof handlerFor>
const users: TestUser[] = []

beforeAll(() => {
  db = connectApi()
  admin = connectAdmin()
  handler = handlerFor(db)
})

afterAll(async () => {
  for (const user of users) await deleteUser(user)
  await admin.end()
  await db.$client.end()
})

async function newUser() {
  const user = await createUser({ locale: 'en' })
  users.push(user)
  return { user, token: await mintToken(user) }
}

type Person = Awaited<ReturnType<typeof newUser>>

const procedures = appRouter._def.procedures as unknown as Record<
  string,
  { _def: { type: string } }
>

/** Calls a procedure of the previewing API: GET for a query, POST for a mutation. */
function call<T>(person: Person, businessId: string, path: string, input?: unknown) {
  const run = procedures[path]?._def.type === 'query' ? query<T> : mutate<T>
  return run(handler, path, { token: person.token, businessId, input })
}

function ok<T>(result: CallResult<T>): T {
  expect(result.error, result.raw).toBeUndefined()
  return result.data as T
}

/** The owner's example (PRODUCT.md §4.8): 1 carton = 12 bottles, 1 bottle = 1 L. */
function milk(name = `Milk ${newId().slice(-8)}`) {
  const bottle = newId()
  return {
    id: newId(),
    name,
    unit: 'l',
    packs: [
      { id: bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
      { id: newId(), name: 'carton', qty: '12', ofPackId: bottle },
    ],
  }
}

let owner: Person
let businessId: string
const team = {} as Record<Exclude<RoleTemplateKey, 'owner'>, Person>

beforeAll(async () => {
  owner = await newUser()
  businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Catalog Workshop' })
  for (const template of [
    'admin',
    'manager',
    'accountant',
    'sales',
    'supervisor',
    'employee',
  ] as const) {
    const member = await newUser()
    await join(db, owner.user, businessId, member.user, template)
    team[template] = member
  }
}, 60_000)

describe('the module gate', () => {
  it('released code serves both modules, without the dev-only preview', async () => {
    for (const path of ['material.list', 'product.list']) {
      const result = await query(handler, path, { token: owner.token, businessId })
      expect(result.error, path).toBeUndefined()
    }
  })

  it('both modules are in the nav and in Customize BizCost, as released', async () => {
    const context = ok(await call<BusinessContextDto>(owner, businessId, 'business.context'))
    expect(
      context.modules
        .filter((m) => m.id === 'products' || m.id === 'materials')
        .map((m) => [m.id, m.nav.map((e) => e.path)]),
    ).toEqual([
      ['products', ['products']],
      ['materials', ['materials']],
    ])
    const customization = ok(
      await call<CustomizationDto>(owner, businessId, 'business.customization'),
    )
    const availability = (id: string) => customization.modules.find((m) => m.id === id)
    expect(availability('materials')).toMatchObject({ availability: 'released', enabled: true })
    expect(availability('orders')?.availability).toBe('planned')
  })

  it('a business that turned the module off gets MODULE_DISABLED; turning it on again brings it back', async () => {
    const other = await newUser()
    const id = await setupBusiness(handler, other.token, WORKSHOP)
    const toggle = (enabled: boolean) =>
      call(other, id, 'business.customize', { item: { kind: 'module', id: 'materials' }, enabled })
    ok(await toggle(false))
    expect(appCode(await call(other, id, 'material.list'))).toBe('module_disabled')
    expect(
      ok(await call<BusinessContextDto>(other, id, 'business.context')).modules.map((m) => m.id),
    ).not.toContain('materials')
    ok(await toggle(true))
    expect(ok(await call<MaterialListDto>(other, id, 'material.list')).items).toEqual([])
  })
})

describe('permissions of the role templates (D-124)', () => {
  // Employee sees materials since the owner's answers of 2026-09-29 (what goes into each product
  // names them, D-155, D-179).
  const VIEW = {
    materials: ['admin', 'manager', 'accountant', 'supervisor', 'employee'],
    products: ['admin', 'manager', 'accountant', 'sales', 'supervisor', 'employee'],
  }
  const MANAGE = ['admin', 'manager']

  it('each template reads and writes exactly what PRODUCT.md §8 gives it', async () => {
    for (const [template, person] of Object.entries(team)) {
      const materials = await call(person, businessId, 'material.list')
      expect(appCode(materials) ?? 'ok', `${template} material.list`).toBe(
        VIEW.materials.includes(template) ? 'ok' : 'forbidden',
      )
      const products = await call(person, businessId, 'product.list')
      expect(appCode(products) ?? 'ok', `${template} product.list`).toBe(
        VIEW.products.includes(template) ? 'ok' : 'forbidden',
      )
      const material = await call(person, businessId, 'material.create', milk())
      expect(appCode(material) ?? 'ok', `${template} material.create`).toBe(
        MANAGE.includes(template) ? 'ok' : 'forbidden',
      )
      const product = await call(person, businessId, 'product.create', {
        id: newId(),
        name: `Tea ${newId()}`,
        type: 'product',
        unit: 'piece',
      })
      expect(appCode(product) ?? 'ok', `${template} product.create`).toBe(
        MANAGE.includes(template) ? 'ok' : 'forbidden',
      )
    }
  })

  it('Smart Setup copied the templates with their new keys', async () => {
    const roles = ok(await call<RoleDto[]>(owner, businessId, 'role.list'))
    for (const template of ROLE_TEMPLATES.filter((t) => !t.allPermissions)) {
      const role = roles.find((r) => r.templateKey === template.key)
      expect([...(role?.permissionKeys ?? [])].sort(), template.key).toEqual(
        [...template.permissionKeys].sort(),
      )
    }
  })

  it('Sales sees Products & Services in the nav, and Materials with no entry; Employee both', async () => {
    const navOf = async (person: Person) =>
      Object.fromEntries(
        ok(await call<BusinessContextDto>(person, businessId, 'business.context')).modules.map(
          (m) => [m.id, m.nav.length],
        ),
      )
    expect(await navOf(team.sales)).toMatchObject({ products: 1, materials: 0 })
    expect(await navOf(team.employee)).toMatchObject({ products: 1, materials: 1 })
  })
})

describe('materials', () => {
  it('saves the owner’s carton example, with Arabic digits, and reads it back', async () => {
    const input = milk()
    const created = ok(
      await call<MaterialDto>(owner, businessId, 'material.create', {
        ...input,
        name: `  ${input.name} `,
        packs: [input.packs[0], { ...input.packs[1], qty: '١٢' }],
        crossFactors: [{ id: newId(), unit: 'kg', qty: '0.97', ofUnit: 'l' }],
      }),
    )
    expect(created).toMatchObject({
      id: input.id,
      name: input.name,
      dimension: 'volume',
      unit: 'l',
      archivedAt: null,
      version: 1,
    })
    expect(created.packs).toEqual([
      { id: input.packs[0]?.id, name: 'bottle', qty: '1', ofUnit: 'l', ofPackId: null },
      {
        id: input.packs[1]?.id,
        name: 'carton',
        qty: '12',
        ofUnit: null,
        ofPackId: input.packs[0]?.id,
      },
    ])
    expect(created.crossFactors).toEqual([
      expect.objectContaining({ unit: 'kg', qty: '0.97', ofUnit: 'l' }),
    ])
    expect(
      ok(await call<MaterialDto>(owner, businessId, 'material.get', { id: input.id })),
    ).toEqual(created)
    const [row] = await admin<{ qty: string }[]>`
      select qty::text from app.material_units where id = ${input.packs[1]?.id ?? ''}`
    expect(row?.qty).toBe('12.000000000000')
  })

  it('is idempotent on the client’s id; another payload with that id is CONFLICT', async () => {
    const input = milk()
    const first = ok(await call<MaterialDto>(owner, businessId, 'material.create', input))
    const again = ok(await call<MaterialDto>(owner, businessId, 'material.create', input))
    expect(again).toEqual(first)
    const [units] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.material_units where material_id = ${input.id}`
    expect(units?.n).toBe(2)
    const other = await call(owner, businessId, 'material.create', { ...input, name: 'Other' })
    expect(appCode(other)).toBe('conflict')
  })

  it('refuses units the domain engine refuses (VALIDATION), and saves nothing', async () => {
    const loop = newId()
    const cases = [
      // A loop: 1 box = 2 crates, 1 crate = 3 boxes.
      [
        { id: loop, name: 'box', qty: '2', ofPackId: newId() },
        { id: newId(), name: 'crate', qty: '3', ofPackId: loop },
      ],
      // A pack of another dimension without a cross factor (milk is kept in ml).
      [{ id: newId(), name: 'bag', qty: '1', ofUnit: 'kg' }],
      // Two packs with one name, ignoring case.
      [
        { id: newId(), name: 'Box', qty: '1', ofUnit: 'l' },
        { id: newId(), name: 'box', qty: '2', ofUnit: 'l' },
      ],
      // Both a unit and a pack, or a quantity of zero.
      [{ id: newId(), name: 'tray', qty: '1', ofUnit: 'l', ofPackId: newId() }],
      [{ id: newId(), name: 'drop', qty: '0', ofUnit: 'ml' }],
    ]
    for (const packs of cases) {
      const input = { ...milk(), packs }
      const result = await call(owner, businessId, 'material.create', input)
      expect(appCode(result), JSON.stringify(packs)).toBe('validation')
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from app.materials where id = ${input.id}`
      expect(row?.n).toBe(0)
    }
    // A cross factor makes the other dimension usable: 1 bag = 1 kg, 1 kg = 0.97 l.
    ok(
      await call(owner, businessId, 'material.create', {
        ...milk(),
        packs: [{ id: newId(), name: 'bag', qty: '1', ofUnit: 'kg' }],
        crossFactors: [{ id: newId(), unit: 'kg', qty: '0.97', ofUnit: 'l' }],
      }),
    )
  })

  it('updates the whole material by version: units added, changed and taken out (soft-deleted)', async () => {
    const input = milk()
    const created = ok(await call<MaterialDto>(owner, businessId, 'material.create', input))
    const [bottle, carton] = created.packs
    const tray = newId()
    const updated = ok(
      await call<MaterialDto>(owner, businessId, 'material.update', {
        id: input.id,
        version: created.version,
        name: `${input.name} (fresh)`,
        unit: 'ml',
        packs: [
          { ...bottle, qty: '1000', ofUnit: 'ml', ofPackId: null },
          { id: tray, name: 'tray', qty: '6', ofPackId: bottle?.id },
        ],
      }),
    )
    expect(updated.version).toBe(created.version + 1)
    expect(updated.unit).toBe('ml')
    expect(updated.packs.map((p) => [p.name, p.qty])).toEqual([
      ['bottle', '1000'],
      ['tray', '6'],
    ])
    const [removed] = await admin<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from app.material_units where id = ${carton?.id ?? ''}`
    expect(removed?.deleted).toBe(true)

    // The version read before is stale now; a material of no business is NOT_FOUND.
    const stale = await call(owner, businessId, 'material.update', { ...input, version: 1 })
    expect(appCode(stale)).toBe('conflict')
    const missing = await call(owner, businessId, 'material.update', { ...milk(), version: 1 })
    expect(appCode(missing)).toBe('not_found')
    // A dimension change must still fit every pack (a litre bottle is not a mass).
    const wrongDimension = await call(owner, businessId, 'material.update', {
      id: input.id,
      version: updated.version,
      name: updated.name,
      unit: 'kg',
      packs: updated.packs,
    })
    expect(appCode(wrongDimension)).toBe('validation')
    // A pack cannot become a cross factor under the same id.
    const kind = await call(owner, businessId, 'material.update', {
      id: input.id,
      version: updated.version,
      name: updated.name,
      unit: 'ml',
      packs: updated.packs.filter((p) => p.name === 'bottle'),
      crossFactors: [{ id: tray, unit: 'g', qty: '1', ofUnit: 'ml' }],
    })
    expect(appCode(kind)).toBe('validation')
  })

  it('keeps one name per business, ignoring case, archived ones included (NAME_TAKEN)', async () => {
    const name = `Sugar ${newId().slice(-8)}`
    const first = ok(
      await call<MaterialDto>(owner, businessId, 'material.create', { ...milk(), name }),
    )
    const twin = await call(owner, businessId, 'material.create', {
      ...milk(),
      name: name.toUpperCase(),
    })
    expect(appCode(twin)).toBe('name_taken')
    ok(await call(owner, businessId, 'material.archive', { id: first.id }))
    const again = await call(owner, businessId, 'material.create', { ...milk(), name })
    expect(appCode(again)).toBe('name_taken')
    const other = ok(await call<MaterialDto>(owner, businessId, 'material.create', milk()))
    const rename = await call(owner, businessId, 'material.update', {
      id: other.id,
      version: other.version,
      name: name.toLowerCase(),
      unit: other.unit,
      packs: other.packs,
    })
    expect(appCode(rename)).toBe('name_taken')
    // Another business may use it.
    const neighbour = await newUser()
    const neighbourId = await setupBusiness(handler, neighbour.token, WORKSHOP)
    ok(await call(neighbour, neighbourId, 'material.create', { ...milk(), name }))
  })

  it('archives and unarchives (never deletes); lists page by name with search and status', async () => {
    const other = await newUser()
    const id = await setupBusiness(handler, other.token, WORKSHOP)
    const names = ['Cardamom', 'cinnamon', 'Cocoa 100%', 'Coffee_beans', 'Dates', 'حليب']
    const made: MaterialDto[] = []
    for (const name of names) {
      made.push(ok(await call<MaterialDto>(other, id, 'material.create', { ...milk(), name })))
    }
    const dates = made[4]
    const archived = ok(
      await call<MaterialDto>(other, id, 'material.archive', { id: dates?.id ?? '' }),
    )
    expect(archived.archivedAt).not.toBeNull()
    expect(archived.version).toBe((dates?.version ?? 0) + 1)
    // Archiving twice changes nothing.
    expect(ok(await call<MaterialDto>(other, id, 'material.archive', { id: dates?.id }))).toEqual(
      archived,
    )

    const list = async (input: object) =>
      ok(await call<MaterialListDto>(other, id, 'material.list', input))
    const page1 = await list({ limit: 2 })
    expect(page1.items.map((m) => m.name)).toEqual(['Cardamom', 'cinnamon'])
    const page2 = await list({ limit: 2, cursor: page1.nextCursor })
    expect(page2.items.map((m) => m.name)).toEqual(['Cocoa 100%', 'Coffee_beans'])
    const page3 = await list({ limit: 2, cursor: page2.nextCursor })
    expect(page3.items.map((m) => m.name)).toEqual(['حليب'])
    expect(page3.nextCursor).toBeNull()
    expect(page1.items[0]?.packs).toHaveLength(2)

    expect((await list({ search: 'CO' })).items.map((m) => m.name)).toEqual([
      'Cocoa 100%',
      'Coffee_beans',
    ])
    // % and _ are plain characters in a search.
    expect((await list({ search: '%' })).items.map((m) => m.name)).toEqual(['Cocoa 100%'])
    expect((await list({ search: '_' })).items.map((m) => m.name)).toEqual(['Coffee_beans'])
    expect((await list({ search: 'حل' })).items.map((m) => m.name)).toEqual(['حليب'])
    expect((await list({ status: 'archived' })).items.map((m) => m.name)).toEqual(['Dates'])
    expect((await list({ status: 'all' })).items).toHaveLength(6)

    ok(await call(other, id, 'material.unarchive', { id: dates?.id }))
    expect((await list({})).items).toHaveLength(6)
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.materials where business_id = ${id} and deleted_at is null`
    expect(row?.n).toBe(6)

    const badCursor = await call(other, id, 'material.list', { cursor: 'not-a-cursor' })
    expect(appCode(badCursor)).toBe('validation')
    expect(appCode(await call(other, id, 'material.get', { id: newId() }))).toBe('not_found')
    expect(appCode(await call(other, id, 'material.archive', { id: newId() }))).toBe('not_found')
  })
})

describe('products & services', () => {
  it('saves a product with its price, VAT setting and locations; reads it back', async () => {
    const locations = ok(await call<LocationDto[]>(owner, businessId, 'location.list'))
    const branch = ok(
      await call<LocationDto>(owner, businessId, 'location.create', { id: newId(), name: 'Mall' }),
    )
    const input = {
      id: newId(),
      name: `Spanish Latte ${newId().slice(-6)}`,
      description: '  Espresso, milk and condensed milk.  ',
      type: 'product',
      unit: 'piece',
      defaultPrice: '١٨٫٥٠',
      vatCategory: 'standard',
      priceIncludesVat: true,
      locationIds: [branch.id],
    }
    const created = ok(await call<ProductDto>(owner, businessId, 'product.create', input))
    expect(created).toMatchObject({
      name: input.name,
      description: 'Espresso, milk and condensed milk.',
      type: 'product',
      unit: 'piece',
      defaultPrice: '18.5',
      vatCategory: 'standard',
      priceIncludesVat: true,
      locationIds: [branch.id],
      archivedAt: null,
      version: 1,
    })
    expect(ok(await call(owner, businessId, 'product.get', { id: input.id }))).toEqual(created)
    expect(ok(await call(owner, businessId, 'product.create', input))).toEqual(created)

    // Sold everywhere again: the link is soft-deleted; then back at the branch on the same row.
    const everywhere = ok(
      await call<ProductDto>(owner, businessId, 'product.update', {
        ...input,
        version: created.version,
        locationIds: [],
        defaultPrice: null,
        description: '',
      }),
    )
    expect(everywhere).toMatchObject({ locationIds: [], defaultPrice: null, description: null })
    const back = ok(
      await call<ProductDto>(owner, businessId, 'product.update', {
        ...input,
        version: everywhere.version,
        locationIds: [branch.id, locations[0]?.id],
      }),
    )
    expect([...back.locationIds].sort()).toEqual([branch.id, locations[0]?.id].sort())
    const [links] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.product_locations where product_id = ${input.id}`
    expect(links?.n).toBe(2)
  })

  it('refuses a negative or too precise price, another business’s location, and a used name', async () => {
    const base = { type: 'service', unit: 'h' }
    for (const defaultPrice of ['-1', '1.12345', '1e3', 12]) {
      const result = await call(owner, businessId, 'product.create', {
        ...base,
        id: newId(),
        name: `Fitting ${newId()}`,
        defaultPrice,
      })
      expect(appCode(result), String(defaultPrice)).toBe('validation')
    }
    const neighbour = await newUser()
    const neighbourId = await setupBusiness(handler, neighbour.token, WORKSHOP)
    const [theirs] = ok(await call<LocationDto[]>(neighbour, neighbourId, 'location.list'))
    const foreign = await call(owner, businessId, 'product.create', {
      ...base,
      id: newId(),
      name: `Fitting ${newId()}`,
      locationIds: [theirs?.id],
    })
    expect(appCode(foreign)).toBe('not_found')

    const name = `Repair ${newId().slice(-6)}`
    ok(await call(owner, businessId, 'product.create', { ...base, id: newId(), name }))
    const twin = await call(owner, businessId, 'product.create', {
      type: 'product',
      unit: 'piece',
      id: newId(),
      name: name.toUpperCase(),
    })
    expect(appCode(twin)).toBe('name_taken')
  })

  it('a single-location business has no location list: CAPABILITY_DISABLED, and a save keeps what is stored', async () => {
    const baker = await newUser()
    const id = await setupBusiness(handler, baker.token, BAKER)
    const input = { id: newId(), name: 'Cupcake', type: 'product', unit: 'piece' }
    const created = ok(await call<ProductDto>(baker, id, 'product.create', input))
    const [location] = await admin<{ id: string }[]>`
      select id from app.locations where business_id = ${id} and is_default`
    const withList = await call(baker, id, 'product.update', {
      ...input,
      version: created.version,
      locationIds: [location?.id],
    })
    expect(appCode(withList)).toBe('capability_disabled')

    // A link stored while the business had branches stays through a save without the list.
    await admin`
      insert into app.product_locations (id, business_id, product_id, location_id, created_by)
      values (${newId()}, ${id}, ${input.id}, ${location?.id ?? ''}, ${baker.user.id})`
    const saved = ok(
      await call<ProductDto>(baker, id, 'product.update', {
        ...input,
        name: 'Cupcake (vanilla)',
        version: created.version,
      }),
    )
    expect(saved.locationIds).toEqual([location?.id])
  })

  it('archives and lists products and services by name', async () => {
    const other = await newUser()
    const id = await setupBusiness(handler, other.token, WORKSHOP)
    for (const [name, type] of [
      ['Table', 'product'],
      ['assembly', 'service'],
      ['Chair', 'product'],
    ] as const) {
      ok(await call(other, id, 'product.create', { id: newId(), name, type, unit: 'piece' }))
    }
    const all = ok(await call<ProductListDto>(other, id, 'product.list'))
    expect(all.items.map((p) => [p.name, p.type])).toEqual([
      ['assembly', 'service'],
      ['Chair', 'product'],
      ['Table', 'product'],
    ])
    const chair = all.items[1]
    ok(await call(other, id, 'product.archive', { id: chair?.id }))
    const active = ok(await call<ProductListDto>(other, id, 'product.list', { status: 'active' }))
    expect(active.items.map((p) => p.name)).toEqual(['assembly', 'Table'])
    const archived = ok(
      await call<ProductListDto>(other, id, 'product.list', { status: 'archived', search: 'ch' }),
    )
    expect(archived.items.map((p) => p.name)).toEqual(['Chair'])
    const back = ok(await call<ProductDto>(other, id, 'product.unarchive', { id: chair?.id }))
    expect(back.archivedAt).toBeNull()
  })
})

// Security and spec review of M2 Step 2 (2026-09-28). Each test below failed on the code as reviewed
// and passes with its fix (D-129–D-131).
describe('review of M2 Step 2', () => {
  it('a removed branch never blocks a product: what product.get returns can be saved again', async () => {
    const boss = await newUser()
    const id = await setupBusiness(handler, boss.token, WORKSHOP)
    const mall = ok(
      await call<LocationDto>(boss, id, 'location.create', { id: newId(), name: 'Mall' }),
    )
    const souq = ok(
      await call<LocationDto>(boss, id, 'location.create', { id: newId(), name: 'Souq' }),
    )
    const input = {
      id: newId(),
      name: 'Karak',
      type: 'product',
      unit: 'piece',
      locationIds: [mall.id, souq.id],
    }
    ok(await call<ProductDto>(boss, id, 'product.create', input))
    ok(await call(boss, id, 'location.remove', { id: souq.id }))

    const got = ok(await call<ProductDto>(boss, id, 'product.get', { id: input.id }))
    const live = ok(await call<LocationDto[]>(boss, id, 'location.list')).map((l) => l.id)
    // The form sends the stored list back (a hidden or read-only field is kept, D-123/D-126).
    const saved = await call<ProductDto>(boss, id, 'product.update', {
      ...input,
      name: 'Karak tea',
      version: got.version,
      locationIds: got.locationIds,
    })
    expect(appCode(saved) ?? 'ok', 'saving the product as read').toBe('ok')
    expect(
      got.locationIds.filter((l) => !live.includes(l)),
      'product.get names only live branches',
    ).toEqual([])
    expect(got.locationIds).toEqual([mall.id])
  })

  it('a branch that is the only one a product is sold at is not removed (it would be sold everywhere)', async () => {
    const boss = await newUser()
    const id = await setupBusiness(handler, boss.token, WORKSHOP)
    const mall = ok(
      await call<LocationDto>(boss, id, 'location.create', { id: newId(), name: 'Mall' }),
    )
    const souq = ok(
      await call<LocationDto>(boss, id, 'location.create', { id: newId(), name: 'Souq' }),
    )
    const input = {
      id: newId(),
      name: 'Souq special',
      type: 'product',
      unit: 'piece',
      locationIds: [souq.id],
    }
    ok(await call<ProductDto>(boss, id, 'product.create', input))
    // Archived, it still counts: brought back, it would be sold everywhere.
    ok(await call(boss, id, 'product.archive', { id: input.id }))
    expect(appCode(await call(boss, id, 'location.remove', { id: souq.id }))).toBe(
      'only_location_of_products',
    )
    const live = ok(await call<LocationDto[]>(boss, id, 'location.list')).map((l) => l.id)
    expect(live).toContain(souq.id)

    // Sold at the Mall too: the Souq can go, and the product keeps the Mall only.
    const archived = ok(await call<ProductDto>(boss, id, 'product.get', { id: input.id }))
    ok(
      await call(boss, id, 'product.update', {
        ...input,
        version: archived.version,
        locationIds: [souq.id, mall.id],
      }),
    )
    ok(await call(boss, id, 'location.remove', { id: souq.id }))
    const after = ok(await call<ProductDto>(boss, id, 'product.get', { id: input.id }))
    expect(after.locationIds).toEqual([mall.id])
  })

  it('where a product is sold changes only with settings.locations.manage, as the form says', async () => {
    const boss = await newUser()
    const id = await setupBusiness(handler, boss.token, WORKSHOP)
    const clerk = await newUser()
    await join(db, boss.user, id, clerk.user, 'supervisor')
    // The owner lets supervisors add and edit products (not branches).
    const role = ok(await call<RoleDto[]>(boss, id, 'role.list')).find(
      (r) => r.templateKey === 'supervisor',
    )
    ok(
      await call(boss, id, 'role.updatePermissions', {
        id: role?.id,
        version: role?.version,
        permissionKeys: [...(role?.permissionKeys ?? []), 'products.items.manage'],
      }),
    )
    const mall = ok(
      await call<LocationDto>(boss, id, 'location.create', { id: newId(), name: 'Mall' }),
    )
    const input = {
      id: newId(),
      name: 'Karak',
      type: 'product',
      unit: 'piece',
      locationIds: [mall.id],
    }
    const created = ok(await call<ProductDto>(boss, id, 'product.create', input))
    // The clerk cannot list branches, and the form shows them read only ("Only people who manage
    // branches can change this.")…
    expect(appCode(await call(clerk, id, 'location.list'))).toBe('forbidden')
    // …and the API refuses any other list from them: here "every branch".
    const widened = await call(clerk, id, 'product.update', {
      ...input,
      version: created.version,
      locationIds: [],
    })
    expect(appCode(widened)).toBe('forbidden')
    const after = ok(await call<ProductDto>(boss, id, 'product.get', { id: input.id }))
    expect(after.locationIds).toEqual([mall.id])
    // The list as stored is theirs to send back with any other change.
    const renamed = ok(
      await call<ProductDto>(clerk, id, 'product.update', {
        ...input,
        name: 'Karak tea',
        version: after.version,
        locationIds: after.locationIds,
      }),
    )
    expect(renamed.locationIds).toEqual([mall.id])
    // A new product: every branch only.
    const fresh = { id: newId(), name: 'Chai', type: 'product', unit: 'piece' }
    expect(
      appCode(await call(clerk, id, 'product.create', { ...fresh, locationIds: [mall.id] })),
    ).toBe('forbidden')
    expect(ok(await call<ProductDto>(clerk, id, 'product.create', fresh)).locationIds).toEqual([])
  })

  it('refuses a unit whose one piece is more base units than a stored quantity holds (numeric(24,6))', async () => {
    const tank = newId()
    const cases = [
      // 1 silo = 9,999,999,999,999,999 kg = about 10^19 g.
      { unit: 'kg', packs: [{ id: newId(), name: 'silo', qty: '9999999999999999', ofUnit: 'kg' }] },
      // 1 fleet = 10^9 tanks = 10^18 L = 10^21 ml (each factor fits numeric(28,12)).
      {
        unit: 'l',
        packs: [
          { id: tank, name: 'tank', qty: '1000000000', ofUnit: 'l' },
          { id: newId(), name: 'fleet', qty: '1000000000', ofPackId: tank },
        ],
      },
      // 1 kg = 9,999,999,999,999,999 L = about 10^19 ml.
      {
        unit: 'l',
        crossFactors: [{ id: newId(), unit: 'kg', qty: '9999999999999999', ofUnit: 'l' }],
      },
    ]
    for (const units of cases) {
      const result = await call(owner, businessId, 'material.create', {
        id: newId(),
        name: `Bulk ${newId().slice(-8)}`,
        ...units,
      })
      expect(appCode(result) ?? 'ok', JSON.stringify(units)).toBe('validation')
    }
  })

  it('a name needs a visible character, and names that look the same are one name (D-123)', async () => {
    const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b)
    const blank = await call(owner, businessId, 'material.create', {
      id: newId(),
      name: ZERO_WIDTH_SPACE,
      unit: 'kg',
    })
    expect(appCode(blank) ?? 'ok', 'a name of a zero-width space').toBe('validation')

    const name = `Sugar ${newId().slice(-6)}`
    ok(await call(owner, businessId, 'material.create', { id: newId(), name, unit: 'kg' }))
    const twin = await call(owner, businessId, 'material.create', {
      id: newId(),
      name: `${name}${ZERO_WIDTH_SPACE}`,
      unit: 'kg',
    })
    expect(['name_taken', 'validation'], 'a second "Sugar" with a zero-width space').toContain(
      appCode(twin) ?? 'ok',
    )
  })
})
