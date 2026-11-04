import { STOCK_COUNT_LINES_MAX, type StockMaterialDto } from '@bizcost/contracts'
import {
  LOCALES,
  TERMINOLOGY_PROFILES,
  type Locale,
  type TerminologyProfile,
} from '@bizcost/domain'
import { hasMessage, resources, terminologyKey, type I18nKey, type Messages } from '@bizcost/i18n'
import { describe, expect, it, vi } from 'vitest'
import {
  changedFrom,
  checkLine,
  countingOrder,
  firstCountMax,
  lineDraftOf,
  nextPartUnit,
  latestCount,
  pickUpTo,
  readCountQty,
  stepCount,
  withPart,
  type LineDraft,
} from './count-draft'
import { CountEdits, nextEdit, shownEdit } from './count-edits'
import {
  countListInput,
  countsFiltered,
  readCountFilters,
  readStockFilters,
  writeFilters,
} from './count-filters'
import { differenceSide, magnitude, stockInWords, summarizeDifferences } from './stock-words'

// The stock screens' own logic (M4 Step 2): stock said in packs ("12 cartons + 3 bottles (147 L)"),
// a counted line as typed (parts in packs and units, − / +, either digit set) and what it comes to,
// the filters kept in the address, the day a later count must come after, what is typed on a sheet
// several people count, what a finalize confirmation calls a match, how many materials one first
// count takes, and the business's word for what it counts.

function material(
  fields: Partial<StockMaterialDto> & Pick<StockMaterialDto, 'unit'>,
): StockMaterialDto {
  const dimension = { l: 'volume', ml: 'volume', kg: 'mass', g: 'mass', piece: 'count' } as const
  return {
    id: 'm1',
    name: 'Milk',
    dimension: dimension[fields.unit as keyof typeof dimension],
    packs: [],
    crossFactors: [],
    archived: false,
    ...fields,
  }
}

const MILK = material({
  unit: 'l',
  packs: [
    { id: 'bottle', name: 'bottle', qty: '1', ofUnit: 'l', ofPackId: null },
    { id: 'carton', name: 'carton', qty: '12', ofUnit: null, ofPackId: 'bottle' },
  ],
})
const BEANS = material({
  id: 'm2',
  name: 'Coffee beans',
  unit: 'kg',
  packs: [{ id: 'bag', name: 'bag', qty: '1', ofUnit: 'kg', ofPackId: null }],
})
const OIL = material({
  id: 'm3',
  name: 'Oil',
  unit: 'g',
  crossFactors: [{ id: 'x', unit: 'l', qty: '920', ofUnit: 'g' }],
})

describe('stock in words', () => {
  it('splits stock into whole packs down the biggest pack, the rest in the counting unit', () => {
    // 147 L of milk in ml: 12 cartons of 12 bottles and 3 bottles.
    expect(stockInWords(MILK, '147000')).toEqual({
      negative: false,
      parts: [
        { kind: 'pack', qty: '12', name: 'carton' },
        { kind: 'pack', qty: '3', name: 'bottle' },
      ],
      total: '147',
      unit: 'l',
    })
    expect(stockInWords(MILK, '147500').parts.at(-1)).toEqual({
      kind: 'unit',
      qty: '0.5',
      unit: 'l',
    })
    expect(stockInWords(MILK, '5000').parts).toEqual([{ kind: 'pack', qty: '5', name: 'bottle' }])
    expect(stockInWords(BEANS, '2500')).toEqual({
      negative: false,
      parts: [
        { kind: 'pack', qty: '2', name: 'bag' },
        { kind: 'unit', qty: '0.5', unit: 'kg' },
      ],
      total: '2.5',
      unit: 'kg',
    })
  })

  it('says only the counting unit without packs, for nothing, and below zero', () => {
    expect(stockInWords(OIL, '920')).toEqual({
      negative: false,
      parts: [],
      total: '920',
      unit: 'g',
    })
    expect(stockInWords(MILK, '0')).toEqual({ negative: false, parts: [], total: '0', unit: 'l' })
    expect(stockInWords(MILK, '-3000')).toEqual({
      negative: true,
      parts: [],
      total: '3',
      unit: 'l',
    })
    // Less than one bottle: no whole pack, the litres alone.
    expect(stockInWords(MILK, '400')).toEqual({
      negative: false,
      parts: [],
      total: '0.4',
      unit: 'l',
    })
  })

  it('says what it cannot convert in the base unit, never labelled with the counting unit', () => {
    // Not something the units engine reads: said as it is, in ml (the base unit), not as litres.
    expect(stockInWords(MILK, 'x')).toEqual({ negative: false, parts: [], total: 'x', unit: 'ml' })
    expect(stockInWords(BEANS, 'x').unit).toBe('g')
  })

  it('never says more packs than there are when a pack does not divide evenly', () => {
    // 999.999999 ml reads as 1.000000 bottle once rounded; not one whole bottle is there.
    expect(stockInWords(MILK, '999.999999').parts).toEqual([])
  })

  it('says which way a difference goes, and drops its sign', () => {
    expect(differenceSide('-80000')).toBe('less')
    expect(differenceSide('5')).toBe('more')
    expect(differenceSide('0')).toBe('same')
    expect(magnitude('-480.5')).toBe('480.5')
    expect(magnitude('12')).toBe('12')
  })
})

describe('a counted line as typed', () => {
  it('starts in the biggest pack, and each part added takes the next unit down', () => {
    expect(countingOrder(MILK)).toEqual(['pack:carton', 'pack:bottle', 'unit:l'])
    expect(countingOrder(OIL)).toEqual(['unit:g'])
    const draft = lineDraftOf({ parts: null }, MILK)
    expect(draft).toHaveLength(1)
    expect(draft[0]).toMatchObject({ qty: '', unit: 'pack:carton' })
    const two = withPart(MILK, draft)
    expect(two.map((part) => part.unit)).toEqual(['pack:carton', 'pack:bottle'])
    expect(nextPartUnit(MILK, two)).toBe('unit:l')
    expect(withPart(MILK, withPart(MILK, two)).at(-1)!.unit).toBe('unit:l')
  })

  it('reads a saved line back as its parts', () => {
    const draft = lineDraftOf(
      {
        parts: [
          { qty: '12', unit: null, packId: 'carton', packName: 'carton' },
          { qty: '0.5', unit: 'l', packId: null, packName: null },
        ],
      },
      MILK,
    )
    expect(draft.map(({ qty, unit }) => ({ qty, unit }))).toEqual([
      { qty: '12', unit: 'pack:carton' },
      { qty: '0.5', unit: 'unit:l' },
    ])
  })

  it('steps one up or down, never below zero, and − on an empty box says 0', () => {
    expect(stepCount('', 1)).toBe('1')
    expect(stepCount('', -1)).toBe('0')
    expect(stepCount('0', -1)).toBe('0')
    expect(stepCount('0.5', -1)).toBe('0')
    expect(stepCount('2.5', 1)).toBe('3.5')
    expect(stepCount('١٢', 1)).toBe('13')
  })

  it('reads a counted quantity in either digit set: zero or more', () => {
    expect(readCountQty('١٢٫٥')).toEqual({ ok: true, value: '12.5' })
    expect(readCountQty('0')).toEqual({ ok: true, value: '0' })
    expect(readCountQty('')).toEqual({ ok: false, error: { key: 'catalog.numbers.required' } })
    expect(readCountQty('-1')).toEqual({ ok: false, error: { key: 'catalog.numbers.notNegative' } })
    expect(readCountQty('abc')).toEqual({ ok: false, error: { key: 'catalog.numbers.invalid' } })
    expect(readCountQty('1.1234567')).toEqual({
      ok: false,
      error: { key: 'catalog.numbers.tooManyDecimals' },
    })
  })

  it('adds the parts in base units, as the API saves them: 12 cartons + 3 bottles = 147 L', () => {
    const draft: LineDraft = [
      { key: 'a', qty: '12', unit: 'pack:carton' },
      { key: 'b', qty: '٣', unit: 'pack:bottle' },
    ]
    expect(checkLine(MILK, draft)).toEqual({
      errors: {},
      parts: [
        { qty: '12', packId: 'carton' },
        { qty: '3', packId: 'bottle' },
      ],
      base: '147000',
    })
    // A unit of another kind through the material's conversion: 1 L of oil is 920 g.
    expect(checkLine(OIL, [{ key: 'a', qty: '1', unit: 'unit:l' }]).base).toBe('920')
    // Nothing on the shelf is a count too.
    expect(checkLine(MILK, [{ key: 'a', qty: '0', unit: 'pack:carton' }]).base).toBe('0')
  })

  it("says each part's problem: a quantity that does not read, or no unit of this material", () => {
    const check = checkLine(MILK, [
      { key: 'a', qty: '', unit: 'pack:carton' },
      { key: 'b', qty: '2', unit: '' },
      { key: 'c', qty: '2', unit: 'pack:bag' },
    ])
    expect(check.parts).toBeNull()
    expect(check.base).toBeNull()
    expect(check.errors).toEqual({
      a: { key: 'catalog.numbers.required' },
      b: { key: 'stock.sheet.unitRequired' },
      c: { key: 'stock.sheet.unitRequired' },
    })
  })

  it('tells a typed change from what was saved, numbers read in either digit set', () => {
    const saved = { parts: [{ qty: '12', unit: null, packId: 'carton', packName: 'carton' }] }
    expect(changedFrom([{ key: 'x', qty: '12', unit: 'pack:carton' }], saved, MILK)).toBe(false)
    expect(changedFrom([{ key: 'x', qty: '١٢', unit: 'pack:carton' }], saved, MILK)).toBe(false)
    expect(changedFrom([{ key: 'x', qty: '12.0', unit: 'pack:carton' }], saved, MILK)).toBe(false)
    expect(changedFrom([{ key: 'x', qty: '11', unit: 'pack:carton' }], saved, MILK)).toBe(true)
    expect(changedFrom([{ key: 'x', qty: '12', unit: 'pack:bottle' }], saved, MILK)).toBe(true)
    // A line not counted yet changes once something is typed (an empty part added is nothing).
    expect(changedFrom(lineDraftOf({ parts: null }, MILK), { parts: null }, MILK)).toBe(false)
    expect(changedFrom([{ key: 'x', qty: '1', unit: 'pack:carton' }], { parts: null }, MILK)).toBe(
      true,
    )
  })
})

describe('the filters in the address', () => {
  const BRANCH = '6f1c2b8e-1d7a-4c3e-9b5a-2f4d6e8a0c1b'

  it('reads counts filters, leaving out what the API would refuse', () => {
    expect(
      readCountFilters(
        new URLSearchParams(`status=posted&kind=opening&branch=${BRANCH.toUpperCase()}`),
      ),
    ).toEqual({ status: 'posted', kind: 'opening', locationId: BRANCH })
    expect(readCountFilters(new URLSearchParams('status=final&kind=x&branch=1'))).toEqual({
      status: 'all',
      kind: null,
      locationId: null,
    })
    expect(readStockFilters(new URLSearchParams(`branch=${BRANCH}&q=%20milk%20`))).toEqual({
      locationId: BRANCH,
      search: 'milk',
    })
  })

  it('writes only what differs from the defaults, and keeps other parameters', () => {
    const params = new URLSearchParams('status=draft&x=1')
    expect(writeFilters(params, { status: 'all', kind: 'count' })).toBe('x=1&kind=count')
    expect(writeFilters(new URLSearchParams(), { locationId: BRANCH, search: ' oat ' })).toBe(
      `branch=${BRANCH}&q=oat`,
    )
  })

  it('says whether the counts list is narrowed, and what count.list is asked', () => {
    const none = { status: 'all', kind: null, locationId: null } as const
    expect(countsFiltered(none)).toBe(false)
    expect(countsFiltered({ ...none, kind: 'count' })).toBe(true)
    expect(countListInput({ status: 'draft', kind: null, locationId: BRANCH })).toEqual({
      status: 'draft',
      kind: undefined,
      locationId: BRANCH,
    })
  })
})

describe('the day a later count comes after', () => {
  const item = (name: string, trackedFrom: string, counted: Record<string, string | null>) =>
    ({
      material: { ...MILK, name },
      trackedFrom,
      onHand: '0',
      branches: Object.entries(counted).map(([locationId, lastCountedOn]) => ({
        locationId,
        locationName: locationId,
        onHand: '0',
        lastCountedOn,
      })),
    }) as unknown as Parameters<typeof latestCount>[0][number]

  it("is the latest last count of the items in the branch (or their first count's day)", () => {
    const items = [
      item('Milk', '2026-09-30', { a: '2026-10-15', b: '2026-09-30' }),
      item('Beans', '2026-10-01', { a: '2026-10-01', b: '2026-10-20' }),
    ]
    expect(latestCount(items, 'a')).toEqual({ date: '2026-10-15', name: 'Milk' })
    expect(latestCount(items, 'b')).toEqual({ date: '2026-10-20', name: 'Beans' })
    // A branch added after an item's first count: its first count's day.
    expect(latestCount([item('Cups', '2026-10-05', {})], 'c')).toEqual({
      date: '2026-10-05',
      name: 'Cups',
    })
    expect(latestCount([], 'a')).toBeNull()
  })

  it("with the branch unknown, is each item's first count day (every count comes after it)", () => {
    const items = [
      item('Milk', '2026-09-30', { a: '2026-10-15' }),
      item('Beans', '2026-10-01', { b: '2026-10-20' }),
    ]
    expect(latestCount(items, null)).toEqual({ date: '2026-10-01', name: 'Beans' })
  })
})

describe('a sheet several people count', () => {
  const saved = (version: number, qty: string | null) => ({
    version,
    parts: qty === null ? null : [{ qty, unit: null, packId: 'carton', packName: 'carton' }],
  })
  const typed = (qty: string): LineDraft => [{ key: 'k', qty, unit: 'pack:carton' }]

  it('keeps the version a change started from, until the typing is back to what is saved', () => {
    const first = nextEdit(undefined, typed('2'), saved(3, null), MILK)
    expect(first).toMatchObject({ version: 3, seen: 3 })
    // Someone else saved it since (version 4): this change still goes with 3, so it is CONFLICT.
    expect(nextEdit(first, typed('21'), saved(4, '5'), MILK)).toMatchObject({ version: 3 })
    // Typed back to what is saved: nothing to save, no version kept.
    expect(nextEdit(first, typed('5'), saved(4, '5'), MILK)).toMatchObject({
      version: null,
      seen: 4,
    })
  })

  it('shows a change not saved, or a clean draft until someone saves the line again', () => {
    const changed = nextEdit(undefined, typed('2'), saved(3, null), MILK)
    expect(shownEdit(changed, { version: 9 })).toBe(changed)
    const clean = nextEdit(undefined, typed('5'), saved(4, '5'), MILK)
    expect(shownEdit(clean, { version: 4 })).toBe(clean)
    // A counter saved it again since: the line shows what they counted, not the old draft.
    expect(shownEdit(clean, { version: 5 })).toBeUndefined()
    expect(shownEdit(undefined, { version: 1 })).toBeUndefined()
  })

  it("tells a line about its own edit only, and the sheet when a line's changed state flips", () => {
    const edits = new CountEdits()
    const line = vi.fn()
    const other = vi.fn()
    const sheet = vi.fn()
    edits.subscribeLine('a', line)
    edits.subscribeLine('b', other)
    edits.subscribe(sheet)
    const before = edits.changed()
    edits.set('a', { draft: typed('1'), version: 2, seen: 2 })
    edits.set('a', { draft: typed('12'), version: 2, seen: 2 })
    expect(line).toHaveBeenCalledTimes(2)
    expect(other).not.toHaveBeenCalled()
    // Typing on a changed line keeps the same set: the sheet hears once, not per keystroke.
    expect(sheet).toHaveBeenCalledTimes(1)
    expect(edits.changed()).not.toBe(before)
    expect([...edits.changed()]).toEqual(['a'])
    // Back to what is saved, then dropped: no line has a change.
    edits.set('a', { draft: typed('5'), version: null, seen: 2 })
    expect(edits.changed().size).toBe(0)
    edits.set('a', undefined)
    expect(edits.get('a')).toBeUndefined()
    edits.set('b', { draft: typed('3'), version: 1, seen: 1 })
    edits.clear()
    expect(edits.changed().size).toBe(0)
    expect(edits.get('b')).toBeUndefined()
  })
})

describe('what a finalize confirmation calls a match', () => {
  it('says everything matches only when no line differs in quantity', () => {
    expect(
      summarizeDifferences([
        { differenceQty: '0', differenceValue: '0' },
        { differenceQty: '0', differenceValue: '0' },
      ]),
    ).toEqual({ differing: 0, total: '0' })
  })

  it('counts a −72 and a +72 as two differences, their value said apart (AED 0 together)', () => {
    expect(
      summarizeDifferences([
        { differenceQty: '-12000', differenceValue: '-72' },
        { differenceQty: '12000', differenceValue: '72' },
      ]),
    ).toEqual({ differing: 2, total: '0' })
  })

  it('counts an unpriced material counted short as a difference at AED 0', () => {
    expect(summarizeDifferences([{ differenceQty: '-1000', differenceValue: '0' }])).toEqual({
      differing: 1,
      total: '0',
    })
  })

  it('hides the total when a value is hidden (no costs switch), and has none without values', () => {
    expect(summarizeDifferences([{ differenceQty: '-1000' }])).toEqual({
      differing: 1,
      total: undefined,
    })
    expect(summarizeDifferences([{ differenceQty: null, differenceValue: null }])).toEqual({
      differing: 0,
      total: null,
    })
  })
})

describe('how many materials one first count takes', () => {
  it("is a count's most lines shared by the live branches", () => {
    expect(firstCountMax(1)).toBe(STOCK_COUNT_LINES_MAX)
    expect(firstCountMax(0)).toBe(STOCK_COUNT_LINES_MAX)
    expect(firstCountMax(3)).toBe(Math.floor(STOCK_COUNT_LINES_MAX / 3))
  })

  it('selects all within it, keeping what was picked, and says when some did not fit', () => {
    expect(pickUpTo(new Set(), ['a', 'b', 'c'], 5)).toEqual({
      picked: new Set(['a', 'b', 'c']),
      capped: false,
    })
    expect(pickUpTo(new Set(['z']), ['a', 'b', 'c'], 3)).toEqual({
      picked: new Set(['z', 'a', 'b']),
      capped: true,
    })
    // Picked already: not counted twice.
    expect(pickUpTo(new Set(['a']), ['a', 'b'], 2)).toEqual({
      picked: new Set(['a', 'b']),
      capped: false,
    })
  })
})

describe("the business's word for what it counts (D-117, D-118)", () => {
  /** The message at `path` of a namespace's messages, or its "other" form when it is plural. */
  function messageOf(locale: Locale, key: string): string | undefined {
    const [namespace, ...path] = key.split('.')
    const at = (parts: readonly string[]): string | undefined => {
      let node: Messages | string | undefined = resources[locale][namespace as 'stock']
      for (const part of parts) node = typeof node === 'object' ? node[part] : undefined
      return typeof node === 'string' ? node : undefined
    }
    return at(path) ?? at([...path.slice(0, -1), `${path.at(-1)}_other`])
  }

  /** What the stock pages say for `key` in a business of `profile` (useTerminology's choice). */
  function said(locale: Locale, key: I18nKey, profile: TerminologyProfile): string {
    return (
      messageOf(
        locale,
        terminologyKey(key, profile, (k) => hasMessage(locale, k)),
      ) ?? ''
    )
  }

  // Every stock message that names what is counted.
  const NAMING: readonly I18nKey[] = [
    'stock.onHand.intro',
    'stock.onHand.empty.body',
    'stock.onHand.empty.untracked',
    'stock.start.pick',
    'stock.newCount.all',
    'stock.sheet.openingNote',
    'stock.sheet.addItems',
    'stock.sheet.noLines',
    'stock.add.title',
    'stock.review.openingIntro',
    'stock.confirm.finalizeBody',
    'stock.confirm.finalizeBodyHere',
    'stock.confirm.openingBody',
    'stock.confirm.reverseBody',
    'stock.confirm.reverseOpeningBody',
    'stock.card.notTracked',
    'stock.card.notFound',
  ]
  type Word = 'general' | 'food' | 'factory' | 'retail'
  const WORDS: Record<Locale, Record<Word, RegExp>> = {
    en: {
      general: /\bmaterials?\b/i,
      food: /ingredient/i,
      factory: /raw material/i,
      retail: /\bitems?\b|\bgoods\b/i,
    },
    ar: { general: /مادة|مواد/, food: /مكو/, factory: /خام/, retail: /صنف|أصناف|بضاع/ },
  }
  /** The shop's word, said only to a shop. */
  const ITEMS: Record<Locale, RegExp> = { en: /\bitems?\b/i, ar: /صنف|أصناف/ }
  const wordOf = (profile: TerminologyProfile): Word =>
    profile === 'food' || profile === 'factory' || profile === 'retail' ? profile : 'general'

  it.each(LOCALES)('names it in each profile, and "items" only in a shop (%s)', (locale) => {
    for (const key of NAMING) {
      for (const profile of TERMINOLOGY_PROFILES) {
        const text = said(locale, key, profile)
        expect(text, `${key} (${profile})`).toMatch(WORDS[locale][wordOf(profile)])
        if (wordOf(profile) !== 'retail')
          expect(text, `${key} (${profile})`).not.toMatch(ITEMS[locale])
      }
    }
  })

  it.each(LOCALES)('says "items" in no other stock message (%s)', (locale) => {
    const keysOf = (messages: Messages | string, prefix: string): string[] =>
      typeof messages === 'string'
        ? [prefix]
        : Object.entries(messages).flatMap(([k, v]) => keysOf(v, `${prefix}.${k}`))
    const named = new Set<string>(NAMING)
    const shared = keysOf(resources[locale].stock, 'stock').filter((key) => {
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '')
      return !/_(food|factory|retail)$/.test(base) && !named.has(base)
    })
    expect(shared.filter((key) => ITEMS[locale].test(messageOf(locale, key) ?? ''))).toEqual([])
  })
})
