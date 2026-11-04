import type {
  CountDto,
  LocationDto,
  MemberLocationsDto,
  RecipeResultDto,
  StockListDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ledgerDrift } from './ledger'
import { tag } from './product-costs'
import { codeOf, line, milkInput, ok, purchaseInput, type Person } from './purchasing'
import { CAFE, CAFE_BRANCHES, shift } from './sales'
import { BAKER } from './settings'
import { lineOf, litres, StockApi, StockScope } from './stock'

// The first count, counts and stock on hand (ROADMAP.md M4 Step 2; D-339 Q2, Q3, Q5, Q6, Q16;
// D-340), through the API with the dev-only preview of Stock (D-125):
//   - the café's first count: 40 L at that day's 90-day average of 6.00 → 240, and a latte's milk costs
//     1.20 the day before and the day after (Q3); a later count finds 80 L missing: −480 at the average;
//   - a first count covers every branch on one day; a branch added since it started must be counted
//     (the review names it, addLines brings it once); stock.list gives the branches to pick from;
//   - blind counting: a member who only counts never gets an expected quantity, a difference or a
//     value (the fields are absent); differences only to managers, values only with the costs switch;
//     a member limited to a branch counts and sees stock only there;
//   - the rules: counts in day order, a first count never before an entry already recorded (both when
//     a count starts and when it is finalized), every line counted, reversal only of the latest,
//     idempotent finalize and reversal;
//   - a count finalized while a purchase of the same material posts: no deadlock, and the ledger
//     rebuilds into the projections (ledgerDrift) after every scenario;
//   - as deployed (no preview), and for a business that keeps no stock, Stock answers MODULE_DISABLED.

let api: StockApi

beforeAll(() => {
  api = new StockApi()
})

afterAll(async () => {
  await api?.close()
})

/** A café (one branch unless `answers` says so), its milk (litres; cartons of 12 bottles) and today. */
async function cafe(answers = CAFE) {
  const scope = await StockScope.open(api, answers)
  const milk = milkInput()
  const material = await scope.material(milk.input)
  return {
    scope,
    milk: material,
    carton: milk.carton,
    bottle: milk.bottle,
    today: await scope.today(),
  }
}

async function expectNoDrift(scope: StockScope) {
  expect(await ledgerDrift(api.admin, scope.id)).toEqual([])
}

const RESULT_FIELDS = ['bookQty', 'differenceQty', 'differenceValue', 'unitCost']

describe('the café’s first count (Q2, Q3)', () => {
  it('starts the milk at 40 L × that day’s 90-day average of 6.00 = 240; a latte’s milk costs the same before and after', async () => {
    const { scope, milk, carton, bottle, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    const latte = await scope.product({ name: `Latte ${tag()}` })
    const before = await scope.recipe(latte.id, [
      { id: newId(), materialId: milk.id, qty: '200', unit: 'ml' },
    ])
    expect(before.lines[0]?.cost).toMatchObject({ basis: 'purchases_90_days', lineCost: '1.2' })
    expect((await scope.stock()).data.items).toEqual([])
    expect((await scope.untracked()).items.map((i) => i.material.id)).toContain(milk.id)

    let count = await scope.start({
      kind: 'opening',
      businessDate: shift(today, -2),
      materialIds: [milk.id],
    })
    expect(count).toMatchObject({
      kind: 'opening',
      status: 'draft',
      locationId: null,
      lineCount: 1,
      countedCount: 0,
    })
    expect((await scope.untracked()).items.find((i) => i.material.id === milk.id)).toMatchObject({
      openingDraftId: count.id,
    })
    // 3 cartons + 4 bottles: 40 L.
    const saved = await scope.save(count, milk.id, [
      { qty: '3', packId: carton },
      { qty: '4', packId: bottle },
    ])
    expect(saved).toMatchObject({ countedQty: '40000', countedByMe: true })
    expect(saved.parts?.map((p) => p.packName)).toEqual(['carton', 'bottle'])
    const review = await scope.review(count.id)
    expect(review).toMatchObject({ notCounted: 0 })
    expect(review.openings).toEqual([
      { materialId: milk.id, countedQty: '40000', avgPerUnit: '6', value: '240' },
    ])
    expect(review.lines[0]).toMatchObject({ expectedQty: null, differenceQty: null })

    count = await scope.finalize(await scope.count(count.id))
    expect(count.status).toBe('posted')
    // The book it replaced: the 12 L bought (a first count shows no usage: nothing to compare yet).
    expect(lineOf(count, milk.id)).toMatchObject({
      countedQty: '40000',
      bookQty: '12000',
      differenceQty: '28000',
      differenceValue: '168',
      unitCost: '0.006',
    })
    const stock = await scope.stock()
    expect(stock.data.items).toHaveLength(1)
    expect(stock.data.items[0]).toMatchObject({
      trackedFrom: shift(today, -2),
      onHand: '40000',
      avgPerUnit: '6',
      value: '240',
    })
    expect(stock.data.items[0]?.branches[0]).toMatchObject({
      onHand: '40000',
      value: '240',
      lastCountedOn: shift(today, -2),
    })
    // D-115 switches for this material: its stock average, and the latte's milk still costs 1.20.
    expect((await scope.costs([milk.id]))[0]?.average).toMatchObject({
      basis: 'stock',
      perUnit: '6',
      from: shift(today, -2),
    })
    const after = ok(await scope.run<RecipeResultDto>('recipe.get', { productId: latte.id })).data
    expect(after.lines[0]?.cost).toMatchObject({ basis: 'stock', lineCost: '1.2' })
    expect((await scope.untracked()).items.map((i) => i.material.id)).not.toContain(milk.id)
    // The stock card lists what came from the first count on.
    const card = await scope.card({ materialId: milk.id })
    expect(card.data).toMatchObject({ onHand: '40000', trackedFrom: shift(today, -2) })
    expect(card.data.entries).toMatchObject([
      {
        kind: 'opening',
        qty: '28000',
        runningQty: '40000',
        countedQty: '40000',
        valueChange: '168',
      },
    ])
    expect(card.data.entries[0]?.countId).toBe(count.id)
    await expectNoDrift(scope)
  })

  it('finds 80 L missing at a later count: −480 at the average, the stock 560 L worth 3,360', async () => {
    const { scope, milk, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    await scope.opening(shift(today, -2), [milk.id], () => litres('40'))
    await scope.buy(purchaseInput(shift(today, -1), [line(milk.id, '600', '6')]))
    let count = await scope.start({ kind: 'count', businessDate: today, materialIds: 'all' })
    expect(count).toMatchObject({ kind: 'count', lineCount: 1 })
    await scope.save(count, milk.id, litres('560'))
    const review = await scope.review(count.id)
    expect(review.lines).toMatchObject([
      {
        countedQty: '560000',
        expectedQty: '640000',
        differenceQty: '-80000',
        differenceValue: '-480',
      },
    ])
    count = await scope.finalize(await scope.count(count.id))
    expect(lineOf(count, milk.id)).toMatchObject({
      bookQty: '640000',
      differenceQty: '-80000',
      differenceValue: '-480',
      unitCost: '0.006',
    })
    expect((await scope.stock()).data.items[0]).toMatchObject({
      onHand: '560000',
      value: '3360',
      avgPerUnit: '6',
    })
    expect((await scope.stock()).data.items[0]?.branches[0]?.lastCountedOn).toBe(today)
    await expectNoDrift(scope)
  })

  it('counts what the book says at the end of the count’s day: a purchase dated after it, posted before, is left out', async () => {
    const { scope, milk, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '10', '6')]))
    await scope.opening(shift(today, -3), [milk.id], () => litres('10'))
    const count = await scope.start({
      kind: 'count',
      businessDate: shift(today, -2),
      materialIds: [milk.id],
    })
    await scope.save(count, milk.id, litres('9'))
    await scope.buy(purchaseInput(shift(today, -1), [line(milk.id, '5', '6')]))
    expect((await scope.review(count.id)).lines[0]).toMatchObject({
      expectedQty: '10000',
      differenceQty: '-1000',
    })
    expect((await scope.finalize(await scope.count(count.id))).status).toBe('posted')
    // 9 counted at the end of that day, and the 5 L bought the day after: 14 L now.
    expect((await scope.stock()).data.items[0]).toMatchObject({ onHand: '14000', value: '84' })
    await expectNoDrift(scope)
  })
})

describe('a first count in every branch (Q2)', () => {
  it('counts each branch on one day, the value split by what each counted', async () => {
    const { scope, milk, today } = await cafe(CAFE_BRANCHES)
    const marina = ok(
      await scope.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    await scope.buy(purchaseInput(shift(today, -2), [line(milk.id, '12', '6')]))
    const count = await scope.start({
      kind: 'opening',
      businessDate: shift(today, -1),
      materialIds: [milk.id],
    })
    expect(count.lines).toHaveLength(2)
    const main = count.lines.find((l) => l.locationId !== marina.id)!
    await scope.save(count, milk.id, litres('25'), scope.owner, main.locationId)
    await scope.save(count, milk.id, litres('15'), scope.owner, marina.id)
    await scope.finalize(await scope.count(count.id))
    const item = (await scope.stock()).data.items[0]!
    expect(item).toMatchObject({ onHand: '40000', value: '240' })
    expect(
      Object.fromEntries(item.branches.map((b) => [b.locationId, [b.onHand, b.value]])),
    ).toEqual({ [main.locationId]: ['25000', '150'], [marina.id]: ['15000', '90'] })
    // One row per branch: the value split 150 / 90, the 72 of book replaced on the first row.
    const rows = await api.admin<{ qty: string; value: string; adjustment: string }[]>`
      select trim_scale(qty)::text as qty, trim_scale(value)::text as value,
             trim_scale(adjustment)::text as adjustment
        from app.stock_movements
       where business_id = ${scope.id} and material_id = ${milk.id} and kind = 'opening'
       order by seq`
    expect(rows.map((r) => r.value).sort()).toEqual(['150', '90'])
    expect(rows.map((r) => r.adjustment).sort()).toEqual(['0', '72'])
    await expectNoDrift(scope)
  })

  it('must count a branch added since it started (COUNT_INCOMPLETE): the review names it, addLines brings it once', async () => {
    const { scope, milk, today } = await cafe(CAFE_BRANCHES)
    let count = await scope.start({ kind: 'opening', businessDate: today, materialIds: [milk.id] })
    expect(count.lines).toHaveLength(1)
    await scope.save(count, milk.id, litres('5'))
    expect((await scope.review(count.id)).missingLines).toEqual([])
    const marina = ok(
      await scope.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    count = await scope.count(count.id)
    expect(
      codeOf(await scope.run('count.finalize', { id: count.id, version: count.version })),
    ).toBe('count_incomplete')
    expect((await scope.review(count.id)).missingLines).toEqual([
      { locationId: marina.id, locationName: marina.name, materialId: milk.id },
    ])
    for (const time of ['once', 'again']) {
      count = ok(
        await scope.run<{ data: CountDto }>('count.addLines', {
          countId: count.id,
          materialIds: [milk.id],
        }),
      ).data
      expect(count.lines, time).toHaveLength(2)
    }
    expect((await scope.review(count.id)).missingLines).toEqual([])
    await scope.save(count, milk.id, litres('0'), scope.owner, marina.id)
    count = await scope.finalize(await scope.count(count.id))
    expect(count.status).toBe('posted')
    await expectNoDrift(scope)
  })
})

describe('who sees what (Q6, Q16)', () => {
  it('counts blind without managing counts; differences only to managers, values only with costs', async () => {
    const { scope, milk, today } = await cafe()
    const business = { id: scope.id, owner: scope.owner }
    const [employee, supervisor, accountant, manager, sales] = await Promise.all([
      api.member(business, 'employee'),
      api.member(business, 'supervisor'),
      api.member(business, 'accountant'),
      api.member(business, 'manager'),
      api.member(business, 'sales'),
    ])
    await scope.buy(purchaseInput(shift(today, -2), [line(milk.id, '12', '6')]))
    const opening = await scope.opening(shift(today, -1), [milk.id], () => litres('40'))
    let count = await scope.start(
      { kind: 'count', businessDate: today, materialIds: 'all' },
      manager,
    )

    // The Employee counts (blind): no expected quantity, difference or value, not even as null.
    const draft = await scope.count(count.id, employee)
    for (const field of RESULT_FIELDS) expect(lineOf(draft, milk.id)).not.toHaveProperty(field)
    const saved = await scope.save(draft, milk.id, litres('38'), employee)
    expect(saved).toMatchObject({ countedQty: '38000', countedByMe: true })
    for (const field of RESULT_FIELDS) expect(saved).not.toHaveProperty(field)
    for (const [path, input] of [
      ['count.review', { id: count.id }],
      ['stock.list', {}],
      ['stock.untracked', {}],
      ['stock.card', { materialId: milk.id }],
      ['count.clearLine', { countId: count.id, lineId: saved.id, version: saved.version }],
      ['count.finalize', { id: count.id, version: count.version }],
      ['count.start', { id: newId(), kind: 'count', businessDate: today, materialIds: 'all' }],
    ] as const) {
      expect(codeOf(await scope.as(employee, path, input)), path).toBe('forbidden')
    }
    // Finalized counts are for those who see stock: not the Employee's.
    expect(codeOf(await scope.as(employee, 'count.get', { id: opening.id }))).toBe('not_found')
    expect((await scope.counts({}, employee)).items.map((c) => c.id)).toEqual([count.id])

    // Another draft of the same day, which stays a draft (a count of the day can't start once one is
    // finalized: COUNT_OUT_OF_ORDER).
    const next = await scope.start({
      kind: 'count',
      businessDate: today,
      materialIds: [milk.id],
    })

    // A manager sees the review and finalizes.
    expect((await scope.review(count.id, manager)).lines[0]).toMatchObject({
      expectedQty: '40000',
      differenceQty: '-2000',
      differenceValue: '-12',
    })
    count = await scope.finalize(await scope.count(count.id, manager), manager)
    expect(lineOf(count, milk.id)).toMatchObject({
      bookQty: '40000',
      differenceQty: '-2000',
      differenceValue: '-12',
    })
    expect(lineOf(count, milk.id).countedByName).toBeTruthy()

    // The Supervisor sees stock and finalized counts (what was counted), no difference, no value.
    const theirs = await scope.count(count.id, supervisor)
    expect(lineOf(theirs, milk.id).countedQty).toBe('38000')
    for (const field of RESULT_FIELDS) expect(lineOf(theirs, milk.id)).not.toHaveProperty(field)
    const locked = await scope.stock({}, supervisor)
    expect(locked.data.items[0]).toMatchObject({ onHand: '38000' })
    expect(locked.data.items[0]).not.toHaveProperty('value')
    expect(locked.data.items[0]).not.toHaveProperty('avgPerUnit')
    expect(locked.meta.redacted).toEqual(
      expect.arrayContaining(['items.*.value', 'items.*.avgPerUnit', 'items.*.branches.*.value']),
    )
    const card = await scope.card({ materialId: milk.id }, supervisor)
    expect(card.data.entries[0]).not.toHaveProperty('valueChange')
    expect(card.data.entries[0]).toMatchObject({ kind: 'count', qty: '-2000' })
    // Sales sees stock too, without values; the Accountant with them, but no difference (not a
    // manager of counts) and no draft (not a counter).
    expect((await scope.stock({}, sales)).data.items[0]).not.toHaveProperty('value')
    expect((await scope.stock({}, accountant)).data.items[0]).toMatchObject({ value: '228' })
    const accountants = await scope.count(count.id, accountant)
    for (const field of RESULT_FIELDS)
      expect(lineOf(accountants, milk.id)).not.toHaveProperty(field)
    expect(codeOf(await scope.as(accountant, 'count.get', { id: next.id }))).toBe('not_found')
    await expectNoDrift(scope)
  })

  it('a member limited to a branch counts and sees stock only there (D-234)', async () => {
    const { scope, milk, today } = await cafe(CAFE_BRANCHES)
    const marina = ok(
      await scope.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
    )
    const manager = await api.member({ id: scope.id, owner: scope.owner }, 'manager')
    const access = ok(
      await scope.run<MemberLocationsDto>('member.locations', { memberId: manager.memberId }),
    )
    ok(
      await scope.run('member.updateLocations', {
        memberId: manager.memberId,
        version: access.version,
        locationIds: [marina.id],
      }),
    )
    await scope.buy(purchaseInput(shift(today, -2), [line(milk.id, '12', '6')]))
    const opening = await scope.opening(shift(today, -1), [milk.id], (_, at) =>
      litres(at === marina.id ? '15' : '25'),
    )
    const main = opening.lines.find((l) => l.locationId !== marina.id)!.locationId

    const theirs = await scope.stock({}, manager)
    expect(theirs.data.items[0]).toMatchObject({ onHand: '15000', value: '90' })
    expect(theirs.data.items[0]?.branches.map((b) => b.locationId)).toEqual([marina.id])
    // The branches to pick from: theirs (the owner's: every live one, whatever the filter).
    expect(theirs.data.branches).toEqual([{ id: marina.id, name: marina.name }])
    expect(
      (await scope.stock({ locationId: marina.id })).data.branches.map((b) => b.id).sort(),
    ).toEqual([main, marina.id].sort())
    expect(codeOf(await scope.as(manager, 'stock.list', { locationId: main }))).toBe('forbidden')
    expect(
      codeOf(await scope.as(manager, 'stock.card', { materialId: milk.id, locationId: main })),
    ).toBe('forbidden')
    expect(
      (await scope.card({ materialId: milk.id }, manager)).data.entries.map((e) => e.locationId),
    ).toEqual([marina.id])
    expect((await scope.count(opening.id, manager)).lines.map((l) => l.locationId)).toEqual([
      marina.id,
    ])
    const sugar = await scope.material(milkInput(`Sugar ${tag()}`).input)
    for (const input of [
      { id: newId(), kind: 'opening', businessDate: today, materialIds: [sugar.id] },
      { id: newId(), kind: 'count', businessDate: today, locationId: main, materialIds: 'all' },
    ]) {
      expect(codeOf(await scope.as(manager, 'count.start', input))).toBe('forbidden')
    }
    const ownCount = await scope.start(
      { kind: 'count', businessDate: today, locationId: marina.id, materialIds: 'all' },
      manager,
    )
    expect(ownCount.lines.map((l) => l.locationId)).toEqual([marina.id])
    const mainCount = await scope.start({
      kind: 'count',
      businessDate: today,
      locationId: main,
      materialIds: 'all',
    })
    expect(codeOf(await scope.as(manager, 'count.get', { id: mainCount.id }))).toBe('not_found')
    expect((await scope.counts({}, manager)).items.map((c) => c.id).sort()).toEqual(
      [ownCount.id, opening.id].sort(),
    )
    await expectNoDrift(scope)
  })
})

describe('the rules of counting', () => {
  it('goes in day order: a count after its material’s first count and after the last count; a first count never before an entry already recorded (COUNT_OUT_OF_ORDER, at start and at finalize)', async () => {
    const { scope, milk, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    await scope.opening(shift(today, -2), [milk.id], () => litres('12'))
    const start = (input: object) => scope.run('count.start', { id: newId(), ...input })
    // On or before the first count's day: refused when it starts (its day never changes).
    for (const day of [shift(today, -2), shift(today, -3)]) {
      expect(
        codeOf(await start({ kind: 'count', businessDate: day, materialIds: 'all' })),
        day,
      ).toBe('count_out_of_order')
    }
    // Two drafts of one day: once the first is finalized, the other is refused when finalized, and
    // no count of that day starts any more.
    const first = await scope.start({ kind: 'count', businessDate: today, materialIds: 'all' })
    const again = await scope.start({ kind: 'count', businessDate: today, materialIds: 'all' })
    await scope.save(first, milk.id, litres('11'))
    await scope.save(again, milk.id, litres('11'))
    await scope.finalize(await scope.count(first.id))
    const read = await scope.count(again.id)
    expect(codeOf(await scope.run('count.finalize', { id: read.id, version: read.version }))).toBe(
      'count_out_of_order',
    )
    expect(
      codeOf(await start({ kind: 'count', businessDate: today, materialIds: [milk.id] })),
    ).toBe('count_out_of_order')
    // A first count dated before a purchase already recorded would drop it: refused when it starts,
    // and when it is finalized for a purchase recorded since it started.
    const sugar = await scope.material(milkInput(`Sugar ${tag()}`).input)
    await scope.buy(purchaseInput(today, [line(sugar.id, '5', '2')]))
    expect(
      codeOf(
        await start({ kind: 'opening', businessDate: shift(today, -1), materialIds: [sugar.id] }),
      ),
    ).toBe('count_out_of_order')
    const salt = await scope.material(milkInput(`Salt ${tag()}`).input)
    const late = await scope.start({
      kind: 'opening',
      businessDate: shift(today, -1),
      materialIds: [salt.id],
    })
    await scope.save(late, salt.id, litres('5'))
    await scope.buy(purchaseInput(today, [line(salt.id, '5', '2')]))
    const lateRead = await scope.count(late.id)
    expect(
      codeOf(await scope.run('count.finalize', { id: lateRead.id, version: lateRead.version })),
    ).toBe('count_out_of_order')
    await expectNoDrift(scope)
  })

  it('needs every line counted (COUNT_INCOMPLETE); a first count is of untracked materials, a count of tracked ones', async () => {
    const { scope, milk, today } = await cafe()
    const sugar = await scope.material(milkInput(`Sugar ${tag()}`).input)
    const count = await scope.start({
      kind: 'opening',
      businessDate: shift(today, -1),
      materialIds: [milk.id, sugar.id],
    })
    await scope.save(count, milk.id, litres('3'))
    const read = await scope.count(count.id)
    expect(codeOf(await scope.run('count.finalize', { id: read.id, version: read.version }))).toBe(
      'count_incomplete',
    )
    // Taken off, the rest finalizes.
    const sugarLine = lineOf(read, sugar.id)
    ok(
      await scope.run('count.removeLine', {
        countId: read.id,
        lineId: sugarLine.id,
        version: sugarLine.version,
      }),
    )
    await scope.finalize(await scope.count(count.id))
    const opening = await scope.as(scope.owner, 'count.start', {
      id: newId(),
      kind: 'opening',
      businessDate: today,
      materialIds: [milk.id],
    })
    expect(codeOf(opening)).toBe('stock_tracked')
    expect(opening.error?.data.names).toEqual([milk.name])
    expect(
      codeOf(
        await scope.run('count.start', {
          id: newId(),
          kind: 'count',
          businessDate: today,
          materialIds: [sugar.id],
        }),
      ),
    ).toBe('stock_not_tracked')
    // A line counted again ("count it again") is not counted any more.
    const next = await scope.start({
      kind: 'count',
      businessDate: today,
      materialIds: [milk.id],
    })
    const saved = await scope.save(next, milk.id, litres('2'))
    const cleared = ok(
      await scope.run<{ data: { countedQty: string | null; parts: unknown } }>('count.clearLine', {
        countId: next.id,
        lineId: saved.id,
        version: saved.version,
      }),
    ).data
    expect(cleared).toMatchObject({ countedQty: null, parts: null })
    // A stale version is CONFLICT.
    expect(
      codeOf(
        await scope.run('count.saveLine', {
          countId: next.id,
          lineId: saved.id,
          parts: litres('1'),
          version: saved.version,
        }),
      ),
    ).toBe('conflict')
  })

  it('reverses only the latest count, a first count only while no later count stands; idempotent', async () => {
    const { scope, milk, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -3), [line(milk.id, '12', '6')]))
    const opening = await scope.opening(shift(today, -2), [milk.id], () => litres('40'))
    const counts: CountDto[] = []
    for (const [day, litresCounted] of [
      [shift(today, -1), '35'],
      [today, '30'],
    ] as const) {
      const count = await scope.start({ kind: 'count', businessDate: day, materialIds: 'all' })
      await scope.save(count, milk.id, litres(litresCounted))
      counts.push(await scope.finalize(await scope.count(count.id)))
    }
    const [earlier, later] = counts as [CountDto, CountDto]
    expect(codeOf(await scope.run('count.reverse', { id: earlier.id }))).toBe('has_later_counts')
    expect(codeOf(await scope.run('count.reverse', { id: opening.id }))).toBe('has_later_counts')
    expect((await scope.reverseCount(later.id)).status).toBe('reversed')
    expect((await scope.reverseCount(later.id)).status).toBe('reversed')
    expect((await scope.stock()).data.items[0]).toMatchObject({ onHand: '35000', value: '210' })
    await scope.reverseCount(earlier.id)
    expect((await scope.stock()).data.items[0]).toMatchObject({ onHand: '40000', value: '240' })
    await scope.reverseCount(opening.id)
    // Not tracked any more: back to the 90-day average, and the book of the purchases alone.
    expect((await scope.stock()).data.items).toEqual([])
    expect((await scope.costs([milk.id]))[0]?.average).toMatchObject({
      basis: 'purchases_90_days',
      perUnit: '6',
    })
    expect(await scope.costRow(milk.id)).toEqual({ qty: '12000', value: '72', avg_cost: '0.006' })
    expect(codeOf(await scope.run('stock.card', { materialId: milk.id }))).toBe('stock_not_tracked')
    const [reversals] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements
       where business_id = ${scope.id} and kind = 'reversal'`
    expect(reversals?.n).toBe(3)
    // Tracked again with a new first count.
    await scope.opening(today, [milk.id], () => litres('7'))
    expect((await scope.stock()).data.items[0]).toMatchObject({ onHand: '7000', value: '42' })
    await expectNoDrift(scope)
  })

  it('finalizes once, discards a draft only, reverses a finalized count only', async () => {
    const { scope, milk, today } = await cafe()
    let count = await scope.start({
      kind: 'opening',
      businessDate: shift(today, -1),
      materialIds: [milk.id],
    })
    expect(codeOf(await scope.run('count.reverse', { id: count.id }))).toBe('document_not_posted')
    await scope.save(count, milk.id, litres('4'))
    count = await scope.count(count.id)
    const [first, second] = await Promise.all([
      scope.run<{ data: CountDto }>('count.finalize', { id: count.id, version: count.version }),
      scope.run<{ data: CountDto }>('count.finalize', { id: count.id, version: count.version }),
    ])
    expect(ok(first).data.status).toBe('posted')
    expect(ok(second).data.status).toBe('posted')
    const [moves] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements
       where business_id = ${scope.id} and kind = 'opening'`
    expect(moves?.n).toBe(1)
    expect(codeOf(await scope.run('count.discard', { id: count.id, version: count.version }))).toBe(
      'document_posted',
    )
    const draft = await scope.start({ kind: 'count', businessDate: today, materialIds: 'all' })
    ok(await scope.run('count.discard', { id: draft.id, version: draft.version }))
    expect(codeOf(await scope.run('count.get', { id: draft.id }))).toBe('not_found')
    // A retried start returns the same draft; the same id for another start is CONFLICT.
    const input = { id: newId(), kind: 'count', businessDate: today, materialIds: [milk.id] }
    const once = ok(await scope.run<{ data: CountDto }>('count.start', input)).data
    const twice = ok(await scope.run<{ data: CountDto }>('count.start', input)).data
    expect(twice.id).toBe(once.id)
    expect(codeOf(await scope.run('count.start', { ...input, materialIds: 'all' }))).toBe(
      'conflict',
    )
    await expectNoDrift(scope)
  })
})

describe('counts and purchases at the same time (D-110, D-135)', () => {
  it('finalizes a count while a purchase of the same material posts: no deadlock, the ledger rebuilds', async () => {
    const { scope, milk, today } = await cafe()
    await scope.buy(purchaseInput(shift(today, -2), [line(milk.id, '12', '6')]))
    // A first count racing a purchase of its day.
    const opening = await scope.start({
      kind: 'opening',
      businessDate: shift(today, -1),
      materialIds: [milk.id],
    })
    await scope.save(opening, milk.id, litres('10'))
    const read = await scope.count(opening.id)
    const purchase = await scope.draft(purchaseInput(shift(today, -1), [line(milk.id, '5', '7')]))
    const [finalized, posted] = await Promise.all([
      scope.run('count.finalize', { id: read.id, version: read.version }),
      scope.run('purchase.post', { id: purchase.id, version: purchase.version }),
    ])
    expect(finalized.error, finalized.raw).toBeUndefined()
    expect(posted.error, posted.raw).toBeUndefined()
    await expectNoDrift(scope)
    // Later counts racing purchases, round after round.
    for (const day of [today]) {
      const count = await scope.start({ kind: 'count', businessDate: day, materialIds: 'all' })
      await scope.save(count, milk.id, litres('9'))
      const draft = await scope.count(count.id)
      const purchases = await Promise.all(
        ['1', '2', '3'].map((qty) => scope.draft(purchaseInput(day, [line(milk.id, qty, '8')]))),
      )
      const results = await Promise.all([
        scope.run('count.finalize', { id: draft.id, version: draft.version }),
        ...purchases.map((p) => scope.run('purchase.post', { id: p.id, version: p.version })),
      ])
      for (const result of results) expect(result.error, result.raw).toBeUndefined()
      await expectNoDrift(scope)
    }
  })
})

describe('served only with the preview, for a business that keeps stock', () => {
  it('answers MODULE_DISABLED as deployed (Stock is planned), and for a business without stock', async () => {
    const { scope } = await cafe()
    for (const path of ['stock.list', 'count.list']) {
      expect(codeOf(await api.call(scope.owner, scope.id, path, {}, api.released)), path).toBe(
        'module_disabled',
      )
    }
    const baker = await StockScope.open(api, BAKER)
    expect(codeOf(await baker.run('stock.list', {}))).toBe('module_disabled')
    const owner: Person = scope.owner
    expect(ok(await scope.as<StockListDto>(owner, 'stock.list', {})).data.items).toEqual([])
  })

  it('counts another branch only with branches (CAPABILITY_DISABLED), a location of the business only (NOT_FOUND)', async () => {
    const { scope, milk, today } = await cafe()
    await scope.opening(shift(today, -1), [milk.id], () => litres('1'))
    const count = (location: string | null) =>
      scope.run<{ data: CountDto }>('count.start', {
        id: newId(),
        kind: 'count',
        businessDate: today,
        locationId: location,
        materialIds: 'all',
      })
    expect(codeOf(await count(newId()))).toBe('capability_disabled')
    const own = ok(await count(null)).data
    expect(ok(await count(own.locationId)).data).toMatchObject({ locationId: own.locationId })
    const branches = await cafe(CAFE_BRANCHES)
    expect(
      codeOf(
        await branches.scope.run('count.start', {
          id: newId(),
          kind: 'count',
          businessDate: today,
          locationId: newId(),
          materialIds: 'all',
        }),
      ),
    ).toBe('not_found')
    expect(codeOf(await branches.scope.run('stock.list', { locationId: newId() }))).toBe(
      'not_found',
    )
  })
})
