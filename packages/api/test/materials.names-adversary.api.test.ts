import type { MaterialDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { codeOf, PurchasingApi, Scope, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// Security adversary (review of the owner's requests of 2026-09-29, R2), through the real fetch
// handler: "already exists" must hold for a name that reads exactly like one the business has. Any
// member who enters purchases may now add materials (material.quickCreate), so the unique index on
// app.name_key is the only thing between them and a second "Sugar". The API keeps inside a name the
// bidi marks (U+200E, U+200F, U+061C, U+2066–U+2069), the Persian letter forms and the decomposed or
// presentation forms of letters, and app.name_key / nameKey do not fold them: each name below is
// accepted as a new material next to the one it reads exactly like.
//
// These tests fail until the key folds them (domain catalog/names.ts and migration name_key, kept
// equal by materials.quick-add.api.test.ts).

let api: PurchasingApi
let shop: Scope
/** Enters purchases and sees materials; may not add or change them in Materials. */
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

describe('material.quickCreate: a name that reads exactly like one the business has is NAME_TAKEN', () => {
  it.each([
    [
      'a left-to-right mark inside',
      (t: string) => `Sugar ${t}`,
      (t: string) => `Sug\u{200E}ar ${t}`,
    ],
    ['a right-to-left mark inside', (t: string) => `سكر ${t}`, (t: string) => `سك\u{200F}ر ${t}`],
    ['an Arabic letter mark inside', (t: string) => `سكر ${t}`, (t: string) => `س\u{061C}كر ${t}`],
    ['the Farsi yeh', (t: string) => `ب\u{064A}ت ${t}`, (t: string) => `ب\u{06CC}ت ${t}`],
    ['the keheh', (t: string) => `\u{0643}ريم ${t}`, (t: string) => `\u{06A9}ريم ${t}`],
    [
      'waw + hamza above for waw with hamza',
      (t: string) => `م\u{0624}سسة ${t}`,
      (t: string) => `م\u{0648}\u{0654}سسة ${t}`,
    ],
    [
      'Arabic presentation forms',
      (t: string) => `سكر ${t}`,
      (t: string) => `\u{FEB3}\u{FEDC}\u{FEAE} ${t}`,
    ],
    ['e + combining acute for é', (t: string) => `Café ${t}`, (t: string) => `Cafe\u{0301} ${t}`],
  ])('%s', async (_what, original, lookalike) => {
    const t = tag()
    const first = await shop.run<MaterialDto>('material.create', {
      id: newId(),
      name: original(t),
      unit: 'kg',
    })
    expect(first.error, first.raw).toBeUndefined()
    const second = await shop.as<MaterialDto>(buyer, 'material.quickCreate', {
      id: newId(),
      name: lookalike(t),
      unit: 'kg',
    })
    expect(codeOf(second), `created ${JSON.stringify(second.data?.name)}`).toBe('name_taken')
    expect(second.error?.data.names).toEqual([original(t)])
  })
})
