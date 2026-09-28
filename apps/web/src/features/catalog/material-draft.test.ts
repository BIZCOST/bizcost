import type { MaterialDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import {
  checkMaterial,
  materialDraft,
  newCross,
  newPack,
  type MaterialDraft,
} from './material-draft'
import { readFactor, readPrice, withLatinDigits } from './numbers'

// The material form's checks: the same rules as the API (the domain units engine), each problem on
// the field that fixes it.

const draft = (over: Partial<MaterialDraft> = {}): MaterialDraft => ({
  name: 'Milk',
  unit: 'l',
  packs: [],
  crossFactors: [],
  ...over,
})

const carton = { id: 'c', name: 'Carton', qty: '12', of: 'pack:b' } as const
const bottle = { id: 'b', name: 'Bottle', qty: '١', of: 'unit:l' } as const

describe('checkMaterial', () => {
  it("sends the owner's carton of bottles, with Arabic digits read", () => {
    const { errors, fields } = checkMaterial(draft({ name: '  Milk ', packs: [carton, bottle] }))
    expect(errors).toEqual({ packs: {}, crossFactors: {} })
    expect(fields).toEqual({
      name: 'Milk',
      unit: 'l',
      packs: [
        { id: 'c', name: 'Carton', qty: '12', ofUnit: null, ofPackId: 'b' },
        { id: 'b', name: 'Bottle', qty: '1', ofUnit: 'l', ofPackId: null },
      ],
      crossFactors: [],
    })
  })

  it('asks for a name and a unit', () => {
    const { errors, fields } = checkMaterial(draft({ name: ' \t', unit: '' }))
    expect(fields).toBeNull()
    expect(errors.name).toEqual({ key: 'catalog.form.nameRequired' })
    expect(errors.unit).toEqual({ key: 'catalog.materials.unitRequired' })
    expect(checkMaterial(draft({ name: 'x'.repeat(101) })).errors.name).toEqual({
      key: 'catalog.form.nameTooLong',
      values: { count: 100 },
    })
  })

  it('checks each pack: its name, once; a quantity more than zero; what it holds', () => {
    const { errors } = checkMaterial(
      draft({
        packs: [
          { id: 'a', name: 'Box', qty: '0', of: 'unit:l' },
          { id: 'b', name: 'box ', qty: 'abc', of: '' },
          { id: 'c', name: '', qty: '1.0000000000001', of: 'unit:ml' },
        ],
      }),
    )
    expect(errors.packs).toEqual({
      a: { qty: { key: 'catalog.numbers.positive' } },
      b: {
        name: { key: 'catalog.materials.packs.nameTaken' },
        qty: { key: 'catalog.numbers.invalid' },
        of: { key: 'catalog.materials.packs.unknown' },
      },
      c: {
        name: { key: 'catalog.materials.packs.nameRequired' },
        qty: { key: 'catalog.numbers.tooManyDecimals' },
      },
    })
  })

  it('says a loop once, naming it, on the pack changed last (else its last in the list)', () => {
    const packs = [
      { id: 'outer', name: 'Pallet', qty: '10', of: 'pack:a' },
      { id: 'a', name: 'Case', qty: '2', of: 'pack:b' },
      { id: 'b', name: 'Tray', qty: '2', of: 'pack:a' },
    ] as const
    // Not on the pallet, which only leads into the loop.
    expect(checkMaterial(draft({ packs: [...packs] })).errors.packs).toEqual({
      b: { of: { key: 'catalog.materials.packs.cycle', chain: ['Tray', 'Case', 'Tray'] } },
    })
    expect(checkMaterial(draft({ packs: [...packs] }), { lastChanged: 'a' }).errors.packs).toEqual({
      a: { of: { key: 'catalog.materials.packs.cycle', chain: ['Case', 'Tray', 'Case'] } },
    })
    // The pack changed last is outside the loop: the loop's last in the list.
    expect(
      checkMaterial(draft({ packs: [...packs] }), { lastChanged: 'outer' }).errors.packs,
    ).toEqual({
      b: { of: { key: 'catalog.materials.packs.cycle', chain: ['Tray', 'Case', 'Tray'] } },
    })
  })

  it('says a pack or a conversion too big or too small to count on its number (D-130)', () => {
    const { errors, fields } = checkMaterial(
      draft({
        packs: [
          { id: 'tank', name: 'Tank', qty: '1000000000', of: 'unit:l' },
          { id: 'fleet', name: 'Fleet', qty: '1000000000', of: 'pack:tank' },
          { id: 'armada', name: 'Armada', qty: '2', of: 'pack:fleet' },
        ],
      }),
    )
    // Said on the fleet, whose own number is too big, not on the armada that holds fleets.
    expect(errors.packs).toEqual({ fleet: { qty: { key: 'catalog.materials.packs.tooLarge' } } })
    expect(fields).toBeNull()
    expect(
      checkMaterial(
        draft({ packs: [{ id: 'speck', name: 'Speck', qty: '0.0000001', of: 'unit:ml' }] }),
      ).errors.packs,
    ).toEqual({ speck: { qty: { key: 'catalog.materials.packs.tooSmall' } } })
    expect(
      checkMaterial(
        draft({ crossFactors: [{ id: 'x', unit: 'kg', qty: '9999999999999999', of: 'l' }] }),
      ).errors.crossFactors,
    ).toEqual({ x: { qty: { key: 'catalog.materials.cross.tooLarge' } } })
  })

  it('takes names as the API stores them: no invisible characters, something to see (D-131)', () => {
    const zeroWidth = String.fromCodePoint(0x200b)
    const { errors, fields } = checkMaterial(
      draft({
        name: `${zeroWidth}Milk${zeroWidth} `,
        packs: [{ id: 'b', name: `Bottle${String.fromCodePoint(0x200f)}`, qty: '1', of: 'unit:l' }],
      }),
    )
    expect(errors).toEqual({ packs: {}, crossFactors: {} })
    expect(fields?.name).toBe('Milk')
    expect(fields?.packs?.[0]?.name).toBe('Bottle')
    expect(checkMaterial(draft({ name: zeroWidth })).errors.name).toEqual({
      key: 'catalog.form.nameRequired',
    })
    // Two packs whose names differ only by an invisible character are one name.
    expect(
      checkMaterial(
        draft({
          packs: [
            { id: 'a', name: 'Bag', qty: '1', of: 'unit:l' },
            { id: 'b', name: `B${zeroWidth}ag`, qty: '2', of: 'unit:l' },
          ],
        }),
      ).errors.packs,
    ).toEqual({ b: { name: { key: 'catalog.materials.packs.nameTaken' } } })
  })

  it('says another kind of measure on the pack that picked it, until a conversion links it', () => {
    const packs = [
      { id: 'crate', name: 'Crate', qty: '4', of: 'pack:bag' },
      { id: 'bag', name: 'Bag', qty: '5', of: 'unit:kg' },
    ] as const
    const { errors } = checkMaterial(draft({ packs: [...packs] }))
    expect(errors.packs).toEqual({ bag: { of: { key: 'catalog.materials.packs.wrongDimension' } } })
    const linked = checkMaterial(
      draft({ packs: [...packs], crossFactors: [{ id: 'x', unit: 'kg', qty: '1.1', of: 'l' }] }),
    )
    expect(linked.errors).toEqual({ packs: {}, crossFactors: {} })
    expect(linked.fields?.crossFactors).toEqual([{ id: 'x', unit: 'kg', qty: '1.1', ofUnit: 'l' }])
  })

  it('checks conversions: another kind of measure, once per kind, landing in the own kind', () => {
    const { errors } = checkMaterial(
      draft({
        unit: 'kg',
        crossFactors: [
          { id: 'same', unit: 'g', qty: '1', of: 'kg' },
          { id: 'l', unit: 'l', qty: '920', of: 'g' },
          { id: 'ml', unit: 'ml', qty: '0.92', of: 'g' },
          { id: 'target', unit: 'piece', qty: '150', of: 'ml' },
          { id: 'empty', unit: '', qty: '', of: 'g' },
        ],
      }),
    )
    expect(errors.crossFactors).toEqual({
      same: { unit: { key: 'catalog.materials.cross.sameKind' } },
      ml: { unit: { key: 'catalog.materials.cross.duplicate' } },
      target: { of: { key: 'catalog.materials.cross.wrongTarget' } },
      empty: {
        unit: { key: 'catalog.form.pickUnit' },
        qty: { key: 'catalog.numbers.required' },
      },
    })
  })
})

describe('materialDraft', () => {
  it('reads a stored material back into the form', () => {
    const material: MaterialDto = {
      id: 'm',
      name: 'Milk',
      dimension: 'volume',
      unit: 'l',
      packs: [
        { id: 'c', name: 'Carton', qty: '12', ofUnit: null, ofPackId: 'b' },
        { id: 'b', name: 'Bottle', qty: '1', ofUnit: 'l', ofPackId: null },
      ],
      crossFactors: [{ id: 'x', unit: 'kg', qty: '1.03', ofUnit: 'l' }],
      archivedAt: null,
      version: 3,
    }
    const read = materialDraft(material)
    expect(read.packs.map((p) => p.of)).toEqual(['pack:b', 'unit:l'])
    expect(checkMaterial(read).fields).toEqual({
      name: 'Milk',
      unit: 'l',
      packs: material.packs,
      crossFactors: material.crossFactors,
    })
  })

  it('starts new rows in the unit the material is used in', () => {
    expect(newPack(draft()).of).toBe('unit:l')
    expect(newPack(draft({ unit: '' })).of).toBe('')
    expect(newCross(draft()).of).toBe('l')
  })
})

describe('numbers', () => {
  it('reads factors and prices typed in either language', () => {
    expect(readFactor('١٢٫٥')).toEqual({ ok: true, value: '12.5' })
    expect(readFactor('-1')).toEqual({ ok: false, error: { key: 'catalog.numbers.positive' } })
    expect(readFactor('')).toEqual({ ok: false, error: { key: 'catalog.numbers.required' } })
    expect(readFactor('1'.repeat(17))).toEqual({
      ok: false,
      error: { key: 'catalog.numbers.tooLarge' },
    })
    expect(readPrice('')).toEqual({ ok: true, value: null })
    expect(readPrice('1,250.50')).toEqual({ ok: true, value: '1250.5' })
    expect(readPrice('0')).toEqual({ ok: true, value: '0' })
    expect(readPrice('−3')).toEqual({ ok: false, error: { key: 'catalog.numbers.notNegative' } })
    expect(readPrice('1.23456')).toEqual({
      ok: false,
      error: { key: 'catalog.numbers.tooManyDecimals' },
    })
  })

  it('shows what was typed with Latin digits once it reads, and leaves the rest as typed', () => {
    expect(withLatinDigits('١٬٢٥٠')).toBe('1,250')
    expect(withLatinDigits('١٨٫٥٠')).toBe('18.50')
    expect(withLatinDigits(' ۱۲ ')).toBe('12')
    expect(withLatinDigits('١٢x')).toBe('١٢x')
    expect(withLatinDigits('')).toBe('')
  })
})
