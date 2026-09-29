import type { MaterialDto } from '@bizcost/contracts'
import { nameKey, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { codeOf, ok, PurchasingApi, Scope, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// Adding a material from a purchase line, and one name per business compared the way people read it
// (the owner's request of 2026-09-29), through the real fetch handler: material.quickCreate for any
// member who enters purchases (create only), NAME_TAKEN naming the material that has the name, and
// the database's app.name_key giving the key nameKey gives.

let api: PurchasingApi
let shop: Scope
/** Enters purchases and sees materials, but may not add or change them in Materials. */
let buyer: Person

beforeAll(async () => {
  api = new PurchasingApi()
  shop = await Scope.open(api, WORKSHOP)
  buyer = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, buyer.user, {
    template: 'accountant',
    overrides: [{ key: 'purchases.documents.manage', effect: 'allow' }],
  })
}, 60_000)

afterAll(async () => {
  await api.close()
})

const tag = () => newId().slice(-6)

describe('material.quickCreate', () => {
  it('a member who enters purchases adds a material with its pack, and only adds', async () => {
    const bottle = newId()
    const input = {
      id: newId(),
      name: `Juice ${tag()}`,
      unit: 'l',
      packs: [
        { id: bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
        { id: newId(), name: 'carton', qty: '12', ofPackId: bottle },
      ],
    }
    expect(codeOf(await shop.as(buyer, 'material.create', input))).toBe('forbidden')
    const created = ok(await shop.as<MaterialDto>(buyer, 'material.quickCreate', input))
    expect(created).toMatchObject({
      id: input.id,
      name: input.name,
      unit: 'l',
      dimension: 'volume',
    })
    expect(created.packs.map((p) => p.name)).toEqual(['bottle', 'carton'])
    // The same payload again returns it (idempotent).
    expect(ok(await shop.as<MaterialDto>(buyer, 'material.quickCreate', input)).id).toBe(input.id)
    // Changing or archiving stays with materials.items.manage.
    expect(
      codeOf(
        await shop.as(buyer, 'material.update', {
          ...input,
          name: `${input.name} 2`,
          version: created.version,
        }),
      ),
    ).toBe('forbidden')
    expect(codeOf(await shop.as(buyer, 'material.archive', { id: input.id }))).toBe('forbidden')
    // Audited like any other create.
    const [audit] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where business_id = ${shop.id} and entity = 'materials' and entity_id = ${input.id}`
    expect(audit?.n).toBe(1)
  })

  it('needs purchases.documents.manage and materials.items.view', async () => {
    const accountant = await api.member(shop, 'accountant')
    const employee = await api.member(shop, 'employee')
    const blind = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, blind.user, {
      template: 'manager',
      overrides: [{ key: 'materials.items.view', effect: 'deny' }],
    })
    for (const person of [accountant, employee, blind]) {
      expect(
        codeOf(
          await shop.as(person, 'material.quickCreate', {
            id: newId(),
            name: `X ${tag()}`,
            unit: 'kg',
          }),
        ),
      ).toBe('forbidden')
    }
    const manager = await api.member(shop, 'manager')
    ok(
      await shop.as(manager, 'material.quickCreate', {
        id: newId(),
        name: `Y ${tag()}`,
        unit: 'kg',
      }),
    )
  })
})

describe('one name per business, the way people read it', () => {
  it('NAME_TAKEN for the same name in other letters, spaces or digits, naming the one that has it', async () => {
    const t = tag()
    const sugar = ok(
      await shop.run<MaterialDto>('material.create', { id: newId(), name: `سكر ${t}`, unit: 'kg' }),
    )
    const coffee = ok(
      await shop.run<MaterialDto>('material.create', {
        id: newId(),
        name: `Brown Coffee ${t}`,
        unit: 'kg',
      }),
    )
    ok(await shop.run('material.archive', { id: coffee.id }))
    for (const [name, taken] of [
      [`سُكَّر ${t}`, sugar.name],
      [`  سكر   ${t} `, sugar.name],
      [`brown  COFFEE ${t}`, coffee.name],
    ] as const) {
      for (const path of ['material.create', 'material.quickCreate']) {
        const result = await shop.as(buyer, path, { id: newId(), name, unit: 'kg' })
        if (path === 'material.create') {
          expect(codeOf(result), name).toBe('forbidden')
          continue
        }
        expect(codeOf(result), name).toBe('name_taken')
        expect(result.error?.data.names, name).toEqual([taken])
      }
      const owners = await shop.run('material.create', { id: newId(), name, unit: 'kg' })
      expect(codeOf(owners), name).toBe('name_taken')
      expect(owners.error?.data.names, name).toEqual([taken])
    }
    // A name that only looks alike is a new material (the screen asks first).
    ok(await shop.run('material.create', { id: newId(), name: `سكر بني ${t}`, unit: 'kg' }))
  })

  it('app.name_key in the database gives the key nameKey gives', async () => {
    const names = [
      '  Brown   SUGAR ',
      'Brown\u{00A0}Sugar',
      'أرز',
      'إسفنج',
      'آيس كريم',
      'ٱلزيت',
      'قهوة',
      'حلوى',
      'سُكَّر',
      'طحيـــنة',
      'حليب ٣٫٥٪',
      'كوب ۱۲ أونصة',
      'Crème brûlée',
      'Ice\u{2003}cream\u{3000}',
      'CAFÉ Ünïcödé',
      '🍓 Strawberry',
      // Migration name_key_unicode: format characters, NFKC and the Persian letter forms.
      'Sug\u{200E}ar',
      'سك\u{200F}ر',
      'س\u{061C}كر',
      'Brown \u{2066}sugar\u{2069}',
      'e\u{200E}\u{0301}',
      'ب\u{06CC}ت',
      'شا\u{06CC}',
      'آيس \u{06A9}ريم',
      'قهو\u{06D5}',
      'قهو\u{06C1}',
      'م\u{0648}\u{0654}سسة',
      'ب\u{064A}\u{0654}ر',
      'Cafe\u{0301}',
      '\u{FEB3}\u{FEDC}\u{FEAE}',
      '\u{FF33}\u{FF55}\u{FF47}\u{FF41}\u{FF52}',
      '\u{FEFB}بن \u{FDF2}',
      '👩\u{200D}🍳 Chef',
    ]
    const rows = await api.admin<{ name: string; key: string }[]>`
      select n as name, app.name_key(n) as key from unnest(${names}::text[]) as n`
    expect(rows.map((r) => r.key)).toEqual(names.map(nameKey))
  })

  it('app.name_key drops every format character (Unicode category Cf), as nameKey does', async () => {
    const names: string[] = []
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      const c = String.fromCodePoint(code)
      if (/\p{Cf}/u.test(c)) names.push(`a${c}b`)
    }
    const rows = await api.admin<{ key: string }[]>`
      select app.name_key(n) as key from unnest(${names}::text[]) with ordinality as t(n, i)
       order by i`
    expect(rows.map((r) => r.key)).toEqual(names.map(nameKey))
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set(['ab']))
  })
})
